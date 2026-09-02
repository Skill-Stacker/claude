// read_message: "read me the email from grandma". Reads one cached message
// back close to verbatim (through scrub.forSpeech for pronunciation only,
// never paraphrased by the model, so it can't misquote it). Sets the
// session's last-message so a follow-up "reply and say ..." (draft_reply)
// knows which message is the parent.
import { findMessageByHint } from './shared.js';

export default {
  key: 'read_message',
  google: 'gmail',
  needsSlots: true,
  schema: {
    type: 'object',
    properties: {
      hint: { type: 'string', description: "who it's from, or a word from the subject" },
    },
    required: ['hint'],
  },
  description: 'Find and read back one cached email message.',
  clarify: 'Which message did you want me to read?',

  validate(rawArgs) {
    const hint = typeof rawArgs?.hint === 'string' ? rawArgs.hint.trim() : '';
    if (!hint) return { ok: false, reason: 'hint is required' };
    return { ok: true, slots: { hint } };
  },

  async run(ctx) {
    const { db, gmail, contacts, scrub, now, profileId, slots, session } = ctx;
    const message = findMessageByHint(db, gmail, contacts, profileId, slots.hint, now);
    const asOf = db.getState('gmail:lastChecked', null);

    if (!message) {
      return { type: 'say', text: `I couldn't find a message matching "${slots.hint}".`, source: { kind: 'inbox', asOf } };
    }

    session.setLastMessage(profileId, message.gm_msgid);

    const from = message.from_name || message.from_addr || 'someone';
    const body = message.body_text || message.snippet || '(no message text was cached)';
    const spoken = scrub.forSpeech(`From ${from}, subject ${message.subject || '(no subject)'}. ${body}`, { mode: 'email' });
    return { type: 'say', text: spoken, source: { kind: 'inbox', asOf } };
  },
};
