// A minimal RFC 6455 WebSocket server, dependency-free, sized for the one
// job it needs to do: stream microphone audio over /ws/mic and let a small
// number of other server-pushed channels use the same primitive later.
//
// Usage:
//   import { attachWebSocket } from './ws.js';
//   const ws = attachWebSocket(server, {
//     path: '/ws/mic',
//     authenticate: (firstFrameText) => tokenFromFirstFrame(firstFrameText, token),
//     onConnection(conn, req) {
//       conn.on('message', (data, isBinary) => { ... });
//       conn.on('close', (code, reason) => { ... });
//     },
//   });
//   ws.close(); // on shutdown, closes every open connection

import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_PAYLOAD = 1024 * 1024; // 1 MB per frame
const DEFAULT_PING_INTERVAL_MS = 15000;
const AUTH_TIMEOUT_MS = 2000;
const CLOSE_GRACE_MS = 1000;

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

function computeAcceptKey(clientKey) {
  return createHash('sha1').update(clientKey + WS_GUID, 'binary').digest('base64');
}

// Builds one unmasked server-to-client frame.
function buildFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function closePayload(code, reason) {
  const reasonBuf = Buffer.from(reason || '', 'utf8');
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  return payload;
}

// Streaming parser for masked client frames. Buffers partial TCP chunks and
// yields complete frames (fin, opcode, payload) as they become available,
// handling the 7/16/64-bit length forms and unmasking each payload.
class FrameParser {
  constructor({ maxPayload, onFrame, onProtocolError }) {
    this.buffer = Buffer.alloc(0);
    this.maxPayload = maxPayload;
    this.onFrame = onFrame;
    this.onProtocolError = onProtocolError;
    this.failed = false;
  }

  push(chunk) {
    if (this.failed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this._drain();
  }

  _fail(message, code) {
    this.failed = true;
    this.onProtocolError(new Error(message), code);
  }

  _drain() {
    for (;;) {
      if (this.failed || this.buffer.length < 2) return;
      const byte0 = this.buffer[0];
      const byte1 = this.buffer[1];
      const fin = (byte0 & 0x80) !== 0;
      const rsv = byte0 & 0x70;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let len = byte1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) return this._fail('unsupported RSV bits', 1002);
      if (!masked) return this._fail('client frame must be masked', 1002);

      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this._fail('frame length overflow', 1009);
        len = Number(big);
        offset += 8;
      }

      if (len > this.maxPayload) return this._fail('frame exceeds maxPayload', 1009);
      if (this.buffer.length < offset + 4) return; // masking key not fully arrived
      const maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      if (this.buffer.length < offset + len) return; // payload not fully arrived

      const masked_ = this.buffer.subarray(offset, offset + len);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = masked_[i] ^ maskKey[i & 3];

      this.buffer = this.buffer.subarray(offset + len);
      this.onFrame({ fin, opcode, payload });
    }
  }
}

class WSConnection extends EventEmitter {
  constructor(socket, req, options) {
    super();
    this.id = randomUUID();
    this.isAlive = true;
    this.socket = socket;
    this.req = req;
    this.authenticate = options.authenticate;
    this.onConnectionCb = options.onConnection;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;

    this.authenticated = false;
    this.pendingFirstFrame = true;
    this.closed = false;
    this.closeRequested = false;
    this.fragmentOpcode = null;
    this.fragmentChunks = [];
    this.missedPongs = 0;
    this.pingTimer = null;

    this.parser = new FrameParser({
      maxPayload: options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
      onFrame: (frame) => this._handleFrame(frame),
      onProtocolError: (_err, code) => this._closeNow(code ?? 1002, 'protocol error'),
    });

    this.authTimer = setTimeout(() => {
      if (this.pendingFirstFrame) this._failAuth();
    }, AUTH_TIMEOUT_MS);
    this.authTimer.unref?.();

    socket.on('data', (chunk) => this.parser.push(chunk));
    socket.on('error', (err) => this._onSocketDown(err));
    socket.on('close', () => this._onSocketDown(null));
  }

  // -- outward API -----------------------------------------------------

  send(dataOrText) {
    if (this.closed) return;
    if (typeof dataOrText === 'string') {
      this.socket.write(buildFrame(OPCODE.TEXT, Buffer.from(dataOrText, 'utf8')));
    } else if (Buffer.isBuffer(dataOrText)) {
      this.socket.write(buildFrame(OPCODE.BINARY, dataOrText));
    } else if (dataOrText instanceof Uint8Array) {
      this.socket.write(buildFrame(OPCODE.BINARY, Buffer.from(dataOrText.buffer, dataOrText.byteOffset, dataOrText.byteLength)));
    } else {
      throw new TypeError('send() expects a string, Buffer, or Uint8Array');
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed || this.closeRequested) return;
    this.closeRequested = true;
    this.closeCodeSent = code;
    try {
      this.socket.write(buildFrame(OPCODE.CLOSE, closePayload(code, reason)));
    } catch {
      // socket already gone
    }
    const forceTimer = setTimeout(() => {
      try { this.socket.destroy(); } catch { /* already gone */ }
    }, CLOSE_GRACE_MS);
    forceTimer.unref?.();
  }

  // -- internals ---------------------------------------------------------

  _startHeartbeat() {
    this.pingTimer = setInterval(() => {
      if (!this.isAlive) {
        this.missedPongs += 1;
        if (this.missedPongs >= 2) {
          this._closeNow(1006, 'no pong received');
          return;
        }
      } else {
        this.missedPongs = 0;
      }
      this.isAlive = false;
      try {
        this.socket.write(buildFrame(OPCODE.PING));
      } catch {
        // ignore, the socket 'close'/'error' handler will clean up
      }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === OPCODE.CLOSE) return this._handleCloseFrame(payload);
    if (opcode === OPCODE.PING) return this._handlePing(payload);
    if (opcode === OPCODE.PONG) return this._handlePong();

    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      if (this.fragmentOpcode !== null) return this._closeNow(1002, 'expected continuation frame');
      if (fin) return this._deliver(opcode, payload);
      this.fragmentOpcode = opcode;
      this.fragmentChunks = [payload];
      return;
    }

    if (opcode === OPCODE.CONTINUATION) {
      if (this.fragmentOpcode === null) return this._closeNow(1002, 'unexpected continuation frame');
      this.fragmentChunks.push(payload);
      if (fin) {
        const full = Buffer.concat(this.fragmentChunks);
        const op = this.fragmentOpcode;
        this.fragmentOpcode = null;
        this.fragmentChunks = [];
        this._deliver(op, full);
      }
      return;
    }

    this._closeNow(1002, 'unknown opcode');
  }

  _handlePing(payload) {
    if (payload.length > 125) return this._closeNow(1002, 'ping payload too large');
    try {
      this.socket.write(buildFrame(OPCODE.PONG, payload));
    } catch { /* ignore */ }
  }

  _handlePong() {
    this.isAlive = true;
    this.missedPongs = 0;
  }

  _handleCloseFrame(payload) {
    let code = 1005;
    let reason = '';
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      reason = payload.subarray(2).toString('utf8');
    }
    if (!this.closeRequested) {
      // Peer-initiated close: echo the same code back to complete the
      // closing handshake, per RFC 6455 section 7.1.5.
      this.closeRequested = true;
      try {
        this.socket.write(buildFrame(OPCODE.CLOSE, closePayload(code, '')));
      } catch { /* ignore */ }
    }
    this._finish(code, reason);
  }

  _deliver(opcode, payload) {
    if (this.pendingFirstFrame) return this._handleFirstFrame(opcode, payload);
    if (!this.authenticated) return; // not authenticated yet: frames are dropped, not queued
    const isBinary = opcode === OPCODE.BINARY;
    this.emit('message', isBinary ? payload : payload.toString('utf8'), isBinary);
  }

  // Resolves the first frame's authenticate() call synchronously when it
  // returns a plain boolean (the real case: a token compare), so a data
  // frame the client sent right after the auth frame and that arrived in
  // the same TCP chunk is not parsed before `authenticated` flips true.
  // A Promise-returning authenticate() still works, just asynchronously.
  _handleFirstFrame(opcode, payload) {
    this.pendingFirstFrame = false;
    clearTimeout(this.authTimer);
    const text = opcode === OPCODE.TEXT ? payload.toString('utf8') : null;
    let result;
    try {
      result = this.authenticate(text);
    } catch {
      this._failAuth();
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then((ok) => this._completeAuth(ok)).catch(() => this._failAuth());
    } else {
      this._completeAuth(result);
    }
  }

  _completeAuth(ok) {
    if (this.closed) return;
    if (ok) {
      this.authenticated = true;
      this._startHeartbeat();
      this.onConnectionCb(this, this.req);
    } else {
      this._failAuth();
    }
  }

  _failAuth() {
    this._closeNow(4401, 'unauthorized');
  }

  // Sends a close frame (best effort) and tears the connection down
  // immediately, without waiting for the peer's echo.
  _closeNow(code, reason) {
    if (this.closed) return;
    try {
      this.socket.write(buildFrame(OPCODE.CLOSE, closePayload(code, reason)));
    } catch { /* ignore */ }
    this._finish(code, reason);
  }

  _onSocketDown(err) {
    if (err && this.listenerCount('error') > 0) this.emit('error', err);
    this._finish(this.closeCodeSent ?? 1006, err ? err.message : 'connection closed');
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.authTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    try { this.socket.destroy(); } catch { /* already gone */ }
    this.emit('close', code, reason);
  }
}

export function attachWebSocket(server, options) {
  const { path, onConnection, authenticate, maxPayload, pingIntervalMs, verifyClient } = options;
  if (typeof path !== 'string') throw new TypeError('attachWebSocket requires options.path');
  if (typeof onConnection !== 'function') throw new TypeError('attachWebSocket requires options.onConnection');
  if (typeof authenticate !== 'function') throw new TypeError('attachWebSocket requires options.authenticate');

  const clients = new Set();

  function upgradeHandler(req, socket, head) {
    const url = req.url || '';
    const pathname = url.split('?')[0];
    if (pathname !== path) return; // not ours: leave it for any other listener

    // Same origin/Host policy as every other route, run once here so the
    // caller does not need a second 'upgrade' listener racing this one.
    if (typeof verifyClient === 'function' && !verifyClient(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    const upgradeHeader = String(req.headers.upgrade || '').toLowerCase();
    const connectionHeader = String(req.headers.connection || '').toLowerCase();
    const validRequest =
      typeof key === 'string' &&
      version === '13' &&
      upgradeHeader === 'websocket' &&
      connectionHeader.split(',').map((s) => s.trim()).includes('upgrade');

    if (!validRequest) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = computeAcceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    socket.setTimeout(0);

    const conn = new WSConnection(socket, req, { authenticate, onConnection, maxPayload, pingIntervalMs });
    clients.add(conn);
    conn.on('close', () => clients.delete(conn));

    if (head && head.length) conn.parser.push(head);
  }

  server.on('upgrade', upgradeHandler);

  function close() {
    server.removeListener('upgrade', upgradeHandler);
    for (const conn of clients) conn.close(1001, 'server shutting down');
  }

  return { close, clients };
}
