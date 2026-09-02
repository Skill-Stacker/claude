// Unit tests for app/lib/profile-routes.js: profile CRUD, pin set/change,
// unlock/lock (including lockout), promote, and the SSE 'lock' event.
// Runs against the real server with a temp base dir; no network involved.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../app/server.js';
import { openDb } from '../app/lib/db.js';
import { createLockManager, createProfile, setPin } from '../app/lib/profiles.js';
import { wireProfiles } from '../app/lib/profile-routes.js';

function tmpBase() {
  return mkdtempSync(join(tmpdir(), 'stickos-profile-routes-'));
}

let nextPort = 47420;
function testPort() {
  nextPort += 1;
  return nextPort;
}

async function setup({ now } = {}) {
  const app = await startServer({ baseDir: tmpBase(), port: testPort() });
  const db = openDb(':memory:');
  const lockManager = createLockManager(now ? { now } : {});
  wireProfiles(app, { db, paths: app.paths, lockManager, bus: app.bus });
  return { app, db, lockManager };
}

function headers(app) {
  return { 'Content-Type': 'application/json', 'x-stickos-token': app.token };
}

async function post(app, path, body) {
  const res = await fetch(`${app.origin}${path}`, {
    method: 'POST',
    headers: headers(app),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(app, path) {
  const res = await fetch(`${app.origin}${path}`);
  return { status: res.status, body: await res.json() };
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Reads whatever SSE frames arrive on `res` within `timeoutMs`, then stops
// reading. Mirrors the helper in tests/monitor.test.js.
async function readSseEvents(res, timeoutMs) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const outcome = await Promise.race([
      reader.read().then((r) => ({ read: r })),
      wait(remaining).then(() => ({ timedOut: true })),
    ]);
    if (outcome.timedOut) break;
    const { value, done } = outcome.read;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const typeMatch = raw.match(/^event: (.+)$/m);
      const dataMatch = raw.match(/^data: (.+)$/m);
      if (typeMatch && dataMatch) events.push({ type: typeMatch[1], data: JSON.parse(dataMatch[1]) });
    }
  }
  try {
    await reader.cancel();
  } catch {
    // stream already gone
  }
  return events;
}

// ---------------------------------------------------------------------------
// GET/POST /api/profiles
// ---------------------------------------------------------------------------

describe('GET/POST /api/profiles', () => {
  test('starts empty, creates a child profile, lists it back', async () => {
    const { app } = await setup();
    try {
      const empty = await get(app, '/api/profiles');
      assert.deepEqual(empty.body, { profiles: [] });

      const created = await post(app, '/api/profiles', { name: 'Alex' });
      assert.equal(created.status, 200);
      assert.equal(created.body.profile.name, 'Alex');
      assert.equal(created.body.profile.kind, 'child');
      assert.equal(created.body.profile.hasPin, false);
      assert.equal(created.body.profile.googleConnected, false);
      assert.equal(created.body.profile.unlockedUntil, null);

      const list = await get(app, '/api/profiles');
      assert.equal(list.body.profiles.length, 1);
      assert.equal(list.body.profiles[0].name, 'Alex');
    } finally {
      await app.close();
    }
  });

  test('rejects an empty name and a name over 40 characters', async () => {
    const { app } = await setup();
    try {
      const empty = await post(app, '/api/profiles', { name: '   ' });
      assert.equal(empty.status, 400);

      const tooLong = await post(app, '/api/profiles', { name: 'x'.repeat(41) });
      assert.equal(tooLong.status, 400);

      const exactlyMax = await post(app, '/api/profiles', { name: 'x'.repeat(40) });
      assert.equal(exactlyMax.status, 200);
    } finally {
      await app.close();
    }
  });

  test('POST requires the per-launch token', async () => {
    const { app } = await setup();
    try {
      const res = await fetch(`${app.origin}/api/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'NoToken' }),
      });
      assert.equal(res.status, 401);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/profiles/pin
// ---------------------------------------------------------------------------

describe('POST /api/profiles/pin', () => {
  test('sets a pin when none is set, then requires the current pin to change it', async () => {
    const { app, db } = await setup();
    try {
      const profile = createProfile(db, { name: 'Sam', kind: 'adult' });

      const setResult = await post(app, '/api/profiles/pin', { profileId: profile.id, pin: '4821' });
      assert.equal(setResult.status, 200);
      assert.equal(setResult.body.ok, true);

      const list = await get(app, '/api/profiles');
      assert.equal(list.body.profiles[0].hasPin, true);

      // Wrong current pin: rejected, no change made.
      const wrongCurrent = await post(app, '/api/profiles/pin', { profileId: profile.id, pin: '0000', newPin: '1111' });
      assert.equal(wrongCurrent.body.ok, false);

      // Right current pin but no newPin: a plain input error, not a lockout.
      const missingNew = await post(app, '/api/profiles/pin', { profileId: profile.id, pin: '4821' });
      assert.equal(missingNew.status, 400);

      // Right current pin, changes it.
      const changed = await post(app, '/api/profiles/pin', { profileId: profile.id, pin: '4821', newPin: '9999' });
      assert.equal(changed.body.ok, true);

      const unlockOld = await post(app, '/api/profiles/unlock', { profileId: profile.id, pin: '4821' });
      assert.equal(unlockOld.body.ok, false);

      const unlockNew = await post(app, '/api/profiles/unlock', { profileId: profile.id, pin: '9999' });
      assert.equal(unlockNew.body.ok, true);
    } finally {
      await app.close();
    }
  });

  test('rejects a malformed pin', async () => {
    const { app, db } = await setup();
    try {
      const profile = createProfile(db, { name: 'Sam', kind: 'adult' });
      const bad = await post(app, '/api/profiles/pin', { profileId: profile.id, pin: 'abcd' });
      assert.equal(bad.status, 400);
    } finally {
      await app.close();
    }
  });

  test('404 for a profileId that does not exist', async () => {
    const { app } = await setup();
    try {
      const res = await post(app, '/api/profiles/pin', { profileId: 999, pin: '1234' });
      assert.equal(res.status, 404);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/profiles/unlock and /api/profiles/lock, with a fake clock
// ---------------------------------------------------------------------------

describe('unlock, lock and lockout, on a fake clock', () => {
  test('unlock succeeds with the right pin, publishes a lock SSE event, and lock clears it', async () => {
    let clock = 1_000_000;
    const { app, db } = await setup({ now: () => clock });
    try {
      const profile = createProfile(db, { name: 'Sam', kind: 'adult' });
      setPin(db, profile.id, '4821');

      const sseRes = await fetch(`${app.origin}/api/events`);

      const unlocked = await post(app, '/api/profiles/unlock', { profileId: profile.id, pin: '4821' });
      assert.equal(unlocked.body.ok, true);
      assert.equal(unlocked.body.unlockedUntil, clock + 10 * 60 * 1000); // default auto_lock_minutes = 10

      const afterUnlock = await get(app, '/api/profiles');
      assert.equal(afterUnlock.body.profiles[0].unlockedUntil, clock + 10 * 60 * 1000);

      const locked = await post(app, '/api/profiles/lock', { profileId: profile.id });
      assert.equal(locked.body.ok, true);

      const afterLock = await get(app, '/api/profiles');
      assert.equal(afterLock.body.profiles[0].unlockedUntil, null);

      const events = await readSseEvents(sseRes, 500);
      const lockEvents = events.filter((e) => e.type === 'lock');
      assert.equal(lockEvents.length, 2);
      assert.equal(lockEvents[0].data.profileId, profile.id);
      assert.ok(lockEvents[0].data.unlockedUntil > clock);
      assert.equal(lockEvents[1].data.unlockedUntil, null);
    } finally {
      await app.close();
    }
  });

  test('wrong pin reports ok: false, and five misses lock it out with lockedForSeconds', async () => {
    let clock = 1_000_000;
    const { app, db } = await setup({ now: () => clock });
    try {
      const profile = createProfile(db, { name: 'Sam', kind: 'adult' });
      setPin(db, profile.id, '4821');

      for (let i = 0; i < 4; i++) {
        const miss = await post(app, '/api/profiles/unlock', { profileId: profile.id, pin: '0000' });
        assert.equal(miss.body.ok, false);
        assert.equal(miss.body.lockedForSeconds, undefined);
      }

      const fifth = await post(app, '/api/profiles/unlock', { profileId: profile.id, pin: '0000' });
      assert.equal(fifth.body.ok, false);
      assert.equal(fifth.body.lockedForSeconds, 60);

      // Still inside the lock window: even the right pin is refused.
      const stillLocked = await post(app, '/api/profiles/unlock', { profileId: profile.id, pin: '4821' });
      assert.equal(stillLocked.body.ok, false);
      assert.ok(stillLocked.body.lockedForSeconds > 0);
    } finally {
      await app.close();
    }
  });

  test('unlocking a profile with no pin set fails cleanly', async () => {
    const { app, db } = await setup();
    try {
      const profile = createProfile(db, { name: 'Kid', kind: 'child' });
      const res = await post(app, '/api/profiles/unlock', { profileId: profile.id, pin: '1234' });
      assert.equal(res.status, 400);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/profiles/promote
// ---------------------------------------------------------------------------

describe('POST /api/profiles/promote', () => {
  test('409 without a pin set', async () => {
    const { app, db } = await setup();
    try {
      const profile = createProfile(db, { name: 'Kid', kind: 'child' });
      const res = await post(app, '/api/profiles/promote', { profileId: profile.id, pin: '1234' });
      assert.equal(res.status, 409);
    } finally {
      await app.close();
    }
  });

  test('promotes to adult once a pin is set and verified', async () => {
    const { app, db } = await setup();
    try {
      const profile = createProfile(db, { name: 'Kid', kind: 'child' });
      setPin(db, profile.id, '1234');

      const wrong = await post(app, '/api/profiles/promote', { profileId: profile.id, pin: '0000' });
      assert.equal(wrong.body.ok, false);

      const right = await post(app, '/api/profiles/promote', { profileId: profile.id, pin: '1234' });
      assert.equal(right.body.ok, true);
      assert.equal(right.body.profile.kind, 'adult');

      const list = await get(app, '/api/profiles');
      assert.equal(list.body.profiles[0].kind, 'adult');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/status includes the profile status provider
// ---------------------------------------------------------------------------

describe('app.setStatus profile provider', () => {
  test('/api/status reports profile count and which ids are unlocked', async () => {
    const { app, db } = await setup();
    try {
      const a = createProfile(db, { name: 'A', kind: 'adult' });
      const b = createProfile(db, { name: 'B', kind: 'child' });
      setPin(db, a.id, '1234');

      await post(app, '/api/profiles/unlock', { profileId: a.id, pin: '1234' });

      const status = await get(app, '/api/status');
      assert.equal(status.body.profile.count, 2);
      assert.deepEqual(status.body.profile.unlocked, [a.id]);
      // b was never created a pin-locked session, so it never appears.
      assert.ok(!status.body.profile.unlocked.includes(b.id));
    } finally {
      await app.close();
    }
  });
});
