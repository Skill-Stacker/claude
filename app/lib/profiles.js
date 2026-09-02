// Profile CRUD, PIN lock (scrypt hash plus a doubling lockout), per-profile
// plaintext secrets on disk, and in-memory unlock sessions for the running
// process. See CLAUDE.md and the profiles table in schema.sql.
//
// Usage:
//   import { openDb } from './db.js';
//   import { createProfile, setPin, verifyPin, createLockManager } from './profiles.js';
//   const db = openDb(dbPath);
//   const profile = createProfile(db, { name: 'Alex', kind: 'adult' });
//   setPin(db, profile.id, '4821');
//   const result = verifyPin(db, profile.id, '4821');
//
// Every column this module uses (pin_salt, pin_hash, kdf_n, kdf_r, kdf_p,
// failed_attempts, locked_until_utc, auto_lock_minutes) already ships in
// schema.sql, so this module needs no ALTER TABLE and defines no
// ensureSchema(db).

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const KDF = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;
const PIN_RE = /^\d{4,8}$/;

const LOCKOUT_THRESHOLD = 5;       // consecutive misses before a lock starts
const LOCKOUT_BASE_SECONDS = 60;
const LOCKOUT_CAP_SECONDS = 3600;

// ---- profile CRUD -----------------------------------------------------

export function createProfile(db, { name, kind = 'child' } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('name is required');
  if (kind !== 'adult' && kind !== 'child') throw new Error('kind must be adult or child');
  const created_utc = new Date().toISOString();
  const result = db.run(
    'INSERT INTO profiles (name, kind, created_utc) VALUES (?, ?, ?)',
    [trimmed, kind, created_utc],
  );
  return getProfile(db, Number(result.lastInsertRowid));
}

export function listProfiles(db) {
  return db.all('SELECT * FROM profiles ORDER BY id');
}

export function getProfile(db, id) {
  return db.get('SELECT * FROM profiles WHERE id = ?', [id]) || null;
}

export function renameProfile(db, id, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('name is required');
  db.run('UPDATE profiles SET name = ? WHERE id = ?', [trimmed, id]);
  return getProfile(db, id);
}

export function promoteToAdult(db, id) {
  db.run("UPDATE profiles SET kind = 'adult' WHERE id = ?", [id]);
  return getProfile(db, id);
}

export function demoteToChild(db, id) {
  db.run("UPDATE profiles SET kind = 'child' WHERE id = ?", [id]);
  return getProfile(db, id);
}

// ---- PIN -----------------------------------------------------------------

export function hasPin(profile) {
  return !!(profile && profile.pin_hash && profile.pin_salt);
}

export function setPin(db, id, pin) {
  if (!PIN_RE.test(String(pin))) {
    throw new Error('pin must be 4 to 8 digits');
  }
  const salt = randomBytes(16);
  const hash = scryptSync(String(pin), salt, KEY_LEN, KDF);
  db.run(
    `UPDATE profiles SET pin_salt = ?, pin_hash = ?, kdf_n = ?, kdf_r = ?, kdf_p = ?,
       failed_attempts = 0, locked_until_utc = NULL WHERE id = ?`,
    [salt, hash, KDF.N, KDF.r, KDF.p, id],
  );
  return getProfile(db, id);
}

// Returns { ok: true } on a correct pin, or { ok: false } / { ok: false,
// lockedForSeconds } on a miss. While locked the pin is never checked.
export function verifyPin(db, id, pin, { now = () => Date.now() } = {}) {
  const profile = getProfile(db, id);
  if (!profile) throw new Error('profile not found');
  if (!hasPin(profile)) throw new Error('profile has no pin set');

  const nowMs = typeof now === 'function' ? now() : now;

  if (profile.locked_until_utc) {
    const lockedUntilMs = Date.parse(profile.locked_until_utc);
    if (lockedUntilMs > nowMs) {
      return { ok: false, lockedForSeconds: Math.ceil((lockedUntilMs - nowMs) / 1000) };
    }
  }

  const salt = Buffer.from(profile.pin_salt);
  const stored = Buffer.from(profile.pin_hash);
  const candidate = scryptSync(String(pin), salt, KEY_LEN, {
    N: profile.kdf_n, r: profile.kdf_r, p: profile.kdf_p,
  });
  const match = candidate.length === stored.length && timingSafeEqual(candidate, stored);

  if (match) {
    db.run('UPDATE profiles SET failed_attempts = 0, locked_until_utc = NULL WHERE id = ?', [id]);
    return { ok: true };
  }

  const attempts = profile.failed_attempts + 1;
  let lockedUntilIso = null;
  let lockedForSeconds;
  if (attempts >= LOCKOUT_THRESHOLD) {
    const exp = attempts - LOCKOUT_THRESHOLD; // 0 on the fifth miss
    lockedForSeconds = Math.min(LOCKOUT_BASE_SECONDS * (2 ** exp), LOCKOUT_CAP_SECONDS);
    lockedUntilIso = new Date(nowMs + lockedForSeconds * 1000).toISOString();
  }
  db.run('UPDATE profiles SET failed_attempts = ?, locked_until_utc = ? WHERE id = ?', [attempts, lockedUntilIso, id]);

  return lockedUntilIso ? { ok: false, lockedForSeconds } : { ok: false };
}

// ---- per-profile secrets on disk -----------------------------------------

// Names are UNIQUE in the profiles table, so a slug of the name alone is a
// safe, collision-free directory name.
export function slugify(name) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'profile';
}

export function profileDir(profilesDir, profile) {
  return join(profilesDir, slugify(profile.name));
}

export function ensureProfileDirs(profilesDir, profile) {
  const dir = profileDir(profilesDir, profile);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const memoryPath = join(dir, 'memory.md');
  if (!existsSync(memoryPath)) writeFileSync(memoryPath, '');
  return dir;
}

export function readSecrets(profilesDir, profile) {
  const path = join(profileDir(profilesDir, profile), 'secrets.json');
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export function writeSecrets(profilesDir, profile, obj) {
  const dir = profileDir(profilesDir, profile);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'secrets.json');
  writeFileSync(path, JSON.stringify(obj, null, 2), { mode: 0o600 });
  // writeFileSync only applies `mode` when the file is created new, so force
  // it here too. Some platforms (Windows) do not support POSIX modes at all.
  try { chmodSync(path, 0o600); } catch { /* not supported on this platform */ }
  return path;
}

export function hasGoogleConnected(profilesDir, profile) {
  const secrets = readSecrets(profilesDir, profile);
  return !!(secrets && (secrets.gmail || secrets.calendar));
}

// The plan's rule: a PIN becomes mandatory the moment a profile connects
// Google, so the Connect wizard is gated behind an adult profile having set one.
export function canConnectGoogle(profile) {
  return !!(profile && profile.kind === 'adult' && hasPin(profile));
}

// True for any profile with Google already connected: unlocking with a PIN
// is required to use it, not just to connect it.
export function requiresPin(profile, profilesDir) {
  return hasGoogleConnected(profilesDir, profile);
}

// ---- in-memory unlock sessions --------------------------------------------

export function createLockManager({ now = () => Date.now() } = {}) {
  const sessions = new Map();   // profileId -> { until, minutes }
  const freshPinAt = new Map(); // profileId -> ms timestamp of the last fresh pin entry

  const clock = () => (typeof now === 'function' ? now() : now);

  function unlock(profileId, minutes) {
    const mins = Number(minutes) > 0 ? Number(minutes) : 10;
    const until = clock() + mins * 60 * 1000;
    sessions.set(profileId, { until, minutes: mins });
    return until;
  }

  function isUnlocked(profileId) {
    const session = sessions.get(profileId);
    if (!session) return false;
    if (session.until <= clock()) { sessions.delete(profileId); return false; }
    return true;
  }

  // Extends the existing session by the same number of minutes it was
  // unlocked with (that value came from the profile's auto_lock_minutes at
  // unlock time). Returns false if there was nothing to extend.
  function touch(profileId) {
    const session = sessions.get(profileId);
    if (!session || session.until <= clock()) { sessions.delete(profileId); return false; }
    session.until = clock() + session.minutes * 60 * 1000;
    return true;
  }

  function lock(profileId) {
    sessions.delete(profileId);
  }

  function lockAll() {
    sessions.clear();
  }

  function unlockedUntil(profileId) {
    const session = sessions.get(profileId);
    if (!session || session.until <= clock()) return null;
    return session.until;
  }

  // Sending mail always requires a fresh pin, separate from the longer
  // unlock session used to view mail and calendar.
  function markFreshPin(profileId) {
    freshPinAt.set(profileId, clock());
  }

  function hasFreshPin(profileId, withinSeconds = 60) {
    const at = freshPinAt.get(profileId);
    if (at == null) return false;
    return (clock() - at) <= withinSeconds * 1000;
  }

  return {
    unlock, isUnlocked, touch, lock, lockAll, unlockedUntil,
    markFreshPin, hasFreshPin, requiresPin,
  };
}
