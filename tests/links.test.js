import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calendarTemplateUrl, describeTemplate } from '../app/lib/google/links.js';

function paramsOf(url) {
  const q = url.split('?')[1];
  const out = {};
  for (const pair of q.split('&')) {
    const [k, v] = pair.split('=');
    out[k] = decodeURIComponent(v || '');
  }
  return out;
}

test('calendarTemplateUrl: timed event, dates and ctz', () => {
  const url = calendarTemplateUrl({
    title: 'Dentist',
    startUtc: '2026-09-08T19:00:00.000Z',
    endUtc: '2026-09-08T19:45:00.000Z',
    zone: 'America/New_York',
    location: 'Maple Street Dental',
    details: 'annual checkup',
  });
  assert.match(url, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&/);
  const p = paramsOf(url);
  assert.equal(p.text, 'Dentist');
  assert.equal(p.dates, '20260908T190000Z/20260908T194500Z');
  assert.equal(p.ctz, 'America/New_York');
  assert.equal(p.location, 'Maple Street Dental');
  assert.equal(p.details, 'annual checkup');
});

test('calendarTemplateUrl: all-day one-day event bumps end to start+1', () => {
  const url = calendarTemplateUrl({
    title: 'Grandma visiting',
    startUtc: '2026-09-12T00:00:00.000Z',
    endUtc: '2026-09-12T00:00:00.000Z',
    allDay: true,
  });
  const p = paramsOf(url);
  assert.equal(p.dates, '20260912/20260913');
});

test('calendarTemplateUrl: all-day one-day event with no endUtc given', () => {
  const url = calendarTemplateUrl({
    title: 'Grandma visiting',
    startUtc: '2026-09-12T00:00:00.000Z',
    allDay: true,
  });
  const p = paramsOf(url);
  assert.equal(p.dates, '20260912/20260913');
});

test('calendarTemplateUrl: multi-day all-day event keeps the exclusive end', () => {
  const url = calendarTemplateUrl({
    title: 'Beach trip',
    startUtc: '2026-09-25T00:00:00.000Z',
    endUtc: '2026-09-28T00:00:00.000Z',
    allDay: true,
  });
  const p = paramsOf(url);
  assert.equal(p.dates, '20260925/20260928');
});

test('calendarTemplateUrl: guests are comma-joined then encoded', () => {
  const url = calendarTemplateUrl({
    title: 'Team sync',
    startUtc: '2026-09-08T19:00:00.000Z',
    endUtc: '2026-09-08T19:30:00.000Z',
    guests: ['a@example.com', 'b@example.com', 'c@example.com'],
  });
  assert.match(url, /add=a%40example\.com%2Cb%40example\.com%2Cc%40example\.com/);
  const p = paramsOf(url);
  assert.equal(p.add, 'a@example.com,b@example.com,c@example.com');
});

test('calendarTemplateUrl: omits guests param when none given', () => {
  const url = calendarTemplateUrl({
    title: 'Solo thing',
    startUtc: '2026-09-08T19:00:00.000Z',
    endUtc: '2026-09-08T19:30:00.000Z',
  });
  assert.ok(!url.includes('add='));
});

test('calendarTemplateUrl: rrule is prefixed and encoded', () => {
  const url = calendarTemplateUrl({
    title: 'Soccer practice',
    startUtc: '2026-09-01T21:30:00.000Z',
    endUtc: '2026-09-01T22:30:00.000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=12',
  });
  const p = paramsOf(url);
  assert.equal(p.recur, 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=12');
});

test('calendarTemplateUrl: rrule already prefixed with RRULE: is not doubled', () => {
  const url = calendarTemplateUrl({
    title: 'Soccer practice',
    startUtc: '2026-09-01T21:30:00.000Z',
    endUtc: '2026-09-01T22:30:00.000Z',
    rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=12',
  });
  const p = paramsOf(url);
  assert.equal(p.recur, 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=12');
});

test('calendarTemplateUrl: special characters in the title are safely encoded', () => {
  const url = calendarTemplateUrl({
    title: `Mom & Dad's "big" trip`,
    startUtc: '2026-09-08T19:00:00.000Z',
    endUtc: '2026-09-08T19:30:00.000Z',
  });
  assert.ok(!url.includes(' '), 'no raw spaces');
  // Only one '&' in the whole URL should separate real query params: count
  // the params we expect (action, text, dates) and make sure that is all.
  const ampersands = url.split('&').length - 1;
  assert.equal(ampersands, 2, 'the title’s own & must be encoded, not counted as a param separator');
  const p = paramsOf(url);
  assert.equal(p.text, `Mom & Dad's "big" trip`);
});

test('calendarTemplateUrl: spaces and quotes in location and details are encoded', () => {
  const url = calendarTemplateUrl({
    title: 'Checkup',
    startUtc: '2026-09-08T19:00:00.000Z',
    endUtc: '2026-09-08T19:30:00.000Z',
    location: `Dr. "Smith"'s office`,
    details: 'bring the "blue" folder',
  });
  assert.ok(!url.includes(' '), 'no raw spaces anywhere in the url');
  const p = paramsOf(url);
  assert.equal(p.location, `Dr. "Smith"'s office`);
  assert.equal(p.details, 'bring the "blue" folder');
});

test('describeTemplate: timed event sentence', () => {
  const text = describeTemplate({
    title: 'Dentist',
    startUtc: '2026-09-08T19:00:00.000Z',
    zone: 'America/New_York',
    location: 'Maple Street Dental',
  });
  assert.match(text, /^Add 'Dentist' on .+ at .+ in Google Calendar, then press Save\.$/);
  assert.ok(text.includes('Maple Street Dental'));
  assert.ok(!text.includes('\u2014'), 'no em dash');
});

test('describeTemplate: all-day event sentence has no time', () => {
  const text = describeTemplate({
    title: 'Grandma visiting',
    startUtc: '2026-09-12T00:00:00.000Z',
    allDay: true,
  });
  assert.match(text, /^Add 'Grandma visiting' on .+ in Google Calendar, then press Save\.$/);
  assert.ok(!/\bat\b/.test(text), 'all-day events should not claim a time');
});
