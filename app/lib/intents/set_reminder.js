// set_reminder: "remind me to take the chicken out at 6". Local only, no
// Google account needed. The model extracts { text, when_text }; code
// resolves when_text with dates.resolve. A reminder with no resolvable time
// is still allowed (an undated to-do), matching the reminders table's
// nullable due_utc.
export default {
  key: 'set_reminder',
  google: null,
  needsSlots: true,
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'what to be reminded about' },
      when_text: { type: 'string', description: 'when, in the words the user used; empty string if no time was given' },
    },
    required: ['text'],
  },
  description: 'Set a reminder.',
  clarify: 'What should I remind you about?',

  validate(rawArgs) {
    const text = typeof rawArgs?.text === 'string' ? rawArgs.text.trim() : '';
    const whenText = typeof rawArgs?.when_text === 'string' ? rawArgs.when_text.trim() : '';
    if (!text) return { ok: false, reason: 'text is required' };
    return { ok: true, slots: { text, when_text: whenText } };
  },

  async run(ctx) {
    const { dates, zone, now, slots } = ctx;
    let dueUtc = null;
    let spokenDue = null;
    if (slots.when_text) {
      const resolved = dates.resolve(slots.when_text, { now, zone });
      if (resolved) {
        dueUtc = new Date(resolved.start).toISOString();
        spokenDue = resolved.allDay
          ? dates.spokenDate(resolved.start, { now, zone })
          : dates.spokenDateTime(resolved.start, { now, zone });
      }
    }

    const sentence = spokenDue
      ? `I'll remind you to ${slots.text} on ${spokenDue}. Should I go ahead?`
      : `I'll add a reminder to ${slots.text}, with no set time. Should I go ahead?`;

    return {
      type: 'confirm',
      action: 'set_reminder',
      details: { text: slots.text, dueUtc },
      sentence,
    };
  },
};
