// Speech-to-text: wraps sherpa-onnx-node's offline (non-streaming)
// recognizer to behave like a streaming one for the mic loop. Moonshine and
// Whisper, as shipped by sherpa-onnx, only decode a whole buffer at once;
// there is no true incremental streaming API for them. So "streaming" here
// means: accumulate PCM16 audio while the mic key is held, and every 1.5s
// of newly-arrived audio, decode everything accumulated so far and report
// that as a `partial`. On stop, decode the whole utterance once more and
// report that as the `final`, with the elapsed time in ms.
//
// Every decode is deferred with setImmediate before it runs, so a decode
// call (a synchronous native addon call that can take a few hundred ms) is
// never started synchronously inside a WebSocket message handler; it always
// yields the current turn of the event loop first, so pending frames on the
// socket get a chance to be read before the decode call blocks the thread.
// The decode call itself still occupies the event loop for its duration
// (sherpa-onnx-node's `decode()` is synchronous C++); see the open
// questions in the handoff for why decodeAsync() was not used instead.
//
// Usage:
//   import { createStt } from './stt.js';
//   const stt = createStt({ paths, engineId: 'moonshine-base', log: console.log });
//   await stt.load();
//   const stream = stt.createStream({ onPartial: (text) => ... });
//   stream.push(pcm16leBuffer, { sampleRate: 16000 });
//   const { text, ms } = await stream.final();

import { join } from 'node:path';

import { sttManifest, sttModelDir, sttEngineFamily, isSttModelPresent, listSttEngines } from './models.js';

const DEFAULT_SAMPLE_RATE = 16000;
const PARTIAL_INTERVAL_MS = 1500;
const MAX_UTTERANCE_MS = 60000;
// RMS threshold (float32 samples, [-1, 1]) below which a buffer counts as
// silence and is never sent to the recognizer at all: about -46 dBFS, well
// below normal speech and above digital silence/room-noise floor jitter.
const SILENCE_RMS = 0.005;

function pcm16leToFloat32(buf) {
  const sampleCount = Math.floor(buf.length / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const sample = buf.readInt16LE(i * 2);
    out[i] = sample < 0 ? sample / 32768 : sample / 32767;
  }
  return out;
}

function isNearSilent(samples) {
  if (samples.length === 0) return true;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / samples.length) < SILENCE_RMS;
}

function concatFloat32(chunks, totalLength) {
  const out = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Runs fn() after yielding the current tick, so callers never block the
// caller's own synchronous stack. Rejects if fn() throws.
function deferred(fn) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      }
    });
  });
}

export function createStt({ paths, engineId = 'moonshine-base', sherpa, log = () => {} } = {}) {
  let currentEngineId = engineId;
  let recognizer = null;
  let loadedEngineId = null;
  let loadPromise = null;
  let sherpaModule = sherpa || null;

  async function resolveSherpa() {
    if (sherpaModule) return sherpaModule;
    const mod = await import('sherpa-onnx-node');
    sherpaModule = mod.default || mod;
    return sherpaModule;
  }

  function buildConfig(id) {
    const manifest = sttManifest(paths);
    if (!manifest[id]) throw new Error(`unknown stt engine: ${id}`);
    const dir = sttModelDir(paths, id);
    const family = sttEngineFamily(paths, id);
    const modelConfig = { numThreads: 1, provider: 'cpu', debug: 0, tokens: '' };

    if (family === 'moonshine') {
      modelConfig.moonshine = {
        preprocessor: join(dir, 'preprocess.onnx'),
        encoder: join(dir, 'encode.int8.onnx'),
        uncachedDecoder: join(dir, 'uncached_decode.int8.onnx'),
        cachedDecoder: join(dir, 'cached_decode.int8.onnx'),
      };
      modelConfig.tokens = join(dir, 'tokens.txt');
    } else {
      const name = manifest[id].dir.replace(/^sherpa-onnx-whisper-/, '');
      modelConfig.whisper = {
        encoder: join(dir, `${name}-encoder.int8.onnx`),
        decoder: join(dir, `${name}-decoder.int8.onnx`),
      };
      modelConfig.tokens = join(dir, `${name}-tokens.txt`);
    }

    return { featConfig: { sampleRate: DEFAULT_SAMPLE_RATE, featureDim: 80 }, modelConfig };
  }

  async function load() {
    if (recognizer && loadedEngineId === currentEngineId) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      if (!isSttModelPresent(paths, currentEngineId)) {
        throw new Error(`stt model not present: ${currentEngineId}`);
      }
      const sherpaMod = await resolveSherpa();
      const config = buildConfig(currentEngineId);
      const start = Date.now();
      const rec = new sherpaMod.OfflineRecognizer(config);
      recognizer = rec;
      loadedEngineId = currentEngineId;
      log(`stt: loaded ${currentEngineId} in ${Date.now() - start}ms`);
    })();
    try {
      await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  function getRecognizer() {
    if (!recognizer || loadedEngineId !== currentEngineId) {
      throw new Error('stt engine not loaded');
    }
    return recognizer;
  }

  // Silence and empty buffers never reach the native addon: they resolve to
  // an empty string without a decode call at all.
  async function decodeSamples(samples, sampleRate) {
    if (isNearSilent(samples)) return '';
    return deferred(() => {
      const rec = getRecognizer();
      const stream = rec.createStream();
      stream.acceptWaveform({ sampleRate, samples });
      rec.decode(stream);
      const result = rec.getResult(stream);
      return (result && result.text) || '';
    });
  }

  // One-shot transcription of a complete PCM16LE buffer (used by tests and
  // by any caller that already has the whole utterance in hand).
  async function transcribeBuffer(pcm16le, sampleRate = DEFAULT_SAMPLE_RATE) {
    const start = Date.now();
    const samples = pcm16leToFloat32(pcm16le);
    const text = await decodeSamples(samples, sampleRate);
    return { text, ms: Date.now() - start };
  }

  // A single utterance: push() accumulates PCM16LE frames (converted to
  // float32 as they arrive), scheduling a partial decode every 1.5s of new
  // audio; final() decodes everything accumulated and returns { text, ms }.
  function createStream({ onPartial } = {}) {
    const chunks = [];
    let totalSamples = 0;
    let lastPartialSamples = 0;
    let sampleRate = DEFAULT_SAMPLE_RATE;
    let partialInFlight = false;
    let cancelled = false;
    let capped = false;
    const startedAt = Date.now();

    function capSamples() {
      return Math.floor((MAX_UTTERANCE_MS / 1000) * sampleRate);
    }

    function maybeSchedulePartial() {
      if (cancelled || partialInFlight || typeof onPartial !== 'function') return;
      const newSamples = totalSamples - lastPartialSamples;
      if ((newSamples / sampleRate) * 1000 < PARTIAL_INTERVAL_MS) return;

      partialInFlight = true;
      const snapshot = concatFloat32(chunks, totalSamples);
      const atSamples = totalSamples;
      decodeSamples(snapshot, sampleRate)
        .then((text) => {
          partialInFlight = false;
          lastPartialSamples = atSamples;
          if (!cancelled) onPartial(text);
        })
        .catch((err) => {
          partialInFlight = false;
          log(`stt: partial decode failed: ${(err && err.message) || err}`);
        });
    }

    return {
      push(pcm16le, { sampleRate: sr } = {}) {
        if (cancelled || capped) return;
        if (sr) sampleRate = sr;
        const floats = pcm16leToFloat32(pcm16le);
        const cap = capSamples();
        let toAdd = floats;
        if (totalSamples + floats.length > cap) {
          toAdd = floats.subarray(0, Math.max(0, cap - totalSamples));
          capped = true;
        }
        if (toAdd.length > 0) {
          chunks.push(toAdd);
          totalSamples += toAdd.length;
        }
        maybeSchedulePartial();
      },
      async final() {
        const samples = concatFloat32(chunks, totalSamples);
        const text = cancelled ? '' : await decodeSamples(samples, sampleRate);
        return { text, ms: Date.now() - startedAt };
      },
      cancel() {
        cancelled = true;
        chunks.length = 0;
        totalSamples = 0;
      },
      get capped() {
        return capped;
      },
      get durationMs() {
        return (totalSamples / sampleRate) * 1000;
      },
    };
  }

  // Switches the target engine id. Does not load or download anything: the
  // caller (voice-routes.js's POST /api/stt/engine) is responsible for
  // ensuring the model is present (models.js's ensureSttModel) and then
  // calling load() to actually bring the new recognizer up.
  function switchEngine(id) {
    if (id === currentEngineId) return;
    currentEngineId = id;
    recognizer = null;
    loadedEngineId = null;
  }

  function list() {
    return listSttEngines(paths);
  }

  return {
    get ready() {
      return recognizer !== null && loadedEngineId === currentEngineId;
    },
    get engineId() {
      return currentEngineId;
    },
    load,
    createStream,
    transcribeBuffer,
    switchEngine,
    list,
  };
}
