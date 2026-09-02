// app/lib/dates.js
//
// All date and time math for Scout lives here. The model never computes a
// date or a time; it only ever sees the words this module produces. Parsing
// uses chrono-node (English locale) against a real reference "now" built in
// the calendar's own zone. Arithmetic and formatting use luxon.
//
// Vague day parts ("Friday morning") must not invent a precise time. chrono
// itself leaves the hour uncertain for these and only implies its own
// default hour (6am for morning, 3pm for afternoon, and so on). Scout uses
// its own, different defaults instead, chosen to read naturally out loud:
//
//   morning   ->  9:00
//   afternoon -> 13:00 (1pm)
//   evening   -> 18:00 (6pm)
//   night     -> 20:00 (8pm)
//   tonight   -> 19:00 (7pm)
//
// Because chrono still marks the hour as uncertain in these cases, resolve()
// reports certain.hour: false and adds a `hint` field naming the day part,
// so callers (and Kokoro's phrasing) know this is a guess, not a fact.

import { DateTime } from 'luxon';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// chrono-node ships an English-only entry point at "chrono-node/en". Prefer
// it (it skips loading every other locale); fall back to the default export
// (which is English too) if the subpath ever fails to resolve.
let chrono;
try {
  chrono = require('chrono-node/en');
} catch {
  const mod = require('chrono-node');
  chrono = mod.en ?? mod;
}

const DAYPART_HOURS = {
  morning: 9,
  afternoon: 13,
  evening: 18,
  night: 20,
  tonight: 19,
};

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// --- helpers to normalize the many ways a caller might hand us a moment ---

function toReferenceDateTime(now, zone) {
  const z = zone || 'local';
  if (now instanceof Date) return DateTime.fromJSDate(now, { zone: z });
  if (typeof now === 'string') return DateTime.fromISO(now, { zone: z });
  if (now && typeof now.isValid === 'boolean' && typeof now.setZone === 'function') {
    return now.setZone(z);
  }
  return DateTime.now().setZone(z);
}

function toDateTime(input, zone) {
  let dt;
  if (input && typeof input.isValid === 'boolean' && typeof input.setZone === 'function') {
    dt = zone ? input.setZone(zone) : input;
  } else if (input instanceof Date) {
    dt = zone ? DateTime.fromJSDate(input, { zone }) : DateTime.fromJSDate(input);
  } else if (typeof input === 'string') {
    // With an explicit zone, interpret a naive string as wall-clock time in
    // that zone; a string with its own offset still converts correctly. With
    // no zone given, keep whatever offset the string itself carries.
    dt = zone ? DateTime.fromISO(input, { zone }) : DateTime.fromISO(input, { setZone: true });
  } else {
    throw new TypeError('expected a luxon DateTime, a Date, or an ISO string');
  }
  return dt.setLocale('en-US');
}

function detectDaypartHint(matchedText) {
  const t = matchedText.toLowerCase();
  if (/\btonight\b/.test(t)) return 'tonight';
  if (/\bmorning\b/.test(t)) return 'morning';
  if (/\bafternoon\b/.test(t)) return 'afternoon';
  if (/\bevening\b/.test(t)) return 'evening';
  if (/\bnight\b/.test(t)) return 'night';
  return null;
}

// --- resolve: free text -> a single point in time (or a short span) ------

export function resolve(text, { now, zone } = {}) {
  if (!text || typeof text !== 'string') return null;
  if (!zone) throw new Error('resolve() requires a zone');

  const refDt = toReferenceDateTime(now, zone);
  const results = chrono.parse(
    text,
    { instant: refDt.toJSDate(), timezone: refDt.offset },
    { forwardDate: true },
  );
  if (!results || results.length === 0) return null;

  const result = results[0];
  const certain = {
    hour: result.start.isCertain('hour'),
    minute: result.start.isCertain('minute'),
    day: result.start.isCertain('day') || result.start.isCertain('weekday'),
  };

  const hint = detectDaypartHint(result.text);

  let startDt = DateTime.fromJSDate(result.start.date(), { zone });
  if (hint && !certain.hour) {
    startDt = startDt.set({ hour: DAYPART_HOURS[hint], minute: 0, second: 0, millisecond: 0 });
  }

  let endDt = null;
  if (result.end) {
    endDt = DateTime.fromJSDate(result.end.date(), { zone });
  }

  const allDay = !certain.hour && !hint;

  return {
    start: startDt.toISO({ suppressMilliseconds: true }),
    end: endDt ? endDt.toISO({ suppressMilliseconds: true }) : null,
    allDay,
    certain,
    matched: result.text,
    ...(hint ? { hint } : {}),
  };
}

// --- windowFor: the small fixed set of calendar windows -------------------

export function windowFor(text, { now, zone } = {}) {
  if (!text || typeof text !== 'string') return null;
  if (!zone) throw new Error('windowFor() requires a zone');

  const ref = toReferenceDateTime(now, zone);
  const t = text.trim().toLowerCase();

  // luxon's endOf() lands on xx:59:59.999; drop the trailing millisecond so
  // window edges read as a clean xx:59:59 in ISO output.
  const endOfDay = (d) => d.endOf('day').set({ millisecond: 0 });
  const endOfMonth = (d) => d.endOf('month').set({ millisecond: 0 });
  const toIso = (d) => d.toUTC().toISO({ suppressMilliseconds: true });

  const dayWindow = (d, label) => ({
    startUtc: toIso(d.startOf('day')),
    endUtc: toIso(endOfDay(d)),
    label,
  });

  if (/\btoday\b/.test(t)) return dayWindow(ref, 'today');
  if (/\btomorrow\b/.test(t)) return dayWindow(ref.plus({ days: 1 }), 'tomorrow');
  if (/\byesterday\b/.test(t)) return dayWindow(ref.minus({ days: 1 }), 'yesterday');

  if (/\bnext\s+week\b/.test(t)) {
    const monday = ref.startOf('week').plus({ weeks: 1 });
    return {
      startUtc: toIso(monday),
      endUtc: toIso(endOfDay(monday.plus({ days: 6 }))),
      label: 'next week',
    };
  }
  if (/\bthis\s+week\b/.test(t)) {
    const monday = ref.startOf('week');
    return {
      startUtc: toIso(monday),
      endUtc: toIso(endOfDay(monday.plus({ days: 6 }))),
      label: 'this week',
    };
  }
  if (/\bweekend\b/.test(t)) {
    const saturday = ref.startOf('week').plus({ days: 5 });
    const sunday = saturday.plus({ days: 1 });
    return {
      startUtc: toIso(saturday.startOf('day')),
      endUtc: toIso(endOfDay(sunday)),
      label: 'this weekend',
    };
  }

  const weekdayIdx = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (weekdayIdx !== -1) {
    const targetIsoWeekday = weekdayIdx + 1;
    const daysAhead = (targetIsoWeekday - ref.weekday + 7) % 7;
    return dayWindow(ref.plus({ days: daysAhead }), capitalize(WEEKDAYS[weekdayIdx]));
  }

  const monthIdx = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(t));
  if (monthIdx !== -1) {
    let year = ref.year;
    if (monthIdx + 1 < ref.month) year += 1;
    const start = DateTime.fromObject({ year, month: monthIdx + 1, day: 1 }, { zone }).startOf('day');
    return {
      startUtc: toIso(start),
      endUtc: toIso(endOfMonth(start)),
      label: capitalize(MONTHS[monthIdx]),
    };
  }

  return null;
}

// --- spoken time / date / duration / relative -----------------------------

function periodOf(hour) {
  if (hour < 12) return 'in the morning';
  if (hour < 17) return 'in the afternoon';
  if (hour < 21) return 'in the evening';
  return 'at night';
}

function hourWord(hour24) {
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return numberToWords(h);
}

function minuteWord(minute) {
  if (minute < 10) return `oh ${numberToWords(minute)}`;
  return numberToWords(minute);
}

// The core "clock face" phrase, with no morning/afternoon/night suffix.
// standalone results (midnight, noon, quarter to midnight/noon) never take
// a suffix; periodHour says which hour's period governs the suffix when one
// is needed (the *upcoming* hour for "quarter to"). Pass includeOclock:false
// to drop the "o'clock" marker on an exact hour, which reads better inside
// a range ("from three to four in the afternoon", not "three o'clock to...").
function timeCore(hour, minute, { includeOclock = true } = {}) {
  if (hour === 0 && minute === 0) return { phrase: 'midnight', standalone: true };
  if (hour === 12 && minute === 0) return { phrase: 'noon', standalone: true };

  if (minute === 45) {
    const nextHour = (hour + 1) % 24;
    if (nextHour === 0) return { phrase: 'quarter to midnight', standalone: true };
    if (nextHour === 12) return { phrase: 'quarter to noon', standalone: true };
    return { phrase: `quarter to ${hourWord(nextHour)}`, standalone: false, periodHour: nextHour };
  }
  if (minute === 0) {
    const phrase = includeOclock ? `${hourWord(hour)} o'clock` : hourWord(hour);
    return { phrase, standalone: false, periodHour: hour };
  }
  if (minute === 15) return { phrase: `quarter past ${hourWord(hour)}`, standalone: false, periodHour: hour };
  if (minute === 30) return { phrase: `half past ${hourWord(hour)}`, standalone: false, periodHour: hour };

  return { phrase: `${hourWord(hour)} ${minuteWord(minute)}`, standalone: false, periodHour: hour };
}

export function spokenTime(dt, { zone } = {}) {
  const d = toDateTime(dt, zone);
  const core = timeCore(d.hour, d.minute);
  if (core.standalone) return core.phrase;
  return `${core.phrase} ${periodOf(core.periodHour)}`;
}

const ORDINAL_ONES = [
  '', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth',
];
const ORDINAL_TEENS = [
  'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth',
  'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth',
];
const ORDINAL_TENS = [
  '', '', 'twentieth', 'thirtieth',
];
const CARDINAL_TENS = [
  '', '', 'twenty', 'thirty',
];

function ordinalWord(day) {
  if (day <= 9) return ORDINAL_ONES[day];
  if (day <= 19) return ORDINAL_TEENS[day - 10];
  const tens = Math.floor(day / 10);
  const ones = day % 10;
  if (ones === 0) return ORDINAL_TENS[tens];
  return `${CARDINAL_TENS[tens]} ${ORDINAL_ONES[ones]}`;
}

export function spokenDate(dt, { now, zone } = {}) {
  const target = toDateTime(dt, zone);
  const ref = toDateTime(now, target.zoneName);

  const diffDays = Math.round(target.startOf('day').diff(ref.startOf('day'), 'days').days);

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays === -1) return 'yesterday';
  if (diffDays >= 2 && diffDays <= 6) return target.weekdayLong;

  const yearSuffix = target.year !== ref.year ? `, ${target.year}` : '';
  if (target.year === ref.year && target.month === ref.month) {
    return `${target.weekdayLong} the ${ordinalWord(target.day)}`;
  }
  return `${target.weekdayLong}, ${target.monthLong} ${ordinalWord(target.day)}${yearSuffix}`;
}

export function spokenDateTime(dt, { now, zone } = {}) {
  return `${spokenDate(dt, { now, zone })} at ${spokenTime(dt, { zone })}`;
}

export function spokenRange(startDt, endDt, { now, zone } = {}) {
  const s = toDateTime(startDt, zone);
  const e = toDateTime(endDt, zone);

  const spansWholeDay =
    s.hour === 0 && s.minute === 0 && s.second === 0 &&
    (
      (e.hour === 23 && e.minute === 59) ||
      e.startOf('day').toMillis() === s.plus({ days: 1 }).startOf('day').toMillis()
    );

  if (spansWholeDay) {
    return `all day ${spokenDate(s, { now, zone })}`;
  }

  const startCore = timeCore(s.hour, s.minute, { includeOclock: false });
  const endCore = timeCore(e.hour, e.minute, { includeOclock: false });
  const endPhrase = endCore.standalone ? endCore.phrase : `${endCore.phrase} ${periodOf(endCore.periodHour)}`;
  return `from ${startCore.phrase} to ${endPhrase}`;
}

export function spokenDuration(minutes) {
  const n = Math.round(minutes);
  if (n < 60) return `${numberToWords(n)} minute${n === 1 ? '' : 's'}`;

  const hours = Math.floor(n / 60);
  const rem = n % 60;
  const hourPhrase = hours === 1 ? 'an hour' : `${numberToWords(hours)} hours`;

  if (rem === 0) return hourPhrase;
  if (rem === 30) return `${hourPhrase} and a half`;
  return `${hourPhrase} and ${numberToWords(rem)} minute${rem === 1 ? '' : 's'}`;
}

export function spokenRelative(dt, { now, zone } = {}) {
  const target = toDateTime(dt, zone);
  const ref = toDateTime(now, target.zoneName);

  const diffMinutes = target.diff(ref, 'minutes').minutes;
  const absMinutes = Math.round(Math.abs(diffMinutes));
  const future = diffMinutes >= 0;

  if (absMinutes === 0) return 'right now';

  let phrase;
  if (absMinutes < 60) {
    phrase = `${numberToWords(absMinutes)} minute${absMinutes === 1 ? '' : 's'}`;
  } else if (absMinutes < 1440) {
    const hours = Math.round(absMinutes / 60);
    phrase = `${numberToWords(hours)} hour${hours === 1 ? '' : 's'}`;
  } else {
    const days = Math.round(absMinutes / 1440);
    phrase = `${numberToWords(days)} day${days === 1 ? '' : 's'}`;
  }

  return future ? `in ${phrase}` : `${phrase} ago`;
}

// --- numberToWords: shared with scrub.js -----------------------------------

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
];

function threeDigitWords(n) {
  const parts = [];
  if (n >= 100) {
    parts.push(ONES[Math.floor(n / 100)], 'hundred');
    n %= 100;
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)]);
    n %= 10;
    if (n > 0) parts.push(ONES[n]);
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(' ');
}

export function numberToWords(n) {
  let num = Math.round(n);
  if (num === 0) return 'zero';
  const negative = num < 0;
  num = Math.abs(num);

  const billions = Math.floor(num / 1e9);
  num %= 1e9;
  const millions = Math.floor(num / 1e6);
  num %= 1e6;
  const thousands = Math.floor(num / 1e3);
  num %= 1e3;
  const rest = num;

  const parts = [];
  if (billions) parts.push(`${threeDigitWords(billions)} billion`);
  if (millions) parts.push(`${threeDigitWords(millions)} million`);
  if (thousands) parts.push(`${threeDigitWords(thousands)} thousand`);
  if (rest || parts.length === 0) parts.push(threeDigitWords(rest));

  return (negative ? 'negative ' : '') + parts.join(' ');
}

// --- small time helpers ----------------------------------------------------

export function nowIn(zone) {
  return DateTime.now().setZone(zone);
}

export function toUtcIso(dt) {
  return toDateTime(dt).toUTC().toISO({ suppressMilliseconds: true });
}

export function fromUtc(iso, zone) {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone);
}
