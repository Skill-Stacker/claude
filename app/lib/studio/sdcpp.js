// Downloads, extracts and supervises stable-diffusion.cpp's sd-server, the
// engine "Make a Picture" talks to. Everything here mirrors the shape of
// app/lib/engine.js on purpose (verified download, a supervised local HTTP
// server, an idle timeout) since that file is the reference for how a
// spawned local server is meant to behave in this app.
//
// The pinned release ships as a .zip on every platform (see manifest.json's
// studio.sdcpp block): sd-server / sd-cli plus a pile of shared libraries
// (.so on Linux, .dll on Windows) that must sit next to them in the same
// folder, since the binaries load them by relative path. There is no zip
// library vendored in this app (see CLAUDE.md: vendored npm packages only
// when hand-written would be materially worse, and a plain DEFLATE zip is
// not that), so extractZip() below reads the End Of Central Directory
// record and central directory by hand and inflates each entry with
// node:zlib. It has no ZIP64 support; every pinned asset here is well under
// the 4 GiB point where that would matter.
//
// Usage:
//   import { ensureSdcpp, createSdServer, sdAsset } from './sdcpp.js';
//   const { sdServer, sdCli } = await ensureSdcpp({ paths, manifest, downloads, onProgress });
//   const server = createSdServer({ exe: sdServer, modelPath, spawn, fetch, log });
//   const png = await server.txt2img({ prompt: 'a red fox', steps: 20, cfg: 7, seed: -1 });
//   await server.stop();
//
// sd-server's HTTP API (examples/server/api.md in the leejet/
// stable-diffusion.cpp source, verified against a real build of tag
// master-841-6b3edaa): the OpenAI-compatible POST /v1/images/generations
// exists, but its top-level fields are only prompt/n/size/output_format, so
// negative prompt, steps, cfg and seed would have to be smuggled in through
// a <sd_cpp_extra_args> block glued onto the prompt string. The native
// sdcpp API gives every one of those fields a real top-level (or one-level-
// nested) place in the request body instead, so this file talks to that
// one: POST /sdcpp/v1/img_gen submits an async job (202, { id }), GET
// /sdcpp/v1/jobs/{id} is polled for status until completed/failed/
// cancelled, and POST /sdcpp/v1/jobs/{id}/cancel stops a job in flight. A
// completed job's result.images[0].b64_json is the PNG, base64-encoded.

import { spawn as nodeSpawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import zlib from 'node:zlib';
import { findFreePort } from '../security.js';

const DEFAULT_PORT_BASE = 1234;
const DEFAULT_PORT_WALK = 4;
const DEFAULT_IDLE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_IDLE_CHECK_MS = 15_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_START_POLL_MS = 250;
const DEFAULT_JOB_POLL_MS = 350;

// ---------------------------------------------------------------------------
// Picking the right asset and binary names for this machine
// ---------------------------------------------------------------------------

// Picks the CPU build by default; Vulkan only when the caller asks for it
// (gpu: true) and a Vulkan build is actually pinned for this platform (only
// Windows, today: see manifest.json). Returns null when nothing is pinned
// for platform/arch at all.
export function sdAsset(manifest, platform, arch, { gpu = false } = {}) {
  const assets = manifest?.studio?.sdcpp?.assets || {};
  const entries = Object.entries(assets).map(([key, a]) => ({ key, ...a }));
  const forPlatform = entries.filter((a) => a.platform === platform);
  if (!forPlatform.length) return null;
  const archMatches = forPlatform.filter((a) => !a.arch || a.arch === arch);
  const pool = archMatches.length ? archMatches : forPlatform;
  if (gpu) {
    const vulkan = pool.find((a) => a.gpu === 'vulkan');
    if (vulkan) return vulkan;
  }
  return pool.find((a) => a.gpu === 'cpu') || pool[0] || null;
}

export function binaryNames(manifest, platform = process.platform) {
  const bin = manifest?.studio?.sdcpp?.binaries || { sdServer: 'sd-server', sdCli: 'sd-cli' };
  const suffix = platform === 'win32' ? '.exe' : '';
  return { sdServer: bin.sdServer + suffix, sdCli: bin.sdCli + suffix };
}

export function sdcppDir(paths) {
  return join(paths.bin, 'sdcpp');
}

export function sdcppBinaryPaths(paths, manifest, platform = process.platform) {
  const dir = sdcppDir(paths);
  const names = binaryNames(manifest, platform);
  return { sdServer: join(dir, names.sdServer), sdCli: join(dir, names.sdCli) };
}

// ---------------------------------------------------------------------------
// Zip extraction (DEFLATE and store only, no ZIP64)
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buf) {
  const minLen = 22;
  const maxCommentLen = 65535;
  const start = Math.max(0, buf.length - minLen - maxCommentLen);
  for (let i = buf.length - minLen; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('not a zip file (no end-of-central-directory record found)');
}

// Same containment idea as security.js's safeJoin, adapted for zip entry
// names (which use '/' always, and may be crafted to escape destDir with
// '../' segments, the "zip slip" attack) rather than URL paths.
function safeExtractPath(destDir, entryName) {
  const cleaned = entryName.replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('\0')) return null;
  const rootResolved = resolve(destDir);
  const resolved = resolve(rootResolved, cleaned);
  const withSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  if (resolved !== rootResolved && !resolved.startsWith(withSep)) return null;
  return resolved;
}

// Extracts every entry of a plain (non-ZIP64) zip file into destDir,
// preserving the executable bit for entries whose external attributes say
// a Unix build marked them +x (sd-server, sd-cli, and nothing else in the
// pinned archives). Entries that would escape destDir are skipped rather
// than thrown on, matching safeJoin's own "refuse, don't crash" spirit.
export function extractZip(zipPath, destDir) {
  const buf = readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(buf);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  mkdirSync(destDir, { recursive: true });

  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error('malformed zip central directory');
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttr = buf.readUInt32LE(offset + 38);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    offset += 46 + nameLen + extraLen + commentLen;

    const targetPath = safeExtractPath(destDir, name);
    if (!targetPath) continue;

    if (name.endsWith('/')) {
      mkdirSync(targetPath, { recursive: true });
      continue;
    }

    if (buf.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`malformed zip local header for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressedData = buf.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) {
      data = compressedData;
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
    if (data.length !== uncompressedSize) {
      throw new Error(`zip entry ${name} extracted to the wrong size`);
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, data);

    const unixMode = (externalAttr >>> 16) & 0o777;
    if (unixMode & 0o111) {
      try {
        chmodSync(targetPath, unixMode);
      } catch {
        // best effort; the explicit chmod +x below on sd-server/sd-cli
        // is what actually matters for running the thing
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ensureSdcpp: download (if needed) and extract the pinned build
// ---------------------------------------------------------------------------

export async function ensureSdcpp({
  paths,
  manifest,
  downloads,
  onProgress,
  platform = process.platform,
  arch = process.arch,
  gpu = false,
} = {}) {
  const cfg = manifest?.studio?.sdcpp;
  if (!cfg || !cfg.tag) {
    throw new Error('stable-diffusion.cpp is not pinned in manifest.json yet');
  }
  const asset = sdAsset(manifest, platform, arch, { gpu });
  if (!asset) {
    throw new Error(`no stable-diffusion.cpp build is pinned for ${platform}/${arch}`);
  }

  const dir = sdcppDir(paths);
  const names = binaryNames(manifest, platform);
  const sdServer = join(dir, names.sdServer);
  const sdCli = join(dir, names.sdCli);

  if (existsSync(sdServer) && existsSync(sdCli)) {
    return { sdServer, sdCli, downloaded: false, asset };
  }

  mkdirSync(dir, { recursive: true });
  const zipName = asset.url.split('/').pop();
  const zipPath = join(dir, '_download', zipName);

  const result = await downloads.downloadAsset(asset, zipPath, { onProgress });

  extractZip(zipPath, dir);

  if (platform !== 'win32') {
    for (const name of [names.sdServer, names.sdCli]) {
      try {
        chmodSync(join(dir, name), 0o755);
      } catch {
        // extractZip already tried to carry over the archive's own
        // executable bit; this is only a backstop.
      }
    }
  }

  if (!existsSync(sdServer) || !existsSync(sdCli)) {
    throw new Error('the stable-diffusion.cpp archive did not contain the expected sd-server/sd-cli binaries');
  }

  return { sdServer, sdCli, downloaded: true, asset, sha256: result.sha256, size: asset.size, url: asset.url };
}

// ---------------------------------------------------------------------------
// createSdServer: spawn, wait for it to answer, run one job at a time,
// stop it after it sits idle
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function abortError(message) {
  const err = new Error(message || 'The generation was cancelled.');
  err.name = 'AbortError';
  return err;
}

export function createSdServer({
  exe,
  modelPath,
  port,
  spawn = nodeSpawn,
  fetch = globalThis.fetch,
  log,
  idleMs = DEFAULT_IDLE_MS,
  idleCheckMs = DEFAULT_IDLE_CHECK_MS,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  now = () => Date.now(),
  extraArgs = [],
} = {}) {
  if (!exe) throw new Error('createSdServer needs exe');
  if (!modelPath) throw new Error('createSdServer needs modelPath');

  let child = null;
  let base = null;
  let busy = false;
  let lastActivity = now();
  let idleTimer = null;
  let starting = null;

  function logLine(text) {
    try {
      log?.(text);
    } catch {
      // logging must never throw
    }
  }

  function touch() {
    lastActivity = now();
  }

  function disarmIdleTimer() {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer() {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (!child || busy) return;
      if (now() - lastActivity >= idleMs) {
        logLine('sd-server: idle, stopping');
        stop().catch(() => {});
      }
    }, idleCheckMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  async function waitReady(chosenPort, deadline) {
    for (;;) {
      if (!child) throw new Error('sd-server exited before it became ready');
      try {
        const res = await fetch(`http://127.0.0.1:${chosenPort}/`);
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      if (now() >= deadline) throw new Error('sd-server did not answer in time');
      await sleep(DEFAULT_START_POLL_MS);
    }
  }

  async function start() {
    if (base) return base;
    if (starting) return starting;
    starting = (async () => {
      const chosenPort = port || (await findFreePort(DEFAULT_PORT_BASE, DEFAULT_PORT_WALK));
      const args = ['-m', modelPath, '-l', '127.0.0.1', '--listen-port', String(chosenPort), ...extraArgs];
      logLine(`sd-server: starting on 127.0.0.1:${chosenPort}`);
      const proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child = proc;
      proc.stdout?.on('data', (d) => logLine(String(d)));
      proc.stderr?.on('data', (d) => logLine(String(d)));
      proc.once('exit', () => {
        child = null;
        base = null;
        disarmIdleTimer();
      });
      proc.once('error', () => {
        child = null;
        base = null;
      });
      try {
        await waitReady(chosenPort, now() + startTimeoutMs);
      } catch (err) {
        await stop();
        throw err;
      }
      base = `http://127.0.0.1:${chosenPort}`;
      touch();
      armIdleTimer();
      return base;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  async function stop() {
    disarmIdleTimer();
    const proc = child;
    child = null;
    base = null;
    if (!proc) return;
    await new Promise((resolvePromise) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolvePromise();
      };
      proc.once('exit', finish);
      try {
        proc.kill('SIGTERM');
      } catch {
        finish();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 5000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    });
  }

  async function txt2img({
    prompt,
    negative = '',
    width = 512,
    height = 512,
    steps = 20,
    cfg = 7,
    seed = -1,
    signal,
    onStatus,
  } = {}) {
    if (!prompt || !String(prompt).trim()) throw new Error('a prompt is required');
    if (busy) throw new Error('a generation is already running');
    busy = true;
    let lastStatus = null;
    const report = (jobStatus) => {
      if (jobStatus === lastStatus) return;
      lastStatus = jobStatus;
      try {
        onStatus?.(jobStatus);
      } catch {
        // a bad progress callback must never break generation
      }
    };
    try {
      report('starting');
      const url = await start();
      touch();

      const body = {
        prompt,
        negative_prompt: negative || '',
        width,
        height,
        seed: Number.isFinite(seed) ? seed : -1,
        batch_count: 1,
        sample_params: {
          sample_steps: steps,
          guidance: { txt_cfg: cfg },
        },
        output_format: 'png',
      };

      const submitRes = await fetch(`${url}/sdcpp/v1/img_gen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (submitRes.status !== 202) {
        const text = await submitRes.text().catch(() => '');
        throw new Error(`sd-server rejected the job (status ${submitRes.status}): ${text || 'no detail'}`);
      }
      const submitted = await submitRes.json();
      const jobId = submitted.id;
      if (!jobId) throw new Error('sd-server did not return a job id');

      const onAbort = () => {
        fetch(`${url}/sdcpp/v1/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }).catch(() => {});
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      try {
        for (;;) {
          if (signal?.aborted) throw abortError();
          const jobRes = await fetch(`${url}/sdcpp/v1/jobs/${encodeURIComponent(jobId)}`, { signal });
          if (jobRes.status === 404 || jobRes.status === 410) {
            throw new Error('sd-server lost track of the generation job');
          }
          const job = await jobRes.json();
          if (job.status === 'completed') {
            const image = job.result?.images?.[0];
            if (!image?.b64_json) throw new Error('sd-server finished but returned no image');
            touch();
            report('completed');
            return Buffer.from(image.b64_json, 'base64');
          }
          if (job.status === 'failed') {
            throw new Error((job.error && job.error.message) || 'image generation failed');
          }
          if (job.status === 'cancelled') {
            throw abortError();
          }
          report(job.status); // 'queued' or 'generating'
          await sleep(DEFAULT_JOB_POLL_MS);
        }
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    } finally {
      busy = false;
    }
  }

  return {
    start,
    stop,
    txt2img,
    isRunning: () => !!child,
    isBusy: () => busy,
    baseUrl: () => base,
    get pid() {
      return child ? child.pid : null;
    },
  };
}
