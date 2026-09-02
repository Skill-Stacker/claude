// keyword_scan: "search my mail for the word invoice". The model extracts
// the keyword only; the lookback window is code-decided (Stage 0's
// dates.windowFor over the raw utterance, when the phrase named one, else a
// fixed default), never asked of the model.
import { messagesSnapshot } from './shared.js';

const DEFAULT_LOOKBACK_DAYS = 90;

export default {
  key: 'keyword_scan',
  google: 'gmail',
  needsSlots: true,
  schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: 'the word or short phrase to search for in the subject or body' },
    },
    required: ['keyword'],
  },
  description: 'Search cached email for a keyword.',
  clarify: 'What word or phrase should I search for?',

  validate(rawArgs) {
    const keyword = typeof rawArgs?.keyword === 'string' ? rawArgs.keyword.trim() : '';
    if (!keyword) return { ok: false, reason: 'keyword is required' };
    return { ok: true, slots: { keyword } };
  },

  async run(ctx) {
    const { db, gmail, dates, zone, now, profileId, slots, utterance } = ctx;
    const window = dates.windowFor(utterance, { now, zone });
    const sinceUtc = window
      ? window.startUtc
      : now.minus({ days: DEFAULT_LOOKBACK_DAYS }).toUTC().toISO({ suppressMilliseconds: true });

    const messages = gmail.keywordScan(db, profileId, slots.keyword, sinceUtc);
    const asOf = db.getState('gmail:lastChecked', null);
    return {
      type: 'narrate',
      data: `Messages matching "${slots.keyword}":\n${messagesSnapshot(messages)}`,
      source: { kind: 'inbox', asOf },
    };
  },
};
