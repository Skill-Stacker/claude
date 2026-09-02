import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../app/lib/db.js';
import {
  addContact,
  listContacts,
  removeContact,
  resolveRecipient,
  suggestAddFromReply,
} from '../app/lib/google/contacts.js';

const PROFILE = 1;

function freshDb() {
  return openDb(':memory:');
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function seedMessage(db, { fromName, fromAddr, daysAgo }) {
  db.run(
    `INSERT INTO messages (profile_id, gm_msgid, from_name, from_addr, subject, date_utc)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [PROFILE, `msg-${fromAddr}-${daysAgo}`, fromName, fromAddr, 'hello', daysAgoIso(daysAgo)],
  );
}

// ---------------------------------------------------------------------------
// addContact / listContacts / removeContact
// ---------------------------------------------------------------------------

test('addContact: adds and lowercases a valid address', () => {
  const db = freshDb();
  const contact = addContact(db, PROFILE, { name: 'Jane Smith', address: 'Jane@Example.COM' });
  assert.equal(contact.address, 'jane@example.com');
  assert.equal(contact.name, 'Jane Smith');

  const rows = listContacts(db, PROFILE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, 'jane@example.com');
  db.close();
});

test('addContact: rejects a bad address', () => {
  const db = freshDb();
  assert.throws(() => addContact(db, PROFILE, { name: 'Bad', address: 'not-an-email' }));
  assert.throws(() => addContact(db, PROFILE, { name: 'Bad', address: 'missing-at-sign.com' }));
  assert.throws(() => addContact(db, PROFILE, { name: 'Bad', address: '@example.com' }));
  assert.equal(listContacts(db, PROFILE).length, 0);
  db.close();
});

test('addContact: rejects a missing name', () => {
  const db = freshDb();
  assert.throws(() => addContact(db, PROFILE, { name: '', address: 'jane@example.com' }));
  db.close();
});

test('addContact: adding the same address again updates the name', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Jane', address: 'jane@example.com' });
  addContact(db, PROFILE, { name: 'Jane Smith', address: 'jane@example.com' });
  const rows = listContacts(db, PROFILE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Jane Smith');
  db.close();
});

test('removeContact: removes a known address and reports success', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Jane', address: 'jane@example.com' });
  assert.equal(removeContact(db, PROFILE, 'JANE@example.com'), true);
  assert.equal(listContacts(db, PROFILE).length, 0);
  assert.equal(removeContact(db, PROFILE, 'jane@example.com'), false);
  db.close();
});

// ---------------------------------------------------------------------------
// resolveRecipient
// ---------------------------------------------------------------------------

test('resolveRecipient: exact full-name match against a contact resolves to one', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Jane Smith', address: 'jane@example.com' });
  addContact(db, PROFILE, { name: 'Bob Jones', address: 'bob@example.com' });

  const result = resolveRecipient(db, PROFILE, 'Jane Smith');
  assert.equal(result.status, 'one');
  assert.equal(result.contact.address, 'jane@example.com');
  db.close();
});

test('resolveRecipient: first-name match resolves to one when unambiguous', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Jane Smith', address: 'jane@example.com' });
  addContact(db, PROFILE, { name: 'Bob Jones', address: 'bob@example.com' });

  const result = resolveRecipient(db, PROFILE, 'Jane');
  assert.equal(result.status, 'one');
  assert.equal(result.contact.address, 'jane@example.com');
  db.close();
});

test('resolveRecipient: same first name on two contacts resolves to many', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Jane Smith', address: 'jane.smith@example.com' });
  addContact(db, PROFILE, { name: 'Jane Doe', address: 'jane.doe@example.com' });

  const result = resolveRecipient(db, PROFILE, 'Jane');
  assert.equal(result.status, 'many');
  assert.equal(result.candidates.length, 2);
  const addresses = result.candidates.map((c) => c.address).sort();
  assert.deepEqual(addresses, ['jane.doe@example.com', 'jane.smith@example.com']);
  db.close();
});

test('resolveRecipient: no match at all returns none', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Jane Smith', address: 'jane@example.com' });

  const result = resolveRecipient(db, PROFILE, 'Zephyr Quixote');
  assert.equal(result.status, 'none');
  db.close();
});

test('resolveRecipient: empty or blank spoken name returns none', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Jane Smith', address: 'jane@example.com' });
  assert.equal(resolveRecipient(db, PROFILE, '').status, 'none');
  assert.equal(resolveRecipient(db, PROFILE, '   ').status, 'none');
  db.close();
});

test('resolveRecipient: a lone initial only scores 0.5 and is ignored (none)', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Jane Smith', address: 'jane@example.com' });
  const result = resolveRecipient(db, PROFILE, 'J');
  assert.equal(result.status, 'none');
  db.close();
});

test('resolveRecipient: punctuation and case in the spoken name are ignored', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Jane Smith', address: 'jane@example.com' });
  const result = resolveRecipient(db, PROFILE, "  JANE, smith!! ");
  assert.equal(result.status, 'one');
  assert.equal(result.contact.address, 'jane@example.com');
  db.close();
});

test('resolveRecipient: nickname "mom" matches a contact named Mom', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Mom', address: 'mom@example.com' });
  addContact(db, PROFILE, { name: 'Bob Jones', address: 'bob@example.com' });

  const result = resolveRecipient(db, PROFILE, 'mom');
  assert.equal(result.status, 'one');
  assert.equal(result.contact.address, 'mom@example.com');
  db.close();
});

test('resolveRecipient: nickname synonym "mum" matches a contact named Mother', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Mother', address: 'mother@example.com' });

  const result = resolveRecipient(db, PROFILE, 'mum');
  assert.equal(result.status, 'one');
  assert.equal(result.contact.address, 'mother@example.com');
  db.close();
});

test('resolveRecipient: nickname synonym does not cross groups', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Dad', address: 'dad@example.com' });
  // "mom" should not match a contact whose name only contains "dad".
  const result = resolveRecipient(db, PROFILE, 'mom');
  assert.equal(result.status, 'none');
  db.close();
});

test('resolveRecipient: nickname "grandma" matches nana and granny too', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Nana', address: 'nana@example.com' });
  const byGrandma = resolveRecipient(db, PROFILE, 'grandma');
  assert.equal(byGrandma.status, 'one');
  assert.equal(byGrandma.contact.address, 'nana@example.com');

  const db2 = freshDb();
  addContact(db2, PROFILE, { name: 'Granny Sue', address: 'granny@example.com' });
  const byNana = resolveRecipient(db2, PROFILE, 'nana');
  assert.equal(byNana.status, 'one');
  assert.equal(byNana.contact.address, 'granny@example.com');
});

test('resolveRecipient: nickname "grandpa" matches papa', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Papa', address: 'papa@example.com' });
  const result = resolveRecipient(db, PROFILE, 'grandpa');
  assert.equal(result.status, 'one');
  assert.equal(result.contact.address, 'papa@example.com');
  db.close();
});

test('resolveRecipient: recent senders (last 180 days) are candidates', () => {
  const db = freshDb();
  seedMessage(db, { fromName: 'Coach Alex', fromAddr: 'coach.alex@example.com', daysAgo: 10 });

  const result = resolveRecipient(db, PROFILE, 'Coach Alex');
  assert.equal(result.status, 'one');
  assert.equal(result.contact.address, 'coach.alex@example.com');
  db.close();
});

test('resolveRecipient: senders older than 180 days are not candidates', () => {
  const db = freshDb();
  seedMessage(db, { fromName: 'Old Contact', fromAddr: 'old@example.com', daysAgo: 200 });

  const result = resolveRecipient(db, PROFILE, 'Old Contact');
  assert.equal(result.status, 'none');
  db.close();
});

test('resolveRecipient: a saved contact wins over a recent sender with the same address', () => {
  const db = freshDb();
  seedMessage(db, { fromName: 'J Smith Sales Robot', fromAddr: 'jane@example.com', daysAgo: 5 });
  addContact(db, PROFILE, { name: 'Jane Smith', address: 'jane@example.com' });

  const result = resolveRecipient(db, PROFILE, 'Jane Smith');
  assert.equal(result.status, 'one');
  assert.equal(result.contact.name, 'Jane Smith');
  db.close();
});

test('resolveRecipient: only looks at this profile’s data', () => {
  const db = freshDb();
  addContact(db, 2, { name: 'Jane Smith', address: 'jane@example.com' });

  const result = resolveRecipient(db, PROFILE, 'Jane Smith');
  assert.equal(result.status, 'none');
  db.close();
});

test('resolveRecipient: never returns an address that was not in contacts or messages', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Jane Smith', address: 'jane@example.com' });
  addContact(db, PROFILE, { name: 'Jane Doe', address: 'jane.doe@example.com' });
  seedMessage(db, { fromName: 'Jane Roe', fromAddr: 'jane.roe@example.com', daysAgo: 1 });

  const known = new Set(['jane@example.com', 'jane.doe@example.com', 'jane.roe@example.com']);
  const result = resolveRecipient(db, PROFILE, 'Jane');
  assert.equal(result.status, 'many');
  for (const c of result.candidates) {
    assert.ok(known.has(c.address), `address ${c.address} must come from contacts or messages`);
  }
  db.close();
});

// ---------------------------------------------------------------------------
// suggestAddFromReply
// ---------------------------------------------------------------------------

test('suggestAddFromReply: adds a new contact with source reply', () => {
  const db = freshDb();
  const added = suggestAddFromReply(db, PROFILE, { name: 'New Person', address: 'new@example.com' });
  assert.ok(added);
  assert.equal(added.source, 'reply');

  const rows = listContacts(db, PROFILE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'reply');
  db.close();
});

test('suggestAddFromReply: does nothing when the address is already known', () => {
  const db = freshDb();
  addContact(db, PROFILE, { name: 'Jane Smith', address: 'jane@example.com', source: 'typed' });
  const result = suggestAddFromReply(db, PROFILE, { name: 'Jane Smith', address: 'jane@example.com' });
  assert.equal(result, null);

  const rows = listContacts(db, PROFILE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'typed', 'must not overwrite the existing typed contact');
  db.close();
});

test('suggestAddFromReply: rejects an invalid address without throwing', () => {
  const db = freshDb();
  const result = suggestAddFromReply(db, PROFILE, { name: 'Bad', address: 'not-an-email' });
  assert.equal(result, null);
  assert.equal(listContacts(db, PROFILE).length, 0);
  db.close();
});
