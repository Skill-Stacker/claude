// send_confirmed: "send it", "yes, send that". Only reachable as a
// follow-up to a draft_reply in the same session (session.getLastDraft);
// answered plainly, with no confirm event, when nothing has been drafted.
// Sending mail always needs a fresh PIN, checked at confirm time by
// confirm.js, never here.
export default {
  key: 'send_confirmed',
  google: 'gmail',
  needsSlots: false,
  schema: null,
  clarify: null,

  async run(ctx) {
    const { db, profileId, session } = ctx;
    const draftId = session.getLastDraft(profileId);
    if (!draftId) {
      return { type: 'say', text: "There's nothing drafted yet to send. Ask me to draft a reply first." };
    }

    const draft = db.get('SELECT * FROM drafts WHERE id = ? AND profile_id = ?', [draftId, profileId]);
    if (!draft) {
      return { type: 'say', text: "There's nothing drafted yet to send. Ask me to draft a reply first." };
    }
    if (draft.state === 'sent') {
      return { type: 'say', text: `That reply to ${draft.to_name || draft.to_addr} was already sent.` };
    }

    const to = draft.to_name || draft.to_addr;
    return {
      type: 'confirm',
      action: 'send_mail',
      details: { draftId: draft.id, needsPin: true, to: draft.to_addr, subject: draft.subject },
      sentence: `I'll send that reply to ${to} with the subject "${draft.subject}". Should I go ahead?`,
    };
  },
};
