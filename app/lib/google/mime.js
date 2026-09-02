// Pure MIME and text helpers for the Gmail connector. Nothing here touches
// the network; imapflow and nodemailer stay in gmail.js. Kept separate so
// the message formatting and validation logic can be unit tested without a
// fake IMAP or SMTP server.
//
// Usage:
//   import { htmlToText, buildReplyMime, validateAppPassword } from './mime.js';
//   const text = htmlToText('<p>Hi <b>there</b></p>');
//   const buf = await buildReplyMime({ from, to, subject, body, inReplyTo, references, messageId });

import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

// ---------------------------------------------------------------------------
// HTML to plain text
// ---------------------------------------------------------------------------

// Tags whose open or close should force a line break. Kept to the common
// block-level set; anything else is treated as inline and just falls away
// when tags are stripped.
const BLOCK_TAG_PATTERN =
  '(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|tr|table|thead|tbody|blockquote|pre|form|fieldset|address)';

// Unicode escapes throughout (never a literal em dash character in source,
// per the writing rule; this table also decodes one out of untrusted mail).
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
  ndash: '\u2013',
  mdash: '\u2014',
  middot: '\u00b7',
  bull: '\u2022',
};

function decodeEntities(str) {
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isNaN(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

// A decent, dependency-free HTML to plain text conversion. Good enough for
// reading an email out loud or showing a snippet, not a full renderer.
export function htmlToText(html) {
  if (!html) return '';
  let out = String(html);

  // Scripts, styles and the document head never carry visible text.
  out = out.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n');
  // Comments carry nothing either.
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // Explicit line breaks and list items.
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<li\b[^>]*>/gi, '\n- ');
  // Block-level tags (open or close) become a newline; everything inside
  // stays on the line until the next block boundary.
  const blockTagRe = new RegExp(`<\\/?${BLOCK_TAG_PATTERN}\\b[^>]*>`, 'gi');
  out = out.replace(blockTagRe, '\n');
  // Whatever tags are left (inline formatting, spans, images, etc.) carry no
  // text of their own once stripped.
  out = out.replace(/<[^>]+>/g, '');

  out = decodeEntities(out);

  // Collapse whitespace: trim each line, then collapse runs of blank lines.
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out;
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

export function snippetOf(text, n = 200) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= n) return collapsed;
  return `${collapsed.slice(0, n).trimEnd()}...`;
}

// ---------------------------------------------------------------------------
// Body part selection
// ---------------------------------------------------------------------------

// parsedParts is a list of { type, content } entries pulled out of a
// message's body structure (see gmail.js), one per leaf text part that was
// actually downloaded. Plain text always wins over HTML when both exist.
export function pickBodyText(parsedParts) {
  const list = Array.isArray(parsedParts) ? parsedParts : [];

  const plain = list.find((p) => p && typeof p.content === 'string' && String(p.type).toLowerCase() === 'text/plain');
  if (plain) return { text: plain.content, format: 'text/plain' };

  const html = list.find((p) => p && typeof p.content === 'string' && String(p.type).toLowerCase() === 'text/html');
  if (html) return { text: htmlToText(html.content), format: 'text/html' };

  return { text: '', format: 'empty' };
}

// ---------------------------------------------------------------------------
// Message-ID
// ---------------------------------------------------------------------------

export function buildMessageId(domain = 'stickos.local') {
  return `<${randomUUID()}@${domain}>`;
}

// ---------------------------------------------------------------------------
// Reply MIME
// ---------------------------------------------------------------------------

function subjectWithRe(subject) {
  const trimmed = String(subject ?? '').trim();
  if (/^re:/i.test(trimmed)) return trimmed;
  return trimmed ? `Re: ${trimmed}` : 'Re:';
}

// Builds an RFC 5322 message buffer for a reply, using nodemailer's
// MailComposer directly (no SMTP involved). References must already be the
// full chain the caller wants on the wire (gmail.js composes it from the
// cached thread); this function only appends nothing further to it.
export async function buildReplyMime({ from, to, subject, body, inReplyTo, references, messageId, date } = {}) {
  const mail = {
    from,
    to,
    subject: subjectWithRe(subject),
    text: body ?? '',
    date: date ? new Date(date) : new Date(),
  };
  if (messageId) mail.messageId = messageId;
  if (inReplyTo) mail.inReplyTo = inReplyTo;
  if (references) mail.references = references;

  const composer = new MailComposer(mail);
  const compiled = composer.compile();

  return new Promise((resolve, reject) => {
    compiled.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

// ---------------------------------------------------------------------------
// App password
// ---------------------------------------------------------------------------

export function validateAppPassword(input) {
  const cleaned = String(input ?? '').replace(/\s+/g, '');
  if (cleaned.length !== 16) {
    return { ok: false, cleaned, reason: `that's ${cleaned.length} characters, App Passwords are 16` };
  }
  if (!/^[A-Za-z0-9]{16}$/.test(cleaned)) {
    return { ok: false, cleaned, reason: 'App Passwords are only letters and numbers' };
  }
  return { ok: true, cleaned, reason: null };
}

// ---------------------------------------------------------------------------
// Account kind
// ---------------------------------------------------------------------------

export function accountKind(address) {
  const domain = String(address ?? '').split('@')[1]?.toLowerCase() ?? '';
  return domain === 'gmail.com' || domain === 'googlemail.com' ? 'personal' : 'workspace';
}
