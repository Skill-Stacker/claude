import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEngine, buildArgs } from '../app/lib/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = join(HERE, '..', 'tools', 'fake-engine.mjs');

// ---------------------------------------------------------------------------
// Fixtures shared by every test in this file
// ---------------------------------------------------------------------------

function makePaths() {
  const base = mkdtempSync(join(tmpdir(), 'stickos-engine-'));
  return { base, bin: join(base, 'bin'), models: join(base, 'models'), state: join(base, 'state') };
}

const MANIFEST = {
  engine: { name: 'llamafile', version: '0.10.5', url: 'https://example.invalid/llamafile', size: 1, sha256: 'engine-expected-sha', min_mb: 1 },
  model: {
    primary: { file: 'model.gguf', url: 'https://example.invalid/model.gguf', size: 1, sha256: 'model-expected-sha', min_mb: 1 },
    fallback: { file: 'model-fallback.gguf', url: 'https://example.invalid/fallback.gguf', size: 1, sha256: null, min_mb: 1 },
  },
};

// A verify() stub that always passes and hands back a stable sha256 keyed
// off which manifest entry it was asked to check, matching the shape
// app/lib/downloads.js's verifyAsset() actually returns.
async function okVerify(path, spec) {
  if (spec === MANIFEST.engine) return { ok: true, reason: null, sha256: 'engine-actual-sha' };
  return { ok: true, reason: null, sha256: 'model-actual-sha' };
}

// Redirects a spawn("<fake binary path>", args, opts) call onto the real
// fake-engine.mjs, forwarding every arg engine.js built (buildArgs already
// includes --port, so the fake listens on the port engine.js picked) and
// tacking on a short load time so tests do not sit through the real
// 5-30s load window.
function realSpawn(binaryPath, args, opts) {
  return nodeSpawn(process.execPath, [FAKE_ENGINE, ...args, '--load-ms', '120', '--tps', '200'], opts);
}

function makeInertChild() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 999999;
  proc.kill = () => { setTimeout(() => proc.emit('exit', null, 'SIGTERM'), 5); return true; };
  return proc;
}

function makeEnoentSpawn() {
  return () => {
    const proc = new EventEmitter();
    process.nextTick(() => proc.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    return proc;
  };
}

function makeCrashingChild(code) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 1234;
  proc.kill = () => true;
  setTimeout(() => proc.emit('exit', code, null), 10);
  return proc;
}

function modelPathFor(paths) {
  return join(paths.models, 'model.gguf');
}

// ---------------------------------------------------------------------------
// buildArgs: pure function, no process involved
// ---------------------------------------------------------------------------

describe('buildArgs', () => {
  test('always includes the base launch shape', () => {
    const args = buildArgs({ modelPath: '/x/model.gguf', port: 8080, gpu: false, flags: {} });
    assert.deepEqual(args, ['-m', '/x/model.gguf', '--server', '--host', '127.0.0.1', '--port', '8080', '-ngl', '999']);
  });

  test('adds --gpu nvidia only when gpu is true', () => {
    const withGpu = buildArgs({ modelPath: '/x/model.gguf', port: 8080, gpu: true, flags: {} });
    assert.ok(withGpu.includes('--gpu'));
    assert.equal(withGpu[withGpu.indexOf('--gpu') + 1], 'nvidia');

    const withoutGpu = buildArgs({ modelPath: '/x/model.gguf', port: 8080, gpu: false, flags: {} });
    assert.ok(!withoutGpu.includes('--gpu'));
  });

  test('includes only the flags marked present', () => {
    const args = buildArgs({
      modelPath: '/x/model.gguf',
      port: 8080,
      gpu: false,
      flags: { jinja: true, reasoningBudget: false, reasoningFormat: false, parallel: true, chatTemplateKwargs: false },
    });
    assert.ok(args.includes('--jinja'));
    assert.ok(args.includes('-np'));
    assert.ok(!args.includes('--reasoning-budget'));
    assert.ok(!args.includes('--reasoning-format'));
    assert.ok(!args.includes('--chat-template-kwargs'));
  });

  test('passes every flag when all are present', () => {
    const args = buildArgs({
      modelPath: '/x/model.gguf',
      port: 8080,
      gpu: true,
      flags: { jinja: true, reasoningBudget: true, reasoningFormat: true, parallel: true, chatTemplateKwargs: true },
    });
    for (const flag of ['--jinja', '--reasoning-budget', '--reasoning-format', '-np', '--chat-template-kwargs', '--gpu']) {
      assert.ok(args.includes(flag), `expected ${flag} in ${args.join(' ')}`);
    }
  });
});

// ---------------------------------------------------------------------------
// probeGpu
// ---------------------------------------------------------------------------

describe('probeGpu', () => {
  test('ENOENT (no nvidia-smi) means no GPU, not an exception', async () => {
    const engine = createEngine({
      paths: makePaths(),
      manifest: MANIFEST,
      verify: okVerify,
      execFile: (file, args, options, cb) => cb(Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' }), '', ''),
    });
    const gpu = await engine.probeGpu();
    assert.equal(gpu.available, false);
  });

  test('"No devices were found" means no GPU', async () => {
    const engine = createEngine({
      paths: makePaths(),
      manifest: MANIFEST,
      verify: okVerify,
      execFile: (file, args, options, cb) => cb(new Error('nvidia-smi exited 6'), 'No devices were found\n', ''),
    });
    const gpu = await engine.probeGpu();
    assert.equal(gpu.available, false);
  });

  test('a "GPU 0: ..." line means available', async () => {
    const engine = createEngine({
      paths: makePaths(),
      manifest: MANIFEST,
      verify: okVerify,
      execFile: (file, args, options, cb) => cb(null, 'GPU 0: NVIDIA GeForce RTX 3060 (UUID: GPU-abcd)\n', ''),
    });
    const gpu = await engine.probeGpu();
    assert.equal(gpu.available, true);
    assert.match(gpu.detail, /GPU 0/);
  });

  test('caches the result for the life of the engine instance', async () => {
    let calls = 0;
    const engine = createEngine({
      paths: makePaths(),
      manifest: MANIFEST,
      verify: okVerify,
      execFile: (file, args, options, cb) => { calls++; cb(null, 'GPU 0: fake\n', ''); },
    });
    await engine.probeGpu();
    await engine.probeGpu();
    assert.equal(calls, 1);
  });
});

// ---------------------------------------------------------------------------
// probeFlags
// ---------------------------------------------------------------------------

describe('probeFlags', () => {
  function execFileViaFakeEngine(helpFlagsCsv) {
    return (file, args, options, cb) => nodeExecFile(process.execPath, [FAKE_ENGINE, '--help', '--help-flags', helpFlagsCsv], options, cb);
  }

  test('parses which flags --help advertises', async () => {
    const paths = makePaths();
    const engine = createEngine({
      paths,
      manifest: MANIFEST,
      verify: okVerify,
      execFile: execFileViaFakeEngine('jinja,reasoning-budget,parallel'),
    });
    const flags = await engine.probeFlags();
    assert.deepEqual(flags, {
      jinja: true,
      reasoningBudget: true,
      reasoningFormat: false,
      parallel: true,
      chatTemplateKwargs: false,
    });
  });

  test('caches to state/engine-flags.json keyed by sha256, so a second probe skips --help', async () => {
    const paths = makePaths();
    let calls = 0;
    const engine = createEngine({
      paths,
      manifest: MANIFEST,
      verify: okVerify,
      execFile: (file, args, options, cb) => { calls++; execFileViaFakeEngine('jinja')(file, args, options, cb); },
    });
    const first = await engine.probeFlags();
    const second = await engine.probeFlags();
    assert.deepEqual(first, second);
    assert.equal(calls, 1);

    const cached = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(paths.state, 'engine-flags.json'), 'utf8')));
    assert.ok(cached['engine-actual-sha']);
    assert.equal(cached['engine-actual-sha'].jinja, true);
  });
});

// ---------------------------------------------------------------------------
// start(): the state machine
// ---------------------------------------------------------------------------

describe('start', () => {
  test('reaches ready against the fake engine', async () => {
    const paths = makePaths();
    const engine = createEngine({
      paths,
      manifest: MANIFEST,
      verify: okVerify,
      spawn: realSpawn,
      timers: { healthPollMs: 30 },
    });
    try {
      const result = await engine.start({ modelPath: modelPathFor(paths) });
      assert.equal(result.state, 'ready');
      assert.equal(engine.status().state, 'ready');
      assert.ok(engine.port >= 8080 && engine.port <= 8084);
      assert.equal(engine.baseUrl(), `http://127.0.0.1:${engine.port}`);

      const health = await fetch(`${engine.baseUrl()}/health`).then((r) => r.json());
      assert.equal(health.status, 'ok');
    } finally {
      await engine.stop();
    }
  });

  test('missing_engine when verify rejects the binary', async () => {
    const paths = makePaths();
    const engine = createEngine({
      paths,
      manifest: MANIFEST,
      verify: async () => ({ ok: false, reason: 'missing' }),
      spawn: realSpawn,
    });
    const result = await engine.start({ modelPath: modelPathFor(paths) });
    assert.equal(result.state, 'missing_engine');
    assert.equal(result.reason, 'missing');
  });

  test('bad_model when verify rejects the model but not the engine', async () => {
    const paths = makePaths();
    const engine = createEngine({
      paths,
      manifest: MANIFEST,
      verify: async (path, spec) => (spec === MANIFEST.engine ? { ok: true, sha256: 'x' } : { ok: false, reason: 'hash_mismatch' }),
      spawn: realSpawn,
    });
    const result = await engine.start({ modelPath: modelPathFor(paths) });
    assert.equal(result.state, 'bad_model');
    assert.equal(result.reason, 'hash_mismatch');
  });

  test('a decoy listener on 8080 makes it pick 8081', async () => {
    const decoy = createServer();
    await new Promise((resolvePromise) => decoy.listen(8080, '127.0.0.1', resolvePromise));
    const paths = makePaths();
    const engine = createEngine({
      paths,
      manifest: MANIFEST,
      verify: okVerify,
      spawn: realSpawn,
      timers: { healthPollMs: 30 },
    });
    try {
      const result = await engine.start({ modelPath: modelPathFor(paths) });
      assert.equal(result.state, 'ready');
      assert.equal(engine.port, 8081);
    } finally {
      await engine.stop();
      await new Promise((resolvePromise) => decoy.close(resolvePromise));
    }
  });

  test('spawn ENOENT reports spawn_enoent, and guidance defender after two in a row', async () => {
    const paths = makePaths();
    const engine = createEngine({
      paths,
      manifest: MANIFEST,
      verify: okVerify,
      spawn: makeEnoentSpawn(),
    });
    const first = await engine.start({ modelPath: modelPathFor(paths) });
    assert.equal(first.state, 'spawn_enoent');
    assert.equal(first.guidance, undefined);

    const second = await engine.start({ modelPath: modelPathFor(paths) });
    assert.equal(second.state, 'spawn_enoent');
    assert.equal(second.guidance, 'defender');
  });

  test('silent when the process never answers /health', async () => {
    const paths = makePaths();
    const engine = createEngine({
      paths,
      manifest: MANIFEST,
      verify: okVerify,
      spawn: () => makeInertChild(),
      timers: { healthPollMs: 20, silentMs: 150 },
    });
    const result = await engine.start({ modelPath: modelPathFor(paths) });
    assert.equal(result.state, 'silent');
    assert.equal(result.guidance, 'smartscreen');
  });

  test('crashed then one restart recovers to ready', async () => {
    const paths = makePaths();
    let attempts = 0;
    const events = [];
    const engine = createEngine({
      paths,
      manifest: MANIFEST,
      verify: okVerify,
      spawn: (binaryPath, args, opts) => {
        attempts++;
        return attempts === 1 ? makeCrashingChild(1) : realSpawn(binaryPath, args, opts);
      },
      timers: { healthPollMs: 30 },
      bus: { publish: (type, data) => events.push(data.state) },
    });
    try {
      const result = await engine.start({ modelPath: modelPathFor(paths) });
      assert.equal(result.state, 'ready');
      assert.equal(attempts, 2);
      assert.ok(events.includes('crashed'));
      assert.ok(events.includes('ready'));
    } finally {
      await engine.stop();
    }
  });

  test('crashed twice ends in failed with the last log lines', async () => {
    const paths = makePaths();
    const engine = createEngine({
      paths,
      manifest: MANIFEST,
      verify: okVerify,
      spawn: () => makeCrashingChild(1),
    });
    const result = await engine.start({ modelPath: modelPathFor(paths) });
    assert.equal(result.state, 'failed');
    assert.match(result.reason, /damaged model/);
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('stop', () => {
  test('kills the child and it stays dead', async () => {
    const paths = makePaths();
    const engine = createEngine({
      paths,
      manifest: MANIFEST,
      verify: okVerify,
      spawn: realSpawn,
      timers: { healthPollMs: 30 },
    });
    const started = await engine.start({ modelPath: modelPathFor(paths) });
    assert.equal(started.state, 'ready');
    const port = engine.port;

    const stopped = await engine.stop();
    assert.equal(stopped.state, 'stopped');
    assert.equal(engine.status().pid, null);

    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });
});
