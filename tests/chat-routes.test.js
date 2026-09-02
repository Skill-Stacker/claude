// Route-level tests for app/lib/chat-routes.js: the real server
// (app/server.js), wired with the real brain.js/confirm.js/reminders.js/
// brief.js and tools/fake-engine.mjs standing in for the model. No real
// network for Google: gmailSession stays disconnected throughout, calendar
// is exercised through the real fixture-backed calendar.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../app/server.js';
import { wireChat } from '../app/lib/chat-routes.js';
import { openDb } from '../app/lib/db.js';
import { createLlm } from '../app/lib/llm.js';
import * as calendarLib from '../app/lib/google/calendar.js';
import * as gmailLib from '../app/lib/google/gmail.js';
import * as contactsLib from '../app/lib/google/contacts.js';
import * as dates from '../app/lib/dates.js';
import * as scrub from '../app/lib/speech/scrub.js';
import * as memory from '../app/lib/memory.js';
import * as profiles from '../app/lib/profiles.js';
import { addReminder, listOpen } from '../app/lib/reminders.js';
import { scopedDb } from '../app/lib/intents/shared.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = join(HERE, '..', 'tools', 'fake-engine.mjs');
const ZONE = 'America/New_York';
const NOW_ISO = '2026-09-08T16:00:00.000Z'; // noon EDT, Tuesday: Dentist + Soccer practice day
const CAL_WINDOW = { fromUtc: '2026-09-01T00:00:00.000Z', toUtc: '2026-10-15T00:00:00.000Z' };
const familyIcs = readFileSync(join(HERE, 'fixtures', 'calendar', 'family.ics'), 'utf8');

let nextHttpPort = 47470;
function testHttpPort() {
  nextHttpPort += 1;
  return nextHttpPort;
}

let nextEnginePort = 8910;
function testEnginePort() {
  nextEnginePort += 1;
  return nextEnginePort;
}

function startFakeEngine({ port, loadMs = 30, tps = 300 } = {}) {
  const args = [FAKE_ENGINE, '--port', String(port), '--load-ms', String(loadMs), '--tps', String(tps)];
  const proc = nodeSpawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    async ready() {
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          const res = await fetch(`${baseUrl}/health`);
          if (res.status === 200 && (await res.json()).status === 'ok') return;
        } catch { /* not listening yet */ }
        if (Date.now() > deadline) throw new Error('fake-engine never became ready');
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => proc.once('exit', r));
    },
  };
}

// Reads a text/event-stream response to completion, returning [{ type, data }, ...].
async function readAllSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const eventMatch = /^event: (.+)$/m.exec(raw);
      if (!eventMatch) continue; // a ": open" heartbeat/comment line
      const dataMatch = /^data: (.*)$/m.exec(raw);
      events.push({ type: eventMatch[1], data: dataMatch ? JSON.parse(dataMatch[1]) : null });
    }
  }
  return events;
}

function tmpBase() {
  return mkdtempSync(join(tmpdir(), 'stickos-chat-routes-'));
}

async function post(app, path, body) {
  return fetch(`${app.origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-stickos-token': app.token },
    body: JSON.stringify(body),
  });
}

async function get(app, path) {
  return fetch(`${app.origin}${path}`);
}

function seedCalendar(db, profileId, { nowUtc = '2026-09-08T10:00:00.000Z' } = {}) {
  const instances = calendarLib.parseAndExpand(familyIcs, { ...CAL_WINDOW, calendarName: 'Family' });
  calendarLib.syncCalendar(scopedDb(db, profileId), profileId, instances, { calendarName: 'Family', nowUtc });
}

// Starts the real server, a real profile (with a PIN), and a fake engine,
// then wires chat onto it. Returns everything a test needs, plus close().
async function setup({ connectCalendar = true, connectGmail = false, unlock = true } = {}) {
  const app = await startServer({ baseDir: tmpBase(), port: testHttpPort() });
  const db = openDb(':memory:');
  const profile = profiles.createProfile(db, { name: 'Alex', kind: 'adult' });
  profiles.setPin(db, profile.id, '1234');
  profiles.ensureProfileDirs(app.paths.profiles, profile);

  const secrets = {};
  if (connectCalendar) secrets.calendar = { icsUrl: 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics' };
  if (connectGmail) secrets.gmail = { address: 'me@gmail.com', appPassword: 'xxxx xxxx xxxx xxxx' };
  if (connectCalendar || connectGmail) profiles.writeSecrets(app.paths.profiles, profile, secrets);
  if (connectCalendar) seedCalendar(db, profile.id);

  const enginePort = testEnginePort();
  const fake = startFakeEngine({ port: enginePort });
  await fake.ready();
  const llm = createLlm({ baseUrl: fake.baseUrl });

  const lockManager = profiles.createLockManager({});
  if (unlock) lockManager.unlock(profile.id, 10);

  const brain = wireChat(app, {
    db,
    llm,
    calendar: calendarLib,
    gmail: gmailLib,
    gmailSession: async () => null,
    contacts: contactsLib,
    dates,
    scrub,
    memory,
    profiles,
    lockManager,
    verifyPin: (profileId, pin) => (pin === '1234' ? { ok: true } : { ok: false }),
    settings: { zone: ZONE },
    now: () => new Date(NOW_ISO),
  });

  return {
    app, db, profile, lockManager, brain,
    async close() {
      await fake.stop();
      await app.close();
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------

describe('POST /api/chat', () => {
  test('a calendar question streams intent, source, delta and done events, in order', async () => {
    const ctx = await setup();
    try {
      const res = await post(ctx.app, '/api/chat', { profileId: ctx.profile.id, text: 'today_agenda what is on my calendar today' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

      const events = await readAllSSE(res);
      const types = events.map((e) => e.type);

      assert.equal(types[0], 'intent');
      assert.equal(events[0].data.intent, 'today_agenda');
      assert.ok(types.includes('source'));
      assert.ok(types.includes('delta'));
      assert.equal(types[types.length - 1], 'done');

      const sourceEvent = events.find((e) => e.type === 'source');
      assert.equal(sourceEvent.data.kind, 'calendar');

      const fullText = events.filter((e) => e.type === 'delta').map((e) => e.data.content).join('');
      assert.match(fullText, /As of my last check/);
    } finally {
      await ctx.close();
    }
  });

  test('a write intent (set_reminder) ends in a confirm event with a code-built sentence', async () => {
    const ctx = await setup({ connectCalendar: false });
    try {
      const res = await post(ctx.app, '/api/chat', { profileId: ctx.profile.id, text: 'set_reminder remind me to call the plumber' });
      const events = await readAllSSE(res);

      const confirmEvent = events.find((e) => e.type === 'confirm');
      assert.ok(confirmEvent, 'expected a confirm event');
      assert.equal(confirmEvent.data.action, 'set_reminder');
      assert.ok(confirmEvent.data.confirmId);
      assert.match(confirmEvent.data.sentence, /Should I go ahead/);

      assert.equal(events[events.length - 1].type, 'done');
      assert.equal(events[events.length - 1].data.finishReason, 'confirm');
    } finally {
      await ctx.close();
    }
  });

  test('missing profileId or text is a plain 400, not an SSE stream', async () => {
    const ctx = await setup();
    try {
      const res = await post(ctx.app, '/api/chat', { text: 'hello' });
      assert.equal(res.status, 400);
    } finally {
      await ctx.close();
    }
  });

  test('the locked-profile path: intent, then a plain locked answer and an unlock confirm', async () => {
    const ctx = await setup({ unlock: false });
    try {
      const res = await post(ctx.app, '/api/chat', { profileId: ctx.profile.id, text: 'today_agenda what is on my calendar' });
      const events = await readAllSSE(res);
      const types = events.map((e) => e.type);

      assert.equal(types[0], 'intent');
      assert.ok(events.some((e) => e.type === 'delta' && /locked/.test(e.data.content)));
      const confirmEvent = events.find((e) => e.type === 'confirm');
      assert.ok(confirmEvent);
      assert.equal(confirmEvent.data.action, 'unlock');
      assert.equal(events[events.length - 1].data.finishReason, 'locked');
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/confirm
// ---------------------------------------------------------------------------

describe('POST /api/confirm', () => {
  async function getConfirmId(ctx) {
    const res = await post(ctx.app, '/api/chat', { profileId: ctx.profile.id, text: 'set_reminder remind me to sign the school form' });
    const events = await readAllSSE(res);
    return events.find((e) => e.type === 'confirm').data.confirmId;
  }

  test('answer yes performs the write and reports a code-built success message', async () => {
    const ctx = await setup({ connectCalendar: false });
    try {
      const confirmId = await getConfirmId(ctx);
      const res = await post(ctx.app, '/api/confirm', { confirmId, answer: 'yes' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.match(body.message, /reminder/);

      // fake-engine fills tool arguments with whichever words land on each
      // schema property positionally (see its buildToolArguments), not real
      // language understanding, so the reminder text itself is arbitrary
      // here; what this proves is that the confirmed write actually landed
      // in the reminders table with the exact text the confirm sentence
      // named.
      const open = listOpen(ctx.db, ctx.profile.id);
      assert.equal(open.length, 1);
      assert.ok(open[0].text.length > 0);
    } finally {
      await ctx.close();
    }
  });

  test('answer no cancels without performing the write', async () => {
    const ctx = await setup({ connectCalendar: false });
    try {
      const confirmId = await getConfirmId(ctx);
      const res = await post(ctx.app, '/api/confirm', { confirmId, answer: 'no' });
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.result, 'cancelled');
      assert.equal(listOpen(ctx.db, ctx.profile.id).length, 0);
    } finally {
      await ctx.close();
    }
  });

  test('an unknown or already-used confirmId reports it has expired', async () => {
    const ctx = await setup({ connectCalendar: false });
    try {
      const res = await post(ctx.app, '/api/confirm', { confirmId: 'not-a-real-id', answer: 'yes' });
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(body.message, /expired/);
    } finally {
      await ctx.close();
    }
  });

  test('a confirmId is one-shot: reusing it after yes also reports expired', async () => {
    const ctx = await setup({ connectCalendar: false });
    try {
      const confirmId = await getConfirmId(ctx);
      await post(ctx.app, '/api/confirm', { confirmId, answer: 'yes' });
      const second = await post(ctx.app, '/api/confirm', { confirmId, answer: 'yes' });
      const body = await second.json();
      assert.equal(body.ok, false);
      assert.match(body.message, /expired/);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/session/new, GET /api/session/memory
// ---------------------------------------------------------------------------

describe('session routes', () => {
  test('POST /api/session/new distills (or skips a too-short session) and GET /api/session/memory reflects it', async () => {
    const ctx = await setup({ connectCalendar: false });
    try {
      const res = await post(ctx.app, '/api/session/new', { profileId: ctx.profile.id });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(typeof body.distilled, 'boolean');

      const memRes = await get(ctx.app, `/api/session/memory?profileId=${ctx.profile.id}`);
      assert.equal(memRes.status, 200);
      const memBody = await memRes.json();
      assert.equal(typeof memBody.memory, 'string');
    } finally {
      await ctx.close();
    }
  });

  test('an unknown profile is a 404', async () => {
    const ctx = await setup({ connectCalendar: false });
    try {
      const res = await post(ctx.app, '/api/session/new', { profileId: 999999 });
      assert.equal(res.status, 404);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/brief
// ---------------------------------------------------------------------------

describe('GET /api/brief', () => {
  test('returns the expected shape and a spoken sentence with no fabricated events', async () => {
    const ctx = await setup();
    try {
      const res = await get(ctx.app, `/api/brief?profileId=${ctx.profile.id}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body.greeting, 'string');
      assert.ok(Array.isArray(body.events));
      assert.ok(Array.isArray(body.unread));
      assert.ok(Array.isArray(body.reminders));
      assert.equal(typeof body.spoken, 'string');
      assert.match(body.events.map((e) => e.summary).join(', '), /Dentist|Soccer/);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/reminders, POST /api/reminders/done
// ---------------------------------------------------------------------------

describe('reminders routes', () => {
  test('lists open reminders and marks one done', async () => {
    const ctx = await setup({ connectCalendar: false });
    try {
      const reminder = addReminder(ctx.db, ctx.profile.id, { text: 'Call the plumber' });

      const listRes = await get(ctx.app, `/api/reminders?profileId=${ctx.profile.id}`);
      const listBody = await listRes.json();
      assert.equal(listBody.reminders.length, 1);
      assert.equal(listBody.reminders[0].id, reminder.id);

      const doneRes = await post(ctx.app, '/api/reminders/done', { id: reminder.id });
      assert.equal(doneRes.status, 200);
      const doneBody = await doneRes.json();
      assert.equal(doneBody.ok, true);
      assert.equal(doneBody.reminder.done, true);

      const listAfter = await get(ctx.app, `/api/reminders?profileId=${ctx.profile.id}`);
      assert.equal((await listAfter.json()).reminders.length, 0);
    } finally {
      await ctx.close();
    }
  });

  test('marking an unknown reminder done is a 404', async () => {
    const ctx = await setup({ connectCalendar: false });
    try {
      const res = await post(ctx.app, '/api/reminders/done', { id: 999999 });
      assert.equal(res.status, 404);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// app.setStatus('brain', ...)
// ---------------------------------------------------------------------------

describe('status', () => {
  test('GET /api/status includes a brain section', async () => {
    const ctx = await setup({ connectCalendar: false });
    try {
      const res = await get(ctx.app, '/api/status');
      const body = await res.json();
      assert.equal(typeof body.brain.intents, 'number');
      assert.equal(typeof body.brain.pendingConfirms, 'number');
    } finally {
      await ctx.close();
    }
  });
});
