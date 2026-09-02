// Scout's memory: a per-profile transcript kept immediately on disk, and a
// distilled memory.md a local model condenses it into between sessions.
//
// Usage:
//   import { startSession, appendExchange, distill, loadMemory, buildSystemPrompt } from './memory.js';
//   const dir = profileDir(profilesDir, profile); // from profiles.js
//   startSession(dir);
//   appendExchange(dir, { user, assistant });
//   ...
//   await distill(dir, (transcript) => askModelForBullets(transcript));
//   const prompt = buildSystemPrompt({ persona: loadPersona(), memory: loadMemory(dir), name: profile.name });

import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_MEMORY_CHARS = 9000;
const MIN_EXCHANGES_TO_DISTILL = 2;
const EXCHANGE_HEADING_RE = /^## /gm;

export const PERSONA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'persona.md');

export function loadPersona() {
  return readFileSync(PERSONA_PATH, 'utf8');
}

// profileDirPath -> the session file name currently in use for it. One file
// per session, chosen once at startSession and kept for every append and
// distill call until the next startSession.
const activeSessions = new Map();

function pad2(n) {
  return String(n).padStart(2, '0');
}

function sessionFilename(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.md`;
}

export function startSession(profileDirPath, { ts = new Date() } = {}) {
  const filename = sessionFilename(ts);
  activeSessions.set(profileDirPath, filename);
  return filename;
}

function currentSessionFile(profileDirPath) {
  let filename = activeSessions.get(profileDirPath);
  if (!filename) filename = startSession(profileDirPath);
  return filename;
}

function sessionPath(profileDirPath) {
  return join(profileDirPath, 'sessions', currentSessionFile(profileDirPath));
}

// Appends one exchange to the current session file immediately (a plain
// synchronous append), so a crash loses nothing already spoken.
export function appendExchange(profileDirPath, { user, assistant, ts = new Date() } = {}) {
  mkdirSync(join(profileDirPath, 'sessions'), { recursive: true });
  const path = sessionPath(profileDirPath);
  const time = ts instanceof Date ? ts : new Date(ts);
  const block = `\n## ${time.toISOString()}\n\n**User:** ${user}\n\n**Assistant:** ${assistant}\n`;
  appendFileSync(path, block);
  return path;
}

export function loadMemory(profileDirPath) {
  const path = join(profileDirPath, 'memory.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function countExchanges(transcript) {
  const matches = transcript.match(EXCHANGE_HEADING_RE);
  return matches ? matches.length : 0;
}

// Trims to at most maxChars by dropping the oldest lines first. Never cuts a
// line in half; if a single remaining line is itself over the cap it is left
// alone rather than chopped mid-line.
function trimToMaxChars(text, maxChars) {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  while (lines.length > 1 && lines.join('\n').length > maxChars) {
    lines.shift();
  }
  return lines.join('\n');
}

// Reads the current session's transcript, asks the injected summarize(transcript)
// for bullets, appends them under a dated heading to memory.md, trims
// memory.md to the size cap, then rotates to a new session. Skips the
// summarizer entirely (a no-op) when the session is too short to be worth
// condensing.
export async function distill(profileDirPath, summarize) {
  const path = sessionPath(profileDirPath);
  const transcript = existsSync(path) ? readFileSync(path, 'utf8') : '';

  if (countExchanges(transcript) < MIN_EXCHANGES_TO_DISTILL) {
    return { distilled: false };
  }

  const bullets = await summarize(transcript);
  const memoryPath = join(profileDirPath, 'memory.md');
  const existing = loadMemory(profileDirPath).replace(/\s+$/, '');
  const heading = `## ${new Date().toISOString().slice(0, 10)}`;
  const section = `${heading}\n${String(bullets).trim()}`;
  const combined = trimToMaxChars(`${existing ? `${existing}\n\n` : ''}${section}\n`, MAX_MEMORY_CHARS);
  mkdirSync(profileDirPath, { recursive: true });
  writeFileSync(memoryPath, combined);

  startSession(profileDirPath);
  return { distilled: true };
}

// persona text with {{name}} filled in, plus notes from memory when there
// are any. Deterministic and byte-identical for the same inputs: this is
// the prompt-cache prefix, so nothing here may vary between calls.
export function buildSystemPrompt({ persona, memory, name }) {
  const filled = String(persona).replaceAll('{{name}}', name);
  if (!memory || !memory.trim()) return filled;
  return `${filled}\n\nNotes from past sessions, oldest first:\n${memory}`;
}
