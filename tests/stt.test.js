import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStt } from '../app/lib/speech/stt.js';
import { ensureSttModel, isSttModelPresent } from '../app/lib/speech/models.js';
import { downloadAsset } from '../app/lib/downloads.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_APP_DIR = join(HERE, '..', 'app');

// ---------------------------------------------------------------------------
// A fake sherpa-onnx-node: records every call and returns text derived from
// the sample count it was asked to decode, so tests can tell which decode
// produced which partial/final without depending on real recognition.
// ---------------------------------------------------------------------------

function makeFakeSherpa() {
  const decodeCalls = [];

  class FakeOfflineStream {
    acceptWaveform({ sampleRate, samples }) {
      this.sampleRate = sampleRate;
      this.samples = samples;
    }
  }

  class FakeOfflineRecognizer {
    constructor(config) {
      this.config = config;
    }
    createStream() {
      return new FakeOfflineStream();
    }
    decode(stream) {
      decodeCalls.push({ sampleRate: stream.sampleRate, samples: stream.samples });
      stream._text = `len:${stream.samples.length}`;
    }
    getResult(stream) {
      return { text: stream._text || '' };
    }
  }

  return { module: { OfflineRecognizer: FakeOfflineRecognizer }, decodeCalls };
}

// ---------------------------------------------------------------------------
// A minimal on-disk manifest + "model" (just the expected file names, empty
// contents) so models.js's isSttModelPresent()/sttModelDir() are satisfied
// without touching the real app/manifest.json or downloading anything.
// ---------------------------------------------------------------------------

function makeFakePaths(ids) {
  const root = mkdtempSync(join(tmpdir(), 'stickos-stt-'));
  const app = join(root, 'app');
  const voices = join(root, 'voices');
  mkdirSync(app, { recursive: true });
  mkdirSync(voices, { recursive: true });

  const stt = { default: ids[0] };
  for (const id of ids) {
    const dir = `${id}-dir`;
    stt[id] = { url: `https://example.invalid/${id}.tar.bz2`, size: null, sha256: null, dir };
    const modelDir = join(voices, dir);
    mkdirSync(modelDir, { recursive: true });
    for (const f of ['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx', 'tokens.txt']) {
      writeFileSync(join(modelDir, f), 'x');
    }
  }
  writeFileSync(join(app, 'manifest.json'), JSON.stringify({ stt }));
  return { root, app, voices };
}

// PCM16LE helpers -----------------------------------------------------------

function loudPcm16(sampleCount, { frequency = 440, sampleRate = 16000, amplitude = 0.5 } = {}) {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const v = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

function silentPcm16(sampleCount) {
  return Buffer.alloc(sampleCount * 2);
}

function ticks(n = 6) {
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      i += 1;
      if (i >= n) return resolve();
      setImmediate(step);
    };
    setImmediate(step);
  });
}

// ---------------------------------------------------------------------------
// Fake-sherpa driven unit tests
// ---------------------------------------------------------------------------

describe('createStt with a fake sherpa module', () => {
  test('load() constructs the recognizer for the configured engine and flips ready', async () => {
    const paths = makeFakePaths(['moonshine-x']);
    const fake = makeFakeSherpa();
    const stt = createStt({ paths, engineId: 'moonshine-x', sherpa: fake.module, log: () => {} });
    assert.equal(stt.ready, false);
    await stt.load();
    assert.equal(stt.ready, true);
    assert.equal(stt.engineId, 'moonshine-x');
  });

  test('load() throws when the model files are not present, and does not construct a recognizer', async () => {
    const paths = makeFakePaths(['moonshine-x']);
    rmSync(join(paths.voices, 'moonshine-x-dir', 'tokens.txt'));
    const fake = makeFakeSherpa();
    const stt = createStt({ paths, engineId: 'moonshine-x', sherpa: fake.module, log: () => {} });
    await assert.rejects(() => stt.load(), /not present/);
    assert.equal(stt.ready, false);
  });

  test('converts PCM16LE to float32 in [-1, 1] before handing it to the recognizer', async () => {
    const paths = makeFakePaths(['moonshine-x']);
    const fake = makeFakeSherpa();
    const stt = createStt({ paths, engineId: 'moonshine-x', sherpa: fake.module, log: () => {} });
    await stt.load();

    const buf = Buffer.alloc(6);
    buf.writeInt16LE(32767, 0); // max positive
    buf.writeInt16LE(-32768, 2); // max negative
    buf.writeInt16LE(0, 4); // silence sample, but not a silent buffer overall

    await stt.transcribeBuffer(buf, 16000);
    assert.equal(fake.decodeCalls.length, 1);
    const samples = fake.decodeCalls[0].samples;
    assert.equal(samples.length, 3);
    assert.ok(Math.abs(samples[0] - 1) < 1e-4, `expected ~1, got ${samples[0]}`);
    assert.ok(Math.abs(samples[1] - -1) < 1e-4, `expected ~-1, got ${samples[1]}`);
    assert.equal(samples[2], 0);
    assert.equal(fake.decodeCalls[0].sampleRate, 16000);
  });

  test('an empty buffer returns an empty final without calling decode', async () => {
    const paths = makeFakePaths(['moonshine-x']);
    const fake = makeFakeSherpa();
    const stt = createStt({ paths, engineId: 'moonshine-x', sherpa: fake.module, log: () => {} });
    await stt.load();

    const result = await stt.transcribeBuffer(Buffer.alloc(0), 16000);
    assert.equal(result.text, '');
    assert.equal(fake.decodeCalls.length, 0);
  });

  test('a near-silent buffer returns an empty final without calling decode', async () => {
    const paths = makeFakePaths(['moonshine-x']);
    const fake = makeFakeSherpa();
    const stt = createStt({ paths, engineId: 'moonshine-x', sherpa: fake.module, log: () => {} });
    await stt.load();

    const result = await stt.transcribeBuffer(silentPcm16(16000), 16000);
    assert.equal(result.text, '');
    assert.equal(fake.decodeCalls.length, 0);
  });

  test('createStream() emits a partial after 1.5s of new audio, and final() decodes everything', async () => {
    const paths = makeFakePaths(['moonshine-x']);
    const fake = makeFakeSherpa();
    const stt = createStt({ paths, engineId: 'moonshine-x', sherpa: fake.module, log: () => {} });
    await stt.load();

    const partials = [];
    const stream = stt.createStream({ onPartial: (text) => partials.push(text) });

    // 1.6s of loud audio at 16kHz: enough to cross the 1.5s partial threshold.
    const firstChunkSamples = Math.round(16000 * 1.6);
    stream.push(loudPcm16(firstChunkSamples), { sampleRate: 16000 });
    await ticks();

    assert.equal(partials.length, 1, 'expected exactly one partial after 1.6s of audio');
    assert.equal(partials[0], `len:${firstChunkSamples}`);

    // Less than 1.5s more: no second partial yet.
    const secondChunkSamples = Math.round(16000 * 0.5);
    stream.push(loudPcm16(secondChunkSamples), { sampleRate: 16000 });
    await ticks();
    assert.equal(partials.length, 1, 'a small additional chunk should not trigger another partial');

    const { text, ms } = await stream.final();
    assert.equal(text, `len:${firstChunkSamples + secondChunkSamples}`);
    assert.equal(typeof ms, 'number');
    assert.ok(ms >= 0);
  });

  test('cancel() discards the utterance: final() after cancel is an empty result with no decode', async () => {
    const paths = makeFakePaths(['moonshine-x']);
    const fake = makeFakeSherpa();
    const stt = createStt({ paths, engineId: 'moonshine-x', sherpa: fake.module, log: () => {} });
    await stt.load();

    const stream = stt.createStream({});
    stream.push(loudPcm16(16000), { sampleRate: 16000 });
    await ticks();
    const callsBeforeCancel = fake.decodeCalls.length;

    stream.cancel();
    const { text } = await stream.final();
    assert.equal(text, '');
    assert.equal(fake.decodeCalls.length, callsBeforeCancel, 'cancel must not trigger another decode');
  });

  test('caps an utterance at 60s: further audio past the cap is dropped', async () => {
    const paths = makeFakePaths(['moonshine-x']);
    const fake = makeFakeSherpa();
    const stt = createStt({ paths, engineId: 'moonshine-x', sherpa: fake.module, log: () => {} });
    await stt.load();

    const stream = stt.createStream({});
    // 61 seconds in one push: should be truncated to the 60s cap.
    stream.push(loudPcm16(16000 * 61), { sampleRate: 16000 });
    await ticks();

    assert.equal(stream.capped, true);
    const durationAtCap = stream.durationMs;
    assert.ok(durationAtCap <= 60000 + 1, `expected <=60000ms, got ${durationAtCap}`);
    assert.ok(durationAtCap > 59000, `expected close to 60000ms, got ${durationAtCap}`);

    stream.push(loudPcm16(16000), { sampleRate: 16000 }); // ignored: already capped
    assert.equal(stream.durationMs, durationAtCap);
  });

  test('switchEngine() resets ready until load() is called again for the new engine', async () => {
    const paths = makeFakePaths(['engine-a', 'engine-b']);
    const fake = makeFakeSherpa();
    const stt = createStt({ paths, engineId: 'engine-a', sherpa: fake.module, log: () => {} });
    await stt.load();
    assert.equal(stt.ready, true);

    stt.switchEngine('engine-b');
    assert.equal(stt.engineId, 'engine-b');
    assert.equal(stt.ready, false);

    await stt.load();
    assert.equal(stt.ready, true);
    assert.equal(stt.engineId, 'engine-b');
  });

  test('list() reports every configured engine with a present flag', async () => {
    const paths = makeFakePaths(['engine-a', 'engine-b']);
    rmSync(join(paths.voices, 'engine-b-dir'), { recursive: true, force: true });
    const fake = makeFakeSherpa();
    const stt = createStt({ paths, engineId: 'engine-a', sherpa: fake.module, log: () => {} });

    const list = stt.list();
    const byId = Object.fromEntries(list.map((e) => [e.id, e.present]));
    assert.equal(byId['engine-a'], true);
    assert.equal(byId['engine-b'], false);
  });
});

// ---------------------------------------------------------------------------
// ONE real integration test: downloads the real Moonshine tiny model from
// the manifest URL (GitHub, reachable from this container) and drives the
// real sherpa-onnx-node addon. Skips cleanly if the download itself fails
// (e.g. no network in this environment).
//
// What this verifies, concretely:
//  - ensureSttModel() downloads and extracts a real sherpa-onnx release
//    .tar.bz2 with the real downloadAsset(), and isSttModelPresent() then
//    sees exactly the files models.js documents for a Moonshine bundle.
//  - createStt() with no injected `sherpa` really imports sherpa-onnx-node
//    and builds a working `sherpa_onnx.OfflineRecognizer` from the
//    downloaded model files.
//  - transcribeBuffer() on a real speech WAV (shipped inside the model's
//    own test_wavs/, read and decoded by hand from PCM16) produces text
//    that actually matches what was said, not just "something".
//  - The near-silence guard returns an empty string for 1.5s of digital
//    silence without throwing.
//  - A synthetic 440Hz tone (non-speech) round-trips through the real
//    recognizer without throwing.
// ---------------------------------------------------------------------------

// Reads a canonical 16-bit PCM WAV file's data chunk directly (no
// dependency on sherpa's own readWave, so this exercises an independent
// path into transcribeBuffer). Scans chunks rather than assuming a fixed
// 44-byte header.
function readPcm16Wav(path) {
  const buf = readFileSync(path);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') fmt = { audioFormat: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4) };
    if (id === 'data') data = buf.subarray(body, body + size);
    offset = body + size + (size % 2);
  }
  assert.ok(fmt && data, 'malformed WAV: missing fmt or data chunk');
  assert.equal(fmt.audioFormat, 1, 'expected PCM');
  assert.equal(fmt.channels, 1, 'expected mono');
  return { sampleRate: fmt.sampleRate, pcm: data };
}

test(
  'real Moonshine tiny model: download, load, and transcribe',
  { timeout: 180000 },
  async (t) => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'stickos-stt-real-'));
    const paths = { app: REAL_APP_DIR, voices: join(tmpRoot, 'voices') };
    const modelId = 'moonshine-tiny';

    try {
      await ensureSttModel(paths, modelId, { download: downloadAsset });
    } catch (err) {
      t.skip(`could not download the real moonshine-tiny model, skipping: ${(err && err.message) || err}`);
      return;
    }

    assert.equal(isSttModelPresent(paths, modelId), true);

    const stt = createStt({ paths, engineId: modelId, log: () => {} });
    await stt.load();
    assert.equal(stt.ready, true);

    const wavPath = join(paths.voices, 'sherpa-onnx-moonshine-tiny-en-int8', 'test_wavs', '0.wav');
    if (!existsSync(wavPath)) {
      t.skip('downloaded model bundle did not include test_wavs/0.wav, skipping the real-speech assertion');
    } else {
      const { sampleRate, pcm } = readPcm16Wav(wavPath);
      const { text, ms } = await stt.transcribeBuffer(pcm, sampleRate);
      const lower = text.toLowerCase();
      assert.ok(lower.includes('nightfall'), `expected "nightfall" in transcript, got: ${text}`);
      assert.ok(lower.includes('brothels'), `expected "brothels" in transcript, got: ${text}`);
      assert.ok(ms >= 0);
    }

    // Silence guard against the real recognizer: no crash, empty text.
    const silence = await stt.transcribeBuffer(silentPcm16(24000), 16000); // 1.5s
    assert.equal(silence.text, '');

    // A synthetic tone (non-speech) must not crash the real addon either.
    const tone = await stt.transcribeBuffer(loudPcm16(16000, { frequency: 440, amplitude: 0.2 }), 16000);
    assert.equal(typeof tone.text, 'string');

    rmSync(tmpRoot, { recursive: true, force: true });
  },
);
