import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../app/server.js';
import { wireVoice } from '../app/lib/speech/voice-routes.js';
import { floatWavBuffer } from '../app/lib/speech/tts.js';

function tmpBase() {
  return mkdtempSync(join(tmpdir(), 'stickos-voice-routes-'));
}

let nextPort = 47360;
function testPort() {
  nextPort += 1;
  return nextPort;
}

// ---------------------------------------------------------------------------
// Fake engines: independent of the real stt.js/tts.js implementations,
// exposing the same shape voice-routes.js consumes, so this file tests the
// wiring (routes, SSE framing, the mic protocol) rather than real speech.
// ---------------------------------------------------------------------------

function makeFakeStt({ ready = true, engineId = 'moonshine-base' } = {}) {
  let currentReady = ready;
  let currentEngine = engineId;
  let switchCalls = 0;
  let loadCalls = 0;

  return {
    get ready() {
      return currentReady;
    },
    get engineId() {
      return currentEngine;
    },
    async load() {
      loadCalls += 1;
      currentReady = true;
    },
    // Emits one partial after 2 pushed frames, matching the real
    // implementation's "partial after enough audio" shape closely enough
    // to exercise the mic protocol end to end.
    createStream({ onPartial } = {}) {
      let pushed = 0;
      let cancelled = false;
      return {
        push() {
          if (cancelled) return;
          pushed += 1;
          if (pushed === 2 && typeof onPartial === 'function') onPartial('partial text');
        },
        async final() {
          return { text: cancelled ? '' : `final:${pushed}`, ms: 42 };
        },
        cancel() {
          cancelled = true;
        },
      };
    },
    async transcribeBuffer() {
      return { text: 'x', ms: 1 };
    },
    switchEngine(id) {
      switchCalls += 1;
      currentEngine = id;
      currentReady = false;
    },
    list() {
      return [
        { id: 'moonshine-base', present: true },
        { id: 'moonshine-tiny', present: false },
      ];
    },
    setReady(v) {
      currentReady = v;
    },
    get switchCalls() {
      return switchCalls;
    },
    get loadCalls() {
      return loadCalls;
    },
  };
}

function makeFakeTts() {
  let voice = 'af_heart';
  return {
    get ready() {
      return true;
    },
    get loadMs() {
      return 10;
    },
    async load() {},
    voices() {
      return {
        voices: [
          { id: 'af_heart', label: 'Heart', grade: 'A' },
          { id: 'af_bella', label: 'Bella', grade: 'B' },
        ],
        current: voice,
      };
    },
    setVoice(id) {
      voice = id;
    },
    async synthesizeSentences(text, { onChunk, signal } = {}) {
      const words = String(text).trim().split(/\s+/).filter(Boolean);
      const parts = [words.slice(0, 3).join(' '), words.slice(3).join(' ')].filter(Boolean);
      let seq = 0;
      for (const part of parts) {
        if (signal && signal.aborted) break;
        seq += 1;
        const wav = floatWavBuffer(new Float32Array([0, 0.1, -0.1, 0.2]), 24000);
        if (typeof onChunk === 'function') onChunk({ seq, wav, text: part });
      }
    },
  };
}

async function startWired({ sttOpts, port } = {}) {
  const app = await startServer({ baseDir: tmpBase(), port: port || testPort() });
  const stt = makeFakeStt(sttOpts);
  const tts = makeFakeTts();
  wireVoice(app, { stt, tts, db: null });
  return { app, stt, tts };
}

// Reads a text/event-stream response to completion, returning [{ type, data }, ...].
async function readAllSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const eventMatch = /^event: (.+)$/m.exec(raw);
      if (!eventMatch) continue; // a ": open" heartbeat/comment line
      const dataMatch = /^data: (.*)$/m.exec(raw);
      events.push({ type: eventMatch[1], data: dataMatch ? JSON.parse(dataMatch[1]) : null });
    }
  }
  return events;
}

function waitOpen(ws) {
  return new Promise((resolvePromise, reject) => {
    ws.onopen = resolvePromise;
    ws.onerror = (event) => reject(new Error('ws error: ' + (event.message || 'unknown')));
  });
}

function nextMessage(ws) {
  return new Promise((resolvePromise) => {
    ws.onmessage = (event) => resolvePromise(JSON.parse(event.data));
  });
}

describe('POST /api/tts', () => {
  test('streams chunk events with base64 WAV, then done', async () => {
    const { app } = await startWired();
    try {
      const res = await fetch(`${app.origin}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ text: 'one two three four five six', profileId: 1 }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

      const events = await readAllSSE(res);
      const chunkEvents = events.filter((e) => e.type === 'chunk');
      const doneEvents = events.filter((e) => e.type === 'done');

      assert.equal(chunkEvents.length, 2);
      assert.equal(doneEvents.length, 1);
      assert.deepEqual(chunkEvents.map((e) => e.data.seq), [1, 2]);
      assert.equal(chunkEvents[0].data.text, 'one two three');

      for (const e of chunkEvents) {
        assert.equal(typeof e.data.wavBase64, 'string');
        const wav = Buffer.from(e.data.wavBase64, 'base64');
        assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
        assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      }

      // "done" is always the last event.
      assert.equal(events[events.length - 1].type, 'done');
    } finally {
      await app.close();
    }
  });

  test('requires the token like every other mutating route', async () => {
    const { app } = await startWired();
    try {
      const res = await fetch(`${app.origin}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      assert.equal(res.status, 401);
    } finally {
      await app.close();
    }
  });

  test('rejects an empty text body', async () => {
    const { app } = await startWired();
    try {
      const res = await fetch(`${app.origin}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ text: '   ' }),
      });
      assert.equal(res.status, 400);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/voices and GET /api/stt/engines', () => {
  test('GET /api/voices reports the voice list and the current voice as default', async () => {
    const { app } = await startWired();
    try {
      const res = await fetch(`${app.origin}/api/voices`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.default, 'af_heart');
      assert.ok(body.voices.some((v) => v.id === 'af_heart' && v.grade === 'A'));
      assert.ok(body.voices.some((v) => v.id === 'af_bella' && v.grade === 'B'));
    } finally {
      await app.close();
    }
  });

  test('GET /api/stt/engines reports every engine with a present flag and the current one', async () => {
    const { app } = await startWired();
    try {
      const res = await fetch(`${app.origin}/api/stt/engines`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.current, 'moonshine-base');
      const byId = Object.fromEntries(body.engines.map((e) => [e.id, e.present]));
      assert.equal(byId['moonshine-base'], true);
      assert.equal(byId['moonshine-tiny'], false);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/status includes voice', () => {
  test('reports stt and tts readiness', async () => {
    const { app } = await startWired();
    try {
      const res = await fetch(`${app.origin}/api/status`);
      const body = await res.json();
      assert.equal(body.voice.stt.ready, true);
      assert.equal(body.voice.stt.engineId, 'moonshine-base');
      assert.equal(body.voice.tts.ready, true);
      assert.equal(body.voice.tts.voice, 'af_heart');
    } finally {
      await app.close();
    }
  });
});

describe('WS /ws/mic', () => {
  test('token, start, binary frames, stop: partial then final', async () => {
    const { app } = await startWired();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws/mic`);
      await waitOpen(ws);

      const messages = [];
      ws.onmessage = (event) => messages.push(JSON.parse(event.data));

      ws.send(JSON.stringify({ token: app.token }));
      ws.send(JSON.stringify({ type: 'start', sampleRate: 16000, profileId: 1 }));
      ws.send(new Uint8Array(320)); // frame 1: no partial yet
      ws.send(new Uint8Array(320)); // frame 2: fake stt emits a partial here

      const deadline = Date.now() + 3000;
      while (!messages.some((m) => m.type === 'partial') && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(messages.some((m) => m.type === 'partial'), 'expected a partial message');
      assert.equal(messages.find((m) => m.type === 'partial').text, 'partial text');

      ws.send(JSON.stringify({ type: 'stop' }));
      const finalDeadline = Date.now() + 3000;
      while (!messages.some((m) => m.type === 'final') && Date.now() < finalDeadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 20));
      }
      const final = messages.find((m) => m.type === 'final');
      assert.ok(final, 'expected a final message');
      assert.equal(final.text, 'final:2');
      assert.equal(typeof final.ms, 'number');

      // partial must have arrived strictly before final.
      const partialIndex = messages.findIndex((m) => m.type === 'partial');
      const finalIndex = messages.findIndex((m) => m.type === 'final');
      assert.ok(partialIndex < finalIndex);

      ws.close(1000, 'done');
      await new Promise((resolvePromise) => {
        ws.onclose = resolvePromise;
      });
    } finally {
      await app.close();
    }
  });

  test('cancel discards the utterance; a fresh start/stop afterwards works normally', async () => {
    const { app } = await startWired();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws/mic`);
      await waitOpen(ws);
      const messages = [];
      ws.onmessage = (event) => messages.push(JSON.parse(event.data));

      ws.send(JSON.stringify({ token: app.token }));
      ws.send(JSON.stringify({ type: 'start', sampleRate: 16000 }));
      ws.send(new Uint8Array(320));
      ws.send(JSON.stringify({ type: 'cancel' }));
      // Give any stray message a moment to (not) arrive.
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(messages.some((m) => m.type === 'final'), false, 'cancel must not produce a final');

      // A fresh utterance after cancel should behave normally.
      ws.send(JSON.stringify({ type: 'start', sampleRate: 16000 }));
      ws.send(new Uint8Array(320));
      ws.send(JSON.stringify({ type: 'stop' }));
      const deadline = Date.now() + 3000;
      while (!messages.some((m) => m.type === 'final') && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 20));
      }
      const final = messages.find((m) => m.type === 'final');
      assert.ok(final);
      assert.equal(final.text, 'final:1'); // only the second utterance's one frame

      ws.close(1000, 'done');
      await new Promise((resolvePromise) => {
        ws.onclose = resolvePromise;
      });
    } finally {
      await app.close();
    }
  });

  test('start while the STT engine is not ready sends a plain-words error', async () => {
    const { app } = await startWired({ sttOpts: { ready: false } });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws/mic`);
      await waitOpen(ws);
      ws.send(JSON.stringify({ token: app.token }));

      const msgPromise = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'start', sampleRate: 16000 }));
      const msg = await msgPromise;

      assert.equal(msg.type, 'error');
      // The fresh temp base dir has no downloaded model, so this is the
      // "still downloading" wording, not the generic "not ready" one.
      assert.equal(msg.message, "Scout's ears are still downloading.");

      ws.close(1000, 'done');
      await new Promise((resolvePromise) => {
        ws.onclose = resolvePromise;
      });
    } finally {
      await app.close();
    }
  });
});
