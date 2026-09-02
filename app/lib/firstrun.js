// The first-run orchestrator: on a brand new stick this is what actually
// gets Scout ready to talk. It checks there is room, downloads the engine,
// the model (falling back to a smaller one if the first choice fails),
// warms up the voice, fetches the ears, double-checks every file survived
// the trip, probes for a graphics card, and starts the engine. Every step
// is reported through state() and, when a bus is given, pushed live as
// `firstrun` SSE events so the boot screen never has to poll.
//
// This file never touches the network itself. Every byte moves through the
// injected `downloads` object (app/lib/downloads.js in production, a fake
// in tests) and every engine action through the injected `engine` object
// (app/lib/engine.js). That is what makes the whole pipeline testable
// without a real USB stick or a real internet connection.
//
// Usage:
//   import { createFirstRun, wireFirstRun } from './firstrun.js';
//   const firstRun = createFirstRun({ paths, manifest, downloads, engine, bus, netlog });
//   wireFirstRun(app, { firstRun });
//   await firstRun.start();      // begins or resumes
//   await firstRun.ready;        // resolves once the engine answers ready
//
// state() always returns exactly the shape GET /api/firstrun documents:
//   { phase, steps, free, needed, gpu, message }
// phase is one of 'preflight' | 'downloading' | 'verifying' | 'probing' |
// 'starting' | 'ready' | 'blocked' | 'failed'. 'probing', 'starting' and
// 'failed' are not spelled out in API.md's short phase list, but they are
// real, reachable phases this module emits; API.md is worth a follow-up
// pass to fold them in.

import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { execFile as nodeExecFile } from 'node:child_process';
import { join } from 'node:path';

import { prepareTtsCacheEnv } from './speech/models.js';

const GIGABYTE = 1000 * 1000 * 1000; // decimal GB, matching app/web/windows/boot.js's own formatGB

const STEP_ORDER = ['node', 'engine', 'model', 'tts', 'stt'];

const STEP_LABELS = {
  node: 'Node.js',
  engine: 'The engine',
  model: 'The language model',
  tts: "Scout's voice",
  stt: "Scout's ears",
};

const SUSPECT_STICK_MESSAGE =
  'This stick seems to be losing data as more is written to it. Try a different stick.';

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

function formatGB(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '0.0';
  return (bytes / GIGABYTE).toFixed(1);
}

function blockedMessage(neededBytes, freeBytes) {
  return `This stick needs at least ${formatGB(neededBytes)} GB free, yours has ${formatGB(freeBytes)}`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function describeErr(err) {
  return (err && (err.userMessage || err.message)) || String(err);
}

function engineFileName(platform) {
  return platform === 'win32' ? 'llamafile.exe' : 'llamafile';
}

// Real tar extraction, used unless a test injects its own. `tar -xjf` is
// present on Windows 10+, macOS, and Linux, so this needs no bzip2 library.
function realExtractTar(archivePath, destDir) {
  return new Promise((resolvePromise, reject) => {
    nodeExecFile('tar', ['-xjf', archivePath, '-C', destDir], (err) => {
      if (err) reject(err);
      else resolvePromise();
    });
  });
}

function initialSteps() {
  return STEP_ORDER.map((id) => ({
    id,
    label: STEP_LABELS[id],
    state: id === 'node' ? 'done' : 'pending',
    received: null,
    total: null,
    percent: null,
    message: id === 'node' ? 'fetched by the launcher' : null,
  }));
}

// ---------------------------------------------------------------------------
// createFirstRun
// ---------------------------------------------------------------------------

export function createFirstRun({
  paths,
  manifest,
  downloads,
  engine,
  bus,
  netlog,
  platform = process.platform,
  arch = process.arch,
  log,
  warmTts,
  extractTar = realExtractTar,
  now = Date.now,
} = {}) {
  if (!paths) throw new Error('createFirstRun needs paths');
  if (!manifest) throw new Error('createFirstRun needs manifest');
  if (!downloads) throw new Error('createFirstRun needs downloads');
  if (!engine) throw new Error('createFirstRun needs engine');

  let phase = 'preflight';
  let message = null;
  let free = null;
  let needed = null;
  let gpu = null;
  const steps = initialSteps();

  let running = false;
  let stopRequested = false;
  let currentAbort = null;
  let inFlight = null;

  let modelFileUsed = null;
  let modelSpecUsed = null;

  let lastPublish = 0;

  let readyResolve;
  const readyPromise = new Promise((resolvePromise) => {
    readyResolve = resolvePromise;
  });
  function resolveReady() {
    if (readyResolve) {
      readyResolve(snapshot());
      readyResolve = null;
    }
  }

  function logLine(text) {
    try {
      log?.(text);
    } catch {
      // logging must never break the pipeline
    }
  }

  function getStep(id) {
    return steps.find((s) => s.id === id);
  }

  function snapshot() {
    return {
      phase,
      steps: steps.map((s) => ({ ...s })),
      free,
      needed,
      gpu,
      message,
    };
  }

  function publish(force) {
    if (!bus || typeof bus.publish !== 'function') return;
    const t = now();
    if (!force && t - lastPublish < 250) return;
    lastPublish = t;
    try {
      bus.publish('firstrun', snapshot());
    } catch {
      // a bad subscriber must not break the pipeline
    }
  }

  function setPhase(next, msg = null) {
    phase = next;
    message = msg;
    logLine(`firstrun: ${next}${msg ? ` (${msg})` : ''}`);
    publish(true);
  }

  // Every download's start and finish goes through here so the
  // "What Scout just did" panel always has a plain-language line for it.
  function logDownload(url, purpose) {
    const host = hostOf(url);
    if (netlog && typeof netlog.record === 'function') {
      try {
        netlog.record({ kind: 'https', host, purpose, ok: true });
      } catch {
        // netlog must never break the pipeline
      }
    }
    return {
      finish(ok, detail) {
        if (netlog && typeof netlog.record === 'function') {
          try {
            netlog.record({ kind: 'https', host, purpose, ok, detail: detail || null });
          } catch {
            // ditto
          }
        }
      },
    };
  }

  function applyProgress(step, p) {
    if (!p) return;
    if (typeof p.received === 'number') step.received = p.received;
    if (typeof p.total === 'number') step.total = p.total;
    step.percent = step.total ? Math.round((step.received / step.total) * 1000) / 10 : null;
    publish(false);
  }

  function failStep(step, err) {
    const msg = describeErr(err);
    step.state = 'failed';
    step.message = msg;
    phase = 'failed';
    message = msg;
    publish(true);
  }

  // ---- destination paths -------------------------------------------------

  function engineDestPath() {
    return join(paths.bin, engineFileName(platform));
  }

  function modelDestPath(spec) {
    return join(paths.models, spec.file);
  }

  function sttEntry() {
    const stt = manifest.stt || {};
    const id = stt.default;
    return id ? stt[id] : null;
  }

  function sttDestDir() {
    const entry = sttEntry();
    return entry ? join(paths.voices, entry.dir) : null;
  }

  function downloadStatePath() {
    return join(paths.state, 'download-manifest.json');
  }

  // ---- preflight -----------------------------------------------------

  function computeNeeded() {
    const assets = [];
    assets.push({ path: engineDestPath(), size: manifest.engine.size || 0 });
    assets.push({ path: modelDestPath(manifest.model.primary), size: manifest.model.primary.size || 0 });
    const entry = sttEntry();
    if (entry && entry.size) {
      assets.push({ path: join(paths.voices, `${entry.dir}.tar.bz2`), size: entry.size });
    }
    const present = assets.filter((a) => existsSync(a.path)).map((a) => a.path);
    return downloads.bytesNeeded(assets, present);
  }

  // ---- step: engine ----------------------------------------------------

  async function doEngineStep() {
    const step = getStep('engine');
    if (step.state === 'done' || step.state === 'skipped') return;

    step.state = 'active';
    step.message = null;
    step.total = manifest.engine.size ?? null;
    step.received = 0;
    step.percent = null;
    publish(true);

    const dl = logDownload(manifest.engine.url, 'getting the AI engine');
    try {
      const result = await downloads.downloadAsset(manifest.engine, engineDestPath(), {
        onProgress: (p) => applyProgress(step, p),
        signal: currentAbort.signal,
        statePath: downloadStatePath(),
      });
      dl.finish(true, null);
      step.state = 'done';
      step.received = step.total;
      step.percent = step.total ? 100 : step.percent;
      step.message = result.skipped ? 'already on the stick' : null;
      publish(true);
    } catch (err) {
      dl.finish(false, describeErr(err));
      if (stopRequested) {
        step.state = 'pending';
        return;
      }
      failStep(step, err);
    }
  }

  // ---- step: model (primary, falling back on failure) -------------------

  async function doModelStep() {
    const step = getStep('model');
    if (step.state === 'done' || step.state === 'skipped') return;

    async function tryVariant(spec) {
      const dl = logDownload(spec.url, 'getting the model');
      try {
        const result = await downloads.downloadAsset(spec, modelDestPath(spec), {
          onProgress: (p) => applyProgress(step, p),
          signal: currentAbort.signal,
          statePath: downloadStatePath(),
        });
        dl.finish(true, null);
        modelFileUsed = spec.file;
        modelSpecUsed = spec;
        return result;
      } catch (err) {
        dl.finish(false, describeErr(err));
        throw err;
      }
    }

    step.state = 'active';
    step.message = null;
    step.total = manifest.model.primary.size ?? null;
    step.received = 0;
    step.percent = null;
    publish(true);

    try {
      const result = await tryVariant(manifest.model.primary);
      step.state = 'done';
      step.message = result.skipped ? 'already on the stick' : null;
      step.received = step.total;
      step.percent = step.total ? 100 : step.percent;
      publish(true);
    } catch (primaryErr) {
      if (stopRequested) {
        step.state = 'pending';
        return;
      }
      if (!manifest.model.fallback) {
        failStep(step, primaryErr);
        return;
      }

      step.message = 'The recommended model did not download; trying a lighter one instead.';
      step.total = manifest.model.fallback.size ?? null;
      step.received = 0;
      step.percent = null;
      publish(true);

      try {
        const result = await tryVariant(manifest.model.fallback);
        step.state = 'done';
        step.message = result.skipped
          ? 'already on the stick, using the lighter fallback model'
          : 'using the lighter fallback model';
        step.received = step.total;
        step.percent = step.total ? 100 : step.percent;
        publish(true);
      } catch (fallbackErr) {
        if (stopRequested) {
          step.state = 'pending';
          return;
        }
        failStep(step, fallbackErr);
      }
    }
  }

  // ---- step: tts (kokoro-js fetches its own model; we just warm it) -----

  async function doTtsStep() {
    const step = getStep('tts');
    if (step.state === 'done' || step.state === 'skipped') return;

    prepareTtsCacheEnv(paths);

    if (typeof warmTts !== 'function') {
      step.state = 'skipped';
      step.message = "Scout will get its voice the first time it needs to speak";
      publish(true);
      return;
    }

    step.state = 'active';
    step.message = null;
    publish(true);
    try {
      await warmTts();
      step.state = 'done';
      step.message = null;
      publish(true);
    } catch (err) {
      if (stopRequested) {
        step.state = 'pending';
        return;
      }
      failStep(step, err);
    }
  }

  // ---- step: stt (sherpa-onnx bundle, extracted with tar) ---------------

  async function doSttStep() {
    const step = getStep('stt');
    if (step.state === 'done' || step.state === 'skipped') return;

    const entry = sttEntry();
    if (!entry) {
      step.state = 'skipped';
      step.message = 'no speech-to-text bundle is pinned in the manifest';
      publish(true);
      return;
    }
    const dir = sttDestDir();

    if (existsSync(dir) && readdirSync(dir).length > 0) {
      step.state = 'done';
      step.message = 'already on the stick';
      publish(true);
      return;
    }

    step.state = 'active';
    step.message = null;
    step.total = entry.size ?? null;
    step.received = 0;
    step.percent = null;
    publish(true);

    mkdirSync(paths.voices, { recursive: true });
    const archivePath = join(paths.voices, `${entry.dir}.tar.bz2`);
    const asset = { url: entry.url, size: entry.size ?? null, sha256: entry.sha256 ?? null };
    const dl = logDownload(entry.url, "getting Scout's ears");

    try {
      await downloads.downloadAsset(asset, archivePath, {
        onProgress: (p) => applyProgress(step, p),
        signal: currentAbort.signal,
        statePath: downloadStatePath(),
      });

      step.message = 'unpacking';
      publish(true);
      await extractTar(archivePath, paths.voices);

      try {
        unlinkSync(archivePath);
      } catch {
        // a leftover archive is harmless; extraction already succeeded
      }

      if (!existsSync(dir) || readdirSync(dir).length === 0) {
        throw new Error('the archive did not contain what Scout expected');
      }

      dl.finish(true, null);
      step.state = 'done';
      step.message = null;
      step.received = step.total;
      step.percent = step.total ? 100 : step.percent;
      publish(true);
    } catch (err) {
      dl.finish(false, describeErr(err));
      if (stopRequested) {
        step.state = 'pending';
        return;
      }
      failStep(step, err);
    }
  }

  // ---- the whole pipeline, one run -----------------------------------

  async function runOnce() {
    currentAbort = new AbortController();
    stopRequested = false;
    try {
      setPhase('preflight');
      needed = computeNeeded();
      const pf = await downloads.diskFreePreflight(paths.base, needed);
      free = pf.free;
      if (!pf.ok) {
        phase = 'blocked';
        message = blockedMessage(needed, free);
        publish(true);
        return snapshot();
      }
      if (stopRequested) return snapshot();

      setPhase('downloading');
      await doEngineStep();
      if (stopRequested || getStep('engine').state === 'failed') return snapshot();

      await doModelStep();
      if (stopRequested || getStep('model').state === 'failed') return snapshot();

      await doTtsStep();
      if (stopRequested || getStep('tts').state === 'failed') return snapshot();

      await doSttStep();
      if (stopRequested || getStep('stt').state === 'failed') return snapshot();

      setPhase('verifying');
      const entries = [{ path: engineDestPath(), asset: manifest.engine }];
      if (modelFileUsed && modelSpecUsed) {
        entries.push({ path: modelDestPath(modelSpecUsed), asset: modelSpecUsed });
      }
      const rv = await downloads.reverifyAll(entries);
      if (!rv.ok) {
        phase = 'failed';
        message = SUSPECT_STICK_MESSAGE;
        const badStep = rv.path === engineDestPath() ? getStep('engine') : getStep('model');
        badStep.state = 'failed';
        badStep.message = SUSPECT_STICK_MESSAGE;
        publish(true);
        return snapshot();
      }
      if (stopRequested) return snapshot();

      setPhase('probing');
      gpu = await engine.probeGpu();
      message = gpu.available ? 'Using your graphics card' : 'Using your processor';
      publish(true);
      if (stopRequested) return snapshot();

      setPhase('starting', message);
      const modelPath = modelFileUsed ? modelDestPath(modelSpecUsed) : modelDestPath(manifest.model.primary);
      const result = await engine.start({ modelPath });
      if (result && result.state === 'ready') {
        phase = 'ready';
        message = null;
        publish(true);
        resolveReady();
      } else {
        phase = 'failed';
        message = (result && result.reason) || 'The engine could not start.';
        publish(true);
      }
      return snapshot();
    } finally {
      running = false;
      currentAbort = null;
    }
  }

  // ---- public surface -----------------------------------------------

  async function start() {
    if (running) return snapshot();
    if (phase === 'ready') return snapshot();
    running = true;
    inFlight = runOnce();
    return inFlight;
  }

  async function retry() {
    if (running) return snapshot();
    for (const s of steps) {
      if (s.state === 'failed') {
        s.state = 'pending';
        s.message = null;
        s.received = null;
        s.total = null;
        s.percent = null;
      }
    }
    if (phase === 'blocked' || phase === 'failed') {
      phase = 'preflight';
      message = null;
    }
    running = true;
    inFlight = runOnce();
    return inFlight;
  }

  async function stop() {
    stopRequested = true;
    if (currentAbort) currentAbort.abort();
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // runOnce() never rejects, but a stopped run must never take stop() down with it
      }
    }
    try {
      await engine.stop();
    } catch {
      // best effort: shutdown must proceed either way
    }
    running = false;
    return snapshot();
  }

  return {
    state: snapshot,
    start,
    retry,
    stop,
    ready: readyPromise,
  };
}

// ---------------------------------------------------------------------------
// wireFirstRun
// ---------------------------------------------------------------------------

export function wireFirstRun(app, { firstRun }) {
  app.addRoute('GET', '/api/firstrun', (req, res, ctx) => {
    ctx.sendJson(200, firstRun.state());
  });

  // Multi-gigabyte downloads run for minutes, so these two never make the
  // HTTP request wait for the whole pipeline: they kick it off and answer
  // with a snapshot right away, the same shape GET returns. Progress from
  // then on comes over the `firstrun` SSE events wireFirstRun's caller
  // subscribes to through GET /api/events.
  app.addRoute('POST', '/api/firstrun/start', (req, res, ctx) => {
    firstRun.start().catch(() => {});
    ctx.sendJson(200, firstRun.state());
  });

  app.addRoute('POST', '/api/firstrun/retry', (req, res, ctx) => {
    firstRun.retry().catch(() => {});
    ctx.sendJson(200, firstRun.state());
  });

  app.setStatus('downloads', () => firstRun.state());
  app.registerShutdown(() => firstRun.stop());

  return firstRun;
}
