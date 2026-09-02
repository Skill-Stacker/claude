#!/usr/bin/env node
// Builds the public installer page: a single self-contained HTML file with
// no external requests. It embeds every file under payload/ as a
// <script type="text/plain" data-path="AI-on-a-Stick/..."> block that the
// page's own JS (see tools/installer-template.html) reads back out,
// byte for byte, either straight to a USB stick (File System Access API)
// or as a hand-rolled in-browser ZIP.
//
// Usage:
//   node tools/build-installer.mjs [--out dist/installer.html] [--version <v>] [--payload <dir>]
//
// The live page is served as PHP, so "<?" or "?>" anywhere in the output
// would execute. Never use an em dash. Never leave a payload's "</script>"
// unescaped. These are enforced below as hard build gates.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MARKER = '<!-- STICKOS_PAYLOAD_FILES -->';
const MAX_BYTES = 500000;
const EM_DASH = '—';

export function parseArgs(argv) {
  const args = {
    out: path.join(repoRoot, 'dist', 'installer.html'),
    version: null,
    payload: path.join(repoRoot, 'payload'),
    template: path.join(__dirname, 'installer-template.html'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--payload') args.payload = path.resolve(argv[++i]);
    else if (a === '--template') args.template = path.resolve(argv[++i]);
    else throw new Error(`build-installer: unknown argument "${a}"`);
  }
  return args;
}

function readVersion(explicit) {
  if (explicit) return explicit;
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return pkg.version;
}

export function walkFiles(dir) {
  const out = [];
  function walk(d, rel) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(d, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, relPath);
      else if (e.isFile()) out.push({ full, rel: relPath });
    }
  }
  walk(dir, '');
  return out;
}

// Original line ending of a raw file buffer: "crlf" only when every
// newline in the file is preceded by a CR, else "lf".
export function detectEol(buf) {
  let sawCrlf = false;
  let sawLoneLf = false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i > 0 && buf[i - 1] === 0x0d) sawCrlf = true;
      else sawLoneLf = true;
    }
  }
  if (sawCrlf && !sawLoneLf) return 'crlf';
  return 'lf';
}

export function rewriteAppVersion(text, version) {
  return text.replace(/("app_version"\s*:\s*)"[^"]*"/, (_m, p1) => `${p1}"${version}"`);
}

// The page's own collectFiles() un-escapes with split("<\\/script>").join("</script>").
// This is the exact inverse.
export function escapeForEmbed(text) {
  return text.split('</script>').join('<\\/script>');
}

export function buildEmbedBlock(dataPath, eol, escapedContent) {
  return `<script type="text/plain" data-path="${dataPath}" data-eol="${eol}">\n${escapedContent}</script>`;
}

function buildPayloadBlocks(payloadDir, version) {
  const files = walkFiles(payloadDir);
  const blocks = [];
  const sizes = [];
  let total = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    const eol = detectEol(buf);
    let text = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (path.basename(f.rel) === 'settings.json') {
      text = rewriteAppVersion(text, version);
    }
    const dataPath = `AI-on-a-Stick/${f.rel.split(path.sep).join('/')}`;
    blocks.push(buildEmbedBlock(dataPath, eol, escapeForEmbed(text)));
    const size = Buffer.byteLength(text, 'utf8');
    sizes.push({ path: dataPath, size });
    total += size;
  }
  return { blocks, sizes, total };
}

// node --check on every real (non text/plain) inline <script> body.
function checkInlineScripts(html, errors) {
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let idx = 0;
  while ((m = scriptRe.exec(html))) {
    const attrs = m[1] || '';
    if (/type\s*=\s*"text\/plain"/i.test(attrs)) continue;
    const body = m[2];
    if (!body.trim()) continue;
    idx++;
    const tmpFile = path.join(
      os.tmpdir(),
      `stickos-installer-check-${process.pid}-${idx}-${Date.now()}.js`,
    );
    fs.writeFileSync(tmpFile, body, 'utf8');
    try {
      const res = spawnSync(process.execPath, ['--check', tmpFile], { encoding: 'utf8' });
      if (res.status !== 0) {
        errors.push(`node --check failed on inline script #${idx}: ${(res.stderr || '').trim()}`);
      }
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }
}

export function runGates(html) {
  const errors = [];

  if (html.includes('<?') || html.includes('?>')) {
    errors.push('output contains "<?" or "?>" (the live page is served as PHP and would execute it)');
  }
  if (html.includes(EM_DASH)) {
    errors.push('output contains an em dash (U+2014)');
  }
  // A real payload may legitimately contain the literal text "<script>"
  // (a bare opening tag has no special meaning inside another tag's script
  // data), so counting "<script" and "</script>" substrings independently
  // is not a valid check. Instead, sweep out every well-formed block the
  // same way an HTML tokenizer would (lazily, up to the nearest literal
  // "</script>"), then confirm nothing script-tag-shaped is left over.
  // An unescaped "</script>" inside a payload ends its own block early and
  // leaves a stray fragment behind; a fully escaped payload leaves none.
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  if (/<\/?script\b/i.test(stripped)) {
    errors.push('a payload appears to contain an unescaped </script> (script tag boundaries do not balance)');
  }
  const byteSize = Buffer.byteLength(html, 'utf8');
  if (byteSize > MAX_BYTES) {
    errors.push(`output is ${byteSize} bytes, over the ${MAX_BYTES} byte cap`);
  }
  checkInlineScripts(html, errors);

  if (errors.length) {
    const err = new Error(
      `build-installer: ${errors.length} gate(s) failed:\n` + errors.map((e) => `  - ${e}`).join('\n'),
    );
    err.gateErrors = errors;
    throw err;
  }
  return byteSize;
}

export function assemble(template, blocks) {
  if (!template.includes(MARKER)) {
    throw new Error(`build-installer: template is missing the ${MARKER} marker`);
  }
  return template.replace(MARKER, blocks.join('\n\n'));
}

export function main(argv) {
  const args = parseArgs(argv);
  const version = readVersion(args.version);

  if (!fs.existsSync(args.payload)) {
    console.warn(`warning: payload directory not found: ${args.payload}`);
  }
  const { blocks, sizes, total } = buildPayloadBlocks(args.payload, version);
  if (sizes.length === 0) {
    console.warn(`warning: no files found under ${args.payload}`);
  }

  console.log('Payload files:');
  for (const row of sizes) {
    console.log(`  ${String(row.size).padStart(10)}  ${row.path}`);
  }
  console.log(`  ${String(total).padStart(10)}  TOTAL`);

  const template = fs.readFileSync(args.template, 'utf8');
  const html = assemble(template, blocks);
  const byteSize = runGates(html);

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, html, 'utf8');
  console.log(`\nWrote ${args.out} (${byteSize} bytes, version ${version})`);
  return { out: args.out, byteSize, version, fileCount: sizes.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
