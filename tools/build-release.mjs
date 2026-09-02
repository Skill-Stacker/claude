#!/usr/bin/env node
// Builds the per-platform app zips the launchers download from GitHub
// Releases. For each requested platform this stages app/ (minus tests
// and anything .gitignore'd) plus a pruned, production-only
// app/node_modules/, trims native binaries down to the target platform,
// zips it, and writes dist/release.json with a sha256 per file.
//
// Usage:
//   node tools/build-release.mjs [--platforms win-x64,darwin-arm64,linux-x64] [--out dist]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const LARGE_FILE_LIMIT = 512 * 1024 * 1024; // fake-capacity USB corruption threshold

// platform id -> onnxruntime-node's napi-v3/<os>/<arch> pair, and the
// sherpa-onnx-node native companion package name for that platform.
export const PLATFORM_DEFS = {
  'win-x64': { onnxOs: 'win32', onnxArch: 'x64', sherpaPkg: 'sherpa-onnx-win-x64' },
  'darwin-arm64': { onnxOs: 'darwin', onnxArch: 'arm64', sherpaPkg: 'sherpa-onnx-darwin-arm64' },
  'linux-x64': { onnxOs: 'linux', onnxArch: 'x64', sherpaPkg: 'sherpa-onnx-linux-x64' },
};

// Packages that must never end up in a release zip, however they were
// reached: devDependencies such as playwright, always excluded outright.
const ALWAYS_EXCLUDE = new Set([
  'node_modules/playwright',
  'node_modules/playwright-core',
  'node_modules/fsevents',
]);

export function parseArgs(argv) {
  const args = {
    platforms: Object.keys(PLATFORM_DEFS),
    out: path.join(repoRoot, 'dist'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platforms') {
      args.platforms = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--out') {
      args.out = path.resolve(argv[++i]);
    } else {
      throw new Error(`build-release: unknown argument "${a}"`);
    }
  }
  for (const p of args.platforms) {
    if (!PLATFORM_DEFS[p]) {
      throw new Error(`build-release: unknown platform "${p}" (know: ${Object.keys(PLATFORM_DEFS).join(', ')})`);
    }
  }
  return args;
}

// ---- .gitignore-ish matching (simple, matches this repo's flat patterns) ----

export function loadGitignorePatterns() {
  const file = path.join(repoRoot, '.gitignore');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function isGitignored(relPath, patterns) {
  const base = path.posix.basename(relPath);
  const segs = relPath.split('/');
  for (const pat of patterns) {
    if (pat.endsWith('/')) {
      if (segs.includes(pat.slice(0, -1))) return true;
    } else if (pat.startsWith('*.')) {
      if (base.endsWith(pat.slice(1))) return true;
    } else if (base === pat || segs.includes(pat)) {
      return true;
    }
  }
  return false;
}

export function isTestPath(relPath) {
  const segs = relPath.split('/');
  if (segs.some((s) => /^(tests?|__tests__)$/i.test(s))) return true;
  const base = path.posix.basename(relPath);
  return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(base);
}

// ---- copying app/ ----

export function copyAppTree(srcRoot, destRoot, gitignorePatterns) {
  function walk(dir, rel) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (isGitignored(relPath, gitignorePatterns) || isTestPath(relPath)) continue;
      const srcFull = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(srcFull, relPath);
      } else if (e.isSymbolicLink()) {
        const real = fs.readlinkSync(srcFull);
        const destFull = path.join(destRoot, relPath);
        fs.mkdirSync(path.dirname(destFull), { recursive: true });
        fs.symlinkSync(real, destFull);
      } else if (e.isFile()) {
        const destFull = path.join(destRoot, relPath);
        fs.mkdirSync(path.dirname(destFull), { recursive: true });
        fs.copyFileSync(srcFull, destFull);
      }
    }
  }
  walk(srcRoot, '');
}

// ---- resolving production dependencies from package-lock.json ----

export function loadLockPackages() {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  return lock.packages || {};
}

// Node-resolution-style candidate keys for `depName` required from the
// package at lockfile key `fromKey` ("" for the project root): nested
// node_modules first, walking up, then the top-level node_modules.
export function resolveCandidates(fromKey, depName) {
  const keys = [];
  let prefix = fromKey;
  while (prefix && prefix.includes('node_modules/')) {
    keys.push(`${prefix}/node_modules/${depName}`);
    const idx = prefix.lastIndexOf('node_modules/');
    prefix = prefix.slice(0, idx).replace(/\/$/, '');
  }
  keys.push(`node_modules/${depName}`);
  return keys;
}

// BFS over package-lock.json's dependency graph starting from
// package.json's dependencies + optionalDependencies, keeping only
// packages that are actually present on disk (npm already skipped
// installing optional deps for other platforms) and never the
// always-excluded devDependency tree. win-ca is dropped for
// non-Windows targets even though it is present on disk here.
export function computeProdDeps(pkgs, rootDeps, platform) {
  const keep = new Map();
  const queue = Object.keys(rootDeps).map((name) => ({ name, fromKey: '' }));

  while (queue.length) {
    const { name, fromKey } = queue.shift();
    if (name === 'win-ca' && platform !== 'win-x64') continue;

    let foundKey = null;
    for (const cand of resolveCandidates(fromKey, name)) {
      if (ALWAYS_EXCLUDE.has(cand)) continue;
      if (fs.existsSync(path.join(repoRoot, cand))) {
        foundKey = cand;
        break;
      }
    }
    if (!foundKey || keep.has(foundKey)) continue;

    const entry = pkgs[foundKey];
    if (!entry) continue;
    keep.set(foundKey, entry);

    const deps = { ...(entry.dependencies || {}), ...(entry.optionalDependencies || {}) };
    for (const depName of Object.keys(deps)) {
      queue.push({ name: depName, fromKey: foundKey });
    }
  }
  return keep;
}

export function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(s), d);
    } else if (e.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function copyDeps(keepMap, stagingAppDir) {
  for (const key of keepMap.keys()) {
    copyDirRecursive(path.join(repoRoot, key), path.join(stagingAppDir, key));
  }
}

// ---- README/docs/test/example pruning, LICENSE always kept ----

function isLicenseName(name) {
  return /^(license|licence|copying|notice)(\..*)?$/i.test(name);
}

function rmIfEmpty(dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function removeExceptLicense(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      removeExceptLicense(full);
      rmIfEmpty(full);
    } else if (!isLicenseName(e.name)) {
      fs.rmSync(full, { force: true });
    }
  }
}

export function prunePackageExtras(pkgDir) {
  if (!fs.existsSync(pkgDir)) return;
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/^(docs?|tests?|__tests__|examples?)$/i.test(e.name)) {
          removeExceptLicense(full);
          rmIfEmpty(full);
        } else {
          walk(full);
        }
      } else if (/^readme(\..*)?$/i.test(e.name) && !isLicenseName(e.name)) {
        fs.rmSync(full, { force: true });
      }
    }
  }
  walk(pkgDir);
}

// ---- platform-native pruning ----

export function pruneOnnxRuntimeNode(stagingAppDir, platform) {
  const def = PLATFORM_DEFS[platform];
  const napiDir = path.join(stagingAppDir, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
  if (!fs.existsSync(napiDir)) return;
  for (const osDir of fs.readdirSync(napiDir)) {
    const osPath = path.join(napiDir, osDir);
    if (!fs.statSync(osPath).isDirectory()) continue;
    if (osDir !== def.onnxOs) {
      fs.rmSync(osPath, { recursive: true, force: true });
      continue;
    }
    for (const archDir of fs.readdirSync(osPath)) {
      if (archDir !== def.onnxArch) {
        fs.rmSync(path.join(osPath, archDir), { recursive: true, force: true });
      }
    }
  }
}

// Keep only the sherpa-onnx-<platform> native companion package that
// matches the target. Fetch it with `npm pack` when it is not already
// on disk (only the local dev platform's copy installs by default),
// verifying its version matches sherpa-onnx-node's in package-lock.json.
export function pruneSherpaOnnx(stagingAppDir, platform, lockPkgs) {
  const nodeModulesDir = path.join(stagingAppDir, 'node_modules');
  const wantPkg = PLATFORM_DEFS[platform].sherpaPkg;
  if (!fs.existsSync(nodeModulesDir)) return;

  for (const entry of fs.readdirSync(nodeModulesDir)) {
    if (/^sherpa-onnx-(win|darwin|linux)-/.test(entry) && entry !== wantPkg) {
      fs.rmSync(path.join(nodeModulesDir, entry), { recursive: true, force: true });
    }
  }

  const wantPath = path.join(nodeModulesDir, wantPkg);
  if (fs.existsSync(wantPath)) return; // already staged (local platform match)

  const sherpaNodeVersion = lockPkgs['node_modules/sherpa-onnx-node']?.version;
  if (!sherpaNodeVersion) {
    throw new Error('cannot determine sherpa-onnx-node version from package-lock.json');
  }

  console.log(`  fetching ${wantPkg}@${sherpaNodeVersion} (npm pack) ...`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickos-sherpa-'));
  try {
    const packRes = spawnSync('npm', ['pack', `${wantPkg}@${sherpaNodeVersion}`, '--pack-destination', tmpDir], {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    if (packRes.status !== 0 || packRes.error) {
      const detail = (packRes.stderr || packRes.error?.message || packRes.stdout || '').trim();
      const err = new Error(`npm pack failed for ${wantPkg}@${sherpaNodeVersion}: ${detail}`);
      err.npmPackFailed = true;
      throw err;
    }
    const tgzName = packRes.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .pop()
      .trim();
    const tgzPath = path.join(tmpDir, tgzName);
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickos-sherpa-extract-'));
    const tarRes = spawnSync('tar', ['-xzf', tgzPath, '-C', extractDir], { encoding: 'utf8' });
    if (tarRes.status !== 0) {
      throw new Error(`failed to extract ${tgzName}: ${(tarRes.stderr || '').trim()}`);
    }
    const pkgDir = path.join(extractDir, 'package');
    const fetchedPkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    if (fetchedPkgJson.version !== sherpaNodeVersion) {
      throw new Error(
        `fetched ${wantPkg}@${fetchedPkgJson.version} but sherpa-onnx-node needs ${sherpaNodeVersion}`,
      );
    }
    copyDirRecursive(pkgDir, wantPath);
    fs.rmSync(extractDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function checkLargeFiles(stagingAppDir, platform) {
  const big = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        walk(full);
      } else {
        const st = fs.statSync(full);
        if (st.size > LARGE_FILE_LIMIT) big.push({ path: full, size: st.size });
      }
    }
  }
  walk(stagingAppDir);
  for (const b of big) {
    console.warn(
      `  WARNING [${platform}]: ${path.relative(stagingAppDir, b.path)} is ${(b.size / 1048576).toFixed(1)} MB, over the 512 MB fake-capacity USB threshold`,
    );
  }
  return big;
}

// ---- zipping ----

function commandExists(cmd) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return res.status === 0;
}

export function crc32(buf) {
  if (!crc32.table) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    crc32.table = t;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal store-method (uncompressed) zip writer, used only when
// neither the `zip` nor `tar` CLI is available.
export function writeZipPureNode(stagingRoot, outFile, topDir) {
  const files = [];
  function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, relPath);
      else files.push({ full, rel: relPath });
    }
  }
  walk(path.join(stagingRoot, topDir), topDir);

  const u16 = (v) => Buffer.from([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v) => Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);

  const fd = fs.openSync(outFile, 'w');
  let offset = 0;
  const central = [];
  try {
    for (const f of files) {
      const data = fs.readFileSync(f.full);
      const crc = crc32(data);
      const nameBuf = Buffer.from(f.rel, 'utf8');
      const lh = Buffer.concat([
        u32(0x04034b50),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0x21),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBuf.length),
        u16(0),
      ]);
      fs.writeSync(fd, lh);
      fs.writeSync(fd, nameBuf);
      fs.writeSync(fd, data);
      const localOffset = offset;
      offset += lh.length + nameBuf.length + data.length;
      const cd = Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0x21),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(localOffset),
      ]);
      central.push({ cd, nameBuf });
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) {
      fs.writeSync(fd, c.cd);
      fs.writeSync(fd, c.nameBuf);
      cdSize += c.cd.length + c.nameBuf.length;
    }
    const eocd = Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(central.length),
      u16(central.length),
      u32(cdSize),
      u32(cdStart),
      u16(0),
    ]);
    fs.writeSync(fd, eocd);
  } finally {
    fs.closeSync(fd);
  }
}

export function zipDir(stagingRoot, outFile, topDir) {
  fs.rmSync(outFile, { force: true });
  if (commandExists('zip')) {
    const res = spawnSync('zip', ['-rq', outFile, topDir], { cwd: stagingRoot });
    if (res.status === 0 && fs.existsSync(outFile)) return 'zip';
  }
  if (commandExists('tar')) {
    const res = spawnSync('tar', ['-a', '-cf', outFile, topDir], { cwd: stagingRoot });
    if (res.status === 0 && fs.existsSync(outFile)) return 'tar';
  }
  writeZipPureNode(stagingRoot, outFile, topDir);
  return 'pure-node';
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

// ---- main ----

export function buildPlatform(platform, { pkg, lockPkgs, gitignorePatterns, outDir }) {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `stickos-release-${platform}-`));
  try {
    const stagingApp = path.join(stagingRoot, 'app');
    copyAppTree(path.join(repoRoot, 'app'), stagingApp, gitignorePatterns);

    const rootProdDeps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
    const keepMap = computeProdDeps(lockPkgs, rootProdDeps, platform);
    copyDeps(keepMap, stagingApp);

    if (platform !== 'win-x64') {
      fs.rmSync(path.join(stagingApp, 'node_modules', 'win-ca'), { recursive: true, force: true });
    }
    pruneOnnxRuntimeNode(stagingApp, platform);
    pruneSherpaOnnx(stagingApp, platform, lockPkgs);

    const nodeModulesDir = path.join(stagingApp, 'node_modules');
    if (fs.existsSync(nodeModulesDir)) {
      for (const entry of fs.readdirSync(nodeModulesDir)) {
        prunePackageExtras(path.join(nodeModulesDir, entry));
      }
    }

    checkLargeFiles(stagingApp, platform);

    const outFile = path.join(outDir, `stickos-app-${pkg.version}-${platform}.zip`);
    const method = zipDir(stagingRoot, outFile, 'app');
    const size = fs.statSync(outFile).size;
    const sha256 = sha256File(outFile);
    console.log(`  ${path.basename(outFile)}  ${(size / 1048576).toFixed(1)} MB  (zipped with ${method})`);
    return { name: path.basename(outFile), size, sha256, platform };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function main(argv) {
  const args = parseArgs(argv);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const lockPkgs = loadLockPackages();
  const gitignorePatterns = loadGitignorePatterns();

  fs.mkdirSync(args.out, { recursive: true });

  const results = [];
  for (const platform of args.platforms) {
    console.log(`\n== ${platform} ==`);
    results.push(buildPlatform(platform, { pkg, lockPkgs, gitignorePatterns, outDir: args.out }));
  }

  const releaseJson = {
    version: pkg.version,
    files: results.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
  };
  fs.writeFileSync(path.join(args.out, 'release.json'), JSON.stringify(releaseJson, null, 2) + '\n');

  console.log('\nplatform        file                                                 size        sha256');
  for (const r of results) {
    console.log(
      `${r.platform.padEnd(16)}${r.name.padEnd(53)}${(r.size / 1048576).toFixed(1).padStart(8)} MB  ${r.sha256.slice(0, 16)}...`,
    );
  }
  return releaseJson;
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
