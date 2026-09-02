// Downmixes the mic input to mono, resamples it from the AudioContext's
// sample rate down to 16000 Hz (linear interpolation), converts to PCM16
// little-endian, and posts 20 ms chunks (320 samples) to the main thread
// along with an RMS level for the lamp.
//
// This file plays two roles from one module, on purpose: the browser loads
// it as an AudioWorklet module (`audioContext.audioWorklet.addModule(...)`,
// which runs it in AudioWorkletGlobalScope), and tests/voice-client.test.js
// imports it as a plain ES module under Node to exercise the pure math. The
// pure helpers below never touch a worklet-only global, so both work; only
// the AudioWorkletProcessor subclass at the bottom needs the guard.

const TARGET_RATE = 16000;
export const CHUNK_SAMPLES = 320; // 20 ms at 16 kHz

// Averages same-index samples across channels. A single channel is handed
// back unchanged (no copy needed).
export function downmixToMono(channelData) {
  if (!channelData || channelData.length === 0) return new Float32Array(0);
  if (channelData.length === 1) return channelData[0];
  const length = channelData[0].length;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < channelData.length; c++) sum += channelData[c][i];
    out[i] = sum / channelData.length;
  }
  return out;
}

// Linear-interpolation resample of a full buffer from one rate to another.
// Used directly by tests against a whole clip; the worklet below wraps it
// in a small streaming state machine so interpolation stays continuous
// across the 128-sample render quanta the browser hands it.
export function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = fromRate / toRate;
  const outLength = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const frac = srcPos - i0;
    const s0 = input[i0] ?? 0;
    const s1 = i0 + 1 < input.length ? input[i0 + 1] : s0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

// Converts -1..1 float samples to PCM16 little-endian, clipping instead of
// wrapping on out-of-range input.
export function floatTo16BitPCM(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(i * 2, Math.round(value), true);
  }
  return buffer;
}

export function computeRMS(float32) {
  if (!float32 || float32.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

// The processor itself only exists in AudioWorkletGlobalScope. Guarding on
// registerProcessor (as asked) rather than AudioWorkletProcessor directly:
// the two are only ever defined together, so this reads as "are we inside
// a worklet" either way, and it matches what actually gets called below.
if (typeof registerProcessor !== 'undefined') {
  class PcmDownsampleProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._fromRate = sampleRate; // AudioWorkletGlobalScope global: the context's real rate
      // Raw mono samples not yet consumed by the resampler, plus a
      // fractional read position into it, so interpolation is continuous
      // from one 128-sample render quantum to the next instead of
      // restarting (and losing a fraction of a sample) at every call.
      this._buffer = new Float32Array(0);
      this._pos = 0;
      this._pending = []; // resampled 16 kHz samples waiting to fill a 20 ms chunk
    }

    process(inputs) {
      const input = inputs[0];
      if (input && input.length > 0 && input[0] && input[0].length > 0) {
        const mono = downmixToMono(input);
        const merged = new Float32Array(this._buffer.length + mono.length);
        merged.set(this._buffer, 0);
        merged.set(mono, this._buffer.length);
        this._buffer = merged;

        const ratio = this._fromRate / TARGET_RATE;
        while (this._pos + 1 < this._buffer.length) {
          const i0 = Math.floor(this._pos);
          const frac = this._pos - i0;
          const s0 = this._buffer[i0];
          const s1 = this._buffer[i0 + 1];
          this._pending.push(s0 + (s1 - s0) * frac);
          this._pos += ratio;
        }
        const dropCount = Math.floor(this._pos);
        if (dropCount > 0) {
          this._buffer = this._buffer.subarray(dropCount);
          this._pos -= dropCount;
        }

        while (this._pending.length >= CHUNK_SAMPLES) {
          const chunk = Float32Array.from(this._pending.splice(0, CHUNK_SAMPLES));
          const level = computeRMS(chunk);
          const pcm = floatTo16BitPCM(chunk);
          this.port.postMessage({ type: 'chunk', buffer: pcm, level }, [pcm]);
        }
      }
      return true; // keep the node alive even through a silent or dropped quantum
    }
  }

  registerProcessor('pcm-downsampler', PcmDownsampleProcessor);
}
