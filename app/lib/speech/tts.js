// Text-to-speech: wraps kokoro-js (the onnx-community/Kokoro-82M-v1.0-ONNX
// model, run through @huggingface/transformers on the CPU) and turns model
// output into WAV chunks the browser can start playing before the whole
// reply has been synthesized.
//
// The model is loaded once and kept warm for the process lifetime (a cold
// start takes several seconds on real hardware); synthesizeSentences() runs
// scrub.js's forSpeech() over the input, then speaks the first clause alone
// first (a short chunk that starts playback sooner) before the rest of the
// text, chunked at sentence boundaries under 85 words (kokoro-js silently
// truncates around 510 phonemes, so chunks must stay well under that).
// Only one synthesis runs at a time: starting a new one aborts whatever was
// still in flight, matching "the assistant has one voice".
//
// Usage:
//   import { createTts } from './tts.js';
//   const tts = createTts({ paths, log: console.log });
//   await tts.load();
//   await tts.synthesizeSentences(text, { onChunk: ({ seq, wav, text }) => ... } );

import { prepareTtsCacheEnv } from './models.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_SAMPLE_RATE = 24000; // kokoro-js always generates at 24 kHz

// Simplified grading for the UI, distinct from kokoro-js's own
// overallGrade (which spans A down to F+ across many training-duration
// tiers): only af_heart is called out as the best choice, af_bella and
// af_nicole as a solid second tier, and everything else as a plain C so
// beginners aren't shown a wall of near-meaningless letter grades.
const SIMPLE_GRADE = { af_heart: 'A', af_bella: 'B', af_nicole: 'B' };
function simpleGrade(id) {
  return SIMPLE_GRADE[id] || 'C';
}

// --- WAV encoding (float32 PCM, mono) ---------------------------------

// Builds a RIFF/WAVE buffer by hand: format tag 3 (IEEE float), 32-bit
// samples, one channel. kokoro-js's own RawAudio.toWav() could do this, but
// writing the header directly keeps this module independent of that
// implementation detail and easy to test against a fake kokoro.
export function floatWavBuffer(samples, sampleRate) {
  const bytesPerSample = 4;
  const blockAlign = bytesPerSample; // mono: blockAlign == bytesPerSample
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(3, 20); // format tag: 3 = IEEE float
  buf.writeUInt16LE(1, 22); // channels: mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(32, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeFloatLE(samples[i], 44 + i * 4);
  }
  return buf;
}

// --- trivial fallback if scrub.js is unavailable at run time -------------

function trivialForSpeech(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function trivialChunkForKokoro(text, { maxWords = 85 } = {}) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
  }
  return chunks;
}

// No fast-start attempt in the fallback: correctness over speed when
// scrub.js itself is unavailable.
function trivialFirstClause() {
  return null;
}

async function loadScrub(injected, log) {
  if (injected) return injected;
  try {
    const mod = await import('./scrub.js');
    const missing = ['forSpeech', 'chunkForKokoro', 'firstClause'].filter((name) => typeof mod[name] !== 'function');
    if (missing.length > 0) {
      log(`tts: scrub.js is missing export(s) [${missing.join(', ')}]; using a trivial fallback for those`);
    }
    return {
      forSpeech: typeof mod.forSpeech === 'function' ? mod.forSpeech : trivialForSpeech,
      chunkForKokoro: typeof mod.chunkForKokoro === 'function' ? mod.chunkForKokoro : trivialChunkForKokoro,
      firstClause: typeof mod.firstClause === 'function' ? mod.firstClause : trivialFirstClause,
    };
  } catch (err) {
    log(`tts: scrub.js unavailable (${(err && err.message) || err}); using a trivial fallback`);
    return { forSpeech: trivialForSpeech, chunkForKokoro: trivialChunkForKokoro, firstClause: trivialFirstClause };
  }
}

export function createTts({ paths, voice = 'af_heart', kokoro, scrub, log = () => {} } = {}) {
  let currentVoice = voice;
  let ttsInstance = null;
  let loadPromise = null;
  let loadMs = null;
  let scrubFns = null;
  let scrubPromise = null;
  let currentRun = null; // { controller: AbortController } for the in-flight synthesis, if any

  async function resolveScrub() {
    if (scrubFns) return scrubFns;
    if (!scrubPromise) scrubPromise = loadScrub(scrub, log);
    scrubFns = await scrubPromise;
    return scrubFns;
  }

  async function load() {
    if (ttsInstance) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      prepareTtsCacheEnv(paths);
      const kokoroMod = kokoro || (await import('kokoro-js'));
      const { KokoroTTS } = kokoroMod;
      const start = Date.now();
      ttsInstance = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'fp32', device: 'cpu' });
      loadMs = Date.now() - start;
      log(`tts: loaded in ${loadMs}ms`);
    })();
    try {
      await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  function voices() {
    const raw = ttsInstance ? ttsInstance.voices : {};
    const list = Object.keys(raw).map((id) => ({
      id,
      label: (raw[id] && raw[id].name) || id,
      grade: simpleGrade(id),
    }));
    return { voices: list, current: currentVoice };
  }

  function setVoice(id) {
    if (ttsInstance && !ttsInstance.voices[id]) {
      throw new Error(`unknown voice: ${id}`);
    }
    currentVoice = id;
  }

  // Splits scrubbed text into { clause, remainder }: `clause` is
  // firstClause()'s fast-start chunk when it is genuinely a prefix of the
  // scrubbed text, otherwise null (falling back to plain chunking) so a
  // surprising firstClause() result can never desync from the real text.
  function splitFirstClause(scrubbed, firstClauseFn) {
    const clause = firstClauseFn(scrubbed);
    if (clause && scrubbed.startsWith(clause)) {
      return { clause, remainder: scrubbed.slice(clause.length).trim() };
    }
    return { clause: null, remainder: scrubbed };
  }

  async function synthesizeSentences(text, { mode = 'chat', onChunk, signal } = {}) {
    // One voice at a time: starting a new synthesis aborts whatever was
    // still running.
    if (currentRun) currentRun.controller.abort();
    const controller = new AbortController();
    const run = { controller };
    currentRun = run;

    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const { forSpeech, chunkForKokoro, firstClause } = await resolveScrub();
      await load();
      if (controller.signal.aborted) return;

      const scrubbed = forSpeech(text, { mode });
      const { clause, remainder } = splitFirstClause(scrubbed, firstClause);

      const textChunks = [];
      if (clause) textChunks.push(clause);
      if (remainder) textChunks.push(...chunkForKokoro(remainder, { maxWords: 85 }));

      let seq = 0;
      for (const chunkText of textChunks) {
        if (controller.signal.aborted) break;
        if (!chunkText) continue;
        // eslint-disable-next-line no-await-in-loop
        const audio = await ttsInstance.generate(chunkText, { voice: currentVoice });
        if (controller.signal.aborted) break;
        const sampleRate = audio.sampling_rate || KOKORO_SAMPLE_RATE;
        const wav = floatWavBuffer(audio.audio, sampleRate);
        seq += 1;
        if (typeof onChunk === 'function') onChunk({ seq, wav, text: chunkText });
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      if (currentRun === run) currentRun = null;
    }
  }

  return {
    get ready() {
      return ttsInstance !== null;
    },
    get loadMs() {
      return loadMs;
    },
    load,
    voices,
    setVoice,
    synthesizeSentences,
  };
}
