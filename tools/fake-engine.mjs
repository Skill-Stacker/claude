#!/usr/bin/env node
// A stand-in for llamafile 0.10.5's built-in HTTP server, used by
// tests/engine.test.js, tests/llm.test.js and the headless smoke suite.
// It is not a simulator of the model, only of the server's HTTP contract:
// /health, /v1/models, /props and /v1/chat/completions (streaming and not),
// plus the reasoning-drain bug that shows up when a request forgets to send
// chat_template_kwargs.enable_thinking: false.
//
// Usage:
//   node tools/fake-engine.mjs --port 8090 [--load-ms 800] [--tps 40] \
//     [--help-flags jinja,reasoning-budget,reasoning-format,parallel,chat-template-kwargs]
//   node tools/fake-engine.mjs --help
//
// It also accepts (and ignores the values of) the real launch-shape flags
// so engine.js can spawn it exactly as it would spawn the real binary:
//   node tools/fake-engine.mjs --server -m <model.gguf> --host 127.0.0.1 \
//     --port 8090 -ngl 999 --gpu nvidia
//
// Debug endpoint: GET /__requests returns the last 200 requests this
// process has seen, each as { method, path, body }, so tests can inspect
// exactly what llm.js sent (grammar text, tool_choice shape, whether
// chat_template_kwargs was set).
//
// Binds 127.0.0.1 only, regardless of --host.

import { createServer } from 'node:http';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  '--port', '--load-ms', '--tps', '--help-flags',
  '--host', '-m', '--model', '-ngl', '--gpu',
  '--reasoning-budget', '--reasoning-format', '-np',
  '--chat-template-kwargs',
]);
const BOOL_FLAGS = new Set(['--server', '--jinja', '--help']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) continue;
    if (BOOL_FLAGS.has(a)) { out[a] = true; continue; }
    if (VALUE_FLAGS.has(a)) { out[a] = argv[i + 1]; i++; continue; }
    // Unknown flag: swallow a following non-flag value too, so an
    // unrecognized real llamafile flag never gets read as our own value.
    if (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('-')) i++;
  }
  return out;
}

const HELP_LINES = {
  jinja: '  --jinja                        use jinja chat template',
  'reasoning-budget': '  --reasoning-budget N           cap reasoning tokens, 0 disables',
  'reasoning-format': '  --reasoning-format FMT         reasoning_content format (none|deepseek)',
  parallel: '  -np N, --parallel N            number of parallel slots',
  'chat-template-kwargs': '  --chat-template-kwargs JSON    default chat template kwargs',
};

function printHelpAndExit(helpFlagsCsv) {
  const wanted = String(helpFlagsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  const lines = [
    'fake-engine (test double for llamafile 0.10.5 --server)',
    'usage: fake-engine.mjs [options]',
    '',
    '  --port N                       bind port',
    '  --host HOST                    bind host',
    '  -m FILE                        model path',
    '  --server                       run in server mode',
    '  -ngl N                         layers offloaded to GPU',
    '  --gpu NAME                     gpu backend name',
  ];
  for (const id of wanted) {
    if (HELP_LINES[id]) lines.push(HELP_LINES[id]);
  }
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
if (args['--help']) printHelpAndExit(args['--help-flags']);

const PORT = Number(args['--port'] || 8090);
const LOAD_MS = Number(args['--load-ms'] || 500);
const TPS = Math.max(1, Number(args['--tps'] || 40));
const STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// Request log (GET /__requests)
// ---------------------------------------------------------------------------

const requestLog = [];
function logRequest(method, pathname, body) {
  requestLog.push({ method, path: pathname, body: body ?? null, at: Date.now() });
  if (requestLog.length > 200) requestLog.shift();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ');
  }
  return '';
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') return contentToText(m.content);
  }
  return '';
}

// Pulls the quoted alternatives out of a `root ::= "a" | "b" | ...` GBNF
// grammar. Returns null when `grammar` does not look like that shape, so
// non-enum grammars fall through to the plain echo reply.
function enumValuesFromGrammar(grammar) {
  if (typeof grammar !== 'string' || !/root\s*::=/.test(grammar)) return null;
  const matches = grammar.match(/"(?:[^"\\]|\\.)*"/g);
  if (!matches || matches.length === 0) return null;
  return matches.map((m) => m.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
}

// A handful of keyword hints so the fake routes everyday phrasings the way
// the real model would, which keeps the smoke run honest. An enum value
// named in the text still wins; otherwise fall back to "chat" when the
// grammar offers it, else the first value.
const ENUM_HINTS = [
  ['set_reminder', /\bremind\b|\breminder\b/],
  ['list_reminders', /\bmy reminders\b|\bwhat reminders\b/],
  ['create_event', /\b(add|put|schedule|create)\b.*\b(calendar|appointment|meeting|event)\b/],
  ['move_event', /\b(move|reschedule|push)\b.*\b(appointment|meeting|event|calendar)\b/],
  ['free_check', /\bam i free\b|\bfree (on|at)\b|\banything (open|free)\b/],
  ['next_event', /\bnext (appointment|event|thing|meeting)\b|\bwhen('s| is) my\b/],
  ['why_missing_event', /\bwhy (don't|do not|can't) you see\b|\bjust added\b/],
  ['date_agenda', /\btomorrow\b|\bthis week\b|\bon (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/],
  ['today_agenda', /\btoday\b|\bmy calendar\b|\bmy day\b/],
  ['unread_from', /\b(email|mail|message)s? from\b|\bhas .* emailed\b|\bunread\b/],
  ['keyword_scan', /\banything from\b|\bany (bills|emails?) (come in|about)\b/],
  ['thread_summary', /\bsummari[sz]e\b|\bcatch me up\b/],
  ['read_message', /\bread (that|it|the|me)\b/],
  ['draft_reply', /\breply\b|\bwrite back\b/],
  ['send_confirmed', /^\s*(yes|send it|go ahead)\b/],
];

function pickEnumValue(values, userText) {
  const lower = userText.toLowerCase();
  const direct = values.find((v) => lower.includes(String(v).toLowerCase()));
  if (direct !== undefined) return direct;
  for (const [name, re] of ENUM_HINTS) {
    if (values.includes(name) && re.test(lower)) return name;
  }
  return values.includes('chat') ? 'chat' : values[0];
}

function pickTool(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const wantName = toolChoice && typeof toolChoice === 'object' ? toolChoice.name : null;
  if (wantName) {
    const found = tools.find((t) => t.function?.name === wantName || t.name === wantName);
    if (found) return found;
  }
  return tools[0];
}

// Tool schemas are flat (no $ref, no nesting) per CLAUDE.md, so a shallow
// walk over properties is enough for a fake.
function buildToolArguments(tool, userText) {
  const schema = tool.function?.parameters || tool.parameters || {};
  const props = schema.properties || {};
  const words = userText.split(/\s+/).filter(Boolean);
  let wi = 0;
  const out = {};
  for (const [name, def] of Object.entries(props)) {
    const type = def && def.type;
    if (/iso|time/i.test(name)) {
      out[name] = new Date().toISOString();
    } else if (Array.isArray(def?.enum) && def.enum.length) {
      out[name] = def.enum[0];
    } else if (type === 'integer' || type === 'number') {
      out[name] = 0;
    } else if (type === 'boolean') {
      out[name] = false;
    } else {
      out[name] = words.length ? words[wi % words.length] : 'value';
      wi++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// /v1/chat/completions
// ---------------------------------------------------------------------------

function classify(body) {
  const thinkingDisabled = body.chat_template_kwargs && body.chat_template_kwargs.enable_thinking === false;
  const userText = lastUserText(body.messages);
  if (!thinkingDisabled) {
    // Reproduces the real v2 bug: without the flag, the model's reasoning
    // eats the whole token budget and no content ever comes out.
    return { mode: 'drain' };
  }
  const enumValues = enumValuesFromGrammar(body.grammar);
  if (enumValues) {
    return { mode: 'enum', text: String(pickEnumValue(enumValues, userText)) };
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    const tool = pickTool(body.tools, body.tool_choice);
    return { mode: 'tool', toolName: tool.function?.name || tool.name || 'tool', args: buildToolArguments(tool, userText) };
  }
  return { mode: 'echo', text: `You said: ${userText}` };
}

function usageAndTimings(maxTokens) {
  return {
    usage: { prompt_tokens: 8, completion_tokens: maxTokens, total_tokens: 8 + maxTokens },
    timings: { prompt_ms: 20, predicted_ms: Math.max(1, maxTokens) * (1000 / TPS), predicted_per_second: TPS },
  };
}

function buildFullResponse(classified, maxTokens) {
  const { usage, timings } = usageAndTimings(maxTokens);
  if (classified.mode === 'drain') {
    const reasoning = 'thinking '.repeat(Math.max(1, Math.ceil(maxTokens / 2)));
    return {
      choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: reasoning } }],
      usage,
      timings,
    };
  }
  if (classified.mode === 'tool') {
    return {
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_0', type: 'function', function: { name: classified.toolName, arguments: JSON.stringify(classified.args) } }],
        },
      }],
      usage,
      timings,
    };
  }
  return {
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: classified.text } }],
    usage,
    timings,
  };
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sendStream(res, classified, maxTokens) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const intervalMs = Math.max(5, Math.round(1000 / TPS));
  let timer = null;

  const finish = (finishReason) => {
    if (timer) clearInterval(timer);
    const { usage, timings } = usageAndTimings(maxTokens);
    sseWrite(res, { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage, timings });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  res.on('close', () => { if (timer) clearInterval(timer); });

  if (classified.mode === 'tool') {
    sseWrite(res, {
      choices: [{
        index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: classified.toolName, arguments: JSON.stringify(classified.args) } }] },
        finish_reason: null,
      }],
    });
    timer = setTimeout(() => finish('tool_calls'), intervalMs);
    return;
  }

  if (classified.mode === 'drain') {
    let sent = 0;
    timer = setInterval(() => {
      if (sent >= maxTokens) { finish('length'); return; }
      sseWrite(res, { choices: [{ index: 0, delta: { reasoning_content: 'thinking ' }, finish_reason: null }] });
      sent++;
    }, intervalMs);
    return;
  }

  const words = String(classified.text).split(/(\s+)/).filter((w) => w.length > 0);
  let i = 0;
  timer = setInterval(() => {
    if (i >= words.length) { finish('stop'); return; }
    sseWrite(res, { choices: [{ index: 0, delta: { content: words[i] }, finish_reason: null }] });
    i++;
  }, intervalMs);
}

async function handleChatCompletions(req, res, pathname) {
  const raw = await readBody(req);
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  logRequest('POST', pathname, body);

  const maxTokens = Math.max(1, Number(body.n_predict ?? body.max_tokens ?? 64));
  const classified = classify(body);

  if (body.stream === true) {
    sendStream(res, classified, maxTokens);
  } else {
    sendJson(res, 200, buildFullResponse(classified, maxTokens));
  }
}

// ---------------------------------------------------------------------------
// The rest of the surface
// ---------------------------------------------------------------------------

function handleHealth(res) {
  const elapsed = Date.now() - STARTED_AT;
  if (elapsed < LOAD_MS) { sendJson(res, 503, { status: 'loading model' }); return; }
  sendJson(res, 200, { status: 'ok' });
}

let modelsToggle = false;
function handleModels(res) {
  modelsToggle = !modelsToggle;
  sendJson(res, 200, modelsToggle
    ? { models: [{ name: 'qwen3.5-4b-fake' }] }
    : { data: [{ id: 'qwen3.5-4b-fake' }] });
}

function handleProps(res) {
  sendJson(res, 200, { default_generation_settings: { n_ctx: 4096 }, total_slots: 1 });
}

const server = createServer((req, res) => {
  Promise.resolve()
    .then(async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') { logRequest('GET', url.pathname); handleHealth(res); return; }
      if (req.method === 'GET' && url.pathname === '/v1/models') { logRequest('GET', url.pathname); handleModels(res); return; }
      if (req.method === 'GET' && url.pathname === '/props') { logRequest('GET', url.pathname); handleProps(res); return; }
      if (req.method === 'GET' && url.pathname === '/__requests') { sendJson(res, 200, requestLog); return; }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') { await handleChatCompletions(req, res, url.pathname); return; }
      sendJson(res, 404, { error: 'not found' });
    })
    .catch((err) => {
      try { sendJson(res, 500, { error: String((err && err.message) || err) }); } catch { /* response already sent */ }
    });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake-engine listening on 127.0.0.1:${PORT} (load ${LOAD_MS}ms, tps ${TPS})`);
});
