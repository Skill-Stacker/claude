// unread_from: "do I have any unread mail from the school". The model
// extracts the sender name or address pattern only; gmail.unreadFrom does a
// LIKE match over the cached from_addr column (see google/gmail.js).
import { messagesSnapshot } from './shared.js';

export default {
  key: 'unread_from',
  google: 'gmail',
  needsSlots: true,
  schema: {
    type: 'object',
    properties: {
      sender: { type: 'string', description: 'the name, email address, or part of a domain to match the sender against' },
    },
    required: ['sender'],
  },
  description: 'Check for unread email from a particular sender.',
  clarify: 'Who did you want me to check for unread mail from?',

  validate(rawArgs) {
    const sender = typeof rawArgs?.sender === 'string' ? rawArgs.sender.trim() : '';
    if (!sender) return { ok: false, reason: 'sender is required' };
    return { ok: true, slots: { sender } };
  },

  async run(ctx) {
    const { db, gmail, contacts, profileId, slots, session } = ctx;
    // A spoken name ("mom", "the school office") resolves against known
    // contacts and recent senders first; unread_from itself only knows how
    // to match an address or domain pattern, never a name.
    const resolved = contacts.resolveRecipient(db, profileId, slots.sender);
    const pattern = resolved.status === 'one' ? resolved.contact.address : slots.sender;
    const messages = gmail.unreadFrom(db, profileId, pattern);
    const asOf = db.getState('gmail:lastChecked', null);
    if (messages[0]) session.setLastMessage(profileId, messages[0].gm_msgid);
    return {
      type: 'narrate',
      data: `Unread messages from "${slots.sender}":\n${messagesSnapshot(messages)}`,
      source: { kind: 'inbox', asOf },
    };
  },
};
