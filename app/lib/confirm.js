// Holds pending writes between the `confirm` SSE event and the human's next
// "yes" (POST /api/confirm), and performs them once confirmed. Nothing here
// ever runs an action on its own; every entry is created by an intent
// module's `{ type: 'confirm', ... }` result and only ever executes after an
// explicit answer: 'yes'. Every result and message this module returns is
// code, never the model, per CLAUDE.md.
//
// Usage:
//   import { createConfirmManager } from './confirm.js';
//   const confirms = createConfirmManager({ db, gmail, gmailSession, verifyPin });
//   const confirmId = confirms.createPending(profileId, { action, details, sentence });
//   const outcome = await confirms.resolve({ confirmId, profileId, answer: 'yes', pin });

import { randomBytes } from 'node:crypto';
import { addReminder } from './reminders.js';
import { performCreateEvent } from './intents/create_event.js';

const TTL_MS = 10 * 60 * 1000; // 10 minutes, per the plan

export function createConfirmManager({ db, gmail, gmailSession, verifyPin, now = () => Date.now(), ttlMs = TTL_MS } = {}) {
  const store = new Map(); // confirmId -> { profileId, action, details, sentence, createdAtMs }

  function createPending(profileId, { action, details, sentence }) {
    const confirmId = randomBytes(16).toString('hex');
    store.set(confirmId, { profileId, action, details: details || {}, sentence, createdAtMs: now() });
    return confirmId;
  }

  // Looks up a pending confirmation without consuming it. Returns null (and
  // drops the entry) once it is missing or past its 10 minute expiry.
  function peek(confirmId) {
    const entry = store.get(confirmId);
    if (!entry) return null;
    if (now() - entry.createdAtMs > ttlMs) {
      store.delete(confirmId);
      return null;
    }
    return entry;
  }

  async function performSendMail(entry, pin) {
    if (entry.details.needsPin) {
      if (!pin) return { ok: false, message: 'Sending mail needs your PIN first.' };
      let check;
      try {
        check = await verifyPin(entry.profileId, pin);
      } catch {
        check = { ok: false };
      }
      if (!check || check.ok !== true) {
        const message = check && check.lockedForSeconds
          ? `Too many tries. Try again in ${check.lockedForSeconds} seconds.`
          : 'That PIN was not right, so I did not send it.';
        return { ok: false, message };
      }
    }

    if (typeof gmailSession !== 'function') {
      return { ok: false, message: "I don't have Gmail connected yet. Open Settings to connect Gmail." };
    }
    const account = await gmailSession(entry.profileId);
    if (!account) {
      return { ok: false, message: "I don't have Gmail connected yet. Open Settings to connect Gmail." };
    }

    const draft = db.get('SELECT * FROM drafts WHERE id = ?', [entry.details.draftId]);
    if (!draft) {
      return { ok: false, message: "That draft isn't there anymore, so I couldn't send it." };
    }

    try {
      const sent = await gmail.sendDraft({ db, draft, creds: account.creds });
      return { ok: true, result: sent, message: `Sent to ${draft.to_name || draft.to_addr}.` };
    } catch (err) {
      return { ok: false, message: (err && err.userMessage) || 'Sending failed, so nothing went out.' };
    }
  }

  function performSetReminder(entry) {
    const reminder = addReminder(db, entry.profileId, { text: entry.details.text, dueUtc: entry.details.dueUtc || null });
    return { ok: true, result: reminder, message: `Okay, I added a reminder to ${entry.details.text}.` };
  }

  function performCreateEventAction(entry) {
    const { url, message } = performCreateEvent(entry.details);
    return { ok: true, result: { url }, message, url };
  }

  function performOpenLink(entry) {
    return { ok: true, result: { url: entry.details.url }, message: entry.details.message || 'Here is the link.', url: entry.details.url };
  }

  // Consumes the pending confirmation (one-shot, whether the answer is yes
  // or no) and performs the write when it is yes. `profileId`, when given,
  // must match the profile the confirmation was created for.
  async function resolve({ confirmId, profileId, answer, pin } = {}) {
    const entry = peek(confirmId);
    if (!entry) {
      return { ok: false, message: 'That confirmation has expired. Please ask again.' };
    }
    if (profileId != null && entry.profileId !== profileId) {
      return { ok: false, message: 'That confirmation is not for this profile.' };
    }
    store.delete(confirmId);

    if (answer !== 'yes') {
      return { ok: true, result: 'cancelled', message: 'Okay, I will not do that.' };
    }

    switch (entry.action) {
      case 'create_event':
        return performCreateEventAction(entry);
      case 'open_link':
        return performOpenLink(entry);
      case 'set_reminder':
        return performSetReminder(entry);
      case 'send_mail':
        return performSendMail(entry, pin);
      default:
        return { ok: false, message: `Scout doesn't know how to do that yet.` };
    }
  }

  return { createPending, peek, resolve, size: () => store.size };
}
