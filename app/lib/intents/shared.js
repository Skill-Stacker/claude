// Shared helpers for the intent modules in this directory. Nothing here is
// itself an intent; each intents/<name>.js file owns exactly one entry in
// the Stage 1 enum (see index.js), and reaches into this file for the bits
// that are the same across several of them: slot validation, connectivity
// and lock gating, and small spoken-text builders built on top of
// app/lib/dates.js.
//
// The contract every intent module follows (see index.js for the registry):
//
//   export default {
//     key: 'today_agenda',
//     google: 'calendar' | 'gmail' | null,   // which connected service (if any) gates this intent
//     needsSlots: false,
//     schema: null | { type: 'object', properties: {...}, required: [...] },
//     clarify: 'a targeted follow-up question, used when slot validation fails',
//     validate(rawArgs) { ... },              // -> { ok: true, slots } | { ok: false, reason }
//     async run(ctx) { ... },                 // -> one of the result shapes below
//   };
//
// run(ctx) returns one of:
//   { type: 'narrate', data: '<compact text block for the model to narrate>', source }
//   { type: 'say', text: '<final spoken sentence, code-built, no model call>', source }
//   { type: 'clarify', question: '<one targeted question>' }
//   { type: 'confirm', action, details, sentence }
//
// `source` (when present) is `{ kind: 'calendar' | 'inbox' | 'reminders', asOf }`
// and becomes the `source` SSE event so the page can show where a fact came from.

const MAX_SLOT_STRING = 500;

// ---------------------------------------------------------------------------
// Slot validation
// ---------------------------------------------------------------------------

// A small, generic validator over a flat { type: 'object', properties, required }
// schema: every property is a string, number or boolean, one level deep, no
// $ref, no pattern, matching the tool-schema rule in CLAUDE.md. Strings are
// trimmed; a required string that is empty after trimming fails validation.
// An optional string missing from rawArgs defaults to ''.
export function validateSlots(schema, rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') {
    return { ok: false, reason: 'no arguments returned' };
  }
  const required = new Set(schema.required || []);
  const slots = {};
  for (const [name, def] of Object.entries(schema.properties || {})) {
    const raw = rawArgs[name];
    if (def.type === 'string') {
      let value = typeof raw === 'string' ? raw.trim() : '';
      if (value.length > MAX_SLOT_STRING) value = value.slice(0, MAX_SLOT_STRING);
      if (required.has(name) && value.length === 0) {
        return { ok: false, reason: `${name} is required` };
      }
      slots[name] = value;
    } else if (def.type === 'number' || def.type === 'integer') {
      const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw);
      if (required.has(name) && !Number.isFinite(value)) {
        return { ok: false, reason: `${name} must be a number` };
      }
      slots[name] = Number.isFinite(value) ? value : null;
    } else if (def.type === 'boolean') {
      slots[name] = raw === true;
    } else {
      slots[name] = raw ?? null;
    }
  }
  return { ok: true, slots };
}

export function toolDefFor(def) {
  return {
    type: 'function',
    function: {
      name: def.key,
      description: def.description || def.key,
      parameters: def.schema,
    },
  };
}

// ---------------------------------------------------------------------------
// Connectivity and lock gating (shared by brain.js, kept here so every
// intent module and its tests can reach the exact same definition of
// "connected").
// ---------------------------------------------------------------------------

// "Connected" is the presence of saved credentials on disk, the same signal
// profiles.hasGoogleConnected uses, just split by service since a profile
// can have one connected and not the other.
export function googleConnection(profiles, paths, profile) {
  const secrets = profiles.readSecrets(paths.profiles, profile) || {};
  return { calendar: !!secrets.calendar, gmail: !!secrets.gmail };
}

export const NOT_CONNECTED_TEXT = {
  calendar: "I don't have your calendar connected yet. Open Settings to connect Google Calendar.",
  gmail: "I don't have Gmail connected yet. Open Settings to connect Gmail.",
};

export const LOCKED_TEXT = "Scout is locked right now. Enter the PIN to unlock, then ask again.";

// ---------------------------------------------------------------------------
// Spoken helpers built on dates.js, shared by the calendar and mail intents.
// ---------------------------------------------------------------------------

export function describeEvent(dates, ev, { now, zone }) {
  const when = ev.allDay
    ? `all day ${dates.spokenDate(ev.startUtc, { now, zone })}`
    : `${dates.spokenDate(ev.startUtc, { now, zone })} ${dates.spokenRange(ev.startUtc, ev.endUtc, { now, zone })}`;
  const where = ev.location ? `, at ${ev.location}` : '';
  return `${ev.summary || 'Untitled event'}: ${when}${where}.`;
}

export function eventsSnapshot(dates, events, { now, zone }) {
  if (!events.length) return 'No matching events were found.';
  return events.map((ev, i) => `${i + 1}. ${describeEvent(dates, ev, { now, zone })}`).join('\n');
}

export function asOfPrefix(dates, lastCheckedIso, zone) {
  if (!lastCheckedIso) return '';
  return `As of my last check at ${dates.spokenTime(lastCheckedIso, { zone })}, `;
}

// A short, plain description of one email message for a narration data block.
export function describeMessage(m) {
  const from = m.from_name || m.from_addr || 'someone';
  const when = m.date_utc ? new Date(m.date_utc).toISOString().slice(0, 10) : '';
  const snippet = (m.snippet || '').slice(0, 200);
  return `From ${from}${when ? ` on ${when}` : ''}, subject "${m.subject || '(no subject)'}": ${snippet}`;
}

export function messagesSnapshot(messages) {
  if (!messages.length) return 'No matching messages were found.';
  return messages.map((m, i) => `${i + 1}. ${describeMessage(m)}`).join('\n');
}

// ---------------------------------------------------------------------------
// Duration default for a timed event with no explicit end.
// ---------------------------------------------------------------------------

export const DEFAULT_EVENT_MINUTES = 60;

// ---------------------------------------------------------------------------
// Locating a message from a spoken hint (a sender's name, or a subject
// word), shared by read_message and thread_summary. Tries a contact/recent
// sender match first (the hint is probably a name), then falls back to a
// keyword match against subject and body. Never guesses beyond what one of
// those two lookups actually returns.
// ---------------------------------------------------------------------------

const LOOKBACK_DAYS_FOR_HINT = 365;

export function findMessageByHint(db, gmail, contacts, profileId, hint, now) {
  const sinceUtc = now.minus({ days: LOOKBACK_DAYS_FOR_HINT }).toUTC().toISO({ suppressMilliseconds: true });

  const resolved = contacts.resolveRecipient(db, profileId, hint);
  if (resolved.status === 'one') {
    const bySender = gmail.recentFrom(db, profileId, resolved.contact.address, sinceUtc);
    if (bySender.length) return bySender[0];
  }

  const byKeyword = gmail.keywordScan(db, profileId, hint, sinceUtc);
  if (byKeyword.length) return byKeyword[0];

  return null;
}
