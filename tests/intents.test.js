// Unit tests for each app/lib/intents/*.js module, run directly against
// their run()/validate() functions (no model, no brain.js dispatch loop).
// Calendar-backed intents use the real tests/fixtures/calendar/family.ics
// fixture through calendar.parseAndExpand/syncCalendar; mail-backed intents
// use a small fixture inserted directly into the messages table, matching
// how tests/contacts.test.js seeds messages; reminders use app/lib/reminders.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DateTime } from 'luxon';

import { openDb } from '../app/lib/db.js';
import * as calendar from '../app/lib/google/calendar.js';
import * as gmail from '../app/lib/google/gmail.js';
import * as contacts from '../app/lib/google/contacts.js';
import * as dates from '../app/lib/dates.js';
import * as scrub from '../app/lib/speech/scrub.js';
import { createSessionStore } from '../app/lib/brain.js';
import { asOfPrefix } from '../app/lib/intents/shared.js';
import { addReminder } from '../app/lib/reminders.js';

import todayAgenda from '../app/lib/intents/today_agenda.js';
import dateAgenda from '../app/lib/intents/date_agenda.js';
import nextEvent from '../app/lib/intents/next_event.js';
import freeCheck from '../app/lib/intents/free_check.js';
import whyMissingEvent from '../app/lib/intents/why_missing_event.js';
import unreadFrom from '../app/lib/intents/unread_from.js';
import keywordScan from '../app/lib/intents/keyword_scan.js';
import threadSummary from '../app/lib/intents/thread_summary.js';
import readMessage from '../app/lib/intents/read_message.js';
import draftReply from '../app/lib/intents/draft_reply.js';
import sendConfirmed from '../app/lib/intents/send_confirmed.js';
import createEvent from '../app/lib/intents/create_event.js';
import moveEvent from '../app/lib/intents/move_event.js';
import setReminder from '../app/lib/intents/set_reminder.js';
import listReminders from '../app/lib/intents/list_reminders.js';

const here = dirname(fileURLToPath(import.meta.url));
const familyIcs = readFileSync(join(here, 'fixtures', 'calendar', 'family.ics'), 'utf8');

const PROFILE = 1;
const ZONE = 'America/New_York';
const CAL_WINDOW = { fromUtc: '2026-09-01T00:00:00.000Z', toUtc: '2026-10-15T00:00:00.000Z' };

function nowAt(iso) {
  return DateTime.fromISO(iso, { zone: ZONE });
}

function seedCalendar(db, { nowUtc = '2026-09-01T00:00:00.000Z' } = {}) {
  const instances = calendar.parseAndExpand(familyIcs, { ...CAL_WINDOW, calendarName: 'Family' });
  calendar.syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc });
}

function insertMessage(db, m) {
  db.run(
    `INSERT INTO messages (
       profile_id, gm_msgid, gm_thrid, folder, uid, message_id,
       from_name, from_addr, to_addrs, subject, date_utc,
       is_unread, is_flagged, labels, snippet, body_text, size, synced_utc
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      PROFILE, m.gmMsgid, m.gmThrid || null, 'INBOX', m.uid || 1, m.messageId || `<${m.gmMsgid}@example.com>`,
      m.fromName, m.fromAddr, JSON.stringify(['me@gmail.com']), m.subject, m.dateUtc,
      m.unread ? 1 : 0, 0, JSON.stringify([]), (m.body || '').slice(0, 200), m.body || '', 512, new Date().toISOString(),
    ],
  );
}

function seedMessages(db) {
  insertMessage(db, {
    gmMsgid: 'em-101', gmThrid: 'thr-grandma-1', fromName: 'Grandma', fromAddr: 'grandma@example.com',
    subject: "Grandma's Birthday", dateUtc: '2026-08-21T12:00:00.000Z', unread: false,
    body: 'Looking forward to the party next month!',
  });
  insertMessage(db, {
    gmMsgid: 'em-102', gmThrid: 'thr-grandma-1', fromName: 'Grandma', fromAddr: 'grandma@example.com',
    subject: "Re: Grandma's Birthday", dateUtc: '2026-08-28T12:00:00.000Z', unread: true,
    body: "Can't wait to see everyone on Saturday! Bringing my famous potato salad.",
  });
  insertMessage(db, {
    gmMsgid: 'em-201', gmThrid: 'thr-school-1', fromName: 'Lincoln Elementary Front Office', fromAddr: 'front.office@lincoln.edu',
    subject: 'Early pickup Friday', dateUtc: '2026-08-22T12:00:00.000Z', unread: false,
    body: 'Reminder: Friday is an early dismissal day for teacher conferences.',
  });
  insertMessage(db, {
    gmMsgid: 'em-301', gmThrid: 'thr-invoice-1', fromName: 'Weekly Digest', fromAddr: 'digest@example.com',
    subject: 'Your invoice is ready', dateUtc: '2026-08-30T12:00:00.000Z', unread: true,
    body: 'Please see the attached invoice for September.',
  });
}

function baseCtx(db, overrides = {}) {
  return {
    db, calendar, gmail, contacts, dates, scrub,
    gmailSession: async () => null,
    profileId: PROFILE,
    profile: { id: PROFILE, name: 'Alex' },
    zone: ZONE,
    now: nowAt('2026-09-02T12:00:00-04:00'),
    slots: {},
    utterance: '',
    session: createSessionStore(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// today_agenda
// ---------------------------------------------------------------------------

describe('today_agenda', () => {
  test('narrates events for the current day, and no others', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-08T10:00:00.000Z' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-08T12:00:00-04:00') });
    return todayAgenda.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'narrate');
      assert.match(outcome.data, /Dentist/);
      assert.match(outcome.data, /Soccer practice/);
      assert.doesNotMatch(outcome.data, /Ferry booking/);
      assert.equal(outcome.source.kind, 'calendar');
      assert.equal(outcome.source.asOf, '2026-09-08T10:00:00.000Z');
    });
  });

  test('an empty day says so plainly, no fabricated events', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-02T10:00:00.000Z' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00') });
    return todayAgenda.run(ctx).then((outcome) => {
      assert.match(outcome.data, /No matching events were found/);
    });
  });
});

// ---------------------------------------------------------------------------
// date_agenda
// ---------------------------------------------------------------------------

describe('date_agenda', () => {
  test('validate rejects an empty date_text', () => {
    assert.equal(dateAgenda.validate({ date_text: '  ' }).ok, false);
  });

  test('a named weekday resolves through windowFor', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-02T10:00:00.000Z' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00'), slots: { date_text: 'next Tuesday' } });
    return dateAgenda.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'narrate');
      assert.match(outcome.data, /Dentist/);
      assert.match(outcome.data, /Soccer practice/);
    });
  });

  test('a date windowFor cannot parse falls back to dates.resolve for a single day', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-02T10:00:00.000Z' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00'), slots: { date_text: '9/10' } });
    return dateAgenda.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'narrate');
      assert.match(outcome.data, /Ferry booking/);
      assert.doesNotMatch(outcome.data, /Dentist/);
    });
  });

  test('a date nothing can parse asks a targeted clarifying question', () => {
    const db = openDb(':memory:');
    const ctx = baseCtx(db, { slots: { date_text: 'blorp' } });
    return dateAgenda.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'clarify');
      assert.equal(outcome.question, 'Which day did you mean?');
    });
  });
});

// ---------------------------------------------------------------------------
// next_event (also the "did you already put the dentist on my calendar"
// ambiguous-question case: it must not fabricate when nothing matches)
// ---------------------------------------------------------------------------

describe('next_event', () => {
  test('no hint returns the soonest upcoming event', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-02T10:00:00.000Z' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00'), slots: { hint: '' } });
    return nextEvent.run(ctx).then((outcome) => {
      assert.match(outcome.data, /Dentist/);
    });
  });

  test('a hint that matches returns that event, not the soonest', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-02T10:00:00.000Z' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00'), slots: { hint: 'soccer' } });
    return nextEvent.run(ctx).then((outcome) => {
      assert.match(outcome.data, /Soccer practice/);
      assert.doesNotMatch(outcome.data, /Dentist/);
    });
  });

  test('a hint matching nothing says so plainly instead of inventing an event', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-02T10:00:00.000Z' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00'), slots: { hint: 'submarine race' } });
    return nextEvent.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'narrate');
      assert.match(outcome.data, /No upcoming event matching "submarine race" was found/);
    });
  });
});

// ---------------------------------------------------------------------------
// free_check
// ---------------------------------------------------------------------------

describe('free_check', () => {
  test('validate rejects empty when_text', () => {
    assert.equal(freeCheck.validate({ when_text: '' }).ok, false);
  });

  test('a time that conflicts with an event reports the conflict', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-02T10:00:00.000Z' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00'), slots: { when_text: 'next Tuesday at 3' } });
    return freeCheck.run(ctx).then((outcome) => {
      assert.match(outcome.data, /is not free/);
      assert.match(outcome.data, /Dentist/);
    });
  });

  test('an open time reports free', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-02T10:00:00.000Z' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00'), slots: { when_text: 'tomorrow at 3' } });
    return freeCheck.run(ctx).then((outcome) => {
      assert.match(outcome.data, /is free on the calendar/);
    });
  });

  test('nothing dates.resolve can parse asks a targeted clarifying question', () => {
    const db = openDb(':memory:');
    const ctx = baseCtx(db, { slots: { when_text: 'blorp' } });
    return freeCheck.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'clarify');
    });
  });
});

// ---------------------------------------------------------------------------
// why_missing_event: scripted, no model call ever (there is nothing here to
// call a model with in the first place, which is the point).
// ---------------------------------------------------------------------------

describe('why_missing_event', () => {
  test('explains the feed lag and includes the as-of prefix', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-02T10:00:00.000Z' });
    const ctx = baseCtx(db);
    return whyMissingEvent.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'say');
      const expectedPrefix = asOfPrefix(dates, '2026-09-02T10:00:00.000Z', ZONE);
      assert.ok(outcome.text.startsWith(expectedPrefix));
      assert.match(outcome.text, /feed/);
    });
  });

  test('never synced: still answers plainly, no crash', () => {
    const db = openDb(':memory:');
    const ctx = baseCtx(db);
    return whyMissingEvent.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'say');
      assert.equal(outcome.source.asOf, null);
    });
  });
});

// ---------------------------------------------------------------------------
// create_event / move_event (writes: return a pendingAction, never act
// directly)
// ---------------------------------------------------------------------------

describe('create_event', () => {
  test('validate requires a title and a when_text', () => {
    assert.equal(createEvent.validate({ title: '', when_text: 'tomorrow' }).ok, false);
    assert.equal(createEvent.validate({ title: 'Team meeting', when_text: '' }).ok, false);
    const ok = createEvent.validate({ title: '  Team meeting  ', when_text: 'next Tuesday at 3', location: '' });
    assert.equal(ok.ok, true);
    assert.equal(ok.slots.title, 'Team meeting');
  });

  test('resolves the date in code and returns a confirm outcome, not a direct write', () => {
    const db = openDb(':memory:');
    const ctx = baseCtx(db, {
      now: nowAt('2026-09-02T12:00:00-04:00'),
      slots: { title: 'Team meeting', when_text: 'next Tuesday at 3', location: '' },
    });
    return createEvent.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'confirm');
      assert.equal(outcome.action, 'create_event');
      assert.equal(outcome.details.title, 'Team meeting');
      assert.equal(outcome.details.startUtc, '2026-09-08T19:00:00Z');
      assert.match(outcome.sentence, /Team meeting/);
      assert.match(outcome.sentence, /Should I go ahead/);
    });
  });

  test('a when_text nothing can parse asks a targeted clarifying question', () => {
    const db = openDb(':memory:');
    const ctx = baseCtx(db, { slots: { title: 'Team meeting', when_text: 'blorp', location: '' } });
    return createEvent.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'clarify');
    });
  });
});

describe('move_event', () => {
  test('a matching event returns a confirm outcome with an open_link action, never a direct edit', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-02T10:00:00.000Z' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00'), slots: { hint: 'dentist' } });
    return moveEvent.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'confirm');
      assert.equal(outcome.action, 'open_link');
      assert.match(outcome.details.url, /^https:\/\/calendar\.google\.com\/calendar\/r\/day\/2026\/09\/08$/);
      assert.match(outcome.sentence, /can't move events/);
    });
  });

  test('no matching event says so, with the as-of prefix, and asks for nothing to confirm', () => {
    const db = openDb(':memory:');
    seedCalendar(db, { nowUtc: '2026-09-02T10:00:00.000Z' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00'), slots: { hint: 'submarine race' } });
    return moveEvent.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'say');
      assert.match(outcome.text, /As of my last check/);
      assert.match(outcome.text, /couldn't find/);
    });
  });
});

// ---------------------------------------------------------------------------
// set_reminder / list_reminders
// ---------------------------------------------------------------------------

describe('set_reminder', () => {
  test('validate requires text but when_text may be empty', () => {
    assert.equal(setReminder.validate({ text: '' }).ok, false);
    assert.equal(setReminder.validate({ text: 'sign the form', when_text: '' }).ok, true);
  });

  test('resolves when_text in code and returns a confirm outcome', () => {
    const db = openDb(':memory:');
    const ctx = baseCtx(db, {
      now: nowAt('2026-09-02T12:00:00-04:00'),
      slots: { text: 'call the plumber', when_text: 'tomorrow' },
    });
    return setReminder.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'confirm');
      assert.equal(outcome.action, 'set_reminder');
      assert.equal(outcome.details.text, 'call the plumber');
      assert.ok(outcome.details.dueUtc);
      assert.match(outcome.sentence, /call the plumber/);
      assert.match(outcome.sentence, /tomorrow/);
    });
  });

  test('an empty when_text still confirms, with no due date', () => {
    const db = openDb(':memory:');
    const ctx = baseCtx(db, { slots: { text: 'sign the form', when_text: '' } });
    return setReminder.run(ctx).then((outcome) => {
      assert.equal(outcome.details.dueUtc, null);
      assert.match(outcome.sentence, /no set time/);
    });
  });
});

describe('list_reminders', () => {
  test('reads open reminders back plainly, no model call needed', () => {
    const db = openDb(':memory:');
    addReminder(db, PROFILE, { text: 'Call the plumber', dueUtc: '2026-09-03T00:00:00.000Z' });
    addReminder(db, PROFILE, { text: 'Sign the school form' });
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00') });
    return listReminders.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'say');
      assert.match(outcome.text, /Call the plumber/);
      assert.match(outcome.text, /Sign the school form/);
      assert.match(outcome.text, /two reminders/);
    });
  });

  test('no open reminders says so plainly', () => {
    const db = openDb(':memory:');
    const ctx = baseCtx(db);
    return listReminders.run(ctx).then((outcome) => {
      assert.equal(outcome.text, "You don't have any open reminders.");
    });
  });
});

// ---------------------------------------------------------------------------
// unread_from / keyword_scan
// ---------------------------------------------------------------------------

describe('unread_from', () => {
  test('resolves a spoken name to an address through contacts, then matches unread mail', () => {
    const db = openDb(':memory:');
    seedMessages(db);
    const ctx = baseCtx(db, { slots: { sender: 'grandma' } });
    return unreadFrom.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'narrate');
      assert.match(outcome.data, /potato salad/);
      assert.equal(outcome.source.kind, 'inbox');
    });
  });

  test('nobody unread from that sender says so, not fabricated', () => {
    const db = openDb(':memory:');
    seedMessages(db);
    const ctx = baseCtx(db, { slots: { sender: 'nobody at all' } });
    return unreadFrom.run(ctx).then((outcome) => {
      assert.match(outcome.data, /No matching messages were found/);
    });
  });
});

describe('keyword_scan', () => {
  test('finds a matching message by keyword', () => {
    const db = openDb(':memory:');
    seedMessages(db);
    const ctx = baseCtx(db, { now: nowAt('2026-09-02T12:00:00-04:00'), slots: { keyword: 'invoice' }, utterance: 'search my email for invoice' });
    return keywordScan.run(ctx).then((outcome) => {
      assert.match(outcome.data, /Your invoice is ready/);
    });
  });
});

// ---------------------------------------------------------------------------
// thread_summary / read_message: read back close to verbatim (scrubbed for
// speech), no model call.
// ---------------------------------------------------------------------------

describe('read_message', () => {
  test('reads a matching message back, scrubbed for speech, and remembers it as the session parent', () => {
    const db = openDb(':memory:');
    seedMessages(db);
    const session = createSessionStore();
    const ctx = baseCtx(db, { slots: { hint: 'grandma' }, session });
    return readMessage.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'say');
      assert.match(outcome.text, /potato salad/);
      assert.equal(session.getLastMessage(PROFILE), 'em-102');
    });
  });

  test('no match says so plainly', () => {
    const db = openDb(':memory:');
    seedMessages(db);
    const ctx = baseCtx(db, { slots: { hint: 'nobody at all' } });
    return readMessage.run(ctx).then((outcome) => {
      assert.match(outcome.text, /couldn't find/);
    });
  });
});

describe('thread_summary', () => {
  test('reads back the thread, oldest to newest, capped and scrubbed', () => {
    const db = openDb(':memory:');
    seedMessages(db);
    const session = createSessionStore();
    const ctx = baseCtx(db, { slots: { hint: 'grandma' }, session });
    return threadSummary.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'say');
      assert.match(outcome.text, /party/);
      assert.match(outcome.text, /potato salad/);
      assert.equal(session.getLastMessage(PROFILE), 'em-102');
    });
  });
});

// ---------------------------------------------------------------------------
// draft_reply -> send_confirmed: send is only reachable after a draft in the
// same session; a cold "send it" must answer that nothing is drafted yet.
// ---------------------------------------------------------------------------

describe('draft_reply and send_confirmed', () => {
  // Matches the real app/lib/google/sync.js's createGmailSession(profileId):
  // { creds, folders, withImap }, where withImap already knows how to open
  // its own connection (draft_reply.js calls account.withImap directly, not
  // gmail.withImap(account.creds, ...)).
  function testGmailSession(appendCalls) {
    return async () => ({
      creds: { email: 'me@gmail.com', appPassword: 'xxxx xxxx xxxx xxxx' },
      folders: { inbox: 'INBOX', all: 'All Mail', sent: 'Sent', drafts: 'Drafts', trash: 'Trash' },
      withImap: async (fn) => fn({ append: async (...args) => { appendCalls.push(args); } }),
    });
  }

  test('send_confirmed with nothing drafted this session answers plainly, no confirm', () => {
    const db = openDb(':memory:');
    const ctx = baseCtx(db, { session: createSessionStore() });
    return sendConfirmed.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'say');
      assert.match(outcome.text, /nothing drafted yet/);
    });
  });

  test('draft_reply with no parent message tracked asks which message to reply to', () => {
    const db = openDb(':memory:');
    const ctx = baseCtx(db, { session: createSessionStore(), slots: { subject: '', body: 'sounds good' } });
    return draftReply.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'clarify');
    });
  });

  test('draft_reply saves a real draft, then send_confirmed can reach it', async () => {
    const db = openDb(':memory:');
    seedMessages(db);
    const session = createSessionStore();
    session.setLastMessage(PROFILE, 'em-102');
    const appendCalls = [];

    const draftCtx = baseCtx(db, {
      session,
      gmailSession: testGmailSession(appendCalls),
      slots: { subject: '', body: "We'll be there, thanks Grandma!" },
    });

    const draftOutcome = await draftReply.run(draftCtx);
    assert.equal(draftOutcome.type, 'say');
    assert.match(draftOutcome.text, /Grandma/);
    assert.equal(appendCalls.length, 1);
    assert.ok(session.getLastDraft(PROFILE));

    const sendCtx = baseCtx(db, { session });
    const sendOutcome = await sendConfirmed.run(sendCtx);
    assert.equal(sendOutcome.type, 'confirm');
    assert.equal(sendOutcome.action, 'send_mail');
    assert.equal(sendOutcome.details.needsPin, true);
    assert.match(sendOutcome.sentence, /Grandma/);
  });

  test('send_confirmed on an already-sent draft says so instead of re-confirming', () => {
    const db = openDb(':memory:');
    const now = new Date().toISOString();
    const result = db.run(
      `INSERT INTO drafts (profile_id, gm_thrid, to_addr, to_name, subject, body, in_reply_to, message_id, state, created_utc, updated_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`,
      [PROFILE, 'thr-grandma-1', 'grandma@example.com', 'Grandma', 'Re: Hi', 'body', null, '<x@example.com>', now, now],
    );
    const session = createSessionStore();
    session.setLastDraft(PROFILE, Number(result.lastInsertRowid));
    const ctx = baseCtx(db, { session });
    return sendConfirmed.run(ctx).then((outcome) => {
      assert.equal(outcome.type, 'say');
      assert.match(outcome.text, /already sent/);
    });
  });
});

// ---------------------------------------------------------------------------
// not-connected answers: these live in brain.js's gating (before an intent's
// run() is ever called), covered end to end in tests/brain.test.js. What
// belongs here is that every intent module's `google` field is set so that
// gate applies to the right service.
// ---------------------------------------------------------------------------

describe('google field on every intent that touches Google', () => {
  test('calendar intents are tagged calendar, mail intents gmail, local ones null', () => {
    assert.equal(todayAgenda.google, 'calendar');
    assert.equal(dateAgenda.google, 'calendar');
    assert.equal(nextEvent.google, 'calendar');
    assert.equal(freeCheck.google, 'calendar');
    assert.equal(whyMissingEvent.google, 'calendar');
    assert.equal(createEvent.google, 'calendar');
    assert.equal(moveEvent.google, 'calendar');
    assert.equal(unreadFrom.google, 'gmail');
    assert.equal(keywordScan.google, 'gmail');
    assert.equal(threadSummary.google, 'gmail');
    assert.equal(readMessage.google, 'gmail');
    assert.equal(draftReply.google, 'gmail');
    assert.equal(sendConfirmed.google, 'gmail');
    assert.equal(setReminder.google, null);
    assert.equal(listReminders.google, null);
  });
});
