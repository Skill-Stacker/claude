// The morning brief: today's events, unread mail, and open reminders,
// plus the one sentence Scout reads aloud for it. No weather, no news: the
// product only ever reports what is actually connected and cached.
//
// Usage:
//   import { buildBrief } from './brief.js';
//   const brief = buildBrief({ db, profileId, now: new Date(), zone: 'America/New_York' });

import * as dates from './dates.js';
import { listEvents, lastChecked } from './google/calendar.js';
import { listOpen } from './reminders.js';

// dates.js does not export an hour-of-day helper directly usable here, so
// this reads the hour the same way dates.spokenTime does: through a plain
// Date read in the target zone via Intl, which needs no extra import.
function hourInZone(now, zone) {
  const d = now instanceof Date ? now : new Date(now);
  const formatted = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: zone }).format(d);
  return Number(formatted);
}

function buildGreeting(now, zone) {
  const hour = hourInZone(now, zone);
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function countPhrase(n, singular, plural) {
  if (n === 0) return null;
  return `${n === 1 ? 'one' : dates.numberToWords(n)} ${n === 1 ? singular : plural}`;
}

export function buildBrief({ db, profileId, now = new Date(), zone = 'UTC' }) {
  const window = dates.windowFor('today', { now, zone });
  const events = listEvents(db, profileId, window.startUtc, window.endUtc);

  const unread = db.all(
    'SELECT * FROM messages WHERE profile_id = ? AND is_unread = 1 ORDER BY date_utc DESC',
    [profileId],
  );

  const reminders = listOpen(db, profileId);

  const asOf = lastChecked(db);
  const greeting = buildGreeting(now, zone);

  const parts = [];
  parts.push(countPhrase(events.length, 'event', 'events') ?? 'nothing on the calendar');
  parts.push(countPhrase(unread.length, 'unread message', 'unread messages') ?? 'no unread mail');
  parts.push(countPhrase(reminders.length, 'open reminder', 'open reminders') ?? 'no open reminders');

  const spoken = `${greeting}. Today you have ${parts[0]}, ${parts[1]}, and ${parts[2]}.`;

  return { greeting, events, unread, reminders, asOf, spoken };
}
