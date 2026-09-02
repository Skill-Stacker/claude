import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../app/lib/db.js';
import { addReminder, listOpen, getReminder, markDone } from '../app/lib/reminders.js';

const PROFILE = 1;

describe('reminders', () => {
  test('addReminder rejects empty text', () => {
    const db = openDb(':memory:');
    assert.throws(() => addReminder(db, PROFILE, { text: '   ' }));
  });

  test('addReminder stores a dated and an undated reminder', () => {
    const db = openDb(':memory:');
    const dated = addReminder(db, PROFILE, { text: 'Take the chicken out', dueUtc: '2026-09-02T22:00:00.000Z' });
    const undated = addReminder(db, PROFILE, { text: 'Sign the school form' });

    assert.equal(dated.text, 'Take the chicken out');
    assert.equal(dated.dueUtc, '2026-09-02T22:00:00.000Z');
    assert.equal(dated.done, false);
    assert.equal(undated.dueUtc, null);
    assert.ok(dated.id && undated.id && dated.id !== undated.id);
  });

  test('listOpen: dated reminders sort soonest first, undated ones after', () => {
    const db = openDb(':memory:');
    addReminder(db, PROFILE, { text: 'later', dueUtc: '2026-09-10T00:00:00.000Z' });
    addReminder(db, PROFILE, { text: 'undated' });
    addReminder(db, PROFILE, { text: 'sooner', dueUtc: '2026-09-03T00:00:00.000Z' });

    const open = listOpen(db, PROFILE);
    assert.deepEqual(open.map((r) => r.text), ['sooner', 'later', 'undated']);
  });

  test('listOpen only returns reminders for the given profile', () => {
    const db = openDb(':memory:');
    addReminder(db, PROFILE, { text: 'mine' });
    addReminder(db, 2, { text: 'not mine' });
    const open = listOpen(db, PROFILE);
    assert.equal(open.length, 1);
    assert.equal(open[0].text, 'mine');
  });

  test('markDone removes a reminder from listOpen and getReminder reflects it', () => {
    const db = openDb(':memory:');
    const r = addReminder(db, PROFILE, { text: 'Call the plumber' });
    assert.equal(listOpen(db, PROFILE).length, 1);

    const updated = markDone(db, r.id);
    assert.equal(updated.done, true);
    assert.equal(listOpen(db, PROFILE).length, 0);
    assert.equal(getReminder(db, r.id).done, true);
  });

  test('markDone on an unknown id returns null', () => {
    const db = openDb(':memory:');
    assert.equal(markDone(db, 9999), null);
  });
});
