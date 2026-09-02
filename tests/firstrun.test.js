import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { createFirstRun, wireFirstRun } from '../app/lib/firstrun.js';
import { createBus } from '../app/lib/bus.js';
import { createNetlog } from '../app/lib/netlog.js';
import { DownloadError } from '../app/lib/downloads.js';
import { startServer } from '../app/server.js';

// ---------------------------------------------------------------------------
// Fixtures shared by every test in this file
// ---------------------------------------------------------------------------

function makePaths() {
  const base = mkdtempSync(join(tmpdir(), 'stickos-firstrun-'));
  const paths = {
    base,
    bin: join(base, 'bin'),
    models: join(base, 'models'),
    voices: join(base, 'voices'),
    state: join(base, 'state'),
  };
  for (const dir of [paths.bin, paths.models, paths.voices, paths.state]) mkdirSync(dir, { recursive: true });
  return paths;
}

const ENGINE_URL = 'https://example.invalid/llamafile';
const MODEL_PRIMARY_URL = 'https://example.invalid/primary.gguf';
const MODEL_FALLBACK_URL = 'https://example.invalid/fallback.gguf';
const STT_URL = 'https://example.invalid/stt.tar.bz2';

// firstrun.js runs the real system `tar -xjf` on whatever lands at the stt
// archive path, so every fake download of it needs to be a real .tar.bz2,
// not placeholder bytes. Built once, locally, no network.
let fixtureArchiveBytes = null;
function fixtureArchive() {
  if (fixtureArchiveBytes) return fixtureArchiveBytes;
  const dir = mkdtempSync(join(tmpdir(), 'stickos-firstrun-fixture-'));
  // Archive the "stt-tiny" directory itself (matching manifest.stt.tiny.dir)
  // so extracting into paths.voices lands the file at voices/stt-tiny/tokens.txt,
  // the same shape a real sherpa-onnx release bundle extracts to.
  mkdirSync(join(dir, 'stt-tiny'), { recursive: true });
  writeFileSync(join(dir, 'stt-tiny', 'tokens.txt'), 'hello');
  const archivePath = join(dir, 'out.tar.bz2');
  execFileSync('tar', ['-cjf', archivePath, '-C', dir, 'stt-tiny']);
  fixtureArchiveBytes = readFileSync(archivePath);
  return fixtureArchiveBytes;
}

function makeManifest() {
  return {
    engine: { name: 'llamafile', version: '0.10.5', url: ENGINE_URL, size: 1000, sha256: 'engine-sha', min_mb: 0 },
    model: {
      tag: 'test:model',
      primary: { file: 'model-primary.gguf', url: MODEL_PRIMARY_URL, size: 2000, sha256: 'primary-sha', min_mb: 0, magic: 'GGUF' },
      fallback: { file: 'model-fallback.gguf', url: MODEL_FALLBACK_URL, size: 1500, sha256: 'fallback-sha', min_mb: 0, magic: 'GGUF' },
    },
    stt: {
      default: 'tiny',
      tiny: { url: STT_URL, size: 500, sha256: null, dir: 'stt-tiny' },
    },
    tts: { engine: 'kokoro-js' },
  };
}

// A fake downloads module matching app/lib/downloads.js's real exports:
// downloadAsset, verifyAsset, reverifyAll, diskFreePreflight, bytesNeeded.
// Records every call, sideloads when the destination already exists (the
// same escape hatch the real module has), and can be told to fail specific
// urls with a given DownloadError kind.
function makeFakeDownloads({ failUrls = {} } = {}) {
  const calls = [];

  async function downloadAsset(asset, destPath, opts = {}) {
    calls.push({ url: asset.url, destPath });

    if (existsSync(destPath)) {
      return { path: destPath, sha256: 'sideload-sha', skipped: true };
    }
    if (opts.signal && opts.signal.aborted) {
      throw new DownloadError('aborted', 'The request was cancelled.');
    }
    const fail = failUrls[asset.url];
    if (fail) {
      throw new DownloadError(fail.kind || 'offline', fail.message || 'it failed');
    }

    const total = asset.size || 1000;
    if (opts.onProgress) {
      opts.onProgress({ received: Math.floor(total / 2), total });
      opts.onProgress({ received: total, total });
    }
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, asset.url === STT_URL ? fixtureArchive() : 'GGUFxxxxxxxxxxxx');
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

function makeFakeEngine({ gpu = { available: false, detail: 'no card' }, results } = {}) {
  let calls = 0;
  let statusState = 'idle';
  let lastStart = null;
  const stopCalls = [];
  return {
    async probeGpu() {
      return gpu;
    },
    async start({ modelPath }) {
      calls += 1;
      lastStart = { modelPath, callIndex: calls };
      const r = Array.isArray(results) ? results[Math.min(calls - 1, results.length - 1)] : results || { state: 'ready' };
      statusState = r.state;
      return { state: r.state, reason: r.reason, port: 8080 };
    },
    async stop() {
      stopCalls.push(Date.now());
      statusState = 'stopped';
      return { state: 'stopped' };
    },
    status() {
      return { state: statusState };
    },
    get startCalls() {
      return calls;
    },
    get lastStart() {
      return lastStart;
    },
    get stopCalls() {
      return stopCalls;
    },
  };
}

// A createBus() with publish() intercepted so tests can inspect every
// event pushed, while still being "the real bus" (subscribe/close/etc.
// all still work exactly as app/lib/bus.js implements them).
function makeSpiedBus() {
  const bus = createBus();
  const published = [];
  bus.publish = (type, data) => published.push({ type, data });
  return { bus, published };
}

function stepOf(state, id) {
  return state.steps.find((s) => s.id === id);
}

function formatGB(bytes) {
  return (bytes / 1_000_000_000).toFixed(1);
}

// ---------------------------------------------------------------------------
// The happy path: step order, sideload skip, gpu line, idempotent start
// ---------------------------------------------------------------------------

describe('createFirstRun: the happy path', () => {
  test('runs node -> engine -> model -> tts(skipped) -> stt in order, then probes and starts', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine({ gpu: { available: true, detail: 'GPU 0: fake card' } });
    const { bus, published } = makeSpiedBus();
    const netlog = createNetlog(bus);

    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog });

    const initial = firstRun.state();
    assert.equal(initial.phase, 'preflight');
    assert.equal(stepOf(initial, 'node').state, 'done');
    assert.equal(stepOf(initial, 'engine').state, 'pending');

    const final = await firstRun.start();

    assert.equal(final.phase, 'ready');
    assert.equal(stepOf(final, 'node').state, 'done');
    assert.equal(stepOf(final, 'engine').state, 'done');
    assert.equal(stepOf(final, 'model').state, 'done');
    assert.equal(stepOf(final, 'tts').state, 'skipped');
    assert.equal(stepOf(final, 'stt').state, 'done');

    // downloadAsset was called for engine, model primary, and the stt
    // archive, strictly in that order; tts never calls it at all because
    // no warmTts() callback was given.
    assert.deepEqual(
      downloads.calls.map((c) => c.url),
      [ENGINE_URL, MODEL_PRIMARY_URL, STT_URL],
    );

    assert.deepEqual(final.gpu, { available: true, detail: 'GPU 0: fake card' });
    assert.equal(engine.startCalls, 1);
    assert.equal(engine.lastStart.modelPath, join(paths.models, 'model-primary.gguf'));

    // The ready promise resolves once, with the ready snapshot.
    const readyState = await firstRun.ready;
    assert.equal(readyState.phase, 'ready');

    // netlog recorded start and finish for each real download.
    const purposes = netlog.list().map((e) => e.purpose);
    assert.ok(purposes.includes('getting the AI engine'));
    assert.ok(purposes.includes('getting the model'));
    assert.ok(purposes.includes("getting Scout's ears"));

    assert.ok(published.some((e) => e.type === 'firstrun'));
  });

  test('a second start() call while running is idempotent; start() after ready is a no-op', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const { bus } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

    const p1 = firstRun.start();
    const p2 = firstRun.start(); // called synchronously, before p1's first await settles
    const s2 = await p2;
    assert.equal(s2.phase, 'preflight'); // returned the in-flight snapshot, did not start a second run
    const s1 = await p1;
    assert.equal(s1.phase, 'ready');

    assert.equal(engine.startCalls, 1);
    assert.equal(downloads.calls.length, 3); // engine + model + stt, not 6

    const s3 = await firstRun.start(); // already ready: also a no-op
    assert.equal(s3.phase, 'ready');
    assert.equal(engine.startCalls, 1);
  });

  test('sideload: a file already on disk that verifies is accepted without a real download', async () => {
    const paths = makePaths();
    writeFileSync(join(paths.bin, 'llamafile'), 'already here');
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const { bus } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

    const final = await firstRun.start();
    assert.equal(stepOf(final, 'engine').state, 'done');
    assert.equal(stepOf(final, 'engine').message, 'already on the stick');
  });

  test('gpu line: "Using your graphics card" vs "Using your processor"', async () => {
    for (const [available, expected] of [[true, 'Using your graphics card'], [false, 'Using your processor']]) {
      const paths = makePaths();
      const downloads = makeFakeDownloads();
      const engine = makeFakeEngine({ gpu: { available, detail: 'x' } });
      const { bus, published } = makeSpiedBus();
      const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

      await firstRun.start();
      // setPhase('probing') itself publishes once (message still null), then a
      // second, forced publish carries the gpu line once probeGpu() resolves.
      const probingEvents = published.filter((e) => e.type === 'firstrun' && e.data.phase === 'probing');
      assert.ok(probingEvents.length > 0, 'expected at least one firstrun event during the probing phase');
      assert.ok(probingEvents.some((e) => e.data.message === expected), `expected one probing event with message "${expected}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// The fallback model
// ---------------------------------------------------------------------------

describe('createFirstRun: model fallback', () => {
  test('a failed primary download falls back to the fallback model and says so', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads({ failUrls: { [MODEL_PRIMARY_URL]: { kind: 'offline' } } });
    const engine = makeFakeEngine();
    const { bus } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

    const final = await firstRun.start();
    assert.equal(final.phase, 'ready');
    assert.equal(stepOf(final, 'model').state, 'done');
    assert.match(stepOf(final, 'model').message, /fallback/i);

    assert.deepEqual(
      downloads.calls.map((c) => c.url),
      [ENGINE_URL, MODEL_PRIMARY_URL, MODEL_FALLBACK_URL, STT_URL],
    );
    assert.equal(engine.lastStart.modelPath, join(paths.models, 'model-fallback.gguf'));
    assert.ok(existsSync(join(paths.models, 'model-fallback.gguf')));
  });
});

// ---------------------------------------------------------------------------
// preflight: blocked
// ---------------------------------------------------------------------------

describe('createFirstRun: preflight blocked', () => {
  test('not enough free space blocks with the exact GB message', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    downloads.diskFreePreflight = async (dir, neededBytes) => {
      void dir;
      return { ok: false, free: 1_500_000_000, needed: neededBytes };
    };
    const engine = makeFakeEngine();
    const { bus } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

    const final = await firstRun.start();
    assert.equal(final.phase, 'blocked');
    const needed = final.needed;
    assert.equal(
      final.message,
      `This stick needs at least ${formatGB(needed)} GB free, yours has ${formatGB(1_500_000_000)}`,
    );
    assert.equal(downloads.calls.length, 0, 'no download should start once blocked');
  });
});

// ---------------------------------------------------------------------------
// verifying: the fake-capacity-stick signature
// ---------------------------------------------------------------------------

describe('createFirstRun: verifying', () => {
  test('a reverify failure after everything downloaded reports the suspect-stick message', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const { bus } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

    downloads.reverifyAll = async (entries) => ({ ok: false, path: entries[0].path, reason: 'hash_mismatch', sha256: null });

    const final = await firstRun.start();
    assert.equal(final.phase, 'failed');
    assert.equal(
      final.message,
      'This stick seems to be losing data as more is written to it. Try a different stick.',
    );
    assert.equal(stepOf(final, 'engine').state, 'failed');
    assert.equal(engine.startCalls, 0, 'the engine must never start over an unverified file');
  });
});

// ---------------------------------------------------------------------------
// throttled progress
// ---------------------------------------------------------------------------

describe('createFirstRun: throttled progress', () => {
  test('rapid progress ticks inside the same 250ms window are dropped, later ones publish', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    const original = downloads.downloadAsset;
    let clock = 1_000_000;
    const now = () => clock;

    downloads.downloadAsset = async (asset, destPath, opts) => {
      if (asset.url !== ENGINE_URL) return original(asset, destPath, opts);
      opts.onProgress({ received: 100, total: 1000 }); // same tick as the forced "active" publish: dropped
      opts.onProgress({ received: 200, total: 1000 }); // still inside the window: dropped
      clock += 300; // past the 250ms window
      opts.onProgress({ received: 300, total: 1000 }); // publishes
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, 'x');
      return { path: destPath, sha256: 'x', skipped: false };
    };

    const engine = makeFakeEngine();
    const { bus, published } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus), now });

    await firstRun.start();

    const engineReceived = published
      .filter((e) => e.type === 'firstrun')
      .map((e) => stepOf(e.data, 'engine').received)
      .filter((v) => v != null);

    assert.ok(!engineReceived.includes(100), 'a progress tick published in the same instant as the forced one should have been throttled');
    assert.ok(!engineReceived.includes(200), 'a second rapid tick should also have been throttled');
    assert.ok(engineReceived.includes(300), 'a tick after the throttle window should have published');
  });
});

// ---------------------------------------------------------------------------
// retry()
// ---------------------------------------------------------------------------

describe('createFirstRun: retry', () => {
  test('retry() clears the failed step and continues from it, skipping steps already done', async () => {
    const paths = makePaths();
    const failUrls = {
      [MODEL_PRIMARY_URL]: { kind: 'offline' },
      [MODEL_FALLBACK_URL]: { kind: 'offline' },
    };
    const downloads = makeFakeDownloads({ failUrls });
    const engine = makeFakeEngine();
    const { bus } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

    const failed = await firstRun.start();
    assert.equal(failed.phase, 'failed');
    assert.equal(stepOf(failed, 'engine').state, 'done'); // already succeeded, not touched
    assert.equal(stepOf(failed, 'model').state, 'failed');
    assert.equal(stepOf(failed, 'tts').state, 'pending'); // never reached
    assert.equal(stepOf(failed, 'stt').state, 'pending');

    delete failUrls[MODEL_PRIMARY_URL];
    delete failUrls[MODEL_FALLBACK_URL];

    const recovered = await firstRun.retry();
    assert.equal(recovered.phase, 'ready');
    assert.equal(stepOf(recovered, 'model').state, 'done');
    assert.equal(stepOf(recovered, 'stt').state, 'done');

    // engine was only ever downloaded once (retry skipped the already-done step)
    assert.equal(downloads.calls.filter((c) => c.url === ENGINE_URL).length, 1);
    // model primary was retried
    assert.equal(downloads.calls.filter((c) => c.url === MODEL_PRIMARY_URL).length, 2);
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('createFirstRun: stop', () => {
  test('stop() aborts the in-flight download and stops the engine', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    const original = downloads.downloadAsset;
    downloads.downloadAsset = (asset, destPath, opts) => {
      if (asset.url !== ENGINE_URL) return original(asset, destPath, opts);
      return new Promise((resolvePromise, reject) => {
        opts.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' }));
        });
      });
    };
    const engine = makeFakeEngine();
    const { bus } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

    const startP = firstRun.start();
    await new Promise((r) => setTimeout(r, 20)); // let it reach the hanging download
    assert.equal(stepOf(firstRun.state(), 'engine').state, 'active');

    const stopped = await firstRun.stop();
    assert.equal(stepOf(stopped, 'engine').state, 'pending'); // reverted, not marked failed
    assert.equal(engine.stopCalls.length, 1);

    await startP; // the original start() call must also resolve cleanly, never hang
  });
});

// ---------------------------------------------------------------------------
// stt: real tar extraction, and the "already unpacked" skip
// ---------------------------------------------------------------------------

describe('createFirstRun: stt', () => {
  test('skips extraction when the directory already has files', async () => {
    const paths = makePaths();
    mkdirSync(join(paths.voices, 'stt-tiny'), { recursive: true });
    writeFileSync(join(paths.voices, 'stt-tiny', 'tokens.txt'), 'x');
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const { bus } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

    const final = await firstRun.start();
    assert.equal(stepOf(final, 'stt').state, 'done');
    assert.equal(stepOf(final, 'stt').message, 'already on the stick');
    assert.ok(!downloads.calls.some((c) => c.url === STT_URL));
  });

  test('downloads and really extracts a .tar.bz2 bundle with the system tar', async () => {
    const paths = makePaths();

    // The default fake writes a real .tar.bz2 (built once by fixtureArchive())
    // for the stt url, so firstrun.js's own real `tar -xjf` does genuine work.
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const { bus } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

    const final = await firstRun.start();
    assert.equal(stepOf(final, 'stt').state, 'done');
    assert.deepEqual(readdirSync(join(paths.voices, 'stt-tiny')), ['tokens.txt']);
    assert.equal(readFileSync(join(paths.voices, 'stt-tiny', 'tokens.txt'), 'utf8'), 'hello');
    assert.ok(!existsSync(join(paths.voices, 'stt-tiny.tar.bz2')), 'the archive should be cleaned up after extraction');
  });
});

// ---------------------------------------------------------------------------
// tts: warmTts callback
// ---------------------------------------------------------------------------

describe('createFirstRun: tts', () => {
  test('with a warmTts callback the step goes active then done', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const { bus, published } = makeSpiedBus();
    let warmed = false;
    const warmTts = async () => {
      warmed = true;
    };
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus), warmTts });

    const final = await firstRun.start();
    assert.ok(warmed);
    assert.equal(stepOf(final, 'tts').state, 'done');
    assert.ok(published.some((e) => e.type === 'firstrun' && stepOf(e.data, 'tts').state === 'active'));
  });

  test('without a warmTts callback the step is skipped with a note', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const { bus } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

    const final = await firstRun.start();
    assert.equal(stepOf(final, 'tts').state, 'skipped');
    assert.ok(stepOf(final, 'tts').message);
  });
});

// ---------------------------------------------------------------------------
// engine start failure
// ---------------------------------------------------------------------------

describe('createFirstRun: engine start failure', () => {
  test('an engine that never reaches ready ends the run in failed with its reason', async () => {
    const paths = makePaths();
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine({ results: { state: 'crashed', reason: 'engine exited with code 1' } });
    const { bus } = makeSpiedBus();
    const firstRun = createFirstRun({ paths, manifest: makeManifest(), downloads, engine, bus, netlog: createNetlog(bus) });

    const final = await firstRun.start();
    assert.equal(final.phase, 'failed');
    assert.equal(final.message, 'engine exited with code 1');
    // no download step is blamed: everything actually downloaded fine
    assert.equal(stepOf(final, 'model').state, 'done');
  });
});

// ---------------------------------------------------------------------------
// wireFirstRun on a real server
// ---------------------------------------------------------------------------

let nextPort = 47390;
function testPort() {
  nextPort += 1;
  return nextPort;
}

async function readSseEvents(res, timeoutMs) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const outcome = await Promise.race([
      reader.read().then((r) => ({ read: r })),
      new Promise((r) => setTimeout(r, remaining)).then(() => ({ timedOut: true })),
    ]);
    if (outcome.timedOut) break;
    const { value, done } = outcome.read;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const typeMatch = raw.match(/^event: (.+)$/m);
      const dataMatch = raw.match(/^data: (.+)$/m);
      if (typeMatch && dataMatch) {
        try {
          events.push({ type: typeMatch[1], data: JSON.parse(dataMatch[1]) });
        } catch {
          // ignore a stray non-JSON frame (heartbeats etc.)
        }
      }
    }
  }
  try {
    await reader.cancel();
  } catch {
    // already closed
  }
  return events;
}

describe('wireFirstRun on a real server', () => {
  test('GET /api/firstrun, POST /api/firstrun/start, and firstrun SSE events', async () => {
    const app = await startServer({ baseDir: mkdtempSync(join(tmpdir(), 'stickos-firstrun-server-')), port: testPort() });
    const downloads = makeFakeDownloads();
    const engine = makeFakeEngine();
    const firstRun = createFirstRun({ paths: app.paths, manifest: makeManifest(), downloads, engine, bus: app.bus, netlog: app.netlog });
    wireFirstRun(app, { firstRun });

    try {
      const getRes = await fetch(`${app.origin}/api/firstrun`);
      assert.equal(getRes.status, 200);
      const body = await getRes.json();
      assert.equal(body.phase, 'preflight');
      assert.equal(stepOf(body, 'node').state, 'done');

      const status = await (await fetch(`${app.origin}/api/status`)).json();
      assert.equal(status.downloads.phase, 'preflight');

      const noToken = await fetch(`${app.origin}/api/firstrun/start`, { method: 'POST' });
      assert.equal(noToken.status, 401);

      const sseRes = await fetch(`${app.origin}/api/events`);
      const startRes = await fetch(`${app.origin}/api/firstrun/start`, {
        method: 'POST',
        headers: { 'x-stickos-token': app.token },
      });
      assert.equal(startRes.status, 200);
      await startRes.json();

      const events = await readSseEvents(sseRes, 800);
      const firstrunEvents = events.filter((e) => e.type === 'firstrun');
      assert.ok(firstrunEvents.length > 0, 'expected at least one firstrun SSE event');
    } finally {
      await app.close();
    }
  });
});
