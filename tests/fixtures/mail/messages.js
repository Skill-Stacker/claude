// Fixture data for tests/gmail.test.js: three threads worth of messages,
// plus the small helpers that turn one of these plain records into the
// shape imapflow's fetch() would hand back (envelope, flags Set, labels
// Set, bodyStructure) and a part-id to raw-content map for download().
//
// Kept deliberately as plain data (no imapflow types involved) so it can be
// reused for hand-built synthetic messages too, see gmail.test.js's
// makeSyntheticMessage().

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// A fixed "now" so every relative date in this file (and in the tests that
// use it) is deterministic.
export const NOW_UTC = '2026-09-02T12:00:00.000Z';

function daysAgo(n) {
  return new Date(new Date(NOW_UTC).getTime() - n * 86400000).toISOString();
}

const grandmaHtml = readFileSync(join(here, 'nested.html'), 'utf8');

// -- Thread 1: grandma's birthday, one HTML-only message, one plain-text
// reply, one read and one unread. --------------------------------------
export const THREAD_GRANDMA = 'thr-grandma-1';

export const grandmaMessages = [
  {
    uid: 101,
    threadId: THREAD_GRANDMA,
    emailId: 'em-101',
    messageId: '<m101@mail.gmail.com>',
    subject: "Grandma's Birthday",
    from: { name: 'Grandma', address: 'grandma@example.com' },
    to: [{ address: 'me@gmail.com' }],
    date: daysAgo(12),
    seen: true,
    flagged: false,
    labels: ['\\Important'],
    html: grandmaHtml,
    size: 4096,
  },
  {
    uid: 102,
    threadId: THREAD_GRANDMA,
    emailId: 'em-102',
    messageId: '<m102@mail.gmail.com>',
    subject: "Re: Grandma's Birthday",
    from: { name: 'Grandma', address: 'grandma@example.com' },
    to: [{ address: 'me@gmail.com' }],
    date: daysAgo(5),
    seen: false,
    flagged: false,
    labels: [],
    text: "Can't wait to see everyone on Saturday! Bringing my famous potato salad.",
    size: 512,
  },
];

// -- Thread 2: school pickup, three messages, used for keyword and
// from-address queries. --------------------------------------------------
export const THREAD_SCHOOL = 'thr-school-1';

export const schoolMessages = [
  {
    uid: 201,
    threadId: THREAD_SCHOOL,
    emailId: 'em-201',
    messageId: '<m201@lincoln.edu>',
    subject: 'Early pickup Friday',
    from: { name: 'Lincoln Elementary Front Office', address: 'front.office@lincoln.edu' },
    to: [{ address: 'me@gmail.com' }],
    date: daysAgo(10),
    seen: true,
    flagged: false,
    labels: [],
    text: 'Reminder: Friday is an early dismissal day for teacher conferences. Pickup is at 1pm.',
    size: 640,
  },
  {
    uid: 202,
    threadId: THREAD_SCHOOL,
    emailId: 'em-202',
    messageId: '<m202@lincoln.edu>',
    subject: 'Re: Early pickup Friday',
    from: { name: 'Lincoln Elementary Front Office', address: 'front.office@lincoln.edu' },
    to: [{ address: 'me@gmail.com' }],
    date: daysAgo(8),
    seen: false,
    flagged: false,
    labels: [],
    text: 'Correction: pickup for the teacher conferences half day is at 12:30pm, not 1pm.',
    size: 600,
  },
  {
    uid: 203,
    threadId: THREAD_SCHOOL,
    emailId: 'em-203',
    messageId: '<m203@lincoln.edu>',
    subject: 'Re: Early pickup Friday',
    from: { name: 'Lincoln Elementary Front Office', address: 'front.office@lincoln.edu' },
    to: [{ address: 'me@gmail.com' }],
    date: daysAgo(7),
    seen: true,
    flagged: false,
    labels: [],
    text: 'One more note: the conferences sign-up sheet closes Thursday at noon.',
    size: 580,
  },
];

// -- Thread 3: a single unread, flagged message, dated outside bodyDays but
// inside the default first-run window, to exercise the body-cap cutoff. --
export const THREAD_SOLO = 'thr-solo-1';

export const soloMessages = [
  {
    uid: 301,
    threadId: THREAD_SOLO,
    emailId: 'em-301',
    messageId: '<m301@example.com>',
    subject: 'Long newsletter you might like',
    from: { name: 'Weekly Digest', address: 'digest@example.com' },
    to: [{ address: 'me@gmail.com' }],
    date: daysAgo(20),
    seen: false,
    flagged: true,
    labels: ['\\Newsletter'],
    // Longer than any bodyCap used in the tests, to prove capping happens.
    text: 'Article one. '.repeat(500),
    size: 8192,
  },
];

export const allMessages = [...grandmaMessages, ...schoolMessages, ...soloMessages];

// ---------------------------------------------------------------------------
// Conversion helpers shared with the FakeImapFlow harness in gmail.test.js
// ---------------------------------------------------------------------------

export function toBodyStructure(fixture) {
  if (fixture.text && fixture.html) {
    return {
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/plain', part: '1', parameters: { charset: 'utf-8' } },
        { type: 'text/html', part: '2', parameters: { charset: 'utf-8' } },
      ],
    };
  }
  if (fixture.text) {
    return { type: 'text/plain', part: '1', parameters: { charset: 'utf-8' } };
  }
  return { type: 'text/html', part: '1', parameters: { charset: 'utf-8' } };
}

export function partsMapFor(fixture) {
  const map = {};
  if (fixture.text && fixture.html) {
    map['1'] = fixture.text;
    map['2'] = fixture.html;
  } else if (fixture.text) {
    map['1'] = fixture.text;
  } else if (fixture.html) {
    map['1'] = fixture.html;
  }
  return map;
}

// Turns one plain fixture record into the FetchMessageObject shape imapflow
// hands back from fetch()/fetchOne().
export function toFetchMessage(fixture) {
  const flags = new Set();
  if (fixture.seen) flags.add('\\Seen');
  if (fixture.flagged) flags.add('\\Flagged');
  return {
    uid: fixture.uid,
    seq: fixture.uid,
    flags,
    envelope: {
      date: new Date(fixture.date),
      subject: fixture.subject,
      messageId: fixture.messageId,
      from: [fixture.from],
      to: fixture.to || [],
    },
    bodyStructure: toBodyStructure(fixture),
    labels: new Set(fixture.labels || []),
    threadId: fixture.threadId,
    emailId: fixture.emailId,
    size: fixture.size || 1024,
  };
}
