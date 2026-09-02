// thread_summary: "catch me up on the email thread about pickup". Locates a
// thread from a spoken hint, then reads back the last 5 messages (capped at
// 1000 characters each, matching gmail.threadMessages' own defaults) close
// to verbatim, through scrub.forSpeech for pronunciation only. Not narrated
// by the model, for the same reason as read_message: the content must not
// be paraphrased or misquoted.
import { findMessageByHint } from './shared.js';

const LAST_N_MESSAGES = 5;
const CAP_CHARS = 1000;

export default {
  key: 'thread_summary',
  google: 'gmail',
  needsSlots: true,
  schema: {
    type: 'object',
    properties: {
      hint: { type: 'string', description: "who the thread is with, or a word from its subject" },
    },
    required: ['hint'],
  },
  description: 'Summarize a cached email thread.',
  clarify: 'Which email thread did you want me to catch you up on?',

  validate(rawArgs) {
    const hint = typeof rawArgs?.hint === 'string' ? rawArgs.hint.trim() : '';
    if (!hint) return { ok: false, reason: 'hint is required' };
    return { ok: true, slots: { hint } };
  },

  async run(ctx) {
    const { db, gmail, contacts, scrub, now, profileId, slots, session } = ctx;
    const anchor = findMessageByHint(db, gmail, contacts, profileId, slots.hint, now);
    const asOf = db.getState('gmail:lastChecked', null);

    if (!anchor || !anchor.gm_thrid) {
      return { type: 'say', text: `I couldn't find an email thread matching "${slots.hint}".`, source: { kind: 'inbox', asOf } };
    }

    const messages = gmail.threadMessages(db, profileId, anchor.gm_thrid, { last: LAST_N_MESSAGES, cap: CAP_CHARS });
    session.setLastMessage(profileId, messages.length ? messages[messages.length - 1].gm_msgid : anchor.gm_msgid);

    const lines = messages.map((m) => {
      const from = m.from_name || m.from_addr || 'someone';
      const body = (m.body_text || m.snippet || '').slice(0, CAP_CHARS);
      return `${from} said: ${body}`;
    });
    const spoken = scrub.forSpeech(lines.join(' Then, '), { mode: 'email' });
    return { type: 'say', text: spoken, source: { kind: 'inbox', asOf } };
  },
};
