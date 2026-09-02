// app/lib/speech/scrub.js
//
// Turns arbitrary text (markdown, chat replies, confirmation sentences)
// into words Kokoro can read cleanly out loud. This module is deliberately
// dependency-free: it does not import dates.js or any other app module, so
// it has its own small numberToWords and clock-time formatter rather than
// sharing the ones in app/lib/dates.js.
//
// forSpeech() runs a pipeline of regex passes. Anything already converted
// to its final spoken form is "protected" behind a placeholder token before
// later passes run, so a later number-hunting rule never re-touches text a
// prior rule already spelled out (for example, the raw year kept in a
// numeric-date match, or a phone number's individual digits).

// --- local number-to-words (kept independent from app/lib/dates.js) -------

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

function numberToWords(n) {
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

// Ordinal words for any size: convert the cardinal words, then turn the
// last word into its ordinal form ("twenty one" -> "twenty first").
const ORDINAL_LAST_WORD = {
  zero: 'zeroth', one: 'first', two: 'second', three: 'third', four: 'fourth',
  five: 'fifth', six: 'sixth', seven: 'seventh', eight: 'eighth', nine: 'ninth',
  ten: 'tenth', eleven: 'eleventh', twelve: 'twelfth', thirteen: 'thirteenth',
  fourteen: 'fourteenth', fifteen: 'fifteenth', sixteen: 'sixteenth',
  seventeen: 'seventeenth', eighteen: 'eighteenth', nineteen: 'nineteenth',
  twenty: 'twentieth', thirty: 'thirtieth', forty: 'fortieth', fifty: 'fiftieth',
  sixty: 'sixtieth', seventy: 'seventieth', eighty: 'eightieth', ninety: 'ninetieth',
  hundred: 'hundredth', thousand: 'thousandth', million: 'millionth', billion: 'billionth',
};

function ordinalWords(n) {
  const words = numberToWords(n).split(' ');
  const last = words.pop();
  words.push(ORDINAL_LAST_WORD[last] || last);
  return words.join(' ');
}

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

function digitsToWords(digits) {
  return digits.split('').map((d) => DIGIT_WORDS[Number(d)]).join(' ');
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// --- clock time (a small local twin of dates.js's spokenTime) -------------

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

function spokenClockTime(hour, minute) {
  if (hour === 0 && minute === 0) return 'midnight';
  if (hour === 12 && minute === 0) return 'noon';

  if (minute === 45) {
    const nextHour = (hour + 1) % 24;
    if (nextHour === 0) return 'quarter to midnight';
    if (nextHour === 12) return 'quarter to noon';
    return `quarter to ${hourWord(nextHour)} ${periodOf(nextHour)}`;
  }
  if (minute === 0) return `${hourWord(hour)} o'clock ${periodOf(hour)}`;
  if (minute === 15) return `quarter past ${hourWord(hour)} ${periodOf(hour)}`;
  if (minute === 30) return `half past ${hourWord(hour)} ${periodOf(hour)}`;
  return `${hourWord(hour)} ${minuteWord(minute)} ${periodOf(hour)}`;
}

// --- markdown stripping -----------------------------------------------------

function stripMarkdown(text) {
  let t = text;

  // Code fences: drop the fence markers and any language tag, keep the code.
  t = t.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_, code) => code.trim());

  const lines = t.split(/\r?\n/);
  const outLines = [];

  for (const raw of lines) {
    const line = raw.trim();

    // A table separator row, e.g. "|---|---|" or "--- | ---".
    if (line.length > 0 && /^[\s|:-]+$/.test(line) && line.includes('-')) {
      continue;
    }

    // A table data row: "| a | b | c |".
    if (/^\|.*\|$/.test(line)) {
      const cells = line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length > 0) {
        let sentence = cells.join(', ');
        if (!/[.!?]$/.test(sentence)) sentence += '.';
        outLines.push(sentence);
      }
      continue;
    }

    // A heading: "# Title", "## Title", and so on.
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      let sentence = heading[1].trim();
      if (sentence && !/[.!?]$/.test(sentence)) sentence += '.';
      outLines.push(sentence);
      continue;
    }

    // A bullet: "- item", "* item", "+ item", "1. item", "2) item".
    const bullet = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      let sentence = bullet[1].trim();
      if (sentence && !/[.!?]$/.test(sentence)) sentence += '.';
      outLines.push(sentence);
      continue;
    }

    outLines.push(line);
  }

  t = outLines.join(' ');

  // Bold before italic, so "**x**" doesn't get half-eaten by the italic rule.
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/__(.+?)__/g, '$1');
  t = t.replace(/\*(.+?)\*/g, '$1');
  t = t.replace(/(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])/g, '$1');

  // Inline code.
  t = t.replace(/`([^`]+)`/g, '$1');

  // Links: keep the label, drop the URL.
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  return t;
}

// --- character-level normalization -----------------------------------------

function normalizeDashesAndEllipses(t) {
  return t
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/…/g, '.')
    .replace(/\.{3,}/g, '.');
}

function normalizeSmartQuotes(t) {
  return t
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

function removeEmojis(t) {
  return t.replace(
    /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}‍️]/gu,
    '',
  );
}

function replaceMisc(t) {
  return t
    .replace(/Q&A/gi, 'Q. and A.')
    .replace(/\bRAM\b/g, 'ram')
    .replace(/\.env\b/gi, 'dot E N V');
}

// --- links, addresses, phone numbers -----------------------------------------

function hostToSpeech(host) {
  const clean = host.replace(/^www\./i, '');
  return clean.split('.').join(' dot ');
}

function urlToSpeech(url) {
  const rest = url.replace(/^https?:\/\//i, '');
  const host = rest.split(/[/?#]/)[0];
  return `a link to ${hostToSpeech(host)}, it's on your screen`;
}

const URL_RE_PROTO = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const URL_RE_WWW = /\bwww\.[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:\/[^\s<>"')\]]*)?/g;

function emailToSpeech(addr) {
  const [local, domain] = addr.split('@');
  return `${local.split('.').join(' dot ')} at ${domain.split('.').join(' dot ')}`;
}

const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

// \b fails right before "(" (neither the preceding space nor "(" is a word
// character, so there is no boundary transition there), so this anchors on
// "not preceded/followed by a digit" instead, which works for both
// "617-555-1212" and "(617) 555-1212".
const PHONE_RE = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g;

function phoneToSpeech(match) {
  const digits = match.replace(/\D/g, '');
  let prefix = '';
  let body = digits;
  if (digits.length === 11) {
    prefix = `${DIGIT_WORDS[Number(digits[0])]}, `;
    body = digits.slice(1);
  }
  const groups = [body.slice(0, 3), body.slice(3, 6), body.slice(6, 10)];
  return prefix + groups.map(digitsToWords).join(', ');
}

// --- money, percentages, units -----------------------------------------------

const MONEY_RE = /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g;

function moneyToSpeech(m) {
  const raw = m.slice(1);
  const [wholePart, centsPart] = raw.split('.');
  const whole = Number(wholePart.replace(/,/g, ''));
  let out = `${numberToWords(whole)} dollar${whole === 1 ? '' : 's'}`;
  if (centsPart) {
    const cents = Number(centsPart);
    if (cents > 0) {
      out += ` and ${numberToWords(cents)} cent${cents === 1 ? '' : 's'}`;
    }
  }
  return out;
}

const PERCENT_RE = /\b(\d+(?:\.\d+)?)%/g;

function percentToSpeech(numStr) {
  if (numStr.includes('.')) {
    const [w, f] = numStr.split('.');
    return `${numberToWords(Number(w))} point ${digitsToWords(f)} percent`;
  }
  return `${numberToWords(Number(numStr))} percent`;
}

const UNIT_WORDS = { gb: 'gigabytes', mb: 'megabytes', km: 'kilometers' };
const UNIT_RE = /\b(\d+(?:\.\d+)?)\s?(GB|MB|km)\b/gi;

// --- times and numeric dates --------------------------------------------------

const TIME_RE_A = /\b(1[0-2]|0?[1-9]):([0-5]\d)\s*([AaPp])\.?[Mm]\.?\b/g;
const TIME_RE_B = /\b(1[0-2]|0?[1-9])\s*([AaPp])\.?[Mm]\.?\b/g;
const TIME_RE_C = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;

function to24Hour(hourStr, meridiem) {
  let hour = Number(hourStr) % 12;
  if (/p/i.test(meridiem)) hour += 12;
  return hour;
}

// "9/9" -> "September ninth"; "9/9/2026" -> "September ninth, 2026" (the
// year is deliberately left as digits here, matching the product's date
// display convention; every other number path in this module spells out
// its digits).
const DATE_RE = /\b(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])(?:\/(\d{4}|\d{2}))?\b/g;

function dateToSpeech(monthStr, dayStr, yearStr) {
  const month = MONTH_NAMES[Number(monthStr) - 1];
  const day = ordinalWords(Number(dayStr));
  return yearStr ? `${month} ${day}, ${yearStr}` : `${month} ${day}`;
}

// --- large numbers -------------------------------------------------------------

const COMMA_NUM_RE = /\b\d{1,3}(?:,\d{3})+\b/g;
const ORDINAL_RE = /\b(\d+)(st|nd|rd|th)\b/gi;
const PLAIN_NUM_RE = /\b\d{1,4}\b/g;

// A raw, unformatted run of 5+ digits reads as an opaque ID (order number,
// confirmation code) rather than a quantity, so it never goes through
// numberToWords: it becomes a placeholder pointing at the screen, or
// digits grouped in threes.
const DIGIT_RUN_RE = /\b\d{5,}\b/g;

function digitRunToSpeech(run, mode) {
  if (mode === 'email') return "a number that's on your screen";
  const groups = [];
  for (let i = 0; i < run.length; i += 3) groups.push(run.slice(i, i + 3));
  return groups.map(digitsToWords).join(', ');
}

// --- the vault: protect finished spoken text from later numeric passes ------

function letterToken(n) {
  let s = '';
  let x = n + 1;
  while (x > 0) {
    x -= 1;
    s = String.fromCharCode(97 + (x % 26)) + s;
    x = Math.floor(x / 26);
  }
  return s;
}

// --- the pipeline ----------------------------------------------------------

export function forSpeech(text, { mode = 'chat' } = {}) {
  if (text === null || text === undefined) return '';
  let t = String(text);

  t = stripMarkdown(t);
  t = replaceMisc(t);
  t = normalizeDashesAndEllipses(t);
  t = removeEmojis(t);

  let counter = 0;
  const vault = new Map();
  // Tokens are delimited by an actual NUL character, built at runtime with
  // String.fromCharCode so the source file never carries a literal control
  // byte or escape. NUL essentially never appears in real text, so these
  // tokens can never collide with an ordinary word (a plain space-delimited
  // token like " a " would collide with the article "a" anywhere else in
  // the sentence).
  const SEP = String.fromCharCode(0);
  const protect = (s) => {
    const token = SEP + letterToken(counter) + SEP;
    counter += 1;
    vault.set(token, s);
    return token;
  };

  t = t.replace(URL_RE_PROTO, (m) => protect(urlToSpeech(m)));
  t = t.replace(URL_RE_WWW, (m) => protect(urlToSpeech(m)));
  t = t.replace(EMAIL_RE, (m) => protect(emailToSpeech(m)));
  t = t.replace(PHONE_RE, (m) => protect(phoneToSpeech(m)));
  t = t.replace(MONEY_RE, (m) => protect(moneyToSpeech(m)));
  t = t.replace(PERCENT_RE, (_m, num) => protect(percentToSpeech(num)));

  t = t.replace(TIME_RE_A, (_m, h, min, ap) => protect(spokenClockTime(to24Hour(h, ap), Number(min))));
  t = t.replace(TIME_RE_B, (_m, h, ap) => protect(spokenClockTime(to24Hour(h, ap), 0)));
  t = t.replace(TIME_RE_C, (_m, h, min) => protect(spokenClockTime(Number(h), Number(min))));

  t = t.replace(DATE_RE, (_m, mo, da, yr) => protect(dateToSpeech(mo, da, yr)));

  t = t.replace(UNIT_RE, (_m, num, unit) => {
    return protect(`${numberToWords(Number(num))} ${UNIT_WORDS[unit.toLowerCase()]}`);
  });

  t = t.replace(COMMA_NUM_RE, (m) => protect(numberToWords(Number(m.replace(/,/g, '')))));
  t = t.replace(DIGIT_RUN_RE, (m) => protect(digitRunToSpeech(m, mode)));
  t = t.replace(ORDINAL_RE, (_m, num) => protect(ordinalWords(Number(num))));
  t = t.replace(PLAIN_NUM_RE, (m) => protect(numberToWords(Number(m))));

  const tokenPattern = new RegExp(SEP + '[a-z]+' + SEP, 'g');
  t = t.replace(tokenPattern, (token) => (vault.has(token) ? vault.get(token) : token));

  t = normalizeSmartQuotes(t);
  t = t.replace(/\s+/g, ' ').trim();
  // Cleanup for punctuation collisions a substitution can leave behind: a
  // removed emoji can strand a space right before punctuation ("team !"),
  // and a replacement that itself ends in a period (like "Q&A" -> "Q. and
  // A.") can double up against punctuation already in the source text.
  t = t.replace(/\s+([,.!?;:])/g, '$1');
  t = t.replace(/([.!?])\1+/g, '$1');
  if (t && !/[.!?]$/.test(t)) t += '.';

  return t;
}

// --- email addresses for send confirmations ---------------------------------

export function spokenEmailAddress(addr) {
  const [local, domain] = String(addr).split('@');
  return `${local.split('.').join(' dot ')} at ${domain.split('.').join(' dot ')}`;
}

export function spelledSlowly(addr) {
  const [local, domain] = String(addr).split('@');
  const tokens = [];
  local.split('.').forEach((part, i) => {
    if (i > 0) tokens.push('dot');
    for (const ch of part) tokens.push(ch);
  });
  const spokenDomain = domain.split('.').join(' dot ');
  return `${tokens.join(', ')}, at ${spokenDomain}`;
}

// --- chunking for Kokoro -----------------------------------------------------

function splitIntoSentences(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitLongSentence(sentence, maxWords) {
  const clauses = sentence.split(/,\s*/).map((c) => c.trim()).filter(Boolean);
  const chunks = [];
  let current = [];
  let count = 0;

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join(', '));
      current = [];
      count = 0;
    }
  };

  for (const clause of clauses) {
    const words = clause.split(/\s+/).filter(Boolean);
    if (words.length > maxWords) {
      flush();
      for (let i = 0; i < words.length; i += maxWords) {
        chunks.push(words.slice(i, i + maxWords).join(' '));
      }
      continue;
    }
    if (count + words.length > maxWords) flush();
    current.push(clause);
    count += words.length;
  }
  flush();

  return chunks;
}

export function chunkForKokoro(text, { maxWords = 85 } = {}) {
  const sentences = splitIntoSentences(String(text ?? ''));
  const chunks = [];
  let current = [];
  let currentWordCount = 0;

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join(' ').trim());
      current = [];
      currentWordCount = 0;
    }
  };

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    if (wordCount > maxWords) {
      flush();
      for (const piece of splitLongSentence(sentence, maxWords)) chunks.push(piece);
      continue;
    }

    if (currentWordCount + wordCount > maxWords) flush();
    current.push(sentence);
    currentWordCount += wordCount;
  }
  flush();

  return chunks.filter((c) => c.length > 0);
}

// --- first clause for fast-start TTS ------------------------------------------

export function firstClause(text, { minWords = 6 } = {}) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  const pieces = trimmed.match(/[^,.!?]+[,.!?]*/g) || [];
  let acc = '';
  let wordCount = 0;

  for (const piece of pieces) {
    const p = piece.trim();
    if (!p) continue;
    acc = acc ? `${acc} ${p}` : p;
    wordCount += p.replace(/[,.!?]+$/, '').split(/\s+/).filter(Boolean).length;
    if (wordCount >= minWords) {
      return acc.trim();
    }
  }
  return null;
}
