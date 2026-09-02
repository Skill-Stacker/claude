// Studio's model manager: the curated list of language models Scout can
// run (the pinned primary and its lighter fallback, plus anything the
// person dropped into models/ by hand), downloading one on request, and
// switching which one the engine loads.
//
// Like app/lib/firstrun.js, this file never touches the network directly:
// every byte moves through the injected `downloads` object (real
// app/lib/downloads.js in production, a fake in tests) and every engine
// action through the injected `engine` object (app/lib/engine.js).
//
// Usage:
//   import { createModelManager, wireModels } from './models.js';
//   const models = createModelManager({ paths, manifest, downloads, engine, bus, db });
//   wireModels(app, { models });
//   const { models: list, current } = await models.list();
//   await models.download('qwen3.5-4b-q4_k_m');
//   await models.select('qwen3.5-4b-q4_k_m');

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNNING_ENGINE_STATES = new Set(['starting', 'loading', 'ready']);

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

function idFromFile(file) {
  return String(file).replace(/\.gguf$/i, '');
}

// Turns an id like "qwen3.5-4b-q6_k_l" into "Qwen3.5 4B (Q6_K_L)". Anything
// that does not fit the "<name>-<size>b-<quant>" shape is shown as is,
// which is exactly right for a stray file whose name Scout did not choose.
function friendlyLabel(id) {
  const m = /^([a-z0-9.]+)-(\d+b)-(q[\w]+)$/i.exec(id);
  if (!m) return id;
  const [, name, size, quant] = m;
  const prettyName = name.charAt(0).toUpperCase() + name.slice(1);
  return `${prettyName} ${size.toUpperCase()} (${quant.toUpperCase()})`;
}

function statSizeSafe(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// createModelManager
// ---------------------------------------------------------------------------

export function createModelManager({ paths, manifest, downloads, engine, bus, db } = {}) {
  if (!paths) throw new Error('createModelManager needs paths');
  if (!manifest) throw new Error('createModelManager needs manifest');
  if (!downloads) throw new Error('createModelManager needs downloads');
  if (!engine) throw new Error('createModelManager needs engine');
  void db; // reserved: nothing here reads or writes the database yet

  function stateFilePath() {
    return join(paths.state, 'model.json');
  }

  function destPathFor(file) {
    return join(paths.models, file);
  }

  // The two manifest-pinned choices, by id.
  function knownSpecs() {
    const out = [];
    if (manifest.model?.primary) out.push({ variant: 'primary', spec: manifest.model.primary });
    if (manifest.model?.fallback) out.push({ variant: 'fallback', spec: manifest.model.fallback });
    return out;
  }

  function specFor(id) {
    for (const { spec } of knownSpecs()) {
      if (idFromFile(spec.file) === id) return spec;
    }
    return null;
  }

  function publish(id, patch) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish('models', { id, ...patch });
    } catch {
      // a bad subscriber must not break the download
    }
  }

  function current() {
    try {
      const raw = readFileSync(stateFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.id === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  function engineIsRunning() {
    try {
      const st = engine.status();
      return !!st && RUNNING_ENGINE_STATES.has(st.state);
    } catch {
      return false;
    }
  }

  // ---- list -------------------------------------------------------------

  async function list() {
    const cur = current();
    const out = [];

    for (const { variant, spec } of knownSpecs()) {
      const id = idFromFile(spec.file);
      const destPath = destPathFor(spec.file);
      let present = false;
      if (existsSync(destPath)) {
        const check = await downloads.verifyAsset(destPath, spec);
        present = check.ok;
      }
      out.push({
        id,
        label: friendlyLabel(id),
        sizeBytes: spec.size ?? (present ? statSizeSafe(destPath) : null),
        present,
        selected: !!cur && cur.id === id,
        notes: variant === 'primary' ? 'the default, tested with Scout' : null,
      });
    }

    const known = new Set(out.map((m) => m.id));
    let files = [];
    try {
      files = readdirSync(paths.models);
    } catch {
      // models/ may not exist yet on a stick that has never downloaded one
    }
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.gguf')) continue;
      const id = idFromFile(file);
      if (known.has(id)) continue;
      const full = destPathFor(file);
      out.push({
        id,
        label: `Your own: ${file}`,
        sizeBytes: statSizeSafe(full),
        present: true,
        selected: !!cur && cur.id === id,
        notes: null,
      });
      known.add(id);
    }

    return { models: out, current: cur };
  }

  // ---- download -----------------------------------------------------

  async function download(id) {
    const spec = specFor(id);
    if (!spec) {
      return { ok: false, id, kind: 'unknown_model', message: `Scout does not know a model called "${id}".` };
    }

    const destPath = destPathFor(spec.file);
    const assets = [{ path: destPath, size: spec.size || 0 }];
    const present = existsSync(destPath) ? [destPath] : [];
    const needed = downloads.bytesNeeded(assets, present);
    const pf = await downloads.diskFreePreflight(paths.base, needed);
    if (!pf.ok) {
      const message = 'There is not enough free space left on the stick for this file.';
      publish(id, { state: 'failed', message });
      return { ok: false, id, kind: 'disk_full', message };
    }

    publish(id, { state: 'active', received: 0, total: spec.size ?? null, percent: null });
    try {
      const result = await downloads.downloadAsset(spec, destPath, {
        onProgress: (p) => {
          const total = typeof p.total === 'number' ? p.total : null;
          const received = typeof p.received === 'number' ? p.received : null;
          const percent = total && received != null ? Math.round((received / total) * 1000) / 10 : null;
          publish(id, { state: 'active', received, total, percent });
        },
        statePath: join(paths.state, 'download-manifest.json'),
      });

      // downloadAsset already checks the GGUF magic bytes for any asset
      // whose manifest entry carries magic: 'GGUF' (every entry here
      // does); this second, explicit check is belt and braces so a bad
      // file can never end up marked present.
      const check = await downloads.verifyAsset(destPath, spec);
      if (!check.ok) {
        const message = 'The downloaded file did not check out. Scout removed it so it can start fresh.';
        publish(id, { state: 'failed', message });
        return { ok: false, id, kind: check.reason || 'verify_failed', message };
      }

      publish(id, { state: 'done', received: spec.size ?? null, total: spec.size ?? null, percent: 100 });
      return {
        ok: true,
        id,
        present: true,
        skipped: !!result.skipped,
        sizeBytes: spec.size ?? statSizeSafe(destPath),
      };
    } catch (err) {
      const message = (err && (err.userMessage || err.message)) || 'The download failed.';
      publish(id, { state: 'failed', message });
      return { ok: false, id, kind: (err && err.kind) || 'download_failed', message };
    }
  }

  // ---- select -------------------------------------------------------

  async function select(id) {
    const spec = specFor(id);
    const file = spec ? spec.file : `${id}.gguf`;
    const modelPath = destPathFor(file);

    if (!existsSync(modelPath)) {
      return { ok: false, id, kind: 'not_present', message: 'That model is not on the stick yet. Download it first.' };
    }

    mkdirSync(paths.state, { recursive: true });
    writeFileSync(stateFilePath(), JSON.stringify({ id, file }, null, 2));

    // engine.restart() (app/lib/engine.js) takes no arguments and reuses
    // whatever model path its own last start() call remembered, so it
    // cannot pick up a newly selected model on its own; stopping and
    // starting again with the new path gets the same "restart on a new
    // model" result through the real interface that file exposes.
    let restarted = false;
    if (engineIsRunning()) {
      await engine.stop();
      await engine.start({ modelPath });
      restarted = true;
    }

    return { ok: true, id, file, restarted };
  }

  return { list, download, select, current };
}

// ---------------------------------------------------------------------------
// wireModels
// ---------------------------------------------------------------------------

export function wireModels(app, { models }) {
  app.addRoute('GET', '/api/models', async (req, res, ctx) => {
    ctx.sendJson(200, await models.list());
  });

  // A model can be gigabytes; like /api/firstrun/start, this kicks the
  // download off and answers right away instead of holding the request
  // open for minutes. Progress arrives as `models` events on GET /api/events.
  app.addRoute('POST', '/api/models/download', async (req, res, ctx) => {
    let body;
    try {
      body = await ctx.readJson();
    } catch {
      return ctx.sendJson(400, { error: 'bad_request', message: 'invalid json' });
    }
    const id = body && body.id;
    if (!id) return ctx.sendJson(400, { error: 'bad_request', message: 'id is required' });
    models.download(id).catch(() => {});
    ctx.sendJson(200, { ok: true, id, started: true });
  });

  app.addRoute('POST', '/api/models/select', async (req, res, ctx) => {
    let body;
    try {
      body = await ctx.readJson();
    } catch {
      return ctx.sendJson(400, { error: 'bad_request', message: 'invalid json' });
    }
    const id = body && body.id;
    if (!id) return ctx.sendJson(400, { error: 'bad_request', message: 'id is required' });
    const result = await models.select(id);
    ctx.sendJson(result.ok ? 200 : 400, result);
  });

  return models;
}
