import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  forSpeech,
  spokenEmailAddress,
  spelledSlowly,
  chunkForKokoro,
  firstClause,
} from '../app/lib/speech/scrub.js';

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);
const CURLY_SINGLE_OPEN = String.fromCharCode(0x2018);
const CURLY_SINGLE_CLOSE = String.fromCharCode(0x2019);
const CURLY_DOUBLE_OPEN = String.fromCharCode(0x201c);
const CURLY_DOUBLE_CLOSE = String.fromCharCode(0x201d);

describe('forSpeech(): markdown stripping', () => {
  test('headings', () => {
    assert.equal(forSpeech('# Weekly Plan'), 'Weekly Plan.');
    assert.equal(forSpeech('## Notes'), 'Notes.');
  });

  test('bold', () => {
    assert.equal(forSpeech('This is **important**.'), 'This is important.');
    assert.equal(forSpeech('This is __also bold__.'), 'This is also bold.');
  });

  test('italics', () => {
    assert.equal(forSpeech('This is *emphasized*.'), 'This is emphasized.');
    assert.equal(forSpeech('This is _also emphasized_.'), 'This is also emphasized.');
  });

  test('code fences drop the fence markers and keep the content', () => {
    assert.equal(forSpeech('```\nplain text\n```'), 'plain text.');
  });

  test('inline code', () => {
    assert.equal(forSpeech('Run `npm test` first.'), 'Run npm test first.');
  });

  test('links keep the label and drop the url', () => {
    assert.equal(
      forSpeech('See the [release notes](https://example.com/notes) for details.'),
      'See the release notes for details.',
    );
  });

  test('bullets become sentences ending with a period', () => {
    assert.equal(forSpeech('- milk\n- eggs\n- bread'), 'milk. eggs. bread.');
    assert.equal(forSpeech('1. first step\n2. second step'), 'first step. second step.');
  });

  test('tables become lines', () => {
    const table = '| Name | Age |\n|------|-----|\n| Jane | 30 |';
    assert.equal(forSpeech(table), 'Name, Age. Jane, thirty.');
  });
});

describe('forSpeech(): links and addresses', () => {
  test('a url becomes a spoken host reference, dropping www and the path', () => {
    assert.equal(
      forSpeech('Read more at https://www.example.com/blog/post-one'),
      "Read more at a link to example dot com, it's on your screen.",
    );
  });

  test('a bare www url without a protocol', () => {
    assert.equal(
      forSpeech('Check www.example.com today'),
      "Check a link to example dot com, it's on your screen today.",
    );
  });

  test('an email address', () => {
    assert.equal(
      forSpeech('Reach me at jane.smith@gmail.com anytime.'),
      'Reach me at jane dot smith at gmail dot com anytime.',
    );
  });

  test('a phone number with dashes', () => {
    assert.equal(
      forSpeech('Call 617-555-1212 for support.'),
      'Call six one seven, five five five, one two one two for support.',
    );
  });

  test('a phone number with parens and a space', () => {
    assert.equal(
      forSpeech('Call (617) 555-1212 for support.'),
      'Call six one seven, five five five, one two one two for support.',
    );
  });

  test('an 11-digit phone number with a leading 1', () => {
    assert.equal(
      forSpeech('Dial 1-617-555-1212 to reach us.'),
      'Dial one, six one seven, five five five, one two one two to reach us.',
    );
  });
});

describe('forSpeech(): money, percentages, and units', () => {
  test('whole dollars with a thousands separator', () => {
    assert.equal(forSpeech('The trip costs $2,000.'), 'The trip costs two thousand dollars.');
  });

  test('dollars and cents', () => {
    assert.equal(forSpeech('The total is $4.99.'), 'The total is four dollars and ninety nine cents.');
  });

  test('a large formatted amount', () => {
    assert.equal(
      forSpeech('The campaign raised $1,250,000.'),
      'The campaign raised one million two hundred fifty thousand dollars.',
    );
  });

  test('a single dollar stays singular', () => {
    assert.equal(forSpeech('It costs $1.'), 'It costs one dollar.');
  });

  test('a percentage', () => {
    assert.equal(forSpeech('Sales are up 15%.'), 'Sales are up fifteen percent.');
  });

  test('units: GB, MB, km', () => {
    assert.equal(forSpeech('The drive holds 500GB.'), 'The drive holds five hundred gigabytes.');
    assert.equal(forSpeech('The file is 16MB.'), 'The file is sixteen megabytes.');
    assert.equal(forSpeech('It is 10km away.'), 'It is ten kilometers away.');
  });
});

describe('forSpeech(): times', () => {
  test('"3:00 PM" style', () => {
    assert.equal(forSpeech('The meeting is at 3:00 PM.'), "The meeting is at three o'clock in the afternoon.");
  });

  test('"3pm" style', () => {
    assert.equal(forSpeech('Call me at 3pm.'), "Call me at three o'clock in the afternoon.");
  });

  test('"15:30" 24-hour style', () => {
    assert.equal(forSpeech('The train leaves at 15:30.'), 'The train leaves at half past three in the afternoon.');
  });
});

describe('forSpeech(): numeric dates', () => {
  test('"9/9" without a year', () => {
    assert.equal(forSpeech('The event is 9/9.'), 'The event is September ninth.');
  });

  test('"9/9/2026" with a year', () => {
    assert.equal(forSpeech('The event is 9/9/2026.'), 'The event is September ninth, 2026.');
  });
});

describe('forSpeech(): numbers', () => {
  test('a raw digit run of five or more digits, chat mode', () => {
    assert.equal(
      forSpeech('Order number 482910573 shipped.'),
      'Order number four eight two, nine one zero, five seven three shipped.',
    );
  });

  test('a raw digit run of five or more digits, email mode', () => {
    assert.equal(
      forSpeech('Order number 482910573 shipped.', { mode: 'email' }),
      "Order number a number that's on your screen shipped.",
    );
  });

  test('plain numbers under ten thousand become words', () => {
    assert.equal(forSpeech('I have 42 apples.'), 'I have forty two apples.');
    assert.equal(forSpeech('There were 1234 attendees.'), 'There were one thousand two hundred thirty four attendees.');
  });

  test('ordinals', () => {
    assert.equal(forSpeech('This is the 3rd time.'), 'This is the third time.');
    assert.equal(forSpeech('She finished 21st.'), 'She finished twenty first.');
  });
});

describe('forSpeech(): fixed word and character rules', () => {
  test('"Q&A" becomes "Q. and A."', () => {
    assert.equal(forSpeech('Time for Q&A.'), 'Time for Q. and A.');
  });

  test('"RAM" is lowercased', () => {
    assert.equal(forSpeech('This needs more RAM.'), 'This needs more ram.');
  });

  test('".env" is spelled out', () => {
    assert.equal(forSpeech('Check the .env file.'), 'Check the dot E N V file.');
  });

  test('a lone article "A" is left alone', () => {
    assert.equal(forSpeech('A good plan beats a great excuse.'), 'A good plan beats a great excuse.');
  });

  test('"AI" is left alone, never spelled "A I"', () => {
    assert.equal(forSpeech('Scout uses AI to help.'), 'Scout uses AI to help.');
  });

  test('em dashes and en dashes become commas', () => {
    assert.equal(forSpeech(`Wait${EM_DASH}no, that changed.`), 'Wait, no, that changed.');
    assert.equal(forSpeech(`A pause${EN_DASH}then more.`), 'A pause, then more.');
  });

  test('ellipses become a period', () => {
    assert.equal(forSpeech('Well... maybe.'), 'Well. maybe.');
    assert.equal(forSpeech(`Well${ELLIPSIS} maybe.`), 'Well. maybe.');
  });

  test('emojis are removed', () => {
    assert.equal(forSpeech('Great job \u{1F389} team \u{1F680}!'), 'Great job team!');
  });

  test('smart quotes are normalized', () => {
    const input = `${CURLY_DOUBLE_OPEN}Hello${CURLY_DOUBLE_CLOSE} and ${CURLY_SINGLE_OPEN}hi${CURLY_SINGLE_CLOSE}.`;
    assert.equal(forSpeech(input), '"Hello" and \'hi\'.');
  });

  test('whitespace is collapsed', () => {
    assert.equal(forSpeech('Too    many\n\nspaces.'), 'Too many spaces.');
  });

  test('a terminal period is added when missing', () => {
    assert.equal(forSpeech('No ending punctuation here'), 'No ending punctuation here.');
  });

  test('a terminal period is not doubled', () => {
    assert.equal(forSpeech('Already has one.'), 'Already has one.');
    assert.equal(forSpeech('Is this fine?'), 'Is this fine?');
    assert.equal(forSpeech('Great!'), 'Great!');
  });
});

describe('forSpeech(): empty and nullish input', () => {
  test('empty string, whitespace, null, undefined', () => {
    assert.equal(forSpeech(''), '');
    assert.equal(forSpeech('   '), '');
    assert.equal(forSpeech(null), '');
    assert.equal(forSpeech(undefined), '');
  });
});

describe('spokenEmailAddress()', () => {
  test('reads naturally', () => {
    assert.equal(spokenEmailAddress('jane.smith@gmail.com'), 'jane dot smith at gmail dot com');
  });
});

describe('spelledSlowly()', () => {
  test('spells the local part letter by letter, comma separated', () => {
    assert.equal(
      spelledSlowly('jane.smith@gmail.com'),
      'j, a, n, e, dot, s, m, i, t, h, at gmail dot com',
    );
  });

  test('a local part with no dot', () => {
    assert.equal(spelledSlowly('jo@example.com'), 'j, o, at example dot com');
  });
});

describe('chunkForKokoro()', () => {
  test('a 300-word paragraph is split at sentence boundaries, never over maxWords', () => {
    const sentence = 'This is sentence number with several plain words in it today.';
    const paragraph = Array.from({ length: 30 }, () => sentence).join(' '); // 30 * 11 = 330 words
    const chunks = chunkForKokoro(paragraph);

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      const wordCount = chunk.split(/\s+/).filter(Boolean).length;
      assert.ok(wordCount <= 85, `chunk has ${wordCount} words: "${chunk}"`);
      assert.ok(chunk.length > 0);
    }

    const totalWords = chunks.reduce((sum, c) => sum + c.split(/\s+/).filter(Boolean).length, 0);
    assert.equal(totalWords, 330);
  });

  test('a single sentence longer than maxWords is split at word boundaries', () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`);
    const longSentence = `${words.join(' ')}.`;
    const chunks = chunkForKokoro(longSentence);

    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      const wordCount = chunk.split(/\s+/).filter(Boolean).length;
      assert.ok(wordCount <= 85, `chunk has ${wordCount} words`);
    }
    const totalWords = chunks.reduce((sum, c) => sum + c.split(/\s+/).filter(Boolean).length, 0);
    assert.equal(totalWords, 120);
  });

  test('a single long sentence with commas splits at the commas first', () => {
    const clause = 'a short clause';
    const clauses = Array.from({ length: 30 }, () => clause);
    const longSentence = `${clauses.join(', ')}.`; // 30 * 3 = 90 words, one sentence
    const chunks = chunkForKokoro(longSentence, { maxWords: 20 });

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      const wordCount = chunk.split(/\s+/).filter(Boolean).length;
      assert.ok(wordCount <= 20, `chunk has ${wordCount} words: "${chunk}"`);
    }
  });

  test('short text fits in a single chunk', () => {
    const chunks = chunkForKokoro('Just a short reply.');
    assert.deepEqual(chunks, ['Just a short reply.']);
  });

  test('respects a custom maxWords', () => {
    const paragraph = 'One two three. Four five six. Seven eight nine.';
    const chunks = chunkForKokoro(paragraph, { maxWords: 6 });
    for (const chunk of chunks) {
      const wordCount = chunk.split(/\s+/).filter(Boolean).length;
      assert.ok(wordCount <= 6);
    }
  });
});

describe('firstClause()', () => {
  test('returns the first clause reaching minWords', () => {
    assert.equal(
      firstClause('Sure, I can help with that, let me check your calendar for tomorrow.'),
      'Sure, I can help with that,',
    );
  });

  test('accumulates short leading clauses until minWords is reached', () => {
    assert.equal(
      firstClause('Okay, sure, I can help you with that request.'),
      'Okay, sure, I can help you with that request.',
    );
  });

  test('returns null when the whole text is shorter than minWords', () => {
    assert.equal(firstClause('Yes.'), null);
    assert.equal(firstClause('No thanks.'), null);
  });

  test('returns null for empty input', () => {
    assert.equal(firstClause(''), null);
    assert.equal(firstClause(undefined), null);
  });

  test('respects a custom minWords', () => {
    assert.equal(firstClause('Sure thing.', { minWords: 2 }), 'Sure thing.');
  });
});
