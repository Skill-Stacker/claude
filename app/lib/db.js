// Thin wrapper over node:sqlite. Every module goes through this file so an API
// change in node:sqlite (still marked experimental on Node 22) is a one-file fix.
//
// Usage:
//   import { openDb } from './db.js';
//   const db = openDb('/path/to/stick/data/scout.sqlite');
//   db.run('INSERT INTO events (uid, summary) VALUES (?, ?)', [uid, summary]);
//   const row = db.get('SELECT * FROM events WHERE uid = ?', [uid]);
//   const rows = db.all('SELECT * FROM events WHERE start_utc < ? ORDER BY start_utc', [t]);
//   db.transaction(() => { ... });
//   db.close();
//
// openDb(':memory:') is fine for tests.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(here, 'schema.sql');

export function openDb(path, { schema = true } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (schema) raw.exec(readFileSync(SCHEMA_PATH, 'utf8'));

  const stmts = new Map();
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) { s = raw.prepare(sql); stmts.set(sql, s); }
    return s;
  };

  return {
    raw,
    run(sql, params = []) { return prep(sql).run(...params); },
    get(sql, params = []) { return prep(sql).get(...params); },
    all(sql, params = []) { return prep(sql).all(...params); },
    exec(sql) { return raw.exec(sql); },
    transaction(fn) {
      raw.exec('BEGIN');
      try { const out = fn(); raw.exec('COMMIT'); return out; }
      catch (err) { raw.exec('ROLLBACK'); throw err; }
    },
    // Tiny key/value helper over sync_state, used by every syncing module.
    getState(key, fallback = null) {
      const row = prep('SELECT value FROM sync_state WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : fallback;
    },
    setState(key, value) {
      prep('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, JSON.stringify(value));
    },
    close() { stmts.clear(); raw.close(); },
  };
}
