// Gmail connector: IMAP for reading and caching, SMTP for sending. Reached
// with a Google App Password, no OAuth. Every network call runs under a
// hard timeout that kills the socket outright, because this has to survive
// a laptop going to sleep mid-connection and waking up later. A fresh
// connection is made per poll and closed right after; nothing here keeps a
// long-lived connection open.
//
// Usage:
//   import { withImap, verifyCredentials, syncMailbox } from './gmail.js';
//   const { ok, folders } = await verifyCredentials({ email, appPassword });
//   await withImap({ email, appPassword }, async (client) => {
//     const folders = await discoverFolders(client);
//     await syncMailbox({ db, profileId, client, folder: folders.inbox });
//   });

import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { buildMessageId, buildReplyMime, htmlToText, snippetOf, validateAppPassword } from './mime.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const DEFAULT_USER_MESSAGES = {
  auth:
    'Gmail did not accept that address and app password. The password may be mistyped, ' +
    '2-Step Verification may be turned off, or a school or work account may have app passwords ' +
    'turned off. Changing the Google account password also cancels every app password, so a new ' +
    'one would need to be created.',
  connection_cap: 'Gmail thinks too many things are connected right now. Scout will keep trying quietly.',
  timeout: 'Gmail took too long to answer, so Scout stopped waiting. It will try again on its own.',
  network: 'Scout could not reach Gmail. Check the internet connection and try again.',
  folders: 'Scout could not find a folder it needs in this Gmail account.',
  unknown: 'Something went wrong talking to Gmail. Scout will try again on its own.',
};

export class GmailError extends Error {
  constructor(kind, message, { userMessage, cause } = {}) {
    super(message || DEFAULT_USER_MESSAGES[kind] || 'Gmail error');
    this.name = 'GmailError';
    this.kind = kind;
    this.userMessage = userMessage || DEFAULT_USER_MESSAGES[kind] || DEFAULT_USER_MESSAGES.unknown;
    if (cause) this.cause = cause;
  }
}

const AUTH_TEXT_PATTERNS = [
  /authenticationfailed/i,
  /invalid credentials/i,
  /application-specific password required/i,
  /username and password not accepted/i,
];

const CONNECTION_CAP_PATTERNS = [/too many simultaneous connections/i];

const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ECONNECTION', 'ESOCKET']);

function textOf(err) {
  if (!err) return '';
  return [err.message, err.response, err.responseText, err.reason].filter(Boolean).join('\n');
}

// Classifies a raw imapflow/nodemailer error into a GmailError. Never
// produces kind 'timeout': that kind is only ever raised directly by our own
// hard-timeout wrapper below, since a caught network timeout code here means
// the far end genuinely reported a timeout, not that we gave up waiting.
export function classifyError(err) {
  if (err instanceof GmailError) return err;
  const text = textOf(err);
  const code = err && err.code;

  if ((err && err.authenticationFailed) || code === 'EAUTH' || AUTH_TEXT_PATTERNS.some((re) => re.test(text))) {
    return new GmailError('auth', (err && err.message) || 'authentication failed', { cause: err });
  }
  if (CONNECTION_CAP_PATTERNS.some((re) => re.test(text))) {
    return new GmailError('connection_cap', (err && err.message) || 'too many simultaneous connections', { cause: err });
  }
  if (code && NETWORK_CODES.has(code)) {
    return new GmailError('network', (err && err.message) || code, { cause: err });
  }
  return new GmailError('unknown', (err && err.message) || 'unknown Gmail error', { cause: err });
}

// ---------------------------------------------------------------------------
// Timeouts that destroy the socket
// ---------------------------------------------------------------------------

export const DEFAULT_IMAP_TIMEOUT_MS = 15000;
export const DEFAULT_SMTP_TIMEOUT_MS = 20000;

function runWithHardTimeout(fn, ms, { onTimeout, label } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (onTimeout) onTimeout();
      } catch {
        // best-effort socket kill, nothing to do if it also fails
      }
      reject(new GmailError('timeout', `${label || 'operation'} timed out after ${ms}ms`));
    }, ms);

    Promise.resolve()
      .then(fn)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ---------------------------------------------------------------------------
// IMAP client
// ---------------------------------------------------------------------------

// Builds (but does not connect) an imapflow client wired for Gmail. The
// caller (withImap, or a test) drives connect()/logout() itself.
export function makeImapClient(creds, { ImapFlowClass = ImapFlow, logger = false, timeoutMs = DEFAULT_IMAP_TIMEOUT_MS } = {}) {
  const { cleaned: pass } = validateAppPassword(creds && creds.appPassword);
  return new ImapFlowClass({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: (creds && creds.email) || '', pass },
    logger,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
}

// Connects, runs fn(client), always logs out, and maps every failure to a
// GmailError. The whole call (connect included) shares one timeout budget;
// a caller doing unusually large work (a big first-run backfill) should pass
// a larger opts.timeoutMs rather than expect this to scale itself.
export async function withImap(creds, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_IMAP_TIMEOUT_MS;
  const client = makeImapClient(creds, { ...opts, timeoutMs });

  try {
    const result = await runWithHardTimeout(async () => {
      await client.connect();
      return fn(client);
    }, timeoutMs, { label: 'IMAP', onTimeout: () => client.close() });
    return result;
  } catch (err) {
    throw err instanceof GmailError ? err : classifyError(err);
  } finally {
    try {
      await client.logout();
    } catch {
      // the socket may already be dead (timeout, or the server hung up); a
      // failed logout after a failed operation is not itself an error
    }
  }
}

// ---------------------------------------------------------------------------
// Folder discovery
// ---------------------------------------------------------------------------

// Finds Gmail's special-use folders by RFC 6154 attribute, never by name:
// Gmail's own folder names are localized ("[Gmail]/Todos" in French, etc.).
export async function discoverFolders(client) {
  let mailboxes;
  try {
    mailboxes = await client.list();
  } catch (err) {
    throw classifyError(err);
  }

  const bySpecialUse = (flag) => mailboxes.find((m) => m.specialUse === flag);
  const all = bySpecialUse('\\All');
  const sent = bySpecialUse('\\Sent');
  const drafts = bySpecialUse('\\Drafts');
  const trash = bySpecialUse('\\Trash');

  const missing = [];
  if (!all) missing.push('All Mail');
  if (!sent) missing.push('Sent');
  if (!drafts) missing.push('Drafts');
  if (!trash) missing.push('Trash');

  if (missing.length) {
    throw new GmailError('folders', `Gmail did not report a special-use folder for: ${missing.join(', ')}`, {
      userMessage: `Scout could not find the ${missing.join(', ')} folder in this Gmail account.`,
    });
  }

  return { all: all.path, sent: sent.path, drafts: drafts.path, trash: trash.path, inbox: 'INBOX' };
}

// ---------------------------------------------------------------------------
// Credential verification
// ---------------------------------------------------------------------------

function smtpOptions(creds, timeoutMs = DEFAULT_SMTP_TIMEOUT_MS) {
  const { cleaned: pass } = validateAppPassword(creds && creds.appPassword);
  return {
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: (creds && creds.email) || '', pass },
    connectionTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  };
}

function defaultTransportFactory(options) {
  return createTransport(options);
}

function runSmtpWithHardTimeout(fn, ms, transport) {
  return runWithHardTimeout(fn, ms, {
    label: 'SMTP',
    onTimeout: () => transport.close(),
  });
}

// A real IMAP login plus an SMTP verify(). Both have to succeed for the
// credentials to be considered good, since Scout needs both to read and to
// send.
export async function verifyCredentials(creds, opts = {}) {
  const folders = await withImap(creds, (client) => discoverFolders(client), opts);

  const transportFactory = opts.transportFactory || defaultTransportFactory;
  const timeoutMs = opts.smtpTimeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS;
  const transport = transportFactory(smtpOptions(creds, timeoutMs));

  try {
    await runSmtpWithHardTimeout(() => transport.verify(), timeoutMs, transport);
  } catch (err) {
    throw err instanceof GmailError ? err : classifyError(err);
  } finally {
    try {
      transport.close();
    } catch {
      // already closed by the timeout handler, or never opened
    }
  }

  return { ok: true, folders };
}

// ---------------------------------------------------------------------------
// Mailbox sync
// ---------------------------------------------------------------------------

const FETCH_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  labels: true,
  threadId: true,
  emailId: true,
  size: true,
};

function isWithinDays(date, nowUtc, days) {
  if (!date) return false;
  const d = new Date(date).getTime();
  const now = new Date(nowUtc).getTime();
  if (Number.isNaN(d) || Number.isNaN(now)) return false;
  return now - d <= days * 86400000;
}

// Walks a fetched bodyStructure tree and returns the leaf text/plain and
// text/html nodes, each carrying the BODYPART identifier download() needs.
function collectTextParts(node, path = []) {
  if (!node) return [];
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    return node.childNodes.flatMap((child, i) => collectTextParts(child, [...path, i + 1]));
  }
  const type = String(node.type || '').toLowerCase();
  if (type === 'text/plain' || type === 'text/html') {
    return [{ type, part: node.part || (path.length ? path.join('.') : '1') }];
  }
  return [];
}

function nodeEncodingFor(charset) {
  const c = String(charset || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (c === 'utf8' || c === 'usascii' || c === 'ascii' || c === '') return 'utf8';
  if (c === 'iso88591' || c === 'latin1' || c === 'windows1252') return 'latin1';
  if (c === 'utf16le' || c === 'ucs2') return 'utf16le';
  return 'utf8';
}

async function readDownloadStream(downloadResult, byteLimit) {
  const { content, meta } = downloadResult;
  const chunks = [];
  let total = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= byteLimit) break;
  }
  const buf = Buffer.concat(chunks);
  const encoding = nodeEncodingFor(meta && meta.charset);
  try {
    return buf.toString(encoding);
  } catch {
    return buf.toString('utf8');
  }
}

// Downloads the best (text/plain over text/html) text part of a message and
// returns it as plain text, capped to bodyCap characters. Empty string if
// the message has no text part at all (an image-only message, say).
async function downloadBestText(client, msg, bodyCap) {
  const parts = collectTextParts(msg.bodyStructure);
  const chosen = parts.find((p) => p.type === 'text/plain') || parts.find((p) => p.type === 'text/html');
  if (!chosen) return '';

  let downloaded;
  try {
    downloaded = await client.download(msg.uid, chosen.part, { uid: true, maxBytes: Math.max(bodyCap * 4, 8192) });
  } catch {
    return '';
  }

  let text = await readDownloadStream(downloaded, Math.max(bodyCap * 4, 8192));
  if (chosen.type === 'text/html') text = htmlToText(text);
  return text.slice(0, bodyCap);
}

function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function upsertMessage(db, profileId, folder, m, bodyCap) {
  const from = (m.envelope && m.envelope.from && m.envelope.from[0]) || {};
  const toList = ((m.envelope && m.envelope.to) || []).map((a) => a.address).filter(Boolean);
  const flags = m.flags instanceof Set ? m.flags : new Set();
  const isUnread = flags.has('\\Seen') ? 0 : 1;
  const isFlagged = flags.has('\\Flagged') ? 1 : 0;
  const labels = Array.from(m.labels || []);
  const dateUtc = m.envelope && m.envelope.date ? new Date(m.envelope.date).toISOString() : null;
  const bodyText = (m.bodyText || '').slice(0, bodyCap);
  const nowUtc = new Date().toISOString();

  db.run(
    `INSERT INTO messages (
       profile_id, gm_msgid, gm_thrid, folder, uid, message_id,
       from_name, from_addr, to_addrs, subject, date_utc,
       is_unread, is_flagged, labels, snippet, body_text, size, synced_utc
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, gm_msgid) DO UPDATE SET
       gm_thrid = excluded.gm_thrid,
       folder = excluded.folder,
       uid = excluded.uid,
       message_id = excluded.message_id,
       from_name = excluded.from_name,
       from_addr = excluded.from_addr,
       to_addrs = excluded.to_addrs,
       subject = excluded.subject,
       date_utc = excluded.date_utc,
       is_unread = excluded.is_unread,
       is_flagged = excluded.is_flagged,
       labels = excluded.labels,
       snippet = excluded.snippet,
       body_text = excluded.body_text,
       size = excluded.size,
       synced_utc = excluded.synced_utc`,
    [
      profileId,
      m.emailId != null ? String(m.emailId) : `noid:${folder}:${m.uid}`,
      m.threadId != null ? String(m.threadId) : null,
      folder,
      m.uid,
      (m.envelope && m.envelope.messageId) || null,
      from.name || null,
      from.address || null,
      JSON.stringify(toList),
      (m.envelope && m.envelope.subject) || null,
      dateUtc,
      isUnread,
      isFlagged,
      JSON.stringify(labels),
      snippetOf(bodyText, 200),
      bodyText,
      m.size ?? null,
      nowUtc,
    ]
  );
}

function refreshThreadRollup(db, profileId, gmThrid) {
  if (!gmThrid) return;
  const rows = db.all(
    'SELECT subject, from_addr, to_addrs, is_unread, date_utc, snippet FROM messages WHERE profile_id = ? AND gm_thrid = ? ORDER BY date_utc',
    [profileId, gmThrid]
  );
  if (!rows.length) return;

  const messageCount = rows.length;
  const unreadCount = rows.reduce((n, r) => n + (r.is_unread ? 1 : 0), 0);
  const last = rows[rows.length - 1];

  const participants = new Set();
  for (const r of rows) {
    if (r.from_addr) participants.add(r.from_addr);
    for (const addr of safeJsonParse(r.to_addrs, [])) {
      if (addr) participants.add(addr);
    }
  }

  db.run(
    `INSERT INTO threads (profile_id, gm_thrid, subject, participants, message_count, unread_count, last_date_utc, last_snippet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, gm_thrid) DO UPDATE SET
       subject = excluded.subject,
       participants = excluded.participants,
       message_count = excluded.message_count,
       unread_count = excluded.unread_count,
       last_date_utc = excluded.last_date_utc,
       last_snippet = excluded.last_snippet`,
    [profileId, gmThrid, last.subject || null, JSON.stringify([...participants]), messageCount, unreadCount, last.date_utc || null, last.snippet || null]
  );
}

function applyBatch(db, profileId, folder, batch, bodyCap) {
  db.transaction(() => {
    const touchedThreads = new Set();
    for (const m of batch) {
      upsertMessage(db, profileId, folder, m, bodyCap);
      if (m.threadId != null) touchedThreads.add(String(m.threadId));
    }
    for (const thrid of touchedThreads) refreshThreadRollup(db, profileId, thrid);
  });
}

// Syncs one folder into the local cache. First run searches the last
// firstRun.days of mail and keeps at most firstRun.max of the newest UIDs;
// every run after that fetches only UIDs above the last one seen. Message
// bodies are only downloaded for messages newer than bodyDays, and are
// capped to bodyCap characters either way.
export async function syncMailbox({
  db,
  profileId,
  client,
  folder = 'INBOX',
  nowUtc = new Date().toISOString(),
  firstRun = { days: 30, max: 500 },
  pageSize = 50,
  bodyDays = 14,
  bodyCap = 4000,
  onProgress = () => {},
} = {}) {
  if (!db || !profileId || !client) {
    throw new GmailError('unknown', 'syncMailbox needs db, profileId and client');
  }

  const lastUidKey = `gmail:${folder}:lastUid`;
  const backfillKey = `gmail:${folder}:backfillComplete`;
  const lastUid = db.getState(lastUidKey, null);
  const isFirstRun = lastUid === null;

  let lock;
  try {
    lock = await client.getMailboxLock(folder);
  } catch (err) {
    throw classifyError(err);
  }

  try {
    let range;
    let total = null;

    if (isFirstRun) {
      const sinceDate = new Date(new Date(nowUtc).getTime() - firstRun.days * 86400000);
      let found;
      try {
        found = await client.search({ since: sinceDate }, { uid: true });
      } catch (err) {
        throw classifyError(err);
      }
      found = Array.isArray(found) ? [...found].sort((a, b) => a - b) : [];
      range = found.length > firstRun.max ? found.slice(-firstRun.max) : found;
      total = range.length;
    } else {
      range = `${lastUid + 1}:*`;
    }

    let done = 0;
    let batch = [];
    let maxUidSeen = lastUid || 0;

    const flushBatch = () => {
      if (!batch.length) return;
      applyBatch(db, profileId, folder, batch, bodyCap);
      for (const m of batch) if (m.uid > maxUidSeen) maxUidSeen = m.uid;
      db.setState(lastUidKey, maxUidSeen);
      done += batch.length;
      onProgress({ done, total });
      batch = [];
    };

    const nothingToDo = Array.isArray(range) && range.length === 0;
    if (!nothingToDo) {
      let iterator;
      try {
        iterator = client.fetch(range, FETCH_QUERY, { uid: true });
      } catch (err) {
        throw classifyError(err);
      }

      try {
        for await (const msg of iterator) {
          const withinBodyWindow = isWithinDays(msg.envelope && msg.envelope.date, nowUtc, bodyDays);
          const bodyText = withinBodyWindow ? await downloadBestText(client, msg, bodyCap) : '';
          batch.push({ ...msg, bodyText });
          if (batch.length >= pageSize) flushBatch();
        }
        flushBatch();
      } catch (err) {
        flushBatch();
        throw classifyError(err);
      }
    }

    db.setState('gmail:lastChecked', nowUtc);
    if (isFirstRun) db.setState(backfillKey, true);

    return { done, total };
  } finally {
    if (lock) lock.release();
  }
}

// ---------------------------------------------------------------------------
// Raw Gmail search
// ---------------------------------------------------------------------------

export async function searchRaw(client, folder, gmailQuery) {
  let lock;
  try {
    lock = await client.getMailboxLock(folder);
    const uids = await client.search({ gmraw: gmailQuery }, { uid: true });
    return Array.isArray(uids) ? uids : [];
  } catch (err) {
    throw classifyError(err);
  } finally {
    if (lock) lock.release();
  }
}

// ---------------------------------------------------------------------------
// Cache queries
// ---------------------------------------------------------------------------

function escapeLike(value) {
  return String(value ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
}

function toLikePattern(value) {
  const s = String(value ?? '');
  if (s.includes('%') || s.includes('_')) return s;
  return `%${escapeLike(s)}%`;
}

function hydrateMessageRow(row) {
  if (!row) return row;
  return {
    ...row,
    to_addrs: safeJsonParse(row.to_addrs, []),
    labels: safeJsonParse(row.labels, []),
    is_unread: !!row.is_unread,
    is_flagged: !!row.is_flagged,
  };
}

export function unreadFrom(db, profileId, addressOrPattern) {
  const pattern = toLikePattern(addressOrPattern);
  return db
    .all(`SELECT * FROM messages WHERE profile_id = ? AND is_unread = 1 AND from_addr LIKE ? ESCAPE '\\' ORDER BY date_utc DESC`, [profileId, pattern])
    .map(hydrateMessageRow);
}

export function recentFrom(db, profileId, pattern, sinceUtc) {
  const like = toLikePattern(pattern);
  return db
    .all(`SELECT * FROM messages WHERE profile_id = ? AND from_addr LIKE ? ESCAPE '\\' AND date_utc >= ? ORDER BY date_utc DESC`, [profileId, like, sinceUtc])
    .map(hydrateMessageRow);
}

export function keywordScan(db, profileId, keyword, sinceUtc) {
  const like = `%${escapeLike(keyword)}%`;
  return db
    .all(
      `SELECT * FROM messages WHERE profile_id = ? AND date_utc >= ? AND (subject LIKE ? ESCAPE '\\' OR body_text LIKE ? ESCAPE '\\') ORDER BY date_utc DESC`,
      [profileId, sinceUtc, like, like]
    )
    .map(hydrateMessageRow);
}

// Oldest first, matching how you'd read a thread top to bottom; `last`
// controls how many of the most recent messages come back, `cap` is a hard
// ceiling on that so a runaway value can never pull an entire mailbox.
export function threadMessages(db, profileId, gmThrid, { last = 5, cap = 1000 } = {}) {
  const limit = Math.max(0, Math.min(last, cap));
  const rows = db
    .all('SELECT * FROM messages WHERE profile_id = ? AND gm_thrid = ? ORDER BY date_utc DESC LIMIT ?', [profileId, gmThrid, limit])
    .map(hydrateMessageRow);
  return rows.reverse();
}

export function messageById(db, profileId, gmMsgid) {
  const row = db.get('SELECT * FROM messages WHERE profile_id = ? AND gm_msgid = ?', [profileId, gmMsgid]);
  return row ? hydrateMessageRow(row) : null;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

// Builds the References chain from whatever of the thread is already cached
// locally: every message_id seen so far in the thread, oldest to newest,
// ending with the parent's own Message-ID. That is the parent's References
// plus its Message-ID whenever the whole chain has passed through the cache;
// it degrades to just the parent's Message-ID for a thread we only just
// started following.
function buildReferences(db, profileId, parent) {
  if (!parent) return '';
  const priorIds = parent.gm_thrid
    ? threadMessages(db, profileId, parent.gm_thrid, { last: 1000, cap: 1000 })
        .map((m) => m.message_id)
        .filter(Boolean)
    : [];
  if (parent.message_id && !priorIds.includes(parent.message_id)) priorIds.push(parent.message_id);
  return priorIds.join(' ');
}

// Composes a reply to `parent` and saves it to the real Drafts folder. The
// model never chooses a recipient: to is always parent.from_addr.
export async function createReplyDraft({ db, profileId, client, folders, from, parent, subject, body } = {}) {
  if (!parent || !parent.from_addr) {
    throw new GmailError('unknown', 'createReplyDraft needs a parent message with a from address');
  }
  if (!folders || !folders.drafts) {
    throw new GmailError('folders', 'no Drafts folder available to save the draft');
  }

  const to = parent.from_addr;
  const finalSubject = subject || parent.subject || '';
  const messageId = buildMessageId();
  const references = buildReferences(db, profileId, parent);

  const mime = await buildReplyMime({
    from,
    to,
    subject: finalSubject,
    body: body || '',
    inReplyTo: parent.message_id || undefined,
    references: references || undefined,
    messageId,
    date: new Date(),
  });

  try {
    await client.append(folders.drafts, mime, ['\\Draft']);
  } catch (err) {
    throw classifyError(err);
  }

  const displaySubject = /^re:/i.test(finalSubject.trim()) ? finalSubject : finalSubject ? `Re: ${finalSubject}` : 'Re:';
  const nowUtc = new Date().toISOString();

  const result = db.run(
    `INSERT INTO drafts (profile_id, gm_thrid, to_addr, to_name, subject, body, in_reply_to, message_id, state, created_utc, updated_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [profileId, parent.gm_thrid || null, to, parent.from_name || null, displaySubject, body || '', parent.message_id || null, messageId, nowUtc, nowUtc]
  );

  return db.get('SELECT * FROM drafts WHERE id = ?', [result.lastInsertRowid]);
}

function markDraftState(db, draftId, state) {
  db.run('UPDATE drafts SET state = ?, updated_utc = ? WHERE id = ?', [state, new Date().toISOString(), draftId]);
}

// Sends a saved draft over SMTP, keeping its Message-ID. Code decides
// success or failure here, never the model: 'sent' only after nodemailer
// reports it accepted, 'unknown' only when our own timeout killed the
// socket mid-send (confirmSent resolves that before any retry), 'failed'
// for every other rejection. There is no automatic retry.
export async function sendDraft({ db, draft, creds, transportFactory, timeoutMs = DEFAULT_SMTP_TIMEOUT_MS } = {}) {
  if (!draft || !draft.id) {
    throw new GmailError('unknown', 'sendDraft needs a draft row');
  }

  markDraftState(db, draft.id, 'sending');

  const factory = transportFactory || defaultTransportFactory;
  const transport = factory(smtpOptions(creds, timeoutMs));

  let info;
  try {
    info = await runSmtpWithHardTimeout(
      () =>
        transport.sendMail({
          from: creds && creds.email,
          to: draft.to_addr,
          subject: draft.subject,
          text: draft.body,
          messageId: draft.message_id,
          inReplyTo: draft.in_reply_to || undefined,
          references: draft.in_reply_to || undefined,
        }),
      timeoutMs,
      transport
    );
  } catch (err) {
    const classified = err instanceof GmailError ? err : classifyError(err);
    markDraftState(db, draft.id, classified.kind === 'timeout' ? 'unknown' : 'failed');
    throw classified;
  } finally {
    try {
      transport.close();
    } catch {
      // already closed by the timeout handler, or never opened
    }
  }

  markDraftState(db, draft.id, 'sent');
  const row = db.get('SELECT * FROM drafts WHERE id = ?', [draft.id]);
  return { ...row, accepted: (info && info.accepted) || [] };
}

// Resolves a 'unknown' send by checking whether it actually landed in Sent,
// searched by our own Message-ID. Call this before ever offering a retry:
// resending an 'unknown' draft without checking first risks a duplicate.
export async function confirmSent({ client, folders, messageId }) {
  if (!folders || !folders.sent) {
    throw new GmailError('folders', 'no Sent folder available to confirm delivery');
  }
  let lock;
  try {
    lock = await client.getMailboxLock(folders.sent);
    const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
    const list = Array.isArray(uids) ? uids : [];
    return { found: list.length > 0, uid: list.length ? list[list.length - 1] : null };
  } catch (err) {
    throw classifyError(err);
  } finally {
    if (lock) lock.release();
  }
}

// ---------------------------------------------------------------------------
// Connection-cap backoff
// ---------------------------------------------------------------------------

const CAP_STATE_KEY = 'gmail:connectionCapBackoff';
const CAP_CEILING = 5;
const CAP_WINDOW_MS = 10 * 60 * 1000;

// Tracks how many times Gmail has answered "too many simultaneous
// connections" inside a rolling 10-minute window. Once that hits the
// ceiling, shouldWait() says to hold off and userMessage explains why in
// beginner terms; nothing here retries anything itself, it only tracks state
// for the caller's own retry loop.
export function capBackoff(db) {
  function state() {
    return db.getState(CAP_STATE_KEY, { attempts: 0, windowStartUtc: null, untilUtc: null });
  }

  function recordAttempt(nowUtc = new Date().toISOString()) {
    const now = new Date(nowUtc).getTime();
    const prev = state();
    const windowStart = prev.windowStartUtc ? new Date(prev.windowStartUtc).getTime() : null;

    let attempts = prev.attempts || 0;
    let windowStartUtc = prev.windowStartUtc;
    if (!windowStart || now - windowStart > CAP_WINDOW_MS) {
      attempts = 0;
      windowStartUtc = nowUtc;
    }
    attempts += 1;

    const atCeiling = attempts >= CAP_CEILING;
    const untilUtc = atCeiling ? new Date(now + CAP_WINDOW_MS).toISOString() : null;

    db.setState(CAP_STATE_KEY, { attempts, windowStartUtc, untilUtc });

    return {
      attempts,
      atCeiling,
      untilUtc,
      userMessage: atCeiling ? DEFAULT_USER_MESSAGES.connection_cap : null,
    };
  }

  function shouldWait(nowUtc = new Date().toISOString()) {
    const s = state();
    if (!s.untilUtc) return false;
    return new Date(nowUtc).getTime() < new Date(s.untilUtc).getTime();
  }

  function reset() {
    db.setState(CAP_STATE_KEY, { attempts: 0, windowStartUtc: null, untilUtc: null });
  }

  return { state, recordAttempt, shouldWait, reset };
}
