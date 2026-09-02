// Background and on-demand sync for Gmail and Google Calendar.
//
// gmail.js and calendar.js are finished modules this file must not edit,
// and their sync_state keys ('gmail:INBOX:lastUid', 'calendar:lastChecked',
// the connection-cap backoff state, ...) are plain strings with no
// profile_id column behind them: on a stick with more than one Google
// connected profile they would collide. scopedDb() is the fix: it wraps the
// shared db so every getState/setState call from those two modules lands on
// a key prefixed with the profile id, while every other method (run, get,
// all, transaction, the real profile_id-scoped tables) passes straight
// through unchanged.
//
// Usage:
//   import { createSync } from './sync.js';
//   const sync = createSync({ db, paths, bus, netlog, fetchText, imapFactory });
//   sync.start();
//   await sync.now(1, 'gmail');
//   // ... later, from the wiring function that has `app`:
//   app.registerShutdown(() => sync.stop());

import { getProfile, listProfiles, readSecrets } from '../profiles.js';
import { GmailError, classifyError, withImap, syncMailbox, capBackoff } from './gmail.js';
import { CalendarError, fetchIcs, parseAndExpand, syncCalendar, lastChecked, staleness } from './calendar.js';

const STAGGER_MS = 250;
const CALENDAR_PAST_DAYS = 1;
const CALENDAR_FUTURE_DAYS = 60;
const CALENDAR_TIMEOUT_MS = 5000;

// See the file header: getState/setState only, everything else is the same
// shared db.js wrapper untouched.
export function scopedDb(db, profileId) {
  const prefix = `p${profileId}:`;
  return {
    raw: db.raw,
    run: (sql, params) => db.run(sql, params),
    get: (sql, params) => db.get(sql, params),
    all: (sql, params) => db.all(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
    getState: (key, fallback) => db.getState(prefix + key, fallback),
    setState: (key, value) => db.setState(prefix + key, value),
  };
}

export function createSync({
  db,
  paths,
  bus,
  netlog,
  fetchText,
  imapFactory,
  now = () => Date.now(),
  timers = { gmailMs: 180000, calendarMs: 2700000 },
  // Not part of the documented signature, but needed for sync.test.js's fake
  // clock: real timer functions by default, swappable for a fake in tests.
  setInterval: setIntervalFn = globalThis.setInterval,
  clearInterval: clearIntervalFn = globalThis.clearInterval,
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  const nowFn = typeof now === 'function' ? now : () => now;
  const imapOpts = () => (imapFactory ? { ImapFlowClass: imapFactory } : {});

  const gmailInFlight = new Set();
  const calendarInFlight = new Set();
  const stoppedGmail = new Set(); // profile ids paused after an auth failure
  const gmailLastError = new Map();
  const calendarLastError = new Map();

  const scheduled = new Map(); // "gmail:<id>" | "calendar:<id>" -> { kickoff, interval }
  let started = false;

  function publish(profileId, what, phase, { done = null, total = null, message = null, kind } = {}) {
    const payload = { profileId, what, phase, done, total, message };
    if (kind) payload.kind = kind;
    if (bus) bus.publish('sync', payload);
  }

  // ---- gmail ----------------------------------------------------------

  async function runGmailSync(profileId) {
    if (gmailInFlight.has(profileId)) return { ok: false, error: 'in_flight' };
    const profile = getProfile(db, profileId);
    if (!profile) return { ok: false, error: 'no_profile' };
    const secrets = readSecrets(paths.profiles, profile);
    if (!secrets.gmail) return { ok: false, error: 'not_connected' };

    const sdb = scopedDb(db, profileId);
    const backoff = capBackoff(sdb);
    const nowIso = new Date(nowFn()).toISOString();
    if (backoff.shouldWait(nowIso)) {
      publish(profileId, 'gmail', 'error', {
        kind: 'connection_cap',
        message: 'Gmail asked Scout to wait before connecting again.',
      });
      return { ok: false, error: 'connection_cap' };
    }

    gmailInFlight.add(profileId);
    publish(profileId, 'gmail', 'start', {});
    const creds = { email: secrets.gmail.address, appPassword: secrets.gmail.appPassword };

    try {
      const result = await withImap(
        creds,
        (client) =>
          syncMailbox({
            db: sdb,
            profileId,
            client,
            folder: 'INBOX',
            nowUtc: nowIso,
            onProgress: (p) => publish(profileId, 'gmail', 'progress', { done: p.done, total: p.total }),
          }),
        imapOpts(),
      );
      netlog.record({ kind: 'imap', host: 'imap.gmail.com', purpose: 'checking your inbox', ok: true });
      gmailLastError.delete(profileId);
      stoppedGmail.delete(profileId);
      publish(profileId, 'gmail', 'done', { done: result.done, total: result.total });
      return { ok: true };
    } catch (err) {
      const classified = err instanceof GmailError ? err : classifyError(err);
      netlog.record({
        kind: 'imap',
        host: 'imap.gmail.com',
        purpose: 'checking your inbox',
        ok: false,
        detail: classified.message,
      });
      if (classified.kind === 'connection_cap') backoff.recordAttempt(nowIso);
      // A timeout is logged and simply retried on the next tick, nothing
      // special to do here beyond reporting it below; only an auth failure
      // stops the poller outright.
      if (classified.kind === 'auth') stoppedGmail.add(profileId);
      const message = classified.userMessage || classified.message;
      gmailLastError.set(profileId, message);
      publish(profileId, 'gmail', 'error', { kind: classified.kind, message });
      return { ok: false, error: classified.kind };
    } finally {
      gmailInFlight.delete(profileId);
    }
  }

  function pollGmail(profileId) {
    if (stoppedGmail.has(profileId)) return;
    runGmailSync(profileId).catch(() => {});
  }

  // ---- calendar ---------------------------------------------------------

  async function runCalendarSync(profileId) {
    if (calendarInFlight.has(profileId)) return { ok: false, error: 'in_flight' };
    const profile = getProfile(db, profileId);
    if (!profile) return { ok: false, error: 'no_profile' };
    const secrets = readSecrets(paths.profiles, profile);
    if (!secrets.calendar) return { ok: false, error: 'not_connected' };

    const sdb = scopedDb(db, profileId);
    calendarInFlight.add(profileId);
    publish(profileId, 'calendar', 'start', {});

    try {
      const icsText = await fetchIcs(secrets.calendar.icsUrl, { fetchText, timeoutMs: CALENDAR_TIMEOUT_MS });
      netlog.record({ kind: 'https', host: 'calendar.google.com', purpose: 'checking your calendar', ok: true });

      const nowMs = nowFn();
      const fromUtc = new Date(nowMs - CALENDAR_PAST_DAYS * 86400000);
      const toUtc = new Date(nowMs + CALENDAR_FUTURE_DAYS * 86400000);
      const calendarName = secrets.calendar.calendarName || null;
      const instances = parseAndExpand(icsText, { fromUtc, toUtc, calendarName });
      const result = syncCalendar(sdb, profileId, instances, { calendarName, nowUtc: new Date(nowMs) });

      calendarLastError.delete(profileId);
      publish(profileId, 'calendar', 'done', { done: result.count, total: result.count });
      return { ok: true };
    } catch (err) {
      const classified = err instanceof CalendarError ? err : new CalendarError('unknown', err && err.message);
      netlog.record({
        kind: 'https',
        host: 'calendar.google.com',
        purpose: 'checking your calendar',
        ok: false,
        detail: classified.message,
      });
      calendarLastError.set(profileId, classified.message);
      publish(profileId, 'calendar', 'error', { kind: classified.kind, message: classified.message });
      return { ok: false, error: classified.kind };
    } finally {
      calendarInFlight.delete(profileId);
    }
  }

  function pollCalendar(profileId) {
    runCalendarSync(profileId).catch(() => {});
  }

  // Google's feed lags anyway, so an on-demand calendar check gives up
  // after CALENDAR_TIMEOUT_MS rather than making the caller wait on a slow
  // feed; never rejects, always resolves { ok, error }.
  function calendarWithTimeout(profileId) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeoutFn(() => {
        if (settled) return;
        settled = true;
        publish(profileId, 'calendar', 'error', {
          kind: 'timeout',
          message: 'Google Calendar took too long to answer.',
        });
        resolve({ ok: false, error: 'timeout' });
      }, CALENDAR_TIMEOUT_MS);

      runCalendarSync(profileId).then(
        (res) => {
          if (settled) return;
          settled = true;
          clearTimeoutFn(timer);
          resolve(res);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeoutFn(timer);
          resolve({ ok: false, error: (err && err.message) || 'unknown' });
        },
      );
    });
  }

  // ---- scheduling ---------------------------------------------------------

  // Idempotent: safe to call again for a profile already scheduled (used
  // both at start() and opportunistically after now(), so a profile that
  // just connected joins the running schedule without a restart).
  function scheduleProfile(profile, secrets) {
    if (secrets.gmail && !scheduled.has(`gmail:${profile.id}`)) {
      const delay = STAGGER_MS * scheduled.size;
      const kickoff = setTimeoutFn(() => pollGmail(profile.id), delay);
      const interval = setIntervalFn(() => pollGmail(profile.id), timers.gmailMs);
      scheduled.set(`gmail:${profile.id}`, { kickoff, interval });
    }
    if (secrets.calendar && !scheduled.has(`calendar:${profile.id}`)) {
      const delay = STAGGER_MS * scheduled.size;
      const kickoff = setTimeoutFn(() => pollCalendar(profile.id), delay);
      const interval = setIntervalFn(() => pollCalendar(profile.id), timers.calendarMs);
      scheduled.set(`calendar:${profile.id}`, { kickoff, interval });
    }
  }

  function start() {
    if (started) return;
    started = true;
    for (const profile of listProfiles(db)) {
      scheduleProfile(profile, readSecrets(paths.profiles, profile));
    }
  }

  function stop() {
    started = false;
    for (const { kickoff, interval } of scheduled.values()) {
      clearTimeoutFn(kickoff);
      clearIntervalFn(interval);
    }
    scheduled.clear();
  }

  async function syncNow(profileId, what) {
    const results = {};
    if (what === 'gmail' || what === 'both') {
      // An explicit request always gets a real attempt, even if a previous
      // auth failure paused the periodic poller for this profile: this is
      // exactly the "credentials saved again" signal that should lift it.
      stoppedGmail.delete(profileId);
      results.gmail = await runGmailSync(profileId);
    }
    if (what === 'calendar' || what === 'both') {
      results.calendar = await calendarWithTimeout(profileId);
    }

    if (started) {
      const profile = getProfile(db, profileId);
      if (profile) scheduleProfile(profile, readSecrets(paths.profiles, profile));
    }

    const ok = Object.values(results).every((r) => r && r.ok);
    return { ok, ...results };
  }

  function status(profileId) {
    const sdb = scopedDb(db, profileId);
    const nowIso = new Date(nowFn()).toISOString();
    return {
      gmail: {
        lastChecked: sdb.getState('gmail:lastChecked', null),
        backfillComplete: !!sdb.getState('gmail:INBOX:backfillComplete', false),
        inFlight: gmailInFlight.has(profileId),
        error: gmailLastError.get(profileId) || null,
      },
      calendar: {
        lastChecked: lastChecked(sdb),
        staleMinutes: staleness(sdb, nowIso),
        inFlight: calendarInFlight.has(profileId),
        error: calendarLastError.get(profileId) || null,
      },
    };
  }

  // For brain.js's draft and send paths: reads secrets fresh on every call
  // so a disconnect between calls is honored, never cached at start().
  function createGmailSession(profileId) {
    const profile = getProfile(db, profileId);
    if (!profile) return null;
    const secrets = readSecrets(paths.profiles, profile);
    if (!secrets.gmail) return null;
    const creds = { email: secrets.gmail.address, appPassword: secrets.gmail.appPassword };
    return {
      creds,
      folders: secrets.gmail.folders || null,
      withImap: (fn, opts = {}) => withImap(creds, fn, { ...imapOpts(), ...opts }),
    };
  }

  return { start, stop, now: syncNow, status, createGmailSession };
}
