// list_reminders: "what are my reminders". Local only, read-only, no slots.
// Read back close to verbatim (it's just a list from our own database, so
// there's nothing for the model to add), consistent with why we don't
// narrate email content either.
import { listOpen } from '../reminders.js';

export default {
  key: 'list_reminders',
  google: null,
  needsSlots: false,
  schema: null,
  clarify: null,

  async run(ctx) {
    const { db, profileId, dates, zone, now } = ctx;
    const reminders = listOpen(db, profileId);
    if (!reminders.length) {
      return { type: 'say', text: "You don't have any open reminders." };
    }
    const lines = reminders.map((r) => {
      const when = r.due_utc ? ` (${dates.spokenRelative(r.due_utc, { now, zone })})` : '';
      return `${r.text}${when}`;
    });
    const count = reminders.length === 1 ? 'one reminder' : `${dates.numberToWords(reminders.length)} reminders`;
    return { type: 'say', text: `You have ${count}: ${lines.join('; ')}.`, source: { kind: 'reminders', asOf: null } };
  },
};
