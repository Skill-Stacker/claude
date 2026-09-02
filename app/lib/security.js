// Security primitives shared by the app server: the per-launch token, the
// origin and Host guards, path containment for static files, and a real
// bind-based free-port finder. Nothing here trusts an HTTP response as proof
// a port is free, and nothing here treats "no Origin header" as suspicious
// (same-origin fetches and curl both omit it).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';

export const APP_PORT = 47300;
export const PORT_WALK = 4;

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export function newToken() {
  return randomBytes(32).toString('hex');
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Every mutating HTTP route requires this header.
export function requireToken(req, token) {
  const header = req.headers['x-stickos-token'];
  if (Array.isArray(header)) return false;
  return constantTimeEqual(header, token);
}

// The WebSocket first frame carries the token as JSON instead of a header,
// since the browser WebSocket API cannot set custom headers.
export function tokenFromFirstFrame(text, token) {
  if (typeof text !== 'string') return false;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed.token !== 'string') return false;
  return constantTimeEqual(parsed.token, token);
}

// ---------------------------------------------------------------------------
// Origin and Host guards
// ---------------------------------------------------------------------------

// Same-origin fetches from the page, and tools like curl, send no Origin
// header at all; that is allowed. A cross-origin browser request always
// carries one, and it must match our own origin exactly.
export function originAllowed(req, ourOrigin) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return origin === ourOrigin;
}

// DNS rebinding guard: a page served from an attacker-controlled domain that
// resolves to 127.0.0.1 would still carry that attacker's Origin header, so
// the Origin check above is not enough on its own; the Host header the
// browser actually connected to must also name this machine and this port.
export function hostAllowed(req, port) {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  const lower = host.toLowerCase();
  return lower === `127.0.0.1:${port}` || lower === `localhost:${port}`;
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

// Returns an absolute path inside `root`, or null if `urlPath` cannot be
// safely mapped there. Decodes percent-escapes, strips query/hash, rejects
// null bytes and any '..' segment (checked before normalization, since
// normalizing a leading '/../' silently eats it instead of surfacing it),
// and rejects protocol-relative or UNC-looking paths ('//host/share') so a
// doubled leading slash can never be read as "absolute, escape the root".
export function safeJoin(root, urlPath) {
  if (typeof urlPath !== 'string') return null;

  const withoutQuery = urlPath.split('?')[0].split('#')[0];
  let pathname;
  try {
    pathname = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }

  if (pathname.includes('\0')) return null;
  if (/^\/{2,}/.test(pathname)) return null; // //host/share style absolute path
  if (/^[a-zA-Z]:[\\/]/.test(pathname)) return null; // C:\ style absolute path
  if (pathname.split(/[\\/]/).includes('..')) return null;

  const relative = pathname.replace(/^[\\/]+/, '');
  if (path.isAbsolute(relative)) return null;

  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, relative);
  const withSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (resolved !== rootResolved && !resolved.startsWith(withSep)) return null;

  return resolved;
}

// ---------------------------------------------------------------------------
// Free port
// ---------------------------------------------------------------------------

function tryBind(port) {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolvePromise(false);
      } else {
        reject(err);
      }
    });
    probe.once('listening', () => {
      probe.close(() => resolvePromise(true));
    });
    probe.listen(port, '127.0.0.1');
  });
}

// Walks preferred, preferred + 1, ... preferred + walk, actually binding
// each candidate rather than probing with an HTTP request. The first port
// that binds wins; EADDRINUSE moves to the next candidate, any other bind
// error throws immediately.
export async function findFreePort(preferred, walk = PORT_WALK) {
  for (let port = preferred; port <= preferred + walk; port++) {
    // eslint-disable-next-line no-await-in-loop
    const bound = await tryBind(port);
    if (bound) return port;
  }
  throw new Error(`No free port found between ${preferred} and ${preferred + walk}`);
}
