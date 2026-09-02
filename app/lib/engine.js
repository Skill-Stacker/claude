// Supervises the llamafile 0.10.5 server process: probes what the shipped
// binary supports, verifies both files before every spawn, walks the local
// port range, watches /health until the model is loaded, and turns crashes
// and stuck launches into a small set of named states the UI can react to.
//
// Usage:
//   import { createEngine } from './engine.js';
//   const engine = createEngine({ paths, manifest, verify, bus });
//   const result = await engine.start({ modelPath });
//   // result.state is one of:
//   //   'starting', 'loading', 'ready',
//   //   'missing_engine', 'bad_model',
//   //   'spawn_enoent', 'silent', 'crashed', 'failed'
//   engine.status();
//   await engine.stop();
//
// Contract assumed for the injected `verify` function (implemented in
// app/lib/downloads.js by another agent, not this file):
//   async function verify(path, spec) -> { ok: boolean, reason?: string, sha256?: string }
// `spec` is a manifest entry shaped like manifest.engine or
// manifest.model.primary / manifest.model.fallback (an object carrying at
// least url, size, sha256, min_mb). `sha256` on the return value is the
// hash actually computed for the file at `path` whenever the file could be
// hashed at all, even when `ok` is false because of a mismatch, so it can
// key the flags cache below and identify which binary was probed. If this
// assumption is wrong, probeFlags() still works, it just cannot cache
// across process restarts.
//
// `log`, if given, is called as log(line: string) with human-readable
// progress notes. `bus`, if given, gets bus.publish('engine', status())
// on every state change.
//
// Windows notes (the launcher owns the shell, this file only spawns the
// path it is given): stop() shells out to `taskkill /PID <pid> /T /F`
// because child.kill('SIGTERM') does not reach a Windows process tree; the
// exe name the launcher stages is llamafile.exe, matched by
// engineBinaryPath() below via process.platform.

import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findFreePort } from './security.js';

const PORT_BASE = 8080;
const PORT_WALK = 4; // tries 8080..8084

const DEFAULT_TIMERS = {
  healthPollMs: 500,
  silentMs: 90_000,
  helpTimeoutMs: 30_000,
  killGraceMs: 5_000,
};

// ---------------------------------------------------------------------------
// Pure helpers (also exposed on the returned engine for direct testing)
// ---------------------------------------------------------------------------

export function engineBinaryPath(paths) {
  const name = process.platform === 'win32' ? 'llamafile.exe' : 'llamafile';
  return path.join(paths.bin, name);
}

export function pickModelSpec(modelPath, model) {
  const base = path.basename(String(modelPath || ''));
  if (model?.primary?.file && base === model.primary.file) return model.primary;
  if (model?.fallback?.file && base === model.fallback.file) return model.fallback;
  return model?.primary || model?.fallback || null;
}

export function buildArgs({ modelPath, port, gpu, flags = {} }) {
  const args = ['-m', modelPath, '--server', '--host', '127.0.0.1', '--port', String(port), '-ngl', '999'];
  if (gpu) args.push('--gpu', 'nvidia');
  if (flags.jinja) args.push('--jinja');
  if (flags.reasoningBudget) args.push('--reasoning-budget', '0');
  if (flags.reasoningFormat) args.push('--reasoning-format', 'none');
  if (flags.parallel) args.push('-np', '1');
  if (flags.chatTemplateKwargs) args.push('--chat-template-kwargs', JSON.stringify({ enable_thinking: false }));
  return args;
}

function runExecFile(execFile, file, args, options) {
  return new Promise((resolvePromise) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      resolvePromise({
        err: err || null,
        stdout: stdout ? String(stdout) : '',
        stderr: stderr ? String(stderr) : '',
      });
    });
  });
}

function flagsCachePath(paths) {
  return path.join(paths.state, 'engine-flags.json');
}

function readFlagsCache(paths) {
  try {
    const data = JSON.parse(readFileSync(flagsCachePath(paths), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeFlagsCache(paths, key, flags) {
  try {
    mkdirSync(paths.state, { recursive: true });
    const all = readFlagsCache(paths);
    all[key] = { ...flags, probedAt: new Date().toISOString() };
    writeFileSync(flagsCachePath(paths), JSON.stringify(all, null, 2));
  } catch {
    // Best-effort cache. A write failure here should never block startup.
  }
}

function parseHelpFlags(text) {
  return {
    jinja: /--jinja\b/.test(text),
    reasoningBudget: /--reasoning-budget\b/.test(text),
    reasoningFormat: /--reasoning-format\b/.test(text),
    parallel: /(^|\s)-np\b|--parallel\b/.test(text),
    chatTemplateKwargs: /--chat-template-kwargs\b/.test(text),
  };
}

// ---------------------------------------------------------------------------
// createEngine
// ---------------------------------------------------------------------------

export function createEngine({
  paths,
  manifest,
  verify,
  spawn = nodeSpawn,
  execFile = nodeExecFile,
  fetch = globalThis.fetch,
  log,
  bus,
  timers = {},
} = {}) {
  const T = { ...DEFAULT_TIMERS, ...timers };

  let currentState = 'idle';
  let currentReason;
  let currentGuidance;
  let currentPort = null;
  let child = null;
  let lastLines = [];
  let lastGpu = null;
  let lastFlags = null;
  let lastModelPath = null;
  let stopping = false;
  let enoentStreak = 0;
  let gpuCache = null;
  const exitListeners = [];

  function logLine(text) {
    lastLines.push(text);
    if (lastLines.length > 200) lastLines.shift();
    try { log?.(text); } catch { /* logging must never throw */ }
  }

  function status() {
    return {
      state: currentState,
      port: currentPort,
      pid: child ? child.pid : null,
      gpu: lastGpu,
      flags: lastFlags,
      guidance: currentGuidance,
      reason: currentReason,
      logs: lastLines.slice(),
    };
  }

  function setState(next, extra = {}) {
    currentState = next;
    currentReason = extra.reason;
    currentGuidance = extra.guidance;
    // Two spawn_enoent states in a row keep the streak; anything else
    // (including a fresh attempt that lands on spawn_enoent only once)
    // clears it, matching "after two repeats in a row".
    if (next !== 'spawn_enoent') enoentStreak = 0;
    if (extra.reason) logLine(`engine: ${next} (${extra.reason})`);
    else logLine(`engine: ${next}`);
    if (bus && typeof bus.publish === 'function') {
      try { bus.publish('engine', status()); } catch { /* a bad subscriber must not break the engine */ }
    }
  }

  // -- flag probing ----------------------------------------------------

  async function probeFlagsInternal(engineCheck) {
    const key = engineCheck && engineCheck.sha256 ? engineCheck.sha256 : null;
    if (key) {
      const cached = readFlagsCache(paths)[key];
      if (cached) return cached;
    }
    const binaryPath = engineBinaryPath(paths);
    const { stdout, stderr } = await runExecFile(execFile, binaryPath, ['--help'], { timeout: T.helpTimeoutMs });
    const flags = parseHelpFlags(`${stdout}\n${stderr}`);
    if (key) writeFlagsCache(paths, key, flags);
    return flags;
  }

  async function probeFlags() {
    const binaryPath = engineBinaryPath(paths);
    const engineCheck = await verify(binaryPath, manifest.engine);
    return probeFlagsInternal(engineCheck);
  }

  // -- GPU probing (cached for the life of this engine instance) -------

  async function probeGpu() {
    if (gpuCache) return gpuCache;
    const { err, stdout } = await runExecFile(execFile, 'nvidia-smi', ['-L'], { timeout: 10_000 });
    if (err && err.code === 'ENOENT') {
      gpuCache = { available: false, detail: 'nvidia-smi not installed' };
    } else if (err) {
      gpuCache = { available: false, detail: (stdout && stdout.trim()) || err.message || 'nvidia-smi failed' };
    } else {
      const gpuLines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('GPU'));
      gpuCache = gpuLines.length > 0
        ? { available: true, detail: gpuLines.join('; ') }
        : { available: false, detail: stdout.trim() || 'no GPU lines from nvidia-smi' };
    }
    return gpuCache;
  }

  // -- spawn + health wait, recursively re-entered once on a crash -----

  function spawnAndWait({ modelPath, port, gpuAvailable, flags }) {
    return new Promise((resolveAttempt) => {
      const binaryPath = engineBinaryPath(paths);
      const args = buildArgs({ modelPath, port, gpu: gpuAvailable, flags });

      let proc;
      try {
        proc = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
      } catch (err) {
        handleSpawnError(err, resolveAttempt);
        return;
      }

      child = proc;
      lastLines = [];
      let settled = false;
      let healthTimer = null;
      let silentTimer = null;

      const finishOnce = (value) => {
        if (settled) return;
        settled = true;
        if (healthTimer) clearInterval(healthTimer);
        if (silentTimer) clearTimeout(silentTimer);
        resolveAttempt(value);
      };

      const pushLines = (chunk) => {
        String(chunk).split('\n').filter(Boolean).forEach((line) => {
          lastLines.push(line);
          if (lastLines.length > 200) lastLines.shift();
        });
      };
      proc.stdout?.on('data', pushLines);
      proc.stderr?.on('data', pushLines);

      proc.once('error', (err) => {
        handleSpawnError(err, finishOnce);
      });

      proc.once('exit', (code, signal) => {
        for (const fn of exitListeners) {
          try { fn(code, signal); } catch { /* a bad listener must not break the engine */ }
        }
        const wasStopping = stopping;
        child = null;
        if (wasStopping) return; // stop() resolves its own promise
        if (healthTimer) clearInterval(healthTimer);
        if (silentTimer) clearTimeout(silentTimer);

        if (settled) {
          // The process died after this attempt already succeeded
          // (ready) or gave up (silent): report it, but there is no
          // pending promise left to resolve.
          setState('crashed', { reason: `engine exited with code ${code}` });
          return;
        }

        if (!crashRestarted) {
          crashRestarted = true;
          setState('crashed', { reason: `engine exited with code ${code}, restarting once` });
          spawnAndWait({ modelPath, port, gpuAvailable, flags }).then(finishOnce);
        } else {
          setState('failed', {
            reason: `engine exited with code ${code} after one restart; an instant exit usually means a damaged model`,
          });
          finishOnce(status());
        }
      });

      let elapsed = 0;
      healthTimer = setInterval(async () => {
        if (settled) return;
        elapsed += T.healthPollMs;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          let body = null;
          try { body = await res.json(); } catch { /* non-JSON or empty body */ }
          const statusText = body && body.status;
          if (res.status === 200 && statusText === 'ok') {
            setState('ready', {});
            finishOnce(status());
            return;
          }
          if (currentState !== 'loading' && (statusText === 'loading model' || res.status === 503)) {
            setState('loading', {});
          }
        } catch {
          // Not listening yet (or a permission dialog is blocking the
          // bind); keep polling until the silent timer decides.
        }
      }, T.healthPollMs);

      silentTimer = setTimeout(() => {
        if (settled) return;
        setState('silent', { reason: 'no health response within timeout', guidance: 'smartscreen' });
        finishOnce(status());
      }, T.silentMs);

      function handleSpawnError(err, resolveFn) {
        child = null;
        if (err && err.code === 'ENOENT') {
          enoentStreak += 1;
          const guidance = enoentStreak >= 2 ? 'defender' : undefined;
          setState('spawn_enoent', { reason: 'engine binary vanished before spawn', guidance });
        } else {
          setState('failed', { reason: (err && err.message) || 'spawn error' });
        }
        resolveFn(status());
      }
    });
  }

  let crashRestarted = false;

  async function start({ modelPath }) {
    lastModelPath = modelPath;
    stopping = false;
    crashRestarted = false;
    setState('starting', {});

    const binaryPath = engineBinaryPath(paths);
    const engineCheck = await verify(binaryPath, manifest.engine);
    if (!engineCheck.ok) {
      setState('missing_engine', { reason: engineCheck.reason });
      return status();
    }

    const modelSpec = pickModelSpec(modelPath, manifest.model);
    const modelCheck = await verify(modelPath, modelSpec);
    if (!modelCheck.ok) {
      setState('bad_model', { reason: modelCheck.reason });
      return status();
    }

    const [flags, gpu] = await Promise.all([probeFlagsInternal(engineCheck), probeGpu()]);
    lastFlags = flags;
    lastGpu = gpu;

    let port;
    try {
      port = await findFreePort(PORT_BASE, PORT_WALK);
    } catch {
      setState('failed', { reason: `no free port between ${PORT_BASE} and ${PORT_BASE + PORT_WALK}` });
      return status();
    }
    currentPort = port;

    return spawnAndWait({ modelPath, port, gpuAvailable: gpu.available, flags });
  }

  async function stop() {
    if (!child) {
      if (currentState !== 'idle') setState('stopped', {});
      return status();
    }
    stopping = true;
    const proc = child;
    const exited = new Promise((resolvePromise) => proc.once('exit', () => resolvePromise()));

    if (process.platform === 'win32') {
      await new Promise((resolvePromise) => {
        execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => resolvePromise());
      });
      await exited;
    } else {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      }, T.killGraceMs);
      await exited;
      clearTimeout(killTimer);
    }

    child = null;
    setState('stopped', {});
    return status();
  }

  async function restart() {
    await stop();
    return start({ modelPath: lastModelPath });
  }

  function baseUrl() {
    if (!currentPort) return null;
    return `http://127.0.0.1:${currentPort}`;
  }

  function onExit(fn) {
    exitListeners.push(fn);
    return () => {
      const i = exitListeners.indexOf(fn);
      if (i >= 0) exitListeners.splice(i, 1);
    };
  }

  return {
    probeFlags,
    probeGpu,
    buildArgs,
    start,
    status,
    stop,
    restart,
    baseUrl,
    onExit,
    get port() { return currentPort; },
  };
}

// Re-exported so app bootstrap code (outside this file) can size and
// pre-create state/ before an engine ever runs, same pattern as paths.js.
export function ensureEngineStateDir(paths) {
  if (!existsSync(paths.state)) mkdirSync(paths.state, { recursive: true });
}
