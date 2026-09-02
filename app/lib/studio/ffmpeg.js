// ffmpeg.js: fetches and runs the BtbN static ffmpeg build Studio's video
// tools drive. Nothing here is bundled with StickOS; the binary is a
// runtime download into bin/ffmpeg/ the same way the model and the engine
// are, verified the same way (downloadAsset), and never fetched twice once
// it is on the stick.
//
// Usage:
//   import { ffmpegAsset, ensureFfmpeg, run, probe, escapeFilterPath } from './ffmpeg.js';
//   const { ffmpeg, ffprobe } = await ensureFfmpeg({ paths, manifest, downloads, onProgress });
//   const info = await probe(ffprobe, '/path/clip.mp4');
//   const { code, stderr } = await run(ffmpeg, ['-i', 'in.mp4', '-c', 'copy', 'out.mp4'], { durationSec: info.durationSec });

import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(nodeExecFile);

// Studio phase B has not run a real download-and-encode pass on a Mac yet
// (no darwin-arm64 entry in manifest.json's studio.ffmpeg table), so the
// setup card and the setup route both surface this rather than pretend.
export const DARWIN_NOTE = "The Mac build of Scout's video tools has not been verified yet.";

// ---------------------------------------------------------------------------
// Picking the right manifest entry
// ---------------------------------------------------------------------------

// manifest.studio.ffmpeg has win-x64 and linux-x64 entries and a darwin-arm64
// key that is always null; this never invents a URL that is not there.
export function ffmpegAsset(manifest, platform = process.platform, arch = process.arch) {
  const table = manifest && manifest.studio && manifest.studio.ffmpeg;
  if (!table) return null;
  if (platform === 'win32' && arch === 'x64') return table['win-x64'] || null;
  if (platform === 'linux' && arch === 'x64') return table['linux-x64'] || null;
  // darwin-arm64 is null in the manifest on purpose; any other platform/arch
  // combination (32-bit, linux-arm64, ...) has no build either.
  return null;
}

// ---------------------------------------------------------------------------
// Locating an already-installed binary, no network involved
// ---------------------------------------------------------------------------

function binNames(platform) {
  return platform === 'win32' ? { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' } : { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
}

// The BtbN archives all extract to one top-level folder (name carries the
// build's own version string, so it is never hardcoded) with bin/ffmpeg and
// bin/ffprobe inside it. This also accepts a flatter layout (dir/bin/... or
// dir/... directly) so a hand-placed or already-flattened install still
// works, and so tests can drop fake binaries in without building a fake
// top-level folder.
function findBinaries(dir, names) {
  const direct = { ffmpeg: join(dir, names.ffmpeg), ffprobe: join(dir, names.ffprobe) };
  if (existsSync(direct.ffmpeg) && existsSync(direct.ffprobe)) return direct;

  const inBin = { ffmpeg: join(dir, 'bin', names.ffmpeg), ffprobe: join(dir, 'bin', names.ffprobe) };
  if (existsSync(inBin.ffmpeg) && existsSync(inBin.ffprobe)) return inBin;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    const candidate = { ffmpeg: join(sub, 'bin', names.ffmpeg), ffprobe: join(sub, 'bin', names.ffprobe) };
    if (existsSync(candidate.ffmpeg) && existsSync(candidate.ffprobe)) return candidate;
  }
  return null;
}

function installDir(paths) {
  return join(paths.bin, 'ffmpeg');
}

// Checks disk only, downloads nothing. video.js's status route and its
// tool functions both use this to tell "already set up" from "needs setup"
// without ever triggering a download as a side effect of asking.
export function locateFfmpeg({ paths, platform = process.platform } = {}) {
  if (!paths || !paths.bin) return null;
  return findBinaries(installDir(paths), binNames(platform));
}

// ---------------------------------------------------------------------------
// Download + extract
// ---------------------------------------------------------------------------

async function extractArchive(archivePath, destDir) {
  // Windows 10 and later ship bsdtar as tar.exe, which (unlike GNU tar)
  // also unpacks .zip, so one command handles both the win-x64 zip and the
  // linux-x64 tar.xz without branching on extension.
  await execFileAsync('tar', ['-xf', archivePath, '-C', destDir], { maxBuffer: 16 * 1024 * 1024 });
}

// Downloads (if needed) and extracts the platform's ffmpeg build into
// <paths.bin>/ffmpeg/, then resolves and (on macOS/Linux) chmods the two
// executables. Returns { ffmpeg, ffprobe }. Throws a plain Error, with
// DARWIN_NOTE as its message on a Mac, if there is nothing to fetch.
export async function ensureFfmpeg({ paths, manifest, downloads, onProgress, platform = process.platform, arch = process.arch } = {}) {
  if (!paths || !paths.bin) throw new Error('ensureFfmpeg needs paths.bin');
  const names = binNames(platform);
  const dir = installDir(paths);

  const already = findBinaries(dir, names);
  if (already) {
    if (platform !== 'win32') {
      try { chmodSync(already.ffmpeg, 0o755); chmodSync(already.ffprobe, 0o755); } catch { /* best effort */ }
    }
    return already;
  }

  const asset = ffmpegAsset(manifest, platform, arch);
  if (!asset) {
    throw new Error(platform === 'darwin' ? DARWIN_NOTE : `No video tools build is defined for ${platform}/${arch}.`);
  }
  if (!downloads || typeof downloads.downloadAsset !== 'function') {
    throw new Error('ensureFfmpeg needs downloads.downloadAsset');
  }

  mkdirSync(dir, { recursive: true });
  const archiveExt = asset.url.toLowerCase().endsWith('.zip') ? '.zip' : '.tar.xz';
  const archivePath = join(dir, 'ffmpeg-archive' + archiveExt);

  await downloads.downloadAsset(asset, archivePath, { onProgress });
  await extractArchive(archivePath, dir);
  try { unlinkSync(archivePath); } catch { /* not fatal, just leaves it on disk */ }

  const found = findBinaries(dir, names);
  if (!found) throw new Error('The video tools downloaded but bin/ffmpeg was not where the archive said it would be.');
  if (platform !== 'win32') {
    chmodSync(found.ffmpeg, 0o755);
    chmodSync(found.ffprobe, 0o755);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Running ffmpeg with progress
// ---------------------------------------------------------------------------

const FFMPEG_FIXED_ARGS = ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-y'];
const STDERR_KEEP_BYTES = 8 * 1024 * 1024; // trailing window kept while a run is in flight
const ERROR_TAIL_LINES = 20; // shown in a thrown error's message

function tailLines(text, n) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-n).join('\n');
}

// ffmpeg's -progress output is repeating key=value lines ending each cycle
// with "progress=continue" or "progress=end". out_time_ms is, despite its
// name, actually microseconds (a long-standing ffmpeg quirk: out_time_ms
// and out_time_us carry the identical value) confirmed against this build's
// real output, so dividing by 1e6 gives seconds.
function parseProgressChunk(chunk, durationSec, onProgress) {
  if (!onProgress) return;
  for (const line of chunk.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key !== 'out_time_ms') continue;
    const micros = Number(line.slice(eq + 1).trim());
    if (!Number.isFinite(micros)) continue;
    const seconds = micros / 1e6;
    const percent = durationSec > 0 ? Math.max(0, Math.min(100, (seconds / durationSec) * 100)) : null;
    onProgress({ seconds, percent });
  }
}

// Spawns ffmpeg with the fixed flags this project always wants, streams
// progress, and settles once the process exits. `signal` (an AbortSignal)
// and `timeoutMs` both kill the child rather than just reject the promise,
// so a caller can rely on the process actually being gone.
export function run(exe, args, { onProgress, timeoutMs, signal, durationSec = 0, cwd, spawn = nodeSpawn } = {}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(exe, [...FFMPEG_FIXED_ARGS, ...args], { cwd });
    } catch (err) {
      reject(err);
      return;
    }

    let stderrText = '';
    let timedOut = false;
    let cancelled = false;
    let timer = null;

    const stopTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    if (timeoutMs) {
      // Deliberately not unref()'d: this is the safety net that guarantees
      // a stuck ffmpeg process actually gets killed, so it must be able to
      // keep the process alive on its own even if nothing else is pending.
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
    }

    const onAbort = () => {
      cancelled = true;
      child.kill('SIGKILL');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const detach = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => parseProgressChunk(chunk, durationSec, onProgress));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderrText += chunk;
        if (stderrText.length > STDERR_KEEP_BYTES) stderrText = stderrText.slice(-STDERR_KEEP_BYTES);
      });
    }

    child.on('error', (err) => {
      stopTimer();
      detach();
      reject(err);
    });

    child.on('close', (code) => {
      stopTimer();
      detach();
      if (cancelled) {
        reject(Object.assign(new Error('cancelled'), { cancelled: true, stderr: stderrText }));
        return;
      }
      if (timedOut) {
        reject(Object.assign(new Error(`ffmpeg timed out after ${timeoutMs}ms`), { timedOut: true, stderr: tailLines(stderrText, ERROR_TAIL_LINES) }));
        return;
      }
      if (code !== 0) {
        reject(Object.assign(new Error(`ffmpeg failed (exit ${code}): ${tailLines(stderrText, ERROR_TAIL_LINES)}`), { code, stderr: stderrText }));
        return;
      }
      resolvePromise({ code, stderr: stderrText });
    });
  });
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

function parseFrameRate(rate) {
  if (typeof rate !== 'string' || rate === '0/0') return null;
  const [n, d] = rate.split('/').map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

// { durationSec, width, height, fps, hasAudio } is the contract video.js's
// tools rely on; videoCodec/audioCodec ride along too since join() needs
// them to decide copy-concat vs. a re-encoding fallback.
export async function probe(ffprobe, file, { execFile = execFileAsync } = {}) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file];
  const { stdout } = await execFile(ffprobe, args, { maxBuffer: 16 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const format = data.format || {};
  const video = streams.find((s) => s.codec_type === 'video') || null;
  const audio = streams.find((s) => s.codec_type === 'audio') || null;
  const durationSec = Number(format.duration ?? video?.duration ?? audio?.duration ?? 0) || 0;
  return {
    durationSec,
    width: video ? Number(video.width) || null : null,
    height: video ? Number(video.height) || null : null,
    fps: video ? parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate) : null,
    hasAudio: Boolean(audio),
    videoCodec: video ? video.codec_name || null : null,
    audioCodec: audio ? audio.codec_name || null : null,
  };
}

// ---------------------------------------------------------------------------
// Windows filter-path escaping
// ---------------------------------------------------------------------------

// ffmpeg filter strings use ':' to separate a filter's own arguments and
// '\' as the escape character, so a Windows path like C:\clips\a.srt used
// inside subtitles=... has to become C\:\\clips\\a.srt: backslashes doubled
// first, then colons escaped (doing it in the other order would re-escape
// the backslash the colon-escape just introduced). On POSIX paths, which
// have neither character, this is a no-op.
export function escapeFilterPath(p) {
  return String(p).split('\\').join('\\\\').split(':').join('\\:');
}
