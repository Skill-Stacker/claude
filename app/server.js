// The StickOS app server: binds 127.0.0.1 only, serves the single-page UI,
// hosts the SSE state bus and the mic WebSocket, and is the only thing the
// browser talks to. Everything else (the engine, the voice loop, the Google
// connectors) is wired in at later milestones through the hook points
// marked below; this file never imports those modules.
//
// Usage (tests):
//   import { startServer } from '../app/server.js';
//   const app = await startServer({ baseDir: someTmpDir, port: 47350 });
//   // app.server, app.port, app.token, app.bus, app.netlog, app.close()
//   // app.registerShutdown(fn), app.onMicConnection(fn) -- hook points
//   await app.close();
//
// Run directly: `node app/server.js` (or `npm start`) prints
// `READY http://127.0.0.1:<port>/` once listening, or
// `ALREADY_RUNNING http://127.0.0.1:<port>/` and exits 0 if another
// instance already answers on its recorded port.

import { createServer as createHttpServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolvePaths, ensureDirs } from './lib/paths.js';
import {
  APP_PORT,
  PORT_WALK,
  newToken,
  requireToken,
  tokenFromFirstFrame,
  originAllowed,
  hostAllowed,
  safeJoin,
  findFreePort,
} from './lib/security.js';
import { createBus } from './lib/bus.js';
import { createNetlog } from './lib/netlog.js';
import { attachWebSocket } from './lib/ws.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

const BODY_LIMIT = 1024 * 1024; // 1 MB, matches the mic frame's maxPayload

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// manifest.json pins third-party asset versions (node, llamafile, the
// model); it does not currently carry a top-level app version, so this
// falls back to package.json's version, which is the real source of truth
// for the app itself. Reading manifest.json first means it wins if a later
// milestone ever adds a top-level "version" key there.
function loadVersion(paths) {
  try {
    const manifest = JSON.parse(readFileSync(join(paths.app, 'manifest.json'), 'utf8'));
    if (typeof manifest.version === 'string') return manifest.version;
  } catch {
    // manifest.json missing or unreadable: fall through to package.json
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(paths.app), 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string') return pkg.version;
  } catch {
    // neither file gave a version
  }
  return '0.0.0-unknown';
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Single-instance check: a previous run's state/port.json names a port; if
// something on that port answers /api/status as this same app and version,
// that is the running instance, and this launch should hand off to it
// rather than binding a second one.
async function detectAlreadyRunning(paths, version) {
  const portFile = join(paths.state, 'port.json');
  if (!existsSync(portFile)) return null;
  let info;
  try {
    info = JSON.parse(readFileSync(portFile, 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(info?.port)) return null;
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${info.port}/api/status`, 1000);
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.app === 'stickos' && body?.version === version) {
      return { port: info.port };
    }
  } catch {
    // no answer, wrong app, or a timeout: treat the recorded port as stale
  }
  return null;
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': data.length,
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

export async function startServer({ baseDir, port: portOverride } = {}) {
  const paths = resolvePaths(baseDir);
  ensureDirs(paths);
  const version = loadVersion(paths);
  const startedAt = Date.now();

  const already = await detectAlreadyRunning(paths, version);
  if (already) {
    return { alreadyRunning: true, port: already.port, url: `http://127.0.0.1:${already.port}/` };
  }

  const token = newToken();
  const bus = createBus();
  const netlog = createNetlog(bus);
  const port = portOverride ?? (await findFreePort(APP_PORT, PORT_WALK));
  const origin = `http://127.0.0.1:${port}`;

  // -- hook points for later milestones ----------------------------------
  // engine.js (M2) and the voice agent (M5) live outside this file's owner
  // and are never imported here. Whoever wires them in calls these once the
  // server is up.

  const shutdownHooks = [];
  function registerShutdown(fn) {
    if (typeof fn === 'function') shutdownHooks.push(fn);
  }

  // Placeholder mic handler: echoes each binary frame's byte count back as
  // `{ "bytes": n }` text, just enough to prove the WebSocket path works
  // end to end. The voice agent milestone replaces it by calling
  // onMicConnection(realHandler) before any browser connects.
  function defaultMicHandler(conn) {
    conn.on('message', (data, isBinary) => {
      if (isBinary) conn.send(JSON.stringify({ bytes: data.length }));
    });
  }
  let micHandler = defaultMicHandler;
  function onMicConnection(handler) {
    micHandler = typeof handler === 'function' ? handler : defaultMicHandler;
  }

  // -- route registry and status providers --------------------------------
  // Feature modules (brain, voice, connectors, studio) register their routes
  // from their own files through app.addRoute(); app/boot.js wires them. The
  // built-in routes below stay in this file. Handlers get (req, res, ctx).
  const routes = [];
  function addRoute(method, path, handler, { prefix = false } = {}) {
    if (typeof handler !== 'function') throw new Error('addRoute needs a handler');
    routes.push({ method: (method || 'GET').toUpperCase(), path, handler, prefix });
  }
  const statusProviders = new Map();
  function setStatus(name, fn) {
    if (typeof fn === 'function') statusProviders.set(name, fn);
  }
  function collectStatus() {
    const out = {};
    for (const [name, fn] of statusProviders) {
      try {
        out[name] = fn();
      } catch (err) {
        out[name] = { error: String((err && err.message) || err) };
      }
    }
    return out;
  }
  let api = null; // the object startServer() returns; handlers reach shared state through ctx.app
  function makeCtx(req, res, pathname) {
    return {
      app: api,
      pathname,
      query: new URL(req.url || '/', origin).searchParams,
      token,
      bus,
      netlog,
      paths,
      origin,
      async readJson(limit = BODY_LIMIT) {
        const raw = await readBody(req, limit);
        if (!raw.length) return null;
        return JSON.parse(raw.toString('utf8'));
      },
      sendJson: (status, body) => sendJson(res, status, body),
      sseStart() {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': open\n\n');
        return {
          send(type, data) {
            if (res.writableEnded || res.destroyed) return false;
            res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
            return true;
          },
          end() {
            if (!res.writableEnded) res.end();
          },
          get closed() {
            return res.writableEnded || res.destroyed;
          },
        };
      },
    };
  }

  // -- request handling ---------------------------------------------------

  function guardCommon(req, res) {
    if (!hostAllowed(req, port)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'bad host' });
      return false;
    }
    if (!originAllowed(req, origin)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'bad origin' });
      return false;
    }
    return true;
  }

  function serveIndex(req, res) {
    let html;
    try {
      html = readFileSync(join(paths.web, 'index.html'), 'utf8');
    } catch {
      return sendJson(res, 500, { error: 'index missing' });
    }
    const body = html.split('__STICKOS_TOKEN__').join(token).split('__STICKOS_ORIGIN__').join(origin);
    const data = Buffer.from(body, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': data.length,
    });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  }

  function serveStatic(req, res, pathname) {
    const filePath = safeJoin(paths.web, pathname);
    if (!filePath) return sendJson(res, 404, { error: 'not found' });
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return sendJson(res, 404, { error: 'not found' });
    }
    if (!stat.isFile()) return sendJson(res, 404, { error: 'not found' });

    let data;
    try {
      data = readFileSync(filePath);
    } catch {
      return sendJson(res, 404, { error: 'not found' });
    }
    const ext = extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': data.length,
    };
    if (ext === '.html') headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  }

  async function handleRequest(req, res) {
    if (!guardCommon(req, res)) return;

    const method = req.method || 'GET';
    const pathname = (req.url || '/').split('?')[0];

    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // Every non-GET route requires the per-launch token.
    if (method === 'POST' && !requireToken(req, token)) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    for (const r of routes) {
      if (r.method !== 'ANY' && r.method !== method) continue;
      if (r.prefix ? !pathname.startsWith(r.path) : pathname !== r.path) continue;
      try {
        await r.handler(req, res, makeCtx(req, res, pathname));
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, err && err.statusCode ? err.statusCode : 500, {
            error: 'internal',
            message: String((err && err.message) || err),
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    if (pathname === '/' && method !== 'POST') {
      return serveIndex(req, res);
    }

    if (pathname === '/api/status' && method === 'GET') {
      return sendJson(res, 200, {
        app: 'stickos',
        version,
        port,
        pid: process.pid,
        uptime: (Date.now() - startedAt) / 1000,
        engine: null,
        voice: null,
        ...collectStatus(), // engine, voice, downloads, profile: filled by modules via setStatus
      });
    }

    if (pathname === '/api/events' && method === 'GET') {
      return bus.subscribe(res);
    }

    if (pathname === '/api/netlog' && method === 'GET') {
      return sendJson(res, 200, { entries: netlog.list(), description: netlog.description });
    }

    if (pathname === '/api/echo' && method === 'POST') {
      let raw;
      try {
        raw = await readBody(req, BODY_LIMIT);
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: 'bad request' });
      }
      let parsed = null;
      try {
        parsed = raw.length ? JSON.parse(raw.toString('utf8')) : null;
      } catch {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      return sendJson(res, 200, { echo: parsed });
    }

    if (method === 'GET' || method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  const server = createHttpServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal error', detail: err && err.message ? err.message : String(err) });
      } else {
        res.end();
      }
    });
  });

  const wsHandle = attachWebSocket(server, {
    path: '/ws/mic',
    maxPayload: BODY_LIMIT,
    verifyClient: (req) => hostAllowed(req, port) && originAllowed(req, origin),
    authenticate: (firstFrameText) => tokenFromFirstFrame(firstFrameText, token),
    onConnection: (conn, connReq) => micHandler(conn, connReq),
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });

  const portJsonPath = join(paths.state, 'port.json');
  const portTxtPath = join(paths.state, 'port.txt');
  writeFileSync(portJsonPath, JSON.stringify({ port, pid: process.pid, startedUtc: new Date().toISOString() }, null, 2));
  // Plain digits, no JSON: the Windows batch launcher reads this with
  // `set /p` because parsing JSON in cmd.exe is fragile.
  writeFileSync(portTxtPath, String(port));

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    bus.close();
    wsHandle.close();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    for (const file of [portJsonPath, portTxtPath]) {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    }
    for (const hook of shutdownHooks) {
      try {
        await hook();
      } catch {
        // a hook failing must never block shutdown
      }
    }
  }

  api = {
    server,
    port,
    token,
    bus,
    netlog,
    close,
    registerShutdown,
    onMicConnection,
    addRoute,
    setStatus,
    collectStatus,
    alreadyRunning: false,
    paths,
    origin,
    version,
  };
  return api;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function main() {
  const app = await startServer();

  if (app.alreadyRunning) {
    console.log(`ALREADY_RUNNING ${app.url}`);
    process.exit(0);
    return;
  }

  // app/boot.js is the composition root: it opens the database and wires the
  // engine, brain, voice, connectors and studio modules onto this server.
  // The server runs without it (tests, early milestones).
  try {
    const boot = await import('./boot.js');
    if (typeof boot.wire === 'function') await boot.wire(app);
  } catch (err) {
    const missing = err && err.code === 'ERR_MODULE_NOT_FOUND' && /boot\.js/.test(String(err.message));
    if (!missing) throw err;
  }

  console.log(`READY http://127.0.0.1:${app.port}/`);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
