// The only place in this repo that speaks HTTP to the llamafile server.
// Everything else (intents, brain, tools) goes through createLlm().
//
// Usage:
//   import { createLlm } from './llm.js';
//   const llm = createLlm({ baseUrl: engine.baseUrl() });
//   const { content } = await llm.chat({ messages });
//   const intent = await llm.intent({ messages, enumValues: ['weather', 'reminder', 'chat'] });
//
// Every request this file sends carries chat_template_kwargs:
// { enable_thinking: false }, no exceptions, because without it Qwen's
// reasoning eats the whole token budget and the reply comes back empty
// (see tools/fake-engine.mjs, which reproduces that bug on purpose so
// tests can catch a caller that forgot to go through chat()).
//
// llama.cpp's tool_choice shape is { type: 'tool', name }, not the OpenAI
// { type: 'function', function: { name } } shape. chat() accepts either a
// bare tool name (string) or an already-shaped object and normalizes it.

const DEFAULT_TIMEOUT_MS = 120_000;

function gbnfString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// root ::= "a" | "b" | ... , one alternative per enum value.
export function buildEnumGrammar(values) {
  return `root ::= ${values.map(gbnfString).join(' | ')}`;
}

function normalizeToolChoice(toolChoice) {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === 'string') return { type: 'tool', name: toolChoice };
  return toolChoice;
}

function parseJsonArguments(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // The server can fail open and return prose instead of a JSON string;
    // callers get raw so they can decide what to do with it.
    return null;
  }
}

function toToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls.map((tc) => {
    const fn = tc.function || {};
    return { name: fn.name, arguments: parseJsonArguments(fn.arguments), raw: fn.arguments };
  });
}

// Combines an optional caller-supplied AbortSignal with an internal
// timeout. `reset()` pushes the timeout back out, used while streaming so
// a request that keeps producing tokens is never killed by the timeout,
// only a stall is.
function createTimeoutController(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal.reason);

  let timer = setTimeout(() => controller.abort(new Error(`llm request timed out after ${timeoutMs}ms`)), timeoutMs);

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    reset() {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`llm request timed out after ${timeoutMs}ms`)), timeoutMs);
    },
    clear() {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    },
  };
}

// Reads a fetch Response body as Server-Sent Events, calling onLine(line)
// for every non-empty line (including the raw "data: [DONE]" terminator).
async function readSse(body, onLine) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) onLine(line);
    }
  }
  const last = buffer.trim();
  if (last) onLine(last);
}

async function readErrorText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export function createLlm({ baseUrl, fetch = globalThis.fetch, flags, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  function url(pathname) {
    return `${baseUrl}${pathname}`;
  }

  async function chat({
    messages,
    stream = false,
    maxTokens = 900,
    temperature,
    grammar,
    tools,
    toolChoice,
    nPredict,
    idSlot = 0,
    cachePrompt = true,
    signal,
    onDelta,
  } = {}) {
    const body = {
      messages,
      // Required on every request, see file header.
      chat_template_kwargs: { enable_thinking: false },
      cache_prompt: cachePrompt,
      id_slot: idSlot,
    };
    if (stream) body.stream = true;
    if (maxTokens != null) body.max_tokens = maxTokens;
    if (nPredict != null) body.n_predict = nPredict;
    if (temperature != null) body.temperature = temperature;
    if (grammar) body.grammar = grammar;
    if (tools) body.tools = tools;
    const normalizedToolChoice = normalizeToolChoice(toolChoice);
    if (normalizedToolChoice) body.tool_choice = normalizedToolChoice;

    const timeoutCtl = createTimeoutController(timeoutMs, signal);

    let res;
    try {
      res = await fetch(url('/v1/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeoutCtl.signal,
      });
    } catch (err) {
      timeoutCtl.clear();
      throw err;
    }

    if (!res.ok) {
      const text = await readErrorText(res);
      timeoutCtl.clear();
      throw new Error(`llm request failed: ${res.status} ${text}`.trim());
    }

    if (!stream) {
      let data;
      try {
        data = await res.json();
      } finally {
        timeoutCtl.clear();
      }
      const choice = (data.choices && data.choices[0]) || {};
      const message = choice.message || {};
      const toolCalls = toToolCalls(message.tool_calls);
      return {
        content: message.content ?? '',
        reasoning: message.reasoning_content ?? '',
        finishReason: choice.finish_reason ?? null,
        toolCalls,
        usage: data.usage ?? null,
        timings: data.timings ?? null,
      };
    }

    let content = '';
    let reasoning = '';
    let finishReason = null;
    let usage = null;
    let timings = null;
    const toolCallsAcc = new Map();

    try {
      await readSse(res.body, (line) => {
        timeoutCtl.reset();
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          return;
        }
        const choice = json.choices && json.choices[0];
        if (choice) {
          const delta = choice.delta || {};
          if (delta.content) content += delta.content;
          if (delta.reasoning_content) reasoning += delta.reasoning_content;
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              const acc = toolCallsAcc.get(i) || { name: '', arguments: '' };
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
              toolCallsAcc.set(i, acc);
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
          if (onDelta) onDelta({ content: delta.content || '', reasoning: delta.reasoning_content || '' });
        }
        if (json.usage) usage = json.usage;
        if (json.timings) timings = json.timings;
      });
    } finally {
      timeoutCtl.clear();
    }

    const toolCalls = [...toolCallsAcc.values()].map(({ name, arguments: argsStr }) => ({
      name,
      arguments: parseJsonArguments(argsStr),
      raw: argsStr,
    }));

    return { content, reasoning, finishReason, toolCalls, usage, timings };
  }

  async function intent({ messages, enumValues, signal }) {
    const grammar = buildEnumGrammar(enumValues);
    const result = await chat({
      messages,
      grammar,
      temperature: 0,
      nPredict: 8,
      maxTokens: 8,
      signal,
    });
    const cleaned = String(result.content || '').trim().replace(/^["']|["']$/g, '').trim();
    return enumValues.includes(cleaned) ? cleaned : 'chat';
  }

  async function warm(messages) {
    const result = await chat({ messages, maxTokens: 1, nPredict: 1, temperature: 0, cachePrompt: true });
    return result.timings || null;
  }

  async function health() {
    const res = await fetch(url('/health'));
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Some failure modes (connection refused surfaces as a thrown
      // error before this point; this catch is for a non-JSON body).
    }
    return { ok: res.ok, status: res.status, body };
  }

  async function models() {
    const res = await fetch(url('/v1/models'));
    const data = await res.json();
    if (Array.isArray(data.models)) return data.models.map((m) => m.name);
    if (Array.isArray(data.data)) return data.data.map((m) => m.id);
    return [];
  }

  async function props() {
    const res = await fetch(url('/props'));
    return res.json();
  }

  return { chat, intent, warm, health, models, props, flags, baseUrl };
}
