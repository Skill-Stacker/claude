import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLlm, buildEnumGrammar } from '../app/lib/llm.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = join(HERE, '..', 'tools', 'fake-engine.mjs');

// ---------------------------------------------------------------------------
// Spins up one fake-engine.mjs per describe block and tears it down after.
// ---------------------------------------------------------------------------

function startFakeEngine({ port, loadMs = 30, tps = 200, helpFlags } = {}) {
  const args = [FAKE_ENGINE, '--port', String(port), '--load-ms', String(loadMs), '--tps', String(tps)];
  if (helpFlags) args.push('--help-flags', helpFlags);
  const proc = nodeSpawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    proc,
    baseUrl,
    async ready() {
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          const res = await fetch(`${baseUrl}/health`);
          if (res.status === 200) {
            const body = await res.json();
            if (body.status === 'ok') return;
          }
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) throw new Error('fake-engine never became ready');
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => proc.once('exit', r));
    },
    async requests() {
      return fetch(`${baseUrl}/__requests`).then((r) => r.json());
    },
  };
}

let nextPort = 8710; // well clear of the real engine's 8080-8084 walk

// ---------------------------------------------------------------------------
// buildEnumGrammar: pure function
// ---------------------------------------------------------------------------

describe('buildEnumGrammar', () => {
  test('builds one alternative per value, quoted', () => {
    const grammar = buildEnumGrammar(['weather', 'reminder', 'chat']);
    assert.equal(grammar, 'root ::= "weather" | "reminder" | "chat"');
  });

  test('escapes quotes and backslashes', () => {
    const grammar = buildEnumGrammar(['say "hi"', 'back\\slash']);
    assert.equal(grammar, 'root ::= "say \\"hi\\"" | "back\\\\slash"');
  });
});

// ---------------------------------------------------------------------------
// chat(): the missing-flag drain bug, reproduced and prevented
// ---------------------------------------------------------------------------

describe('chat() and the reasoning drain bug', () => {
  test('the raw endpoint drains into reasoning_content when the flag is missing', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const res = await fetch(`${fake.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], max_tokens: 6 }),
      });
      const data = await res.json();
      assert.equal(data.choices[0].finish_reason, 'length');
      assert.equal(data.choices[0].message.content, '');
      assert.ok(data.choices[0].message.reasoning_content.length > 0);
    } finally {
      await fake.stop();
    }
  });

  test('chat() always sets chat_template_kwargs and never drains', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const llm = createLlm({ baseUrl: fake.baseUrl });
      const result = await llm.chat({ messages: [{ role: 'user', content: 'hello there' }] });
      assert.equal(result.finishReason, 'stop');
      assert.equal(result.content, 'You said: hello there');

      const requests = await fake.requests();
      const last = requests[requests.length - 1];
      assert.equal(last.body.chat_template_kwargs.enable_thinking, false);
    } finally {
      await fake.stop();
    }
  });

  test('streaming deltas arrive via onDelta and assemble into the full content', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port, tps: 40 });
    try {
      await fake.ready();
      const llm = createLlm({ baseUrl: fake.baseUrl });
      const deltas = [];
      const result = await llm.chat({
        messages: [{ role: 'user', content: 'stream this back' }],
        stream: true,
        onDelta: (d) => deltas.push(d),
      });
      assert.equal(result.content, 'You said: stream this back');
      assert.equal(result.finishReason, 'stop');
      assert.ok(deltas.length > 1, 'expected more than one delta chunk');
      assert.equal(deltas.map((d) => d.content).join(''), 'You said: stream this back');
    } finally {
      await fake.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// intent()
// ---------------------------------------------------------------------------

describe('intent()', () => {
  test('returns the enum value present in the message', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const llm = createLlm({ baseUrl: fake.baseUrl });
      const result = await llm.intent({
        messages: [{ role: 'user', content: 'what is the weather like' }],
        enumValues: ['weather', 'reminder', 'chat'],
      });
      assert.equal(result, 'weather');
    } finally {
      await fake.stop();
    }
  });

  // The fake engine's grammar simulation always answers with one of the
  // offered alternatives (defaulting to the first when none match the
  // user text), same as a real grammar-constrained llama.cpp reply would
  // almost always do. The 'chat' fallback in intent() is a defense
  // against the rarer case of the server failing open on the grammar and
  // returning something outside it, so it is exercised directly against
  // a stub fetch rather than through the fake engine.
  function stubFetchReturning(content) {
    return async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }),
    });
  }

  test('falls back to chat when the reply is not one of the values', async () => {
    const llm = createLlm({ baseUrl: 'http://127.0.0.1:1', fetch: stubFetchReturning('banana') });
    const result = await llm.intent({
      messages: [{ role: 'user', content: 'tell me a joke' }],
      enumValues: ['weather', 'reminder'],
    });
    assert.equal(result, 'chat');
  });

  test('trims whitespace and quotes around a valid value', async () => {
    const llm = createLlm({ baseUrl: 'http://127.0.0.1:1', fetch: stubFetchReturning('  "weather"  \n') });
    const result = await llm.intent({
      messages: [{ role: 'user', content: 'anything' }],
      enumValues: ['weather', 'reminder'],
    });
    assert.equal(result, 'weather');
  });

  test('sends n_predict 8 and temperature 0, no tools', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const llm = createLlm({ baseUrl: fake.baseUrl });
      await llm.intent({ messages: [{ role: 'user', content: 'weather' }], enumValues: ['weather', 'chat'] });
      const requests = await fake.requests();
      const last = requests[requests.length - 1];
      assert.equal(last.body.n_predict, 8);
      assert.equal(last.body.temperature, 0);
      assert.equal(last.body.tools, undefined);
      assert.match(last.body.grammar, /^root ::= "weather" \| "chat"$/);
    } finally {
      await fake.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

describe('chat() with tools', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'set_timer',
      description: 'Set a timer',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          iso_time: { type: 'string' },
        },
      },
    },
  }];

  test('returns parsed arguments and sends the llama.cpp tool_choice shape', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const llm = createLlm({ baseUrl: fake.baseUrl });
      const result = await llm.chat({
        messages: [{ role: 'user', content: 'set a timer for bread' }],
        tools,
        toolChoice: 'set_timer',
      });
      assert.equal(result.toolCalls.length, 1);
      assert.equal(result.toolCalls[0].name, 'set_timer');
      assert.equal(typeof result.toolCalls[0].arguments, 'object');
      assert.ok(result.toolCalls[0].arguments.iso_time);
      assert.equal(result.toolCalls[0].raw, JSON.stringify(result.toolCalls[0].arguments));
      assert.equal(result.finishReason, 'tool_calls');

      const requests = await fake.requests();
      const last = requests[requests.length - 1];
      assert.deepEqual(last.body.tool_choice, { type: 'tool', name: 'set_timer' });
      assert.equal(last.body.chat_template_kwargs.enable_thinking, false);
    } finally {
      await fake.stop();
    }
  });

  test('an already-shaped tool_choice object passes through unchanged', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const llm = createLlm({ baseUrl: fake.baseUrl });
      await llm.chat({
        messages: [{ role: 'user', content: 'go' }],
        tools,
        toolChoice: { type: 'tool', name: 'set_timer' },
      });
      const requests = await fake.requests();
      const last = requests[requests.length - 1];
      assert.deepEqual(last.body.tool_choice, { type: 'tool', name: 'set_timer' });
    } finally {
      await fake.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// warm(), health(), models(), props()
// ---------------------------------------------------------------------------

describe('warm/health/models/props', () => {
  test('warm() returns timings', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const llm = createLlm({ baseUrl: fake.baseUrl });
      const timings = await llm.warm([{ role: 'user', content: 'prime the cache' }]);
      assert.ok(timings);
      assert.equal(typeof timings.predicted_per_second, 'number');
    } finally {
      await fake.stop();
    }
  });

  test('health(), models() and props() read the fake engine surface', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const llm = createLlm({ baseUrl: fake.baseUrl });

      const health = await llm.health();
      assert.equal(health.ok, true);
      assert.equal(health.body.status, 'ok');

      const modelNames = await llm.models();
      assert.ok(Array.isArray(modelNames));
      assert.ok(modelNames.length > 0);

      const props = await llm.props();
      assert.equal(typeof props.default_generation_settings.n_ctx, 'number');
      assert.equal(typeof props.total_slots, 'number');
    } finally {
      await fake.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Timeouts and aborts
// ---------------------------------------------------------------------------

describe('timeouts', () => {
  test('an external AbortSignal aborts an in-flight streaming request', async () => {
    const port = nextPort++;
    // Slow token pacing so there is time to abort mid-stream.
    const fake = startFakeEngine({ port, tps: 3 });
    try {
      await fake.ready();
      const llm = createLlm({ baseUrl: fake.baseUrl });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 60);
      await assert.rejects(
        llm.chat({
          messages: [{ role: 'user', content: 'this is a longer message with more words to stream slowly back' }],
          stream: true,
          maxTokens: 40,
          signal: controller.signal,
        }),
      );
    } finally {
      await fake.stop();
    }
  });

  test('a short per-request timeout aborts a slow non-streaming request', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      // fetch stub that never resolves on its own, to exercise the
      // timeout path without depending on real engine latency. It does
      // honor the abort signal, exactly like real fetch, since that is
      // the mechanism the timeout is built on.
      const hangingFetch = (url, options) => new Promise((resolvePromise, rejectPromise) => {
        options?.signal?.addEventListener('abort', () => {
          rejectPromise(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
      const llm = createLlm({ baseUrl: fake.baseUrl, fetch: hangingFetch, timeoutMs: 50 });
      await assert.rejects(llm.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    } finally {
      await fake.stop();
    }
  });
});
