// tests/fixtures/video/make.mjs: builds a tiny (6s, 320x240) test clip out
// of ffmpeg's own lavfi test sources (testsrc + a sine tone), with two
// silent gaps mixed into the audio so the "cut silence" tool has something
// real to find. Needs a real ffmpeg binary; the integration test in
// tests/video.test.js calls ensureFfmpeg() first and passes its path in.
//
// Usage (as a module):
//   import { makeFixtureClip } from './make.mjs';
//   await makeFixtureClip(ffmpegPath, '/tmp/fixture.mp4');
//
// Usage (standalone, once you already have an ffmpeg binary somewhere):
//   node tests/fixtures/video/make.mjs /path/to/ffmpeg /tmp/fixture.mp4

import { run } from '../../../app/lib/studio/ffmpeg.js';

// Two gaps: 1.5s at [1, 2.5) and 0.7s at [4, 4.7), both above the video
// tools' default 0.6s minimum silence length, leaving three audible
// stretches (0-1, 2.5-4, 4.7-6) so trim/join/shorts have real content to
// cut around too.
const SILENCE_FILTER = "volume=enable='between(t,1,2.5)+between(t,4,4.7)':volume=0";

export async function makeFixtureClip(ffmpegPath, outPath, { durationSec = 6, size = '320x240', rate = 15, frequency = 440 } = {}) {
  const args = [
    '-f', 'lavfi', '-i', `testsrc=duration=${durationSec}:size=${size}:rate=${rate}`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${durationSec}`,
    '-filter_complex', `[1:a]${SILENCE_FILTER}[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-shortest',
    outPath,
  ];
  await run(ffmpegPath, args, { durationSec });
  return outPath;
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (isDirectRun) {
  const [ffmpegPath, outPath] = process.argv.slice(2);
  if (!ffmpegPath || !outPath) {
    console.error('usage: node make.mjs <ffmpegPath> <outPath>');
    process.exit(1);
  }
  await makeFixtureClip(ffmpegPath, outPath);
  console.log('wrote', outPath);
}
