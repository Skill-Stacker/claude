// Composition root. app/server.js starts the loopback HTTP server and then calls
// wire(app) from this file, which opens the database and wires every feature
// module onto it: engine and llm, first run, profiles, voice, brain, Google
// connectors, monitor, model manager. Each module is imported dynamically and
// guarded so one missing or broken module never keeps the server from
// serving the page; the status route lists what did not load.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

async function tryImport(spec, missing) {
  try {
    return await import(spec);
  } catch (err) {
    missing.push({ module: spec, error: String((err && err.message) || err) });
    return null;
  }
}

function readSettings(paths) {
  const file = join(paths.base, 'settings.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export async function wire(app) {
  const { paths, bus, netlog } = app;
  const missing = [];
  const log = (...args) => console.log('[boot]', ...args);
  const manifest = JSON.parse(readFileSync(join(paths.app, 'manifest.json'), 'utf8'));
  const settings = readSettings(paths);
  app.setStatus('boot', () => ({ missing }));

  // Database and profiles are the ground everything else stands on.
  const { openDb } = await import('./lib/db.js');
  const db = openDb(join(paths.data, 'scout.sqlite'));
  app.db = db;
  app.registerShutdown(() => db.close());

  const profiles = await tryImport('./lib/profiles.js', missing);
  const lockManager = profiles ? profiles.createLockManager({}) : null;
  const profileRoutes = await tryImport('./lib/profile-routes.js', missing);
  if (profileRoutes && lockManager) {
    profileRoutes.wireProfiles(app, { db, paths, lockManager, bus });
  }

  // Network and downloads, with the state file kept on the stick.
  const net = await tryImport('./lib/net.js', missing);
  const dl = await tryImport('./lib/downloads.js', missing);
  const statePath = join(paths.state, 'download-manifest.json');
  const downloads = dl
    ? {
        ...dl,
        downloadAsset: (asset, dest, opts = {}) => dl.downloadAsset(asset, dest, { statePath, ...opts }),
      }
    : null;
  // calendar.fetchIcs expects { status, text } for a completed request and a
  // thrown error with code 'timeout' for a timeout. net.request throws on
  // non-2xx, so map that back into a status the calendar module can read.
  const fetchText = net
    ? async (url, { timeoutMs = 5000 } = {}) => {
        try {
          const res = await net.request(url, { timeoutMs });
          const chunks = [];
          for await (const c of res.stream) chunks.push(c);
          return { status: res.status, text: Buffer.concat(chunks).toString('utf8') };
        } catch (err) {
          if (err && err.kind === 'http' && typeof err.status === 'number') return { status: err.status, text: '' };
          if (err && err.kind === 'timeout') err.code = 'timeout';
          throw err;
        }
      }
    : undefined;

  // Engine and llm client.
  const engineMod = await tryImport('./lib/engine.js', missing);
  const llmMod = await tryImport('./lib/llm.js', missing);
  let engine = null;
  let llm = null;
  // Dev mode: STICKOS_FAKE_ENGINE=1 runs tools/fake-engine.mjs in place of
  // llamafile and skips every download, so the page and the dispatch can be
  // exercised on a machine with no model. Never set by the launchers.
  const fakeEngine = !!process.env.STICKOS_FAKE_ENGINE;
  if (engineMod && (downloads || fakeEngine)) {
    const fakePath = join(paths.app, '..', 'tools', 'fake-engine.mjs');
    const cp = fakeEngine ? await import('node:child_process') : null;
    engine = engineMod.createEngine({
      paths,
      manifest,
      verify: fakeEngine ? async () => ({ ok: true, sha256: 'fake' }) : (path, spec) => downloads.verifyAsset(path, spec),
      spawn: fakeEngine ? (cmd, args, opts) => cp.spawn(process.execPath, [fakePath, ...args], opts) : undefined,
      execFile: fakeEngine
        ? (cmd, args, opts, cb) => cp.execFile(process.execPath, [fakePath, ...(args || [])], opts, cb)
        : undefined,
      bus,
      log,
    });
    app.registerShutdown(() => engine.stop());
    app.setStatus('engine', () => engine.status());
    if (llmMod) {
      llm = {
        // llm is created lazily once the engine has a port; brain calls llm.current().
        current: () => (engine.baseUrl() ? llmMod.createLlm({ baseUrl: engine.baseUrl() }) : null),
      };
    }
  }

  // Speech.
  const sttMod = await tryImport('./lib/speech/stt.js', missing);
  const ttsMod = await tryImport('./lib/speech/tts.js', missing);
  const voiceRoutes = await tryImport('./lib/speech/voice-routes.js', missing);
  const scrub = await tryImport('./lib/speech/scrub.js', missing);
  let stt = null;
  let tts = null;
  if (sttMod && ttsMod && voiceRoutes) {
    stt = sttMod.createStt({ paths, engineId: settings.stt || manifest.stt.default, log });
    tts = ttsMod.createTts({ paths, voice: settings.voice || manifest.tts.voice, scrub, log });
    voiceRoutes.wireVoice(app, { stt, tts, db });
  }

  // First run: downloads, verification, GPU probe, engine start, voice warm-up.
  const firstRunMod = await tryImport('./lib/firstrun.js', missing);
  let firstRun = null;
  if (fakeEngine && engine) {
    log('dev mode: fake engine, no downloads');
    engine.start({ modelPath: join(paths.models, 'fake.gguf') }).catch((err) => log('fake engine failed:', err.message));
  } else if (firstRunMod && downloads && engine) {
    firstRun = firstRunMod.createFirstRun({
      paths,
      manifest,
      downloads,
      engine,
      bus,
      netlog,
      log,
      warmTts: tts ? () => tts.load() : null,
      warmStt: stt ? () => stt.load() : null,
    });
    firstRunMod.wireFirstRun(app, { firstRun });
    app.registerShutdown(() => firstRun.stop());
  }

  // Google connectors and sync.
  const calendar = await tryImport('./lib/google/calendar.js', missing);
  const gmail = await tryImport('./lib/google/gmail.js', missing);
  const contacts = await tryImport('./lib/google/contacts.js', missing);
  const syncMod = await tryImport('./lib/google/sync.js', missing);
  const googleRoutes = await tryImport('./lib/google/routes.js', missing);
  let sync = null;
  if (syncMod && googleRoutes && lockManager) {
    sync = syncMod.createSync({ db, paths, bus, netlog, fetchText });
    googleRoutes.wireGoogle(app, { db, paths, lockManager, sync, fetchText });
    app.registerShutdown(() => sync.stop());
    sync.start();
  }

  // Brain: dispatch, intents, chat routes.
  const dates = await tryImport('./lib/dates.js', missing);
  const memory = await tryImport('./lib/memory.js', missing);
  const chatRoutes = await tryImport('./lib/chat-routes.js', missing);
  if (chatRoutes && llm && lockManager) {
    chatRoutes.wireChat(app, {
      db,
      paths,
      llm,
      engine,
      calendar,
      gmail,
      gmailSession: sync ? (profileId) => sync.createGmailSession(profileId) : null,
      contacts,
      dates,
      scrub,
      memory,
      profiles,
      lockManager,
      verifyPin: (profileId, pin) => profiles.verifyPin(db, profileId, pin, {}),
      settings,
      tts,
    });
  }

  // Studio: monitor and model manager.
  const monitorMod = await tryImport('./lib/monitor.js', missing);
  if (monitorMod) {
    const monitor = monitorMod.createMonitor({ paths, bus });
    monitorMod.wireMonitor(app, { monitor });
  }
  const modelsMod = await tryImport('./lib/studio/models.js', missing);
  if (modelsMod && downloads && engine) {
    const models = modelsMod.createModelManager({ paths, manifest, downloads, engine, bus, db });
    modelsMod.wireModels(app, { models });
  }

  // Studio: make a picture (sd.cpp) and video tools (ffmpeg). Both spawn their
  // helpers on demand and reap them when idle.
  const imagesMod = await tryImport('./lib/studio/images.js', missing);
  if (imagesMod && downloads) {
    const images = imagesMod.createImages({ paths, manifest, downloads, bus, netlog });
    imagesMod.wireImages(app, { images });
    if (typeof images.stop === 'function') app.registerShutdown(() => images.stop());
  }
  const videoMod = await tryImport('./lib/studio/video.js', missing);
  if (videoMod && downloads) {
    const video = videoMod.createVideoTools({ paths, manifest, downloads, stt, bus, netlog });
    videoMod.wireVideo(app, { video });
    if (typeof video.stop === 'function') app.registerShutdown(() => video.stop());
  }

  // Kick off first run (downloads, then the engine) without blocking the page.
  if (firstRun) {
    firstRun.start().catch((err) => log('first run failed:', (err && err.message) || err));
  }

  if (missing.length) log('modules not loaded:', missing.map((m) => `${m.module} (${m.error})`).join('; '));
  return { db, engine, llm, stt, tts, firstRun, sync, lockManager, missing };
}
