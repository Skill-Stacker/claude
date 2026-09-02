import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { attachWebSocket } from '../app/lib/ws.js';

const TOKEN = 'test-token-abc123';

function authenticate(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && parsed.token === TOKEN;
  } catch {
    return false;
  }
}

function defaultOnConnection(conn) {
  conn.on('message', (data, isBinary) => {
    if (isBinary) conn.send(JSON.stringify({ bytes: data.length }));
  });
}

function makeServer(opts = {}) {
  const server = createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  attachWebSocket(server, {
    path: '/ws/mic',
    authenticate,
    onConnection: opts.onConnection || defaultOnConnection,
    pingIntervalMs: opts.pingIntervalMs,
    maxPayload: opts.maxPayload,
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolvePromise({ server, port, url: `ws://127.0.0.1:${port}/ws/mic` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => server.close(resolvePromise));
}

function waitOpen(ws) {
  return new Promise((resolvePromise, reject) => {
    ws.onopen = resolvePromise;
    ws.onerror = (event) => reject(new Error('ws error: ' + (event.message || 'unknown')));
  });
}

describe('WebSocket handshake and auth', () => {
  test('completes the RFC 6455 handshake', async () => {
    const { server, url } = await makeServer();
    try {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      assert.equal(ws.readyState, WebSocket.OPEN);
      ws.close(1000, 'done');
      await new Promise((resolvePromise) => { ws.onclose = resolvePromise; });
    } finally {
      await closeServer(server);
    }
  });

  test('a wrong first-frame token closes with 4401 well within 2 seconds', async () => {
    const { server, url } = await makeServer();
    try {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      const start = Date.now();
      ws.send(JSON.stringify({ token: 'wrong-token' }));
      const closeEvent = await new Promise((resolvePromise, reject) => {
        ws.onclose = resolvePromise;
        setTimeout(() => reject(new Error('did not close in time')), 2500);
      });
      const elapsed = Date.now() - start;
      assert.equal(closeEvent.code, 4401);
      assert.ok(elapsed < 2000, `closed after ${elapsed}ms, expected well under 2000ms`);
    } finally {
      await closeServer(server);
    }
  });

  test('no first frame at all times out near 2 seconds and closes with 4401', async () => {
    const { server, url } = await makeServer();
    try {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      const start = Date.now();
      const closeEvent = await new Promise((resolvePromise, reject) => {
        ws.onclose = resolvePromise;
        setTimeout(() => reject(new Error('did not close in time')), 3000);
      });
      const elapsed = Date.now() - start;
      assert.equal(closeEvent.code, 4401);
      assert.ok(elapsed >= 1900, `closed too early, after ${elapsed}ms`);
      assert.ok(elapsed < 2800, `closed too late, after ${elapsed}ms`);
    } finally {
      await closeServer(server);
    }
  });
});

describe('messages after authentication', () => {
  test('a correct token then a binary frame is echoed as { bytes: n }', async () => {
    const { server, url } = await makeServer();
    try {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      await waitOpen(ws);

      const echoPromise = new Promise((resolvePromise, reject) => {
        ws.onmessage = (event) => resolvePromise(event.data);
        setTimeout(() => reject(new Error('timed out waiting for echo')), 3000);
      });

      // Sent back to back on purpose: on localhost these commonly land in
      // the same TCP read, which is exactly the case that must not drop
      // the second frame while authentication is still resolving.
      ws.send(JSON.stringify({ token: TOKEN }));
      ws.send(new Uint8Array([1, 2, 3, 4, 5]));

      const reply = await echoPromise;
      const body = JSON.parse(reply);
      assert.equal(body.bytes, 5);

      ws.close(1000, 'done');
      await new Promise((resolvePromise) => { ws.onclose = resolvePromise; });
    } finally {
      await closeServer(server);
    }
  });

  test('frames before authentication succeeds are not delivered', async () => {
    let delivered = 0;
    const { server, url } = await makeServer({
      onConnection: (conn) => {
        conn.on('message', () => { delivered += 1; });
      },
    });
    try {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      // A wrong token first frame should never reach onConnection at all,
      // so nothing can have been delivered.
      ws.send(JSON.stringify({ token: 'nope' }));
      await new Promise((resolvePromise) => { ws.onclose = resolvePromise; });
      assert.equal(delivered, 0);
    } finally {
      await closeServer(server);
    }
  });
});

describe('heartbeat', () => {
  test('server pings keep an active connection alive', async () => {
    const { server, url } = await makeServer({ pingIntervalMs: 150 });
    try {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      ws.send(JSON.stringify({ token: TOKEN }));
      let closed = false;
      let closeCode = null;
      ws.onclose = (event) => { closed = true; closeCode = event.code; };

      // Several ping intervals' worth of waiting; a compliant client
      // answers each ping with a pong automatically.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
      assert.equal(closed, false, `connection closed early with code ${closeCode}`);

      ws.close(1000, 'done');
      await new Promise((resolvePromise) => { ws.onclose = resolvePromise; });
    } finally {
      await closeServer(server);
    }
  });
});

describe('close code round trip', () => {
  test('a client-initiated close code is seen by the server', async () => {
    let serverConn = null;
    const { server, url } = await makeServer({
      onConnection: (conn) => { serverConn = conn; },
    });
    try {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      ws.send(JSON.stringify({ token: TOKEN }));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      assert.ok(serverConn, 'onConnection should have fired after authentication');

      const serverClosed = new Promise((resolvePromise) => {
        serverConn.on('close', (code, reason) => resolvePromise({ code, reason }));
      });
      ws.close(4300, 'bye from client');
      const result = await serverClosed;
      assert.equal(result.code, 4300);
    } finally {
      await closeServer(server);
    }
  });

  test('a server-initiated close code is seen by the client', async () => {
    let serverConn = null;
    const { server, url } = await makeServer({
      onConnection: (conn) => { serverConn = conn; },
    });
    try {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      ws.send(JSON.stringify({ token: TOKEN }));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      assert.ok(serverConn, 'onConnection should have fired after authentication');

      const clientClosed = new Promise((resolvePromise) => { ws.onclose = resolvePromise; });
      serverConn.close(4301, 'bye from server');
      const event = await clientClosed;
      assert.equal(event.code, 4301);
    } finally {
      await closeServer(server);
    }
  });
});
