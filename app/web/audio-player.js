// The gap-free WAV chunk scheduler voice.js uses to play Kokoro's TTS
// output as it streams in, plus the pure WAV parsing it is built on. The
// parser is exported on its own (parseWavHeader, wavToFloat32) so
// tests/voice-client.test.js can run it under plain Node, no AudioContext
// needed; createPlayer is the browser half and needs a real one.

// ---------------------------------------------------------------------------
// WAV parsing (pure, no Web Audio)
// ---------------------------------------------------------------------------

const RIFF_TAG = 'RIFF';
const WAVE_TAG = 'WAVE';
const FMT_TAG = 'fmt ';
const DATA_TAG = 'data';

// WAVE_FORMAT_PCM and WAVE_FORMAT_IEEE_FLOAT: the only two tags kokoro-js
// and the browser's own encoders ever write. WAVE_FORMAT_EXTENSIBLE
// (0xfffe) is not handled here; callers fall back to decodeAudioData for
// anything this parser does not recognize.
const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;

function readTag(view, offset) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

// Walks RIFF chunks looking for 'fmt ' and 'data', skipping anything else
// (a 'fact' chunk shows up on float WAV files, for example) without
// copying the possibly-large sample data. Returns null for anything that
// is not a well-formed RIFF/WAVE buffer.
export function parseWavHeader(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) return null;
  const view = new DataView(buffer);
  if (readTag(view, 0) !== RIFF_TAG) return null;
  if (readTag(view, 8) !== WAVE_TAG) return null;

  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= view.byteLength) {
    const id = readTag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (bodyOffset + size > view.byteLength) break; // truncated chunk, stop reading

    if (id === FMT_TAG) {
      fmt = {
        audioFormat: view.getUint16(bodyOffset, true),
        numChannels: view.getUint16(bodyOffset + 2, true),
        sampleRate: view.getUint32(bodyOffset + 4, true),
        byteRate: view.getUint32(bodyOffset + 8, true),
        blockAlign: view.getUint16(bodyOffset + 12, true),
        bitsPerSample: view.getUint16(bodyOffset + 14, true),
      };
    } else if (id === DATA_TAG) {
      dataOffset = bodyOffset;
      dataLength = size;
    }

    offset = bodyOffset + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt || dataOffset < 0) return null;
  return { ...fmt, dataOffset, dataLength };
}

// Converts the sample data a parseWavHeader() result points at into
// per-channel Float32Arrays in the -1..1 range decodeAudioData would give.
// Returns null for a format/bit-depth combination it does not handle, so
// the caller can fall back to decodeAudioData.
export function wavToFloat32(buffer) {
  const header = parseWavHeader(buffer);
  if (!header) return null;
  const { audioFormat, numChannels, sampleRate, bitsPerSample, dataOffset, dataLength } = header;
  if (numChannels < 1) return null;

  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample < 1) return null;
  const frameCount = Math.floor(dataLength / (bytesPerSample * numChannels));
  const view = new DataView(buffer, dataOffset, dataLength);

  const channelData = [];
  for (let c = 0; c < numChannels; c++) channelData.push(new Float32Array(frameCount));

  if (audioFormat === FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
    for (let i = 0; i < frameCount; i++) {
      for (let c = 0; c < numChannels; c++) {
        channelData[c][i] = view.getFloat32((i * numChannels + c) * 4, true);
      }
    }
  } else if (audioFormat === FORMAT_PCM && bitsPerSample === 16) {
    for (let i = 0; i < frameCount; i++) {
      for (let c = 0; c < numChannels; c++) {
        channelData[c][i] = view.getInt16((i * numChannels + c) * 2, true) / 32768;
      }
    }
  } else if (audioFormat === FORMAT_PCM && bitsPerSample === 8) {
    // 8-bit WAV is stored unsigned, centered on 128.
    for (let i = 0; i < frameCount; i++) {
      for (let c = 0; c < numChannels; c++) {
        channelData[c][i] = (view.getUint8(i * numChannels + c) - 128) / 128;
      }
    }
  } else {
    return null;
  }

  return { sampleRate, numberOfChannels: numChannels, length: frameCount, channelData };
}

// ---------------------------------------------------------------------------
// Gap-free scheduler (needs a real AudioContext; browser only)
// ---------------------------------------------------------------------------

// createPlayer(audioContext) returns { enqueue, stop, reset, onEnded,
// isActive, analyser }. `analyser` is a real AnalyserNode wired into the
// playback graph (source -> analyser -> destination) so the lamp's
// `speaking` mood can read it directly; attach it once, it survives reset().
export function createPlayer(audioContext) {
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.6;
  analyser.connect(audioContext.destination);

  let nextStartTime = 0;
  const activeSources = new Set();
  const endedCallbacks = [];
  let stopped = false;
  let pending = 0; // chunks currently being decoded, not yet scheduled

  function onEnded(fn) {
    endedCallbacks.push(fn);
  }

  function isActive() {
    return pending > 0 || activeSources.size > 0;
  }

  function maybeFireEnded() {
    if (stopped || isActive()) return;
    for (const fn of endedCallbacks) {
      try {
        fn();
      } catch {
        // a listener's problem, not the player's
      }
    }
  }

  function buildBuffer(decoded) {
    const buf = audioContext.createBuffer(decoded.numberOfChannels, decoded.length, decoded.sampleRate);
    for (let c = 0; c < decoded.numberOfChannels; c++) buf.copyToChannel(decoded.channelData[c], c);
    return buf;
  }

  async function enqueue(arrayBuffer) {
    if (stopped) return;
    pending += 1;
    let audioBuffer;
    try {
      const decoded = wavToFloat32(arrayBuffer);
      audioBuffer = decoded ? buildBuffer(decoded) : await audioContext.decodeAudioData(arrayBuffer.slice(0));
    } catch (err) {
      pending -= 1;
      maybeFireEnded();
      throw err;
    }
    pending -= 1;
    if (stopped) {
      maybeFireEnded();
      return;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(analyser);

    const startAt = Math.max(audioContext.currentTime, nextStartTime);
    source.start(startAt);
    nextStartTime = startAt + audioBuffer.duration;

    activeSources.add(source);
    source.onended = () => {
      activeSources.delete(source);
      maybeFireEnded();
    };
  }

  function stop() {
    stopped = true;
    for (const source of activeSources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // already stopped
      }
    }
    activeSources.clear();
    nextStartTime = 0;
  }

  // Call before reusing the player for a new utterance (a fresh speak()
  // call). Keeps the same AnalyserNode so the lamp does not need to
  // re-attach.
  function reset() {
    stopped = false;
    nextStartTime = 0;
  }

  return { enqueue, stop, reset, onEnded, isActive, analyser };
}
