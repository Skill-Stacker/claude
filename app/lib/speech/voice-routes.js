// Wires the voice endpoints onto the app server: POST /api/tts (SSE, one
// WAV chunk per sentence), GET /api/voices, GET/POST /api/stt/engines, and
// the /ws/mic protocol (start / binary PCM16 frames / stop / cancel). See
// app/API.md for the wire shapes this file implements.
//
// Usage:
//   import { wireVoice } from './voice-routes.js';
//   wireVoice(app, { stt, tts, db });

import { isSttModelPresent, ensureSttModel } from './models.js';

const STT_NOT_DOWNLOADED_MESSAGE = "Scout's ears are still downloading.";
const STT_NOT_READY_MESSAGE = 'voice is not ready yet, you can type';

function sttNotReadyMessage(paths, engineId) {
  return isSttModelPresent(paths, engineId) ? STT_NOT_READY_MESSAGE : STT_NOT_DOWNLOADED_MESSAGE;
}

export function wireVoice(app, { stt, tts, db } = {}) {
  void db; // reserved for a later milestone (e.g. remembering a per-profile voice/engine choice)
  const paths = app.paths;

  // -- POST /api/tts: SSE, one `chunk` event per sentence, then `done` ----
  app.addRoute('POST', '/api/tts', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const { text, voice, mode } = body;

    if (typeof text !== 'string' || !text.trim()) {
      return ctx.sendJson(400, { error: 'text is required' });
    }
    if (typeof voice === 'string' && voice) {
      try {
        tts.setVoice(voice);
      } catch (err) {
        return ctx.sendJson(400, { error: String((err && err.message) || err) });
      }
    }

    const sse = ctx.sseStart();
    const controller = new AbortController();
    // Closing the request (barge-in, navigation, a fresh /api/tts call from
    // the page) stops synthesis rather than letting it run to completion
    // unheard.
    req.on('close', () => controller.abort());

    try {
      await tts.synthesizeSentences(text, {
        mode: mode === 'email' ? 'email' : 'chat',
        signal: controller.signal,
        onChunk: ({ seq, wav, text: chunkText }) => {
          sse.send('chunk', { seq, wavBase64: wav.toString('base64'), text: chunkText });
        },
      });
    } catch (err) {
      sse.send('error', { message: String((err && err.message) || err) });
    } finally {
      sse.send('done', {});
      sse.end();
    }
  });

  // -- GET /api/voices ------------------------------------------------------
  app.addRoute('GET', '/api/voices', async (req, res, ctx) => {
    const { voices, current } = tts.voices();
    ctx.sendJson(200, { voices, default: current });
  });

  // -- GET /api/stt/engines ---------------------------------------------------
  app.addRoute('GET', '/api/stt/engines', async (req, res, ctx) => {
    ctx.sendJson(200, { engines: stt.list(), current: stt.engineId });
  });

  // -- POST /api/stt/engine: switch, downloading the model if missing -------
  app.addRoute('POST', '/api/stt/engine', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const id = body.engine;
    if (typeof id !== 'string' || !id) {
      return ctx.sendJson(400, { error: 'engine is required' });
    }
    const known = stt.list().some((e) => e.id === id);
    if (!known) {
      return ctx.sendJson(400, { error: `unknown engine: ${id}` });
    }

    try {
      if (!isSttModelPresent(ctx.paths, id)) {
        ctx.bus.publish('stt', { state: 'downloading', engine: id, percent: 0 });
        await ensureSttModel(ctx.paths, id, {
          onProgress: (p) => {
            ctx.bus.publish('stt', {
              state: 'downloading',
              engine: id,
              percent: p.percent,
              received: p.received,
              total: p.total,
            });
          },
        });
        ctx.bus.publish('stt', { state: 'downloaded', engine: id });
      }

      stt.switchEngine(id);
      ctx.bus.publish('stt', { state: 'loading', engine: id });
      await stt.load();
      ctx.bus.publish('stt', { state: 'ready', engine: id });
      ctx.sendJson(200, { ok: true, engine: stt.engineId });
    } catch (err) {
      const message = String((err && err.message) || err);
      ctx.bus.publish('stt', { state: 'failed', engine: id, message });
      ctx.sendJson(500, { ok: false, error: message });
    }
  });

  // -- status ----------------------------------------------------------------
  app.setStatus('voice', () => {
    const ttsVoices = tts.voices();
    return {
      stt: { engineId: stt.engineId, ready: stt.ready },
      tts: { ready: tts.ready, voice: ttsVoices.current, loadMs: tts.loadMs },
    };
  });

  // -- WS /ws/mic: start / binary PCM16 frames / stop / cancel ---------------
  app.onMicConnection((conn) => {
    let stream = null;
    let sampleRate = 16000;

    function sendJson(obj) {
      try {
        conn.send(JSON.stringify(obj));
      } catch {
        // socket already gone; nothing to do
      }
    }

    function beginUtterance() {
      stream = stt.createStream({
        onPartial: (text) => sendJson({ type: 'partial', text }),
      });
    }

    async function endUtterance() {
      const active = stream;
      stream = null;
      if (!active) return;
      try {
        const { text, ms } = await active.final();
        sendJson({ type: 'final', text, ms });
      } catch (err) {
        sendJson({ type: 'error', message: String((err && err.message) || err) });
      }
    }

    conn.on('message', (data, isBinary) => {
      if (!isBinary) {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'start') {
          if (stream) stream.cancel();
          if (!stt.ready) {
            sendJson({ type: 'error', message: sttNotReadyMessage(paths, stt.engineId) });
            stream = null;
            return;
          }
          sampleRate = Number(msg.sampleRate) > 0 ? Number(msg.sampleRate) : 16000;
          beginUtterance();
          return;
        }

        if (msg.type === 'stop') {
          endUtterance();
          return;
        }

        if (msg.type === 'cancel') {
          if (stream) stream.cancel();
          stream = null;
          return;
        }

        return;
      }

      // Binary frame: raw PCM16 little-endian audio for the current utterance.
      if (stream) stream.push(data, { sampleRate });
    });

    conn.on('close', () => {
      if (stream) stream.cancel();
      stream = null;
    });
  });
}
