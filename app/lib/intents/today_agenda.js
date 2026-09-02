// today_agenda: "what's on my calendar today". No slots: the window is
// always today in the profile's zone, resolved in code with dates.windowFor,
// never guessed by the model.
import { eventsSnapshot } from './shared.js';

export default {
  key: 'today_agenda',
  google: 'calendar',
  needsSlots: false,
  schema: null,
  clarify: null,

  async run(ctx) {
    const { db, calendar, dates, zone, now } = ctx;
    const window = dates.windowFor('today', { now, zone });
    const events = calendar.listEvents(db, ctx.profileId, window.startUtc, window.endUtc);
    const asOf = calendar.lastChecked(db);
    return {
      type: 'narrate',
      data: `Today's events:\n${eventsSnapshot(dates, events, { now, zone })}`,
      source: { kind: 'calendar', asOf },
    };
  },
};
