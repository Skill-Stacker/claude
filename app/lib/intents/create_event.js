// create_event: "put a dentist appointment on my calendar for next Tuesday
// at 3". The model extracts the title and (optionally) location only; code
// resolves the date/time with dates.resolve, never the model. Scout has no
// OAuth, so it never writes to Google Calendar directly: this always ends
// as a pendingAction whose confirmed action is a prefilled
// calendar.google.com "add event" link (see app/lib/google/links.js) that
// the human opens and saves themselves.
import { DateTime } from 'luxon';
import { calendarTemplateUrl, describeTemplate } from '../google/links.js';
import { DEFAULT_EVENT_MINUTES } from './shared.js';

export default {
  key: 'create_event',
  google: 'calendar',
  needsSlots: true,
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'a short title for the event' },
      when_text: { type: 'string', description: 'the day and time the user wants the event, in their own words' },
      location: { type: 'string', description: 'a location, empty string if none was mentioned' },
    },
    required: ['title', 'when_text'],
  },
  description: 'Create a new calendar event with a title and a time.',
  clarify: 'What day and time should I put that on?',

  validate(rawArgs) {
    const title = typeof rawArgs?.title === 'string' ? rawArgs.title.trim() : '';
    const whenText = typeof rawArgs?.when_text === 'string' ? rawArgs.when_text.trim() : '';
    const location = typeof rawArgs?.location === 'string' ? rawArgs.location.trim() : '';
    if (!title) return { ok: false, reason: 'title is required' };
    if (!whenText) return { ok: false, reason: 'when_text is required' };
    return { ok: true, slots: { title, when_text: whenText, location } };
  },

  async run(ctx) {
    const { dates, zone, now, slots } = ctx;
    const resolved = dates.resolve(slots.when_text, { now, zone });
    if (!resolved) {
      return { type: 'clarify', question: 'What day and time should I put that on?' };
    }

    const allDay = resolved.allDay;
    const startUtc = DateTime.fromISO(resolved.start, { zone }).toUTC().toISO({ suppressMilliseconds: true });
    const endUtc = allDay
      ? startUtc
      : resolved.end
        ? DateTime.fromISO(resolved.end, { zone }).toUTC().toISO({ suppressMilliseconds: true })
        : DateTime.fromISO(resolved.start, { zone }).plus({ minutes: DEFAULT_EVENT_MINUTES }).toUTC().toISO({ suppressMilliseconds: true });

    const spokenWhen = allDay
      ? dates.spokenDate(resolved.start, { now, zone })
      : dates.spokenDateTime(resolved.start, { now, zone });

    const sentence = `I'll add ${slots.title} on ${spokenWhen}${slots.location ? ` at ${slots.location}` : ''}. Should I go ahead?`;

    return {
      type: 'confirm',
      action: 'create_event',
      details: {
        title: slots.title,
        startUtc,
        endUtc,
        allDay,
        zone,
        location: slots.location || null,
      },
      sentence,
    };
  },
};

// Used by confirm.js once the human says yes: builds the prefilled Google
// Calendar link and the plain sentence the page shows next to it. Exported
// separately so confirm.js does not need to re-derive the same shape.
export function performCreateEvent(details) {
  const url = calendarTemplateUrl({
    title: details.title,
    startUtc: details.startUtc,
    endUtc: details.endUtc,
    allDay: details.allDay,
    zone: details.zone,
    location: details.location || undefined,
  });
  const message = describeTemplate({
    title: details.title,
    startUtc: details.startUtc,
    allDay: details.allDay,
    zone: details.zone,
    location: details.location || undefined,
  });
  return { url, message };
}
