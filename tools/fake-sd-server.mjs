#!/usr/bin/env node
// tools/fake-sd-server.mjs: stands in for the real stable-diffusion.cpp
// sd-server binary in tests/images.test.js, so those tests can drive
// app/lib/studio/sdcpp.js without a real multi-hundred-megabyte binary or a
// GPU. It answers just enough of the real HTTP API (see examples/server/
// api.md in the leejet/stable-diffusion.cpp source, and the header comment
// in sdcpp.js) for createSdServer()'s txt2img() to work end to end:
//
//   GET  /                              readiness probe (sd-server itself
//                                        answers this once the model, which
//                                        it loads before it ever starts
//                                        listening, is ready)
//   POST /sdcpp/v1/img_gen              submit a job, 202 + { id }
//   GET  /sdcpp/v1/jobs/:id             poll job status
//   POST /sdcpp/v1/jobs/:id/cancel      cancel a job
//
// Launch args mirror the real sd-server ones sdcpp.js actually passes:
// -m/--model, -l/--listen-ip, --listen-port. Two more, --delay-ms and
// --fail, are not real sd-server flags; they are test-only knobs a test's
// spawn wrapper appends after the real args, the same way
// tests/engine.test.js's fake-engine.mjs does.
//
// Usage: node tools/fake-sd-server.mjs -m <model> -l 127.0.0.1 --listen-port 1234 [--delay-ms 30] [--fail]

import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

function parseArgs(argv) {
  const out = { listenIp: '127.0.0.1', listenPort: 1234, model: null, delayMs: 30, fail: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' || a === '--model') out.model = argv[++i];
    else if (a === '-l' || a === '--listen-ip') out.listenIp = argv[++i];
    else if (a === '--listen-port') out.listenPort = Number(argv[++i]);
    else if (a === '--delay-ms') out.delayMs = Number(argv[++i]);
    else if (a === '--fail') out.fail = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// A real, small PNG, built by hand: signature, IHDR, one IDAT (zlib-wrapped
// DEFLATE of a solid-color 16x16 truecolor bitmap), IEND, each chunk with
// its own CRC32. See CLAUDE.md and downloads.js for why nothing in this app
// trusts a library to get bytes-on-disk right without checking; this file
// has the same "write it and verify it" spirit turned around, on the
// generating side instead of the checking side.
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

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function makeSolidPng(width = 16, height = 16, [r, g, b] = [90, 140, 210]) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor (RGB, no alpha)
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const ihdr = pngChunk('IHDR', ihdrData);

  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0; // per-scanline filter type: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  const idat = pngChunk('IDAT', deflateSync(raw)); // PNG IDAT wants zlib-wrapped deflate, not raw
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

// ---------------------------------------------------------------------------
// The server itself
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const png = makeSolidPng(16, 16, [90, 140, 210]);
  const b64 = png.toString('base64');

  let nextId = 1;
  const jobs = new Map(); // id -> { status, createdAt, result, error }

  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendJson(res, 400, { error: 'bad url' });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(res, 200, { ok: true, note: 'fake sd-server', model: args.model });
    }

    if (req.method === 'POST' && url.pathname === '/sdcpp/v1/img_gen') {
      let body = {};
      try {
        const raw = (await readBody(req)).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      if (!body.prompt) return sendJson(res, 400, { error: 'prompt is required' });

      const id = `job_${nextId++}`;
      const createdAt = Date.now();
      const job = { status: 'queued', createdAt, result: null, error: null };
      jobs.set(id, job);

      setTimeout(() => {
        if (job.status === 'queued') job.status = 'generating';
      }, Math.min(10, args.delayMs));

      setTimeout(() => {
        if (job.status === 'cancelled') return;
        if (args.fail) {
          job.status = 'failed';
          job.error = { code: 'generation_failed', message: 'fake sd-server was told to fail' };
        } else {
          job.status = 'completed';
          job.result = { output_format: 'png', images: [{ index: 0, b64_json: b64 }] };
        }
      }, args.delayMs);

      return sendJson(res, 202, {
        id,
        kind: 'img_gen',
        status: 'queued',
        created: Math.floor(createdAt / 1000),
        poll_url: `/sdcpp/v1/jobs/${id}`,
      });
    }

    const jobMatch = url.pathname.match(/^\/sdcpp\/v1\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, {
        id: jobMatch[1],
        kind: 'img_gen',
        status: job.status,
        created: Math.floor(job.createdAt / 1000),
        result: job.result,
        error: job.error,
      });
    }

    const cancelMatch = url.pathname.match(/^\/sdcpp\/v1\/jobs\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'not found' });
      job.status = 'cancelled';
      job.error = { code: 'cancelled', message: 'job cancelled by client' };
      return sendJson(res, 200, { id: cancelMatch[1], status: 'cancelled' });
    }

    return sendJson(res, 404, { error: 'not found' });
  });

  server.listen(args.listenPort, args.listenIp, () => {
    // The real sd-server logs "listening on: ..." to stdout on startup;
    // mirrored here in case a test ever scrapes child stdout for it.
    console.log(`listening on: http://${args.listenIp}:${args.listenPort}`);
  });

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('fake-sd-server.mjs');
if (isDirectRun) main();
