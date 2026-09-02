// date_agenda: "what's on my calendar next Tuesday" / "...this weekend" /
// "...in October". The model extracts the raw date phrase only; code
// resolves it with dates.windowFor (the fixed set of named windows) and
// falls back to dates.resolve for a single named day. The model never
// computes the date itself.
import { DateTime } from 'luxon';
import { eventsSnapshot } from './shared.js';

export default {
  key: 'date_agenda',
  google: 'calendar',
  needsSlots: true,
  schema: {
    type: 'object',
    properties: {
      date_text: { type: 'string', description: 'the day, weekend, or month the user asked about, in their own words' },
    },
    required: ['date_text'],
  },
  description: 'Look up what is on the calendar for a day, weekend, or month the user named.',
  clarify: 'Which day did you mean?',

  validate(rawArgs) {
    const dateText = typeof rawArgs?.date_text === 'string' ? rawArgs.date_text.trim() : '';
    if (!dateText) return { ok: false, reason: 'date_text is required' };
    return { ok: true, slots: { date_text: dateText } };
  },

  async run(ctx) {
    const { db, calendar, dates, zone, now, slots } = ctx;
    let window = dates.windowFor(slots.date_text, { now, zone });
    let label = window ? window.label : null;
    if (!window) {
      const resolved = dates.resolve(slots.date_text, { now, zone });
      if (resolved) {
        window = dayWindow(resolved.start, zone);
        label = dates.spokenDate(resolved.start, { now, zone });
      }
    }
    if (!window) {
      return { type: 'clarify', question: 'Which day did you mean?' };
    }
    const events = calendar.listEvents(db, ctx.profileId, window.startUtc, window.endUtc);
    const asOf = calendar.lastChecked(db);
    return {
      type: 'narrate',
      data: `Events for ${label}:\n${eventsSnapshot(dates, events, { now, zone })}`,
      source: { kind: 'calendar', asOf },
    };
  },
};

// The [start of day, end of day] window in `zone` for the day `iso` falls
// on, expressed as UTC ISO bounds (same shape dates.windowFor returns).
function dayWindow(iso, zone) {
  const dt = DateTime.fromISO(iso, { zone });
  if (!dt.isValid) return null;
  const start = dt.startOf('day');
  const end = dt.endOf('day').set({ millisecond: 0 });
  return {
    startUtc: start.toUTC().toISO({ suppressMilliseconds: true }),
    endUtc: end.toUTC().toISO({ suppressMilliseconds: true }),
  };
}
