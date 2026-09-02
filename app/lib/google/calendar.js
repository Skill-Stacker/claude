// Reads events from Google Calendar's "Secret address in iCal format" (a
// private basic.ics URL) and keeps a local copy in the events table.
//
// Google regenerates that feed on its own schedule, often hours behind, so
// every read here is paired with `lastChecked`/`staleness` so the rest of
// the app can say "as of ..." instead of pretending the data is live.
//
// Times are resolved from each event's own zone (its TZID, or UTC, or
// floating if it has none), never from the machine's zone. Everything
// written to the database and returned from these functions is UTC ISO text.

import ical from 'node-ical';

export class CalendarError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'CalendarError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

// Default network fetcher. Returns { status, text } for any response that
// completed, and throws for a network-level failure or a timeout (marked
// with .code = 'timeout' so fetchIcs can tell it apart from "unreachable").
async function defaultFetchText(url, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const timeoutErr = new Error('Google Calendar did not answer in time.');
      timeoutErr.code = 'timeout';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Fetches the ICS text at `url`. `fetchText(url, { timeoutMs })` is injected
// for tests; it should return { status, text } for a completed request and
// throw for a network failure or timeout. Always throws a CalendarError with
// a beginner-readable message when the feed cannot be read.
export async function fetchIcs(url, { fetchText = defaultFetchText, timeoutMs = 5000 } = {}) {
  let result;
  try {
    result = await fetchText(url, { timeoutMs });
  } catch (err) {
    if (err && err.code === 'timeout') {
      throw new CalendarError('timeout', 'Google Calendar did not answer in time.');
    }
    throw new CalendarError('unreachable', 'Could not reach Google Calendar. Check the connection and try again.');
  }

  const { status, text } = result || {};

  if (status === 404) {
    throw new CalendarError('not_found', 'Google could not find that calendar address. Check it was copied in full.');
  }
  if (typeof status !== 'number' || status < 200 || status >= 300) {
    throw new CalendarError('http', `Google Calendar returned an error (status ${status}).`);
  }
  if (typeof text !== 'string' || !text.trimStart().startsWith('BEGIN:VCALENDAR')) {
    throw new CalendarError('not_ics', 'That did not look like a calendar file.');
  }
  return text;
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

// Checks that `url` looks like the private "Secret address in iCal format",
// not the public address, the embed address, or a typo. Returns beginner
// readable reasons so the UI can explain what is wrong.
export function validateIcsUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: 'That does not look like a web address.' };
  }

  if (parsed.protocol === 'http:') {
    return { ok: false, reason: 'That address needs to start with https, not http.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'That address needs to start with https.' };
  }
  if (parsed.hostname !== 'calendar.google.com') {
    return { ok: false, reason: 'That needs to be a calendar.google.com address.' };
  }
  if (parsed.pathname.includes('/calendar/embed')) {
    return { ok: false, reason: 'That is the embed address for a website, not the secret iCal address.' };
  }
  if (!parsed.pathname.includes('/calendar/ical/')) {
    return { ok: false, reason: 'That does not look like a Google Calendar iCal address.' };
  }
  if (!parsed.pathname.includes('/private-')) {
    return { ok: false, reason: 'That looks like the public address, not the secret one.' };
  }
  if (!parsed.pathname.endsWith('.ics')) {
    return { ok: false, reason: 'That address should end in .ics.' };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Parsing and expansion
// ---------------------------------------------------------------------------

function textVal(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'val' in v) return textVal(v.val);
  return String(v);
}

// The event's own zone: its IANA TZID, 'UTC' for a Z-stamped time, or
// 'floating' for a date with no zone at all (including all-day dates).
function resolveTzid(dateVal) {
  const tz = dateVal && dateVal.tz;
  if (!tz) return 'floating';
  if (tz === 'Etc/UTC' || tz === 'UTC') return 'UTC';
  return tz;
}

function buildInstance(source, startDate, endDate, calendarName, rruleRaw) {
  const allDay = !!(startDate && startDate.dateOnly) || source.datetype === 'date';
  const startUtc = startDate.toISOString();
  const endUtc = endDate.toISOString();
  return {
    instanceId: `${source.uid}@${startUtc}`,
    uid: source.uid,
    calendarName: calendarName ?? null,
    summary: textVal(source.summary),
    location: textVal(source.location),
    description: textVal(source.description),
    startUtc,
    endUtc,
    allDay,
    tzid: resolveTzid(startDate),
    status: source.status ?? null,
    organizer: textVal(source.organizer),
    rruleRaw: rruleRaw ?? null,
  };
}

function inWindow(date, from, to) {
  const t = date.getTime();
  return t >= from.getTime() && t <= to.getTime();
}

function expandRecurring(master, from, to, calendarName, out) {
  if (master.status === 'CANCELLED') return;
  const rruleRaw = master.rrule.toString();
  const occurrences = master.rrule.between(from, to, true);
  const baseDurationMs = master.end.getTime() - master.start.getTime();

  for (const occ of occurrences) {
    const key = occ.toISOString();
    if (master.exdate && Object.prototype.hasOwnProperty.call(master.exdate, key)) continue;

    const override = master.recurrences && master.recurrences[key];
    if (override) {
      if (override.status === 'CANCELLED') continue;
      out.push(buildInstance(override, override.start, override.end, calendarName, rruleRaw));
      continue;
    }

    const endDate = new Date(occ.getTime() + baseDurationMs);
    out.push(buildInstance(master, occ, endDate, calendarName, rruleRaw));
  }
}

function addSingle(event, from, to, calendarName, out) {
  if (event.status === 'CANCELLED') return;
  if (!inWindow(event.start, from, to)) return;
  out.push(buildInstance(event, event.start, event.end, calendarName, null));
}

// Parses `icsText` (as returned by fetchIcs) and expands every VEVENT into
// concrete instances inside [fromUtc, toUtc]. Handles RRULE expansion,
// EXDATE, RECURRENCE-ID overrides, cancelled events and overrides, all-day
// events, and DTEND/DURATION. Returns instances sorted by start.
export function parseAndExpand(icsText, { fromUtc, toUtc, calendarName = null } = {}) {
  const from = fromUtc instanceof Date ? fromUtc : new Date(fromUtc);
  const to = toUtc instanceof Date ? toUtc : new Date(toUtc);
  const data = ical.sync.parseICS(icsText);
  const out = [];

  for (const entry of Object.values(data)) {
    if (!entry || entry.type !== 'VEVENT') continue;
    // A stray RECURRENCE-ID override that node-ical could not merge into its
    // master (no master present in this feed) has nothing to attach to;
    // normal overrides are already folded into master.recurrences.
    if (entry.recurrenceid && !entry.rrule) continue;
    if (entry.rrule) {
      expandRecurring(entry, from, to, calendarName, out);
    } else {
      addSingle(entry, from, to, calendarName, out);
    }
  }

  out.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  return out;
}

// ---------------------------------------------------------------------------
// Sync (write the parsed instances into the events table)
// ---------------------------------------------------------------------------

const UPSERT_SQL = `
  INSERT INTO events (
    profile_id, instance_id, uid, calendar_name, summary, location, description,
    start_utc, end_utc, all_day, tzid, status, organizer, rrule_raw, last_seen_utc
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, instance_id) DO UPDATE SET
    uid = excluded.uid,
    calendar_name = excluded.calendar_name,
    summary = excluded.summary,
    location = excluded.location,
    description = excluded.description,
    start_utc = excluded.start_utc,
    end_utc = excluded.end_utc,
    all_day = excluded.all_day,
    tzid = excluded.tzid,
    status = excluded.status,
    organizer = excluded.organizer,
    rrule_raw = excluded.rrule_raw,
    last_seen_utc = excluded.last_seen_utc
`;

// Upserts every instance for `calendarName`, then deletes rows for that
// calendar that were not touched this pass (they disappeared from the feed).
// Records when we last checked and last had a good read.
export function syncCalendar(db, profileId, instances, { calendarName, nowUtc }) {
  const now = nowUtc instanceof Date ? nowUtc.toISOString() : String(nowUtc);

  db.transaction(() => {
    for (const inst of instances) {
      db.run(UPSERT_SQL, [
        profileId,
        inst.instanceId,
        inst.uid,
        calendarName ?? inst.calendarName ?? null,
        inst.summary,
        inst.location,
        inst.description,
        inst.startUtc,
        inst.endUtc,
        inst.allDay ? 1 : 0,
        inst.tzid,
        inst.status,
        inst.organizer,
        inst.rruleRaw,
        now,
      ]);
    }

    db.run(
      `DELETE FROM events
       WHERE profile_id = ? AND calendar_name IS ? AND (last_seen_utc IS NULL OR last_seen_utc < ?)`,
      [profileId, calendarName ?? null, now],
    );

    db.setState('calendar:lastChecked', now);
    db.setState('calendar:lastOk', now);
  });

  return { count: instances.length };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function rowToEvent(row) {
  return {
    instanceId: row.instance_id,
    uid: row.uid,
    calendarName: row.calendar_name,
    summary: row.summary,
    location: row.location,
    description: row.description,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    allDay: !!row.all_day,
    tzid: row.tzid,
    status: row.status,
    organizer: row.organizer,
    rruleRaw: row.rrule_raw,
    lastSeenUtc: row.last_seen_utc,
  };
}

// Events that overlap [startUtc, endUtc), ordered by start.
export function listEvents(db, profileId, startUtc, endUtc) {
  const rows = db.all(
    `SELECT * FROM events WHERE profile_id = ? AND start_utc < ? AND end_utc > ? ORDER BY start_utc`,
    [profileId, endUtc, startUtc],
  );
  return rows.map(rowToEvent);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// The next upcoming event at or after nowUtc, ignoring cancelled events. When
// `hint` is given, ranks candidates by cheap token overlap on summary and
// location; falls back to the soonest event when there is no hint or nothing
// overlaps. `matchedByHint` says which path was taken.
export function nextEvent(db, profileId, nowUtc, { hint } = {}) {
  const rows = db.all(
    `SELECT * FROM events
     WHERE profile_id = ? AND start_utc >= ? AND (status IS NULL OR status != 'CANCELLED')
     ORDER BY start_utc`,
    [profileId, nowUtc],
  );
  if (rows.length === 0) return null;
  const events = rows.map(rowToEvent);

  const hintTokens = tokenize(hint);
  if (hintTokens.length > 0) {
    let best = null;
    let bestScore = 0;
    for (const ev of events) {
      const evTokens = new Set(tokenize(`${ev.summary || ''} ${ev.location || ''}`));
      const score = hintTokens.filter((t) => evTokens.has(t)).length;
      if (score > bestScore) {
        bestScore = score;
        best = ev;
      }
    }
    if (best && bestScore > 0) {
      return { ...best, matchedByHint: true };
    }
  }

  return { ...events[0], matchedByHint: false };
}

// Whether [startUtc, endUtc) is free of non-cancelled events, and the list
// of conflicts if not.
export function isFree(db, profileId, startUtc, endUtc) {
  const rows = db.all(
    `SELECT * FROM events
     WHERE profile_id = ? AND start_utc < ? AND end_utc > ? AND (status IS NULL OR status != 'CANCELLED')
     ORDER BY start_utc`,
    [profileId, endUtc, startUtc],
  );
  const conflicts = rows.map(rowToEvent);
  return { free: conflicts.length === 0, conflicts };
}

// The ISO timestamp of the last successful feed read, or null if we have
// never checked.
export function lastChecked(db) {
  return db.getState('calendar:lastChecked', null);
}

// Minutes since the last successful check, or null if we have never checked.
export function staleness(db, nowUtc) {
  const last = db.getState('calendar:lastChecked', null);
  if (!last) return null;
  const now = nowUtc instanceof Date ? nowUtc : new Date(nowUtc);
  const lastDate = new Date(last);
  return (now.getTime() - lastDate.getTime()) / 60000;
}
