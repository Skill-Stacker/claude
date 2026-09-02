// free_check: "am I free tomorrow at 3", "is Saturday morning open". The
// model extracts the raw time phrase only; code resolves it with
// dates.resolve and checks calendar.isFree. A phrase with no explicit end
// gets a default one-hour window; a phrase with no explicit time at all
// (just a day) checks the whole day.
import { DateTime } from 'luxon';
import { describeEvent, DEFAULT_EVENT_MINUTES } from './shared.js';

export default {
  key: 'free_check',
  google: 'calendar',
  needsSlots: true,
  schema: {
    type: 'object',
    properties: {
      when_text: { type: 'string', description: 'the day and, if given, time the user asked about being free' },
    },
    required: ['when_text'],
  },
  description: 'Check whether a day or time is free on the calendar.',
  clarify: 'What day and time did you want me to check?',

  validate(rawArgs) {
    const whenText = typeof rawArgs?.when_text === 'string' ? rawArgs.when_text.trim() : '';
    if (!whenText) return { ok: false, reason: 'when_text is required' };
    return { ok: true, slots: { when_text: whenText } };
  },

  async run(ctx) {
    const { db, calendar, dates, zone, now, slots, profileId } = ctx;
    const resolved = dates.resolve(slots.when_text, { now, zone });
    if (!resolved) {
      return { type: 'clarify', question: 'What day and time did you want me to check?' };
    }

    let startUtc;
    let endUtc;
    if (resolved.allDay) {
      const dt = DateTime.fromISO(resolved.start, { zone });
      startUtc = dt.startOf('day').toUTC().toISO({ suppressMilliseconds: true });
      endUtc = dt.endOf('day').set({ millisecond: 0 }).toUTC().toISO({ suppressMilliseconds: true });
    } else {
      const start = DateTime.fromISO(resolved.start, { zone });
      startUtc = start.toUTC().toISO({ suppressMilliseconds: true });
      endUtc = resolved.end
        ? DateTime.fromISO(resolved.end, { zone }).toUTC().toISO({ suppressMilliseconds: true })
        : start.plus({ minutes: DEFAULT_EVENT_MINUTES }).toUTC().toISO({ suppressMilliseconds: true });
    }

    const { free, conflicts } = calendar.isFree(db, profileId, startUtc, endUtc);
    const asOf = calendar.lastChecked(db);
    const when = resolved.allDay
      ? dates.spokenDate(resolved.start, { now, zone })
      : dates.spokenDateTime(resolved.start, { now, zone });
    const data = free
      ? `${when} is free on the calendar.`
      : `${when} is not free. Conflicts:\n${conflicts.map((ev, i) => `${i + 1}. ${describeEvent(dates, ev, { now, zone })}`).join('\n')}`;
    return { type: 'narrate', data, source: { kind: 'calendar', asOf } };
  },
};
