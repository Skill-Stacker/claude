// Unit tests for app/lib/google/sync.js. No real network: a small fake
// ImapFlow class (the FakeImapFlow approach from tests/gmail.test.js,
// trimmed to what syncMailbox actually calls) and a fake fetchText stand in
// for Gmail and the calendar feed. Every timer (setInterval/setTimeout) is
// injected so the schedule, the stagger, and the on-demand calendar timeout
// can all be driven by hand instead of real wall-clock time.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../app/lib/db.js';
import { createProfile, writeSecrets } from '../app/lib/profiles.js';
import { createSync, scopedDb } from '../app/lib/google/sync.js';

const here = dirname(fileURLToPath(import.meta.url));
const familyIcs = readFileSync(join(here, 'fixtures', 'calendar', 'family.ics'), 'utf8');

function tmpProfilesDir() {
  return mkdtempSync(join(tmpdir(), 'stickos-sync-'));
}

// ---------------------------------------------------------------------------
// Fake ImapFlow: only the surface syncMailbox actually calls (see gmail.js).
// ---------------------------------------------------------------------------

function throwFakeError(mode) {
  if (mode === 'auth') {
    const err = new Error('[AUTHENTICATIONFAILED] Invalid credentials (Failure)');
    err.authenticationFailed = true;
    throw err;
  }
  if (mode === 'connection_cap') {
    throw new Error('[ALERT] Too many simultaneous connections. (Failure)');
  }
  if (mode === 'network') {
    const err = new Error('connect ECONNRESET');
    err.code = 'ECONNRESET';
    throw err;
  }
  throw new Error(`fake ${mode} error`);
}

function makeFakeImapFlowClass(state) {
  return class FakeImapFlow {
    constructor() {
      state.instances.push(this);
    }
    async connect() {
      if (state.connectGate) await state.connectGate;
      if (state.connectMode) throwFakeError(state.connectMode);
    }
    async logout() {}
    close() {}
    async getMailboxLock(path) {
      this._selected = path;
      return { path, release() {} };
    }
    async search() {
      return [];
    }
    fetch() {
      return (async function* () {})();
    }
  };
}

// ---------------------------------------------------------------------------
// Fake netlog / bus
// ---------------------------------------------------------------------------

function fakeNetlog() {
  const entries = [];
  return { record: (e) => { entries.push(e); return e; }, entries };
}

function fakeBus() {
  const events = [];
  return { publish: (type, data) => events.push({ type, data }), events };
}

// ---------------------------------------------------------------------------
// Fake timers: setInterval/setTimeout return incrementing ids and just
// record the {fn, ms}; nothing fires on its own, tests fire them by hand.
// ---------------------------------------------------------------------------

function makeFakeTimers() {
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  let lastTimeoutId = null;
  return {
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timeouts.set(id, { fn, ms });
      lastTimeoutId = id;
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    intervals,
    timeouts,
    fireTimeout(id) {
      const t = timeouts.get(id);
      if (t) { timeouts.delete(id); t.fn(); }
    },
    fireLastTimeout() {
      if (lastTimeoutId != null) this.fireTimeout(lastTimeoutId);
    },
  };
}

function setupProfile(db, profilesDir, { name = 'Adult', gmail, calendar } = {}) {
  const profile = createProfile(db, { name, kind: 'adult' });
  const secrets = {};
  if (gmail) secrets.gmail = { address: 'me@gmail.com', appPassword: 'abcdefghijklmnop', ...gmail };
  if (calendar) secrets.calendar = { icsUrl: 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics', ...calendar };
  writeSecrets(profilesDir, profile, secrets);
  return profile;
}

// ---------------------------------------------------------------------------
// scopedDb
// ---------------------------------------------------------------------------

test('scopedDb prefixes getState/setState by profile, everything else passes through', () => {
  const db = openDb(':memory:');
  const a = scopedDb(db, 1);
  const b = scopedDb(db, 2);
  a.setState('gmail:lastChecked', 'A');
  b.setState('gmail:lastChecked', 'B');
  assert.equal(a.getState('gmail:lastChecked'), 'A');
  assert.equal(b.getState('gmail:lastChecked'), 'B');
  assert.equal(db.getState('p1:gmail:lastChecked'), 'A');

  a.run('INSERT INTO reminders (profile_id, text, created_utc) VALUES (?, ?, ?)', [1, 'hi', new Date().toISOString()]);
  assert.equal(db.all('SELECT * FROM reminders').length, 1, 'run() is not scoped, it hits the real table');
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

describe('start()/stop() scheduling', () => {
  test('schedules a staggered kickoff plus an interval per connected profile, and stop() clears them all', () => {
    const db = openDb(':memory:');
    const profilesDir = tmpProfilesDir();
    const gmailProfile = setupProfile(db, profilesDir, { name: 'Gmailer', gmail: {} });
    const calProfile = setupProfile(db, profilesDir, { name: 'Calendarer', calendar: {} });
    const both = setupProfile(db, profilesDir, { name: 'Both', gmail: {}, calendar: {} });

    const timers = makeFakeTimers();
    const sync = createSync({
      db,
      paths: { profiles: profilesDir },
      bus: fakeBus(),
      netlog: fakeNetlog(),
      fetchText: async () => ({ status: 200, text: familyIcs }),
      imapFactory: makeFakeImapFlowClass({ instances: [] }),
      timers: { gmailMs: 180000, calendarMs: 2700000 },
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    sync.start();

    // One gmail interval for gmailProfile and both, one calendar interval
    // for calProfile and both: 4 intervals at the documented default ms.
    const intervalMsValues = [...timers.intervals.values()].map((t) => t.ms).sort();
    assert.deepEqual(intervalMsValues, [180000, 180000, 2700000, 2700000]);

    // Every connected profile also gets a staggered one-shot kickoff.
    assert.equal(timers.timeouts.size, 4);
    const delays = [...timers.timeouts.values()].map((t) => t.ms).sort((a, b) => a - b);
    assert.deepEqual(delays, [0, 250, 500, 750]);

    // Calling start() again must not double-schedule.
    sync.start();
    assert.equal(timers.intervals.size, 4);
    assert.equal(timers.timeouts.size, 4);

    sync.stop();
    assert.equal(timers.intervals.size, 0);
    assert.equal(timers.timeouts.size, 0);

    void gmailProfile;
    void calProfile;
    void both;
  });
});

// ---------------------------------------------------------------------------
// now(): in-flight guard, netlog, bus events
// ---------------------------------------------------------------------------

describe('now(): gmail', () => {
  test('a second concurrent now() for the same profile short-circuits with in_flight', async () => {
    const db = openDb(':memory:');
    const profilesDir = tmpProfilesDir();
    const profile = setupProfile(db, profilesDir, { gmail: {} });

    const state = { instances: [], connectGate: new Promise(() => {}) }; // never resolves until released
    let release;
    state.connectGate = new Promise((r) => { release = r; });

    const netlog = fakeNetlog();
    const bus = fakeBus();
    const sync = createSync({
      db,
      paths: { profiles: profilesDir },
      bus,
      netlog,
      fetchText: async () => ({ status: 200, text: familyIcs }),
      imapFactory: makeFakeImapFlowClass(state),
    });

    const first = sync.now(profile.id, 'gmail');
    // Give the first call a tick to reach the in-flight state.
    await Promise.resolve();
    await Promise.resolve();

    const second = await sync.now(profile.id, 'gmail');
    assert.equal(second.ok, false);
    assert.equal(second.gmail.error, 'in_flight');

    release();
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
  });

  test('a successful sync records netlog and publishes start/done bus events', async () => {
    const db = openDb(':memory:');
    const profilesDir = tmpProfilesDir();
    const profile = setupProfile(db, profilesDir, { gmail: {} });

    const netlog = fakeNetlog();
    const bus = fakeBus();
    const sync = createSync({
      db,
      paths: { profiles: profilesDir },
      bus,
      netlog,
      fetchText: async () => ({ status: 200, text: familyIcs }),
      imapFactory: makeFakeImapFlowClass({ instances: [] }),
    });

    const result = await sync.now(profile.id, 'gmail');
    assert.equal(result.ok, true);

    const imapEntries = netlog.entries.filter((e) => e.kind === 'imap');
    assert.equal(imapEntries.length, 1);
    assert.equal(imapEntries[0].ok, true);
    assert.equal(imapEntries[0].purpose, 'checking your inbox');
    assert.equal(imapEntries[0].host, 'imap.gmail.com');

    const syncEvents = bus.events.filter((e) => e.type === 'sync' && e.data.what === 'gmail');
    assert.equal(syncEvents[0].data.phase, 'start');
    assert.equal(syncEvents[0].data.profileId, profile.id);
    assert.equal(syncEvents[syncEvents.length - 1].data.phase, 'done');
  });

  test('an auth failure stops the periodic poller until now() is called again', async () => {
    const db = openDb(':memory:');
    const profilesDir = tmpProfilesDir();
    const profile = setupProfile(db, profilesDir, { gmail: {} });

    const state = { instances: [], connectMode: 'auth' };
    const netlog = fakeNetlog();
    const bus = fakeBus();
    const timers = makeFakeTimers();
    const sync = createSync({
      db,
      paths: { profiles: profilesDir },
      bus,
      netlog,
      fetchText: async () => ({ status: 200, text: familyIcs }),
      imapFactory: makeFakeImapFlowClass(state),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    const first = await sync.now(profile.id, 'gmail');
    assert.equal(first.ok, false);
    assert.equal(first.gmail.error, 'auth');
    const afterFirst = netlog.entries.filter((e) => e.kind === 'imap').length;

    // Simulate the periodic poller ticking: it must now no-op (the auth
    // failure paused it), so no new netlog entries or bus events appear.
    sync.start();
    for (const { fn } of timers.timeouts.values()) fn(); // fire the staggered kickoffs
    for (const { fn } of timers.intervals.values()) fn(); // fire the interval ticks
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(netlog.entries.filter((e) => e.kind === 'imap').length, afterFirst, 'poller must have skipped, not attempted');

    // now() is the "credentials saved again" signal: it always retries.
    state.connectMode = null;
    const second = await sync.now(profile.id, 'gmail');
    assert.equal(second.ok, true);
    assert.ok(netlog.entries.filter((e) => e.kind === 'imap').length > afterFirst, 'the explicit retry must have attempted the network');
  });

  test('the connection-cap backoff stops further attempts once the ceiling is hit', async () => {
    const db = openDb(':memory:');
    const profilesDir = tmpProfilesDir();
    const profile = setupProfile(db, profilesDir, { gmail: {} });

    const state = { instances: [], connectMode: 'connection_cap' };
    const netlog = fakeNetlog();
    let clock = 1_000_000;
    const sync = createSync({
      db,
      paths: { profiles: profilesDir },
      bus: fakeBus(),
      netlog,
      fetchText: async () => ({ status: 200, text: familyIcs }),
      imapFactory: makeFakeImapFlowClass(state),
      now: () => clock,
    });

    // Gmail's cap ceiling is 5 attempts inside a 10 minute window (gmail.js
    // capBackoff): the first 5 on-demand calls all really attempt and fail,
    // and only the 5th trips the backoff.
    for (let i = 0; i < 5; i++) {
      const r = await sync.now(profile.id, 'gmail');
      assert.equal(r.ok, false);
    }
    const attemptedCount = netlog.entries.filter((e) => e.kind === 'imap').length;
    assert.equal(attemptedCount, 5);

    // A 6th call, still within the backoff window, must not touch the
    // network at all.
    const sixth = await sync.now(profile.id, 'gmail');
    assert.equal(sixth.ok, false);
    assert.equal(sixth.gmail.error, 'connection_cap');
    assert.equal(netlog.entries.filter((e) => e.kind === 'imap').length, attemptedCount, 'the 6th call must have been held back, not attempted');
  });
});

// ---------------------------------------------------------------------------
// now(): calendar, including the 5 second on-demand timeout
// ---------------------------------------------------------------------------

describe('now(): calendar', () => {
  test('a successful calendar sync records netlog, publishes events, and reports upcoming instances', async () => {
    const db = openDb(':memory:');
    const profilesDir = tmpProfilesDir();
    const profile = setupProfile(db, profilesDir, { calendar: { calendarName: 'Family' } });

    const netlog = fakeNetlog();
    const bus = fakeBus();
    const sync = createSync({
      db,
      paths: { profiles: profilesDir },
      bus,
      netlog,
      fetchText: async () => ({ status: 200, text: familyIcs }),
      imapFactory: null,
    });

    const result = await sync.now(profile.id, 'calendar');
    assert.equal(result.ok, true);

    const httpEntries = netlog.entries.filter((e) => e.kind === 'https');
    assert.equal(httpEntries.length, 1);
    assert.equal(httpEntries[0].ok, true);

    const s = sync.status(profile.id);
    assert.ok(s.calendar.lastChecked);
    assert.ok(s.calendar.staleMinutes >= 0 && s.calendar.staleMinutes < 1, 'just synced, so staleness should be under a minute');

    const doneEvent = bus.events.find((e) => e.type === 'sync' && e.data.what === 'calendar' && e.data.phase === 'done');
    assert.ok(doneEvent);
    assert.ok(doneEvent.data.done > 0);
  });

  test('on-demand calendar sync never throws and times out at 5 seconds when fetchText never resolves', async () => {
    const db = openDb(':memory:');
    const profilesDir = tmpProfilesDir();
    const profile = setupProfile(db, profilesDir, { calendar: {} });

    const timers = makeFakeTimers();
    const bus = fakeBus();
    const sync = createSync({
      db,
      paths: { profiles: profilesDir },
      bus,
      netlog: fakeNetlog(),
      fetchText: () => new Promise(() => {}), // never resolves
      imapFactory: null,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: () => 0,
      clearInterval: () => {},
    });

    const pending = sync.now(profile.id, 'calendar');
    await Promise.resolve();
    await Promise.resolve();

    // Exactly one 5 second timer should be pending: the on-demand timeout.
    const fiveSecondTimers = [...timers.timeouts.values()].filter((t) => t.ms === 5000);
    assert.equal(fiveSecondTimers.length, 1);

    timers.fireLastTimeout();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.calendar.error, 'timeout');

    const timeoutEvent = bus.events.find((e) => e.type === 'sync' && e.data.kind === 'timeout');
    assert.ok(timeoutEvent);
  });
});

// ---------------------------------------------------------------------------
// createGmailSession
// ---------------------------------------------------------------------------

describe('createGmailSession', () => {
  test('returns creds and folders while connected, null once disconnected', () => {
    const db = openDb(':memory:');
    const profilesDir = tmpProfilesDir();
    const profile = setupProfile(db, profilesDir, { gmail: { folders: { inbox: 'INBOX' } } });

    const sync = createSync({
      db,
      paths: { profiles: profilesDir },
      bus: fakeBus(),
      netlog: fakeNetlog(),
      fetchText: async () => ({ status: 200, text: familyIcs }),
      imapFactory: null,
    });

    const session = sync.createGmailSession(profile.id);
    assert.equal(session.creds.email, 'me@gmail.com');
    assert.deepEqual(session.folders, { inbox: 'INBOX' });
    assert.equal(typeof session.withImap, 'function');

    writeSecrets(profilesDir, profile, {}); // disconnect
    assert.equal(sync.createGmailSession(profile.id), null);
  });
});
