// tests/video.test.js: Studio's video tools (app/lib/studio/ffmpeg.js and
// app/lib/studio/video.js). Unit tests use fakes for every ffmpeg process
// (a fake spawn()/run() for argument construction and progress parsing, a
// fake downloads.downloadAsset() but a REAL `tar` for extraction) so the
// suite runs fast and offline; one integration test at the bottom downloads
// the real BtbN linux64 ffmpeg build and drives the real binary end to end,
// and is skipped with a clear message if that download fails.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../app/server.js';
import {
  ffmpegAsset,
  locateFfmpeg,
  ensureFfmpeg,
  run,
  probe,
  escapeFilterPath,
  DARWIN_NOTE,
} from '../app/lib/studio/ffmpeg.js';
import {
  createVideoTools,
  wireVideo,
  formatConcatLine,
  srtTimestamp,
  wrapCaptionLines,
  buildSrt,
  parseSilenceDetect,
  buildKeptSegments,
} from '../app/lib/studio/video.js';
import { makeFixtureClip } from './fixtures/video/make.mjs';

const execFileAsync = promisify(nodeExecFile);

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'stickos-video-'));
}

let nextPort = 47450;
function testPort() {
  nextPort += 1;
  return nextPort;
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Reads whatever SSE frames arrive on `res` within `timeoutMs`, then stops.
async function readSseEvents(res, timeoutMs) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const outcome = await Promise.race([
      reader.read().then((r) => ({ read: r })),
      wait(remaining).then(() => ({ timedOut: true })),
    ]);
    if (outcome.timedOut) break;
    const { value, done } = outcome.read;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const typeMatch = raw.match(/^event: (.+)$/m);
      const dataMatch = raw.match(/^data: (.+)$/m);
      if (!dataMatch) continue;
      let data;
      try {
        data = JSON.parse(dataMatch[1]);
      } catch {
        data = dataMatch[1];
      }
      events.push({ type: typeMatch ? typeMatch[1] : 'message', data });
    }
  }
  try {
    reader.cancel();
  } catch {
    // best effort
  }
  return events;
}

function writeStudioInFile(paths, name, content = Buffer.from('not a real video, just a fixture placeholder')) {
  const dir = join(paths.base, 'studio', 'in');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function fakePaths() {
  const base = tmpDir();
  return { base, bin: join(base, 'bin') };
}

const FAKE_MANIFEST = {
  studio: {
    ffmpeg: {
      'win-x64': { url: 'https://example.invalid/ffmpeg-win.zip', size: null, sha256: null },
      'linux-x64': { url: 'https://example.invalid/ffmpeg-linux.tar.xz', size: null, sha256: null },
      'darwin-arm64': null,
    },
  },
};

// A fake ffmpegLib that records every run()/probe() call and never spawns a
// real process. Whenever a run() call's last argument looks like a real
// output path (not an ffmpeg flag or the '-f null -' sink), it drops a tiny
// placeholder file there so existsSync() checks on a job's declared output
// behave the way they would against the real ffmpeg.
function makeFakeFfmpegLib({ probeResults, silenceStderr } = {}) {
  const calls = { run: [], probe: [], concatLists: [] };
  let probeIndex = 0;
  const lib = {
    async run(exe, args, opts) {
      calls.run.push({ exe, args, opts: { ...opts, onProgress: undefined } });
      if (opts && opts.onProgress) opts.onProgress({ seconds: 1, percent: 100 });
      const isSilenceDetect = args.some((a) => typeof a === 'string' && a.includes('silencedetect'));
      // A concat-demuxer run's list file is a temp file the caller deletes
      // once the run resolves, so its content has to be captured here, at
      // call time, for a test to be able to assert on it afterward.
      if (args.includes('-f') && args.includes('concat')) {
        const listPath = args[args.indexOf('-i') + 1];
        try {
          calls.concatLists.push(readFileSync(listPath, 'utf8'));
        } catch {
          // ignore, nothing to capture
        }
      }
      const outArg = args[args.length - 1];
      if (typeof outArg === 'string' && !outArg.startsWith('-')) {
        try {
          writeFileSync(outArg, Buffer.from('fake-ffmpeg-output'));
        } catch {
          // some destinations (temp dirs not yet created) are not asserted on; ignore
        }
      }
      return { code: 0, stderr: isSilenceDetect && silenceStderr ? silenceStderr : '' };
    },
    async probe() {
      calls.probe.push(true);
      if (Array.isArray(probeResults)) {
        const r = probeResults[Math.min(probeIndex, probeResults.length - 1)];
        probeIndex += 1;
        return r;
      }
      return probeResults || { durationSec: 10, width: 320, height: 240, fps: 15, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac' };
    },
    locateFfmpeg: () => ({ ffmpeg: 'FAKE_FFMPEG', ffprobe: 'FAKE_FFPROBE' }),
    escapeFilterPath,
    ffmpegAsset,
    DARWIN_NOTE,
    async ensureFfmpeg({ onProgress } = {}) {
      if (onProgress) onProgress({ percent: 1 });
      return { ffmpeg: 'FAKE_FFMPEG', ffprobe: 'FAKE_FFPROBE' };
    },
  };
  return { lib, calls };
}

function makeVideoTools(overrides = {}) {
  const paths = overrides.paths || fakePaths();
  const { lib, calls } = overrides.ffmpegLibAndCalls || makeFakeFfmpegLib(overrides.fakeOpts);
  const busEvents = [];
  const bus = overrides.bus || { publish: (type, data) => busEvents.push({ type, data }) };
  const stt =
    overrides.stt !== undefined
      ? overrides.stt
      : { async transcribeBuffer() { return { text: 'hello world', ms: 1 }; } };
  const video = createVideoTools({
    paths,
    manifest: FAKE_MANIFEST,
    downloads: overrides.downloads || {},
    stt,
    bus,
    netlog: overrides.netlog || null,
    ffmpegLib: lib,
  });
  return { video, paths, calls, busEvents };
}

// ---------------------------------------------------------------------------
// escapeFilterPath
// ---------------------------------------------------------------------------

describe('escapeFilterPath', () => {
  test('a Windows path gets its colon escaped and its backslashes doubled', () => {
    assert.equal(escapeFilterPath('C:\\path\\file.srt'), 'C\\:\\\\path\\\\file.srt');
  });

  test('a POSIX path (no colon, no backslash) is unchanged', () => {
    assert.equal(escapeFilterPath('/home/user/clip.srt'), '/home/user/clip.srt');
  });

  test('a UNC-style path escapes every backslash and colon it has', () => {
    assert.equal(escapeFilterPath('D:\\a\\b\\c.srt'), 'D\\:\\\\a\\\\b\\\\c.srt');
  });
});

// ---------------------------------------------------------------------------
// formatConcatLine (video.js)
// ---------------------------------------------------------------------------

describe('formatConcatLine', () => {
  test('wraps a plain path in file \'...\'', () => {
    assert.equal(formatConcatLine('/studio/in/clip.mp4'), "file '/studio/in/clip.mp4'");
  });

  test('escapes a literal single quote the shell way', () => {
    assert.equal(formatConcatLine("/studio/in/it's a clip.mp4"), "file '/studio/in/it'\\''s a clip.mp4'");
  });
});

// ---------------------------------------------------------------------------
// captions: srtTimestamp / wrapCaptionLines / buildSrt
// ---------------------------------------------------------------------------

describe('srtTimestamp', () => {
  test('formats HH:MM:SS,mmm', () => {
    assert.equal(srtTimestamp(0), '00:00:00,000');
    assert.equal(srtTimestamp(1.5), '00:00:01,500');
    assert.equal(srtTimestamp(65.02), '00:01:05,020');
    assert.equal(srtTimestamp(3661.999), '01:01:01,999');
  });
});

describe('wrapCaptionLines', () => {
  test('short text is one line', () => {
    assert.deepEqual(wrapCaptionLines('hello there'), ['hello there']);
  });

  test('long text wraps onto a second line at a word boundary, staying under 42 chars', () => {
    const text = 'this sentence is long enough that it has to wrap onto a second line';
    const lines = wrapCaptionLines(text);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(line.length <= 42, `line too long: "${line}" (${line.length})`);
    assert.equal(lines.join(' ').replace('…', '').trim().startsWith('this sentence is long enough'), true);
  });

  test('very long text is truncated with an ellipsis rather than spilling a third line', () => {
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const lines = wrapCaptionLines(text);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(line.length <= 42);
    assert.ok(lines[1].endsWith('…'));
  });

  test('empty text yields one empty line, never throws', () => {
    assert.deepEqual(wrapCaptionLines(''), ['']);
  });
});

describe('buildSrt', () => {
  test('one cue per window, numbered from 1, with the wrapped text', () => {
    const srt = buildSrt([
      { start: 0, end: 2, text: 'hello there' },
      { start: 2, end: 4, text: 'general kenobi' },
    ]);
    assert.equal(
      srt,
      '1\n00:00:00,000 --> 00:00:02,000\nhello there\n\n2\n00:00:02,000 --> 00:00:04,000\ngeneral kenobi\n',
    );
  });
});

// ---------------------------------------------------------------------------
// silence: parseSilenceDetect / buildKeptSegments
// ---------------------------------------------------------------------------

describe('parseSilenceDetect', () => {
  test('pairs silence_start/silence_end lines from real silencedetect stderr', () => {
    const stderr = [
      '[Parsed_silencedetect_0 @ 0x1] silence_start: 1.021678',
      '[Parsed_silencedetect_0 @ 0x1] silence_end: 2.507755 | silence_duration: 1.486077',
      '[Parsed_silencedetect_0 @ 0x1] silence_start: 4.017007',
      '[Parsed_silencedetect_0 @ 0x1] silence_end: 4.713696 | silence_duration: 0.696689',
    ].join('\n');
    assert.deepEqual(parseSilenceDetect(stderr), [
      { start: 1.021678, end: 2.507755 },
      { start: 4.017007, end: 4.713696 },
    ]);
  });

  test('no silence markers at all yields an empty list', () => {
    assert.deepEqual(parseSilenceDetect('frame=90 fps=0.0\n'), []);
  });

  test('a trailing unmatched silence_start (clip ends in silence) closes at durationSec', () => {
    const stderr = '[x] silence_start: 5.0\n';
    assert.deepEqual(parseSilenceDetect(stderr, 6), [{ start: 5.0, end: 6 }]);
    // without a durationSec to close against, the dangling mark is dropped rather than guessed
    assert.deepEqual(parseSilenceDetect(stderr), []);
  });
});

describe('buildKeptSegments', () => {
  test('keeps the padded complement of each silence', () => {
    const kept = buildKeptSegments([{ start: 1, end: 2.5 }, { start: 4, end: 4.7 }], 6, 0.15);
    assert.deepEqual(kept, [
      { start: 0, end: 1.15 },
      { start: 2.35, end: 4.15 },
      { start: 4.55, end: 6 },
    ]);
  });

  test('no silences: the whole clip is one kept segment', () => {
    assert.deepEqual(buildKeptSegments([], 6, 0.15), [{ start: 0, end: 6 }]);
  });

  test('a silence covering nearly the whole clip still yields a valid (possibly empty) plan, never inverted', () => {
    const kept = buildKeptSegments([{ start: 0, end: 6 }], 6, 0.15);
    for (const seg of kept) assert.ok(seg.end >= seg.start);
  });

  test('out-of-order input is sorted before padding', () => {
    const kept = buildKeptSegments([{ start: 4, end: 4.7 }, { start: 1, end: 2.5 }], 6, 0);
    assert.deepEqual(kept, [
      { start: 0, end: 1 },
      { start: 2.5, end: 4 },
      { start: 4.7, end: 6 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// ffmpegAsset
// ---------------------------------------------------------------------------

describe('ffmpegAsset', () => {
  test('picks win-x64 for win32/x64', () => {
    assert.deepEqual(ffmpegAsset(FAKE_MANIFEST, 'win32', 'x64'), FAKE_MANIFEST.studio.ffmpeg['win-x64']);
  });

  test('picks linux-x64 for linux/x64', () => {
    assert.deepEqual(ffmpegAsset(FAKE_MANIFEST, 'linux', 'x64'), FAKE_MANIFEST.studio.ffmpeg['linux-x64']);
  });

  test('darwin is always null, regardless of arch', () => {
    assert.equal(ffmpegAsset(FAKE_MANIFEST, 'darwin', 'arm64'), null);
    assert.equal(ffmpegAsset(FAKE_MANIFEST, 'darwin', 'x64'), null);
  });

  test('an unlisted platform/arch is null, never guessed', () => {
    assert.equal(ffmpegAsset(FAKE_MANIFEST, 'linux', 'arm64'), null);
    assert.equal(ffmpegAsset({}, 'linux', 'x64'), null);
  });
});

// ---------------------------------------------------------------------------
// locateFfmpeg (disk only, no network)
// ---------------------------------------------------------------------------

describe('locateFfmpeg', () => {
  test('finds binaries nested one folder deep (the BtbN archive layout)', () => {
    const paths = fakePaths();
    const top = join(paths.bin, 'ffmpeg', 'ffmpeg-master-latest-linux64-gpl', 'bin');
    mkdirSync(top, { recursive: true });
    writeFileSync(join(top, 'ffmpeg'), '');
    writeFileSync(join(top, 'ffprobe'), '');
    const found = locateFfmpeg({ paths, platform: 'linux' });
    assert.equal(found.ffmpeg, join(top, 'ffmpeg'));
    assert.equal(found.ffprobe, join(top, 'ffprobe'));
  });

  test('also finds a flat dir/bin layout', () => {
    const paths = fakePaths();
    const bin = join(paths.bin, 'ffmpeg', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'ffmpeg'), '');
    writeFileSync(join(bin, 'ffprobe'), '');
    const found = locateFfmpeg({ paths, platform: 'linux' });
    assert.equal(found.ffmpeg, join(bin, 'ffmpeg'));
  });

  test('nothing on disk yields null, never throws', () => {
    const paths = fakePaths();
    assert.equal(locateFfmpeg({ paths, platform: 'linux' }), null);
  });

  test('uses .exe names on win32', () => {
    const paths = fakePaths();
    const bin = join(paths.bin, 'ffmpeg', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'ffmpeg.exe'), '');
    writeFileSync(join(bin, 'ffprobe.exe'), '');
    const found = locateFfmpeg({ paths, platform: 'win32' });
    assert.equal(found.ffmpeg, join(bin, 'ffmpeg.exe'));
  });
});

// ---------------------------------------------------------------------------
// run(): a fake spawn() drives real ChildProcess-shaped events, so this
// exercises the real progress parser, timeout, and cancellation logic
// without spawning anything.
// ---------------------------------------------------------------------------

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  return child;
}

describe('run()', () => {
  test('spawns with the fixed flags first, then the caller\'s args, in order', async () => {
    const spawnCalls = [];
    const fakeSpawn = (exe, args) => {
      spawnCalls.push({ exe, args });
      const child = makeFakeChild();
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    await run('ffmpeg-exe', ['-i', 'in.mp4', 'out.mp4'], { spawn: fakeSpawn });
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].exe, 'ffmpeg-exe');
    assert.deepEqual(spawnCalls[0].args, ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-y', '-i', 'in.mp4', 'out.mp4']);
  });

  test('parses out_time_ms (really microseconds) into seconds and a percent of durationSec', async () => {
    const progressEvents = [];
    const fakeSpawn = () => {
      const child = makeFakeChild();
      setImmediate(() => {
        child.stdout.emit('data', 'frame=45\nout_time_ms=3000000\nprogress=continue\n');
        setImmediate(() => {
          child.stdout.emit('data', 'out_time_ms=6000000\nprogress=end\n');
          child.emit('close', 0);
        });
      });
      return child;
    };
    const result = await run('ffmpeg-exe', ['-i', 'in.mp4', 'out.mp4'], {
      spawn: fakeSpawn,
      durationSec: 6,
      onProgress: (p) => progressEvents.push(p),
    });
    assert.equal(result.code, 0);
    assert.equal(progressEvents.length, 2);
    assert.equal(progressEvents[0].seconds, 3);
    assert.equal(progressEvents[0].percent, 50);
    assert.equal(progressEvents[1].percent, 100);
  });

  test('percent is null when durationSec is unknown', async () => {
    const progressEvents = [];
    const fakeSpawn = () => {
      const child = makeFakeChild();
      setImmediate(() => {
        child.stdout.emit('data', 'out_time_ms=3000000\n');
        child.emit('close', 0);
      });
      return child;
    };
    await run('ffmpeg-exe', ['-i', 'in.mp4', 'out.mp4'], { spawn: fakeSpawn, onProgress: (p) => progressEvents.push(p) });
    assert.equal(progressEvents[0].percent, null);
  });

  test('a non-zero exit rejects with the stderr tail and .code, but keeps the full text on .stderr', async () => {
    const fakeSpawn = () => {
      const child = makeFakeChild();
      setImmediate(() => {
        child.stderr.emit('data', 'line1\nline2\nline3\n');
        child.emit('close', 1);
      });
      return child;
    };
    await assert.rejects(
      () => run('ffmpeg-exe', ['-i', 'bad.mp4', 'out.mp4'], { spawn: fakeSpawn }),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.message, /exit 1/);
        assert.match(err.message, /line3/);
        assert.match(err.stderr, /line1/);
        return true;
      },
    );
  });

  test('timeoutMs kills the child and rejects with timedOut', async () => {
    let killed = false;
    const fakeSpawn = () => {
      const child = makeFakeChild();
      child.kill = () => {
        killed = true;
        setImmediate(() => child.emit('close', null));
      };
      return child; // never closes on its own
    };
    await assert.rejects(
      () => run('ffmpeg-exe', ['-i', 'in.mp4', 'out.mp4'], { spawn: fakeSpawn, timeoutMs: 20 }),
      (err) => {
        assert.equal(err.timedOut, true);
        return true;
      },
    );
    assert.equal(killed, true);
  });

  test('an aborted signal kills the child and rejects with cancelled', async () => {
    const controller = new AbortController();
    let killed = false;
    const fakeSpawn = () => {
      const child = makeFakeChild();
      child.kill = () => {
        killed = true;
        setImmediate(() => child.emit('close', null));
      };
      return child;
    };
    const p = run('ffmpeg-exe', ['-i', 'in.mp4', 'out.mp4'], { spawn: fakeSpawn, signal: controller.signal });
    controller.abort();
    await assert.rejects(() => p, (err) => {
      assert.equal(err.cancelled, true);
      return true;
    });
    assert.equal(killed, true);
  });
});

// ---------------------------------------------------------------------------
// probe(): a fake execFile so this tests the JSON-shaping logic, not a
// real ffprobe binary.
// ---------------------------------------------------------------------------

describe('probe()', () => {
  test('shapes ffprobe JSON into { durationSec, width, height, fps, hasAudio, videoCodec, audioCodec }', async () => {
    const fakeJson = JSON.stringify({
      streams: [
        { codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30/1', codec_name: 'h264' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: { duration: '12.5' },
    });
    const fakeExecFile = async (file, args) => {
      assert.equal(file, 'ffprobe-exe');
      assert.deepEqual(args.slice(0, 4), ['-v', 'error', '-print_format', 'json']);
      assert.equal(args[args.length - 1], 'clip.mp4');
      return { stdout: fakeJson, stderr: '' };
    };
    const info = await probe('ffprobe-exe', 'clip.mp4', { execFile: fakeExecFile });
    assert.deepEqual(info, {
      durationSec: 12.5,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
  });

  test('no audio stream: hasAudio false, audioCodec null; 0/0 frame rate: fps null', async () => {
    const fakeExecFile = async () => ({
      stdout: JSON.stringify({
        streams: [{ codec_type: 'video', width: 10, height: 10, avg_frame_rate: '0/0', codec_name: 'vp9' }],
        format: { duration: '1' },
      }),
    });
    const info = await probe('ffprobe-exe', 'x.mp4', { execFile: fakeExecFile });
    assert.equal(info.hasAudio, false);
    assert.equal(info.audioCodec, null);
    assert.equal(info.fps, null);
  });
});

// ---------------------------------------------------------------------------
// ensureFfmpeg(): fake downloads.downloadAsset(), but a REAL tar for
// extraction, so this proves the extraction and binary-location logic
// against a real archive without a real network download.
// ---------------------------------------------------------------------------

async function buildFakeFfmpegArchive(destArchivePath) {
  const stageDir = mkdtempSync(join(tmpdir(), 'stickos-ffmpeg-stage-'));
  const top = join(stageDir, 'ffmpeg-master-latest-linux64-gpl', 'bin');
  mkdirSync(top, { recursive: true });
  writeFileSync(join(top, 'ffmpeg'), '#!/bin/sh\necho fake-ffmpeg\n');
  writeFileSync(join(top, 'ffprobe'), '#!/bin/sh\necho fake-ffprobe\n');
  await execFileAsync('tar', ['-cJf', destArchivePath, '-C', stageDir, 'ffmpeg-master-latest-linux64-gpl']);
  rmSync(stageDir, { recursive: true, force: true });
}

describe('ensureFfmpeg()', () => {
  test('downloads (fake) once, extracts a real tar.xz, chmods the binaries, and is idempotent on a second call', async () => {
    const paths = fakePaths();
    let downloadCalls = 0;
    const downloads = {
      async downloadAsset(asset, destPath, opts) {
        downloadCalls += 1;
        assert.equal(asset.url, FAKE_MANIFEST.studio.ffmpeg['linux-x64'].url);
        if (opts && opts.onProgress) opts.onProgress({ received: 50, total: 100, percent: 0.5 });
        await buildFakeFfmpegArchive(destPath);
        return { path: destPath, sha256: 'x', skipped: false };
      },
    };
    const progressSeen = [];
    const bins = await ensureFfmpeg({
      paths,
      manifest: FAKE_MANIFEST,
      downloads,
      platform: 'linux',
      arch: 'x64',
      onProgress: (p) => progressSeen.push(p),
    });
    assert.equal(downloadCalls, 1);
    assert.ok(existsSync(bins.ffmpeg));
    assert.ok(existsSync(bins.ffprobe));
    assert.ok(progressSeen.length > 0);
    if (process.platform !== 'win32') {
      assert.ok(statSync(bins.ffmpeg).mode & 0o100, 'ffmpeg should be chmod +x');
      assert.ok(statSync(bins.ffprobe).mode & 0o100, 'ffprobe should be chmod +x');
    }

    const again = await ensureFfmpeg({ paths, manifest: FAKE_MANIFEST, downloads, platform: 'linux', arch: 'x64' });
    assert.equal(downloadCalls, 1, 'a second call must not download again');
    assert.deepEqual(again, bins);
  });

  test('darwin with no manifest asset throws DARWIN_NOTE without touching downloads', async () => {
    const paths = fakePaths();
    let called = false;
    const downloads = { async downloadAsset() { called = true; } };
    await assert.rejects(
      () => ensureFfmpeg({ paths, manifest: FAKE_MANIFEST, downloads, platform: 'darwin', arch: 'arm64' }),
      (err) => {
        assert.equal(err.message, DARWIN_NOTE);
        return true;
      },
    );
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// createVideoTools: exact ffmpeg argument construction for every tool, path
// containment, and readiness gating. All against a fake ffmpegLib.
// ---------------------------------------------------------------------------

describe('createVideoTools: trim', () => {
  test('fast trim (precise:false): -ss/-to before -i, -c copy', async () => {
    const { video, paths, calls } = makeVideoTools();
    const input = writeStudioInFile(paths, 'clip.mp4');
    const { output, log } = await video.trim({ file: 'clip.mp4', startSec: 1, endSec: 4, precise: false });
    assert.equal(calls.run.length, 1);
    const { args } = calls.run[0];
    assert.deepEqual(args, ['-ss', '1', '-to', '4', '-i', input, '-c', 'copy', output]);
    assert.match(log, /copying/);
    assert.ok(existsSync(output));
  });

  test('precise trim (precise:true): -i first, -ss/-to after, re-encode', async () => {
    const { video, paths, calls } = makeVideoTools();
    const input = writeStudioInFile(paths, 'clip.mp4');
    const { output, log } = await video.trim({ file: 'clip.mp4', startSec: 1, endSec: 4, precise: true });
    const { args } = calls.run[0];
    assert.deepEqual(args, ['-i', input, '-ss', '1', '-to', '4', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', output]);
    assert.match(log, /re-encode/);
  });

  test('rejects an end at or before the start', async () => {
    const { video, paths } = makeVideoTools();
    writeStudioInFile(paths, 'clip.mp4');
    assert.throws(() => video.trim({ file: 'clip.mp4', startSec: 5, endSec: 5 }), (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    });
  });

  test('rejects a relative path that tries to escape studio/in', async () => {
    const { video, paths } = makeVideoTools();
    writeStudioInFile(paths, 'clip.mp4');
    assert.throws(() => video.trim({ file: '../../etc/passwd', startSec: 0, endSec: 1 }), (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    });
  });

  test('accepts an absolute path outside studio/in (the user picked it through the text field)', async () => {
    const { video } = makeVideoTools();
    const outsideDir = tmpDir();
    const outsideFile = join(outsideDir, 'elsewhere.mp4');
    writeFileSync(outsideFile, 'x');
    const { output } = await video.trim({ file: outsideFile, startSec: 0, endSec: 1 });
    assert.ok(output);
  });

  test('a file that does not exist is a plain 400, not a crash', async () => {
    const { video } = makeVideoTools();
    assert.throws(() => video.trim({ file: 'nope.mp4', startSec: 0, endSec: 1 }), (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    });
  });

  test('when ffmpeg is not set up yet, every tool throws a 409 synchronously (no job queued)', async () => {
    const notReadyLib = makeFakeFfmpegLib().lib;
    notReadyLib.locateFfmpeg = () => null;
    const { video, paths } = makeVideoTools({ ffmpegLibAndCalls: { lib: notReadyLib, calls: { run: [], probe: [] } } });
    writeStudioInFile(paths, 'clip.mp4');
    assert.throws(() => video.trim({ file: 'clip.mp4', startSec: 0, endSec: 1 }), (err) => {
      assert.equal(err.statusCode, 409);
      return true;
    });
    assert.deepEqual(video.jobs(), []);
  });
});

describe('createVideoTools: join', () => {
  test('same format: writes an escaped concat list and runs -f concat -c copy', async () => {
    const { video, paths, calls } = makeVideoTools({
      fakeOpts: { probeResults: { durationSec: 3, width: 320, height: 240, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, fps: 15 } },
    });
    writeStudioInFile(paths, 'a.mp4');
    writeStudioInFile(paths, "b's clip.mp4");
    const aPath = join(paths.base, 'studio', 'in', 'a.mp4');
    const bPath = join(paths.base, 'studio', 'in', "b's clip.mp4");
    const { output, log } = await video.join({ files: ['a.mp4', "b's clip.mp4"] });
    const joinRun = calls.run.find((c) => c.args.includes('-f') && c.args.includes('concat'));
    assert.ok(joinRun, 'expected a concat demuxer run');
    assert.deepEqual(joinRun.args.slice(0, 3), ['-f', 'concat', '-safe']);
    assert.deepEqual(joinRun.args.slice(-3), ['-c', 'copy', output]);
    assert.equal(calls.concatLists.length, 1);
    assert.equal(calls.concatLists[0], `${formatConcatLine(aPath)}\n${formatConcatLine(bPath)}\n`);
    assert.match(log, /without re-encoding/);
  });

  test('different codecs or sizes: falls back to a filter_complex concat re-encode', async () => {
    const { video, paths, calls } = makeVideoTools({
      fakeOpts: {
        probeResults: [
          { durationSec: 3, width: 320, height: 240, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, fps: 15 },
          { durationSec: 4, width: 640, height: 480, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, fps: 15 },
        ],
      },
    });
    writeStudioInFile(paths, 'a.mp4');
    writeStudioInFile(paths, 'b.mp4');
    const { output, log } = await video.join({ files: ['a.mp4', 'b.mp4'] });
    const filterRun = calls.run.find((c) => c.args.includes('-filter_complex'));
    assert.ok(filterRun, 'expected a filter_complex re-encode run');
    const graphIdx = filterRun.args.indexOf('-filter_complex') + 1;
    assert.equal(filterRun.args[graphIdx], '[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]');
    assert.deepEqual(filterRun.args.slice(-13), [
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac',
      output,
    ]);
    assert.match(log, /re-encode/);
  });

  test('needs at least two clips', async () => {
    const { video, paths } = makeVideoTools();
    writeStudioInFile(paths, 'a.mp4');
    assert.throws(() => video.join({ files: ['a.mp4'] }), (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    });
  });
});

describe('createVideoTools: captions', () => {
  test('extracts 16kHz mono s16le audio, calls stt per window, writes an SRT (no burn-in)', async () => {
    const transcribed = [];
    const stt = {
      async transcribeBuffer(buf, sampleRate) {
        transcribed.push({ length: buf.length, sampleRate });
        return { text: 'hello there general kenobi', ms: 1 };
      },
    };
    const { video, paths, calls } = makeVideoTools({
      stt,
      fakeOpts: { probeResults: { durationSec: 40, width: 320, height: 240, hasAudio: true, fps: 15, videoCodec: 'h264', audioCodec: 'aac' } },
    });
    writeStudioInFile(paths, 'talk.mp4');
    const { output, srt, log } = await video.captions({ file: 'talk.mp4', burnIn: false });

    const extractRun = calls.run.find((c) => c.args.includes('s16le'));
    assert.ok(extractRun, 'expected an audio-extraction run');
    assert.deepEqual(extractRun.args.slice(0, 8), ['-i', join(paths.base, 'studio', 'in', 'talk.mp4'), '-vn', '-ac', '1', '-ar', '16000', '-f']);
    assert.equal(extractRun.args[8], 's16le');

    // 40s of audio, 30s windows with 0.5s overlap (29.5s step) -> 2 windows
    assert.equal(transcribed.length, 2);
    assert.equal(transcribed[0].sampleRate, 16000);

    assert.equal(output, srt);
    assert.ok(existsSync(srt));
    const text = readFileSync(srt, 'utf8');
    assert.match(text, /hello there/);
    assert.match(log, /caption cue/);
    // no burn-in: only the extraction run touched ffmpeg
    assert.equal(calls.run.length, 1);
  });

  test('burnIn true also renders a subtitles= filter with the escaped SRT path', async () => {
    const { video, paths, calls } = makeVideoTools({
      fakeOpts: { probeResults: { durationSec: 5, width: 320, height: 240, hasAudio: true, fps: 15, videoCodec: 'h264', audioCodec: 'aac' } },
    });
    writeStudioInFile(paths, 'talk.mp4');
    const { output, srt } = await video.captions({ file: 'talk.mp4', burnIn: true });
    assert.notEqual(output, srt);
    assert.ok(output.endsWith('.mp4'));
    assert.ok(srt.endsWith('.srt'));
    const burnRun = calls.run.find((c) => c.args.includes('-vf'));
    assert.ok(burnRun);
    const vfIdx = burnRun.args.indexOf('-vf') + 1;
    assert.equal(burnRun.args[vfIdx], `subtitles=${escapeFilterPath(srt)}:force_style='FontSize=22,Outline=1'`);
  });

  test('without an stt engine, fails fast with the plain-language fallback message', async () => {
    const { video, paths } = makeVideoTools({ stt: null });
    writeStudioInFile(paths, 'talk.mp4');
    assert.throws(() => video.captions({ file: 'talk.mp4' }), (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, "Captions need Scout's ears, which are still downloading.");
      return true;
    });
  });
});

describe('createVideoTools: silence', () => {
  const SILENCE_STDERR = [
    '[Parsed_silencedetect_0] silence_start: 1.0',
    '[Parsed_silencedetect_0] silence_end: 2.5 | silence_duration: 1.5',
  ].join('\n');

  test('runs silencedetect, then cuts and rejoins the kept segments', async () => {
    const { video, paths, calls } = makeVideoTools({
      fakeOpts: {
        silenceStderr: SILENCE_STDERR,
        probeResults: { durationSec: 6, width: 320, height: 240, hasAudio: true, fps: 15, videoCodec: 'h264', audioCodec: 'aac' },
      },
    });
    writeStudioInFile(paths, 'clip.mp4');
    const { output, log, removedSeconds } = await video.silence({ file: 'clip.mp4', thresholdDb: -35, minSilenceSec: 0.6, paddingSec: 0.15 });

    const detectRun = calls.run.find((c) => c.args.some((a) => typeof a === 'string' && a.includes('silencedetect')));
    assert.ok(detectRun);
    assert.deepEqual(detectRun.args.slice(-3), ['-f', 'null', '-']);
    assert.ok(detectRun.args.includes('silencedetect=noise=-35dB:d=0.6'));

    // two kept segments (0 to 1.15, 2.35 to 6) -> two per-segment cuts, then one join
    const segmentRuns = calls.run.filter((c) => c.args.includes('-ss') && c.args.includes('libx264'));
    assert.equal(segmentRuns.length, 2);
    for (const seg of segmentRuns) {
      assert.deepEqual(seg.args.slice(0, 2), ['-i', join(paths.base, 'studio', 'in', 'clip.mp4')]);
      assert.ok(seg.args.includes('-crf'));
    }
    const joinRun = calls.run.find((c) => c.args.includes('-f') && c.args.includes('concat') && c.args.includes('copy'));
    assert.ok(joinRun);
    assert.equal(joinRun.args[joinRun.args.length - 1], output);

    assert.ok(removedSeconds > 0);
    assert.match(log, /removed/);
  });

  test('no silence found: copies the file through unchanged and says so', async () => {
    const { video, paths, calls } = makeVideoTools({
      fakeOpts: { probeResults: { durationSec: 6, width: 320, height: 240, hasAudio: true, fps: 15, videoCodec: 'h264', audioCodec: 'aac' } },
    });
    writeStudioInFile(paths, 'clip.mp4');
    const { log, removedSeconds } = await video.silence({ file: 'clip.mp4' });
    assert.equal(removedSeconds, 0);
    assert.match(log, /no quiet stretches/);
    const copyRun = calls.run.find((c) => c.args.includes('copy') && c.args.includes('-i'));
    assert.ok(copyRun);
  });
});

describe('createVideoTools: shorts', () => {
  test('crop mode: scale then center-crop to 1080x1920', async () => {
    const { video, paths, calls } = makeVideoTools();
    const input = writeStudioInFile(paths, 'clip.mp4');
    const { output, log } = await video.shorts({ file: 'clip.mp4', mode: 'crop' });
    const { args } = calls.run[0];
    assert.deepEqual(args, ['-i', input, '-vf', 'scale=-2:1920,crop=1080:1920', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', output]);
    assert.match(log, /crop/);
  });

  test('blur mode: split into a blurred background and a centered foreground', async () => {
    const { video, paths, calls } = makeVideoTools();
    const input = writeStudioInFile(paths, 'clip.mp4');
    const { output } = await video.shorts({ file: 'clip.mp4', mode: 'blur' });
    const { args } = calls.run[0];
    assert.deepEqual(args, [
      '-i', input,
      '-filter_complex', 'split[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20[bg2];[fg]scale=1080:-2[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac',
      output,
    ]);
  });

  test('rejects a mode that is neither crop nor blur', async () => {
    const { video, paths } = makeVideoTools();
    writeStudioInFile(paths, 'clip.mp4');
    assert.throws(() => video.shorts({ file: 'clip.mp4', mode: 'sepia' }), (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    });
  });
});

describe('createVideoTools: setup and status', () => {
  test('status() reports present/canSetUp from locateFfmpeg + ffmpegAsset', async () => {
    const { video } = makeVideoTools();
    const status = video.status();
    assert.equal(status.present, true);
    assert.equal(status.canSetUp, true);
    assert.equal(status.note, null);
  });

  test('setup() calls ensureFfmpeg, reports progress, and logs to netlog on success and failure', async () => {
    const netlogCalls = [];
    const netlog = { record: (e) => netlogCalls.push(e) };
    const paths = fakePaths();
    const { lib } = makeFakeFfmpegLib();
    let progressReported = false;
    lib.ensureFfmpeg = async ({ onProgress }) => {
      if (onProgress) {
        onProgress({ percent: 0.5 });
        progressReported = true;
      }
      return { ffmpeg: 'FAKE_FFMPEG', ffprobe: 'FAKE_FFPROBE' };
    };
    const video = createVideoTools({ paths, manifest: FAKE_MANIFEST, downloads: {}, stt: null, bus: null, netlog, ffmpegLib: lib });
    const { log } = await video.setup();
    assert.equal(progressReported, true);
    assert.match(log, /installed/);
    assert.equal(netlogCalls.length, 2);
    assert.equal(netlogCalls[0].ok, true);
    assert.equal(netlogCalls[1].ok, true);
    assert.equal(netlogCalls[0].kind, 'https');

    const failingLib = { ...lib, ensureFfmpeg: async () => { throw new Error('boom'); } };
    const netlogCalls2 = [];
    const video2 = createVideoTools({
      paths: fakePaths(),
      manifest: FAKE_MANIFEST,
      downloads: {},
      stt: null,
      bus: null,
      netlog: { record: (e) => netlogCalls2.push(e) },
      ffmpegLib: failingLib,
    });
    await assert.rejects(() => video2.setup());
    assert.equal(netlogCalls2[netlogCalls2.length - 1].ok, false);
  });
});

describe('createVideoTools: job list and cancel', () => {
  test('jobs() lists queued/running/done jobs; cancel() stops a queued job before it runs', async () => {
    const { video, paths } = makeVideoTools();
    writeStudioInFile(paths, 'a.mp4');
    writeStudioInFile(paths, 'b.mp4');

    const first = video.trim({ file: 'a.mp4', startSec: 0, endSec: 1 });
    const second = video.trim({ file: 'b.mp4', startSec: 0, endSec: 1 });

    // the second job is still queued right after both calls return
    const cancelResult = video.cancel(second.jobId);
    assert.equal(cancelResult.ok, true);
    await assert.rejects(() => second, (err) => {
      assert.equal(err.cancelled, true);
      return true;
    });
    await first;

    const jobs = video.jobs();
    const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));
    assert.equal(byId[first.jobId].state, 'done');
    assert.equal(byId[second.jobId].state, 'cancelled');
  });

  test('cancel() on an unknown id returns ok:false', () => {
    const { video } = makeVideoTools();
    assert.deepEqual(video.cancel('nope'), { ok: false, reason: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// wireVideo: routes on a real server, with the same fakes
// ---------------------------------------------------------------------------

describe('wireVideo on a real server', () => {
  async function setup() {
    const app = await startServer({ baseDir: tmpDir(), port: testPort() });
    const { video, paths, busEvents } = makeVideoTools({ paths: app.paths, bus: app.bus });
    wireVideo(app, { video });
    return { app, video, paths, busEvents };
  }

  test('GET /api/video/status, GET /api/video/files, POST /api/video/probe', async () => {
    const { app, paths } = await setup();
    try {
      writeStudioInFile(paths, 'clip.mp4');
      const status = await (await fetch(`${app.origin}/api/video/status`)).json();
      assert.equal(status.present, true);

      const files = await (await fetch(`${app.origin}/api/video/files`)).json();
      assert.equal(files.files.length, 1);
      assert.equal(files.files[0].name, 'clip.mp4');

      const probeRes = await fetch(`${app.origin}/api/video/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ file: 'clip.mp4' }),
      });
      assert.equal(probeRes.status, 200);
      const probeBody = await probeRes.json();
      assert.equal(probeBody.width, 320);

      const missingRes = await fetch(`${app.origin}/api/video/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ file: 'missing.mp4' }),
      });
      assert.equal(missingRes.status, 400);
    } finally {
      await app.close();
    }
  });

  test('POST without a token is rejected before any job runs', async () => {
    const { app, paths } = await setup();
    try {
      writeStudioInFile(paths, 'clip.mp4');
      const res = await fetch(`${app.origin}/api/video/trim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'clip.mp4', startSec: 0, endSec: 1 }),
      });
      assert.equal(res.status, 401);
    } finally {
      await app.close();
    }
  });

  test('POST /api/video/trim returns 202 + jobId; the job completes and shows up in GET /api/video/jobs', async () => {
    const { app, paths } = await setup();
    try {
      writeStudioInFile(paths, 'clip.mp4');
      const res = await fetch(`${app.origin}/api/video/trim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ file: 'clip.mp4', startSec: 0, endSec: 1, precise: false }),
      });
      assert.equal(res.status, 202);
      const { jobId } = await res.json();
      assert.ok(jobId);

      let job = null;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const jobs = (await (await fetch(`${app.origin}/api/video/jobs`)).json()).jobs;
        job = jobs.find((j) => j.id === jobId);
        if (job && job.state === 'done') break;
        await wait(20);
      }
      assert.ok(job && job.state === 'done', 'expected the job to finish');
      assert.ok(existsSync(job.output));
    } finally {
      await app.close();
    }
  });

  test('POST /api/video/cancel on an unknown jobId is a 404', async () => {
    const { app } = await setup();
    try {
      const res = await fetch(`${app.origin}/api/video/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ jobId: 'nope' }),
      });
      assert.equal(res.status, 404);
    } finally {
      await app.close();
    }
  });

  test('a bad request body (missing file) is a 400 with a plain message, not a 500', async () => {
    const { app } = await setup();
    try {
      const res = await fetch(`${app.origin}/api/video/trim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ startSec: 0, endSec: 1 }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'invalid_request');
    } finally {
      await app.close();
    }
  });

  test('video progress reaches GET /api/events as SSE type "video"', async () => {
    const { app, paths } = await setup();
    try {
      writeStudioInFile(paths, 'clip.mp4');
      const sseRes = await fetch(`${app.origin}/api/events`);
      await fetch(`${app.origin}/api/video/trim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
        body: JSON.stringify({ file: 'clip.mp4', startSec: 0, endSec: 1 }),
      });
      const events = await readSseEvents(sseRes, 800);
      const videoEvents = events.filter((e) => e.type === 'video');
      assert.ok(videoEvents.length > 0, 'expected at least one video SSE event');
      assert.ok(videoEvents.every((e) => typeof e.data.jobId === 'string'));
      assert.ok(videoEvents.some((e) => e.data.phase === 'done'));
    } finally {
      await app.close();
    }
  });

  test('GET /api/status includes a video status provider', async () => {
    const { app } = await setup();
    try {
      const status = await (await fetch(`${app.origin}/api/status`)).json();
      assert.ok(status.video);
      assert.equal(status.video.present, true);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ONE real integration test: downloads the actual BtbN linux64 static
// ffmpeg build, generates the fixture clip with it, and runs probe, trim
// (fast and precise), a silence cut, and a shorts crop through the real
// pipeline end to end. Skipped with a clear message if the download fails
// (no network in this environment, GitHub unreachable, and so on).
//
// manifest.json's own studio.ffmpeg.linux-x64 entry currently points at a
// dead tag (BtbN/FFmpeg-Builds releases/download/n9.0/... 404s: that tag
// does not exist any more). This test builds its own manifest fragment with
// the real, verified-working URL (BtbN's rolling "latest" release,
// ffmpeg-master-latest-linux64-gpl.tar.xz) instead of trusting the
// committed manifest, since fixing that file is outside this change's
// ownership; see the handoff notes for the working URL to put there.
// ---------------------------------------------------------------------------

const REAL_LINUX_FFMPEG_ASSET = {
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
  size: null,
  sha256: null,
};

test(
  'integration: real ffmpeg download, real fixture clip, probe/trim/silence/shorts',
  { timeout: 300000 },
  async (t) => {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      t.skip('this integration test only targets the linux-x64 BtbN build');
      return;
    }

    const paths = fakePaths();
    const manifest = { studio: { ffmpeg: { 'linux-x64': REAL_LINUX_FFMPEG_ASSET, 'win-x64': null, 'darwin-arm64': null } } };
    const { downloadAsset } = await import('../app/lib/downloads.js');
    const downloads = { downloadAsset: (asset, dest, opts) => downloadAsset(asset, dest, { statePath: join(paths.base, 'download-manifest.json'), ...opts }) };

    let bins;
    try {
      bins = await ensureFfmpeg({ paths, manifest, downloads, platform: 'linux', arch: 'x64' });
    } catch (err) {
      t.skip(`could not download the real ffmpeg build, skipping: ${(err && err.message) || err}`);
      return;
    }
    assert.ok(existsSync(bins.ffmpeg));
    assert.ok(existsSync(bins.ffprobe));

    const fixturePath = join(paths.base, 'fixture.mp4');
    await makeFixtureClip(bins.ffmpeg, fixturePath);
    assert.ok(existsSync(fixturePath));

    const video = createVideoTools({ paths, manifest, downloads, stt: null, bus: null, netlog: null });
    writeStudioInFile(paths, 'fixture.mp4', readFileSync(fixturePath));

    // probe: this really is the 6-second clip make.mjs asked for
    const info = await video.probe({ file: 'fixture.mp4' });
    assert.ok(Math.abs(info.durationSec - 6) < 0.5, `unexpected duration ${info.durationSec}`);
    assert.equal(info.width, 320);
    assert.equal(info.height, 240);
    assert.equal(info.hasAudio, true);

    // trim, fast (stream copy)
    const fast = await video.trim({ file: 'fixture.mp4', startSec: 0.5, endSec: 3, precise: false });
    assert.ok(existsSync(fast.output));
    const fastInfo = await video.probe({ file: fast.output });
    assert.ok(fastInfo.durationSec > 1 && fastInfo.durationSec < 3.5, `fast trim duration off: ${fastInfo.durationSec}`);

    // trim, precise (re-encode)
    const precise = await video.trim({ file: 'fixture.mp4', startSec: 0.5, endSec: 3, precise: true });
    assert.ok(existsSync(precise.output));
    const preciseInfo = await video.probe({ file: precise.output });
    assert.ok(Math.abs(preciseInfo.durationSec - 2.5) < 0.35, `precise trim duration off: ${preciseInfo.durationSec}`);

    // cut silence: the fixture has two silent gaps (1.5s and 0.7s), well
    // above the 0.6s default minimum, so real seconds should come off.
    const cut = await video.silence({ file: 'fixture.mp4' });
    assert.ok(existsSync(cut.output));
    assert.ok(cut.removedSeconds > 1, `expected real quiet time removed, got ${cut.removedSeconds}`);
    const cutInfo = await video.probe({ file: cut.output });
    assert.ok(cutInfo.durationSec < info.durationSec, 'the silence cut should shorten the clip');

    // shorts, crop mode: real 1080x1920 output
    const shorts = await video.shorts({ file: 'fixture.mp4', mode: 'crop' });
    assert.ok(existsSync(shorts.output));
    const shortsInfo = await video.probe({ file: shorts.output });
    assert.equal(shortsInfo.width, 1080);
    assert.equal(shortsInfo.height, 1920);
  },
);
