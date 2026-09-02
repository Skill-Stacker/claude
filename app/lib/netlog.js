// The "What Scout just did" log: a ring buffer of every outbound call this
// software itself initiated (Gmail IMAP/SMTP, the calendar's secret iCal
// fetch, an asset download, and so on). This is a network audit trail, not a
// statement about file security at rest, and the UI copy must say so.
//
// Usage:
//   import { createNetlog } from './netlog.js';
//   const netlog = createNetlog(bus);
//   netlog.record({ kind: 'https', host: 'calendar.google.com', purpose: 'refresh calendar', bytes: 4096, ok: true });
//   netlog.list();
//   netlog.clear();

const MAX_ENTRIES = 200;

// Shown next to the panel in the UI. Never phrase this as a claim about
// encryption or storage; it only ever describes network calls.
export const NETLOG_DESCRIPTION =
  'This lists the connections this software made to reach the internet. ' +
  'It says nothing about whether files on this stick are protected at rest.';

export function createNetlog(bus) {
  const entries = [];
  let nextId = 1;

  function record({ kind, host, purpose, bytes = null, ok = true, detail = null } = {}) {
    const entry = {
      id: nextId++,
      time: new Date().toISOString(),
      kind,
      host,
      purpose,
      bytes,
      ok,
      detail,
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    if (bus) bus.publish('netlog', entry);
    return entry;
  }

  function list() {
    return entries.slice();
  }

  function clear() {
    entries.length = 0;
  }

  return { record, list, clear, description: NETLOG_DESCRIPTION };
}
