import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startSession, appendExchange, loadMemory, distill, buildSystemPrompt,
  PERSONA_PATH, loadPersona,
} from '../app/lib/memory.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'stickos-memory-'));
}

test('appendExchange creates the session file and writes immediately', () => {
  const dir = tmpDir();
  startSession(dir, { ts: new Date('2026-09-02T10:15:00Z') });
  const path = appendExchange(dir, {
    user: 'Hi Scout',
    assistant: 'Hello there',
    ts: new Date('2026-09-02T10:15:00Z'),
  });

  assert.ok(existsSync(path));
  const files = readdirSync(join(dir, 'sessions'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}-\d{4}\.md$/);

  const content = readFileSync(path, 'utf8');
  assert.match(content, /Hi Scout/);
  assert.match(content, /Hello there/);

  rmSync(dir, { recursive: true, force: true });
});

test('appendExchange without an explicit startSession still creates a session file', () => {
  const dir = tmpDir();
  appendExchange(dir, { user: 'first', assistant: 'reply' });
  const files = readdirSync(join(dir, 'sessions'));
  assert.equal(files.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('distill skips the summarizer when the session has fewer than two exchanges', async () => {
  const dir = tmpDir();
  startSession(dir, { ts: new Date() });
  appendExchange(dir, { user: 'Hi', assistant: 'Hello', ts: new Date() });

  let called = false;
  const summarize = async () => { called = true; return '- should not appear'; };

  const before = loadMemory(dir);
  const result = await distill(dir, summarize);

  assert.equal(called, false);
  assert.equal(result.distilled, false);
  assert.equal(loadMemory(dir), before);

  rmSync(dir, { recursive: true, force: true });
});

test('distill appends summarizer bullets under a dated heading, and trims memory to 9000 chars dropping oldest lines first', async () => {
  const dir = tmpDir();
  startSession(dir, { ts: new Date() });
  appendExchange(dir, { user: 'My dog is named Rex', assistant: 'Got it.', ts: new Date() });
  appendExchange(dir, { user: 'I like tea', assistant: 'Noted.', ts: new Date() });

  // Seed memory.md well past the cap with clearly ordered, distinguishable lines.
  const filler = Array.from({ length: 400 }, (_, i) => `old filler line number ${i}`).join('\n') + '\n';
  writeFileSync(join(dir, 'memory.md'), filler);
  assert.ok(filler.length > 9000);

  let seenTranscript = null;
  const summarize = async (transcript) => {
    seenTranscript = transcript;
    return '- likes tea\n- has a dog named Rex';
  };

  const result = await distill(dir, summarize);
  assert.equal(result.distilled, true);
  assert.match(seenTranscript, /Rex/);
  assert.match(seenTranscript, /I like tea/);

  const memory = loadMemory(dir);
  assert.ok(memory.length <= 9000, `expected <= 9000 chars, got ${memory.length}`);
  assert.match(memory, /likes tea/);
  assert.match(memory, /has a dog named Rex/);

  // oldest lines were dropped first: the earliest filler lines are gone,
  // the newest filler lines (right before the cut) and the new bullets remain.
  assert.ok(!memory.includes('old filler line number 0\n'));
  assert.match(memory, /old filler line number 399/);

  // no line was cut in half: every remaining line still starts cleanly.
  for (const line of memory.split('\n')) {
    if (line.startsWith('old filler line number')) {
      assert.match(line, /^old filler line number \d+$/);
    }
  }

  // distill rotates to a new session, so the next exchange goes to a fresh file.
  const filesAfter = readdirSync(join(dir, 'sessions'));
  appendExchange(dir, { user: 'next', assistant: 'reply', ts: new Date() });
  assert.ok(readdirSync(join(dir, 'sessions')).length >= filesAfter.length);

  rmSync(dir, { recursive: true, force: true });
});

test('buildSystemPrompt is byte-identical across calls with the same inputs', () => {
  const persona = "You are Scout, {{name}}'s assistant. Call them {{name}}.";
  const a = buildSystemPrompt({ persona, memory: '- likes tea\n- has a dog named Rex', name: 'Alex' });
  const b = buildSystemPrompt({ persona, memory: '- likes tea\n- has a dog named Rex', name: 'Alex' });
  assert.equal(a, b);
  assert.equal(Buffer.from(a).equals(Buffer.from(b)), true);
  assert.match(a, /Alex/);
  assert.match(a, /Notes from past sessions, oldest first:/);

  const noMemory = buildSystemPrompt({ persona, memory: '', name: 'Alex' });
  assert.equal(noMemory.includes('Notes from past sessions'), false);
  assert.equal(noMemory, persona.replaceAll('{{name}}', 'Alex'));
});

test('persona loads, fills in the name, and contains no em dash', () => {
  assert.ok(existsSync(PERSONA_PATH));
  const persona = loadPersona();
  assert.ok(persona.includes('{{name}}'));
  assert.equal(persona.includes('\u2014'), false);

  const filled = buildSystemPrompt({ persona, memory: '', name: 'Riley' });
  assert.match(filled, /Riley/);
  assert.equal(filled.includes('{{name}}'), false);
});
