import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { openDb } from '../app/lib/db.js';
import {
  CalendarError,
  fetchIcs,
  validateIcsUrl,
  parseAndExpand,
  syncCalendar,
  listEvents,
  nextEvent,
  isFree,
  lastChecked,
  staleness,
} from '../app/lib/google/calendar.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures', 'calendar');
const familyIcs = readFileSync(join(fixturesDir, 'family.ics'), 'utf8');
const emptyIcs = readFileSync(join(fixturesDir, 'empty.ics'), 'utf8');
const notIcsText = readFileSync(join(fixturesDir, 'not-ics.txt'), 'utf8');

const WINDOW = { fromUtc: '2026-09-01T00:00:00.000Z', toUtc: '2026-10-15T00:00:00.000Z' };
const PROFILE = 1;

function byUid(instances, uid) {
  return instances.filter((i) => i.uid === uid).sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

// ---------------------------------------------------------------------------
// parseAndExpand
// ---------------------------------------------------------------------------

test('parseAndExpand: exact instance list for the family fixture', () => {
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });

  assert.equal(instances.length, 11, 'expected 11 instances in the window');

  const expectedOrder = [
    '2026-09-01T21:30:00.000Z',
    '2026-09-08T19:00:00.000Z',
    '2026-09-08T21:30:00.000Z',
    '2026-09-10T14:00:00.000Z',
    '2026-09-11T13:00:00.000Z',
    '2026-09-12T00:00:00.000Z',
    '2026-09-22T22:00:00.000Z',
    '2026-09-25T00:00:00.000Z',
    '2026-09-29T21:30:00.000Z',
    '2026-10-06T21:30:00.000Z',
    '2026-10-13T21:30:00.000Z',
  ];
  assert.deepEqual(
    instances.map((i) => i.startUtc),
    expectedOrder,
    'instances should be sorted by start and match the expected occurrences',
  );

  // RRULE expansion + EXDATE removed: soccer practice occurs on 09-01, 09-08
  // (09-15 excluded), the 09-22 override, 09-29, 10-06, 10-13 = 6 instances.
  const soccer = byUid(instances, 'soccer-weekly@family.example.com');
  assert.equal(soccer.length, 6);
  assert.ok(
    !soccer.some((i) => i.startUtc.startsWith('2026-09-15')),
    'the EXDATE occurrence must not appear',
  );
  for (const i of soccer) {
    assert.equal(i.summary, 'Soccer practice');
    assert.equal(i.allDay, false);
    assert.equal(i.tzid, 'America/New_York');
    assert.equal(i.status, 'CONFIRMED');
    assert.ok(i.rruleRaw && i.rruleRaw.includes('FREQ=WEEKLY'));
  }
  const plainOccurrenceLocations = soccer.filter((i) => i.startUtc !== '2026-09-22T22:00:00.000Z');
  for (const i of plainOccurrenceLocations) {
    assert.equal(i.location, 'Cedar Park Field 3');
  }

  // RECURRENCE-ID override: new time and new location, same series.
  const overridden = soccer.find((i) => i.startUtc === '2026-09-22T22:00:00.000Z');
  assert.ok(overridden, 'the moved occurrence should appear at its new time');
  assert.equal(overridden.endUtc, '2026-09-22T23:00:00.000Z');
  assert.equal(overridden.location, 'Riverside Field 7 (away)');
  assert.equal(overridden.instanceId, `soccer-weekly@family.example.com@2026-09-22T22:00:00.000Z`);

  // Cancelled event dropped entirely.
  assert.equal(
    byUid(instances, 'book-club@family.example.com').length,
    0,
    'a STATUS:CANCELLED event must not produce an instance',
  );

  // Plain timed event.
  const dentist = byUid(instances, 'dentist-visit@family.example.com');
  assert.equal(dentist.length, 1);
  assert.equal(dentist[0].startUtc, '2026-09-08T19:00:00.000Z');
  assert.equal(dentist[0].endUtc, '2026-09-08T19:45:00.000Z');
  assert.equal(dentist[0].tzid, 'America/New_York');
  assert.equal(dentist[0].allDay, false);

  // All-day, single day: end is the next day (exclusive), and it is flagged.
  const grandma = byUid(instances, 'grandma-visit@family.example.com');
  assert.equal(grandma.length, 1);
  assert.equal(grandma[0].startUtc, '2026-09-12T00:00:00.000Z');
  assert.equal(grandma[0].endUtc, '2026-09-13T00:00:00.000Z');
  assert.equal(grandma[0].allDay, true);

  // UTC-stamped (Z) event converts to tzid 'UTC'.
  const ferry = byUid(instances, 'ferry-booking@family.example.com');
  assert.equal(ferry.length, 1);
  assert.equal(ferry[0].startUtc, '2026-09-10T14:00:00.000Z');
  assert.equal(ferry[0].endUtc, '2026-09-10T15:00:00.000Z');
  assert.equal(ferry[0].tzid, 'UTC');
  assert.equal(ferry[0].allDay, false);

  // DURATION instead of DTEND is honored (1h30m after start).
  const bike = byUid(instances, 'bike-tuneup@family.example.com');
  assert.equal(bike.length, 1);
  assert.equal(bike[0].startUtc, '2026-09-11T13:00:00.000Z');
  assert.equal(bike[0].endUtc, '2026-09-11T14:30:00.000Z');
  assert.equal(bike[0].tzid, 'America/New_York');

  // Multi-day all-day event spans several days and is flagged all-day.
  const beach = byUid(instances, 'beach-trip@family.example.com');
  assert.equal(beach.length, 1);
  assert.equal(beach[0].startUtc, '2026-09-25T00:00:00.000Z');
  assert.equal(beach[0].endUtc, '2026-09-28T00:00:00.000Z');
  assert.equal(beach[0].allDay, true);
});

test('parseAndExpand: does not depend on the machine time zone', () => {
  const baseline = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });

  const originalTz = process.env.TZ;
  process.env.TZ = 'Pacific/Kiritimati'; // UTC+14, about as far from UTC as it gets
  let underOddTz;
  try {
    underOddTz = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }

  assert.deepEqual(underOddTz, baseline, 'results must be identical regardless of process.env.TZ');
});

test('parseAndExpand: empty calendar yields no instances', () => {
  const instances = parseAndExpand(emptyIcs, { ...WINDOW, calendarName: 'Family' });
  assert.deepEqual(instances, []);
});

// ---------------------------------------------------------------------------
// validateIcsUrl
// ---------------------------------------------------------------------------

test('validateIcsUrl: accepts a real secret address', () => {
  const url =
    'https://calendar.google.com/calendar/ical/parent%40gmail.com/private-abc123def456/basic.ics';
  const result = validateIcsUrl(url);
  assert.deepEqual(result, { ok: true, reason: null });
});

test('validateIcsUrl: rejects the public address', () => {
  const url =
    'https://calendar.google.com/calendar/ical/somegroup%40group.calendar.google.com/public/basic.ics';
  const result = validateIcsUrl(url);
  assert.equal(result.ok, false);
  assert.match(result.reason, /public address, not the secret one/);
});

test('validateIcsUrl: rejects the embed address', () => {
  const url = 'https://calendar.google.com/calendar/embed?src=parent%40gmail.com';
  const result = validateIcsUrl(url);
  assert.equal(result.ok, false);
  assert.match(result.reason, /embed address/);
});

test('validateIcsUrl: rejects http', () => {
  const url = 'http://calendar.google.com/calendar/ical/parent%40gmail.com/private-abc123/basic.ics';
  const result = validateIcsUrl(url);
  assert.equal(result.ok, false);
  assert.match(result.reason, /https/);
});

test('validateIcsUrl: rejects a missing .ics extension', () => {
  const url = 'https://calendar.google.com/calendar/ical/parent%40gmail.com/private-abc123/basic';
  const result = validateIcsUrl(url);
  assert.equal(result.ok, false);
  assert.match(result.reason, /\.ics/);
});

test('validateIcsUrl: rejects a non Google host', () => {
  const url = 'https://example.com/calendar/ical/parent/private-abc123/basic.ics';
  const result = validateIcsUrl(url);
  assert.equal(result.ok, false);
  assert.match(result.reason, /calendar\.google\.com/);
});

test('validateIcsUrl: rejects gibberish', () => {
  const result = validateIcsUrl('not a url at all');
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// fetchIcs
// ---------------------------------------------------------------------------

async function expectKind(promise, kind) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof CalendarError, 'error should be a CalendarError');
    assert.equal(err.kind, kind);
    return true;
  });
}

test('fetchIcs: returns the text on success', async () => {
  const fetchText = async () => ({ status: 200, text: familyIcs });
  const text = await fetchIcs('https://calendar.google.com/x.ics', { fetchText });
  assert.equal(text, familyIcs);
});

test('fetchIcs: not_found on 404', async () => {
  const fetchText = async () => ({ status: 404, text: 'Not Found' });
  await expectKind(fetchIcs('https://calendar.google.com/x.ics', { fetchText }), 'not_found');
});

test('fetchIcs: http on another bad status', async () => {
  const fetchText = async () => ({ status: 500, text: 'server error' });
  await expectKind(fetchIcs('https://calendar.google.com/x.ics', { fetchText }), 'http');
});

test('fetchIcs: not_ics when the body is not a calendar', async () => {
  const fetchText = async () => ({ status: 200, text: notIcsText });
  await expectKind(fetchIcs('https://calendar.google.com/x.ics', { fetchText }), 'not_ics');
});

test('fetchIcs: timeout when fetchText reports a timeout', async () => {
  const fetchText = async () => {
    const err = new Error('timed out');
    err.code = 'timeout';
    throw err;
  };
  await expectKind(fetchIcs('https://calendar.google.com/x.ics', { fetchText }), 'timeout');
});

test('fetchIcs: unreachable on a network failure', async () => {
  const fetchText = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  await expectKind(fetchIcs('https://calendar.google.com/x.ics', { fetchText }), 'unreachable');
});

test('fetchIcs: passes timeoutMs through to fetchText', async () => {
  let seen;
  const fetchText = async (url, { timeoutMs }) => {
    seen = timeoutMs;
    return { status: 200, text: emptyIcs };
  };
  await fetchIcs('https://calendar.google.com/x.ics', { fetchText, timeoutMs: 1234 });
  assert.equal(seen, 1234);
});

// ---------------------------------------------------------------------------
// syncCalendar / listEvents / nextEvent / isFree / lastChecked / staleness
// ---------------------------------------------------------------------------

function freshDb() {
  return openDb(':memory:');
}

test('syncCalendar: writes instances and records lastChecked/lastOk', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  const now = '2026-09-01T12:00:00.000Z';

  const result = syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: now });
  assert.equal(result.count, instances.length);

  const rows = listEvents(db, PROFILE, WINDOW.fromUtc, WINDOW.toUtc);
  assert.equal(rows.length, instances.length);
  assert.equal(lastChecked(db), now);
  db.close();
});

test('syncCalendar: a re-sync with an event removed from the feed deletes it', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  const firstSync = '2026-09-01T12:00:00.000Z';
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: firstSync });

  const dentistUid = 'dentist-visit@family.example.com';
  assert.equal(byUid(listEvents(db, PROFILE, WINDOW.fromUtc, WINDOW.toUtc), dentistUid).length, 1);

  const withoutDentist = instances.filter((i) => i.uid !== dentistUid);
  const secondSync = '2026-09-01T13:00:00.000Z';
  syncCalendar(db, PROFILE, withoutDentist, { calendarName: 'Family', nowUtc: secondSync });

  const after = listEvents(db, PROFILE, WINDOW.fromUtc, WINDOW.toUtc);
  assert.equal(after.length, withoutDentist.length);
  assert.equal(byUid(after, dentistUid).length, 0, 'the removed event should be deleted');
  assert.equal(lastChecked(db), secondSync);
  db.close();
});

test('listEvents: ordered by start', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: '2026-09-01T12:00:00.000Z' });

  const rows = listEvents(db, PROFILE, WINDOW.fromUtc, WINDOW.toUtc);
  const starts = rows.map((r) => r.startUtc);
  const sorted = [...starts].sort();
  assert.deepEqual(starts, sorted);
});

test('listEvents: only returns events overlapping the window', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: '2026-09-01T12:00:00.000Z' });

  const rows = listEvents(db, PROFILE, '2026-09-01T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.startUtc < '2026-09-09T00:00:00.000Z'));
});

test('nextEvent: without a hint returns the soonest upcoming event', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: '2026-09-01T12:00:00.000Z' });

  const result = nextEvent(db, PROFILE, '2026-09-01T00:00:00.000Z', {});
  assert.equal(result.startUtc, '2026-09-01T21:30:00.000Z');
  assert.equal(result.matchedByHint, false);
});

test('nextEvent: with a hint matching a later event returns that one', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: '2026-09-01T12:00:00.000Z' });

  const result = nextEvent(db, PROFILE, '2026-09-01T00:00:00.000Z', { hint: 'dentist' });
  assert.equal(result.uid, 'dentist-visit@family.example.com');
  assert.equal(result.matchedByHint, true);
});

test('nextEvent: a hint that matches nothing falls back to the soonest event', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: '2026-09-01T12:00:00.000Z' });

  const result = nextEvent(db, PROFILE, '2026-09-01T00:00:00.000Z', { hint: 'submarine race' });
  assert.equal(result.startUtc, '2026-09-01T21:30:00.000Z');
  assert.equal(result.matchedByHint, false);
});

test('nextEvent: a hint on location also matches', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: '2026-09-01T12:00:00.000Z' });

  const result = nextEvent(db, PROFILE, '2026-09-01T00:00:00.000Z', { hint: 'riverside' });
  assert.equal(result.location, 'Riverside Field 7 (away)');
  assert.equal(result.matchedByHint, true);
});

test('nextEvent: returns null when there is nothing upcoming', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: '2026-09-01T12:00:00.000Z' });

  const result = nextEvent(db, PROFILE, '2027-01-01T00:00:00.000Z', {});
  assert.equal(result, null);
});

test('isFree: reports a conflict when an event overlaps the window', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: '2026-09-01T12:00:00.000Z' });

  const result = isFree(db, PROFILE, '2026-09-08T18:30:00.000Z', '2026-09-08T19:15:00.000Z');
  assert.equal(result.free, false);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].uid, 'dentist-visit@family.example.com');
});

test('isFree: reports free when nothing overlaps', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: '2026-09-01T12:00:00.000Z' });

  const result = isFree(db, PROFILE, '2026-09-13T00:00:00.000Z', '2026-09-13T01:00:00.000Z');
  assert.equal(result.free, true);
  assert.deepEqual(result.conflicts, []);
});

test('isFree: ignores cancelled events', () => {
  const db = freshDb();
  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: '2026-09-01T12:00:00.000Z' });

  // The book club event was CANCELLED in the source feed, so it was never
  // synced at all; this window matches where it would have been.
  const result = isFree(db, PROFILE, '2026-09-16T14:00:00.000Z', '2026-09-16T15:00:00.000Z');
  assert.equal(result.free, true);
});

test('staleness: minutes since the last check, or null when never checked', () => {
  const db = freshDb();
  assert.equal(staleness(db, '2026-09-01T12:00:00.000Z'), null);

  const instances = parseAndExpand(familyIcs, { ...WINDOW, calendarName: 'Family' });
  syncCalendar(db, PROFILE, instances, { calendarName: 'Family', nowUtc: '2026-09-01T12:00:00.000Z' });

  const minutesLater = staleness(db, '2026-09-01T13:30:00.000Z');
  assert.equal(minutesLater, 90);
  db.close();
});
