// Static checks for app/web that do not need a browser: every file the page
// needs exists, nothing uses an em dash (see CLAUDE.md's writing rules),
// index.html carries the token placeholder and the lamp/mic mount points,
// every windows/*.js module parses on its own, and nothing reaches out to
// an external URL beyond the three Google pages Scout is actually allowed
// to send someone to (see windows/links.js and windows/connect.js).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const webDir = join(repoRoot, 'app', 'web');
const windowsDir = join(webDir, 'windows');

const REQUIRED_FILES = [
  'index.html',
  'style.css',
  'app.js',
  'api.js',
  'windows/boot.js',
  'windows/profiles.js',
  'windows/chat.js',
  'windows/today.js',
  'windows/connect.js',
  'windows/mail.js',
  'windows/calendar.js',
  'windows/netlog.js',
  'windows/settings.js',
  'windows/links.js',
  'windows/monitor.js',
];

const EM_DASH = '\u2014';

// The only network destinations Scout ever sends a person to (see
// windows/links.js's own header comment for why the list is this short).
const ALLOWED_EXACT_URLS = new Set([
  'https://myaccount.google.com/security',
  'https://myaccount.google.com/apppasswords',
]);
const ALLOWED_PREFIXES = ['https://calendar.google.com'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function isAllowedUrl(url) {
  if (ALLOWED_EXACT_URLS.has(url)) return true;
  return ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

describe('app/web static checks', () => {
  test('every file the page needs exists', () => {
    for (const rel of REQUIRED_FILES) {
      assert.equal(existsSync(join(webDir, rel)), true, `${rel} should exist`);
    }
  });

  test('no file under app/web contains an em dash', () => {
    for (const file of walk(webDir)) {
      const text = readFileSync(file, 'utf8');
      assert.equal(text.includes(EM_DASH), false, `${relative(repoRoot, file)} should not contain an em dash`);
    }
  });

  test('index.html carries the token placeholder, the lamp canvas, and the mic button', () => {
    const html = readFileSync(join(webDir, 'index.html'), 'utf8');
    assert.ok(html.includes('__STICKOS_TOKEN__'), 'index.html should carry the __STICKOS_TOKEN__ placeholder');
    assert.ok(html.includes('id="lamp"'), 'index.html should have the lamp canvas mount point');
    assert.ok(html.includes('id="mic"'), 'index.html should have the mic button');
  });

  test('app.js and api.js parse as ES modules', () => {
    for (const name of ['app.js', 'api.js']) {
      execFileSync(process.execPath, ['--check', join(webDir, name)]);
    }
  });

  test('every windows/*.js file parses as an ES module', () => {
    const names = readdirSync(windowsDir).filter((n) => n.endsWith('.js'));
    assert.ok(names.length >= REQUIRED_FILES.filter((f) => f.startsWith('windows/')).length);
    for (const name of names) {
      execFileSync(process.execPath, ['--check', join(windowsDir, name)]);
    }
  });

  test('no file references an external URL beyond the allowed Google pages', () => {
    const urlPattern = /https?:\/\/[^\s"'<>)]+/g;
    for (const file of walk(webDir)) {
      const text = readFileSync(file, 'utf8');
      const matches = text.match(urlPattern) || [];
      for (const raw of matches) {
        const url = raw.replace(/[.,;]+$/, '');
        assert.ok(isAllowedUrl(url), `${relative(repoRoot, file)} references a disallowed external URL: ${url}`);
      }
    }
  });
});
