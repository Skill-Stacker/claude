// Resolves every runtime path StickOS uses, and creates the runtime-only
// directories on demand. Nothing under these paths is committed to git
// (see .gitignore): bin/, models/, voices/, data/, sessions/, state/, chats/.
//
// Usage:
//   import { resolvePaths, ensureDirs } from './paths.js';
//   const paths = resolvePaths();
//   ensureDirs(paths);

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');

// The default base is the parent of the app/ folder, so a checkout laid out
// as <stick>/app keeps everything runtime-only under <stick>/.
const defaultBase = resolve(appDir, '..');

export function resolvePaths(baseDir) {
  const base = resolve(baseDir || process.env.STICKOS_HOME || defaultBase);
  const data = join(base, 'data');
  return {
    base,
    app: appDir,
    web: join(appDir, 'web'),
    bin: join(base, 'bin'),
    models: join(base, 'models'),
    voices: join(base, 'voices'),
    data,
    profiles: join(data, 'profiles'),
    sessions: join(base, 'sessions'),
    state: join(base, 'state'),
    chats: join(base, 'chats'),
    tmp: join(base, 'tmp'),
  };
}

// Directories that actually need to exist on disk. `app` and `web` ship in
// the repo/release zip and are never created here.
const RUNTIME_KEYS = ['bin', 'models', 'voices', 'data', 'profiles', 'sessions', 'state', 'chats', 'tmp'];

export function ensureDirs(paths) {
  for (const key of RUNTIME_KEYS) {
    mkdirSync(paths[key], { recursive: true });
  }
  return paths;
}
