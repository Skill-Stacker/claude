// Unit tests for app/lib/google/gmail.js. No real network: FakeImapFlow and
// a fake nodemailer transport stand in for the real thing, driven by the
// fixtures in tests/fixtures/mail/. An integration test at the bottom talks
// to real Gmail and is skipped unless STICKOS_GMAIL_USER and
// STICKOS_GMAIL_APP_PASSWORD are set in the environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../app/lib/db.js';
import {
  GmailError,
  classifyError,
  withImap,
  makeImapClient,
  discoverFolders,
  verifyCredentials,
  syncMailbox,
  searchRaw,
  unreadFrom,
  recentFrom,
  keywordScan,
  threadMessages,
  messageById,
  createReplyDraft,
  sendDraft,
  confirmSent,
  capBackoff,
} from '../app/lib/google/gmail.js';
import {
  NOW_UTC,
  THREAD_GRANDMA,
  THREAD_SCHOOL,
  THREAD_SOLO,
  allMessages,
  toFetchMessage,
  partsMapFor,
} from './fixtures/mail/messages.js';

// ---------------------------------------------------------------------------
// FakeImapFlow: implements only what gmail.js actually calls.
// ---------------------------------------------------------------------------

// Gmail's real folder names are localized; these are deliberately not the
// English names, so a test that matched by name instead of specialUse would
// fail to find them.
const LOCALIZED_FOLDERS = [
  { path: 'INBOX', flags: new Set(['\\Inbox']) },
  { path: '[Gmail]/Todos', specialUse: '\\All', flags: new Set(['\\All']) },
  { path: '[Gmail]/Enviados', specialUse: '\\Sent', flags: new Set(['\\Sent']) },
  { path: '[Gmail]/Borradores', specialUse: '\\Drafts', flags: new Set(['\\Drafts']) },
  { path: '[Gmail]/Papelera', specialUse: '\\Trash', flags: new Set(['\\Trash']) },
  { path: '[Gmail]/Destacados', flags: new Set(['\\Flagged']) },
];

const FOLDERS = {
  all: '[Gmail]/Todos',
  sent: '[Gmail]/Enviados',
  drafts: '[Gmail]/Borradores',
  trash: '[Gmail]/Papelera',
  inbox: 'INBOX',
};

function defaultState(overrides = {}) {
  return {
    connectMode: null,
    listMode: null,
    searchMode: null,
    fetchMode: null,
    downloadMode: null,
    appendMode: null,
    mailboxList: LOCALIZED_FOLDERS,
    mailboxesByFolder: { INBOX: allMessages.map((m) => ({ ...m })) },
    gmrawResults: {},
    appended: [],
    nextAppendUid: 9001,
    instances: [],
    ...overrides,
  };
}

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

function asyncIterableFromString(text) {
  const buf = Buffer.from(text || '', 'utf8');
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: buf };
        },
      };
    },
  };
}

function extractHeader(mimeText, name) {
  const headerBlock = mimeText.split(/\r?\n\r?\n/)[0];
  const line = headerBlock.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(line.indexOf(':') + 1).trim() : undefined;
}

function makeFakeImapFlowClass(state) {
  return class FakeImapFlow {
    constructor(options) {
      this.options = options;
      this._selected = null;
      this._connected = false;
      this._closed = false;
      state.instances.push(this);
    }

    async connect() {
      if (state.connectMode) {
        if (state.connectMode === 'hang') {
          await new Promise(() => {});
          return;
        }
        throwFakeError(state.connectMode);
      }
      this._connected = true;
    }

    async logout() {
      this._connected = false;
    }

    close() {
      this._connected = false;
      this._closed = true;
    }

    async list() {
      if (state.listMode) throwFakeError(state.listMode);
      return state.mailboxList;
    }

    async getMailboxLock(path) {
      this._selected = path;
      return { path, release: () => {} };
    }

    async search(query) {
      if (state.searchMode) throwFakeError(state.searchMode);
      const records = state.mailboxesByFolder[this._selected] || [];
      if (query.since) {
        const since = query.since instanceof Date ? query.since.getTime() : new Date(query.since).getTime();
        return records
          .filter((r) => new Date(r.date).getTime() >= since)
          .map((r) => r.uid)
          .sort((a, b) => a - b);
      }
      if (query.gmraw) {
        return state.gmrawResults[query.gmraw] || [];
      }
      if (query.header && query.header['message-id']) {
        const wanted = query.header['message-id'];
        return records.filter((r) => r.messageId === wanted).map((r) => r.uid);
      }
      return [];
    }

    fetch(range) {
      const records = state.mailboxesByFolder[this._selected] || [];
      let matched;
      if (Array.isArray(range)) {
        const wanted = new Set(range);
        matched = records.filter((r) => wanted.has(r.uid));
      } else {
        const start = Number(String(range).split(':')[0]);
        matched = records.filter((r) => r.uid >= start);
      }
      matched = matched.slice().sort((a, b) => a.uid - b.uid);
      const mode = state.fetchMode;

      async function* generator() {
        if (mode) throwFakeError(mode);
        for (const record of matched) {
          await Promise.resolve();
          yield toFetchMessage(record);
        }
      }
      return generator();
    }

    async download(uid, part) {
      if (state.downloadMode) throwFakeError(state.downloadMode);
      const records = state.mailboxesByFolder[this._selected] || [];
      const record = records.find((r) => r.uid === uid);
      const content = (record && partsMapFor(record)[part]) || '';
      return { meta: { charset: 'utf-8', contentType: 'text/plain' }, content: asyncIterableFromString(content) };
    }

    async append(path, content, flags) {
      if (state.appendMode) throwFakeError(state.appendMode);
      const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
      const uid = state.nextAppendUid++;
      state.appended.push({ path, text, flags });
      state.mailboxesByFolder[path] = state.mailboxesByFolder[path] || [];
      state.mailboxesByFolder[path].push({ uid, date: new Date().toISOString(), messageId: extractHeader(text, 'Message-ID') });
      return { destination: path, uid };
    }
  };
}

function makeFakeTransport(mode = 'ok') {
  const closes = [];
  return {
    async verify() {
      if (mode === 'reject') {
        const err = new Error('Invalid login: 535-5.7.8 Username and Password not accepted');
        err.code = 'EAUTH';
        throw err;
      }
      if (mode === 'hang') {
        await new Promise(() => {});
        return true;
      }
      return true;
    },
    async sendMail(data) {
      if (mode === 'reject') {
        const err = new Error('550 5.1.1 The email account that you tried to reach does not exist');
        err.responseCode = 550;
        throw err;
      }
      if (mode === 'hang') {
        await new Promise(() => {});
        return undefined;
      }
      return { accepted: [data.to], rejected: [], response: '250 2.0.0 OK', messageId: data.messageId };
    },
    close() {
      closes.push(Date.now());
    },
    closeCalls: closes,
  };
}

// Generates a synthetic, well-ordered message: higher uid = more recent, so
// slicing "the newest N" is easy to reason about in the pagination tests.
function makeSyntheticMessage(uid, { daysOld = 5, textLength } = {}) {
  return {
    uid,
    threadId: `thr-synth-${uid}`,
    emailId: `em-synth-${uid}`,
    messageId: `<synth-${uid}@example.com>`,
    subject: `Synthetic message ${uid}`,
    from: { name: 'Synth Sender', address: 'synth@example.com' },
    to: [{ address: 'me@gmail.com' }],
    date: new Date(new Date(NOW_UTC).getTime() - daysOld * 86400000 + uid * 1000).toISOString(),
    seen: uid % 2 === 0,
    flagged: false,
    labels: [],
    text: textLength ? 'A'.repeat(textLength) : `Body text for synthetic message number ${uid}.`,
    size: 256,
  };
}

const CREDS = { email: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' };

async function syncedFixtureDb(opts = {}) {
  const db = openDb(':memory:');
  const state = defaultState();
  const FakeClass = makeFakeImapFlowClass(state);
  const client = new FakeClass({});
  await client.connect();
  const result = await syncMailbox({
    db,
    profileId: 1,
    client,
    folder: 'INBOX',
    nowUtc: NOW_UTC,
    firstRun: opts.firstRun || { days: 30, max: 50 },
    pageSize: opts.pageSize || 50,
    bodyDays: opts.bodyDays ?? 14,
    bodyCap: opts.bodyCap ?? 4000,
    onProgress: opts.onProgress,
  });
  await client.logout();
  return { db, state, client, result };
}

// ---------------------------------------------------------------------------
// discoverFolders
// ---------------------------------------------------------------------------

test('discoverFolders resolves special-use folders despite Gmail localizing their names', async () => {
  const state = defaultState();
  const FakeClass = makeFakeImapFlowClass(state);
  const client = new FakeClass({});
  await client.connect();
  const folders = await discoverFolders(client);
  assert.deepEqual(folders, FOLDERS);
});

test('discoverFolders throws GmailError kind folders naming what is missing', async () => {
  const state = defaultState({ mailboxList: LOCALIZED_FOLDERS.filter((m) => m.specialUse !== '\\Trash') });
  const FakeClass = makeFakeImapFlowClass(state);
  const client = new FakeClass({});
  await client.connect();
  await assert.rejects(
    () => discoverFolders(client),
    (err) => {
      assert.ok(err instanceof GmailError);
      assert.equal(err.kind, 'folders');
      assert.match(err.message, /Trash/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// syncMailbox: first run cap and paging
// ---------------------------------------------------------------------------

test('syncMailbox first run caps to the newest firstRun.max messages and pages by pageSize', async () => {
  const db = openDb(':memory:');
  const synthetic = [];
  for (let uid = 1; uid <= 12; uid++) synthetic.push(makeSyntheticMessage(uid, { daysOld: 5 }));
  const state = defaultState({ mailboxesByFolder: { INBOX: synthetic } });
  const FakeClass = makeFakeImapFlowClass(state);
  const client = new FakeClass({});
  await client.connect();

  const progressCalls = [];
  const result = await syncMailbox({
    db,
    profileId: 1,
    client,
    folder: 'INBOX',
    nowUtc: NOW_UTC,
    firstRun: { days: 30, max: 5 },
    pageSize: 2,
    onProgress: (p) => progressCalls.push({ ...p }),
  });

  assert.equal(result.total, 5);
  assert.equal(result.done, 5);
  assert.deepEqual(
    progressCalls.map((p) => p.done),
    [2, 4, 5]
  );
  assert.ok(progressCalls.every((p) => p.total === 5));

  const rows = db.all('SELECT gm_msgid, uid FROM messages WHERE profile_id = ? ORDER BY uid', [1]);
  assert.deepEqual(
    rows.map((r) => r.uid),
    [8, 9, 10, 11, 12]
  );

  assert.equal(db.getState('gmail:INBOX:lastUid'), 12);
  assert.equal(db.getState('gmail:INBOX:backfillComplete'), true);
  assert.ok(db.getState('gmail:lastChecked'));
});

// ---------------------------------------------------------------------------
// syncMailbox: delta fetch
// ---------------------------------------------------------------------------

test('syncMailbox delta fetch only pulls uids above lastUid on the second sync', async () => {
  const db = openDb(':memory:');
  const synthetic = [];
  for (let uid = 1; uid <= 5; uid++) synthetic.push(makeSyntheticMessage(uid, { daysOld: 5 }));
  const state = defaultState({ mailboxesByFolder: { INBOX: synthetic } });
  const FakeClass = makeFakeImapFlowClass(state);

  const client1 = new FakeClass({});
  await client1.connect();
  await syncMailbox({ db, profileId: 1, client: client1, folder: 'INBOX', nowUtc: NOW_UTC, firstRun: { days: 30, max: 50 }, pageSize: 50 });
  await client1.logout();

  assert.equal(db.getState('gmail:INBOX:lastUid'), 5);
  assert.equal(db.all('SELECT * FROM messages WHERE profile_id = ?', [1]).length, 5);

  // New mail arrives server-side between polls.
  state.mailboxesByFolder.INBOX.push(makeSyntheticMessage(6, { daysOld: 1 }));
  state.mailboxesByFolder.INBOX.push(makeSyntheticMessage(7, { daysOld: 1 }));

  const client2 = new FakeClass({});
  await client2.connect();
  const result = await syncMailbox({ db, profileId: 1, client: client2, folder: 'INBOX', nowUtc: NOW_UTC, firstRun: { days: 30, max: 50 }, pageSize: 50 });
  await client2.logout();

  assert.equal(result.done, 2);
  assert.equal(result.total, null, 'delta run does not know a total ahead of time');

  const rows = db.all('SELECT uid FROM messages WHERE profile_id = ? ORDER BY uid', [1]);
  assert.deepEqual(
    rows.map((r) => r.uid),
    [1, 2, 3, 4, 5, 6, 7]
  );
  assert.equal(db.getState('gmail:INBOX:lastUid'), 7);
});

// ---------------------------------------------------------------------------
// syncMailbox: body cap and bodyDays window
// ---------------------------------------------------------------------------

test('syncMailbox caps body_text to bodyCap and skips bodies outside bodyDays', async () => {
  const db = openDb(':memory:');
  const withinWindow = makeSyntheticMessage(1, { daysOld: 5, textLength: 5000 });
  const outsideWindow = makeSyntheticMessage(2, { daysOld: 20, textLength: 500 });
  const state = defaultState({ mailboxesByFolder: { INBOX: [withinWindow, outsideWindow] } });
  const FakeClass = makeFakeImapFlowClass(state);
  const client = new FakeClass({});
  await client.connect();

  await syncMailbox({
    db,
    profileId: 1,
    client,
    folder: 'INBOX',
    nowUtc: NOW_UTC,
    firstRun: { days: 30, max: 50 },
    pageSize: 50,
    bodyDays: 14,
    bodyCap: 1000,
  });

  const within = db.get('SELECT body_text FROM messages WHERE profile_id = ? AND uid = ?', [1, 1]);
  const outside = db.get('SELECT body_text FROM messages WHERE profile_id = ? AND uid = ?', [1, 2]);

  assert.equal(within.body_text.length, 1000);
  assert.ok(withinWindow.text.startsWith(within.body_text));
  assert.equal(outside.body_text, '');
});

// ---------------------------------------------------------------------------
// syncMailbox: thread rollups
// ---------------------------------------------------------------------------

test('syncMailbox builds thread rollups: count, unread_count, last_date, last_snippet, participants', async () => {
  const { db } = await syncedFixtureDb();

  const grandma = db.get('SELECT * FROM threads WHERE profile_id = ? AND gm_thrid = ?', [1, THREAD_GRANDMA]);
  assert.equal(grandma.message_count, 2);
  assert.equal(grandma.unread_count, 1);
  assert.ok(grandma.last_snippet.includes('potato salad'));
  const grandmaParticipants = JSON.parse(grandma.participants);
  assert.ok(grandmaParticipants.includes('grandma@example.com'));
  assert.ok(grandmaParticipants.includes('me@gmail.com'));

  const school = db.get('SELECT * FROM threads WHERE profile_id = ? AND gm_thrid = ?', [1, THREAD_SCHOOL]);
  assert.equal(school.message_count, 3);
  assert.equal(school.unread_count, 1);
  assert.ok(school.last_snippet.includes('sign-up sheet closes Thursday'));

  const solo = db.get('SELECT * FROM threads WHERE profile_id = ? AND gm_thrid = ?', [1, THREAD_SOLO]);
  assert.equal(solo.message_count, 1);
  assert.equal(solo.unread_count, 1);
});

test('syncMailbox converts the HTML-only message to readable plain text and snippet', async () => {
  const { db } = await syncedFixtureDb();
  const row = db.get('SELECT * FROM messages WHERE profile_id = ? AND gm_msgid = ?', [1, 'em-101']);
  assert.ok(row.body_text.includes("Grandma’s Birthday") || row.body_text.includes('Hi Alex'));
  assert.ok(!row.body_text.includes('<'));
  assert.ok(row.snippet.length <= 203);
});

// ---------------------------------------------------------------------------
// Cache queries
// ---------------------------------------------------------------------------

test('unreadFrom returns only unread cached messages from a matching address', async () => {
  const { db } = await syncedFixtureDb();
  const rows = unreadFrom(db, 1, 'grandma@example.com');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gm_msgid, 'em-102');
  assert.equal(rows[0].is_unread, true);
});

test('recentFrom returns cached messages from a pattern since a given time', async () => {
  const { db } = await syncedFixtureDb();
  const rows = recentFrom(db, 1, '%@lincoln.edu', new Date(new Date(NOW_UTC).getTime() - 9 * 86400000).toISOString());
  assert.equal(rows.length, 2, 'only the two most recent school messages fall after the cutoff');
  assert.ok(rows.every((r) => r.from_addr === 'front.office@lincoln.edu'));
});

test('keywordScan matches subject and body text since a given time', async () => {
  const { db } = await syncedFixtureDb();
  const rows = keywordScan(db, 1, 'conference', '2000-01-01T00:00:00.000Z');
  const ids = rows.map((r) => r.gm_msgid).sort();
  assert.deepEqual(ids, ['em-201', 'em-202', 'em-203'], 'all three school messages mention conference(s)');
});

test('threadMessages returns a thread oldest to newest, capped by last', async () => {
  const { db } = await syncedFixtureDb();
  const rows = threadMessages(db, 1, THREAD_SCHOOL, { last: 2 });
  assert.equal(rows.length, 2);
  assert.ok(new Date(rows[0].date_utc) <= new Date(rows[1].date_utc));
  assert.equal(rows[1].gm_msgid, 'em-203', 'the most recent of the last two is the newest message overall');
});

test('messageById finds a cached message by its Gmail message id', async () => {
  const { db } = await syncedFixtureDb();
  const row = messageById(db, 1, 'em-201');
  assert.equal(row.subject, 'Early pickup Friday');
  const missing = messageById(db, 1, 'does-not-exist');
  assert.equal(missing, null);
});

// ---------------------------------------------------------------------------
// searchRaw
// ---------------------------------------------------------------------------

test('searchRaw runs a Gmail raw search against the given folder', async () => {
  const state = defaultState({ gmrawResults: { 'from:grandma is:unread': [102] } });
  const FakeClass = makeFakeImapFlowClass(state);
  const client = new FakeClass({});
  await client.connect();
  const uids = await searchRaw(client, 'INBOX', 'from:grandma is:unread');
  assert.deepEqual(uids, [102]);
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

test('createReplyDraft appends to the Drafts folder with the parent address as To', async () => {
  const { db, state, client } = await syncedFixtureDb();
  const parent = messageById(db, 1, 'em-102');

  const draft = await createReplyDraft({
    db,
    profileId: 1,
    client,
    folders: FOLDERS,
    from: 'me@gmail.com',
    parent,
    body: 'Sounds wonderful, see you Saturday!',
  });

  assert.equal(state.appended.length, 1);
  const appended = state.appended[0];
  assert.equal(appended.path, FOLDERS.drafts);
  assert.deepEqual(appended.flags, ['\\Draft']);
  assert.equal(extractHeader(appended.text, 'To'), 'grandma@example.com');
  assert.equal(extractHeader(appended.text, 'Subject'), "Re: Grandma's Birthday");

  const references = extractHeader(appended.text, 'References');
  assert.ok(references.includes('m101@mail.gmail.com'));
  assert.ok(references.includes('m102@mail.gmail.com'));
  assert.equal(extractHeader(appended.text, 'In-Reply-To'), '<m102@mail.gmail.com>');

  assert.equal(draft.state, 'draft');
  assert.equal(draft.to_addr, 'grandma@example.com');
  assert.equal(draft.in_reply_to, '<m102@mail.gmail.com>');
  assert.equal(extractHeader(appended.text, 'Message-ID'), draft.message_id);
});

test('createReplyDraft rejects with GmailError when the Drafts folder is unknown', async () => {
  const { db, client } = await syncedFixtureDb();
  const parent = messageById(db, 1, 'em-102');
  await assert.rejects(
    () => createReplyDraft({ db, profileId: 1, client, folders: {}, from: 'me@gmail.com', parent, body: 'hi' }),
    (err) => {
      assert.ok(err instanceof GmailError);
      assert.equal(err.kind, 'folders');
      return true;
    }
  );
});

function insertDraft(db, overrides = {}) {
  const nowUtc = new Date().toISOString();
  const row = {
    profile_id: 1,
    gm_thrid: THREAD_GRANDMA,
    to_addr: 'grandma@example.com',
    to_name: 'Grandma',
    subject: "Re: Grandma's Birthday",
    body: 'Sounds wonderful, see you Saturday!',
    in_reply_to: '<m102@mail.gmail.com>',
    message_id: '<draft-1@stickos.local>',
    state: 'draft',
    created_utc: nowUtc,
    updated_utc: nowUtc,
    ...overrides,
  };
  const result = db.run(
    `INSERT INTO drafts (profile_id, gm_thrid, to_addr, to_name, subject, body, in_reply_to, message_id, state, created_utc, updated_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.profile_id, row.gm_thrid, row.to_addr, row.to_name, row.subject, row.body, row.in_reply_to, row.message_id, row.state, row.created_utc, row.updated_utc]
  );
  return db.get('SELECT * FROM drafts WHERE id = ?', [result.lastInsertRowid]);
}

test('sendDraft transitions to sent with the accepted list on success', async () => {
  const db = openDb(':memory:');
  const draft = insertDraft(db);
  const result = await sendDraft({ db, draft, creds: CREDS, transportFactory: () => makeFakeTransport('ok') });
  assert.deepEqual(result.accepted, ['grandma@example.com']);
  assert.equal(result.state, 'sent');
  const stored = db.get('SELECT state FROM drafts WHERE id = ?', [draft.id]);
  assert.equal(stored.state, 'sent');
});

test('sendDraft transitions to failed on rejection, with no accepted list', async () => {
  const db = openDb(':memory:');
  const draft = insertDraft(db);
  await assert.rejects(
    () => sendDraft({ db, draft, creds: CREDS, transportFactory: () => makeFakeTransport('reject') }),
    (err) => {
      assert.ok(err instanceof GmailError);
      return true;
    }
  );
  const stored = db.get('SELECT state FROM drafts WHERE id = ?', [draft.id]);
  assert.equal(stored.state, 'failed');
});

test('sendDraft transitions to unknown on timeout, and does not retry automatically', async () => {
  const db = openDb(':memory:');
  const draft = insertDraft(db);
  const transport = makeFakeTransport('hang');
  await assert.rejects(
    () => sendDraft({ db, draft, creds: CREDS, transportFactory: () => transport, timeoutMs: 30 }),
    (err) => {
      assert.ok(err instanceof GmailError);
      assert.equal(err.kind, 'timeout');
      return true;
    }
  );
  const stored = db.get('SELECT state FROM drafts WHERE id = ?', [draft.id]);
  assert.equal(stored.state, 'unknown');
  assert.ok(transport.closeCalls.length >= 1, 'the hard timeout closed the stuck transport');
});

// ---------------------------------------------------------------------------
// confirmSent
// ---------------------------------------------------------------------------

test('confirmSent finds a message that landed in Sent by Message-ID', async () => {
  const state = defaultState({
    mailboxesByFolder: {
      INBOX: [],
      [FOLDERS.sent]: [{ uid: 555, date: NOW_UTC, messageId: '<draft-1@stickos.local>' }],
    },
  });
  const FakeClass = makeFakeImapFlowClass(state);
  const client = new FakeClass({});
  await client.connect();
  const result = await confirmSent({ client, folders: FOLDERS, messageId: '<draft-1@stickos.local>' });
  assert.deepEqual(result, { found: true, uid: 555 });
});

test('confirmSent reports not found when nothing matches', async () => {
  const state = defaultState({ mailboxesByFolder: { INBOX: [], [FOLDERS.sent]: [] } });
  const FakeClass = makeFakeImapFlowClass(state);
  const client = new FakeClass({});
  await client.connect();
  const result = await confirmSent({ client, folders: FOLDERS, messageId: '<never-sent@stickos.local>' });
  assert.deepEqual(result, { found: false, uid: null });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test('classifyError recognizes AUTHENTICATIONFAILED as kind auth', () => {
  const err = new Error('[AUTHENTICATIONFAILED] Invalid credentials (Failure)');
  err.authenticationFailed = true;
  const classified = classifyError(err);
  assert.equal(classified.kind, 'auth');
  assert.ok(classified.userMessage.includes('app password'));
});

test('classifyError recognizes "Application-specific password required" as kind auth', () => {
  const err = new Error('Application-specific password required');
  assert.equal(classifyError(err).kind, 'auth');
});

test('classifyError recognizes nodemailer EAUTH as kind auth', () => {
  const err = new Error('Invalid login');
  err.code = 'EAUTH';
  assert.equal(classifyError(err).kind, 'auth');
});

test('classifyError recognizes "Too many simultaneous connections" as kind connection_cap', () => {
  const err = new Error('[ALERT] Too many simultaneous connections. (Failure)');
  assert.equal(classifyError(err).kind, 'connection_cap');
});

test('classifyError recognizes ENOTFOUND, ECONNRESET and ETIMEDOUT as kind network', () => {
  for (const code of ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT']) {
    const err = new Error(`boom ${code}`);
    err.code = code;
    assert.equal(classifyError(err).kind, 'network', code);
  }
});

test('classifyError falls back to kind unknown for anything unrecognized', () => {
  const err = new Error('the server said something new');
  assert.equal(classifyError(err).kind, 'unknown');
});

test('classifyError passes an existing GmailError through unchanged', () => {
  const original = new GmailError('folders', 'missing Trash');
  assert.equal(classifyError(original), original);
});

test('withImap never classifies its own hard timeout as kind network: it is always kind timeout', async () => {
  const state = defaultState({ connectMode: 'hang' });
  const FakeClass = makeFakeImapFlowClass(state);
  await assert.rejects(
    () => withImap(CREDS, async () => 'unreachable', { ImapFlowClass: FakeClass, timeoutMs: 30 }),
    (err) => {
      assert.ok(err instanceof GmailError);
      assert.equal(err.kind, 'timeout');
      return true;
    }
  );
  assert.equal(state.instances.length, 1);
  assert.equal(state.instances[0]._closed, true, 'the hard timeout destroyed the socket');
});

test('withImap classifies a raw error thrown from fn(client) and still logs out', async () => {
  const state = defaultState();
  const FakeClass = makeFakeImapFlowClass(state);
  let loggedOut = false;
  class TrackingFakeImapFlow extends FakeClass {
    async logout() {
      loggedOut = true;
      return super.logout();
    }
  }
  await assert.rejects(
    () =>
      withImap(
        CREDS,
        async () => {
          const err = new Error('getaddrinfo ENOTFOUND imap.gmail.com');
          err.code = 'ENOTFOUND';
          throw err;
        },
        { ImapFlowClass: TrackingFakeImapFlow }
      ),
    (err) => {
      assert.ok(err instanceof GmailError);
      assert.equal(err.kind, 'network');
      return true;
    }
  );
  assert.equal(loggedOut, true);
});

// ---------------------------------------------------------------------------
// verifyCredentials
// ---------------------------------------------------------------------------

test('verifyCredentials succeeds when both IMAP login and SMTP verify succeed', async () => {
  const state = defaultState();
  const FakeClass = makeFakeImapFlowClass(state);
  const result = await verifyCredentials(CREDS, { ImapFlowClass: FakeClass, transportFactory: () => makeFakeTransport('ok') });
  assert.deepEqual(result, { ok: true, folders: FOLDERS });
});

test('verifyCredentials classifies an SMTP auth rejection', async () => {
  const state = defaultState();
  const FakeClass = makeFakeImapFlowClass(state);
  await assert.rejects(
    () => verifyCredentials(CREDS, { ImapFlowClass: FakeClass, transportFactory: () => makeFakeTransport('reject') }),
    (err) => {
      assert.ok(err instanceof GmailError);
      assert.equal(err.kind, 'auth');
      return true;
    }
  );
});

test('verifyCredentials classifies an IMAP auth failure without ever reaching SMTP', async () => {
  const state = defaultState({ connectMode: 'auth' });
  const FakeClass = makeFakeImapFlowClass(state);
  let smtpAttempted = false;
  await assert.rejects(
    () =>
      verifyCredentials(CREDS, {
        ImapFlowClass: FakeClass,
        transportFactory: () => {
          smtpAttempted = true;
          return makeFakeTransport('ok');
        },
      }),
    (err) => {
      assert.ok(err instanceof GmailError);
      assert.equal(err.kind, 'auth');
      return true;
    }
  );
  assert.equal(smtpAttempted, false);
});

// ---------------------------------------------------------------------------
// makeImapClient
// ---------------------------------------------------------------------------

test('makeImapClient wires host, port and strips spaces from the app password', () => {
  const state = defaultState();
  const FakeClass = makeFakeImapFlowClass(state);
  const client = makeImapClient({ email: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' }, { ImapFlowClass: FakeClass });
  assert.equal(client.options.host, 'imap.gmail.com');
  assert.equal(client.options.port, 993);
  assert.equal(client.options.secure, true);
  assert.equal(client.options.auth.user, 'me@gmail.com');
  assert.equal(client.options.auth.pass, 'abcdefghijklmnop');
});

// ---------------------------------------------------------------------------
// Connection-cap backoff
// ---------------------------------------------------------------------------

test('capBackoff hits its ceiling at 5 attempts inside a 10 minute window', () => {
  const db = openDb(':memory:');
  const backoff = capBackoff(db);
  const base = new Date('2026-09-02T12:00:00.000Z').getTime();

  let last;
  for (let i = 0; i < 4; i++) {
    last = backoff.recordAttempt(new Date(base + i * 60000).toISOString());
    assert.equal(last.atCeiling, false);
    assert.equal(last.userMessage, null);
  }

  last = backoff.recordAttempt(new Date(base + 4 * 60000).toISOString());
  assert.equal(last.attempts, 5);
  assert.equal(last.atCeiling, true);
  assert.ok(last.userMessage.includes('too many things are connected'));

  assert.equal(backoff.shouldWait(new Date(base + 5 * 60000).toISOString()), true);
  assert.equal(backoff.shouldWait(new Date(base + 11 * 60000).toISOString()), true, 'still inside the 10 minute wait that started at the ceiling');
  assert.equal(backoff.shouldWait(new Date(base + 15 * 60000).toISOString()), false, 'the wait window has elapsed');
});

test('capBackoff resets the attempt count once the 10 minute window has passed', () => {
  const db = openDb(':memory:');
  const backoff = capBackoff(db);
  const base = new Date('2026-09-02T12:00:00.000Z').getTime();

  for (let i = 0; i < 5; i++) backoff.recordAttempt(new Date(base + i * 60000).toISOString());
  assert.equal(backoff.state().attempts, 5);

  const later = backoff.recordAttempt(new Date(base + 20 * 60000).toISOString());
  assert.equal(later.attempts, 1);
  assert.equal(later.atCeiling, false);
});

test('capBackoff reset clears attempts and the wait window', () => {
  const db = openDb(':memory:');
  const backoff = capBackoff(db);
  for (let i = 0; i < 5; i++) backoff.recordAttempt(new Date(Date.now() + i * 60000).toISOString());
  backoff.reset();
  const s = backoff.state();
  assert.equal(s.attempts, 0);
  assert.equal(s.untilUtc, null);
  assert.equal(backoff.shouldWait(), false);
});

// ---------------------------------------------------------------------------
// Integration: real Gmail, opt-in only
// ---------------------------------------------------------------------------

const hasRealCreds = Boolean(process.env.STICKOS_GMAIL_USER && process.env.STICKOS_GMAIL_APP_PASSWORD);

test('integration: verifyCredentials against real Gmail', { skip: !hasRealCreds }, async () => {
  const creds = { email: process.env.STICKOS_GMAIL_USER, appPassword: process.env.STICKOS_GMAIL_APP_PASSWORD };
  const result = await verifyCredentials(creds);
  assert.equal(result.ok, true);
  assert.ok(result.folders.all);
  assert.ok(result.folders.sent);
  assert.ok(result.folders.drafts);
  assert.ok(result.folders.trash);
});
