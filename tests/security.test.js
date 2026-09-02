import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { join } from 'node:path';
import os from 'node:os';

import {
  safeJoin,
  originAllowed,
  hostAllowed,
  findFreePort,
  requireToken,
  tokenFromFirstFrame,
  newToken,
} from '../app/lib/security.js';

const ROOT = join(os.tmpdir(), 'stickos-safejoin-root');

describe('safeJoin', () => {
  test('rejects a ../ traversal', () => {
    assert.equal(safeJoin(ROOT, '/../etc/passwd'), null);
    assert.equal(safeJoin(ROOT, '/foo/../../etc/passwd'), null);
    assert.equal(safeJoin(ROOT, '../secret'), null);
  });

  test('rejects an encoded %2e%2e traversal', () => {
    assert.equal(safeJoin(ROOT, '/%2e%2e/etc/passwd'), null);
    assert.equal(safeJoin(ROOT, '/foo/%2e%2e%2f%2e%2e/etc/passwd'), null);
  });

  test('rejects absolute-path forms', () => {
    assert.equal(safeJoin(ROOT, '//etc/passwd'), null); // protocol-relative / UNC style
    assert.equal(safeJoin(ROOT, 'C:\\Windows\\System32\\config\\SAM'), null); // drive-absolute
  });

  test('rejects a null byte', () => {
    assert.equal(safeJoin(ROOT, '/index.html%00.png'), null);
  });

  test('resolves a normal path inside root', () => {
    assert.equal(safeJoin(ROOT, '/index.html'), join(ROOT, 'index.html'));
    assert.equal(safeJoin(ROOT, '/windows/style.css'), join(ROOT, 'windows', 'style.css'));
    assert.equal(safeJoin(ROOT, '/'), ROOT);
  });

  test('rejects a non-string input', () => {
    assert.equal(safeJoin(ROOT, undefined), null);
    assert.equal(safeJoin(ROOT, null), null);
  });
});

describe('originAllowed', () => {
  const ourOrigin = 'http://127.0.0.1:47300';

  test('allows a request with no Origin header', () => {
    assert.equal(originAllowed({ headers: {} }, ourOrigin), true);
  });

  test('allows a request whose Origin matches exactly', () => {
    assert.equal(originAllowed({ headers: { origin: ourOrigin } }, ourOrigin), true);
  });

  test('rejects a foreign Origin', () => {
    assert.equal(originAllowed({ headers: { origin: 'http://evil.example' } }, ourOrigin), false);
    assert.equal(originAllowed({ headers: { origin: 'http://127.0.0.1:47301' } }, ourOrigin), false);
    assert.equal(originAllowed({ headers: { origin: 'https://127.0.0.1:47300' } }, ourOrigin), false);
  });
});

describe('hostAllowed (DNS rebinding guard)', () => {
  const port = 47300;

  test('allows 127.0.0.1:<port>', () => {
    assert.equal(hostAllowed({ headers: { host: '127.0.0.1:47300' } }, port), true);
  });

  test('allows localhost:<port>, case-insensitively', () => {
    assert.equal(hostAllowed({ headers: { host: 'LOCALHOST:47300' } }, port), true);
  });

  test('rejects a foreign hostname resolving to 127.0.0.1', () => {
    assert.equal(hostAllowed({ headers: { host: 'attacker.example:47300' } }, port), false);
  });

  test('rejects the right host with the wrong port', () => {
    assert.equal(hostAllowed({ headers: { host: '127.0.0.1:9999' } }, port), false);
  });

  test('rejects a missing Host header', () => {
    assert.equal(hostAllowed({ headers: {} }, port), false);
  });
});

describe('token', () => {
  test('newToken returns 64 hex characters (32 bytes)', () => {
    const token = newToken();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(token, newToken());
  });

  test('requireToken checks the x-stickos-token header', () => {
    const token = newToken();
    assert.equal(requireToken({ headers: { 'x-stickos-token': token } }, token), true);
    assert.equal(requireToken({ headers: { 'x-stickos-token': 'wrong' } }, token), false);
    assert.equal(requireToken({ headers: {} }, token), false);
  });

  test('tokenFromFirstFrame checks the WebSocket first-frame JSON', () => {
    const token = newToken();
    assert.equal(tokenFromFirstFrame(JSON.stringify({ token }), token), true);
    assert.equal(tokenFromFirstFrame(JSON.stringify({ token: 'wrong' }), token), false);
    assert.equal(tokenFromFirstFrame('not json', token), false);
    assert.equal(tokenFromFirstFrame(undefined, token), false);
  });
});

describe('findFreePort', () => {
  test('skips a port a decoy listener holds', async () => {
    const basePort = await new Promise((resolvePromise, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolvePromise(port));
      });
    });

    const decoy = createServer();
    await new Promise((resolvePromise, reject) => {
      decoy.once('error', reject);
      decoy.listen(basePort, '127.0.0.1', resolvePromise);
    });

    try {
      const found = await findFreePort(basePort, 3);
      assert.equal(found, basePort + 1);
    } finally {
      await new Promise((resolvePromise) => decoy.close(resolvePromise));
    }
  });

  test('throws on a non-EADDRINUSE bind error', async () => {
    await assert.rejects(() => findFreePort(70000, 1));
  });
});
