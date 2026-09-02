// Unit tests for app/lib/google/mime.js. Pure functions only, no network,
// no fake IMAP client needed here (see gmail.test.js for that).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  htmlToText,
  snippetOf,
  pickBodyText,
  buildMessageId,
  buildReplyMime,
  validateAppPassword,
  accountKind,
} from '../app/lib/google/mime.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures', 'mail');

function headerLines(buffer) {
  const text = buffer.toString('utf8');
  const headerBlock = text.split(/\r?\n\r?\n/)[0];
  return headerBlock.split(/\r?\n/);
}

function headerValue(buffer, name) {
  const line = headerLines(buffer).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(line.indexOf(':') + 1).trim() : undefined;
}

// ---------------------------------------------------------------------------
// htmlToText
// ---------------------------------------------------------------------------

test('htmlToText strips scripts and styles entirely', () => {
  const html = readFileSync(join(fixturesDir, 'nested.html'), 'utf8');
  const text = htmlToText(html);
  assert.ok(!text.includes('this should never appear'));
  assert.ok(!text.includes('font-family'));
  assert.ok(!text.includes('<'));
  assert.ok(!text.includes('>'));
});

test('htmlToText decodes named and numeric entities', () => {
  const html = readFileSync(join(fixturesDir, 'nested.html'), 'utf8');
  const text = htmlToText(html);
  assert.ok(text.includes('Grandma’s Birthday'), 'rsquo decoded');
  assert.ok(text.includes('reminder \u2014 the party'), 'mdash decoded');
  assert.ok(text.includes('Something to share & enjoy'), 'amp decoded');
  assert.ok(text.includes('“she always says”'), 'ldquo/rdquo decoded');
});

test('htmlToText turns block elements and <br> into newlines, and <li> into a bullet line', () => {
  const html = readFileSync(join(fixturesDir, 'nested.html'), 'utf8');
  const text = htmlToText(html);
  const lines = text.split('\n').map((l) => l.trim());
  assert.ok(lines.includes('Hi Alex,'));
  assert.ok(lines.includes('Bring a jacket, it might be cold.'), 'br produced a real line break');
  assert.ok(lines.includes('- A card'));
  assert.ok(lines.includes('- Your favorite board game'));
});

test('htmlToText collapses runs of blank lines and trims', () => {
  const text = htmlToText('<p>one</p>\n\n\n\n<p>two</p>   ');
  assert.equal(text, 'one\n\ntwo');
});

test('htmlToText on empty or missing input returns empty string', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(undefined), '');
});

test('htmlToText decodes numeric and hex character references', () => {
  assert.equal(htmlToText('caf&#233; &#x2603;'), 'café ☃');
});

// ---------------------------------------------------------------------------
// snippetOf
// ---------------------------------------------------------------------------

test('snippetOf collapses whitespace and passes short text through unchanged', () => {
  assert.equal(snippetOf('  hello   there  \n friend  '), 'hello there friend');
});

test('snippetOf truncates to n characters and marks truncation', () => {
  const long = 'word '.repeat(100).trim();
  const snippet = snippetOf(long, 20);
  assert.ok(snippet.length <= 24);
  assert.ok(snippet.endsWith('...'));
});

test('snippetOf defaults to 200 characters', () => {
  const long = 'x'.repeat(500);
  assert.equal(snippetOf(long).length, 203);
});

// ---------------------------------------------------------------------------
// pickBodyText
// ---------------------------------------------------------------------------

test('pickBodyText prefers text/plain over text/html when both are present', () => {
  const result = pickBodyText([
    { type: 'text/html', content: '<p>from html</p>' },
    { type: 'text/plain', content: 'from plain' },
  ]);
  assert.equal(result.text, 'from plain');
  assert.equal(result.format, 'text/plain');
});

test('pickBodyText falls back to converted html when there is no plain part', () => {
  const result = pickBodyText([{ type: 'text/html', content: '<p>Hi <b>there</b></p>' }]);
  assert.equal(result.text, 'Hi there');
  assert.equal(result.format, 'text/html');
});

test('pickBodyText returns empty for no usable parts', () => {
  assert.deepEqual(pickBodyText([]), { text: '', format: 'empty' });
  assert.deepEqual(pickBodyText(undefined), { text: '', format: 'empty' });
});

// ---------------------------------------------------------------------------
// buildMessageId
// ---------------------------------------------------------------------------

test('buildMessageId returns an angle-bracketed id at the given domain', () => {
  const id = buildMessageId('stickos.local');
  assert.match(id, /^<[0-9a-f-]{36}@stickos\.local>$/);
});

test('buildMessageId defaults to stickos.local and produces unique ids', () => {
  const a = buildMessageId();
  const b = buildMessageId();
  assert.notEqual(a, b);
  assert.match(a, /@stickos\.local>$/);
});

// ---------------------------------------------------------------------------
// buildReplyMime
// ---------------------------------------------------------------------------

test('buildReplyMime sets To, Subject, Message-ID, In-Reply-To and References', async () => {
  const buf = await buildReplyMime({
    from: 'scout@example.com',
    to: 'grandma@example.com',
    subject: 'Birthday plans',
    body: 'Sounds great, see you then.',
    inReplyTo: '<parent-id@gmail.com>',
    references: '<older-id@gmail.com> <parent-id@gmail.com>',
    messageId: '<new-id@stickos.local>',
    date: '2026-09-01T12:00:00Z',
  });

  assert.equal(headerValue(buf, 'To'), 'grandma@example.com');
  assert.equal(headerValue(buf, 'Subject'), 'Re: Birthday plans');
  assert.equal(headerValue(buf, 'Message-ID'), '<new-id@stickos.local>');
  assert.equal(headerValue(buf, 'In-Reply-To'), '<parent-id@gmail.com>');
  assert.equal(headerValue(buf, 'References'), '<older-id@gmail.com> <parent-id@gmail.com>');
  assert.ok(buf.toString('utf8').includes('Sounds great, see you then.'));
});

test('buildReplyMime adds "Re: " when the subject does not already have it', async () => {
  const buf = await buildReplyMime({ from: 'a@b.com', to: 'c@d.com', subject: 'Plain subject', body: 'hi', messageId: '<x@y>' });
  assert.equal(headerValue(buf, 'Subject'), 'Re: Plain subject');
});

test('buildReplyMime does not double up "Re: " when the subject already has it', async () => {
  const buf = await buildReplyMime({ from: 'a@b.com', to: 'c@d.com', subject: 're: already there', body: 'hi', messageId: '<x@y>' });
  assert.equal(headerValue(buf, 'Subject'), 're: already there');
});

test('buildReplyMime omits In-Reply-To and References when there is no parent', async () => {
  const buf = await buildReplyMime({ from: 'a@b.com', to: 'c@d.com', subject: 'New thread', body: 'hi', messageId: '<x@y>' });
  assert.equal(headerValue(buf, 'In-Reply-To'), undefined);
  assert.equal(headerValue(buf, 'References'), undefined);
});

test('buildReplyMime generates a Message-ID when none is given', async () => {
  const buf = await buildReplyMime({ from: 'a@b.com', to: 'c@d.com', subject: 'No id supplied', body: 'hi' });
  const value = headerValue(buf, 'Message-ID');
  assert.ok(value && value.startsWith('<') && value.endsWith('>'));
});

// ---------------------------------------------------------------------------
// validateAppPassword
// ---------------------------------------------------------------------------

test('validateAppPassword accepts 16 letters/digits with spaces stripped', () => {
  assert.deepEqual(validateAppPassword('abcd efgh ijkl mnop'), { ok: true, cleaned: 'abcdefghijklmnop', reason: null });
});

test('validateAppPassword rejects the wrong length with a beginner reason', () => {
  const result = validateAppPassword('abcd efgh ijkl mno');
  assert.equal(result.ok, false);
  assert.equal(result.cleaned, 'abcdefghijklmno');
  assert.equal(result.reason, "that's 15 characters, App Passwords are 16");
});

test('validateAppPassword rejects non-alphanumeric characters even at the right length', () => {
  const result = validateAppPassword('abcd efgh ijkl mn-p');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'App Passwords are only letters and numbers');
});

test('validateAppPassword handles empty input', () => {
  const result = validateAppPassword('');
  assert.equal(result.ok, false);
  assert.equal(result.reason, "that's 0 characters, App Passwords are 16");
});

test('validateAppPassword handles null/undefined input without throwing', () => {
  assert.equal(validateAppPassword(null).ok, false);
  assert.equal(validateAppPassword(undefined).ok, false);
});

// ---------------------------------------------------------------------------
// accountKind
// ---------------------------------------------------------------------------

test('accountKind reports personal for gmail.com and googlemail.com', () => {
  assert.equal(accountKind('someone@gmail.com'), 'personal');
  assert.equal(accountKind('someone@googlemail.com'), 'personal');
  assert.equal(accountKind('Someone@GMAIL.com'), 'personal');
});

test('accountKind reports workspace for every other domain', () => {
  assert.equal(accountKind('someone@example.com'), 'workspace');
  assert.equal(accountKind('someone@school.edu'), 'workspace');
});

test('accountKind does not throw on malformed input', () => {
  assert.equal(accountKind(''), 'workspace');
  assert.equal(accountKind(undefined), 'workspace');
  assert.equal(accountKind('not-an-email'), 'workspace');
});
