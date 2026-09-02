import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { startServer } from '../app/server.js';

function tmpBase() {
  return mkdtempSync(join(os.tmpdir(), 'stickos-server-'));
}

let nextPort = 47340;
function testPort() {
  nextPort += 1;
  return nextPort;
}

describe('startServer basics', () => {
  test('starts on an ephemeral base dir and reports alreadyRunning: false', async () => {
    const baseDir = tmpBase();
    const app = await startServer({ baseDir, port: testPort() });
    try {
      assert.equal(app.alreadyRunning, false);
      assert.equal(typeof app.port, 'number');
      assert.equal(typeof app.token, 'string');
      assert.ok(app.token.length > 0);
      assert.equal(existsSync(join(baseDir, 'state', 'port.json')), true);
      assert.equal(existsSync(join(baseDir, 'state', 'port.txt')), true);
      const portTxt = readFileSync(join(baseDir, 'state', 'port.txt'), 'utf8');
      assert.equal(portTxt, String(app.port));
    } finally {
      await app.close();
    }
  });

  test('deletes state/port.json and state/port.txt on close', async () => {
    const baseDir = tmpBase();
    const app = await startServer({ baseDir, port: testPort() });
    const jsonPath = join(baseDir, 'state', 'port.json');
    const txtPath = join(baseDir, 'state', 'port.txt');
    assert.equal(existsSync(jsonPath), true);
    assert.equal(existsSync(txtPath), true);
    await app.close();
    assert.equal(existsSync(jsonPath), false);
    assert.equal(existsSync(txtPath), false);
  });

  test('honors STICKOS_HOME when baseDir is not given', async () => {
    const baseDir = tmpBase();
    const prior = process.env.STICKOS_HOME;
    process.env.STICKOS_HOME = baseDir;
    try {
      const app = await startServer({ port: testPort() });
      try {
        assert.equal(app.paths.base, baseDir);
        assert.equal(existsSync(join(baseDir, 'state', 'port.json')), true);
      } finally {
        await app.close();
      }
    } finally {
      if (prior === undefined) delete process.env.STICKOS_HOME;
      else process.env.STICKOS_HOME = prior;
    }
  });
});

describe('routes', () => {
  test('GET / contains the token', async () => {
    const app = await startServer({ baseDir: tmpBase(), port: testPort() });
    try {
      const res = await fetch(`${app.origin}/`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes(app.token), 'index page should contain the token');
      assert.equal(body.includes('__STICKOS_TOKEN__'), false);
      assert.equal(body.includes('__STICKOS_ORIGIN__'), false);
    } finally {
      await app.close();
    }
  });

  test('GET /api/status has no token', async () => {
    const app = await startServer({ baseDir: tmpBase(), port: testPort() });
    try {
      const res = await fetch(`${app.origin}/api/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.app, 'stickos');
      assert.equal(body.port, app.port);
      assert.equal(body.engine, null);
      assert.equal(body.voice, null);
      const text = JSON.stringify(body);
      assert.equal(text.includes(app.token), false);
    } finally {
      await app.close();
    }
  });

  test('POST /api/echo without token is 401, with token is 200', async () => {
    const app = await startServer({ baseDir: tmpBase(), port: testPort() });
    try {
      const noToken = await fetch(`${app.origin}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      assert.equal(noToken.status, 401);

      const withToken = await fetch(`${app.origin}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ hello: 'world' }),
      });
      assert.equal(withToken.status, 200);
      const body = await withToken.json();
      assert.deepEqual(body.echo, { hello: 'world' });
    } finally {
      await app.close();
    }
  });

  test('POST with a foreign Origin is 403', async () => {
    const app = await startServer({ baseDir: tmpBase(), port: testPort() });
    try {
      const res = await fetch(`${app.origin}/api/echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-stickos-token': app.token,
          Origin: 'http://evil.example',
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 403);
    } finally {
      await app.close();
    }
  });

  test('GET /../package.json is 404', async () => {
    const app = await startServer({ baseDir: tmpBase(), port: testPort() });
    try {
      const res = await fetch(`${app.origin}/../package.json`);
      assert.equal(res.status, 404);
    } finally {
      await app.close();
    }
  });

  test('SSE hello event arrives on /api/events', async () => {
    const app = await startServer({ baseDir: tmpBase(), port: testPort() });
    try {
      const res = await fetch(`${app.origin}/api/events`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 3000;
      while (!text.includes('event: hello') && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel().catch(() => {});
      assert.ok(text.includes('event: hello'), 'expected a hello event');
    } finally {
      await app.close();
    }
  });
});

describe('single instance and the real port range', () => {
  test('a decoy listener on 47300 makes the server take 47301', async () => {
    const decoy = createServer();
    await new Promise((resolvePromise, reject) => {
      decoy.once('error', reject);
      decoy.listen(47300, '127.0.0.1', resolvePromise);
    });

    let app;
    try {
      app = await startServer({ baseDir: tmpBase() }); // no portOverride: exercises the real walk
      assert.equal(app.port, 47301);
    } finally {
      if (app && !app.alreadyRunning) await app.close();
      await new Promise((resolvePromise) => decoy.close(resolvePromise));
    }
  });

  test('a second startServer against the same base dir resolves alreadyRunning: true', async () => {
    const baseDir = tmpBase();
    const first = await startServer({ baseDir, port: testPort() });
    try {
      assert.equal(first.alreadyRunning, false);
      const second = await startServer({ baseDir, port: testPort() });
      assert.equal(second.alreadyRunning, true);
      assert.equal(second.port, first.port);
      assert.equal(second.url, `http://127.0.0.1:${first.port}/`);
    } finally {
      await first.close();
    }
  });
});
