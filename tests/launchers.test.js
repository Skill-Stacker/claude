// Static checks for the payload launchers. Nothing here runs a .bat, a
// .command, or a .sh: there is no Windows or Mac in this environment, so
// these are text-level checks for the traps CLAUDE.md calls out (see
// "Launcher traps") plus the payload/README/settings contract from the
// build. Run with: node --test tests/launchers.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const payloadDir = path.join(repoRoot, 'payload');

function payloadPath(name) {
  return path.join(payloadDir, name);
}

function readRaw(filePath) {
  // Read as a binary-safe latin1 string so \r and \n are each exactly one
  // character apiece and nothing gets recoded; every payload file here is
  // plain ASCII, so this is lossless.
  return readFileSync(filePath, 'latin1');
}

function hasBareLF(text) {
  // A "bare" LF is a \n that is not immediately preceded by \r. This is
  // (?<!\r)\n as a hand-rolled scan, so it works the same on old and new
  // Node without relying on lookbehind support.
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n' && text[i - 1] !== '\r') return true;
  }
  return false;
}

function isCRLF(text) {
  return text.includes('\r\n') && !hasBareLF(text);
}

function isLFOnly(text) {
  return text.includes('\n') && !text.includes('\r');
}

// ---------------------------------------------------------------------------
// Heuristic: never `set` a variable and read it with %VAR% inside the same
// ( ... ) parenthesised block (CLAUDE.md, "Launcher traps"). cmd.exe expands
// every % reference in a parenthesised block ONCE, before any line in the
// block runs, so a `set "X=..."` earlier in the same block is invisible to a
// `%X%` later in it (or before it - expansion order does not follow source
// order at all). This is a heuristic, not a real cmd.exe parser: it finds
// every balanced ( ... ) span in the file (a naive stack scan, so it will
// also pick up parentheses that just happen to sit inside a REM comment or a
// quoted string; that only makes the scan over-inclusive, never blind to a
// real violation), then for each span looks for a `set "NAME=` assignment
// together with a bare %NAME% reference (not %%NAME%%, which is the
// double-percent form used to write a literal % into a generated helper
// file) anywhere else in the same span.
function findParenSpans(text) {
  const spans = [];
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      stack.push(i);
    } else if (ch === ')') {
      const start = stack.pop();
      if (start !== undefined) spans.push(text.slice(start + 1, i));
    }
  }
  return spans;
}

function findSetThenReadViolations(batText) {
  const spans = findParenSpans(batText);
  const violations = [];
  const setRe = /set\s+"([A-Za-z_][A-Za-z0-9_]*)=/g;
  for (const span of spans) {
    let m;
    setRe.lastIndex = 0;
    const names = new Set();
    while ((m = setRe.exec(span)) !== null) names.add(m[1]);
    for (const name of names) {
      // Every line that assigns this name, so those lines are excluded
      // below (assigning "X=%X%something" on ITS OWN line is a different,
      // legitimate pattern - self-expansion from the value the variable
      // held coming into the block - not the set-then-read-later trap).
      const assignLineRe = new RegExp(`^.*set\\s+"${name}=.*$`, 'gm');
      const withoutAssignLines = span.replace(assignLineRe, '');
      const readRe = new RegExp(`(?<!%)%${name}%(?!%)`);
      if (readRe.test(withoutAssignLines)) {
        violations.push(name);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------

describe('payload/Start Button.bat', () => {
  const filePath = payloadPath('Start Button.bat');
  const text = readRaw(filePath);

  test('is CRLF with no bare LF', () => {
    assert.ok(isCRLF(text), 'expected every line ending to be \\r\\n');
  });

  test('never sets and reads back a variable in the same parenthesised block', () => {
    const violations = findSetThenReadViolations(text);
    assert.deepEqual(violations, [], `set-then-read in the same ( ) block: ${violations.join(', ')}`);
  });

  test('contains no \\" sequences (not an escape in cmd.exe)', () => {
    assert.ok(!text.includes('\\"'), 'found a backslash-quote sequence; a trailing backslash before a closing quote escapes the quote instead of ending the path');
  });

  test('never calls start with a second quoted argument', () => {
    assert.ok(!text.includes('start "" "'), 'found start "" "..." - with a second quoted argument this launches nothing and still exits 0; write a helper .cmd to tmp\\ and start that instead');
  });

  test('timeout.exe is always called with the System32 path', () => {
    const lines = text.split(/\r\n/);
    const offenders = lines.filter((line) => /timeout\.exe/i.test(line) && !line.includes('%SystemRoot%\\System32\\timeout.exe'));
    assert.deepEqual(offenders, [], `timeout.exe called without the explicit System32 path: ${JSON.stringify(offenders)}`);
  });

  test('extracts with tar -xf', () => {
    assert.ok(text.includes('tar -xf'), 'expected tar -xf to be used for extraction (bsdtar ships with Windows 10 1803+)');
  });

  test('ROOT is trimmed without comparing against a lone backslash', () => {
    // %~dp0 always ends in a backslash, so the trim can be unconditional;
    // doing it that way also sidesteps ever writing \" in the source (see
    // the \" test above).
    assert.ok(text.includes('set "ROOT=%~dp0"'), 'expected ROOT to be captured from %~dp0');
  });
});

describe('payload/Start Button.command (macOS)', () => {
  const filePath = payloadPath('Start Button.command');
  const text = readRaw(filePath);

  test('is LF only', () => {
    assert.ok(isLFOnly(text), 'expected every line ending to be a bare \\n with no \\r anywhere');
  });

  test('starts with the bash shebang', () => {
    assert.ok(text.startsWith('#!/bin/bash\n'), 'expected the file to start with #!/bin/bash');
  });

  test('sets strict mode (set -euo pipefail or equivalent)', () => {
    const strict = /set\s+-e[a-zA-Z]*u[a-zA-Z]*\b.*pipefail/.test(text) || (/set\s+-[a-zA-Z]*e[a-zA-Z]*/.test(text) && /set\s+-[a-zA-Z]*u[a-zA-Z]*/.test(text) && text.includes('pipefail'));
    assert.ok(strict, 'expected set -euo pipefail or an equivalent combination of -e, -u and pipefail');
  });

  test('references STICKOS_HOME', () => {
    assert.ok(text.includes('STICKOS_HOME'), 'expected the app server to be started with STICKOS_HOME set');
  });

  test('references the Application Support exec cache', () => {
    assert.ok(text.includes('Application Support'), 'expected copied executables to land under ~/Library/Application Support (nothing executes off an exFAT stick on macOS)');
  });

  test('strips the quarantine attribute with xattr', () => {
    assert.ok(text.includes('xattr'), 'expected xattr -d com.apple.quarantine on every executable copied off the stick');
  });
});

describe('payload/Start Button.sh (Linux)', () => {
  const filePath = payloadPath('Start Button.sh');
  const text = readRaw(filePath);

  test('is LF only', () => {
    assert.ok(isLFOnly(text), 'expected every line ending to be a bare \\n with no \\r anywhere');
  });

  test('starts with the bash shebang', () => {
    assert.ok(text.startsWith('#!/bin/bash\n'), 'expected the file to start with #!/bin/bash');
  });

  test('sets strict mode (set -euo pipefail or equivalent)', () => {
    const strict = /set\s+-e[a-zA-Z]*u[a-zA-Z]*\b.*pipefail/.test(text) || (/set\s+-[a-zA-Z]*e[a-zA-Z]*/.test(text) && /set\s+-[a-zA-Z]*u[a-zA-Z]*/.test(text) && text.includes('pipefail'));
    assert.ok(strict, 'expected set -euo pipefail or an equivalent combination of -e, -u and pipefail');
  });

  test('references STICKOS_HOME', () => {
    assert.ok(text.includes('STICKOS_HOME'), 'expected the app server to be started with STICKOS_HOME set');
  });
});

describe('payload/README.txt', () => {
  const filePath = payloadPath('README.txt');
  const text = readRaw(filePath);

  test('is CRLF with no bare LF', () => {
    assert.ok(isCRLF(text), 'expected every line ending to be \\r\\n');
  });

  for (const phrase of ['Start Button', 'App Password', 'Gatekeeper', 'SmartScreen']) {
    test(`mentions "${phrase}"`, () => {
      assert.ok(text.includes(phrase), `expected README.txt to mention "${phrase}"`);
    });
  }
});

describe('payload/settings.json', () => {
  const filePath = payloadPath('settings.json');
  const text = readRaw(filePath);

  test('parses as JSON', () => {
    assert.doesNotThrow(() => JSON.parse(text));
  });

  test('has the required keys', () => {
    const data = JSON.parse(text);
    for (const key of ['app_version', 'preferred_port', 'model', 'voice', 'stt', 'gpu', 'speed_boost']) {
      assert.ok(Object.prototype.hasOwnProperty.call(data, key), `missing key "${key}"`);
    }
  });
});

describe('payload/ (all files)', () => {
  const files = readdirSync(payloadDir).filter((name) => statSync(path.join(payloadDir, name)).isFile());

  for (const name of files) {
    test(`${name} contains no <?, ?>, or em dash`, () => {
      const text = readRaw(payloadPath(name));
      assert.ok(!text.includes('<?'), `found "<?" in ${name} (the installer page is served as PHP and will execute it)`);
      assert.ok(!text.includes('?>'), `found "?>" in ${name} (the installer page is served as PHP and will execute it)`);
      assert.ok(!text.includes('—'), `found an em dash (U+2014) in ${name}`);
    });
  }
});
