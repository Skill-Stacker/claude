import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../app/server.js';
import { sdAsset, binaryNames, extractZip, ensureSdcpp, createSdServer } from '../app/lib/studio/sdcpp.js';
import { createImages, wireImages } from '../app/lib/studio/images.js';
import { downloadAsset as realDownloadAsset } from '../app/lib/downloads.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_SD_SERVER = join(HERE, '..', 'tools', 'fake-sd-server.mjs');
const REPO_ROOT = join(HERE, '..');

function tmpDir(prefix = 'stickos-images-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makePaths(base) {
  return {
    base,
    bin: join(base, 'bin'),
    models: join(base, 'models'),
    state: join(base, 'state'),
  };
}

let nextPort = 47420;
function testPort() {
  nextPort += 1;
  return nextPort;
}

// ---------------------------------------------------------------------------
// A tiny hand-rolled STORE-method zip writer, so tests can build a fake
// stable-diffusion.cpp release archive without a zip library (there isn't
// one vendored in this app; see the header comment in sdcpp.js for why).
// Mirrors the parsing sdcpp.js's extractZip() does, in reverse.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data: Buffer, mode?: number (unix perms, e.g. 0o755) }]
function makeTestZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); // method: store
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([localHeader, nameBuf, data]);
    localParts.push(localEntry);

    const externalAttr = (((entry.mode || 0o644) << 16) >>> 0) >>> 0;
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4); // version made by: unix
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(externalAttr, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([centralHeader, nameBuf]));

    offset += localEntry.length;
  }
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// A manifest carrying just enough of studio.sdcpp for these tests: one
// pinned asset per platform, matching the shape of the real manifest.json.
function makeManifest(assetUrl) {
  return {
    studio: {
      sdcpp: {
        tag: 'master-test-0000000',
        binaries: { sdServer: 'sd-server', sdCli: 'sd-cli' },
        assets: {
          'win-cpu-x64': { platform: 'win32', arch: 'x64', gpu: 'cpu', url: assetUrl, size: null, sha256: null },
          'win-vulkan-x64': { platform: 'win32', arch: 'x64', gpu: 'vulkan', url: assetUrl, size: null, sha256: null },
          'darwin-arm64': { platform: 'darwin', arch: 'arm64', gpu: 'cpu', url: assetUrl, size: null, sha256: null },
          'linux-cpu-x64': { platform: 'linux', arch: 'x64', gpu: 'cpu', url: assetUrl, size: null, sha256: null },
        },
        model: { sd15: { id: 'sd15', label: 'Stable Diffusion 1.5 (small)', url: null, size: null, sha256: null, notes: 'set after a live check' } },
      },
    },
  };
}

// A downloads.downloadAsset stand-in that ignores the network entirely and
// just writes prebuilt zip bytes to destPath, counting calls so tests can
// assert a second ensureSdcpp() call skips the download.
function fakeDownloads(zipBytes) {
  let calls = 0;
  return {
    calls: () => calls,
    downloadAsset: async (asset, destPath) => {
      calls += 1;
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, zipBytes);
      return { path: destPath, sha256: 'fake-sha', skipped: false };
    },
  };
}

// Builds a fake sd-server/sd-cli pair (plain text stand-ins; extractZip
// does not care what is inside a file, only the zip structure and mode
// bits around it) zipped up the way the real release assets are shaped:
// the two binaries loose at the archive root.
function fakeSdcppZip(platform) {
  const suffix = platform === 'win32' ? '.exe' : '';
  return makeTestZip([
    { name: `sd-server${suffix}`, data: Buffer.from('#!/bin/sh\necho fake sd-server\n'), mode: 0o755 },
    { name: `sd-cli${suffix}`, data: Buffer.from('#!/bin/sh\necho fake sd-cli\n'), mode: 0o755 },
    { name: 'readme.txt', data: Buffer.from('fake release notes'), mode: 0o644 },
  ]);
}

// Wraps fake-sd-server.mjs as the `spawn` sdcpp.js/images.js are given, the
// same trick tests/engine.test.js uses for its fake engine: forward every
// arg createSdServer built (so --listen-port etc. land on the fake) and
// tack on test-only knobs.
function fakeSpawn({ delayMs = 40, fail = false } = {}) {
  return (exe, args) => {
    const extra = ['--delay-ms', String(delayMs)];
    if (fail) extra.push('--fail');
    return nodeSpawn(process.execPath, [FAKE_SD_SERVER, ...args, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// sdAsset / binaryNames: pure, no filesystem or network
// ---------------------------------------------------------------------------

describe('sdAsset', () => {
  const manifest = makeManifest('https://example.invalid/sd.zip');

  test('picks the cpu build by default', () => {
    const asset = sdAsset(manifest, 'win32', 'x64', {});
    assert.equal(asset.gpu, 'cpu');
  });

  test('picks vulkan only when asked, and only where pinned', () => {
    const vulkan = sdAsset(manifest, 'win32', 'x64', { gpu: true });
    assert.equal(vulkan.gpu, 'vulkan');

    // No vulkan build pinned for darwin in this fixture: falls back to cpu
    // rather than returning nothing.
    const darwinGpu = sdAsset(manifest, 'darwin', 'arm64', { gpu: true });
    assert.equal(darwinGpu.gpu, 'cpu');
  });

  test('returns null for a platform nothing is pinned for', () => {
    assert.equal(sdAsset(manifest, 'freebsd', 'x64', {}), null);
  });

  test('binaryNames appends .exe only on win32', () => {
    assert.deepEqual(binaryNames(manifest, 'win32'), { sdServer: 'sd-server.exe', sdCli: 'sd-cli.exe' });
    assert.deepEqual(binaryNames(manifest, 'linux'), { sdServer: 'sd-server', sdCli: 'sd-cli' });
  });
});

// ---------------------------------------------------------------------------
// extractZip
// ---------------------------------------------------------------------------

describe('extractZip', () => {
  test('extracts entries and preserves the executable bit', () => {
    const dest = join(tmpDir(), 'out');
    const zip = fakeSdcppZip('linux');
    const zipPath = join(tmpDir(), 'test.zip');
    writeFileSync(zipPath, zip);

    extractZip(zipPath, dest);

    assert.ok(existsSync(join(dest, 'sd-server')));
    assert.ok(existsSync(join(dest, 'sd-cli')));
    assert.ok(existsSync(join(dest, 'readme.txt')));
    assert.equal(readFileSync(join(dest, 'readme.txt'), 'utf8'), 'fake release notes');

    const mode = statSync(join(dest, 'sd-server')).mode & 0o777;
    assert.equal(mode, 0o755);
  });

  test('refuses to write outside destDir (zip slip)', () => {
    const dest = join(tmpDir(), 'out');
    const zip = makeTestZip([
      { name: '../../escape.txt', data: Buffer.from('nope'), mode: 0o644 },
      { name: 'safe.txt', data: Buffer.from('ok'), mode: 0o644 },
    ]);
    const zipPath = join(tmpDir(), 'slip.zip');
    writeFileSync(zipPath, zip);

    extractZip(zipPath, dest);

    assert.ok(existsSync(join(dest, 'safe.txt')));
    assert.ok(!existsSync(join(tmpDir(), 'escape.txt')));
  });
});

// ---------------------------------------------------------------------------
// ensureSdcpp: fake downloader, no network
// ---------------------------------------------------------------------------

describe('ensureSdcpp', () => {
  test('downloads and extracts once, then skips on a second call', async () => {
    const base = tmpDir();
    const paths = makePaths(base);
    const zip = fakeSdcppZip('linux');
    const manifest = makeManifest('https://example.invalid/sd.zip');
    const downloads = fakeDownloads(zip);
    const progressEvents = [];

    const first = await ensureSdcpp({
      paths,
      manifest,
      downloads,
      platform: 'linux',
      arch: 'x64',
      onProgress: (p) => progressEvents.push(p),
    });
    assert.ok(existsSync(first.sdServer));
    assert.ok(existsSync(first.sdCli));
    assert.equal(first.downloaded, true);
    assert.equal(downloads.calls(), 1);

    const second = await ensureSdcpp({ paths, manifest, downloads, platform: 'linux', arch: 'x64' });
    assert.equal(second.downloaded, false);
    assert.equal(downloads.calls(), 1); // not called again: the binaries are already there
  });

  test('throws plainly when nothing is pinned for this platform', async () => {
    const paths = makePaths(tmpDir());
    const manifest = makeManifest('https://example.invalid/sd.zip');
    const downloads = fakeDownloads(fakeSdcppZip('linux'));
    await assert.rejects(
      () => ensureSdcpp({ paths, manifest, downloads, platform: 'freebsd', arch: 'x64' }),
      /no stable-diffusion\.cpp build is pinned/,
    );
  });
});

// ---------------------------------------------------------------------------
// createSdServer + the fake sd-server process
// ---------------------------------------------------------------------------

describe('createSdServer', () => {
  test('txt2img returns real PNG bytes', async () => {
    const server = createSdServer({ exe: 'unused', modelPath: '/fake/model.gguf', spawn: fakeSpawn({ delayMs: 30 }) });
    try {
      const statuses = [];
      const png = await server.txt2img({ prompt: 'a red fox', steps: 10, cfg: 7, seed: 1, onStatus: (s) => statuses.push(s) });
      assert.ok(Buffer.isBuffer(png));
      assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
      assert.ok(statuses.includes('starting'));
      assert.ok(statuses.includes('completed'));
    } finally {
      await server.stop();
    }
  });

  test('never runs two generations at once', async () => {
    const server = createSdServer({ exe: 'unused', modelPath: '/fake/model.gguf', spawn: fakeSpawn({ delayMs: 80 }) });
    try {
      const first = server.txt2img({ prompt: 'first' });
      await assert.rejects(() => server.txt2img({ prompt: 'second' }), /already running/);
      await first;
    } finally {
      await server.stop();
    }
  });

  test('a failed job rejects with the server error message', async () => {
    const server = createSdServer({ exe: 'unused', modelPath: '/fake/model.gguf', spawn: fakeSpawn({ delayMs: 20, fail: true }) });
    try {
      await assert.rejects(() => server.txt2img({ prompt: 'a red fox' }), /fake sd-server was told to fail/);
    } finally {
      await server.stop();
    }
  });

  test('cancelling through the signal aborts before the job would finish', async () => {
    const server = createSdServer({ exe: 'unused', modelPath: '/fake/model.gguf', spawn: fakeSpawn({ delayMs: 2000 }) });
    try {
      const controller = new AbortController();
      const started = Date.now();
      const call = server.txt2img({ prompt: 'a red fox', signal: controller.signal });
      setTimeout(() => controller.abort(), 60);
      await assert.rejects(() => call, /AbortError|cancelled/i);
      assert.ok(Date.now() - started < 1500, 'should not have waited for the full fake delay');
    } finally {
      await server.stop();
    }
  });

  test('stops itself once idle, using an injected clock', async () => {
    let fakeNow = 1_000_000;
    const server = createSdServer({
      exe: 'unused',
      modelPath: '/fake/model.gguf',
      spawn: fakeSpawn({ delayMs: 20 }),
      idleMs: 100,
      idleCheckMs: 20,
      now: () => fakeNow,
    });
    try {
      await server.txt2img({ prompt: 'a red fox' });
      assert.equal(server.isRunning(), true);

      fakeNow += 500; // well past idleMs
      // idleCheckMs uses real timers; give it a couple of real ticks.
      await new Promise((r) => setTimeout(r, 150));

      assert.equal(server.isRunning(), false);
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// wireImages on a real server: status, setup, model, generate, gallery,
// the served image route (with a path-traversal attempt), and cancel.
// ---------------------------------------------------------------------------

describe('wireImages on a real server', () => {
  function makeApp({ delayMs = 30, fail = false } = {}) {
    const base = tmpDir();
    const paths = makePaths(base);
    const manifest = makeManifest('https://example.invalid/sd.zip');
    const downloads = fakeDownloads(fakeSdcppZip(process.platform));
    const images = createImages({
      paths,
      manifest,
      downloads,
      spawn: fakeSpawn({ delayMs, fail }),
    });
    return { paths, manifest, images };
  }

  async function withServer(fn, opts) {
    const app = await startServer({ baseDir: tmpDir(), port: testPort() });
    const { paths, images } = makeApp(opts);
    wireImages(app, { images });
    try {
      await fn({ app, paths, images });
    } finally {
      await images.stopServer();
      await app.close();
    }
  }

  test('GET /api/images/status is honest before anything is set up', async () => {
    await withServer(async ({ app }) => {
      const res = await fetch(`${app.origin}/api/images/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.binary.present, false);
      assert.equal(body.model.present, false);
      assert.match(body.model.note, /no picture model is pinned yet/i);
      assert.equal(body.pinned, true);
    });
  });

  test('POST /api/images/setup requires the token, then downloads and extracts', async () => {
    await withServer(async ({ app }) => {
      const noToken = await fetch(`${app.origin}/api/images/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      assert.equal(noToken.status, 401);

      const res = await fetch(`${app.origin}/api/images/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: '{}',
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.binary.present, true);
    });
  });

  test('POST /api/images/model rejects a path outside models/, accepts one inside it', async () => {
    await withServer(async ({ app, paths }) => {
      const outside = await fetch(`${app.origin}/api/images/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ path: '../../etc/passwd' }),
      });
      assert.equal(outside.status, 400);

      mkdirSync(paths.models, { recursive: true });
      writeFileSync(join(paths.models, 'sd15.gguf'), 'not a real model, just bytes for the test');

      const inside = await fetch(`${app.origin}/api/images/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ path: 'sd15.gguf' }),
      });
      assert.equal(inside.status, 200);
      const body = await inside.json();
      assert.equal(body.model.present, true);
      assert.equal(body.model.path, join(paths.models, 'sd15.gguf'));
    });
  });

  test('generate saves a PNG, writes a gallery entry with the measured time, and serves it back', async () => {
    await withServer(async ({ app, paths }) => {
      await fetch(`${app.origin}/api/images/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token } });
      mkdirSync(paths.models, { recursive: true });
      writeFileSync(join(paths.models, 'sd15.gguf'), 'fake model bytes');
      await fetch(`${app.origin}/api/images/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ path: 'sd15.gguf' }),
      });

      const genRes = await fetch(`${app.origin}/api/images/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ prompt: 'a red fox in the snow', size: '512x512', steps: 8, seed: 42 }),
      });
      assert.equal(genRes.status, 200);
      const text = await genRes.text();
      assert.match(text, /event: done/);
      const doneLine = text.split('\n\n').find((b) => b.includes('event: done'));
      const doneData = JSON.parse(doneLine.split('data: ')[1]);
      assert.ok(doneData.file);
      assert.equal(doneData.url, `/studio/images/${doneData.file}`);
      assert.equal(typeof doneData.seconds, 'number');

      const gallery = JSON.parse(readFileSync(join(paths.base, 'studio', 'images', 'gallery.json'), 'utf8'));
      assert.equal(gallery.length, 1);
      assert.equal(gallery[0].prompt, 'a red fox in the snow');
      assert.equal(typeof gallery[0].seconds, 'number');

      const galleryRes = await fetch(`${app.origin}/api/images/gallery`);
      const galleryBody = await galleryRes.json();
      assert.equal(galleryBody.images.length, 1);
      assert.equal(galleryBody.images[0].file, doneData.file);

      const imgRes = await fetch(`${app.origin}${doneData.url}`);
      assert.equal(imgRes.status, 200);
      assert.equal(imgRes.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await imgRes.arrayBuffer());
      assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE);

      const traversal = await fetch(`${app.origin}/studio/images/${encodeURIComponent('../../gallery.json')}`);
      assert.equal(traversal.status, 404);
      const traversal2 = await fetch(`${app.origin}/studio/images/gallery.json`);
      assert.equal(traversal2.status, 404);
    }, { delayMs: 30 });
  });

  test('cancel mid-generation is reported on the SSE stream', async () => {
    await withServer(async ({ app, paths }) => {
      await fetch(`${app.origin}/api/images/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token } });
      mkdirSync(paths.models, { recursive: true });
      writeFileSync(join(paths.models, 'sd15.gguf'), 'fake model bytes');
      await fetch(`${app.origin}/api/images/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ path: 'sd15.gguf' }),
      });

      const genPromise = fetch(`${app.origin}/api/images/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ prompt: 'a slow fox', size: '512x512', steps: 8 }),
      });

      await new Promise((r) => setTimeout(r, 60));
      const cancelRes = await fetch(`${app.origin}/api/images/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
      });
      assert.equal((await cancelRes.json()).cancelled, true);

      const text = await (await genPromise).text();
      assert.match(text, /event: error/);
      assert.match(text, /cancelled/i);
    }, { delayMs: 2000 });
  });

  test('POST /api/images/cancel with nothing running answers honestly', async () => {
    await withServer(async ({ app }) => {
      const res = await fetch(`${app.origin}/api/images/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
      });
      assert.equal((await res.json()).cancelled, false);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration smoke: a real stable-diffusion.cpp Linux CPU build, downloaded
// for real. Skipped (not failed) if the network is not reachable from here.
// ---------------------------------------------------------------------------

describe('real stable-diffusion.cpp build (integration smoke)', () => {
  test('downloads the pinned Linux CPU build and runs sd-server --help', async (t) => {
    const manifestPath = join(REPO_ROOT, 'app', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const paths = makePaths(tmpDir('stickos-images-smoke-'));

    let result;
    try {
      result = await ensureSdcpp({
        paths,
        manifest,
        downloads: { downloadAsset: realDownloadAsset },
        platform: 'linux',
        arch: 'x64',
      });
    } catch (err) {
      t.skip(`could not download the real build from here: ${(err && err.message) || err}`);
      return;
    }

    assert.ok(existsSync(result.sdServer));
    assert.ok(existsSync(result.sdCli));
    try {
      chmodSync(result.sdServer, 0o755);
      chmodSync(result.sdCli, 0o755);
    } catch {
      // already executable on most platforms; harmless if this no-ops
    }

    const help = await new Promise((resolvePromise) => {
      nodeExecFile(
        result.sdServer,
        ['--help'],
        { timeout: 15000, env: { ...process.env, LD_LIBRARY_PATH: dirname(result.sdServer) } },
        (err, stdout, stderr) => resolvePromise({ err, stdout, stderr }),
      );
    });
    assert.equal(help.err, null, help.err && help.err.message);
    assert.match(help.stdout, /Usage:.*sd-server/);
  });
});
