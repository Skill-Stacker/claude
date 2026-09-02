// Builds a prefilled calendar.google.com "add event" link. This is Scout's
// only way to write to Google Calendar: there is no OAuth, so instead of
// creating the event ourselves we hand the human a link with everything
// already filled in, they press Save, and Google does the writing.
//
// https://calendar.google.com/calendar/render?action=TEMPLATE&...

const BASE = 'https://calendar.google.com/calendar/render?action=TEMPLATE';

function isoParts(iso) {
  const d = new Date(iso);
  const compact = d.toISOString().replace(/[-:]/g, '');
  return {
    datePart: compact.slice(0, 8), // YYYYMMDD
    dateTimePart: `${compact.slice(0, 15)}Z`, // YYYYMMDDTHHmmssZ
  };
}

function addOneUtcDay(datePart) {
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(4, 6)) - 1;
  const day = Number(datePart.slice(6, 8));
  const d = new Date(Date.UTC(year, month, day));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function datesParam({ startUtc, endUtc, allDay }) {
  if (allDay) {
    const start = isoParts(startUtc).datePart;
    let end = isoParts(endUtc || startUtc).datePart;
    if (end === start) end = addOneUtcDay(start);
    return `${start}/${end}`;
  }
  const start = isoParts(startUtc).dateTimePart;
  const end = isoParts(endUtc || startUtc).dateTimePart;
  return `${start}/${end}`;
}

// Builds the "Add to Google Calendar" template link. `startUtc`/`endUtc` are
// UTC ISO strings. `zone` is the IANA zone to show the event in (ctz). All
// other fields are optional. Every value is percent-encoded, so a title with
// '&', quotes, or spaces round-trips safely.
export function calendarTemplateUrl({
  title,
  startUtc,
  endUtc,
  allDay = false,
  zone,
  details,
  location,
  guests,
  rrule,
} = {}) {
  const parts = [BASE];
  parts.push(`text=${encodeURIComponent(title || '')}`);
  parts.push(`dates=${encodeURIComponent(datesParam({ startUtc, endUtc, allDay }))}`);
  if (zone) parts.push(`ctz=${encodeURIComponent(zone)}`);
  if (details) parts.push(`details=${encodeURIComponent(details)}`);
  if (location) parts.push(`location=${encodeURIComponent(location)}`);
  if (Array.isArray(guests) && guests.length > 0) {
    parts.push(`add=${encodeURIComponent(guests.join(','))}`);
  }
  if (rrule) {
    const body = String(rrule).replace(/^RRULE:/i, '');
    parts.push(`recur=${encodeURIComponent(`RRULE:${body}`)}`);
  }
  return parts.join('&');
}

function formatWhen({ startUtc, allDay, zone }) {
  const d = new Date(startUtc);
  const opts = { weekday: 'long', month: 'long', day: 'numeric', timeZone: zone || 'UTC' };
  const dateText = d.toLocaleDateString('en-US', opts);
  if (allDay) return `on ${dateText}`;
  const timeText = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone || 'UTC',
  });
  return `on ${dateText} at ${timeText}`;
}

// The plain sentence the UI shows next to the link, e.g.
// "Add 'Dentist' on Tuesday, September 8 at 3:00 PM in Google Calendar, then press Save."
export function describeTemplate({ title, startUtc, allDay = false, zone, location } = {}) {
  const when = formatWhen({ startUtc, allDay, zone });
  const where = location ? ` at ${location}` : '';
  return `Add '${title}' ${when}${where} in Google Calendar, then press Save.`;
}
