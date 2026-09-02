// why_missing_event: "why isn't my event showing up". A scripted answer,
// always, even when the calendar is connected and working: Google Calendar's
// own "Secret address in iCal format" feed regenerates on Google's schedule,
// often tens of minutes to a few hours behind, so a just-added event can be
// genuinely missing from the last read. No model call: the explanation and
// the last-check time are both facts code already has.
import { asOfPrefix } from './shared.js';

export default {
  key: 'why_missing_event',
  google: 'calendar',
  needsSlots: false,
  schema: null,
  clarify: null,

  async run(ctx) {
    const { db, calendar, dates, zone } = ctx;
    const asOf = calendar.lastChecked(db);
    const prefix = asOfPrefix(dates, asOf, zone);
    const text = prefix
      ? `${prefix}Google only updates the calendar feed I read every so often, sometimes an hour or more behind, so that event was not there yet. It should show up next time I check.`
      : "Google only updates the calendar feed I read every so often, sometimes an hour or more behind, and I have not been able to check it yet.";
    return { type: 'say', text, source: { kind: 'calendar', asOf } };
  },
};
