// move_event: "move my dentist appointment". Scout has no OAuth, so it
// cannot edit an existing Google Calendar event on its own; there is also no
// delete intent (see CLAUDE.md), so this never recreates the event under a
// new time on the human's behalf either, which would risk a duplicate. The
// only honest, safe write here is: find the event, say plainly that Scout
// cannot move it directly, and offer to open Google Calendar to that event's
// day so the human can drag it themselves.
import { DateTime } from 'luxon';
import { describeEvent } from './shared.js';

function dayLinkFor(startUtc, zone) {
  const dt = DateTime.fromISO(startUtc, { zone: 'utc' }).setZone(zone);
  const y = dt.toFormat('yyyy');
  const m = dt.toFormat('LL');
  const d = dt.toFormat('dd');
  return `https://calendar.google.com/calendar/r/day/${y}/${m}/${d}`;
}

export default {
  key: 'move_event',
  google: 'calendar',
  needsSlots: true,
  schema: {
    type: 'object',
    properties: {
      hint: { type: 'string', description: 'a word or two naming which event to move' },
    },
    required: ['hint'],
  },
  description: 'Locate an upcoming event the user wants to move.',
  clarify: 'Which event did you want to move?',

  validate(rawArgs) {
    const hint = typeof rawArgs?.hint === 'string' ? rawArgs.hint.trim() : '';
    if (!hint) return { ok: false, reason: 'hint is required' };
    return { ok: true, slots: { hint } };
  },

  async run(ctx) {
    const { db, calendar, dates, zone, now, slots, profileId } = ctx;
    const nowUtc = now.toUTC().toISO({ suppressMilliseconds: true });
    const found = calendar.nextEvent(db, profileId, nowUtc, { hint: slots.hint });
    const asOf = calendar.lastChecked(db);

    if (!found || !found.matchedByHint) {
      return {
        type: 'say',
        text: `I couldn't find an upcoming event matching "${slots.hint}" to move.`,
        source: { kind: 'calendar', asOf },
      };
    }

    const url = dayLinkFor(found.startUtc, zone);
    const sentence =
      `I can't move events on Google Calendar directly yet. I'll open your calendar to ` +
      `${dates.spokenDate(found.startUtc, { now, zone })}, where ${found.summary} is, so you can drag it to a new time yourself. Should I go ahead?`;

    return {
      type: 'confirm',
      action: 'open_link',
      details: { url, message: `Open Google Calendar on ${dates.spokenDate(found.startUtc, { now, zone })} to move ${describeEvent(dates, found, { now, zone })}` },
      sentence,
    };
  },
};
