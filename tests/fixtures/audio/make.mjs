#!/usr/bin/env node
// Generates the tiny WAV fixtures tests/voice-client.test.js reads: a 16
// kHz mono sine sweep, written once as PCM16 and once as IEEE float32 (so
// the header parser is exercised against both encodings kokoro-js and the
// browser's own encoder actually produce), plus a silent PCM16 clip.
//
// Run directly (`node tests/fixtures/audio/make.mjs`) to write the files by
// hand, or import `generate()` from a test's `before` hook so the fixtures
// always exist before the assertions run, with no separate build step.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 16000;
const DURATION_S = 0.5;
const SWEEP_FROM_HZ = 220;
const SWEEP_TO_HZ = 2000;

export const FIXTURE_PATHS = {
  sinePcm16: path.join(HERE, 'sine-pcm16.wav'),
  sineFloat32: path.join(HERE, 'sine-float32.wav'),
  silent: path.join(HERE, 'silent.wav'),
};

function sineSweepSamples(sampleRate, durationS, fromHz, toHz) {
  const n = Math.round(sampleRate * durationS);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // Linear frequency sweep: instantaneous phase is the integral of a
    // linearly changing frequency, f0*t + (f1-f0)*t^2 / (2*duration).
    const phase = 2 * Math.PI * (fromHz * t + ((toHz - fromHz) * t * t) / (2 * durationS));
    out[i] = Math.sin(phase) * 0.8;
  }
  return out;
}

function buildWavHeader({ dataLength, numChannels, sampleRate, bitsPerSample, audioFormat }) {
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(audioFormat, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function encodePcm16(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    data.writeInt16LE(Math.round(value), i * 2);
  }
  const header = buildWavHeader({ dataLength: data.length, numChannels: 1, sampleRate, bitsPerSample: 16, audioFormat: 1 });
  return Buffer.concat([header, data]);
}

function encodeFloat32(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) data.writeFloatLE(samples[i], i * 4);
  const header = buildWavHeader({ dataLength: data.length, numChannels: 1, sampleRate, bitsPerSample: 32, audioFormat: 3 });
  return Buffer.concat([header, data]);
}

export async function generate() {
  await mkdir(HERE, { recursive: true });
  const sweep = sineSweepSamples(SAMPLE_RATE, DURATION_S, SWEEP_FROM_HZ, SWEEP_TO_HZ);
  const silence = new Float32Array(Math.round(SAMPLE_RATE * 0.2));

  await writeFile(FIXTURE_PATHS.sinePcm16, encodePcm16(sweep, SAMPLE_RATE));
  await writeFile(FIXTURE_PATHS.sineFloat32, encodeFloat32(sweep, SAMPLE_RATE));
  await writeFile(FIXTURE_PATHS.silent, encodePcm16(silence, SAMPLE_RATE));

  return FIXTURE_PATHS;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generate().then((paths) => {
    for (const [name, p] of Object.entries(paths)) console.log(`wrote ${name}: ${p}`);
  });
}
