// video.js: Studio's beginner video tools. Trim, join, captions, cut
// silence, and vertical (shorts) export, all driven by the ffmpeg build
// ffmpeg.js fetches. Every tool runs through one job queue (one ffmpeg
// process at a time, cancellable, progress on the 'video' bus channel) so
// the UI can show a simple job list instead of juggling concurrent encodes
// on a beginner's laptop.
//
// Usage:
//   import { createVideoTools, wireVideo } from './video.js';
//   const video = createVideoTools({ paths, manifest, downloads, stt, bus, netlog });
//   wireVideo(app, { video });
//   const { output, log } = await video.trim({ file: 'clip.mp4', startSec: 1, endSec: 5, precise: false });

import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { join as joinPath, basename, extname, isAbsolute, resolve as resolvePath } from 'node:path';

import { safeJoin } from '../security.js';
import * as realFfmpeg from './ffmpeg.js';

const JOB_TIMEOUT_MS = 30 * 60 * 1000; // a stuck encode gets killed rather than hanging the queue forever

// ---------------------------------------------------------------------------
// small helpers shared by every tool
// ---------------------------------------------------------------------------

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function notReady(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'github.com';
  }
}

function safeStem(file) {
  const stem = basename(String(file || ''), extname(String(file || '')));
  const cleaned = stem.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'clip').slice(0, 60);
}

// Sortable and unique enough that two jobs started in the same second (the
// queue runs one at a time, but two requests can arrive in the same tick)
// never overwrite each other's output.
function timestampTag(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

// Write a temp list file with `file '...'` lines for the concat demuxer,
// escaping a literal single quote the way the shell would: close the
// quoted string, insert an escaped quote, reopen it.
export function formatConcatLine(path) {
  return `file '${String(path).split("'").join("'\\''")}'`;
}

// ---------------------------------------------------------------------------
// captions: SRT timing and line wrapping
// ---------------------------------------------------------------------------

export function srtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, len) => String(n).padStart(len, '0');
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

// Greedy word wrap into at most `maxLines` lines of at most `maxLen`
// characters. One cue per caption window (the spec for this tool), so any
// words left over once both lines are full are summarized with an ellipsis
// rather than dropped silently or spilled into a third line.
export function wrapCaptionLines(text, maxLen = 42, maxLines = 2) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = '';
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    const word = words[i];
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLen) {
      current = next;
      i += 1;
      continue;
    }
    if (!current) {
      current = word.length <= maxLen ? word : word.slice(0, maxLen - 1) + '…';
      i += 1;
    }
    lines.push(current);
    current = '';
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  } else if (i < words.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length < maxLen ? last + '…' : last.slice(0, maxLen - 1) + '…';
  }
  return lines.length ? lines : [''];
}

export function buildSrt(cues) {
  return cues
    .map((cue, i) => `${i + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${wrapCaptionLines(cue.text).join('\n')}\n`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// silence: parsing ffmpeg's silencedetect stderr, and the padded cut plan
// ---------------------------------------------------------------------------

const SILENCE_MARK_RE = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;

// Reads every silence_start/silence_end pair out of raw silencedetect
// stderr, in the order ffmpeg printed them. If the clip ends while still
// silent, ffmpeg does print a matching silence_end at the last frame, but a
// truncated log (a cancelled run, say) can leave one dangling: closing it
// at durationSec keeps that case from being silently dropped instead.
export function parseSilenceDetect(stderrText, durationSec = null) {
  const marks = [];
  let m;
  SILENCE_MARK_RE.lastIndex = 0;
  const text = String(stderrText || '');
  while ((m = SILENCE_MARK_RE.exec(text))) {
    marks.push({ kind: m[1], at: Number(m[2]) });
  }
  const intervals = [];
  let openStart = null;
  for (const mark of marks) {
    if (mark.kind === 'start') {
      openStart = mark.at;
    } else if (openStart != null) {
      intervals.push({ start: openStart, end: mark.at });
      openStart = null;
    }
  }
  if (openStart != null && typeof durationSec === 'number' && durationSec > openStart) {
    intervals.push({ start: openStart, end: durationSec });
  }
  return intervals;
}

// The segments to KEEP once each silence (padded so a bit of natural quiet
// survives at each cut) is removed. Silences are expected in start order;
// out-of-order or overlapping input is sorted and clamped so segments never
// invert or run backward.
export function buildKeptSegments(silences, durationSec, paddingSec = 0) {
  const sorted = silences.slice().sort((a, b) => a.start - b.start);
  const kept = [];
  let cursor = 0;
  for (const { start, end } of sorted) {
    const cutStart = Math.max(cursor, Math.min(durationSec, start + paddingSec));
    const cutEnd = Math.max(cutStart, Math.min(durationSec, end - paddingSec));
    if (cutStart > cursor + 0.001) kept.push({ start: cursor, end: cutStart });
    cursor = Math.max(cursor, cutEnd);
  }
  if (durationSec - cursor > 0.001) kept.push({ start: cursor, end: durationSec });
  return kept;
}

// ---------------------------------------------------------------------------
// createVideoTools
// ---------------------------------------------------------------------------

// ffmpegLib is swappable so tests can hand in a fake run()/probe() and
// assert exact ffmpeg argument lists without spawning anything real.
export function createVideoTools({ paths, manifest, downloads, stt, bus, netlog, ffmpegLib = realFfmpeg } = {}) {
  if (!paths || !paths.base) throw new Error('createVideoTools needs paths.base');

  const studioIn = joinPath(paths.base, 'studio', 'in');
  const studioOut = joinPath(paths.base, 'studio', 'out');
  mkdirSync(studioIn, { recursive: true });
  mkdirSync(studioOut, { recursive: true });

  let ffmpegBins = null;

  // -- path containment: same rule as security.js's safeJoin. A relative
  // name is resolved under studio/in and cannot escape it with '..'; an
  // absolute path is trusted as-is (the page's text field is how a person
  // sitting at this machine points Scout at a file elsewhere on their own
  // computer, the same trust a native file-open dialog would carry). ------
  function resolveInputPath(file) {
    if (typeof file !== 'string' || !file.trim()) throw badRequest('Pick a file first.');
    if (file.includes('\0')) throw badRequest('That file path is not allowed.');
    let resolved;
    if (isAbsolute(file)) {
      resolved = resolvePath(file);
    } else {
      resolved = safeJoin(studioIn, file);
      if (!resolved) throw badRequest('That file path is not allowed.');
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw badRequest('Scout could not find that file.');
    }
    return resolved;
  }

  function outputPath(tool, sourceFile, ext = 'mp4') {
    return joinPath(studioOut, `${timestampTag()}-${tool}-${safeStem(sourceFile)}.${ext}`);
  }

  // -- ffmpeg readiness: checked from disk only, never triggers a download
  // as a side effect of a tool call. --------------------------------------
  function requireReady() {
    if (ffmpegBins) return ffmpegBins;
    const found = ffmpegLib.locateFfmpeg({ paths, platform: process.platform });
    if (!found) throw notReady('Video tools are not set up yet. Use Set Up first.');
    ffmpegBins = found;
    return ffmpegBins;
  }

  // -- job queue: one ffmpeg process at a time, progress on the bus -------
  let jobSeq = 0;
  const jobs = new Map();
  let queue = [];
  let activeJob = null;

  function publish(job) {
    if (!bus) return;
    try {
      bus.publish('video', { jobId: job.id, phase: job.phase, percent: job.percent, message: job.message });
    } catch {
      // a bad subscriber must never break a running job
    }
  }

  function pump() {
    if (activeJob || queue.length === 0) return;
    const job = queue.shift();
    activeJob = job;
    job.state = 'running';
    job.phase = 'running';
    publish(job);
    Promise.resolve()
      .then(() => job.task(job, job.controller.signal))
      .then((result) => {
        job.state = 'done';
        job.phase = 'done';
        job.percent = 100;
        job.output = result.output;
        job.log = result.log;
        publish(job);
        job.settleResolve(result);
      })
      .catch((err) => {
        job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
        job.phase = job.state;
        job.error = (err && err.message) || String(err);
        publish(job);
        job.settleReject(err);
      })
      .finally(() => {
        activeJob = null;
        pump();
      });
  }

  function enqueue(tool, meta, task) {
    const controller = new AbortController();
    let settleResolve;
    let settleReject;
    const promise = new Promise((res, rej) => {
      settleResolve = res;
      settleReject = rej;
    });
    const job = {
      id: `job-${++jobSeq}`,
      tool,
      file: meta.file || null,
      state: 'queued',
      phase: 'queued',
      percent: 0,
      message: meta.message || '',
      output: null,
      log: null,
      error: null,
      createdAt: Date.now(),
      controller,
      task,
      settleResolve,
      settleReject,
    };
    jobs.set(job.id, job);
    queue.push(job);
    publish(job);
    pump();
    promise.jobId = job.id;
    promise.catch(() => {}); // routes hand back the jobId and let the queue run; this just avoids an unhandled-rejection warning when nobody awaits it directly
    return promise;
  }

  function listJobs() {
    return Array.from(jobs.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((j) => ({
        id: j.id,
        tool: j.tool,
        state: j.state,
        phase: j.phase,
        percent: j.percent,
        message: j.message,
        file: j.file,
        output: j.output,
        log: j.log,
        error: j.error,
        createdAt: j.createdAt,
      }));
  }

  function cancelJob(id) {
    const job = jobs.get(id);
    if (!job) return { ok: false, reason: 'not_found' };
    if (job.state === 'queued') {
      queue = queue.filter((j) => j.id !== id);
      job.state = 'cancelled';
      job.phase = 'cancelled';
      job.message = 'cancelled before it started';
      publish(job);
      job.settleReject(Object.assign(new Error('cancelled'), { cancelled: true }));
      return { ok: true };
    }
    if (job.state === 'running') {
      job.controller.abort();
      return { ok: true };
    }
    return { ok: false, reason: 'not_running' };
  }

  // Runs one ffmpeg step and folds its 0-100 progress into the job's
  // overall percent as [base, base+span]. Multi-step tools (join, silence,
  // captions) call this more than once with different [base, span] slices.
  function runStep(job, exe, args, { durationSec = 0, base = 0, span = 100, message } = {}, signal) {
    if (message) {
      job.message = message;
      publish(job);
    }
    return ffmpegLib.run(exe, args, {
      durationSec,
      signal,
      timeoutMs: JOB_TIMEOUT_MS,
      onProgress: ({ percent }) => {
        if (percent == null) return;
        job.percent = Math.round(base + (span * percent) / 100);
        publish(job);
      },
    });
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
  }

  // -- probe: fast, not queued (no ffmpeg encode, just ffprobe) -----------
  async function probeFile({ file }) {
    const input = resolveInputPath(file);
    const bins = requireReady();
    return ffmpegLib.probe(bins.ffprobe, input);
  }

  // -- trim -----------------------------------------------------------------
  function validateRange(startSec, endSec) {
    const s = Number(startSec);
    const e = Number(endSec);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) {
      throw badRequest('Pick a start and end time where the end comes after the start.');
    }
    return { s, e };
  }

  function trim({ file, startSec, endSec, precise }) {
    const input = resolveInputPath(file);
    const { s, e } = validateRange(startSec, endSec);
    requireReady();
    const out = outputPath('trim', file);
    return enqueue('trim', { file: input, message: 'Trimming' }, async (job, signal) => {
      const bins = requireReady();
      const args = precise
        ? ['-i', input, '-ss', String(s), '-to', String(e), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', out]
        : ['-ss', String(s), '-to', String(e), '-i', input, '-c', 'copy', out];
      await runStep(job, bins.ffmpeg, args, { durationSec: e - s, message: precise ? 'Trimming (re-encoding for an exact cut)' : 'Trimming' }, signal);
      return {
        output: out,
        log: precise ? 'trimmed with a re-encode so the cut lands exactly' : 'trimmed by copying; the cut lands on the nearest keyframe',
      };
    });
  }

  // -- join -----------------------------------------------------------------
  function joinClips({ files }) {
    if (!Array.isArray(files) || files.length < 2) throw badRequest('Pick at least two clips to join.');
    const inputs = files.map((f) => resolveInputPath(f));
    requireReady();
    const out = outputPath('join', files[0]);
    return enqueue('join', { file: inputs[0], message: 'Checking the clips' }, async (job, signal) => {
      const bins = requireReady();
      const infos = [];
      for (const input of inputs) {
        throwIfAborted(signal);
        infos.push(await ffmpegLib.probe(bins.ffprobe, input));
      }
      const first = infos[0];
      const sameFormat = infos.every(
        (i) => i.width === first.width && i.height === first.height && i.videoCodec === first.videoCodec && i.audioCodec === first.audioCodec,
      );
      const totalDuration = infos.reduce((sum, i) => sum + (i.durationSec || 0), 0);

      if (sameFormat) {
        const listPath = joinPath(studioOut, `.join-list-${job.id}.txt`);
        writeFileSync(listPath, inputs.map(formatConcatLine).join('\n') + '\n', 'utf8');
        try {
          await runStep(job, bins.ffmpeg, ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out], { durationSec: totalDuration, base: 10, span: 90, message: 'Joining' }, signal);
        } finally {
          try { unlinkSync(listPath); } catch { /* best effort cleanup */ }
        }
        return { output: out, log: 'joined without re-encoding, the clips already matched' };
      }

      const inputArgs = inputs.flatMap((p) => ['-i', p]);
      const graph = `${inputs.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('')}concat=n=${inputs.length}:v=1:a=1[v][a]`;
      await runStep(
        job,
        bins.ffmpeg,
        [...inputArgs, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', out],
        { durationSec: totalDuration, base: 10, span: 90, message: 'Joining (re-encoding, the clips did not match)' },
        signal,
      );
      return { output: out, log: 'joined with a re-encode, the clips did not match' };
    });
  }

  // -- captions ---------------------------------------------------------
  function makeCaptions({ file, burnIn }) {
    const input = resolveInputPath(file);
    if (!stt || typeof stt.transcribeBuffer !== 'function') {
      throw badRequest("Captions need Scout's ears, which are still downloading.");
    }
    requireReady();
    const burn = Boolean(burnIn);
    const srtOut = outputPath('captions', file, 'srt');
    const mp4Out = burn ? outputPath('captions', file, 'mp4') : null;

    return enqueue('captions', { file: input, message: 'Listening to the audio' }, async (job, signal) => {
      const bins = requireReady();
      const info = await ffmpegLib.probe(bins.ffprobe, input);
      const durationSec = info.durationSec || 0;

      const pcmPath = joinPath(studioOut, `.captions-audio-${job.id}.pcm`);
      await runStep(job, bins.ffmpeg, ['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', pcmPath], { durationSec, base: 0, span: 20, message: 'Listening to the audio' }, signal);

      let pcm;
      try {
        pcm = readFileSync(pcmPath);
      } finally {
        try { unlinkSync(pcmPath); } catch { /* best effort */ }
      }

      const BYTES_PER_SEC = 16000 * 2; // 16 kHz, mono, 16-bit
      const WINDOW_SEC = 30;
      const OVERLAP_SEC = 0.5;
      const STEP_SEC = WINDOW_SEC - OVERLAP_SEC;
      const windowCount = Math.max(1, Math.ceil(durationSec / STEP_SEC));

      const cues = [];
      let t = 0;
      let windowIndex = 0;
      while (t < durationSec) {
        throwIfAborted(signal);
        const windowEnd = Math.min(t + WINDOW_SEC, durationSec);
        const startByte = Math.floor(t * BYTES_PER_SEC);
        const endByte = Math.min(pcm.length, Math.floor(windowEnd * BYTES_PER_SEC));
        job.message = `Writing captions (${windowIndex + 1} of ${windowCount})`;
        job.percent = Math.round(20 + (70 * windowIndex) / windowCount);
        publish(job);
        // eslint-disable-next-line no-await-in-loop
        const { text } = await stt.transcribeBuffer(Buffer.from(pcm.subarray(startByte, endByte)), 16000);
        const clean = (text || '').trim();
        if (clean) cues.push({ start: t, end: windowEnd, text: clean });
        windowIndex += 1;
        t += STEP_SEC;
      }

      writeFileSync(srtOut, buildSrt(cues), 'utf8');
      const cueWord = cues.length === 1 ? 'cue' : 'cues';

      if (!burn) {
        job.percent = 100;
        return { output: srtOut, srt: srtOut, log: `wrote ${cues.length} caption ${cueWord}` };
      }

      const filter = `subtitles=${ffmpegLib.escapeFilterPath(srtOut)}:force_style='FontSize=22,Outline=1'`;
      await runStep(job, bins.ffmpeg, ['-i', input, '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', mp4Out], { durationSec, base: 90, span: 10, message: 'Burning captions into the video' }, signal);
      return { output: mp4Out, srt: srtOut, log: `wrote ${cues.length} caption ${cueWord} and burned them in` };
    });
  }

  // -- silence --------------------------------------------------------------
  function cutSilence({ file, thresholdDb = -35, minSilenceSec = 0.6, paddingSec = 0.15 }) {
    const input = resolveInputPath(file);
    requireReady();
    const out = outputPath('silence', file);
    return enqueue('silence', { file: input, message: 'Listening for quiet stretches' }, async (job, signal) => {
      const bins = requireReady();
      const info = await ffmpegLib.probe(bins.ffprobe, input);
      const durationSec = info.durationSec || 0;

      const { stderr } = await runStep(
        job,
        bins.ffmpeg,
        ['-i', input, '-af', `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`, '-f', 'null', '-'],
        { durationSec, base: 0, span: 20, message: 'Listening for quiet stretches' },
        signal,
      );
      const silences = parseSilenceDetect(stderr, durationSec);
      const kept = buildKeptSegments(silences, durationSec, paddingSec);
      if (!kept.length) throw badRequest('Scout could not find any sound to keep in that clip.');

      const nothingToCut = kept.length === 1 && kept[0].start < 0.001 && Math.abs(kept[0].end - durationSec) < 0.01;
      if (nothingToCut) {
        await runStep(job, bins.ffmpeg, ['-i', input, '-c', 'copy', out], { durationSec, base: 20, span: 80, message: 'No quiet stretches found, copying as-is' }, signal);
        return { output: out, log: 'no quiet stretches longer than the threshold were found', removedSeconds: 0 };
      }

      const segmentFiles = [];
      try {
        for (let i = 0; i < kept.length; i++) {
          throwIfAborted(signal);
          const seg = kept[i];
          const segPath = joinPath(studioOut, `.silence-seg-${job.id}-${i}.mp4`);
          segmentFiles.push(segPath);
          // eslint-disable-next-line no-await-in-loop
          await runStep(
            job,
            bins.ffmpeg,
            ['-i', input, '-ss', String(seg.start), '-to', String(seg.end), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', segPath],
            { durationSec: seg.end - seg.start, base: 20 + Math.round((60 * i) / kept.length), span: Math.round(60 / kept.length), message: `Cutting the quiet parts (${i + 1} of ${kept.length})` },
            signal,
          );
        }

        const listPath = joinPath(studioOut, `.silence-list-${job.id}.txt`);
        writeFileSync(listPath, segmentFiles.map(formatConcatLine).join('\n') + '\n', 'utf8');
        try {
          const keptDuration = kept.reduce((sum, k) => sum + (k.end - k.start), 0);
          await runStep(job, bins.ffmpeg, ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out], { durationSec: keptDuration, base: 80, span: 20, message: 'Putting the clip back together' }, signal);
        } finally {
          try { unlinkSync(listPath); } catch { /* best effort */ }
        }
      } finally {
        for (const f of segmentFiles) {
          try { unlinkSync(f); } catch { /* best effort */ }
        }
      }

      const keptDuration = kept.reduce((sum, k) => sum + (k.end - k.start), 0);
      const removedSeconds = Math.max(0, durationSec - keptDuration);
      return { output: out, log: `removed ${removedSeconds.toFixed(1)}s of quiet`, removedSeconds };
    });
  }

  // -- shorts -----------------------------------------------------------
  function makeShorts({ file, mode }) {
    const input = resolveInputPath(file);
    if (mode !== 'crop' && mode !== 'blur') throw badRequest("Pick 'crop' or 'blur'.");
    requireReady();
    const out = outputPath('shorts', file);
    return enqueue('shorts', { file: input, message: mode === 'crop' ? 'Cropping to vertical' : 'Filling in blurred edges' }, async (job, signal) => {
      const bins = requireReady();
      const info = await ffmpegLib.probe(bins.ffprobe, input);
      const args =
        mode === 'crop'
          ? ['-i', input, '-vf', 'scale=-2:1920,crop=1080:1920', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', out]
          : [
              '-i',
              input,
              '-filter_complex',
              'split[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20[bg2];[fg]scale=1080:-2[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2',
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-crf',
              '20',
              '-c:a',
              'aac',
              out,
            ];
      await runStep(job, bins.ffmpeg, args, { durationSec: info.durationSec, message: mode === 'crop' ? 'Cropping to vertical' : 'Filling in blurred edges' }, signal);
      return { output: out, log: `made a 1080x1920 ${mode} export` };
    });
  }

  // -- ffmpeg setup: the only tool that ever touches the network ----------
  function status() {
    const platform = process.platform;
    const arch = process.arch;
    if (!ffmpegBins) ffmpegBins = ffmpegLib.locateFfmpeg({ paths, platform });
    const asset = ffmpegLib.ffmpegAsset(manifest, platform, arch);
    return {
      present: Boolean(ffmpegBins),
      platform,
      canSetUp: Boolean(asset),
      note: !asset && platform === 'darwin' ? ffmpegLib.DARWIN_NOTE : null,
    };
  }

  function setup() {
    const asset = ffmpegLib.ffmpegAsset(manifest, process.platform, process.arch);
    const host = asset ? hostOf(asset.url) : 'github.com';
    return enqueue('setup', { message: 'Downloading the video tools' }, async (job) => {
      const record = (ok, detail) => {
        if (!netlog) return;
        try {
          netlog.record({ kind: 'https', host, purpose: 'download the video tools (ffmpeg)', ok, detail: detail || null });
        } catch {
          // netlog must never break the pipeline
        }
      };
      record(true);
      try {
        const bins = await ffmpegLib.ensureFfmpeg({
          paths,
          manifest,
          downloads,
          onProgress: (p) => {
            job.percent = Math.round(((p && p.percent) || 0) * 90);
            job.message = 'Downloading the video tools';
            publish(job);
          },
        });
        ffmpegBins = bins;
        record(true);
        job.percent = 100;
        job.message = 'Ready';
        publish(job);
        return { output: null, log: 'video tools installed' };
      } catch (err) {
        record(false, (err && err.message) || String(err));
        throw err;
      }
    });
  }

  // -- browsing the studio folder ------------------------------------------
  function listFiles() {
    let files = [];
    try {
      files = readdirSync(studioIn, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const full = joinPath(studioIn, e.name);
          const stat = statSync(full);
          return { name: e.name, path: full, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      files = [];
    }
    return { dir: studioIn, files };
  }

  return {
    probe: probeFile,
    trim,
    join: joinClips,
    captions: makeCaptions,
    silence: cutSilence,
    shorts: makeShorts,
    status,
    setup,
    jobs: listJobs,
    cancel: cancelJob,
    files: listFiles,
  };
}

// ---------------------------------------------------------------------------
// wireVideo
// ---------------------------------------------------------------------------

function errorStatus(err) {
  return (err && err.statusCode) || 500;
}

function errorKind(status) {
  if (status === 400) return 'invalid_request';
  if (status === 409) return 'not_ready';
  return 'internal';
}

async function readJsonBody(ctx) {
  try {
    return (await ctx.readJson()) || {};
  } catch {
    const err = new Error('That request was not valid JSON.');
    err.statusCode = 400;
    throw err;
  }
}

export function wireVideo(app, { video }) {
  function sendError(ctx, err) {
    const status = errorStatus(err);
    ctx.sendJson(status, { error: errorKind(status), message: (err && err.message) || String(err) });
  }

  function jobRoute(name, fn) {
    app.addRoute('POST', `/api/video/${name}`, async (req, res, ctx) => {
      let body;
      try {
        body = await readJsonBody(ctx);
      } catch (err) {
        return sendError(ctx, err);
      }
      try {
        const promise = fn(body);
        ctx.sendJson(202, { jobId: promise.jobId });
      } catch (err) {
        sendError(ctx, err);
      }
    });
  }

  app.addRoute('GET', '/api/video/status', async (req, res, ctx) => {
    ctx.sendJson(200, video.status());
  });

  app.addRoute('POST', '/api/video/setup', async (req, res, ctx) => {
    try {
      const promise = video.setup();
      ctx.sendJson(202, { jobId: promise.jobId });
    } catch (err) {
      sendError(ctx, err);
    }
  });

  app.addRoute('GET', '/api/video/files', async (req, res, ctx) => {
    ctx.sendJson(200, video.files());
  });

  app.addRoute('POST', '/api/video/probe', async (req, res, ctx) => {
    let body;
    try {
      body = await readJsonBody(ctx);
    } catch (err) {
      return sendError(ctx, err);
    }
    try {
      ctx.sendJson(200, await video.probe(body));
    } catch (err) {
      sendError(ctx, err);
    }
  });

  jobRoute('trim', video.trim);
  jobRoute('join', video.join);
  jobRoute('captions', video.captions);
  jobRoute('silence', video.silence);
  jobRoute('shorts', video.shorts);

  app.addRoute('GET', '/api/video/jobs', async (req, res, ctx) => {
    ctx.sendJson(200, { jobs: video.jobs() });
  });

  app.addRoute('POST', '/api/video/cancel', async (req, res, ctx) => {
    let body;
    try {
      body = await readJsonBody(ctx);
    } catch (err) {
      return sendError(ctx, err);
    }
    const result = video.cancel(body.jobId);
    ctx.sendJson(result.ok ? 200 : 404, result);
  });

  app.setStatus('video', () => video.status());
}
