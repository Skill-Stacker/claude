import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { createModelManager, wireModels } from '../app/lib/studio/models.js';
import { createBus } from '../app/lib/bus.js';
import { startServer } from '../app/server.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePaths() {
  const base = mkdtempSync(join(tmpdir(), 'stickos-models-'));
  const paths = { base, models: join(base, 'models'), state: join(base, 'state') };
  mkdirSync(paths.models, { recursive: true });
  mkdirSync(paths.state, { recursive: true });
  return paths;
}

const PRIMARY_URL = 'https://example.invalid/qwen3.5-4b-q6_k_l.gguf';
const FALLBACK_URL = 'https://example.invalid/qwen3.5-4b-q4_k_m.gguf';

function makeManifest() {
  return {
    model: {
      tag: 'qwen3.5:4b-q6_k_l',
      primary: { file: 'qwen3.5-4b-q6_k_l.gguf', url: PRIMARY_URL, size: 4000, sha256: 'primary-sha', min_mb: 0, magic: 'GGUF' },
      fallback: { file: 'qwen3.5-4b-q4_k_m.gguf', url: FALLBACK_URL, size: 2500, sha256: 'fallback-sha', min_mb: 0, magic: 'GGUF' },
    },
  };
}

// A fake matching app/lib/downloads.js's real exports (downloadAsset,
// verifyAsset, reverifyAll, diskFreePreflight, bytesNeeded). Any file
// already present at the destination is treated as valid, so tests can
// assert `present` by simply writing a file there.
function makeFakeDownloads({ diskFull = false } = {}) {
  const calls = [];

  async function downloadAsset(asset, destPath, opts = {}) {
    calls.push({ url: asset.url, destPath });
    const total = asset.size || 1000;
    if (opts.onProgress) {
      opts.onProgress({ received: Math.floor(total / 2), total });
      opts.onProgress({ received: total, total });
    }
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, 'GGUFxxxxxxxxxxxx');
    return { path: destPath, sha256: 'fake-sha', skipped: false };
  }

  async function verifyAsset(path) {
    return existsSync(path)
      ? { ok: true, reason: null, sha256: 'fake-sha' }
      : { ok: false, reason: 'missing', sha256: null };
  }

  async function reverifyAll(entries) {
    for (const { path } of entries) {
      // eslint-disable-next-line no-await-in-loop
      const check = await verifyAsset(path);
      if (!check.ok) return { ok: false, path, reason: check.reason, sha256: null };
    }
    return { ok: true };
  }

  async function diskFreePreflight(dir, neededBytes) {
    void dir;
    if (diskFull) return { ok: false, free: 100, needed: neededBytes };
    return { ok: true, free: neededBytes + 10_000_000_000, needed: neededBytes };
  }

  function bytesNeeded(assets, existingPaths) {
    const present = new Set(existingPaths);
    let total = 0;
    for (const a of assets) if (!present.has(a.path)) total += a.size || 0;
    return total;
  }

  return { downloadAsset, verifyAsset, reverifyAll, diskFreePreflight, bytesNeeded, calls };
}

function makeFakeEngine({ state = 'idle' } = {}) {
  let statusState = state;
  const stopCalls = [];
  const startCalls = [];
  return {
    async probeGpu() {
      return { available: false, detail: 'no card' };
    },
    async start({ modelPath }) {
      startCalls.push(modelPath);
      statusState = 'ready';
      return { state: 'ready', port: 8080 };
    },
    async stop() {
      stopCalls.push(Date.now());
      statusState = 'stopped';
      return { state: 'stopped' };
    },
    status() {
      return { state: statusState };
    },
    setState(s) {
      statusState = s;
    },
    get stopCalls() {
      return stopCalls;
    },
    get startCalls() {
      return startCalls;
    },
  };
}

function makeSpiedBus() {
  const bus = createBus();
  const published = [];
  bus.publish = (type, data) => published.push({ type, data });
  return { bus, published };
}

function byId(list, id) {
  return list.find((m) => m.id === id);
}

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe('createModelManager: list', () => {
  test('lists the curated primary and fallback, plus a stray .gguf on disk', async () => {
    const paths = makePaths();
    writeFileSync(join(paths.models, 'llama-3-8b-instruct.gguf'), 'GGUFxxxx');
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const models = createModelManager({ paths, manifest: makeManifest(), downloads, engine });

    const { models: list, current } = await models.list();
    assert.equal(current, null);

    const primary = byId(list, 'qwen3.5-4b-q6_k_l');
    const fallback = byId(list, 'qwen3.5-4b-q4_k_m');
    const stray = byId(list, 'llama-3-8b-instruct');

    assert.ok(primary, 'primary model should be listed');
    assert.ok(fallback, 'fallback model should be listed');
    assert.ok(stray, 'the stray .gguf file should be listed');

    assert.equal(primary.present, false);
    assert.equal(primary.notes, 'the default, tested with Scout');
    assert.equal(fallback.notes, null);

    assert.equal(stray.present, true);
    assert.equal(stray.label, 'Your own: llama-3-8b-instruct.gguf');
    assert.equal(stray.notes, null);
  });

  test('a downloaded file is present, and the selected model is marked selected', async () => {
    const paths = makePaths();
    writeFileSync(join(paths.models, 'qwen3.5-4b-q6_k_l.gguf'), 'GGUFxxxx');
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const models = createModelManager({ paths, manifest: makeManifest(), downloads, engine });

    await models.select('qwen3.5-4b-q6_k_l');

    const { models: list, current } = await models.list();
    assert.equal(current.id, 'qwen3.5-4b-q6_k_l');
    assert.equal(byId(list, 'qwen3.5-4b-q6_k_l').present, true);
    assert.equal(byId(list, 'qwen3.5-4b-q6_k_l').selected, true);
    assert.equal(byId(list, 'qwen3.5-4b-q4_k_m').selected, false);
  });
});

// ---------------------------------------------------------------------------
// download()
// ---------------------------------------------------------------------------

describe('createModelManager: download', () => {
  test('downloads a known model, reporting progress on the bus as models events', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const { bus, published } = makeSpiedBus();
    const models = createModelManager({ paths, manifest: makeManifest(), downloads, engine, bus });

    const result = await models.download('qwen3.5-4b-q4_k_m');
    assert.equal(result.ok, true);
    assert.equal(result.present, true);
    assert.ok(existsSync(join(paths.models, 'qwen3.5-4b-q4_k_m.gguf')));

    assert.deepEqual(downloads.calls.map((c) => c.url), [FALLBACK_URL]);

    const modelEvents = published.filter((e) => e.type === 'models' && e.data.id === 'qwen3.5-4b-q4_k_m');
    assert.ok(modelEvents.some((e) => e.data.state === 'active'));
    assert.ok(modelEvents.some((e) => e.data.state === 'done'));
  });

  test('an unknown id is rejected without touching downloadAsset', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const models = createModelManager({ paths, manifest: makeManifest(), downloads, engine });

    const result = await models.download('not-a-real-model');
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'unknown_model');
    assert.equal(downloads.calls.length, 0);
  });

  test('not enough free space is reported before any download starts', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads({ diskFull: true });
    const engine = makeFakeEngine();
    const models = createModelManager({ paths, manifest: makeManifest(), downloads, engine });

    const result = await models.download('qwen3.5-4b-q6_k_l');
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'disk_full');
    assert.equal(downloads.calls.length, 0);
  });

  test('a file that fails the GGUF magic check after downloading is not marked present', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    downloads.verifyAsset = async () => ({ ok: false, reason: 'bad_magic', sha256: null });
    const engine = makeFakeEngine();
    const models = createModelManager({ paths, manifest: makeManifest(), downloads, engine });

    const result = await models.download('qwen3.5-4b-q6_k_l');
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'bad_magic');
  });
});

// ---------------------------------------------------------------------------
// select()
// ---------------------------------------------------------------------------

describe('createModelManager: select', () => {
  test('writes state/model.json and restarts the engine when it is running', async () => {
    const paths = makePaths();
    writeFileSync(join(paths.models, 'qwen3.5-4b-q4_k_m.gguf'), 'GGUFxxxx');
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine({ state: 'ready' });
    const models = createModelManager({ paths, manifest: makeManifest(), downloads, engine });

    const result = await models.select('qwen3.5-4b-q4_k_m');
    assert.equal(result.ok, true);
    assert.equal(result.restarted, true);
    assert.equal(engine.stopCalls.length, 1);
    assert.deepEqual(engine.startCalls, [join(paths.models, 'qwen3.5-4b-q4_k_m.gguf')]);

    const saved = JSON.parse(readFileSync(join(paths.state, 'model.json'), 'utf8'));
    assert.deepEqual(saved, { id: 'qwen3.5-4b-q4_k_m', file: 'qwen3.5-4b-q4_k_m.gguf' });
    assert.deepEqual(models.current(), { id: 'qwen3.5-4b-q4_k_m', file: 'qwen3.5-4b-q4_k_m.gguf' });
  });

  test('does not restart the engine when it is not running', async () => {
    const paths = makePaths();
    writeFileSync(join(paths.models, 'qwen3.5-4b-q6_k_l.gguf'), 'GGUFxxxx');
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine({ state: 'idle' });
    const models = createModelManager({ paths, manifest: makeManifest(), downloads, engine });

    const result = await models.select('qwen3.5-4b-q6_k_l');
    assert.equal(result.ok, true);
    assert.equal(result.restarted, false);
    assert.equal(engine.stopCalls.length, 0);
    assert.equal(engine.startCalls.length, 0);
  });

  test('selects a stray .gguf file not in the manifest by its file-derived id', async () => {
    const paths = makePaths();
    writeFileSync(join(paths.models, 'llama-3-8b-instruct.gguf'), 'GGUFxxxx');
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine({ state: 'idle' });
    const models = createModelManager({ paths, manifest: makeManifest(), downloads, engine });

    const result = await models.select('llama-3-8b-instruct');
    assert.equal(result.ok, true);
    assert.equal(result.file, 'llama-3-8b-instruct.gguf');
    assert.deepEqual(models.current(), { id: 'llama-3-8b-instruct', file: 'llama-3-8b-instruct.gguf' });
  });

  test('selecting a model that is not on the stick yet fails', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const models = createModelManager({ paths, manifest: makeManifest(), downloads, engine });

    const result = await models.select('qwen3.5-4b-q6_k_l');
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'not_present');
  });
});

// ---------------------------------------------------------------------------
// wireModels on a real server
// ---------------------------------------------------------------------------

let nextPort = 47420;
function testPort() {
  nextPort += 1;
  return nextPort;
}

describe('wireModels on a real server', () => {
  test('GET /api/models, POST /api/models/download and /select', async () => {
    const app = await startServer({ baseDir: mkdtempSync(join(tmpdir(), 'stickos-models-server-')), port: testPort() });
    mkdirSync(app.paths.models, { recursive: true });
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const models = createModelManager({ paths: app.paths, manifest: makeManifest(), downloads, engine, bus: app.bus });
    wireModels(app, { models });

    try {
      const getRes = await fetch(`${app.origin}/api/models`);
      assert.equal(getRes.status, 200);
      const body = await getRes.json();
      assert.ok(byId(body.models, 'qwen3.5-4b-q6_k_l'));

      const noToken = await fetch(`${app.origin}/api/models/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'qwen3.5-4b-q4_k_m' }),
      });
      assert.equal(noToken.status, 401);

      const dl = await fetch(`${app.origin}/api/models/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ id: 'qwen3.5-4b-q4_k_m' }),
      });
      assert.equal(dl.status, 200);
      const dlBody = await dl.json();
      assert.equal(dlBody.started, true);

      // POST /api/models/download answers immediately (a model can be
      // gigabytes); give the fire-and-forget download a tick to land.
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(existsSync(join(app.paths.models, 'qwen3.5-4b-q4_k_m.gguf')));

      const sel = await fetch(`${app.origin}/api/models/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ id: 'qwen3.5-4b-q4_k_m' }),
      });
      assert.equal(sel.status, 200);
      const selBody = await sel.json();
      assert.equal(selBody.ok, true);
      assert.equal(selBody.id, 'qwen3.5-4b-q4_k_m');
    } finally {
      await app.close();
    }
  });
});
