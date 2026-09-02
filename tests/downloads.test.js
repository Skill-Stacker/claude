import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  downloadAsset,
  verifyAsset,
  reverifyAll,
  diskFreePreflight,
  bytesNeeded,
  ggufMagicOk,
  DownloadError,
} from '../app/lib/downloads.js';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'stickos-downloads-'));
}

// A 3 MB deterministic (not-actually-random, but non-repeating) buffer, big
// enough to exercise Range resume without making the test suite slow.
function makeBuffer(size = 3 * 1024 * 1024) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 37 + 11) % 256;
  return buf;
}

// A local http server serving `buf` at /asset with Range support. When
// `stallAt` is set, the FIRST request only is cut off after that many bytes
// (simulating a dropped connection); every later request behaves normally.
function rangeServer(buf, { stallAt } = {}) {
  let requestCount = 0;
  return http.createServer((req, res) => {
    requestCount += 1;
    const range = req.headers.range;
    let start = 0;
    if (range) {
      const m = /bytes=(\d+)-/.exec(range);
      if (m) start = Number(m[1]);
    }
    if (stallAt != null && requestCount === 1) {
      res.writeHead(start > 0 ? 206 : 200, { 'Content-Length': String(buf.length - start) });
      res.write(buf.subarray(start, stallAt));
      res.socket.destroy();
      return;
    }
    if (start > 0) {
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${buf.length - 1}/${buf.length}`,
        'Content-Length': String(buf.length - start),
      });
      res.end(buf.subarray(start));
    } else {
      res.writeHead(200, { 'Content-Length': String(buf.length) });
      res.end(buf);
    }
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}/asset`;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

const BUF = makeBuffer();
const HASH = sha256(BUF);

test('downloadAsset: full download verifies and renames into place', async () => {
  const dir = tmpDir();
  const server = rangeServer(BUF);
  const url = await listen(server);
  const dest = join(dir, 'file.bin');
  const asset = { url, size: BUF.length, sha256: HASH, min_mb: 1 };

  const progress = [];
  const result = await downloadAsset(asset, dest, {
    statePath: join(dir, 'state.json'),
    backoff: () => 5,
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result.skipped, false);
  assert.equal(result.sha256, HASH);
  assert.equal(result.path, dest);
  assert.ok(existsSync(dest));
  assert.equal(statSync(dest).size, BUF.length);
  assert.ok(!existsSync(dest + '.incomplete'));
  assert.ok(progress.length > 0, 'onProgress should fire at least once');
  const last = progress.at(-1);
  assert.equal(last.received, BUF.length);
  assert.equal(last.total, BUF.length);

  await closeServer(server);
  rmSync(dir, { recursive: true, force: true });
});

test('downloadAsset: resumes a truncated .incomplete file with Range', async () => {
  const dir = tmpDir();
  const server = rangeServer(BUF);
  const url = await listen(server);
  const dest = join(dir, 'file.bin');
  const already = 1024 * 1024;
  writeFileSync(dest + '.incomplete', BUF.subarray(0, already));
  const asset = { url, size: BUF.length, sha256: HASH, min_mb: 1 };

  const result = await downloadAsset(asset, dest, {
    statePath: join(dir, 'state.json'),
    backoff: () => 5,
  });

  assert.equal(result.sha256, HASH);
  assert.equal(statSync(dest).size, BUF.length);

  await closeServer(server);
  rmSync(dir, { recursive: true, force: true });
});

test('downloadAsset: a dropped connection at 60 percent resumes and completes', async () => {
  const dir = tmpDir();
  const server = rangeServer(BUF, { stallAt: Math.floor(BUF.length * 0.6) });
  const url = await listen(server);
  const dest = join(dir, 'file.bin');
  const asset = { url, size: BUF.length, sha256: HASH, min_mb: 1 };

  const progress = [];
  const result = await downloadAsset(asset, dest, {
    statePath: join(dir, 'state.json'),
    attempts: 3,
    backoff: () => 5,
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result.sha256, HASH);
  assert.equal(statSync(dest).size, BUF.length);

  await closeServer(server);
  rmSync(dir, { recursive: true, force: true });
});

test('downloadAsset: a wrong-size response fails verification and cleans up', async () => {
  const dir = tmpDir();
  const server = rangeServer(BUF);
  const url = await listen(server);
  const dest = join(dir, 'file.bin');
  // The server always sends the real (correct) buffer; the manifest just
  // claims a different size, so every attempt fails identically.
  const asset = { url, size: BUF.length + 100, sha256: HASH, min_mb: 1 };

  await assert.rejects(
    () => downloadAsset(asset, dest, { statePath: join(dir, 'state.json'), attempts: 1, backoff: () => 5 }),
    (err) => {
      assert.ok(err instanceof DownloadError);
      assert.equal(err.kind, 'verify_failed');
      assert.ok(err.userMessage.length > 0);
      return true;
    },
  );
  assert.ok(!existsSync(dest));
  assert.ok(!existsSync(dest + '.incomplete'));

  await closeServer(server);
  rmSync(dir, { recursive: true, force: true });
});

test('downloadAsset: a flipped byte fails the hash check and deletes the file', async () => {
  const dir = tmpDir();
  const corrupted = Buffer.from(BUF);
  corrupted[100] ^= 0xff;
  const server = rangeServer(corrupted);
  const url = await listen(server);
  const dest = join(dir, 'file.bin');
  // asset.sha256 is the hash of the ORIGINAL, uncorrupted buffer.
  const asset = { url, size: BUF.length, sha256: HASH, min_mb: 1 };

  await assert.rejects(
    () => downloadAsset(asset, dest, { statePath: join(dir, 'state.json'), attempts: 1, backoff: () => 5 }),
    (err) => {
      assert.equal(err.kind, 'verify_failed');
      return true;
    },
  );
  assert.ok(!existsSync(dest));
  assert.ok(!existsSync(dest + '.incomplete'));

  await closeServer(server);
  rmSync(dir, { recursive: true, force: true });
});

test('downloadAsset: 3 hash mismatches on the same asset across launches escalates to suspect_stick', async () => {
  const dir = tmpDir();
  const corrupted = Buffer.from(BUF);
  corrupted[100] ^= 0xff;
  const server = rangeServer(corrupted);
  const url = await listen(server);
  const dest = join(dir, 'file.bin');
  const statePath = join(dir, 'state.json');
  const asset = { url, size: BUF.length, sha256: HASH, min_mb: 1 };

  const kinds = [];
  for (let i = 0; i < 3; i++) {
    try {
      await downloadAsset(asset, dest, { statePath, attempts: 1, backoff: () => 5 });
    } catch (err) {
      kinds.push(err.kind);
    }
  }
  assert.deepEqual(kinds, ['verify_failed', 'verify_failed', 'suspect_stick']);

  await closeServer(server);
  rmSync(dir, { recursive: true, force: true });
});

test('downloadAsset: a pre-existing verified file is skipped (sideload)', async () => {
  const dir = tmpDir();
  const dest = join(dir, 'file.bin');
  writeFileSync(dest, BUF);
  const asset = { url: 'http://should-not-be-called.invalid/asset', size: BUF.length, sha256: HASH, min_mb: 1 };
  const request = async () => { throw new Error('the network should never be touched for a sideloaded file'); };

  const result = await downloadAsset(asset, dest, { statePath: join(dir, 'state.json'), request });
  assert.equal(result.skipped, true);
  assert.equal(result.sha256, HASH);

  rmSync(dir, { recursive: true, force: true });
});

test('downloadAsset: self-pin records the first hash when asset.sha256 is null', async () => {
  const dir = tmpDir();
  const server = rangeServer(BUF);
  const url = await listen(server);
  const port = Number(new URL(url).port);
  const dest = join(dir, 'file.bin');
  const statePath = join(dir, 'state.json');
  const asset = { url, size: BUF.length, sha256: null, min_mb: 1 };

  const first = await downloadAsset(asset, dest, { statePath, backoff: () => 5 });
  assert.equal(first.sha256, HASH);
  await closeServer(server);

  // A later download from the same url that now serves corrupted bytes
  // must fail, even though asset.sha256 is still null: the first download
  // pinned the expected hash and it now acts as the truth.
  rmSync(dest);
  const corrupted = Buffer.from(BUF);
  corrupted[0] ^= 0xff;
  const server2 = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': String(corrupted.length) });
    res.end(corrupted);
  });
  await new Promise((resolve) => server2.listen(port, '127.0.0.1', resolve));

  await assert.rejects(
    () => downloadAsset({ url, size: BUF.length, sha256: null, min_mb: 1 }, dest, {
      statePath,
      attempts: 1,
      backoff: () => 5,
    }),
    (err) => {
      assert.equal(err.kind, 'verify_failed');
      return true;
    },
  );

  await closeServer(server2);
  rmSync(dir, { recursive: true, force: true });
});

test('ggufMagicOk: passes real GGUF magic bytes and fails everything else', () => {
  const dir = tmpDir();
  const good = join(dir, 'good.gguf');
  writeFileSync(good, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(16)]));
  const bad = join(dir, 'bad.gguf');
  writeFileSync(bad, Buffer.alloc(20));
  const missing = join(dir, 'missing.gguf');

  assert.equal(ggufMagicOk(good), true);
  assert.equal(ggufMagicOk(bad), false);
  assert.equal(ggufMagicOk(missing), false);

  rmSync(dir, { recursive: true, force: true });
});

test('downloadAsset: GGUF magic check integration, pass and fail', async () => {
  const dir = tmpDir();
  const goodContent = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(60)]);
  const badContent = Buffer.concat([Buffer.from('NOPE'), Buffer.alloc(60)]);

  // Pass.
  {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': String(goodContent.length) });
      res.end(goodContent);
    });
    const url = await listen(server);
    const dest = join(dir, 'good.gguf');
    const asset = { url, size: goodContent.length, sha256: sha256(goodContent), magic: 'GGUF' };
    const result = await downloadAsset(asset, dest, { statePath: join(dir, 'state.json'), backoff: () => 5 });
    assert.equal(result.sha256, sha256(goodContent));
    await closeServer(server);
  }

  // Fail.
  {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': String(badContent.length) });
      res.end(badContent);
    });
    const url = await listen(server);
    const dest = join(dir, 'bad.gguf');
    const asset = { url, size: badContent.length, sha256: sha256(badContent), magic: 'GGUF' };
    await assert.rejects(
      () => downloadAsset(asset, dest, { statePath: join(dir, 'state2.json'), attempts: 1, backoff: () => 5 }),
      (err) => {
        assert.equal(err.kind, 'verify_failed');
        return true;
      },
    );
    assert.ok(!existsSync(dest));
    await closeServer(server);
  }

  rmSync(dir, { recursive: true, force: true });
});

test('verifyAsset and reverifyAll check without downloading', async () => {
  const dir = tmpDir();
  const good = join(dir, 'good.bin');
  writeFileSync(good, BUF);
  const bad = join(dir, 'bad.bin');
  const corrupted = Buffer.from(BUF);
  corrupted[0] ^= 0xff;
  writeFileSync(bad, corrupted);

  const asset = { url: 'http://x.invalid/a', size: BUF.length, sha256: HASH, min_mb: 1 };

  const okResult = await verifyAsset(good, asset);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.sha256, HASH);

  const badResult = await verifyAsset(bad, asset);
  assert.equal(badResult.ok, false);
  assert.equal(badResult.reason, 'hash_mismatch');

  const missingResult = await verifyAsset(join(dir, 'missing.bin'), asset);
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reason, 'missing');

  const allOk = await reverifyAll([{ path: good, asset }]);
  assert.deepEqual(allOk, { ok: true });

  const allBad = await reverifyAll([{ path: good, asset }, { path: bad, asset }]);
  assert.equal(allBad.ok, false);
  assert.equal(allBad.path, bad);
  assert.equal(allBad.reason, 'hash_mismatch');

  rmSync(dir, { recursive: true, force: true });
});

test('diskFreePreflight reports ok true for a tiny need and false for an impossible one', async () => {
  const dir = tmpDir();
  const small = await diskFreePreflight(dir, 1);
  assert.equal(small.ok, true);
  assert.ok(small.free > 0);
  assert.equal(small.needed, 1);

  const huge = await diskFreePreflight(dir, Number.MAX_SAFE_INTEGER);
  assert.equal(huge.ok, false);

  rmSync(dir, { recursive: true, force: true });
});

test('bytesNeeded sums only assets not already present', () => {
  const manifest = [
    { path: 'a', size: 10 },
    { path: 'b', size: 20 },
    { path: 'c', size: 30 },
  ];
  assert.equal(bytesNeeded(manifest, ['b']), 40);
  assert.equal(bytesNeeded(manifest, []), 60);
  assert.equal(bytesNeeded(manifest, ['a', 'b', 'c']), 0);
});
