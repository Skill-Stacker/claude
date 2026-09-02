import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTts, floatWavBuffer } from '../app/lib/speech/tts.js';

// ---------------------------------------------------------------------------
// A fake kokoro-js: KokoroTTS.from_pretrained resolves to an object exposing
// `.voices` and `generate(text, { voice })`, recording every call so tests
// can assert ordering, chunk text, and the voice used.
// ---------------------------------------------------------------------------

const FAKE_VOICES = {
  af_heart: { name: 'Heart', language: 'en-us', gender: 'F', overallGrade: 'A' },
  af_bella: { name: 'Bella', language: 'en-us', gender: 'F', overallGrade: 'A-' },
  af_nicole: { name: 'Nicole', language: 'en-us', gender: 'F', overallGrade: 'B-' },
  am_adam: { name: 'Adam', language: 'en-us', gender: 'M', overallGrade: 'F+' },
};

function makeFakeKokoro({ voices = FAKE_VOICES, samplesFor } = {}) {
  const calls = [];

  class FakeKokoroTTS {
    get voices() {
      return voices;
    }
    static async from_pretrained() {
      return new FakeKokoroTTS();
    }
    async generate(text, { voice }) {
      calls.push({ text, voice });
      const samples = samplesFor ? samplesFor(text) : new Float32Array([0, 0.25, -0.25, 0.5, -0.5]);
      return { audio: samples, sampling_rate: 24000 };
    }
  }

  return { module: { KokoroTTS: FakeKokoroTTS }, calls };
}

// A deterministic, word-count-based scrub stand-in, independent of the real
// scrub.js (owned separately): forSpeech() is a pass-through, firstClause()
// returns the leading `minWords` words as a real prefix (or null for short
// text), and chunkForKokoro() splits on plain word count. This lets tests
// assert tts.js's own chunking/ordering/abort logic without depending on
// scrub.js's exact sentence-splitting rules.
function fakeScrub() {
  return {
    forSpeech: (text) => String(text),
    firstClause: (text, { minWords = 6 } = {}) => {
      const words = String(text).trim().split(/\s+/).filter(Boolean);
      if (words.length <= minWords) return null;
      return words.slice(0, minWords).join(' ');
    },
    chunkForKokoro: (text, { maxWords = 85 } = {}) => {
      const words = String(text).trim().split(/\s+/).filter(Boolean);
      const chunks = [];
      for (let i = 0; i < words.length; i += maxWords) {
        chunks.push(words.slice(i, i + maxWords).join(' '));
      }
      return chunks;
    },
  };
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function makeWords(n, prefix = 'word') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
}

function makePaths() {
  const base = mkdtempSync(join(tmpdir(), 'stickos-tts-'));
  return { voices: join(base, 'voices') };
}

// Parses a WAV buffer written by floatWavBuffer()/tts.js back into its
// parts, independent of tts.js's own writer, so the header test is a real
// round trip rather than checking the writer against itself.
function parseFloatWav(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.toString('ascii', 12, 16), 'fmt ');
  const fmtSize = buf.readUInt32LE(16);
  assert.equal(fmtSize, 16);
  const formatTag = buf.readUInt16LE(20);
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const byteRate = buf.readUInt32LE(28);
  const blockAlign = buf.readUInt16LE(32);
  const bitsPerSample = buf.readUInt16LE(34);
  assert.equal(buf.toString('ascii', 36, 40), 'data');
  const dataSize = buf.readUInt32LE(40);
  const sampleCount = dataSize / 4;
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) samples[i] = buf.readFloatLE(44 + i * 4);
  return { formatTag, channels, sampleRate, byteRate, blockAlign, bitsPerSample, dataSize, samples };
}

// ---------------------------------------------------------------------------

describe('floatWavBuffer', () => {
  test('writes a float32 mono RIFF header that parses back exactly', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const buf = floatWavBuffer(samples, 24000);
    const parsed = parseFloatWav(buf);
    assert.equal(parsed.formatTag, 3); // IEEE float
    assert.equal(parsed.channels, 1);
    assert.equal(parsed.sampleRate, 24000);
    assert.equal(parsed.bitsPerSample, 32);
    assert.equal(parsed.blockAlign, 4);
    assert.equal(parsed.byteRate, 24000 * 4);
    assert.equal(parsed.samples.length, samples.length);
    for (let i = 0; i < samples.length; i++) assert.equal(parsed.samples[i], samples[i]);
  });
});

describe('createTts', () => {
  test('ready flips from false to true across load()', async () => {
    const fake = makeFakeKokoro();
    const tts = createTts({ paths: makePaths(), kokoro: fake.module, scrub: fakeScrub(), log: () => {} });
    assert.equal(tts.ready, false);
    await tts.load();
    assert.equal(tts.ready, true);
  });

  test('voices() maps the simplified grade scheme and reports the current voice', async () => {
    const fake = makeFakeKokoro();
    const tts = createTts({ paths: makePaths(), kokoro: fake.module, scrub: fakeScrub(), log: () => {} });
    await tts.load();

    const { voices, current } = tts.voices();
    assert.equal(current, 'af_heart');
    const byId = Object.fromEntries(voices.map((v) => [v.id, v]));
    assert.equal(byId.af_heart.grade, 'A');
    assert.equal(byId.af_bella.grade, 'B');
    assert.equal(byId.af_nicole.grade, 'B');
    assert.equal(byId.am_adam.grade, 'C');
    assert.equal(byId.af_heart.label, 'Heart');

    tts.setVoice('af_bella');
    assert.equal(tts.voices().current, 'af_bella');
  });

  test('setVoice() rejects an unknown voice once the model is loaded', async () => {
    const fake = makeFakeKokoro();
    const tts = createTts({ paths: makePaths(), kokoro: fake.module, scrub: fakeScrub(), log: () => {} });
    await tts.load();
    assert.throws(() => tts.setVoice('not_a_real_voice'));
  });

  test('first-clause fast start: the first chunk emitted is the first clause, then the rest chunked under 85 words', async () => {
    const fake = makeFakeKokoro();
    const tts = createTts({ paths: makePaths(), kokoro: fake.module, scrub: fakeScrub(), log: () => {} });

    // 6-word clause, then 94 more words: 85 + 9 across two more chunks.
    const clauseWords = 'Hello there, this is Scout speaking';
    const restWords = makeWords(94);
    const text = `${clauseWords} ${restWords}`;

    const chunks = [];
    await tts.synthesizeSentences(text, { onChunk: (c) => chunks.push(c) });

    assert.equal(chunks.length, 3, 'expected clause + 2 body chunks (85 + 9 words)');
    assert.deepEqual(chunks.map((c) => c.seq), [1, 2, 3]);
    assert.equal(chunks[0].text, clauseWords, 'first chunk must be exactly the first clause (fast start)');
    assert.equal(wordCount(chunks[1].text), 85);
    assert.equal(wordCount(chunks[2].text), 9);

    for (const c of chunks) {
      assert.ok(wordCount(c.text) <= 85, `chunk exceeded 85 words: "${c.text}"`);
    }

    assert.equal(fake.calls.length, 3);
    assert.deepEqual(fake.calls.map((c) => c.text), chunks.map((c) => c.text));
    assert.ok(fake.calls.every((c) => c.voice === 'af_heart'));
  });

  test('each onChunk carries a well-formed WAV built from the generated audio', async () => {
    const samples = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    const fake = makeFakeKokoro({ samplesFor: () => samples });
    const tts = createTts({ paths: makePaths(), kokoro: fake.module, scrub: fakeScrub(), log: () => {} });

    const chunks = [];
    await tts.synthesizeSentences('short text', { onChunk: (c) => chunks.push(c) });

    assert.equal(chunks.length, 1);
    const parsed = parseFloatWav(chunks[0].wav);
    assert.equal(parsed.sampleRate, 24000);
    assert.equal(parsed.samples.length, samples.length);
    for (let i = 0; i < samples.length; i++) {
      assert.ok(Math.abs(parsed.samples[i] - samples[i]) < 1e-6);
    }
  });

  test('aborting the caller-supplied signal mid-way stops synthesis after the in-flight chunk', async () => {
    const fake = makeFakeKokoro();
    const tts = createTts({ paths: makePaths(), kokoro: fake.module, scrub: fakeScrub(), log: () => {} });

    const text = `${makeWords(10)} ${makeWords(85)} ${makeWords(85)}`; // clause + 2 body chunks
    const controller = new AbortController();
    const chunks = [];

    await tts.synthesizeSentences(text, {
      signal: controller.signal,
      onChunk: (c) => {
        chunks.push(c);
        if (c.seq === 1) controller.abort(); // abort right after the first (clause) chunk
      },
    });

    assert.equal(chunks.length, 1, 'only the in-flight chunk should have been delivered');
    assert.equal(fake.calls.length, 1);
  });

  test('one voice at a time: starting a new synthesis aborts whatever was still running', async () => {
    const fake = makeFakeKokoro();
    const tts = createTts({ paths: makePaths(), kokoro: fake.module, scrub: fakeScrub(), log: () => {} });

    const run1Chunks = [];
    const run2Chunks = [];

    // Started but not awaited: its synchronous prefix runs immediately.
    const p1 = tts.synthesizeSentences(makeWords(20), { onChunk: (c) => run1Chunks.push(c) });
    // Starting immediately, in the same tick, aborts run 1 before it can
    // produce anything (see tts.js: a new call aborts currentRun synchronously).
    const p2 = tts.synthesizeSentences(makeWords(3), { onChunk: (c) => run2Chunks.push(c) });

    await Promise.all([p1, p2]);

    assert.equal(run1Chunks.length, 0, 'the superseded run should not have emitted any chunk');
    assert.equal(run2Chunks.length, 1, 'the newer run should complete normally');
  });

  test('uses the real scrub.js end to end without throwing (no injected scrub)', async () => {
    const fake = makeFakeKokoro();
    const tts = createTts({ paths: makePaths(), kokoro: fake.module, log: () => {} });
    const chunks = [];
    await tts.synthesizeSentences('Hello! This is a short test message for Scout.', {
      onChunk: (c) => chunks.push(c),
    });
    assert.ok(chunks.length >= 1);
    for (const c of chunks) {
      assert.ok(Buffer.isBuffer(c.wav));
      assert.ok(c.wav.length > 44);
    }
  });
});
