// Pure-function tests for the browser voice client. No browser: these
// exercise the WAV parser (audio-player.js), the resampler and PCM16
// conversion (pcm-worklet.js), and confirm lamp.js imports cleanly under
// Node with nothing at module load time reaching for window or document.
//
// Fixtures are generated fresh by tests/fixtures/audio/make.mjs in the
// `before` hook below, so there is nothing binary to keep in sync by hand.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { generate, FIXTURE_PATHS } from './fixtures/audio/make.mjs';
import { parseWavHeader, wavToFloat32 } from '../app/web/audio-player.js';
import { resampleLinear, floatTo16BitPCM, computeRMS, downmixToMono, CHUNK_SAMPLES } from '../app/web/pcm-worklet.js';
import { initLamp } from '../app/web/lamp.js';

before(async () => {
  await generate();
});

async function readArrayBuffer(filePath) {
  const buf = await readFile(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('pcm-worklet: resampling', () => {
  test('resamples a 48 kHz sine to 16 kHz with the right length and peak', () => {
    const fromRate = 48000;
    const toRate = 16000;
    const durationS = 1;
    const n = fromRate * durationS;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / fromRate);

    const out = resampleLinear(input, fromRate, toRate);

    assert.equal(out.length, toRate * durationS);
    let peak = 0;
    for (const s of out) peak = Math.max(peak, Math.abs(s));
    assert.ok(peak > 0.95 && peak <= 1.0001, `peak was ${peak}`);
  });

  test('is a no-op copy when rates already match', () => {
    const input = Float32Array.from([0.1, -0.2, 0.3]);
    const out = resampleLinear(input, 16000, 16000);
    assert.notEqual(out, input); // a copy, not the same array
    assert.deepEqual(Array.from(out), Array.from(input));
  });

  test('downmixes multiple channels by averaging', () => {
    const left = Float32Array.from([1, 1, 1]);
    const right = Float32Array.from([-1, -1, -1]);
    assert.deepEqual(Array.from(downmixToMono([left, right])), [0, 0, 0]);
    // a single channel is handed back unchanged, no copy needed
    assert.equal(downmixToMono([left]), left);
  });

  test('chunk size is 20 ms at 16 kHz', () => {
    assert.equal(CHUNK_SAMPLES, 320);
  });
});

describe('pcm-worklet: PCM16 conversion', () => {
  test('converts float32 to PCM16 little-endian', () => {
    const buf = floatTo16BitPCM(Float32Array.from([0, 0.5, -0.5]));
    const view = new DataView(buf);
    assert.equal(view.getInt16(0, true), 0);
    assert.equal(view.getInt16(2, true), Math.round(0.5 * 0x7fff));
    assert.equal(view.getInt16(4, true), Math.round(-0.5 * 0x8000));
  });

  test('clips out-of-range samples instead of wrapping', () => {
    const buf = floatTo16BitPCM(Float32Array.from([2, -2, 1.5, -1.5]));
    const view = new DataView(buf);
    assert.equal(view.getInt16(0, true), 32767);
    assert.equal(view.getInt16(2, true), -32768);
    assert.equal(view.getInt16(4, true), 32767);
    assert.equal(view.getInt16(6, true), -32768);
  });

  test('computes RMS level', () => {
    assert.equal(computeRMS(new Float32Array(320)), 0);
    assert.equal(computeRMS(new Float32Array(320).fill(1)), 1);
    assert.equal(computeRMS(new Float32Array(0)), 0);
  });
});

describe('audio-player: WAV header parsing', () => {
  test('reads a PCM16 WAV header and samples', async () => {
    const arrayBuffer = await readArrayBuffer(FIXTURE_PATHS.sinePcm16);
    const header = parseWavHeader(arrayBuffer);
    assert.equal(header.audioFormat, 1);
    assert.equal(header.numChannels, 1);
    assert.equal(header.sampleRate, 16000);
    assert.equal(header.bitsPerSample, 16);

    const decoded = wavToFloat32(arrayBuffer);
    assert.equal(decoded.sampleRate, 16000);
    assert.equal(decoded.numberOfChannels, 1);
    assert.equal(decoded.channelData.length, 1);
    let peak = 0;
    for (const s of decoded.channelData[0]) peak = Math.max(peak, Math.abs(s));
    assert.ok(peak > 0.5, `peak was ${peak}`);
  });

  test('reads a float32 WAV header and samples', async () => {
    const arrayBuffer = await readArrayBuffer(FIXTURE_PATHS.sineFloat32);
    const header = parseWavHeader(arrayBuffer);
    assert.equal(header.audioFormat, 3);
    assert.equal(header.bitsPerSample, 32);

    const decoded = wavToFloat32(arrayBuffer);
    assert.equal(decoded.sampleRate, 16000);
    let peak = 0;
    for (const s of decoded.channelData[0]) peak = Math.max(peak, Math.abs(s));
    assert.ok(peak > 0.5, `peak was ${peak}`);
  });

  test('reads the silent WAV as all-zero samples', async () => {
    const arrayBuffer = await readArrayBuffer(FIXTURE_PATHS.silent);
    const decoded = wavToFloat32(arrayBuffer);
    assert.ok(decoded.channelData[0].length > 0);
    for (const s of decoded.channelData[0]) assert.equal(s, 0);
  });

  test('rejects a buffer that is not RIFF/WAVE', () => {
    const bogus = new TextEncoder().encode('not a wav file at all').buffer;
    assert.equal(parseWavHeader(bogus), null);
    assert.equal(wavToFloat32(bogus), null);
  });
});

describe('lamp: importable under Node', () => {
  test('the module loads with no top-level access to window or document', () => {
    // If lamp.js touched a browser global at module load time, the import
    // at the top of this file would already have thrown before this test
    // ever ran. This just confirms the environment really is plain Node
    // (no DOM shim) and that initLamp is what came out of that import.
    assert.equal(typeof globalThis.window, 'undefined');
    assert.equal(typeof initLamp, 'function');
  });
});
