// Unit tests for app/lib/google/routes.js. No real network: a small fake
// ImapFlow class (the FakeImapFlow approach from tests/gmail.test.js,
// trimmed to what verifyCredentials/discoverFolders/syncMailbox actually
// call), a fake SMTP transport, and a fake fetchText serving the calendar
// fixtures under tests/fixtures/calendar/.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../app/server.js';
import { openDb } from '../app/lib/db.js';
import { createProfile, setPin, createLockManager, readSecrets } from '../app/lib/profiles.js';
import { createSync } from '../app/lib/google/sync.js';
import { wireGoogle } from '../app/lib/google/routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const calDir = join(here, 'fixtures', 'calendar');
const familyIcs = readFileSync(join(calDir, 'family.ics'), 'utf8');
const notIcsText = readFileSync(join(calDir, 'not-ics.txt'), 'utf8');
const GOOD_ICS_URL = 'https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/private-secret123/basic.ics';

// ---------------------------------------------------------------------------
// Fake ImapFlow
// ---------------------------------------------------------------------------

const LOCALIZED_FOLDERS = [
  { path: 'INBOX', flags: new Set(['\\Inbox']) },
  { path: '[Gmail]/All Mail', specialUse: '\\All' },
  { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
  { path: '[Gmail]/Drafts', specialUse: '\\Drafts' },
  { path: '[Gmail]/Trash', specialUse: '\\Trash' },
];
const FOLDERS = {
  all: '[Gmail]/All Mail', sent: '[Gmail]/Sent Mail', drafts: '[Gmail]/Drafts', trash: '[Gmail]/Trash', inbox: 'INBOX',
};

function throwFakeError(mode) {
  if (mode === 'auth') {
    const err = new Error('[AUTHENTICATIONFAILED] Invalid credentials (Failure)');
    err.authenticationFailed = true;
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
      if (state.connectMode) throwFakeError(state.connectMode);
    }
    async logout() {}
    close() {}
    async list() {
      return state.mailboxList || LOCALIZED_FOLDERS;
    }
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

function makeFakeTransport(mode) {
  return {
    async verify() {
      if (mode === 'reject') {
        const err = new Error('Invalid login: 535-5.7.8 Username and Password not accepted');
        err.code = 'EAUTH';
        throw err;
      }
      return true;
    },
    close() {},
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let nextPort = 47460;
function testPort() {
  nextPort += 1;
  return nextPort;
}

async function setup() {
  const baseDir = mkdtempSync(join(tmpdir(), 'stickos-google-routes-'));
  const app = await startServer({ baseDir, port: testPort() });
  const db = openDb(':memory:');
  const lockManager = createLockManager();

  const imapState = { instances: [], connectMode: null, mailboxList: LOCALIZED_FOLDERS };
  const imapFactory = makeFakeImapFlowClass(imapState);

  let fetchImpl = async () => ({ status: 200, text: familyIcs });
  const fetchText = (url, opts) => fetchImpl(url, opts);

  let transportMode = 'ok';
  const transportFactory = () => makeFakeTransport(transportMode);

  const sync = createSync({ db, paths: app.paths, bus: app.bus, netlog: app.netlog, fetchText, imapFactory });
  wireGoogle(app, { db, paths: app.paths, lockManager, sync, fetchText, imapFactory, transportFactory });

  return {
    app,
    db,
    lockManager,
    sync,
    imapState,
    setFetch: (fn) => { fetchImpl = fn; },
    setTransportMode: (mode) => { transportMode = mode; },
  };
}

function headers(app) {
  return { 'Content-Type': 'application/json', 'x-stickos-token': app.token };
}

async function post(app, path, body) {
  const res = await fetch(`${app.origin}${path}`, { method: 'POST', headers: headers(app), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function get(app, path) {
  const res = await fetch(`${app.origin}${path}`);
  return { status: res.status, body: await res.json() };
}

function makeAdultWithPin(db, name = 'Adult') {
  const profile = createProfile(db, { name, kind: 'adult' });
  setPin(db, profile.id, '1234');
  return profile;
}

// ---------------------------------------------------------------------------
// GET /api/google/status
// ---------------------------------------------------------------------------

describe('GET /api/google/status', () => {
  test('404 for an unknown profile', async () => {
    const { app } = await setup();
    try {
      const res = await get(app, '/api/google/status?profileId=999');
      assert.equal(res.status, 404);
    } finally {
      await app.close();
    }
  });

  test('reports both services disconnected for a fresh profile', async () => {
    const { app, db } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      const res = await get(app, `/api/google/status?profileId=${profile.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.gmail.connected, false);
      assert.equal(res.body.calendar.connected, false);
      assert.equal(res.body.gmail.lastChecked, null);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/google/gmail/verify
// ---------------------------------------------------------------------------

describe('POST /api/google/gmail/verify', () => {
  test('the 16-character fast fail never touches the network', async () => {
    const { app, db, imapState } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      const res = await post(app, '/api/google/gmail/verify', {
        profileId: profile.id, address: 'me@gmail.com', appPassword: 'short',
      });
      assert.equal(res.body.ok, false);
      assert.equal(res.body.kind, 'bad_password');
      assert.match(res.body.message, /16/);
      assert.equal(imapState.instances.length, 0, 'a badly-shaped password must never reach IMAP');
    } finally {
      await app.close();
    }
  });

  test('success returns folders and accountKind', async () => {
    const { app, db } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      const res = await post(app, '/api/google/gmail/verify', {
        profileId: profile.id, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop',
      });
      assert.equal(res.body.ok, true);
      assert.deepEqual(res.body.folders, FOLDERS);
      assert.equal(res.body.accountKind, 'personal');
    } finally {
      await app.close();
    }
  });

  test('an auth failure carries the question and no workspace prefix for a personal account', async () => {
    const { app, db, imapState } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      imapState.connectMode = 'auth';
      const res = await post(app, '/api/google/gmail/verify', {
        profileId: profile.id, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop',
      });
      assert.equal(res.body.ok, false);
      assert.equal(res.body.kind, 'auth');
      assert.equal(res.body.question, 'Did Google actually show you a 16-character password to copy, or did that option never appear?');
      assert.doesNotMatch(res.body.message, /administrator/);
    } finally {
      await app.close();
    }
  });

  test('an auth failure on a workspace address leads with the admin-block possibility', async () => {
    const { app, db, imapState } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      imapState.connectMode = 'auth';
      const res = await post(app, '/api/google/gmail/verify', {
        profileId: profile.id, address: 'me@ourschool.edu', appPassword: 'abcd efgh ijkl mnop',
      });
      assert.equal(res.body.ok, false);
      assert.match(res.body.message, /administrator/);
      assert.ok(res.body.message.startsWith('A school or work Google account'));
    } finally {
      await app.close();
    }
  });

  test('404 for an unknown profile', async () => {
    const { app } = await setup();
    try {
      const res = await post(app, '/api/google/gmail/verify', {
        profileId: 999, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop',
      });
      assert.equal(res.status, 404);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/google/gmail/save and disconnect
// ---------------------------------------------------------------------------

describe('POST /api/google/gmail/save', () => {
  test('409 without a pin set on the profile', async () => {
    const { app, db } = await setup();
    try {
      const profile = createProfile(db, { name: 'NoPin', kind: 'adult' });
      const res = await post(app, '/api/google/gmail/save', {
        profileId: profile.id, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop',
      });
      assert.equal(res.status, 409);
    } finally {
      await app.close();
    }
  });

  test('saves credentials, and status then reports connected', async () => {
    const { app, db, lockManager } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      lockManager.unlock(profile.id, 10);
      const saved = await post(app, '/api/google/gmail/save', {
        profileId: profile.id, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop',
      });
      assert.equal(saved.body.ok, true);

      const secrets = readSecrets(app.paths.profiles, profile);
      assert.equal(secrets.gmail.address, 'me@gmail.com');
      assert.equal(secrets.gmail.appPassword, 'abcdefghijklmnop');
      assert.deepEqual(secrets.gmail.folders, FOLDERS);

      const status = await get(app, `/api/google/status?profileId=${profile.id}`);
      assert.equal(status.body.gmail.connected, true);
      assert.equal(status.body.gmail.address, 'me@gmail.com');
    } finally {
      await app.close();
    }
  });

  test('once connected, further Google routes require the profile to be unlocked', async () => {
    const { app, db, lockManager } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      lockManager.unlock(profile.id, 10);
      await post(app, '/api/google/gmail/save', { profileId: profile.id, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' });

      lockManager.lock(profile.id);
      const res = await get(app, `/api/google/status?profileId=${profile.id}`);
      assert.equal(res.status, 423);
      assert.equal(res.body.error, 'locked');
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/google/gmail/disconnect', () => {
  test('clears the credentials and the cached messages/threads', async () => {
    const { app, db, lockManager } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      lockManager.unlock(profile.id, 10);
      await post(app, '/api/google/gmail/save', { profileId: profile.id, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' });

      db.run(
        `INSERT INTO messages (profile_id, gm_msgid, subject, date_utc) VALUES (?, ?, ?, ?)`,
        [profile.id, 'msg-1', 'hi', new Date().toISOString()],
      );
      db.run(
        `INSERT INTO threads (profile_id, gm_thrid, subject) VALUES (?, ?, ?)`,
        [profile.id, 'thr-1', 'hi'],
      );

      const res = await post(app, '/api/google/gmail/disconnect', { profileId: profile.id });
      assert.equal(res.body.ok, true);

      const secrets = readSecrets(app.paths.profiles, profile);
      assert.equal(secrets.gmail, undefined);
      assert.equal(db.all('SELECT * FROM messages WHERE profile_id = ?', [profile.id]).length, 0);
      assert.equal(db.all('SELECT * FROM threads WHERE profile_id = ?', [profile.id]).length, 0);

      const status = await get(app, `/api/google/status?profileId=${profile.id}`);
      assert.equal(status.body.gmail.connected, false);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/google/calendar/verify
// ---------------------------------------------------------------------------

describe('POST /api/google/calendar/verify', () => {
  test('rejects a URL that is not the secret iCal address', async () => {
    const { app, db } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      const res = await post(app, '/api/google/calendar/verify', { profileId: profile.id, icsUrl: 'https://example.com/cal.ics' });
      assert.equal(res.body.ok, false);
      assert.equal(res.body.kind, 'bad_url');
    } finally {
      await app.close();
    }
  });

  test('good url and feed: reports upcoming instances and the calendar name', async () => {
    const { app, db } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      const res = await post(app, '/api/google/calendar/verify', { profileId: profile.id, icsUrl: GOOD_ICS_URL });
      assert.equal(res.body.ok, true);
      assert.equal(res.body.calendarName, 'Family');
      assert.ok(res.body.upcoming > 0);
    } finally {
      await app.close();
    }
  });

  test('not_found (404) gets the copy-the-address-again message', async () => {
    const { app, db, setFetch } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      setFetch(async () => ({ status: 404, text: 'Not Found' }));
      const res = await post(app, '/api/google/calendar/verify', { profileId: profile.id, icsUrl: GOOD_ICS_URL });
      assert.equal(res.body.ok, false);
      assert.equal(res.body.kind, 'not_found');
      assert.match(res.body.message, /Secret address again/);
    } finally {
      await app.close();
    }
  });

  test('not_ics gets the not-a-calendar message', async () => {
    const { app, db, setFetch } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      setFetch(async () => ({ status: 200, text: notIcsText }));
      const res = await post(app, '/api/google/calendar/verify', { profileId: profile.id, icsUrl: GOOD_ICS_URL });
      assert.equal(res.body.ok, false);
      assert.equal(res.body.kind, 'not_ics');
      assert.match(res.body.message, /not a calendar/);
    } finally {
      await app.close();
    }
  });

  test('unreachable and timeout are reported in plain words', async () => {
    const { app, db, setFetch } = await setup();
    try {
      const profile = makeAdultWithPin(db);

      setFetch(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
      const unreachable = await post(app, '/api/google/calendar/verify', { profileId: profile.id, icsUrl: GOOD_ICS_URL });
      assert.equal(unreachable.body.kind, 'unreachable');
      assert.ok(unreachable.body.message.length > 0);

      setFetch(async () => { const err = new Error('timed out'); err.code = 'timeout'; throw err; });
      const timedOut = await post(app, '/api/google/calendar/verify', { profileId: profile.id, icsUrl: GOOD_ICS_URL });
      assert.equal(timedOut.body.kind, 'timeout');
      assert.ok(timedOut.body.message.length > 0);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/google/calendar/save and disconnect
// ---------------------------------------------------------------------------

describe('POST /api/google/calendar/save', () => {
  test('409 without a pin set', async () => {
    const { app, db } = await setup();
    try {
      const profile = createProfile(db, { name: 'NoPin', kind: 'adult' });
      const res = await post(app, '/api/google/calendar/save', { profileId: profile.id, icsUrl: GOOD_ICS_URL });
      assert.equal(res.status, 409);
    } finally {
      await app.close();
    }
  });

  test('saves on a good url and does not persist on a bad one', async () => {
    const { app, db } = await setup();
    try {
      const profile = makeAdultWithPin(db);

      const bad = await post(app, '/api/google/calendar/save', { profileId: profile.id, icsUrl: 'https://example.com/cal.ics' });
      assert.equal(bad.body.ok, false);
      assert.equal(readSecrets(app.paths.profiles, profile).calendar, undefined);

      const good = await post(app, '/api/google/calendar/save', { profileId: profile.id, icsUrl: GOOD_ICS_URL });
      assert.equal(good.body.ok, true);
      assert.equal(good.body.calendarName, 'Family');
      assert.equal(readSecrets(app.paths.profiles, profile).calendar.icsUrl, GOOD_ICS_URL);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/google/calendar/disconnect', () => {
  test('clears the credentials and the cached events', async () => {
    const { app, db, lockManager } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      lockManager.unlock(profile.id, 10);
      await post(app, '/api/google/calendar/save', { profileId: profile.id, icsUrl: GOOD_ICS_URL });

      db.run(
        `INSERT INTO events (profile_id, instance_id, uid, start_utc, end_utc) VALUES (?, ?, ?, ?, ?)`,
        [profile.id, 'ev-1', 'uid-1', new Date().toISOString(), new Date().toISOString()],
      );

      const res = await post(app, '/api/google/calendar/disconnect', { profileId: profile.id });
      assert.equal(res.body.ok, true);
      assert.equal(readSecrets(app.paths.profiles, profile).calendar, undefined);
      assert.equal(db.all('SELECT * FROM events WHERE profile_id = ?', [profile.id]).length, 0);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/google/sync
// ---------------------------------------------------------------------------

describe('POST /api/google/sync', () => {
  test('rejects an unknown "what"', async () => {
    const { app, db, lockManager } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      lockManager.unlock(profile.id, 10);
      const res = await post(app, '/api/google/sync', { profileId: profile.id, what: 'everything' });
      assert.equal(res.status, 400);
    } finally {
      await app.close();
    }
  });

  test('"both" syncs gmail and calendar and reports a combined result', async () => {
    const { app, db, lockManager } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      lockManager.unlock(profile.id, 10);
      await post(app, '/api/google/gmail/save', { profileId: profile.id, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' });
      await post(app, '/api/google/calendar/save', { profileId: profile.id, icsUrl: GOOD_ICS_URL });

      const res = await post(app, '/api/google/sync', { profileId: profile.id, what: 'both' });
      assert.equal(res.body.ok, true);
      assert.equal(res.body.gmail.ok, true);
      assert.equal(res.body.calendar.ok, true);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/calendar/events, /api/mail/threads, /api/mail/thread
// ---------------------------------------------------------------------------

describe('GET /api/calendar/events', () => {
  test('400 without from/to', async () => {
    const { app, db, lockManager } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      lockManager.unlock(profile.id, 10);
      const res = await get(app, `/api/calendar/events?profileId=${profile.id}`);
      assert.equal(res.status, 400);
    } finally {
      await app.close();
    }
  });

  test('returns events synced from the feed with asOf/staleMinutes', async () => {
    const { app, db, lockManager } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      lockManager.unlock(profile.id, 10);
      await post(app, '/api/google/calendar/save', { profileId: profile.id, icsUrl: GOOD_ICS_URL });

      const res = await get(
        app,
        `/api/calendar/events?profileId=${profile.id}&from=2026-09-01T00:00:00.000Z&to=2026-10-15T00:00:00.000Z`,
      );
      assert.equal(res.status, 200);
      assert.ok(res.body.asOf);
      assert.equal(typeof res.body.staleMinutes, 'number');
      assert.ok(res.body.events.length > 0);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/mail/threads and /api/mail/thread', () => {
  test('lists cached threads newest first and reads one thread', async () => {
    const { app, db, lockManager } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      lockManager.unlock(profile.id, 10);
      await post(app, '/api/google/gmail/save', { profileId: profile.id, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' });

      db.run(
        `INSERT INTO threads (profile_id, gm_thrid, subject, participants, message_count, unread_count, last_date_utc, last_snippet)
         VALUES (?, 'thr-old', 'Old thread', '["a@example.com"]', 1, 0, '2026-01-01T00:00:00.000Z', 'old')`,
        [profile.id],
      );
      db.run(
        `INSERT INTO threads (profile_id, gm_thrid, subject, participants, message_count, unread_count, last_date_utc, last_snippet)
         VALUES (?, 'thr-new', 'New thread', '["b@example.com"]', 2, 1, '2026-06-01T00:00:00.000Z', 'new')`,
        [profile.id],
      );
      db.run(
        `INSERT INTO messages (profile_id, gm_msgid, gm_thrid, subject, from_addr, date_utc) VALUES (?, 'm1', 'thr-new', 'New thread', 'b@example.com', '2026-06-01T00:00:00.000Z')`,
        [profile.id],
      );

      const threads = await get(app, `/api/mail/threads?profileId=${profile.id}`);
      assert.equal(threads.status, 200);
      assert.equal(threads.body.threads.length, 2);
      assert.equal(threads.body.threads[0].gm_thrid, 'thr-new', 'newest first');
      assert.deepEqual(threads.body.threads[0].participants, ['b@example.com']);

      const thread = await get(app, `/api/mail/thread?profileId=${profile.id}&id=thr-new`);
      assert.equal(thread.status, 200);
      assert.equal(thread.body.messages.length, 1);
      assert.equal(thread.body.messages[0].gm_msgid, 'm1');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

describe('contacts', () => {
  test('add, list and remove a contact', async () => {
    const { app, db } = await setup();
    try {
      const profile = createProfile(db, { name: 'Kid', kind: 'child' });

      const added = await post(app, '/api/contacts', { profileId: profile.id, name: 'Grandma', address: 'Grandma@Example.com' });
      assert.equal(added.body.ok, true);
      assert.equal(added.body.contact.address, 'grandma@example.com');

      const listed = await get(app, `/api/contacts?profileId=${profile.id}`);
      assert.equal(listed.body.contacts.length, 1);

      const badAdd = await post(app, '/api/contacts', { profileId: profile.id, name: 'Bad', address: 'not-an-email' });
      assert.equal(badAdd.status, 400);

      const removed = await post(app, '/api/contacts/remove', { profileId: profile.id, address: 'grandma@example.com' });
      assert.equal(removed.body.ok, true);
      const afterRemove = await get(app, `/api/contacts?profileId=${profile.id}`);
      assert.equal(afterRemove.body.contacts.length, 0);
    } finally {
      await app.close();
    }
  });

  test('contacts are reachable even while the profile is locked', async () => {
    const { app, db, lockManager } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      lockManager.unlock(profile.id, 10);
      await post(app, '/api/google/gmail/save', { profileId: profile.id, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' });
      lockManager.lock(profile.id);

      const res = await get(app, `/api/contacts?profileId=${profile.id}`);
      assert.equal(res.status, 200);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The 423 locked path
// ---------------------------------------------------------------------------

describe('423 locked', () => {
  test('every google-touching route 423s once connected and locked', async () => {
    const { app, db, lockManager } = await setup();
    try {
      const profile = makeAdultWithPin(db);
      lockManager.unlock(profile.id, 10);
      await post(app, '/api/google/gmail/save', { profileId: profile.id, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' });
      lockManager.lock(profile.id);

      const statusRes = await get(app, `/api/google/status?profileId=${profile.id}`);
      assert.equal(statusRes.status, 423);

      const verifyRes = await post(app, '/api/google/gmail/verify', { profileId: profile.id, address: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' });
      assert.equal(verifyRes.status, 423);

      const syncRes = await post(app, '/api/google/sync', { profileId: profile.id, what: 'gmail' });
      assert.equal(syncRes.status, 423);

      const eventsRes = await get(app, `/api/calendar/events?profileId=${profile.id}&from=2026-09-01T00:00:00.000Z&to=2026-09-02T00:00:00.000Z`);
      assert.equal(eventsRes.status, 423);

      const threadsRes = await get(app, `/api/mail/threads?profileId=${profile.id}`);
      assert.equal(threadsRes.status, 423);
    } finally {
      await app.close();
    }
  });
});
