// Local reminders: the `reminders` table (see schema.sql), used by the
// set_reminder / list_reminders intents and by GET /api/reminders,
// POST /api/reminders/done. No Google account involved.
//
// Usage:
//   import { addReminder, listOpen, markDone } from './reminders.js';
//   const reminder = addReminder(db, profileId, { text: 'Take the chicken out', dueUtc });
//   const open = listOpen(db, profileId);
//   markDone(db, reminder.id);

function rowToReminder(row) {
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    text: row.text,
    dueUtc: row.due_utc,
    done: !!row.done,
    createdUtc: row.created_utc,
  };
}

// Inserts a new open reminder. `dueUtc` may be null (an undated to-do).
export function addReminder(db, profileId, { text, dueUtc = null } = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('A reminder needs some text.');
  const createdUtc = new Date().toISOString();
  const result = db.run(
    'INSERT INTO reminders (profile_id, text, due_utc, done, created_utc) VALUES (?, ?, ?, 0, ?)',
    [profileId, clean, dueUtc, createdUtc],
  );
  return rowToReminder(db.get('SELECT * FROM reminders WHERE id = ?', [Number(result.lastInsertRowid)]));
}

// Open (not yet done) reminders for a profile, soonest due first; undated
// reminders (due_utc null) sort after every dated one.
export function listOpen(db, profileId) {
  const rows = db.all(
    `SELECT * FROM reminders WHERE profile_id = ? AND done = 0
     ORDER BY (due_utc IS NULL), due_utc, created_utc`,
    [profileId],
  );
  return rows.map(rowToReminder);
}

export function getReminder(db, id) {
  return rowToReminder(db.get('SELECT * FROM reminders WHERE id = ?', [id]));
}

// Marks a reminder done. Returns the updated reminder, or null if no
// reminder with that id exists.
export function markDone(db, id) {
  db.run('UPDATE reminders SET done = 1 WHERE id = ?', [id]);
  return getReminder(db, id);
}
