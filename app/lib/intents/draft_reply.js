// draft_reply: "reply and tell them we'll be there at noon". The model
// produces only { subject, body }; code sets the recipient from the parent
// message the session last looked at (read_message, thread_summary, or the
// top hit of unread_from set it) and saves the draft to the real Drafts
// folder. Saving a draft is reversible and never sends mail, so unlike
// send_confirmed this runs immediately, with no confirmation step; the
// reply here just reports what code already did.
export default {
  key: 'draft_reply',
  google: 'gmail',
  needsSlots: true,
  schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'the reply subject line' },
      body: { type: 'string', description: 'the reply body, in the words the user asked for' },
    },
    required: ['body'],
  },
  description: 'Draft a reply to the email the user was just looking at.',
  clarify: 'What would you like the reply to say?',

  validate(rawArgs) {
    const subject = typeof rawArgs?.subject === 'string' ? rawArgs.subject.trim() : '';
    const body = typeof rawArgs?.body === 'string' ? rawArgs.body.trim() : '';
    if (!body) return { ok: false, reason: 'body is required' };
    return { ok: true, slots: { subject, body } };
  },

  async run(ctx) {
    const { db, gmail, gmailSession, profileId, slots, session } = ctx;
    const asOf = db.getState('gmail:lastChecked', null);

    const lastMessageId = session.getLastMessage(profileId);
    const parent = lastMessageId ? gmail.messageById(db, profileId, lastMessageId) : null;
    if (!parent) {
      return { type: 'clarify', question: 'Which message should this reply go to? Read it to me first, then ask for a reply.' };
    }

    const account = await gmailSession(profileId);
    if (!account) {
      return { type: 'say', text: "I don't have Gmail connected yet. Open Settings to connect Gmail.", source: { kind: 'inbox', asOf } };
    }

    const draft = await gmail.withImap(account.creds, (client) =>
      gmail.createReplyDraft({
        db,
        profileId,
        client,
        folders: account.folders,
        from: account.from,
        parent,
        subject: slots.subject,
        body: slots.body,
      }),
    );

    session.setLastDraft(profileId, draft.id);

    const to = parent.from_name || parent.from_addr;
    return {
      type: 'say',
      text: `I saved a draft reply to ${to} with the subject "${draft.subject}". Say "send it" if you want me to send it.`,
      source: { kind: 'inbox', asOf },
    };
  },
};
