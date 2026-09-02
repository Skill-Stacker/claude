import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import {
  resolve,
  windowFor,
  spokenTime,
  spokenDate,
  spokenDateTime,
  spokenRange,
  spokenDuration,
  spokenRelative,
  numberToWords,
  nowIn,
  toUtcIso,
  fromUtc,
} from '../app/lib/dates.js';

// Fixed reference point used across this whole file: 2026-09-02T14:00:00 in
// America/New_York, a Wednesday.
const ZONE = 'America/New_York';
const NOW = '2026-09-02T14:00:00';
const NOW_DT = DateTime.fromISO(NOW, { zone: ZONE });

function dt(iso) {
  return DateTime.fromISO(iso, { zone: ZONE });
}

describe('resolve()', () => {
  const cases = [
    {
      text: 'tomorrow at 3',
      start: '2026-09-03T03:00:00-04:00',
      allDay: false,
      certain: { hour: true, minute: true, day: true },
    },
    {
      text: 'tomorrow at 3pm',
      start: '2026-09-03T15:00:00-04:00',
      allDay: false,
      certain: { hour: true, minute: true, day: true },
    },
    {
      text: 'next Tuesday at 3pm',
      start: '2026-09-08T15:00:00-04:00',
      allDay: false,
      certain: { hour: true, minute: true, day: true },
    },
    {
      // No timezone offset given in the phrase itself, but the reference
      // "now" is a Wednesday, so the coming Tuesday is September 8.
      text: 'Tuesday at 3',
      start: '2026-09-08T03:00:00-04:00',
      allDay: false,
      certain: { hour: true, minute: true, day: true },
    },
    {
      text: 'in two weeks',
      start: '2026-09-16T14:00:00-04:00',
      allDay: true,
      certain: { hour: false, minute: false, day: true },
    },
    {
      text: 'Friday morning',
      start: '2026-09-04T09:00:00-04:00',
      allDay: false,
      certain: { hour: false, minute: false, day: true },
      hint: 'morning',
    },
    {
      text: 'Saturday afternoon',
      start: '2026-09-05T13:00:00-04:00',
      allDay: false,
      certain: { hour: false, minute: false, day: true },
      hint: 'afternoon',
    },
    {
      text: 'tonight',
      start: '2026-09-02T19:00:00-04:00',
      allDay: false,
      certain: { hour: false, minute: false, day: true },
      hint: 'tonight',
    },
    {
      text: 'noon tomorrow',
      start: '2026-09-03T12:00:00-04:00',
      allDay: false,
      certain: { hour: true, minute: true, day: true },
    },
    {
      text: 'this weekend',
      start: '2026-09-05T12:00:00-04:00',
      allDay: true,
      certain: { hour: false, minute: false, day: true },
    },
    {
      text: 'October 3rd',
      start: '2026-10-03T12:00:00-04:00',
      allDay: true,
      certain: { hour: false, minute: false, day: true },
    },
    {
      text: 'October 3rd at 10am',
      start: '2026-10-03T10:00:00-04:00',
      allDay: false,
      certain: { hour: true, minute: true, day: true },
    },
    {
      text: 'in 45 minutes',
      start: '2026-09-02T14:45:00-04:00',
      allDay: false,
      certain: { hour: true, minute: true, day: true },
    },
    {
      text: 'at 7',
      start: '2026-09-03T07:00:00-04:00',
      allDay: false,
      certain: { hour: true, minute: true, day: false },
    },
    {
      text: 'next month',
      start: '2026-10-02T14:00:00-04:00',
      allDay: true,
      certain: { hour: false, minute: false, day: false },
    },
  ];

  for (const c of cases) {
    test(`"${c.text}"`, () => {
      const result = resolve(c.text, { now: NOW, zone: ZONE });
      assert.ok(result, `expected a result for "${c.text}"`);
      assert.equal(result.start, c.start);
      assert.equal(result.allDay, c.allDay);
      assert.deepEqual(result.certain, c.certain);
      if (c.hint) {
        assert.equal(result.hint, c.hint);
      } else {
        assert.equal(result.hint, undefined);
      }
    });
  }

  test('bare "tomorrow" is allDay', () => {
    const result = resolve('tomorrow', { now: NOW, zone: ZONE });
    assert.equal(result.allDay, true);
    assert.equal(result.certain.hour, false);
  });

  test('returns null when nothing parses', () => {
    assert.equal(resolve('purple elephants dance', { now: NOW, zone: ZONE }), null);
    assert.equal(resolve('', { now: NOW, zone: ZONE }), null);
  });

  test('reports the matched substring', () => {
    const result = resolve('remind me tomorrow at 3pm please', { now: NOW, zone: ZONE });
    assert.equal(result.matched, 'tomorrow at 3pm');
  });

  test('"Friday night" and "Friday evening" get different default hours', () => {
    const night = resolve('Friday night', { now: NOW, zone: ZONE });
    const evening = resolve('Friday evening', { now: NOW, zone: ZONE });
    assert.equal(night.hint, 'night');
    assert.equal(night.start, '2026-09-04T20:00:00-04:00');
    assert.equal(evening.hint, 'evening');
    assert.equal(evening.start, '2026-09-04T18:00:00-04:00');
  });
});

describe('windowFor()', () => {
  test('today', () => {
    const w = windowFor('today', { now: NOW, zone: ZONE });
    assert.equal(w.startUtc, dt('2026-09-02T00:00:00').toUTC().toISO({ suppressMilliseconds: true }));
    assert.equal(w.endUtc, dt('2026-09-02T23:59:59').toUTC().toISO({ suppressMilliseconds: true }));
    assert.equal(w.label, 'today');
  });

  test('tomorrow', () => {
    const w = windowFor('tomorrow', { now: NOW, zone: ZONE });
    assert.equal(w.label, 'tomorrow');
    assert.equal(w.startUtc, dt('2026-09-03T00:00:00').toUTC().toISO({ suppressMilliseconds: true }));
  });

  test('yesterday', () => {
    const w = windowFor('yesterday', { now: NOW, zone: ZONE });
    assert.equal(w.label, 'yesterday');
    assert.equal(w.startUtc, dt('2026-09-01T00:00:00').toUTC().toISO({ suppressMilliseconds: true }));
  });

  test('this week runs Monday to Sunday', () => {
    const w = windowFor('this week', { now: NOW, zone: ZONE });
    assert.equal(w.label, 'this week');
    assert.equal(w.startUtc, dt('2026-08-31T00:00:00').toUTC().toISO({ suppressMilliseconds: true }));
    assert.equal(w.endUtc, dt('2026-09-06T23:59:59').toUTC().toISO({ suppressMilliseconds: true }));
  });

  test('next week', () => {
    const w = windowFor('next week', { now: NOW, zone: ZONE });
    assert.equal(w.label, 'next week');
    assert.equal(w.startUtc, dt('2026-09-07T00:00:00').toUTC().toISO({ suppressMilliseconds: true }));
    assert.equal(w.endUtc, dt('2026-09-13T23:59:59').toUTC().toISO({ suppressMilliseconds: true }));
  });

  test('this weekend runs Saturday to Sunday', () => {
    const w = windowFor('this weekend', { now: NOW, zone: ZONE });
    assert.equal(w.label, 'this weekend');
    assert.equal(w.startUtc, dt('2026-09-05T00:00:00').toUTC().toISO({ suppressMilliseconds: true }));
    assert.equal(w.endUtc, dt('2026-09-06T23:59:59').toUTC().toISO({ suppressMilliseconds: true }));
  });

  test('a weekday name resolves to the next one, whole day', () => {
    const w = windowFor('Friday', { now: NOW, zone: ZONE });
    assert.equal(w.label, 'Friday');
    assert.equal(w.startUtc, dt('2026-09-04T00:00:00').toUTC().toISO({ suppressMilliseconds: true }));
    assert.equal(w.endUtc, dt('2026-09-04T23:59:59').toUTC().toISO({ suppressMilliseconds: true }));
  });

  test('a month name resolves to that whole month', () => {
    const w = windowFor('October', { now: NOW, zone: ZONE });
    assert.equal(w.label, 'October');
    assert.equal(w.startUtc, dt('2026-10-01T00:00:00').toUTC().toISO({ suppressMilliseconds: true }));
    assert.equal(w.endUtc, dt('2026-10-31T23:59:59').toUTC().toISO({ suppressMilliseconds: true }));
  });

  test('a month already passed this year rolls to next year', () => {
    const w = windowFor('January', { now: NOW, zone: ZONE });
    assert.equal(w.startUtc, dt('2027-01-01T00:00:00').toUTC().toISO({ suppressMilliseconds: true }));
  });

  test('returns null for unrecognized text', () => {
    assert.equal(windowFor('purple elephants', { now: NOW, zone: ZONE }), null);
    assert.equal(windowFor('', { now: NOW, zone: ZONE }), null);
  });
});

describe('spokenTime()', () => {
  const cases = [
    ['2026-09-02T12:00:00', 'noon'],
    ['2026-09-02T00:00:00', 'midnight'],
    ['2026-09-02T12:30:00', 'half past twelve in the afternoon'],
    ['2026-09-02T11:45:00', 'quarter to noon'],
    ['2026-09-02T23:59:00', 'eleven fifty nine at night'],
    ['2026-09-02T23:45:00', 'quarter to midnight'],
    ['2026-09-02T15:45:00', 'quarter to four in the afternoon'],
    ['2026-09-02T15:00:00', "three o'clock in the afternoon"],
    ['2026-09-02T09:15:00', 'quarter past nine in the morning'],
    ['2026-09-02T19:40:00', 'seven forty in the evening'],
    ['2026-09-02T00:30:00', 'half past twelve in the morning'],
    ['2026-09-02T03:05:00', 'three oh five in the morning'],
    ['2026-09-02T17:00:00', "five o'clock in the evening"],
    ['2026-09-02T21:00:00', "nine o'clock at night"],
    ['2026-09-02T16:59:00', 'four fifty nine in the afternoon'],
  ];

  for (const [iso, expected] of cases) {
    test(`${iso} -> "${expected}"`, () => {
      assert.equal(spokenTime(dt(iso)), expected);
    });
  }

  test('accepts a plain ISO string with an explicit zone option', () => {
    assert.equal(spokenTime('2026-09-02T15:00:00', { zone: ZONE }), "three o'clock in the afternoon");
  });
});

describe('spokenDate()', () => {
  test('today, tomorrow, yesterday', () => {
    assert.equal(spokenDate(dt('2026-09-02T09:00:00'), { now: NOW_DT }), 'today');
    assert.equal(spokenDate(dt('2026-09-03T09:00:00'), { now: NOW_DT }), 'tomorrow');
    assert.equal(spokenDate(dt('2026-09-01T09:00:00'), { now: NOW_DT }), 'yesterday');
  });

  test('weekday name alone within the next six days', () => {
    assert.equal(spokenDate(dt('2026-09-04T09:00:00'), { now: NOW_DT }), 'Friday');
    assert.equal(spokenDate(dt('2026-09-08T09:00:00'), { now: NOW_DT }), 'Tuesday');
  });

  test('"weekday the nth" within the same month beyond six days', () => {
    assert.equal(spokenDate(dt('2026-09-09T09:00:00'), { now: NOW_DT }), 'Wednesday the ninth');
    assert.equal(spokenDate(dt('2026-09-20T09:00:00'), { now: NOW_DT }), 'Sunday the twentieth');
  });

  test('full "weekday, month nth" for a different month', () => {
    assert.equal(spokenDate(dt('2026-08-30T09:00:00'), { now: NOW_DT }), 'Sunday, August thirtieth');
    assert.equal(spokenDate(dt('2026-10-01T09:00:00'), { now: NOW_DT }), 'Thursday, October first');
  });

  test('adds the year only when it differs from now', () => {
    assert.equal(
      spokenDate(dt('2027-01-05T09:00:00'), { now: NOW_DT }),
      'Tuesday, January fifth, two thousand twenty seven',
    );
    assert.equal(
      spokenDate(dt('2026-12-25T09:00:00'), { now: NOW_DT }),
      'Friday, December twenty fifth',
    );
  });

  test('ordinal words go up through the thirty first', () => {
    assert.equal(
      spokenDate(dt('2026-10-31T09:00:00'), { now: NOW_DT }),
      'Saturday, October thirty first',
    );
    assert.equal(
      spokenDate(dt('2026-09-21T09:00:00'), { now: NOW_DT }),
      'Monday the twenty first',
    );
  });
});

describe('spokenDateTime()', () => {
  test('combines date and time', () => {
    assert.equal(
      spokenDateTime(dt('2026-09-03T15:00:00'), { now: NOW_DT }),
      "tomorrow at three o'clock in the afternoon",
    );
    assert.equal(
      spokenDateTime(dt('2026-09-09T12:00:00'), { now: NOW_DT }),
      'Wednesday the ninth at noon',
    );
  });
});

describe('spokenRange()', () => {
  test('same-day timed range drops the repeated "o\'clock" and period', () => {
    assert.equal(
      spokenRange(dt('2026-09-05T15:00:00'), dt('2026-09-05T16:00:00'), { now: NOW_DT }),
      'from three to four in the afternoon',
    );
  });

  test('a range with non-hour minutes keeps the past/to wording', () => {
    assert.equal(
      spokenRange(dt('2026-09-05T15:15:00'), dt('2026-09-05T16:45:00'), { now: NOW_DT }),
      'from quarter past three to quarter to five in the evening',
    );
  });

  test('all-day range', () => {
    assert.equal(
      spokenRange(dt('2026-09-05T00:00:00'), dt('2026-09-05T23:59:59'), { now: NOW_DT }),
      'all day Saturday',
    );
  });
});

describe('spokenDuration()', () => {
  const cases = [
    [1, 'one minute'],
    [45, 'forty five minutes'],
    [60, 'an hour'],
    [90, 'an hour and a half'],
    [120, 'two hours'],
    [150, 'two hours and a half'],
    [61, 'an hour and one minute'],
    [0, 'zero minutes'],
  ];

  for (const [minutes, expected] of cases) {
    test(`${minutes} minutes -> "${expected}"`, () => {
      assert.equal(spokenDuration(minutes), expected);
    });
  }
});

describe('spokenRelative()', () => {
  test('in the future, under an hour', () => {
    assert.equal(
      spokenRelative(dt('2026-09-02T14:20:00'), { now: NOW_DT }),
      'in twenty minutes',
    );
  });

  test('in the future, hours away', () => {
    assert.equal(
      spokenRelative(dt('2026-09-02T17:00:00'), { now: NOW_DT }),
      'in three hours',
    );
  });

  test('in the future, days away', () => {
    assert.equal(
      spokenRelative(dt('2026-09-04T14:00:00'), { now: NOW_DT }),
      'in two days',
    );
  });

  test('in the past', () => {
    assert.equal(
      spokenRelative(dt('2026-09-02T13:40:00'), { now: NOW_DT }),
      'twenty minutes ago',
    );
  });

  test('right now', () => {
    assert.equal(spokenRelative(NOW_DT, { now: NOW_DT }), 'right now');
  });
});

describe('daylight saving crossing (November 1 2026)', () => {
  // Clocks in America/New_York fall back at 2:00 AM on November 1, 2026.
  const before = dt('2026-11-01T00:30:00'); // -04:00 (EDT), before the fallback
  const after = dt('2026-11-01T02:30:00'); // -05:00 (EST), after the fallback

  test('spokenTime works on both sides of the fallback', () => {
    assert.equal(spokenTime(before), 'half past twelve in the morning');
    assert.equal(spokenTime(after), 'half past two in the morning');
  });

  test('the two offsets really differ', () => {
    assert.equal(before.offset, -240);
    assert.equal(after.offset, -300);
  });

  test('spokenRelative measures real elapsed time across the fallback, not wall-clock time', () => {
    // Wall clock says 2 hours (00:30 to 02:30) but the fallback adds an
    // extra real hour, so three hours actually pass.
    assert.equal(spokenRelative(after, { now: before }), 'in three hours');
  });

  test('spokenDate still reads naturally across the boundary', () => {
    assert.equal(spokenDate(after, { now: before }), 'today');
  });
});

describe('numberToWords()', () => {
  const cases = [
    [0, 'zero'],
    [4, 'four'],
    [15, 'fifteen'],
    [45, 'forty five'],
    [99, 'ninety nine'],
    [100, 'one hundred'],
    [105, 'one hundred five'],
    [999, 'nine hundred ninety nine'],
    [1000, 'one thousand'],
    [2000, 'two thousand'],
    [4990, 'four thousand nine hundred ninety'],
    [1250000, 'one million two hundred fifty thousand'],
    [1000000000, 'one billion'],
    [-5, 'negative five'],
  ];

  for (const [n, expected] of cases) {
    test(`${n} -> "${expected}"`, () => {
      assert.equal(numberToWords(n), expected);
    });
  }
});

describe('nowIn() / toUtcIso() / fromUtc()', () => {
  test('nowIn returns a DateTime in the requested zone', () => {
    const result = nowIn(ZONE);
    assert.equal(result.zoneName, ZONE);
    assert.ok(result.isValid);
  });

  test('toUtcIso converts a zoned moment to UTC', () => {
    assert.equal(toUtcIso(dt('2026-09-02T14:00:00')), '2026-09-02T18:00:00Z');
  });

  test('fromUtc converts a UTC ISO string into the requested zone', () => {
    const result = fromUtc('2026-09-02T18:00:00Z', ZONE);
    assert.equal(result.toISO({ suppressMilliseconds: true }), '2026-09-02T14:00:00-04:00');
  });

  test('round trip', () => {
    const original = dt('2026-11-01T02:30:00');
    const roundTripped = fromUtc(toUtcIso(original), ZONE);
    assert.equal(roundTripped.toMillis(), original.toMillis());
  });
});
