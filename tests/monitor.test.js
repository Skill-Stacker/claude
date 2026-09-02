import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../app/server.js';
import {
  sampleCpu,
  sampleRam,
  sampleDisk,
  sampleGpu,
  createMonitor,
  wireMonitor,
  humanBytes,
  humanPercent,
} from '../app/lib/monitor.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'stickos-monitor-'));
}

let nextPort = 47370;
function testPort() {
  nextPort += 1;
  return nextPort;
}

// A fake execFile with node's execFile(file, args, options, callback) shape,
// so it drops straight into sampleGpu({ execFile }) in place of the real
// node:child_process one.
function fakeExecFile(kind) {
  return (file, args, options, callback) => {
    if (kind === 'ok') {
      callback(null, 'NVIDIA GeForce RTX 3080, 42, 2048, 10240, 65\n', '');
    } else if (kind === 'enoent') {
      const err = new Error('spawn nvidia-smi ENOENT');
      err.code = 'ENOENT';
      callback(err, '', '');
    } else if (kind === 'garbage') {
      callback(null, 'not a csv line at all, no numbers here\n', '');
    } else {
      throw new Error(`unknown fake kind: ${kind}`);
    }
  };
}

// ---------------------------------------------------------------------------
// sampleGpu: canned nvidia-smi line, ENOENT, garbage
// ---------------------------------------------------------------------------

describe('sampleGpu', () => {
  test('parses a real nvidia-smi CSV line', async () => {
    const gpu = await sampleGpu({ execFile: fakeExecFile('ok') });
    assert.deepEqual(gpu, {
      name: 'NVIDIA GeForce RTX 3080',
      util: 42,
      vram: { used: 2048 * 1024 * 1024, total: 10240 * 1024 * 1024 },
      temp: 65,
    });
  });

  test('ENOENT (no nvidia-smi on this machine) falls back to null, never throws', async () => {
    const gpu = await sampleGpu({ execFile: fakeExecFile('enoent') });
    assert.equal(gpu, null);
  });

  test('garbage stdout falls back to null, never throws', async () => {
    const gpu = await sampleGpu({ execFile: fakeExecFile('garbage') });
    assert.equal(gpu, null);
  });

  test('darwin returns an unavailable note without running anything', async () => {
    const original = process.platform;
    let ran = false;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const gpu = await sampleGpu({
        execFile: () => {
          ran = true;
        },
      });
      assert.equal(ran, false);
      assert.deepEqual(gpu, { unavailable: true, reason: 'not available on this Mac without extra permission' });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sampleCpu: this has to run before anything else in the file touches it,
// since the "first call is null" promise is about the module's very first
// sample, not this test's.
// ---------------------------------------------------------------------------

describe('sampleCpu', () => {
  test('first call has nothing to diff against and returns percent: null; second is a real number', () => {
    const first = sampleCpu();
    assert.equal(first.percent, null);
    assert.equal(typeof first.cores, 'number');
    assert.ok(first.cores > 0);
    if (process.platform !== 'win32') {
      assert.ok(Array.isArray(first.load));
      assert.equal(first.load.length, 3);
    } else {
      assert.equal('load' in first, false);
    }

    const second = sampleCpu();
    assert.equal(typeof second.percent, 'number');
    assert.ok(second.percent >= 0 && second.percent <= 100, `percent ${second.percent} should be in [0, 100]`);
  });
});

// ---------------------------------------------------------------------------
// sampleRam
// ---------------------------------------------------------------------------

describe('sampleRam', () => {
  test('reports sane used/total/percent', () => {
    const ram = sampleRam();
    assert.equal(typeof ram.total, 'number');
    assert.ok(ram.total > 0);
    assert.equal(typeof ram.used, 'number');
    assert.ok(ram.used >= 0 && ram.used <= ram.total);
    assert.equal(typeof ram.percent, 'number');
    assert.ok(ram.percent >= 0 && ram.percent <= 100);
  });
});

// ---------------------------------------------------------------------------
// sampleDisk
// ---------------------------------------------------------------------------

describe('sampleDisk', () => {
  test('works on a temp dir', async () => {
    const disk = await sampleDisk(tmpDir());
    assert.equal(typeof disk.total, 'number');
    assert.ok(disk.total > 0);
    assert.equal(typeof disk.free, 'number');
    assert.ok(disk.free >= 0 && disk.free <= disk.total);
  });
});

// ---------------------------------------------------------------------------
// createMonitor: sample() shape, watch/stop bookkeeping
// ---------------------------------------------------------------------------

describe('createMonitor', () => {
  test('needs paths.base', () => {
    assert.throws(() => createMonitor({}), /paths\.base/);
  });

  test('sample() assembles cpu, ram, disk, gpu, at', async () => {
    const paths = { base: tmpDir() };
    const monitor = createMonitor({ paths, execFile: fakeExecFile('ok'), bus: null });
    const snap = await monitor.sample();
    assert.ok(snap.cpu && typeof snap.cpu.cores === 'number');
    assert.ok(snap.ram && typeof snap.ram.total === 'number');
    assert.ok(snap.disk && typeof snap.disk.total === 'number');
    assert.equal(snap.gpu.name, 'NVIDIA GeForce RTX 3080');
    assert.equal(typeof snap.at, 'string');
    assert.ok(!Number.isNaN(Date.parse(snap.at)));
  });

  test('watch/stop toggle watching, and stop() is idempotent', () => {
    const paths = { base: tmpDir() };
    const monitor = createMonitor({ paths, execFile: fakeExecFile('enoent'), bus: null });
    assert.equal(monitor.watching, false);
    monitor.watch(true);
    assert.equal(monitor.watching, true);
    monitor.stop();
    assert.equal(monitor.watching, false);
    monitor.stop(); // must not throw on a second stop
    assert.equal(monitor.watching, false);
  });
});

// ---------------------------------------------------------------------------
// The real server: routes, and the 30s auto-stop, proven with a fake clock
// instead of an actual 30 second wait.
// ---------------------------------------------------------------------------

describe('wireMonitor on a real server', () => {
  test('GET /api/monitor and POST /api/monitor/watch require what the API contract says', async () => {
    const app = await startServer({ baseDir: tmpDir(), port: testPort() });
    const monitor = createMonitor({ paths: app.paths, execFile: fakeExecFile('enoent'), bus: app.bus, intervalMs: 20 });
    wireMonitor(app, { monitor });
    try {
      const getRes = await fetch(`${app.origin}/api/monitor`);
      assert.equal(getRes.status, 200);
      const snap = await getRes.json();
      assert.ok(snap.cpu);
      assert.ok(snap.ram);
      assert.ok(snap.disk);
      assert.equal(snap.gpu, null);

      const noToken = await fetch(`${app.origin}/api/monitor/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: true }),
      });
      assert.equal(noToken.status, 401);
      assert.equal(monitor.watching, false);

      const withToken = await fetch(`${app.origin}/api/monitor/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ on: true }),
      });
      assert.equal(withToken.status, 200);
      const watchBody = await withToken.json();
      assert.equal(watchBody.watching, true);
      assert.equal(monitor.watching, true);

      const status = await (await fetch(`${app.origin}/api/status`)).json();
      assert.equal(status.monitor.watching, true);

      const off = await fetch(`${app.origin}/api/monitor/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ on: false }),
      });
      assert.equal((await off.json()).watching, false);
      assert.equal(monitor.watching, false);
    } finally {
      await app.close();
    }
  });

  test('while watching, monitor events reach GET /api/events', async () => {
    const app = await startServer({ baseDir: tmpDir(), port: testPort() });
    const monitor = createMonitor({ paths: app.paths, execFile: fakeExecFile('enoent'), bus: app.bus, intervalMs: 15 });
    wireMonitor(app, { monitor });
    try {
      const sseRes = await fetch(`${app.origin}/api/events`);
      await fetch(`${app.origin}/api/monitor/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ on: true }),
      });

      const events = await readSseEvents(sseRes, 500);
      const monitorEvents = events.filter((e) => e.type === 'monitor');
      assert.ok(monitorEvents.length > 0, 'expected at least one monitor SSE event');
      assert.equal(monitorEvents[0].data.gpu, null);
      assert.ok(monitorEvents[0].data.ram);
    } finally {
      await app.close();
    }
  });

  test('watching auto-stops after idleMs with no re-arm, proven on a fake clock', async () => {
    const app = await startServer({ baseDir: tmpDir(), port: testPort() });
    let clockOffset = 0;
    const now = () => 1_000_000 + clockOffset; // fake clock; real setInterval still ticks in real time
    const monitor = createMonitor({
      paths: app.paths,
      execFile: fakeExecFile('enoent'),
      bus: app.bus,
      intervalMs: 15, // real ms between ticks, kept tiny so the test stays fast
      idleMs: 200,    // fake ms of allowed silence before watch() gives up
      now,
    });
    wireMonitor(app, { monitor });
    try {
      monitor.watch(true);
      assert.equal(monitor.watching, true);

      // A few real ticks pass with the fake clock unmoved: still well inside
      // idleMs, so watching must not have stopped on its own.
      await wait(80);
      assert.equal(monitor.watching, true);

      // Jump the fake clock past idleMs without re-arming, the way a closed
      // Monitor window would just stop calling watch(true).
      clockOffset = 500;
      await wait(80); // give the real (tiny) interval a couple of ticks to notice

      assert.equal(monitor.watching, false);
      const status = await (await fetch(`${app.origin}/api/status`)).json();
      assert.equal(status.monitor.watching, false);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// format helpers
// ---------------------------------------------------------------------------

describe('format helpers', () => {
  test('humanBytes', () => {
    assert.equal(humanBytes(0), '0 B');
    assert.equal(humanBytes(500), '500 B');
    assert.equal(humanBytes(1536), '1.5 KB');
    assert.equal(humanBytes(3.9 * 1024 ** 3), '3.9 GB');
  });

  test('humanPercent', () => {
    assert.equal(humanPercent(42.4), '42%');
    assert.equal(humanPercent(0), '0%');
    assert.equal(humanPercent(NaN), '--');
  });
});

// ---------------------------------------------------------------------------
// tiny local helpers
// ---------------------------------------------------------------------------

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Reads whatever SSE frames arrive on `res` within `timeoutMs`, then cancels
// the stream. Good enough for a test; not a general SSE client.
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
      wait(remaining).then(() => ({ timedOut: true })),
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
        events.push({ type: typeMatch[1], data: JSON.parse(dataMatch[1]) });
      }
    }
  }
  try {
    await reader.cancel();
  } catch {
    // stream already gone
  }
  return events;
}
