// "Make a Picture": the Studio image-generation module. Owns the on-disk
// gallery, the one sd-server process this app ever runs at a time, and the
// HTTP routes the images.js window talks to. All the actual downloading,
// extracting and process supervision lives in sdcpp.js; this file is the
// product shape around it, the same split engine.js/chat-routes.js use for
// the chat engine.
//
// Usage:
//   import { createImages, wireImages } from './images.js';
//   const images = createImages({ paths, manifest, downloads, bus, netlog });
//   wireImages(app, { images });
//
// Honesty rules this file exists to keep (see CLAUDE.md): manifest.json's
// studio.sdcpp.model.sd15.url is null on purpose (huggingface.co is not
// reachable while pinning this build, so no URL here has been checked
// against a real download). GET /api/images/status must say plainly that
// no model is pinned rather than ever guessing one, and every gallery entry
// records the real wall-clock seconds a generation took so the UI can say
// "your last one took N seconds" instead of promising a speed nobody
// measured on this machine.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep, basename, extname } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { safeJoin } from '../security.js';
import { ensureSdcpp, createSdServer, sdAsset, sdcppBinaryPaths } from './sdcpp.js';

const DEFAULT_SIZE = '512x512';
const ALLOWED_SIZES = new Set(['512x512', '768x768']);
const MAX_STEPS = 50;
const DEFAULT_STEPS = 20;
const DEFAULT_CFG = 7;

// ---------------------------------------------------------------------------
// small file helpers (gallery.json and the pasted-model-path setting live
// as plain JSON files, same pattern as everywhere else on the stick)
// ---------------------------------------------------------------------------

function readJsonSafe(path, fallback) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data;
  } catch {
    return fallback;
  }
}

function writeJsonSafe(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function imagesDir(paths) {
  return join(paths.base, 'studio', 'images');
}

function galleryPath(paths) {
  return join(imagesDir(paths), 'gallery.json');
}

function settingsPath(paths) {
  return join(paths.state, 'images.json');
}

function loadGallery(paths) {
  const data = readJsonSafe(galleryPath(paths), []);
  return Array.isArray(data) ? data : [];
}

function saveGallery(paths, list) {
  writeJsonSafe(galleryPath(paths), list);
}

function loadSettings(paths) {
  const data = readJsonSafe(settingsPath(paths), {});
  return data && typeof data === 'object' ? data : {};
}

function saveSettings(paths, data) {
  writeJsonSafe(settingsPath(paths), data);
}

// A pasted model path must resolve inside this stick's models/ folder; this
// is the filesystem-path equivalent of security.js's safeJoin, which is
// built for URL request paths instead.
function resolveModelPath(paths, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const root = resolve(paths.models);
  const candidate = resolve(root, raw.trim());
  const withSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(withSep)) return null;
  return candidate;
}

function apiError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// createImages
// ---------------------------------------------------------------------------

export function createImages({ paths, manifest, downloads, bus, netlog, spawn = nodeSpawn, fetch = globalThis.fetch, log } = {}) {
  if (!paths) throw new Error('createImages needs paths');
  if (!manifest) throw new Error('createImages needs manifest');

  let server = null; // the createSdServer() instance, made lazily once a model is picked
  let serverModelPath = null; // which model `server` was built against
  let generating = false;
  let currentAbort = null;

  function publish(event) {
    if (!bus) return;
    try {
      bus.publish('images', event);
    } catch {
      // a bad subscriber must never break generation
    }
  }

  function binaryPaths() {
    return sdcppBinaryPaths(paths, manifest);
  }

  function binaryStatus() {
    const bp = binaryPaths();
    return { present: existsSync(bp.sdServer) && existsSync(bp.sdCli), sdServer: bp.sdServer, sdCli: bp.sdCli };
  }

  function modelStatus() {
    const settings = loadSettings(paths);
    const path = settings.modelPath || null;
    if (!path) {
      return {
        present: false,
        path: null,
        note: 'No picture model is pinned yet. Paste the path to a model file from this stick’s models folder.',
      };
    }
    let present = false;
    try {
      present = existsSync(path) && statSync(path).isFile();
    } catch {
      present = false;
    }
    return { present, path, note: present ? null : 'That model file could not be found any more.' };
  }

  function lastGenerationSeconds() {
    const gallery = loadGallery(paths);
    if (!gallery.length) return null;
    const last = gallery[gallery.length - 1];
    return typeof last.seconds === 'number' ? last.seconds : null;
  }

  function status() {
    const bin = binaryStatus();
    const model = modelStatus();
    return {
      pinned: !!manifest?.studio?.sdcpp?.tag,
      binary: bin,
      model,
      server: { running: !!(server && server.isRunning()), busy: generating },
      lastGenerationSeconds: lastGenerationSeconds(),
      ready: bin.present && model.present,
    };
  }

  async function setup() {
    const result = await ensureSdcpp({
      paths,
      manifest,
      downloads,
      onProgress: (p) => publish({ phase: 'downloading', ...p }),
    });
    if (result.downloaded && netlog) {
      let host = 'github.com';
      try {
        host = new URL(result.url).host;
      } catch {
        // keep the fallback host
      }
      netlog.record({
        kind: 'https',
        host,
        purpose: 'download the picture-making engine',
        bytes: result.size || null,
        ok: true,
      });
    }
    publish({ phase: result.downloaded ? 'ready' : 'already_present' });
    return status();
  }

  function setModelPath(raw) {
    const resolved = resolveModelPath(paths, raw);
    if (!resolved) {
      throw apiError(400, 'bad_model_path', 'That has to be a file inside this stick’s models folder.');
    }
    let ok = false;
    try {
      ok = existsSync(resolved) && statSync(resolved).isFile();
    } catch {
      ok = false;
    }
    if (!ok) {
      throw apiError(400, 'model_not_found', 'That file could not be found.');
    }
    const settings = loadSettings(paths);
    settings.modelPath = resolved;
    saveSettings(paths, settings);
    return status();
  }

  function ensureServer(modelPath) {
    if (server && serverModelPath === modelPath) return server;
    // The model changed since the last generation (or there was none yet):
    // any previous instance is left to its own idle timeout, and a fresh
    // one is built pointed at the current model.
    const bp = binaryPaths();
    server = createSdServer({ exe: bp.sdServer, modelPath, spawn, fetch, log });
    serverModelPath = modelPath;
    return server;
  }

  function clampSteps(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_STEPS;
    return Math.min(MAX_STEPS, Math.round(n));
  }

  function clampSeed(raw) {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : -1;
  }

  async function generate({ prompt, negative, size, steps, seed } = {}, onProgress) {
    if (generating) {
      throw apiError(409, 'busy', 'Scout is already making a picture. Wait for it to finish, or cancel it.');
    }
    const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!cleanPrompt) {
      throw apiError(400, 'no_prompt', 'Tell Scout what picture to make.');
    }
    const bin = binaryStatus();
    if (!bin.present) {
      throw apiError(409, 'binary_missing', 'The picture maker is not set up yet. Set it up first.');
    }
    const model = modelStatus();
    if (!model.present) {
      throw apiError(409, 'no_model', model.note || 'No picture model is pinned yet.');
    }

    const dims = ALLOWED_SIZES.has(size) ? size : DEFAULT_SIZE;
    const [width, height] = dims.split('x').map(Number);
    const finalSteps = clampSteps(steps);
    const finalSeed = clampSeed(seed);

    const instance = ensureServer(model.path);
    const controller = new AbortController();
    currentAbort = controller;
    generating = true;
    const startedAt = Date.now();
    try {
      const png = await instance.txt2img({
        prompt: cleanPrompt,
        negative: typeof negative === 'string' ? negative : '',
        width,
        height,
        steps: finalSteps,
        cfg: DEFAULT_CFG,
        seed: finalSeed,
        signal: controller.signal,
        onStatus: (jobStatus) => onProgress?.({ phase: jobStatus }),
      });

      const seconds = round1((Date.now() - startedAt) / 1000);
      const dateStamp = new Date().toISOString().slice(0, 10);
      const seedForName = finalSeed >= 0 ? finalSeed : Math.floor(Math.random() * 1e9);
      const fileName = `${dateStamp}-${seedForName}.png`;
      const dir = imagesDir(paths);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, fileName), png);

      const entry = {
        file: fileName,
        url: `/studio/images/${fileName}`,
        prompt: cleanPrompt,
        negative: typeof negative === 'string' ? negative : '',
        size: dims,
        steps: finalSteps,
        seed: finalSeed,
        seconds,
        createdAt: new Date().toISOString(),
      };
      const gallery = loadGallery(paths);
      gallery.push(entry);
      saveGallery(paths, gallery);

      return entry;
    } finally {
      generating = false;
      currentAbort = null;
    }
  }

  function cancel() {
    if (currentAbort) {
      currentAbort.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  function gallery() {
    return loadGallery(paths).slice().reverse();
  }

  async function stopServer() {
    if (server) await server.stop();
  }

  return {
    status,
    setup,
    setModelPath,
    generate,
    cancel,
    gallery,
    stopServer,
    imagesDir: () => imagesDir(paths),
  };
}

// ---------------------------------------------------------------------------
// wireImages
// ---------------------------------------------------------------------------

export function wireImages(app, { images }) {
  app.setStatus('images', () => images.status());

  app.addRoute('GET', '/api/images/status', (req, res, ctx) => {
    ctx.sendJson(200, images.status());
  });

  app.addRoute('POST', '/api/images/setup', async (req, res, ctx) => {
    try {
      const result = await images.setup();
      ctx.sendJson(200, result);
    } catch (err) {
      ctx.sendJson(err.status || 500, { error: err.code || 'setup_failed', message: err.message });
    }
  });

  app.addRoute('POST', '/api/images/model', async (req, res, ctx) => {
    let body;
    try {
      body = await ctx.readJson();
    } catch {
      return ctx.sendJson(400, { error: 'invalid_json', message: 'That was not valid JSON.' });
    }
    try {
      const result = images.setModelPath(body && body.path);
      ctx.sendJson(200, result);
    } catch (err) {
      ctx.sendJson(err.status || 400, { error: err.code || 'bad_model_path', message: err.message });
    }
  });

  app.addRoute('POST', '/api/images/generate', async (req, res, ctx) => {
    let body;
    try {
      body = await ctx.readJson();
    } catch {
      return ctx.sendJson(400, { error: 'invalid_json', message: 'That was not valid JSON.' });
    }
    const stream = ctx.sseStart();
    try {
      const entry = await images.generate(body || {}, (p) => {
        if (!stream.closed) stream.send('progress', p);
      });
      if (!stream.closed) stream.send('done', { file: entry.file, url: entry.url, seconds: entry.seconds });
    } catch (err) {
      const isAbort = err && err.name === 'AbortError';
      if (!stream.closed) {
        stream.send('error', {
          message: isAbort ? 'Cancelled.' : err.message,
          code: isAbort ? 'cancelled' : err.code || null,
        });
      }
    } finally {
      stream.end();
    }
  });

  app.addRoute('POST', '/api/images/cancel', (req, res, ctx) => {
    ctx.sendJson(200, images.cancel());
  });

  app.addRoute('GET', '/api/images/gallery', (req, res, ctx) => {
    ctx.sendJson(200, { images: images.gallery() });
  });

  // Path containment as everywhere else static files are served (see
  // server.js's own serveStatic): decode, reject '..', resolve inside the
  // images directory before ever touching the filesystem. Only .png files
  // that made it into gallery.json live here, so anything else (including
  // gallery.json itself) 404s rather than being served as an image.
  app.addRoute(
    'GET',
    '/studio/images/',
    (req, res, ctx) => {
      const rel = ctx.pathname.slice('/studio/images/'.length);
      const filePath = safeJoin(images.imagesDir(), rel);
      if (!filePath || extname(filePath).toLowerCase() !== '.png' || basename(filePath) === 'gallery.json') {
        return ctx.sendJson(404, { error: 'not_found' });
      }
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        return ctx.sendJson(404, { error: 'not_found' });
      }
      if (!stat.isFile()) return ctx.sendJson(404, { error: 'not_found' });
      const data = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') return res.end();
      res.end(data);
    },
    { prefix: true },
  );
}

// re-exported for anyone (tests included) that wants the raw asset picker
// without going through status()
export { sdAsset };
