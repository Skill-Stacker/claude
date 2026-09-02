import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { request, detectProxy, extraCaOptions, classifyError, NetError } from '../app/lib/net.js';

const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
const NO_PROXY_ENV_NAMES = ['NO_PROXY', 'no_proxy'];

// Snapshots and clears every proxy-related env var so tests do not see the
// real proxy this container runs under (or each other's leftovers), then
// restores the original values afterward.
function withCleanProxyEnv(fn) {
  const saved = {};
  for (const name of [...PROXY_ENV_NAMES, ...NO_PROXY_ENV_NAMES]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  return fn().finally(restore);
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function readAll(stream) {
  let body = '';
  for await (const chunk of stream) body += chunk;
  return body;
}

// ---------------------------------------------------------------------------
// detectProxy
// ---------------------------------------------------------------------------

test('detectProxy reads HTTPS_PROXY and reports its source', () => withCleanProxyEnv(async () => {
  assert.equal(detectProxy(), null);
  process.env.HTTPS_PROXY = 'http://proxy.example:8080';
  const found = detectProxy();
  assert.equal(found.url, 'http://proxy.example:8080');
  assert.equal(found.source, 'HTTPS_PROXY');
}));

test('detectProxy prefers HTTPS_PROXY over HTTP_PROXY', () => withCleanProxyEnv(async () => {
  process.env.HTTP_PROXY = 'http://plain.example:8080';
  process.env.HTTPS_PROXY = 'http://secure.example:8080';
  const found = detectProxy();
  assert.equal(found.source, 'HTTPS_PROXY');
}));

test('detectProxy honors NO_PROXY for a matching host', () => withCleanProxyEnv(async () => {
  process.env.HTTPS_PROXY = 'http://proxy.example:8080';
  process.env.NO_PROXY = '127.0.0.1,localhost,.internal.example';
  assert.equal(detectProxy('127.0.0.1'), null);
  assert.equal(detectProxy('localhost'), null);
  assert.equal(detectProxy('foo.internal.example'), null);
  assert.notEqual(detectProxy('outside.example'), null);
  // called with no host at all, NO_PROXY cannot be applied
  assert.notEqual(detectProxy(), null);
}));

// ---------------------------------------------------------------------------
// extraCaOptions
// ---------------------------------------------------------------------------

test('extraCaOptions reads a PEM from NODE_EXTRA_CA_CERTS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stickos-ca-'));
  const pemPath = join(dir, 'ca.pem');
  const fakePem = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
  writeFileSync(pemPath, fakePem);
  const saved = process.env.NODE_EXTRA_CA_CERTS;
  try {
    process.env.NODE_EXTRA_CA_CERTS = pemPath;
    const out = extraCaOptions();
    assert.equal(out.ca, fakePem);
  } finally {
    if (saved === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extraCaOptions never throws when the path is missing or unset', () => {
  const saved = process.env.NODE_EXTRA_CA_CERTS;
  try {
    delete process.env.NODE_EXTRA_CA_CERTS;
    assert.deepEqual(extraCaOptions(), {});
    process.env.NODE_EXTRA_CA_CERTS = '/does/not/exist.pem';
    assert.deepEqual(extraCaOptions(), {});
  } finally {
    if (saved === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = saved;
  }
});

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

test('classifyError maps Node system errors to the right kind', () => {
  const cases = [
    ['ENOTFOUND', 'offline'],
    ['EAI_AGAIN', 'offline'],
    ['ENETUNREACH', 'offline'],
    ['EHOSTUNREACH', 'offline'],
    ['ECONNRESET', 'offline'],
    ['ECONNREFUSED', 'offline'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_verify'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls_verify'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_verify'],
    ['CERT_HAS_EXPIRED', 'tls_verify'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_verify'],
  ];
  for (const [code, kind] of cases) {
    const err = classifyError(Object.assign(new Error(code), { code }));
    assert.equal(err.kind, kind, `code ${code}`);
    assert.ok(err instanceof NetError);
    assert.ok(err.userMessage.length > 0);
  }
});

test('classifyError marks ECONNRESET during a proxy handshake as blocked', () => {
  const err = classifyError(Object.assign(new Error('reset'), { code: 'ECONNRESET', duringHandshake: true }));
  assert.equal(err.kind, 'blocked');
});

test('classifyError is idempotent on an existing NetError', () => {
  const original = new NetError('timeout', 'slow');
  assert.equal(classifyError(original), original);
});

test('classifyError maps an AbortError to aborted', () => {
  const err = classifyError(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  assert.equal(err.kind, 'aborted');
});

// ---------------------------------------------------------------------------
// request(): direct connections, redirects, non-2xx, abort, timeout
// ---------------------------------------------------------------------------

test('request: a direct GET resolves status, headers, and a readable body', () => withCleanProxyEnv(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '5', 'X-Test': 'yes' });
    res.end('hello');
  });
  const port = await listen(server);
  const res = await request(`http://127.0.0.1:${port}/ok`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-test'], 'yes');
  assert.equal(await readAll(res.stream), 'hello');
  await closeServer(server);
}));

test('request: follows a redirect and reports the final url', () => withCleanProxyEnv(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/end' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Length': '2' });
    res.end('OK');
  });
  const port = await listen(server);
  const res = await request(`http://127.0.0.1:${port}/start`);
  assert.equal(res.status, 200);
  assert.equal(res.url, `http://127.0.0.1:${port}/end`);
  assert.equal(await readAll(res.stream), 'OK');
  await closeServer(server);
}));

test('request: a non-2xx response throws NetError kind http with the status', () => withCleanProxyEnv(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Length': '2' });
    res.end('NF');
  });
  const port = await listen(server);
  await assert.rejects(
    () => request(`http://127.0.0.1:${port}/missing`),
    (err) => {
      assert.equal(err.kind, 'http');
      assert.equal(err.status, 404);
      return true;
    },
  );
  await closeServer(server);
}));

test('request: an aborted signal throws NetError kind aborted', () => withCleanProxyEnv(async () => {
  const server = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('late'); }, 5000);
  });
  const port = await listen(server);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(
    () => request(`http://127.0.0.1:${port}/slow`, { signal: ac.signal }),
    (err) => {
      assert.equal(err.kind, 'aborted');
      return true;
    },
  );
  await closeServer(server);
}));

test('request: an idle connection past timeoutMs throws NetError kind timeout', () => withCleanProxyEnv(async () => {
  const server = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('late'); }, 5000);
  });
  const port = await listen(server);
  await assert.rejects(
    () => request(`http://127.0.0.1:${port}/slow`, { timeoutMs: 200 }),
    (err) => {
      assert.equal(err.kind, 'timeout');
      return true;
    },
  );
  await closeServer(server);
}));

// ---------------------------------------------------------------------------
// request(): through a proxy (CONNECT tunnel)
// ---------------------------------------------------------------------------

function proxyThatReplies(statusLine) {
  return http.createServer().on('connect', (req, clientSocket) => {
    clientSocket.write(`HTTP/1.1 ${statusLine}\r\nContent-Length: 0\r\n\r\n`);
    clientSocket.end();
  });
}

// A minimal CONNECT-tunneling proxy: accepts the tunnel and pipes bytes
// straight through to whatever host:port the client asked for.
function tunnelingProxy() {
  const server = http.createServer();
  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':');
    const upstream = net.connect(Number(portStr), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
    });
    // Forward data by hand rather than upstream.pipe(clientSocket) et al:
    // piping two raw sockets into each other here leaves the test runner's
    // own idle-loop detection confused after the exchange finishes.
    const teardown = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on('data', (chunk) => { if (!clientSocket.destroyed) clientSocket.write(chunk); });
    clientSocket.on('data', (chunk) => { if (!upstream.destroyed) upstream.write(chunk); });
    upstream.on('end', () => clientSocket.end());
    clientSocket.on('end', () => upstream.end());
    upstream.on('error', teardown);
    clientSocket.on('error', teardown);
    upstream.on('close', teardown);
    clientSocket.on('close', teardown);
  });
  return server;
}

test('request: a proxy answering 407 to CONNECT throws NetError kind proxy_auth', () => withCleanProxyEnv(async () => {
  const proxy = proxyThatReplies('407 Proxy Authentication Required');
  const port = await listen(proxy);
  process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
  await assert.rejects(
    () => request('https://example.invalid/', { timeoutMs: 3000 }),
    (err) => {
      assert.equal(err.kind, 'proxy_auth');
      return true;
    },
  );
  await closeServer(proxy);
}));

test('request: a proxy answering 403 to CONNECT throws NetError kind blocked', () => withCleanProxyEnv(async () => {
  const proxy = proxyThatReplies('403 Forbidden');
  const port = await listen(proxy);
  process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
  await assert.rejects(
    () => request('https://example.invalid/', { timeoutMs: 3000 }),
    (err) => {
      assert.equal(err.kind, 'blocked');
      return true;
    },
  );
  await closeServer(proxy);
}));

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

test('request: through a tunnel, an unrecognized self-signed cert fails, and a trusted one succeeds', { skip: !hasOpenssl && 'openssl not available' }, () => withCleanProxyEnv(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stickos-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const gen = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-subj', '/CN=localhost', '-keyout', keyPath, '-out', certPath, '-days', '1',
  ]);
  assert.equal(gen.status, 0, gen.stderr?.toString());

  const { readFileSync } = await import('node:fs');
  const https = await import('node:https');
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);

  const target = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'Content-Length': '2' });
    res.end('OK');
  });
  const targetPort = await listen(target);

  const proxy = tunnelingProxy();
  const proxyPort = await listen(proxy);
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;

  await assert.rejects(
    () => request(`https://localhost:${targetPort}/`, { timeoutMs: 3000 }),
    (err) => {
      assert.equal(err.kind, 'tls_verify');
      return true;
    },
  );

  const res = await request(`https://localhost:${targetPort}/`, { timeoutMs: 3000, ca: cert.toString() });
  assert.equal(res.status, 200);
  assert.equal(await readAll(res.stream), 'OK');

  await closeServer(target);
  await closeServer(proxy);
  rmSync(dir, { recursive: true, force: true });
}));

// ---------------------------------------------------------------------------
// Live smoke test, opt-in only
// ---------------------------------------------------------------------------

test('live: a Range 0-0 request to a real GitHub release asset through this container\'s proxy', {
  skip: process.env.STICKOS_LIVE_NET !== '1' && 'set STICKOS_LIVE_NET=1 to run',
}, async () => {
  const url = 'https://github.com/mozilla-ai/llamafile/releases/download/0.10.5/llamafile-0.10.5';
  const res = await request(url, { headers: { Range: 'bytes=0-0' }, timeoutMs: 15000 });
  assert.ok(res.status === 200 || res.status === 206, `unexpected status ${res.status}`);
  res.stream.resume();
  await new Promise((resolve) => res.stream.on('end', resolve));
});
