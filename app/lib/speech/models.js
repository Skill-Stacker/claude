// Speech model bookkeeping: where STT (speech-to-text) model bundles live on
// the stick, whether one is already present, how to fetch and extract one,
// and where the TTS (text-to-speech) model cache lives.
//
// STT models are sherpa-onnx release bundles (`.tar.bz2`), pinned in the
// `stt` section of app/manifest.json. Two archive shapes exist today, and
// the exact file names below were confirmed by downloading and listing the
// real GitHub release assets (not guessed):
//
//   Moonshine (e.g. sherpa-onnx-moonshine-tiny-en-int8.tar.bz2,
//   sherpa-onnx-moonshine-base-en-int8.tar.bz2) extracts to a directory
//   containing:
//     preprocess.onnx
//     encode.int8.onnx
//     uncached_decode.int8.onnx
//     cached_decode.int8.onnx
//     tokens.txt
//     LICENSE, README.md, test_wavs/ (extra, not required)
//
//   Whisper (e.g. sherpa-onnx-whisper-base.en.tar.bz2) extracts to a
//   directory containing, for a <name> equal to the manifest dir with its
//   "sherpa-onnx-whisper-" prefix removed (e.g. "base.en"):
//     <name>-encoder.int8.onnx
//     <name>-decoder.int8.onnx
//     <name>-tokens.txt
//     <name>-encoder.onnx, <name>-decoder.onnx (fp32, extra, not required)
//     test_wavs/ (extra, not required)
//
// Usage:
//   import { sttModelDir, isSttModelPresent, ensureSttModel, ttsCacheDir } from './models.js';
//   const dir = sttModelDir(paths, 'moonshine-base');
//   if (!isSttModelPresent(paths, 'moonshine-base')) {
//     await ensureSttModel(paths, 'moonshine-base', { onProgress: (p) => ... });
//   }

import { existsSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { downloadAsset } from '../downloads.js';

const MOONSHINE_FILES = [
  'preprocess.onnx',
  'encode.int8.onnx',
  'uncached_decode.int8.onnx',
  'cached_decode.int8.onnx',
  'tokens.txt',
];

const WHISPER_DIR_PREFIX = 'sherpa-onnx-whisper-';

function readManifest(paths) {
  const raw = readFileSync(join(paths.app, 'manifest.json'), 'utf8');
  return JSON.parse(raw);
}

// Returns the `stt` section of manifest.json: { default, <id>: { url, size, sha256, dir }, ... }.
export function sttManifest(paths) {
  const manifest = readManifest(paths);
  return manifest.stt || {};
}

function manifestEntry(paths, id) {
  const stt = sttManifest(paths);
  const entry = stt[id];
  if (!entry || typeof entry.dir !== 'string') {
    throw new Error(`unknown stt model id: ${id}`);
  }
  return entry;
}

export function sttModelDir(paths, id) {
  const entry = manifestEntry(paths, id);
  return join(paths.voices, entry.dir);
}

// 'moonshine' or 'whisper', derived from the manifest's directory name
// rather than the id, so an id like "moonshine-base" or "whisper-base"
// still works even if a future id doesn't follow that naming.
export function sttEngineFamily(paths, id) {
  const entry = manifestEntry(paths, id);
  return entry.dir.startsWith(WHISPER_DIR_PREFIX) ? 'whisper' : 'moonshine';
}

// The exact file names ensureSttModel/isSttModelPresent check for, per the
// archive layouts documented above.
export function expectedSttFiles(paths, id) {
  const entry = manifestEntry(paths, id);
  if (entry.dir.startsWith(WHISPER_DIR_PREFIX)) {
    const name = entry.dir.slice(WHISPER_DIR_PREFIX.length);
    return [`${name}-encoder.int8.onnx`, `${name}-decoder.int8.onnx`, `${name}-tokens.txt`];
  }
  return MOONSHINE_FILES;
}

export function isSttModelPresent(paths, id) {
  const dir = sttModelDir(paths, id);
  return expectedSttFiles(paths, id).every((f) => existsSync(join(dir, f)));
}

// Downloads and extracts the model bundle for `id` if it is not already
// present. `download` defaults to the real downloadAsset from
// app/lib/downloads.js and is injectable for tests; it is called as
// `download(asset, destPath, { onProgress, signal })`, matching that
// module's signature. Extraction uses the system `tar -xjf` (present on
// Windows 10+, macOS, and Linux) rather than a bzip2 library dependency.
export async function ensureSttModel(paths, id, { download = downloadAsset, onProgress, signal } = {}) {
  const entry = manifestEntry(paths, id);
  if (isSttModelPresent(paths, id)) {
    return { downloaded: false, extracted: false, dir: sttModelDir(paths, id) };
  }

  mkdirSync(paths.voices, { recursive: true });
  const archivePath = join(paths.voices, `${entry.dir}.tar.bz2`);
  const asset = { url: entry.url, size: entry.size ?? null, sha256: entry.sha256 ?? null };
  await download(asset, archivePath, { onProgress, signal });

  try {
    execFileSync('tar', ['-xjf', archivePath, '-C', paths.voices], { stdio: 'ignore' });
  } catch (err) {
    throw new Error(`failed to extract ${archivePath}: ${(err && err.message) || err}`);
  }

  try {
    unlinkSync(archivePath);
  } catch {
    // leftover archive is harmless; extraction already succeeded
  }

  if (!isSttModelPresent(paths, id)) {
    throw new Error(`stt model "${id}" was extracted but expected files are missing`);
  }
  return { downloaded: true, extracted: true, dir: sttModelDir(paths, id) };
}

// Every configured STT engine with a `present` flag, for GET /api/stt/engines.
export function listSttEngines(paths) {
  const stt = sttManifest(paths);
  return Object.keys(stt)
    .filter((id) => id !== 'default')
    .map((id) => ({ id, present: isSttModelPresent(paths, id) }));
}

// kokoro-js (through @huggingface/transformers) fetches the Kokoro model
// into whatever HF_HOME points at; this keeps that cache on the stick
// instead of the host's home directory.
export function ttsCacheDir(paths) {
  return join(paths.voices, 'hf-cache');
}

// Sets HF_HOME and TRANSFORMERS_CACHE to ttsCacheDir(paths) and creates it.
// Must run before kokoro-js is imported/loaded so its first cache lookup
// already sees the right directory.
export function prepareTtsCacheEnv(paths) {
  const dir = ttsCacheDir(paths);
  mkdirSync(dir, { recursive: true });
  process.env.HF_HOME = dir;
  process.env.TRANSFORMERS_CACHE = dir;
  return dir;
}
