// Wires the Google connect wizard, the on-demand sync trigger, and the read
// routes over the local cache (mail, calendar, contacts) onto the app
// server. All real work (IMAP/SMTP, the ICS feed, the local cache queries,
// the background scheduler) lives in gmail.js, calendar.js, contacts.js and
// sync.js; this file is the HTTP shape and the plain-language error text
// around them.
//
// Usage:
//   import { wireGoogle } from './routes.js';
//   wireGoogle(app, { db, paths, lockManager, sync, fetchText, imapFactory });

import { getProfile, readSecrets, writeSecrets, hasPin, hasGoogleConnected } from '../profiles.js';
import {
  GmailError,
  classifyError,
  withImap,
  discoverFolders,
  verifyCredentials,
  threadMessages,
} from './gmail.js';
import { validateAppPassword, accountKind } from './mime.js';
import { CalendarError, validateIcsUrl, fetchIcs, parseAndExpand, listEvents } from './calendar.js';
import { addContact, listContacts, removeContact } from './contacts.js';

const CALENDAR_VERIFY_MESSAGES = {
  not_found:
    'That link does not look right, go back to Calendar settings and copy the Secret address again, the whole thing.',
  not_ics: 'That address answered with something that is not a calendar.',
};

const AUTH_QUESTION =
  'Did Google actually show you a 16-character password to copy, or did that option never appear?';

const CALENDAR_VERIFY_WINDOW_DAYS = 60;

function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function parseProfileId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

// A one-line, unfolded read of X-WR-CALNAME; good enough for the calendar
// display name Google Calendar always emits on a single line in this feed.
function extractCalendarName(icsText) {
  const m = /^X-WR-CALNAME:(.*)$/im.exec(String(icsText || ''));
  const name = m ? m[1].trim() : '';
  return name || null;
}

function calendarErrorReply(err) {
  const classified = err instanceof CalendarError ? err : new CalendarError('unknown', (err && err.message) || 'unknown error');
  const message = CALENDAR_VERIFY_MESSAGES[classified.kind] || classified.message;
  return { classified, body: { ok: false, kind: classified.kind, message } };
}

export function wireGoogle(app, { db, paths, lockManager, sync, fetchText, imapFactory, transportFactory } = {}) {
  // transportFactory is not part of the documented wireGoogle signature; it
  // is accepted so tests can fake the SMTP half of gmail/verify the same
  // way imapFactory fakes the IMAP half (see gmail.js's own verifyCredentials
  // tests). Production wiring simply omits it and gmail.js uses nodemailer.
  const imapOpts = () => (imapFactory ? { ImapFlowClass: imapFactory } : {});
  const verifyOpts = () => ({
    ...(imapFactory ? { ImapFlowClass: imapFactory } : {}),
    ...(transportFactory ? { transportFactory } : {}),
  });

  app.registerShutdown(() => sync.stop());

  function requireProfile(ctx, profileId) {
    const profile = getProfile(db, profileId);
    if (!profile) {
      ctx.sendJson(404, { error: 'not_found', message: 'No profile with that id.' });
      return null;
    }
    return profile;
  }

  function requireProfileId(ctx, raw) {
    const profileId = parseProfileId(raw);
    if (profileId == null) {
      ctx.sendJson(400, { error: 'bad_request', message: 'profileId is required.' });
      return null;
    }
    return profileId;
  }

  function ensureUnlocked(ctx, profile) {
    if (hasGoogleConnected(paths.profiles, profile) && !lockManager.isUnlocked(profile.id)) {
      ctx.sendJson(423, { error: 'locked', message: 'Unlock this profile with its pin first.' });
      return false;
    }
    return true;
  }

  // ---- status -----------------------------------------------------------

  app.addRoute('GET', '/api/google/status', (req, res, ctx) => {
    const profileId = requireProfileId(ctx, ctx.query.get('profileId'));
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;
    if (!ensureUnlocked(ctx, profile)) return;

    const secrets = readSecrets(paths.profiles, profile);
    const s = sync.status(profile.id);
    ctx.sendJson(200, {
      gmail: {
        connected: !!secrets.gmail,
        address: secrets.gmail ? secrets.gmail.address : null,
        lastChecked: s.gmail.lastChecked,
        backfillComplete: s.gmail.backfillComplete,
        error: s.gmail.error,
      },
      calendar: {
        connected: !!secrets.calendar,
        lastChecked: s.calendar.lastChecked,
        staleMinutes: s.calendar.staleMinutes,
        error: s.calendar.error,
      },
    });
  });

  // ---- gmail --------------------------------------------------------------

  app.addRoute('POST', '/api/google/gmail/verify', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;
    if (!ensureUnlocked(ctx, profile)) return;

    const address = String(body.address || '').trim();
    const passCheck = validateAppPassword(body.appPassword);
    if (!passCheck.ok) {
      ctx.netlog.record({
        kind: 'imap',
        host: 'imap.gmail.com',
        purpose: 'checking your Gmail login',
        ok: false,
        detail: passCheck.reason,
      });
      return ctx.sendJson(200, {
        ok: false,
        kind: 'bad_password',
        message: `That does not look like an app password: ${passCheck.reason}.`,
      });
    }

    const kind = accountKind(address);
    try {
      const result = await verifyCredentials({ email: address, appPassword: passCheck.cleaned }, verifyOpts());
      ctx.netlog.record({ kind: 'imap', host: 'imap.gmail.com', purpose: 'checking your Gmail login', ok: true });
      return ctx.sendJson(200, { ok: true, folders: result.folders, accountKind: kind });
    } catch (err) {
      const classified = err instanceof GmailError ? err : classifyError(err);
      ctx.netlog.record({
        kind: 'imap',
        host: 'imap.gmail.com',
        purpose: 'checking your Gmail login',
        ok: false,
        detail: classified.message,
      });

      let message = classified.userMessage || classified.message;
      let question;
      if (classified.kind === 'auth') {
        if (kind === 'workspace') {
          message = `A school or work Google account can have app passwords turned off by an administrator. ${message}`;
        }
        question = AUTH_QUESTION;
      }
      return ctx.sendJson(200, { ok: false, kind: classified.kind, message, question });
    }
  });

  app.addRoute('POST', '/api/google/gmail/save', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;
    if (!hasPin(profile)) {
      return ctx.sendJson(409, { error: 'no_pin', message: 'Set a pin for this profile before connecting Google.' });
    }
    if (!ensureUnlocked(ctx, profile)) return;

    const address = String(body.address || '').trim();
    const passCheck = validateAppPassword(body.appPassword);
    if (!passCheck.ok) {
      return ctx.sendJson(200, { ok: false, kind: 'bad_password', message: passCheck.reason });
    }

    let folders = body.folders || null;
    if (!folders) {
      try {
        folders = await withImap(
          { email: address, appPassword: passCheck.cleaned },
          (client) => discoverFolders(client),
          imapOpts(),
        );
        ctx.netlog.record({ kind: 'imap', host: 'imap.gmail.com', purpose: 'checking your Gmail login', ok: true });
      } catch (err) {
        const classified = err instanceof GmailError ? err : classifyError(err);
        ctx.netlog.record({
          kind: 'imap',
          host: 'imap.gmail.com',
          purpose: 'checking your Gmail login',
          ok: false,
          detail: classified.message,
        });
        return ctx.sendJson(200, { ok: false, kind: classified.kind, message: classified.userMessage || classified.message });
      }
    }

    const secrets = readSecrets(paths.profiles, profile);
    secrets.gmail = { address, appPassword: passCheck.cleaned, folders, savedUtc: new Date().toISOString() };
    writeSecrets(paths.profiles, profile, secrets);

    // Kicks off the first sync in the background; the caller does not wait
    // on it, and any error it hits is reported through the sync bus event.
    sync.now(profile.id, 'gmail').catch(() => {});

    ctx.sendJson(200, { ok: true });
  });

  app.addRoute('POST', '/api/google/gmail/disconnect', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;
    if (!ensureUnlocked(ctx, profile)) return;

    const secrets = readSecrets(paths.profiles, profile);
    delete secrets.gmail;
    writeSecrets(paths.profiles, profile, secrets);

    db.run('DELETE FROM messages WHERE profile_id = ?', [profileId]);
    db.run('DELETE FROM threads WHERE profile_id = ?', [profileId]);
    db.run('DELETE FROM sync_state WHERE key LIKE ?', [`p${profileId}:gmail:%`]);

    ctx.sendJson(200, { ok: true });
  });

  // ---- calendar -----------------------------------------------------------

  app.addRoute('POST', '/api/google/calendar/verify', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;
    if (!ensureUnlocked(ctx, profile)) return;

    const urlCheck = validateIcsUrl(body.icsUrl);
    if (!urlCheck.ok) {
      ctx.netlog.record({
        kind: 'https',
        host: 'calendar.google.com',
        purpose: 'checking your calendar link',
        ok: false,
        detail: urlCheck.reason,
      });
      return ctx.sendJson(200, { ok: false, kind: 'bad_url', message: urlCheck.reason });
    }

    try {
      const icsText = await fetchIcs(body.icsUrl, { fetchText, timeoutMs: 5000 });
      ctx.netlog.record({ kind: 'https', host: 'calendar.google.com', purpose: 'checking your calendar link', ok: true });

      const nowMs = Date.now();
      const instances = parseAndExpand(icsText, {
        fromUtc: new Date(nowMs),
        toUtc: new Date(nowMs + CALENDAR_VERIFY_WINDOW_DAYS * 86400000),
      });
      return ctx.sendJson(200, { ok: true, upcoming: instances.length, calendarName: extractCalendarName(icsText) });
    } catch (err) {
      const { classified, body: reply } = calendarErrorReply(err);
      ctx.netlog.record({
        kind: 'https',
        host: 'calendar.google.com',
        purpose: 'checking your calendar link',
        ok: false,
        detail: classified.message,
      });
      return ctx.sendJson(200, reply);
    }
  });

  app.addRoute('POST', '/api/google/calendar/save', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;
    if (!hasPin(profile)) {
      return ctx.sendJson(409, { error: 'no_pin', message: 'Set a pin for this profile before connecting Google.' });
    }
    if (!ensureUnlocked(ctx, profile)) return;

    const urlCheck = validateIcsUrl(body.icsUrl);
    if (!urlCheck.ok) {
      return ctx.sendJson(200, { ok: false, kind: 'bad_url', message: urlCheck.reason });
    }

    let calendarName;
    try {
      const icsText = await fetchIcs(body.icsUrl, { fetchText, timeoutMs: 5000 });
      ctx.netlog.record({ kind: 'https', host: 'calendar.google.com', purpose: 'checking your calendar link', ok: true });
      calendarName = extractCalendarName(icsText);
    } catch (err) {
      const { classified, body: reply } = calendarErrorReply(err);
      ctx.netlog.record({
        kind: 'https',
        host: 'calendar.google.com',
        purpose: 'checking your calendar link',
        ok: false,
        detail: classified.message,
      });
      return ctx.sendJson(200, reply);
    }

    const secrets = readSecrets(paths.profiles, profile);
    secrets.calendar = { icsUrl: body.icsUrl, calendarName };
    writeSecrets(paths.profiles, profile, secrets);

    sync.now(profile.id, 'calendar').catch(() => {});

    ctx.sendJson(200, { ok: true, calendarName });
  });

  app.addRoute('POST', '/api/google/calendar/disconnect', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;
    if (!ensureUnlocked(ctx, profile)) return;

    const secrets = readSecrets(paths.profiles, profile);
    delete secrets.calendar;
    writeSecrets(paths.profiles, profile, secrets);

    db.run('DELETE FROM events WHERE profile_id = ?', [profileId]);
    db.run('DELETE FROM sync_state WHERE key LIKE ?', [`p${profileId}:calendar:%`]);

    ctx.sendJson(200, { ok: true });
  });

  // ---- sync trigger -------------------------------------------------------

  app.addRoute('POST', '/api/google/sync', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;
    if (!ensureUnlocked(ctx, profile)) return;

    const what = body.what;
    if (what !== 'gmail' && what !== 'calendar' && what !== 'both') {
      return ctx.sendJson(400, { error: 'bad_request', message: "what must be 'gmail', 'calendar' or 'both'." });
    }

    const result = await sync.now(profile.id, what);
    ctx.sendJson(200, result);
  });

  // ---- reads over the cache -------------------------------------------------

  app.addRoute('GET', '/api/calendar/events', (req, res, ctx) => {
    const profileId = requireProfileId(ctx, ctx.query.get('profileId'));
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;
    if (!ensureUnlocked(ctx, profile)) return;

    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return ctx.sendJson(400, { error: 'bad_request', message: 'from and to must both be valid dates.' });
    }

    const events = listEvents(db, profileId, from, to);
    const s = sync.status(profileId).calendar;
    ctx.sendJson(200, { asOf: s.lastChecked, staleMinutes: s.staleMinutes, events });
  });

  app.addRoute('GET', '/api/mail/threads', (req, res, ctx) => {
    const profileId = requireProfileId(ctx, ctx.query.get('profileId'));
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;
    if (!ensureUnlocked(ctx, profile)) return;

    const limitRaw = Number(ctx.query.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

    const rows = db.all(
      'SELECT * FROM threads WHERE profile_id = ? ORDER BY last_date_utc DESC LIMIT ?',
      [profileId, limit],
    );
    const threads = rows.map((row) => ({ ...row, participants: safeJsonParse(row.participants, []) }));
    const s = sync.status(profileId).gmail;
    ctx.sendJson(200, { asOf: s.lastChecked, threads });
  });

  app.addRoute('GET', '/api/mail/thread', (req, res, ctx) => {
    const profileId = requireProfileId(ctx, ctx.query.get('profileId'));
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;
    if (!ensureUnlocked(ctx, profile)) return;

    const id = ctx.query.get('id');
    if (!id) return ctx.sendJson(400, { error: 'bad_request', message: 'id is required.' });

    const limitRaw = Number(ctx.query.get('limit'));
    const last = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 200;

    const messages = threadMessages(db, profileId, id, { last, cap: 1000 });
    ctx.sendJson(200, { messages });
  });

  // ---- contacts -------------------------------------------------------------
  // Local address book, not gated behind the Google lock: it holds no
  // Google credentials or synced mail/calendar content.

  app.addRoute('GET', '/api/contacts', (req, res, ctx) => {
    const profileId = requireProfileId(ctx, ctx.query.get('profileId'));
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;

    ctx.sendJson(200, { contacts: listContacts(db, profileId) });
  });

  app.addRoute('POST', '/api/contacts', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;

    try {
      const contact = addContact(db, profileId, { name: body.name, address: body.address });
      ctx.sendJson(200, { ok: true, contact });
    } catch (err) {
      ctx.sendJson(400, { ok: false, message: err.message });
    }
  });

  app.addRoute('POST', '/api/contacts/remove', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profileId = requireProfileId(ctx, body.profileId);
    if (profileId == null) return;
    const profile = requireProfile(ctx, profileId);
    if (!profile) return;

    const removed = removeContact(db, profileId, body.address);
    ctx.sendJson(200, { ok: removed });
  });
}
