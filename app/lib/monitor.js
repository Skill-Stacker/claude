// Studio's live system monitor: CPU, RAM, disk and GPU numbers, honest and
// with no native dependencies. Everything here is read from os/, /proc, or a
// shelled-out `nvidia-smi`, never guessed. A failed or missing GPU read
// returns null (or, on a Mac, an "unavailable" note); nothing here throws
// into the caller.
//
// Usage:
//   import { createMonitor, wireMonitor } from './monitor.js';
//   const monitor = createMonitor({ paths, bus });
//   wireMonitor(app, { monitor });
//   const snapshot = await monitor.sample();
//   monitor.watch(true);  // starts publishing 'monitor' events on the bus
//   monitor.watch(false); // or just stop re-arming; it times out on its own

import { execFile as nodeExecFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { statfs as statfsAsync } from 'node:fs/promises';
import os from 'node:os';

const IDLE_STOP_MS = 30_000; // no re-arm within this long and watch() gives up

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function round1(n) {
  return Math.round(n * 10) / 10;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

// Diffs os.cpus() tick totals between calls, so the module keeps the last
// sample it saw. The first call after the process starts (or after cpu
// counts change in a way that makes the diff meaningless) has nothing to
// diff against, so it reports percent: null rather than guessing.
let previousCpuTotals = null;

export function sampleCpu() {
  const cpus = os.cpus();
  let idleSum = 0;
  let totalSum = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idleSum += t.idle;
    totalSum += t.user + t.nice + t.sys + t.idle + t.irq;
  }

  const previous = previousCpuTotals;
  previousCpuTotals = { idle: idleSum, total: totalSum };

  const out = { percent: null, cores: cpus.length };
  // os.loadavg() reads 0,0,0 on Windows, so it is never the primary number;
  // it only rides along as an extra on POSIX, where it means something.
  if (process.platform !== 'win32') out.load = os.loadavg();

  if (!previous) return out;

  const idleDelta = idleSum - previous.idle;
  const totalDelta = totalSum - previous.total;
  out.percent = totalDelta > 0 ? round1(clamp(100 * (1 - idleDelta / totalDelta), 0, 100)) : 0;
  return out;
}

// ---------------------------------------------------------------------------
// RAM
// ---------------------------------------------------------------------------

function readMemAvailableLinux() {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const match = text.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!match) return null;
    return Number(match[1]) * 1024;
  } catch {
    return null; // /proc/meminfo missing or unreadable: fall back to freemem
  }
}

export function sampleRam() {
  const total = os.totalmem();
  // os.freemem() only counts fully-free pages, so on Linux it undercounts
  // (it ignores reclaimable cache); /proc/meminfo's MemAvailable is the
  // number that actually answers "how much could a new program use".
  const free = (process.platform === 'linux' && readMemAvailableLinux()) || os.freemem();
  const used = Math.max(0, total - free);
  return { used, total, percent: total > 0 ? round1((used / total) * 100) : 0 };
}

// ---------------------------------------------------------------------------
// Disk (the stick)
// ---------------------------------------------------------------------------

export async function sampleDisk(dir) {
  const stats = await statfsAsync(dir);
  // bavail (blocks available to an unprivileged writer), not bfree, matches
  // what a person means by "free space" and what `df -h` shows them.
  return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
}

// ---------------------------------------------------------------------------
// GPU (optional, never required, never throws)
// ---------------------------------------------------------------------------

const NVIDIA_SMI_ARGS = [
  '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
  '--format=csv,noheader,nounits',
];

export function sampleGpu({ execFile = nodeExecFile } = {}) {
  if (process.platform === 'darwin') {
    return Promise.resolve({ unavailable: true, reason: 'not available on this Mac without extra permission' });
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    try {
      execFile('nvidia-smi', NVIDIA_SMI_ARGS, { timeout: 3000 }, (err, stdout) => {
        if (err) return finish(null); // no card, no driver, timed out: all the same to the UI
        finish(parseNvidiaSmiLine(String(stdout || '')));
      });
    } catch {
      finish(null); // a synchronous throw from execFile itself (bad platform, etc.)
    }
  });
}

function parseNvidiaSmiLine(stdout) {
  const line = stdout.split('\n').map((s) => s.trim()).find(Boolean);
  if (!line) return null;
  const parts = line.split(',').map((s) => s.trim());
  if (parts.length < 5) return null;
  const [name, util, memUsed, memTotal, temp] = parts;
  const utilNum = Number(util);
  const memUsedNum = Number(memUsed);
  const memTotalNum = Number(memTotal);
  const tempNum = Number(temp);
  if (!name || !Number.isFinite(utilNum) || !Number.isFinite(memUsedNum) || !Number.isFinite(memTotalNum)) {
    return null;
  }
  const MIB = 1024 * 1024;
  return {
    name,
    util: utilNum,
    vram: { used: memUsedNum * MIB, total: memTotalNum * MIB },
    temp: Number.isFinite(tempNum) ? tempNum : null,
  };
}

// ---------------------------------------------------------------------------
// createMonitor
// ---------------------------------------------------------------------------

// `now` and `idleMs` are extra, optional knobs beyond the four the UI cares
// about; they default to the real clock and the real 30s rule and exist so
// tests can prove the auto-stop without an actual 30 second wait.
export function createMonitor({ paths, execFile = nodeExecFile, bus, intervalMs = 2000, now = Date.now, idleMs = IDLE_STOP_MS } = {}) {
  if (!paths || !paths.base) throw new Error('createMonitor needs paths.base');

  let watching = false;
  let timer = null;
  let lastArmedAt = 0;
  let ticking = false; // guards against an overlapping tick if a sample runs long

  async function sample() {
    const cpu = sampleCpu();
    const ram = sampleRam();
    const [disk, gpu] = await Promise.all([sampleDisk(paths.base), sampleGpu({ execFile })]);
    return { cpu, ram, disk, gpu, at: new Date(now()).toISOString() };
  }

  async function tick() {
    if (now() - lastArmedAt > idleMs) {
      stop();
      return;
    }
    if (ticking) return;
    ticking = true;
    try {
      const snapshot = await sample();
      if (bus) bus.publish('monitor', snapshot);
    } catch {
      // a bad sample must never take the timer down with it
    } finally {
      ticking = false;
    }
  }

  function watch(on) {
    if (on) {
      lastArmedAt = now();
      watching = true;
      if (!timer) {
        timer = setInterval(tick, intervalMs);
        timer.unref?.();
      }
    } else {
      stop();
    }
    return watching;
  }

  function stop() {
    watching = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    sample,
    watch,
    stop,
    get watching() {
      return watching;
    },
  };
}

// ---------------------------------------------------------------------------
// wireMonitor
// ---------------------------------------------------------------------------

export function wireMonitor(app, { monitor }) {
  app.addRoute('GET', '/api/monitor', async (req, res, ctx) => {
    const snapshot = await monitor.sample();
    ctx.sendJson(200, snapshot);
  });

  app.addRoute('POST', '/api/monitor/watch', async (req, res, ctx) => {
    let body = null;
    try {
      body = await ctx.readJson();
    } catch {
      return ctx.sendJson(400, { error: 'invalid json' });
    }
    monitor.watch(Boolean(body && body.on));
    ctx.sendJson(200, { watching: monitor.watching });
  });

  app.setStatus('monitor', () => ({ watching: monitor.watching }));
  app.registerShutdown(() => monitor.stop());

  return monitor;
}

// ---------------------------------------------------------------------------
// UI format helpers
// ---------------------------------------------------------------------------

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unit]}`;
}

export function humanPercent(x) {
  if (!Number.isFinite(x)) return '--';
  return `${Math.round(x)}%`;
}
