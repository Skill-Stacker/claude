import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../app/lib/db.js';
import {
  createProfile, listProfiles, getProfile, renameProfile,
  promoteToAdult, demoteToChild,
  setPin, verifyPin, hasPin,
  profileDir, ensureProfileDirs, readSecrets, writeSecrets, hasGoogleConnected,
  canConnectGoogle, requiresPin,
  createLockManager,
} from '../app/lib/profiles.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'stickos-profiles-'));
}

test('createProfile, listProfiles, getProfile, renameProfile, promote and demote', () => {
  const db = openDb(':memory:');
  const kid = createProfile(db, { name: 'Alex' });
  assert.equal(kid.kind, 'child');
  assert.equal(kid.name, 'Alex');
  assert.ok(kid.id);

  const adult = createProfile(db, { name: 'Sam', kind: 'adult' });
  assert.equal(adult.kind, 'adult');

  const all = listProfiles(db);
  assert.equal(all.length, 2);

  assert.equal(getProfile(db, kid.id).name, 'Alex');
  assert.equal(getProfile(db, 999), null);

  const renamed = renameProfile(db, kid.id, 'Alexandra');
  assert.equal(renamed.name, 'Alexandra');

  const promoted = promoteToAdult(db, kid.id);
  assert.equal(promoted.kind, 'adult');

  const demoted = demoteToChild(db, kid.id);
  assert.equal(demoted.kind, 'child');

  db.close();
});

test('setPin rejects bad pins and accepts a valid one', () => {
  const db = openDb(':memory:');
  const p = createProfile(db, { name: 'Alex', kind: 'adult' });

  assert.throws(() => setPin(db, p.id, '12'));
  assert.throws(() => setPin(db, p.id, 'abcd'));
  assert.throws(() => setPin(db, p.id, '123456789'));

  const updated = setPin(db, p.id, '4821');
  assert.equal(hasPin(updated), true);

  db.close();
});

test('verifyPin accepts the right pin and rejects the wrong one', () => {
  const db = openDb(':memory:');
  const p = createProfile(db, { name: 'Alex', kind: 'adult' });
  setPin(db, p.id, '4821');

  const right = verifyPin(db, p.id, '4821');
  assert.equal(right.ok, true);

  // a fresh miss after a successful verify (attempts reset to 0)
  const wrong = verifyPin(db, p.id, '0000');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.lockedForSeconds, undefined);

  db.close();
});

test('verifyPin locks out after five consecutive misses and doubles the wait, capped at one hour', () => {
  const db = openDb(':memory:');
  const p = createProfile(db, { name: 'Alex', kind: 'adult' });
  setPin(db, p.id, '4821');

  let clock = 1_000_000;
  const now = () => clock;

  for (let i = 0; i < 4; i++) {
    const r = verifyPin(db, p.id, '0000', { now });
    assert.equal(r.ok, false);
    assert.equal(r.lockedForSeconds, undefined, `miss ${i + 1} should not lock yet`);
  }

  const fifth = verifyPin(db, p.id, '0000', { now });
  assert.equal(fifth.ok, false);
  assert.equal(fifth.lockedForSeconds, 60);

  // still inside the lock window: the pin is not even checked
  clock += 30_000;
  const stillLocked = verifyPin(db, p.id, '4821', { now });
  assert.equal(stillLocked.ok, false);
  assert.equal(stillLocked.lockedForSeconds, 30);

  // move past the lock, miss again: sixth consecutive miss doubles to 120s
  clock += 31_000;
  const sixth = verifyPin(db, p.id, '0000', { now });
  assert.equal(sixth.ok, false);
  assert.equal(sixth.lockedForSeconds, 120);

  // keep missing (always waiting out each lock) until the cap is hit
  let last = sixth;
  for (let i = 0; i < 10; i++) {
    clock += last.lockedForSeconds * 1000 + 1;
    last = verifyPin(db, p.id, '0000', { now });
  }
  assert.equal(last.lockedForSeconds, 3600);

  // a correct pin after waiting out the lock resets the counter
  clock += last.lockedForSeconds * 1000 + 1;
  const recovered = verifyPin(db, p.id, '4821', { now });
  assert.equal(recovered.ok, true);
  const freshMiss = verifyPin(db, p.id, '0000', { now });
  assert.equal(freshMiss.lockedForSeconds, undefined);

  db.close();
});

test('secrets round-trip in a temp dir, with 0600 file mode on posix', () => {
  const dir = tmpDir();
  const db = openDb(':memory:');
  const p = createProfile(db, { name: "O'Brien Kid", kind: 'child' });

  ensureProfileDirs(dir, p);
  assert.deepEqual(readSecrets(dir, p), {});
  assert.equal(hasGoogleConnected(dir, p), false);

  const path = writeSecrets(dir, p, { gmail: { appPassword: 'x' } });
  const back = readSecrets(dir, p);
  assert.deepEqual(back, { gmail: { appPassword: 'x' } });
  assert.equal(hasGoogleConnected(dir, p), true);

  if (process.platform !== 'win32') {
    const stat = statSync(path);
    assert.equal(stat.mode & 0o777, 0o600);
  }

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('canConnectGoogle requires an adult profile with a pin set', () => {
  const db = openDb(':memory:');
  const child = createProfile(db, { name: 'Kid', kind: 'child' });
  const adultNoPin = createProfile(db, { name: 'AdultNoPin', kind: 'adult' });
  const adultWithPin = createProfile(db, { name: 'AdultWithPin', kind: 'adult' });
  setPin(db, adultWithPin.id, '1234');

  assert.equal(canConnectGoogle(child), false);
  assert.equal(canConnectGoogle(adultNoPin), false);
  assert.equal(canConnectGoogle(getProfile(db, adultWithPin.id)), true);

  db.close();
});

test('requiresPin is true once a profile has connected Google', () => {
  const dir = tmpDir();
  const db = openDb(':memory:');
  const p = createProfile(db, { name: 'Connected', kind: 'adult' });
  setPin(db, p.id, '1234');

  assert.equal(requiresPin(p, dir), false);
  writeSecrets(dir, p, { calendar: { icalUrl: 'https://example.invalid/cal.ics' } });
  assert.equal(requiresPin(p, dir), true);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('lock manager: unlock, touch extends by the original minutes, and expiry', () => {
  let clock = 0;
  const mgr = createLockManager({ now: () => clock });

  assert.equal(mgr.isUnlocked(1), false);
  assert.equal(mgr.unlockedUntil(1), null);

  mgr.unlock(1, 10); // 10 minutes
  assert.equal(mgr.isUnlocked(1), true);

  clock += 9 * 60 * 1000;
  assert.equal(mgr.isUnlocked(1), true);
  assert.equal(mgr.touch(1), true);

  clock += 9 * 60 * 1000; // would have expired without the touch
  assert.equal(mgr.isUnlocked(1), true);

  clock += 11 * 60 * 1000; // now well past the touched expiry
  assert.equal(mgr.isUnlocked(1), false);

  mgr.unlock(2, 5);
  mgr.lock(2);
  assert.equal(mgr.isUnlocked(2), false);

  mgr.unlock(3, 5);
  mgr.unlock(4, 5);
  mgr.lockAll();
  assert.equal(mgr.isUnlocked(3), false);
  assert.equal(mgr.isUnlocked(4), false);

  // touch on a profile with no session at all is a no-op that reports false
  assert.equal(mgr.touch(999), false);
});

test('fresh pin window used to gate sending mail', () => {
  let clock = 0;
  const mgr = createLockManager({ now: () => clock });

  assert.equal(mgr.hasFreshPin(1), false);

  mgr.markFreshPin(1);
  assert.equal(mgr.hasFreshPin(1), true);

  clock += 61 * 1000;
  assert.equal(mgr.hasFreshPin(1), false);
  assert.equal(mgr.hasFreshPin(1, 120), true);

  clock += 60 * 1000;
  assert.equal(mgr.hasFreshPin(1, 120), false);
});
