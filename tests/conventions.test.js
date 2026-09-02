// Repo-wide convention checks. These exist because the rules in CLAUDE.md
// bite for real: an em dash in spoken copy reads wrong, and a `<?` inside a
// payload file takes the live installer page down (it is served as PHP).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const SCAN_DIRS = ['app', 'payload', 'tools', 'tests'];
const TEXT_EXT = new Set(['.js', '.mjs', '.html', '.css', '.md', '.json', '.txt', '.bat', '.command', '.sh', '.sql', '.ics']);
const EM_DASH = '\u2014';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'out' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (TEXT_EXT.has(extname(name)) || name === 'README.txt') yield full;
  }
}

function sourceFiles() {
  const out = [];
  for (const d of SCAN_DIRS) {
    try {
      out.push(...walk(join(root, d)));
    } catch {
      // a scan dir may not exist yet on a fresh checkout
    }
  }
  return out;
}

test('no em dash character anywhere in source, copy, or tests', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    if (text.includes(EM_DASH)) {
      const line = text.split('\n').findIndex((l) => l.includes(EM_DASH)) + 1;
      offenders.push(`${relative(root, file)}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], `write the character as \\u2014 in code, and never in copy: ${offenders.join(', ')}`);
});

test('payload files never contain PHP open or close tags', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    if (!relative(root, file).startsWith('payload')) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes('<?') || text.includes('?>')) offenders.push(relative(root, file));
  }
  assert.deepEqual(offenders, []);
});

test('the Windows launcher and the stick README are CRLF, everything else in payload is LF', () => {
  for (const file of sourceFiles()) {
    const rel = relative(root, file);
    if (!rel.startsWith('payload')) continue;
    const text = readFileSync(file, 'utf8');
    const crlf = (text.match(/\r\n/g) || []).length;
    const bareLf = (text.match(/(^|[^\r])\n/g) || []).length;
    if (rel.endsWith('.bat') || rel.endsWith('README.txt')) {
      assert.ok(crlf > 0 && bareLf === 0, `${rel} must be CRLF only`);
    } else {
      assert.equal(crlf, 0, `${rel} must be LF only`);
    }
  }
});
