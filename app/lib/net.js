// Outbound HTTPS for a beginner's laptop that may sit behind a corporate proxy.
// Node's global fetch ignores proxy environment variables, so requests are
// built by hand on node:http, node:https and node:tls.
//
// Usage:
//   import * as net from './net.js';
//   const res = await net.request('https://example.com/file');
//   res.status, res.headers, res.stream (a readable), res.url (final, after redirects)
//
// Errors thrown by request() are always net.NetError with a .kind and a
// plain-language .userMessage. Pass a raw error to classifyError() to get
// the same treatment for errors caught elsewhere (for example while reading
// a response stream after request() has already resolved).

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MAX_REDIRECTS = 10;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const USER_MESSAGES = {
  tls_verify:
    'Your network is inspecting secure connections, which usually means a workplace computer. ' +
    'Scout needs a home-style connection to download its parts.',
  proxy_auth:
    'This network asked for a proxy username and password that Scout does not have. ' +
    'Try a different network, like your home Wi-Fi.',
  blocked:
    "Something on this network blocked Scout's connection. " +
    'Try a different network, or ask whoever manages this computer to allow it.',
  offline:
    'Scout cannot reach the internet right now. Check the Wi-Fi or cable and try again.',
  timeout:
    'The connection is taking too long and stopped responding.',
  http:
    'The server sent back an error instead of the file.',
  aborted:
    'The request was cancelled.',
};

export class NetError extends Error {
  constructor(kind, message, { status, cause } = {}) {
    super(message || USER_MESSAGES[kind] || 'A network error happened.');
    this.name = 'NetError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (cause !== undefined) this.cause = cause;
    this.userMessage = USER_MESSAGES[kind] || 'A network error happened. Scout will try again.';
  }
}

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

// Turns any caught error into a NetError. Safe to call on an error that is
// already a NetError (returned as is) or on a plain Node system error.
export function classifyError(err) {
  if (err instanceof NetError) return err;
  if (!err) return new NetError('offline', 'Unknown network error.');

  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
    return new NetError('aborted', 'The request was cancelled.', { cause: err });
  }
  if (err.httpStatus !== undefined) {
    return new NetError('http', `Server responded with status ${err.httpStatus}.`, {
      status: err.httpStatus,
      cause: err,
    });
  }
  if (err.proxyStatus === 407) {
    return new NetError('proxy_auth', 'The proxy asked for a username and password.', { cause: err });
  }
  if (err.proxyStatus !== undefined || err.tunnelRefused) {
    return new NetError('blocked', 'The proxy would not open a connection.', { cause: err });
  }
  if (err.isTimeout || err.code === 'ETIMEDOUT') {
    return new NetError('timeout', 'The connection timed out.', { cause: err });
  }
  if (TLS_CODES.has(err.code)) {
    return new NetError('tls_verify', 'The server certificate could not be verified.', { cause: err });
  }
  // ECONNRESET while establishing the proxy tunnel means something on the
  // network dropped the connection deliberately (blocked); ECONNRESET
  // anywhere else usually just means a flaky link (offline, retryable).
  if (err.code === 'ECONNRESET' && err.duringHandshake) {
    return new NetError('blocked', 'The connection was reset while connecting.', { cause: err });
  }
  if (OFFLINE_CODES.has(err.code) || err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
    return new NetError('offline', 'The network seems unreachable.', { cause: err });
  }
  return new NetError('offline', err.message || 'Network error.', { cause: err });
}

// ---------------------------------------------------------------------------
// Proxy detection
// ---------------------------------------------------------------------------

const ENV_PROXY_NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

function envProxy() {
  for (const name of ENV_PROXY_NAMES) {
    const val = process.env[name];
    if (val && val.trim()) return { url: val.trim(), source: name };
  }
  return null;
}

// Very small NO_PROXY matcher: exact host, leading-dot or bare domain
// suffix, and simple IPv4 CIDR ranges (the shape corporate NO_PROXY lists
// actually use). Never throws.
function noProxyMatches(host) {
  const raw = process.env.NO_PROXY || process.env.no_proxy;
  if (!raw || !host) return false;
  const h = host.toLowerCase();
  const entries = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const entry of entries) {
    if (entry === '*') return true;
    if (entry.includes('/')) {
      if (ipInCidr(h, entry)) return true;
      continue;
    }
    const pattern = entry.startsWith('.') ? entry.slice(1) : entry;
    if (h === pattern || h.endsWith('.' + pattern)) return true;
  }
  return false;
}

function ipInCidr(ip, cidr) {
  try {
    const [range, bitsStr] = cidr.split('/');
    const bits = Number(bitsStr);
    const toInt = (s) => s.split('.').map(Number).reduce((acc, n) => (acc << 8) + n, 0) >>> 0;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(range)) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toInt(ip) & mask) === (toInt(range) & mask);
  } catch {
    return false;
  }
}

function registryProxy() {
  try {
    const enableRes = spawnSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'],
      { timeout: 3000, encoding: 'utf8' },
    );
    if (!enableRes || enableRes.status !== 0 || !enableRes.stdout) return null;
    if (!/0x1\b/.test(enableRes.stdout)) return null;

    const serverRes = spawnSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
      { timeout: 3000, encoding: 'utf8' },
    );
    if (!serverRes || serverRes.status !== 0 || !serverRes.stdout) return null;
    const match = serverRes.stdout.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (!match) return null;
    // ProxyServer can be "host:port" or "http=host:port;https=host:port".
    let value = match[1];
    const httpsPart = value.split(';').find((p) => p.startsWith('https='));
    if (httpsPart) value = httpsPart.slice('https='.length);
    else if (value.includes('=')) value = value.split('=').pop();
    if (!value.includes('://')) value = 'http://' + value;
    return { url: value, source: 'registry' };
  } catch {
    return null;
  }
}

// Returns { url, source } for the proxy that should be used, or null.
// Pass the destination hostname to honor NO_PROXY for that host (127.0.0.1
// and localhost are the common case on this machine); called with no
// argument it just reports whatever proxy is configured.
export function detectProxy(host) {
  const fromEnv = envProxy();
  const found = fromEnv || (process.platform === 'win32' ? registryProxy() : null);
  if (!found) return null;
  if (host && noProxyMatches(host)) return null;
  return found;
}

// ---------------------------------------------------------------------------
// CA trust
// ---------------------------------------------------------------------------

// Returns { ca } when NODE_EXTRA_CA_CERTS points at a readable PEM file.
// On win32, best-effort injects the Windows root store via the optional
// win-ca dependency. Never throws, on any platform.
export function extraCaOptions() {
  const out = {};
  const certPath = process.env.NODE_EXTRA_CA_CERTS;
  if (certPath) {
    try {
      const pem = readFileSync(certPath, 'utf8');
      if (pem && pem.includes('BEGIN CERTIFICATE')) out.ca = pem;
    } catch {
      // unreadable or missing: fall through with no extra CA
    }
  }
  if (process.platform === 'win32') {
    // win-ca injects the Windows root store into Node's default trust on
    // import as a side effect. Dynamic import is unavoidably async here;
    // this is fire-and-forget best effort and must never throw.
    import('win-ca')
      .then((mod) => {
        const inject = mod.default || mod;
        if (typeof inject === 'function') inject();
      })
      .catch(() => {});
  }
  return out;
}

function mergedCa(userCa) {
  const extra = extraCaOptions().ca;
  const parts = [];
  if (extra) parts.push(extra);
  if (userCa) parts.push(userCa);
  if (parts.length === 0) return undefined;
  return [...tls.rootCertificates, ...parts];
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function abortedError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function timeoutMarked() {
  const err = new Error('Timed out.');
  err.isTimeout = true;
  return err;
}

function proxyStatusError(status) {
  const err = new Error(`Proxy responded with status ${status}.`);
  err.proxyStatus = status;
  return err;
}

function tunnelRefusedError(cause) {
  const err = new Error('The proxy tunnel was refused.');
  err.tunnelRefused = true;
  err.cause = cause;
  return err;
}

// Opens an HTTP CONNECT tunnel through proxyUrl to targetHost:targetPort and
// resolves with the raw (unencrypted) socket once the proxy accepts.
function openProxyTunnel(proxyUrl, targetHost, targetPort, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let proxy;
    try {
      proxy = new URL(proxyUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const headers = { Host: `${targetHost}:${targetPort}` };
    if (proxy.username || proxy.password) {
      const user = decodeURIComponent(proxy.username);
      const pass = decodeURIComponent(proxy.password);
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    }

    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      timeout: timeoutMs,
    });

    const onAbort = () => req.destroy(abortedError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    // Node fires 'connect' for every reply to a CONNECT request, success or
    // not; 'response' never fires here. A non-2xx status means the proxy
    // rejected the tunnel, so the socket is unusable.
    req.on('connect', (res, socket) => {
      cleanup();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(proxyStatusError(res.statusCode));
      }
    });
    req.on('timeout', () => {
      req.destroy();
      cleanup();
      reject(timeoutMarked());
    });
    req.on('error', (err) => {
      cleanup();
      if (err && err.name === 'AbortError') reject(err);
      else reject(tunnelRefusedError(err));
    });
    req.end();
  });
}

// Performs the TLS handshake over an already-CONNECTed proxy socket.
function tlsHandshakeOverSocket(socket, servername, ca, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, ca, timeout: timeoutMs });
    const onAbort = () => tlsSocket.destroy(abortedError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    tlsSocket.once('secureConnect', () => {
      cleanup();
      resolve(tlsSocket);
    });
    tlsSocket.once('error', (err) => {
      cleanup();
      if (err && err.code === 'ECONNRESET') err.duringHandshake = true;
      reject(err);
    });
    tlsSocket.once('timeout', () => {
      tlsSocket.destroy();
      cleanup();
      reject(timeoutMarked());
    });
  });
}

// Sends one HTTP request over an already-connected (and, for https targets,
// already-secured) socket and resolves with the response.
function requestOverSocket(socket, urlObj, method, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      path: urlObj.pathname + urlObj.search,
      headers: { ...headers, Host: urlObj.host, Connection: 'close' },
      createConnection: () => socket,
      // No agent: createConnection only takes effect without one, and we
      // want this one-off tunneled socket closed after this single
      // request, not pooled for reuse.
      agent: false,
    });
    req.on('error', reject);
    req.on('response', (res) => resolve(res));
    req.end();
  });
}

// One request, no redirect handling. Resolves { status, headers, stream }.
async function doOneRequest(urlObj, method, headers, timeoutMs, signal, userCa) {
  if (signal?.aborted) throw abortedError();

  const proxy = detectProxy(urlObj.hostname);
  const isHttps = urlObj.protocol === 'https:';

  if (proxy && isHttps) {
    const targetPort = urlObj.port || 443;
    const socket = await openProxyTunnel(proxy.url, urlObj.hostname, targetPort, timeoutMs, signal);
    const ca = mergedCa(userCa);
    const tlsSocket = await tlsHandshakeOverSocket(socket, urlObj.hostname, ca, timeoutMs, signal);
    const res = await requestOverSocket(tlsSocket, urlObj, method, headers);
    return { status: res.statusCode, headers: res.headers, stream: res };
  }

  if (proxy && !isHttps) {
    // Plain-HTTP-through-proxy: send the absolute URL directly, no CONNECT.
    let proxyUrl;
    try {
      proxyUrl = new URL(proxy.url);
    } catch (err) {
      throw err;
    }
    const proxyHeaders = { ...headers, Host: urlObj.host };
    if (proxyUrl.username || proxyUrl.password) {
      const user = decodeURIComponent(proxyUrl.username);
      const pass = decodeURIComponent(proxyUrl.password);
      proxyHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    }
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        method,
        path: urlObj.toString(),
        headers: proxyHeaders,
        timeout: timeoutMs,
      });
      const onAbort = () => req.destroy(abortedError());
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      req.on('timeout', () => { req.destroy(); reject(timeoutMarked()); });
      req.on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err);
      });
      req.on('response', (r) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(r);
      });
      req.end();
    });
    return { status: res.statusCode, headers: res.headers, stream: res };
  }

  // Direct connection, no proxy.
  const mod = isHttps ? https : http;
  const options = {
    method,
    headers: { ...headers, Host: urlObj.host },
    timeout: timeoutMs,
  };
  if (isHttps) options.ca = mergedCa(userCa);

  const res = await new Promise((resolve, reject) => {
    const req = mod.request(urlObj, options);
    const onAbort = () => req.destroy(abortedError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => { req.destroy(); reject(timeoutMarked()); });
    req.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.on('response', (r) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(r);
    });
    req.end();
  });
  return { status: res.statusCode, headers: res.headers, stream: res };
}

// Makes an HTTPS/HTTP request, following redirects and going through a
// detected proxy where needed. Resolves { status, headers, stream, url }
// for any 2xx response; throws NetError otherwise.
export async function request(rawUrl, opts = {}) {
  const { method = 'GET', headers = {}, timeoutMs = 30000, signal, ca } = opts;
  let urlObj = new URL(rawUrl);
  let currentMethod = method;
  const currentHeaders = { ...headers };

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    let res;
    try {
      res = await doOneRequest(urlObj, currentMethod, currentHeaders, timeoutMs, signal, ca);
    } catch (err) {
      throw classifyError(err);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      res.stream.resume(); // discard the redirect body
      if (redirect === MAX_REDIRECTS) {
        throw new NetError('http', 'Too many redirects.', { status: res.status });
      }
      urlObj = new URL(res.headers.location, urlObj);
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      res.stream.resume(); // drain so the socket can be reused/closed cleanly
      throw new NetError('http', `Server responded with status ${res.status}.`, { status: res.status });
    }

    return { status: res.status, headers: res.headers, stream: res.stream, url: urlObj.toString() };
  }
  // Unreachable, but keeps the function's return type honest.
  throw new NetError('http', 'Too many redirects.');
}
