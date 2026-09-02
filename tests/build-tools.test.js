import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as installer from '../tools/build-installer.mjs';
import * as release from '../tools/build-release.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function mkScratch(prefix) {
  // Always under the OS temp dir, never inside the repo.
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// helpers shared by the build-installer round-trip tests: pull the page's
// own collectFiles() out of the template and run it in a tiny VM sandbox
// against script blocks parsed back out of a real build's output.
// ---------------------------------------------------------------------------

function extractInstallerLogic(templateHtml) {
  const m = templateHtml.match(/<script id="installer-logic">([\s\S]*?)<\/script>/);
  assert.ok(m, 'template should have a <script id="installer-logic"> block');
  return m[1];
}

function extractPayloadNodes(html) {
  const re = /<script type="text\/plain" data-path="([^"]*)" data-eol="([^"]*)">\n([\s\S]*?)<\/script>/g;
  const nodes = [];
  let m;
  while ((m = re.exec(html))) {
    const [, dataPath, eol, content] = m;
    nodes.push({
      getAttribute(name) {
        if (name === 'data-path') return dataPath;
        if (name === 'data-eol') return eol;
        return null;
      },
      // The real leading newline the browser's DOM would hand back too,
      // since collectFiles() strips exactly one before doing anything else.
      textContent: `\n${content}`,
    });
  }
  return nodes;
}

function collectViaVm(logicSrc, nodes) {
  const sandbox = {
    document: {
      querySelectorAll() {
        return nodes;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${logicSrc}\nthis.__out = collectFiles();`, sandbox, { filename: 'installer-logic.js' });
  return sandbox.__out;
}

function collectFromBuiltHtml(html) {
  const templatePath = path.join(repoRoot, 'tools', 'installer-template.html');
  const logicSrc = extractInstallerLogic(fs.readFileSync(templatePath, 'utf8'));
  return collectViaVm(logicSrc, extractPayloadNodes(html));
}

// ---------------------------------------------------------------------------
// build-installer.mjs
// ---------------------------------------------------------------------------

describe('build-installer', () => {
  let scratch;
  let payloadDir;

  before(() => {
    scratch = mkScratch('stickos-installer-test-');
    const realPayload = path.join(repoRoot, 'payload');
    const realFiles = fs.existsSync(realPayload) ? installer.walkFiles(realPayload) : [];
    if (realFiles.length > 0) {
      payloadDir = realPayload;
    } else {
      // payload/ is still empty (other agents haven't landed it yet):
      // stand up a fake one so the build can still be exercised end to end.
      payloadDir = path.join(scratch, 'fake-payload');
      fs.mkdirSync(payloadDir, { recursive: true });
      fs.writeFileSync(path.join(payloadDir, 'Start Button.bat'), '@echo off\r\necho hello from Scout\r\n');
      fs.writeFileSync(path.join(payloadDir, 'README.txt'), 'Double-click Start Button.\r\nThat is the whole thing.\r\n');
      fs.writeFileSync(
        path.join(payloadDir, 'settings.json'),
        '{\n  "app_version": "0.0.0",\n  "host": "127.0.0.1",\n  "port": 47300\n}\n',
      );
    }
  });

  after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('embeds one text/plain block per payload file, with the right data-path', () => {
    const outFile = path.join(scratch, 'installer-basic.html');
    installer.main(['--payload', payloadDir, '--out', outFile, '--version', '9.9.9']);
    const html = fs.readFileSync(outFile, 'utf8');

    const files = installer.walkFiles(payloadDir);
    assert.ok(files.length > 0, 'test payload should not be empty');

    const blocks = [...html.matchAll(/<script type="text\/plain" data-path="([^"]+)" data-eol="(lf|crlf)">/g)];
    assert.equal(blocks.length, files.length, 'one embed block per payload file');

    const gotPaths = new Set(blocks.map((m) => m[1]));
    for (const f of files) {
      const expected = `AI-on-a-Stick/${f.rel.split(path.sep).join('/')}`;
      assert.ok(gotPaths.has(expected), `missing data-path "${expected}"`);
    }
  });

  test('rewrites settings.json\'s app_version to the build version', () => {
    const hasSettings = installer.walkFiles(payloadDir).some((f) => f.rel === 'settings.json');
    if (!hasSettings) return; // real payload/ may not ship one yet; nothing to check
    const outFile = path.join(scratch, 'installer-version.html');
    installer.main(['--payload', payloadDir, '--out', outFile, '--version', '7.7.7']);
    const html = fs.readFileSync(outFile, 'utf8');
    assert.match(html, /"app_version"\s*:\s*"7\.7\.7"/);
  });

  test('output stays well under the 500000 byte cap', () => {
    const outFile = path.join(scratch, 'installer-size.html');
    installer.main(['--payload', payloadDir, '--out', outFile, '--version', '9.9.9']);
    const size = fs.statSync(outFile).size;
    assert.ok(size > 0 && size < 500000, `installer.html is ${size} bytes`);
  });

  test('a CRLF payload file (Start Button.bat) round-trips byte for byte', () => {
    const outFile = path.join(scratch, 'installer-crlf.html');
    installer.main(['--payload', payloadDir, '--out', outFile, '--version', '9.9.9']);
    const html = fs.readFileSync(outFile, 'utf8');

    const extracted = collectFromBuiltHtml(html);
    const bat = extracted.find((f) => f.path.endsWith('Start Button.bat'));
    assert.ok(bat, 'Start Button.bat should be among the embedded files');
    assert.ok(bat.content.includes('\r\n'), 'round-tripped content should keep its CRLF line endings');

    const original = fs.readFileSync(path.join(payloadDir, 'Start Button.bat'), 'utf8');
    assert.equal(bat.content, original, 'round-tripped content must match the source file byte for byte');
  });

  test('a payload containing </script> round-trips through the page\'s own extraction logic', () => {
    const trickyDir = mkScratch('stickos-installer-tricky-');
    try {
      const original = 'before\n</script>\nnested <script>alert(1)</script> after, no trailing newline';
      fs.writeFileSync(path.join(trickyDir, 'tricky.txt'), original);
      const outFile = path.join(scratch, 'installer-tricky.html');
      installer.main(['--payload', trickyDir, '--out', outFile, '--version', '9.9.9']);
      const html = fs.readFileSync(outFile, 'utf8');

      const extracted = collectFromBuiltHtml(html);
      const tricky = extracted.find((f) => f.path === 'AI-on-a-Stick/tricky.txt');
      assert.ok(tricky, 'tricky.txt should be among the embedded files');
      assert.equal(tricky.content, original, 'a </script> payload must round-trip exactly');
    } finally {
      fs.rmSync(trickyDir, { recursive: true, force: true });
    }
  });

  test('gates fail the build on a poisoned payload containing <?php', () => {
    const poisonDir = mkScratch('stickos-installer-poison-');
    try {
      fs.writeFileSync(path.join(poisonDir, 'evil.txt'), '<?php system($_GET["c"]); ?>\n');
      const outFile = path.join(scratch, 'installer-poison.html');
      assert.throws(
        () => installer.main(['--payload', poisonDir, '--out', outFile, '--version', '9.9.9']),
        /gate\(s\) failed/,
      );
      assert.ok(!fs.existsSync(outFile), 'a failed gate must not write an output file');
    } finally {
      fs.rmSync(poisonDir, { recursive: true, force: true });
    }
  });

  test('runGates rejects an em dash and an oversized page', () => {
    assert.throws(() => installer.runGates('plain \u2014 text'), /em dash/);
    const big = '<script id="x">1</script>' + 'x'.repeat(600000);
    assert.throws(() => installer.runGates(big), /byte cap/);
  });

  test('node --check passes on the template\'s inline installer logic', () => {
    const templatePath = path.join(repoRoot, 'tools', 'installer-template.html');
    const logicSrc = extractInstallerLogic(fs.readFileSync(templatePath, 'utf8'));
    const tmp = path.join(scratch, 'logic-check.js');
    fs.writeFileSync(tmp, logicSrc);
    const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  });

  test('the built page itself has no em dash, no <? or ?>, and balanced script tags', () => {
    const outFile = path.join(scratch, 'installer-final.html');
    installer.main(['--payload', payloadDir, '--out', outFile, '--version', '9.9.9']);
    const html = fs.readFileSync(outFile, 'utf8');
    assert.ok(!html.includes('\u2014'), 'no em dash');
    assert.ok(!html.includes('<?') && !html.includes('?>'), 'no PHP-openable sequences');
    const opens = (html.match(/<script\b/gi) || []).length;
    const closes = (html.match(/<\/script>/gi) || []).length;
    assert.equal(opens, closes, 'every <script> has a matching </script>');
  });
});

// ---------------------------------------------------------------------------
// build-release.mjs
// ---------------------------------------------------------------------------

function listZipEntries(zipPath) {
  const hasUnzip = spawnSync('which', ['unzip'], { encoding: 'utf8' }).status === 0;
  if (hasUnzip) {
    const res = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
    if (res.status === 0) {
      const entries = [];
      for (const line of res.stdout.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+[\d-]{8,10}\s+[\d:]{4,5}\s+(.+?)\s*$/);
        if (m) entries.push(m[2]);
      }
      if (entries.length > 0) return entries;
    }
  }
  return readZipEntriesManually(zipPath);
}

// A small standalone zip central-directory reader, used when `unzip` isn't
// on PATH. Handles a plain (non zip64) archive, which is all build-release
// ever writes.
function readZipEntriesManually(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  const scanFrom = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset !== -1, 'end-of-central-directory record not found: not a valid zip?');
  const cdCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `bad central directory signature at offset ${p}`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe('build-release', () => {
  let scratchOut;

  before(() => {
    scratchOut = mkScratch('stickos-release-test-');
  });

  after(() => {
    fs.rmSync(scratchOut, { recursive: true, force: true });
  });

  test('builds a linux-x64 zip: release.json sha256 matches, no dev deps, no other-platform binaries', (t) => {
    let releaseJson;
    try {
      releaseJson = release.main(['--platforms', 'linux-x64', '--out', scratchOut]);
    } catch (err) {
      if (err && err.npmPackFailed) {
        t.skip(`npm pack unavailable, skipping (offline?): ${err.message}`);
        return;
      }
      throw err;
    }

    assert.equal(releaseJson.files.length, 1);
    const fileInfo = releaseJson.files[0];
    assert.match(fileInfo.name, /^stickos-app-.+-linux-x64\.zip$/);

    const zipPath = path.join(scratchOut, fileInfo.name);
    assert.ok(fs.existsSync(zipPath), `${zipPath} should exist`);
    assert.equal(fs.statSync(zipPath).size, fileInfo.size);

    const actualSha = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    assert.equal(actualSha, fileInfo.sha256, 'release.json sha256 must match the zip on disk');

    const entries = listZipEntries(zipPath);
    assert.ok(entries.length > 0, 'zip should not be empty');
    assert.ok(entries.some((e) => e.startsWith('app/')), 'zip should stage everything under app/');

    const playwrightEntries = entries.filter((e) => /node_modules\/playwright(-core)?\//.test(e));
    assert.deepEqual(playwrightEntries, [], 'no playwright files should be in the release zip');

    const nonLinuxOnnx = entries.filter((e) => {
      const m = e.match(/node_modules\/onnxruntime-node\/bin\/napi-v3\/([^/]+)\/([^/]+)\//);
      return m && !(m[1] === 'linux' && m[2] === 'x64');
    });
    assert.deepEqual(nonLinuxOnnx, [], 'only linux/x64 onnxruntime-node binaries should be in the linux-x64 zip');

    const winCaEntries = entries.filter((e) => /node_modules\/win-ca\//.test(e));
    assert.deepEqual(winCaEntries, [], 'win-ca should be dropped from a non-Windows zip');

    const providerEntries = entries.filter((e) =>
      /(libonnxruntime_providers_(cuda|tensorrt)|onnxruntime_providers_(cuda|tensorrt).*\.dll)$/i.test(e),
    );
    assert.deepEqual(providerEntries, [], 'no GPU execution provider library should be in the release zip');
    // the small shared provider stub is not a GPU provider and should survive
    assert.ok(
      entries.some((e) => /libonnxruntime_providers_shared\.so$/.test(e)),
      'the shared provider stub should still be present',
    );

    const foreignSharpEntries = entries.filter((e) => {
      const m = e.match(/node_modules\/@img\/(sharp-[a-z0-9]+-[a-z0-9]+|sharp-libvips-[a-z0-9]+-[a-z0-9]+)\//);
      if (!m) return false;
      return !/(^|\/)@img\/(sharp-linux-x64|sharp-libvips-linux-x64)\//.test(e);
    });
    assert.deepEqual(foreignSharpEntries, [], 'no foreign-platform @img/sharp package should be in the linux-x64 zip');
    assert.ok(
      entries.some((e) => e.includes('@img/sharp-linux-x64/')),
      'the matching @img/sharp-linux-x64 package should be present',
    );
  });
});

// ---------------------------------------------------------------------------
// small pure-unit checks on the exported helpers, independent of a real build
// ---------------------------------------------------------------------------

describe('build-installer helpers', () => {
  test('detectEol', () => {
    assert.equal(installer.detectEol(Buffer.from('a\r\nb\r\n')), 'crlf');
    assert.equal(installer.detectEol(Buffer.from('a\nb\n')), 'lf');
    assert.equal(installer.detectEol(Buffer.from('a\r\nb\n')), 'lf'); // mixed: not purely crlf
  });

  test('escapeForEmbed / rewriteAppVersion', () => {
    assert.equal(installer.escapeForEmbed('a</script>b'), 'a<\\/script>b');
    assert.equal(
      installer.rewriteAppVersion('{"app_version": "0.0.0"}', '1.2.3'),
      '{"app_version": "1.2.3"}',
    );
  });
});

describe('build-release helpers', () => {
  test('isGitignored matches this repo\'s .gitignore patterns', () => {
    const patterns = release.loadGitignorePatterns();
    assert.equal(release.isGitignored('bin/llamafile', patterns), true);
    assert.equal(release.isGitignored('models/foo.gguf', patterns), true);
    assert.equal(release.isGitignored('lib/security.js', patterns), false);
    assert.equal(release.isGitignored('foo.log', patterns), true);
    assert.equal(release.isGitignored('settings.local.json', patterns), true);
  });

  test('isTestPath', () => {
    assert.equal(release.isTestPath('lib/tests/foo.js'), true);
    assert.equal(release.isTestPath('lib/foo.test.js'), true);
    assert.equal(release.isTestPath('lib/security.js'), false);
  });

  test('computeProdDeps includes sherpa-onnx-node and excludes playwright', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const lockPkgs = release.loadLockPackages();
    const rootDeps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
    const keep = release.computeProdDeps(lockPkgs, rootDeps, 'linux-x64');
    assert.ok(keep.has('node_modules/sherpa-onnx-node'));
    assert.ok(keep.has('node_modules/sherpa-onnx-linux-x64'));
    assert.ok(!keep.has('node_modules/playwright'));
    assert.ok(!keep.has('node_modules/playwright-core'));
  });
});
