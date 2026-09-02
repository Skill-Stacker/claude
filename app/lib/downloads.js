// Resumable, verified downloads for multi-gigabyte assets onto a possibly
// fake-capacity USB stick. A fake-capacity stick reports the right size but
// silently corrupts bytes, so every download is hashed and every hash
// mismatch is remembered across launches.
//
// Usage:
//   import { downloadAsset } from './downloads.js';
//   const result = await downloadAsset(
//     { url, size, sha256, min_mb, magic: 'GGUF' },
//     '/stick/models/qwen.gguf',
//     { onProgress: (p) => ..., statePath: '/stick/state/download-manifest.json' },
//   );

import {
  existsSync,
  statSync,
  createWriteStream,
  createReadStream,
  renameSync,
  unlinkSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { readFile, writeFile, mkdir, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as net from './net.js';
import { NetError, classifyError } from './net.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const DOWNLOAD_USER_MESSAGES = {
  verify_failed:
    'This file did not match what Scout expected, even after trying again. Scout removed it so it can start fresh.',
  suspect_stick:
    'This file keeps arriving damaged the same way. The USB stick itself may be losing data. A different stick may fix it.',
  disk_full:
    'There is not enough free space left on the stick for this file.',
};

export class DownloadError extends Error {
  constructor(kind, message, { cause, userMessage } = {}) {
    super(message || kind);
    this.name = 'DownloadError';
    this.kind = kind;
    if (cause !== undefined) this.cause = cause;
    this.userMessage = userMessage || DOWNLOAD_USER_MESSAGES[kind] || 'The download failed. Scout will try again.';
  }
}

function toDownloadError(netErr) {
  return new DownloadError(netErr.kind, netErr.message, { cause: netErr, userMessage: netErr.userMessage });
}

// Marks a completed transfer that failed its post-download checks (size,
// magic bytes, or hash), as opposed to a network-level failure.
class VerifyFailure extends Error {
  constructor(reason, sha256 = null) {
    super(`verification failed: ${reason}`);
    this.reason = reason;
    this.sha256 = sha256;
  }
}

// ---------------------------------------------------------------------------
// Verification (no network)
// ---------------------------------------------------------------------------

export function ggufMagicOk(path) {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(4);
      const n = readSync(fd, buf, 0, 4, 0);
      return n === 4 && buf.toString('ascii') === 'GGUF';
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

// Shared by verifyAsset (no pin awareness) and downloadAsset (which passes
// the self-pinned hash on from its state file, if there is one).
async function checkFile(path, asset, pinnedSha256) {
  if (!existsSync(path)) return { ok: false, reason: 'missing', sha256: null };
  const stat = statSync(path);
  if (asset.min_mb != null && stat.size < asset.min_mb * 1024 * 1024) {
    return { ok: false, reason: 'too_small', sha256: null };
  }
  if (asset.size != null && stat.size !== asset.size) {
    return { ok: false, reason: 'size_mismatch', sha256: null };
  }
  if (asset.magic === 'GGUF' && !ggufMagicOk(path)) {
    return { ok: false, reason: 'bad_magic', sha256: null };
  }
  const sha256 = await hashFile(path);
  const expected = asset.sha256 || pinnedSha256 || null;
  if (expected && sha256.toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, reason: 'hash_mismatch', sha256 };
  }
  return { ok: true, reason: null, sha256 };
}

// Checks a file already on disk against an asset's rules, no download.
export async function verifyAsset(path, asset) {
  return checkFile(path, asset, null);
}

// Checks a list of { path, asset } pairs, stopping at the first failure.
export async function reverifyAll(entries) {
  for (const { path, asset } of entries) {
    const result = await verifyAsset(path, asset);
    if (!result.ok) return { ok: false, path, reason: result.reason, sha256: result.sha256 };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Disk space
// ---------------------------------------------------------------------------

export async function diskFreePreflight(dir, neededBytes) {
  await mkdir(dir, { recursive: true }).catch(() => {});
  const stats = await statfs(dir);
  const free = stats.bavail * stats.bsize;
  return { ok: free >= neededBytes, free, needed: neededBytes };
}

// Sums the size of every manifest asset whose path is not already present.
// manifestAssets: [{ path, size }]. existingPaths: iterable of paths that
// already exist on disk (or should otherwise count as present).
export function bytesNeeded(manifestAssets, existingPaths) {
  const present = new Set(existingPaths);
  let total = 0;
  for (const asset of manifestAssets) {
    if (!present.has(asset.path)) total += asset.size || 0;
  }
  return total;
}

// ---------------------------------------------------------------------------
// State file (per-asset attempts, last error, self-pinned hash)
// ---------------------------------------------------------------------------

function defaultStatePath() {
  return join(process.cwd(), 'state', 'download-manifest.json');
}

async function loadState(statePath) {
  try {
    const raw = await readFile(statePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// The transfer itself
// ---------------------------------------------------------------------------

function contentLengthTotal(headers, resumeOffset) {
  const cl = headers['content-length'];
  if (cl == null) return null;
  const n = Number(cl);
  return Number.isFinite(n) ? resumeOffset + n : null;
}

async function primeHash(hash, filePath) {
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
}

// Streams a response body to disk while hashing it, calling onProgress at
// most every 250ms. On a source-side error (dropped connection) whatever
// was already written stays on disk so the next attempt can resume.
function streamToFile(stream, filePath, flag, hash, { onProgress, startReceived, total }) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(filePath, { flags: flag });
    let received = startReceived;
    let lastEmit = 0;
    let windowStart = Date.now();
    let windowBytes = 0;
    let settled = false;

    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onSourceError);
      stream.removeListener('aborted', onAborted);
      out.removeListener('drain', onDrain);
      out.removeListener('error', onOutError);
    };

    const emitProgress = (force) => {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - lastEmit < 250) return;
      const dt = (now - windowStart) / 1000;
      const bytesPerSecond = dt > 0 ? windowBytes / dt : 0;
      onProgress({ received, total, percent: total ? received / total : null, bytesPerSecond });
      lastEmit = now;
      windowStart = now;
      windowBytes = 0;
    };

    // Graceful: flush whatever is already written before settling. Used
    // both on a clean end and on a source-side drop mid-transfer.
    const settleGraceful = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      out.end(() => (err ? reject(err) : resolve()));
    };

    // Hard: the destination itself failed (disk full, etc). Nothing more
    // to flush.
    const settleHard = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      out.destroy();
      reject(err);
    };

    const onData = (chunk) => {
      hash.update(chunk);
      received += chunk.length;
      windowBytes += chunk.length;
      const ok = out.write(chunk);
      if (!ok) stream.pause();
      emitProgress(false);
    };
    const onDrain = () => stream.resume();
    const onEnd = () => { emitProgress(true); settleGraceful(null); };
    const onSourceError = (err) => settleGraceful(err);
    const onAborted = () => settleGraceful(Object.assign(new Error('connection aborted'), { code: 'ECONNRESET' }));
    const onOutError = (err) => settleHard(err);

    out.on('drain', onDrain);
    out.on('error', onOutError);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onSourceError);
    stream.on('aborted', onAborted);
  });
}

// One attempt: request, stream to <destPath>.incomplete, verify, rename.
// Throws a classified NetError-derived error or a VerifyFailure.
async function attemptDownload({ url, destPath, incompletePath, asset, request, timeoutMs, signal, onProgress, pinnedSha256 }) {
  const existing = existsSync(incompletePath) ? statSync(incompletePath).size : 0;
  const headers = {};
  if (existing > 0) headers.Range = `bytes=${existing}-`;

  let res;
  try {
    res = await request(url, { headers, signal, timeoutMs });
  } catch (err) {
    throw err instanceof NetError ? err : classifyError(err);
  }

  let resumeOffset = existing;
  let writeFlag = 'a';
  if (existing === 0) {
    writeFlag = 'w';
  } else if (res.status !== 206) {
    // The server ignored our Range header: it will send the whole thing
    // from the start, so start the file over too.
    resumeOffset = 0;
    writeFlag = 'w';
  }

  const total = asset.size != null ? asset.size : contentLengthTotal(res.headers, resumeOffset);

  const hash = createHash('sha256');
  if (writeFlag === 'a' && resumeOffset > 0) {
    await primeHash(hash, incompletePath);
  }

  await streamToFile(res.stream, incompletePath, writeFlag, hash, {
    onProgress,
    startReceived: resumeOffset,
    total,
  });

  const stat = statSync(incompletePath);
  if (asset.min_mb != null && stat.size < asset.min_mb * 1024 * 1024) {
    unlinkSync(incompletePath);
    throw new VerifyFailure('too_small');
  }
  if (asset.size != null && stat.size !== asset.size) {
    unlinkSync(incompletePath);
    throw new VerifyFailure('size_mismatch');
  }
  if (asset.magic === 'GGUF' && !ggufMagicOk(incompletePath)) {
    unlinkSync(incompletePath);
    throw new VerifyFailure('bad_magic');
  }

  const digest = hash.digest('hex');
  const expected = asset.sha256 || pinnedSha256 || null;
  if (expected && digest.toLowerCase() !== expected.toLowerCase()) {
    unlinkSync(incompletePath);
    throw new VerifyFailure('hash_mismatch', digest);
  }

  mkdirSync(dirname(destPath), { recursive: true });
  renameSync(incompletePath, destPath);
  return { path: destPath, sha256: digest, newlyPinned: !asset.sha256 && !pinnedSha256 };
}

function isRetryableNetKind(err) {
  if (err.kind === 'timeout' || err.kind === 'offline') return true;
  if (err.kind === 'http') return typeof err.status === 'number' && err.status >= 500;
  return false;
}

function defaultBackoff(attemptIndex) {
  return Math.min(2000 * 2 ** attemptIndex, 30000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Downloads (or accepts an already-sideloaded) asset to destPath.
export async function downloadAsset(asset, destPath, opts = {}) {
  const {
    onProgress,
    signal,
    request = net.request,
    attempts = 5,
    statePath = defaultStatePath(),
    backoff = defaultBackoff,
    timeoutMs = 30000,
  } = opts;

  const incompletePath = destPath + '.incomplete';
  mkdirSync(dirname(destPath), { recursive: true });

  const state = await loadState(statePath);
  const key = asset.url;
  const entry = state[key] || {};

  // Sideload escape hatch: a file already sitting at destPath (dropped in
  // by hand) that verifies is accepted without touching the network.
  if (existsSync(destPath)) {
    const check = await checkFile(destPath, asset, entry.pinnedSha256 || null);
    if (check.ok) {
      if (!asset.sha256 && !entry.pinnedSha256 && check.sha256) {
        state[key] = { ...entry, pinnedSha256: check.sha256 };
        await saveState(statePath, state);
      }
      return { path: destPath, sha256: check.sha256, skipped: true };
    }
    // Stale or wrong file already there: clear it and fall through to a
    // normal download.
    try { unlinkSync(destPath); } catch { /* already gone */ }
  }

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) {
      throw toDownloadError(classifyError(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }
    try {
      const pinned = state[key]?.pinnedSha256 || null;
      const result = await attemptDownload({
        url: asset.url,
        destPath,
        incompletePath,
        asset,
        request,
        timeoutMs,
        signal,
        onProgress,
        pinnedSha256: pinned,
      });

      const next = { ...(state[key] || {}) };
      if (result.newlyPinned) next.pinnedSha256 = result.sha256;
      next.attempts = 0;
      next.lastErrorKind = null;
      state[key] = next;
      await saveState(statePath, state);
      return { path: result.path, sha256: result.sha256, skipped: false };
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts - 1;

      if (err instanceof VerifyFailure) {
        const next = { ...(state[key] || {}) };
        next.attempts = (next.attempts || 0) + 1;
        next.lastErrorKind = err.reason;
        if (err.reason === 'hash_mismatch') next.hashMismatches = (next.hashMismatches || 0) + 1;
        state[key] = next;
        await saveState(statePath, state);

        if (isLast) {
          const suspect = err.reason === 'hash_mismatch' && (next.hashMismatches || 0) >= 3;
          throw suspect
            ? new DownloadError('suspect_stick', 'Repeated hash mismatch on the same asset across launches.')
            : new DownloadError('verify_failed', `The downloaded file failed verification (${err.reason}).`);
        }
        await sleep(backoff(i));
        continue;
      }

      const netErr = err instanceof NetError ? err : classifyError(err);
      const next = { ...(state[key] || {}) };
      next.attempts = (next.attempts || 0) + 1;
      next.lastErrorKind = netErr.kind;
      state[key] = next;
      await saveState(statePath, state);

      if (netErr.kind === 'aborted' || !isRetryableNetKind(netErr) || isLast) {
        throw toDownloadError(netErr);
      }
      await sleep(backoff(i));
    }
  }
  throw toDownloadError(lastErr instanceof NetError ? lastErr : classifyError(lastErr));
}
