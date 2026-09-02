// chat: anything that isn't a calendar, mail, or reminder job. brain.js
// special-cases this result type (no tools, no snapshot, just a normal
// streamed reply from the persona-prefixed conversation), so this module
// only declares the registry entry; there is no slot schema and run() is
// never actually invoked by brain.js (kept here anyway so the registry
// stays uniform and testable).
export default {
  key: 'chat',
  google: null,
  needsSlots: false,
  schema: null,
  clarify: null,

  async run() {
    return { type: 'chat' };
  },
};
