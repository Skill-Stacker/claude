// next_event: "when's my next dentist appointment", "what's next on my
// calendar". The model extracts an optional hint (an empty string means no
// hint, just the soonest event); calendar.nextEvent does the actual ranking.
// This is also the intent for ambiguous "did you already put X on my
// calendar" questions: if nothing matches, the narration data below says so
// plainly, and the standing narration rule keeps the model from inventing
// an event that was never found.
import { describeEvent } from './shared.js';

export default {
  key: 'next_event',
  google: 'calendar',
  needsSlots: true,
  schema: {
    type: 'object',
    properties: {
      hint: { type: 'string', description: 'a word or two naming the event, empty if the user just wants the next event' },
    },
    required: [],
  },
  description: 'Find the next upcoming event, optionally matching a hint about which one.',
  clarify: null,

  validate(rawArgs) {
    const hint = typeof rawArgs?.hint === 'string' ? rawArgs.hint.trim() : '';
    return { ok: true, slots: { hint } };
  },

  async run(ctx) {
    const { db, calendar, dates, zone, now, slots, profileId } = ctx;
    const nowUtc = now.toUTC().toISO({ suppressMilliseconds: true });
    const found = calendar.nextEvent(db, profileId, nowUtc, { hint: slots.hint || undefined });
    const asOf = calendar.lastChecked(db);

    // calendar.nextEvent falls back to the soonest event when a hint is
    // given but nothing overlaps it, flagged by matchedByHint: false. That
    // fallback event is not what was asked about, so it must not be
    // reported as a match: doing so would fabricate an answer to exactly
    // the kind of "did you already put X on my calendar" question this
    // intent also has to handle honestly.
    const isRealMatch = found && (!slots.hint || found.matchedByHint);

    const data = isRealMatch
      ? `Next matching event:\n1. ${describeEvent(dates, found, { now, zone })}`
      : slots.hint
        ? `No upcoming event matching "${slots.hint}" was found on the calendar.`
        : 'No upcoming events were found on the calendar.';
    return { type: 'narrate', data, source: { kind: 'calendar', asOf } };
  },
};
