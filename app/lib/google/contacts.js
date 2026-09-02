// Resolves a spoken name into a known email address. Scout must never guess
// an address: "reply to sender" reuses the thread's From address directly
// (no lookup, not handled here), and "email Jane" only ever resolves against
// addresses already in the `contacts` table or seen recently in `messages`.
// If a name is not in one of those two tables it does not get an address.

// Conservative RFC 5322-ish check. Good enough to catch typos, not meant to
// accept every legal address.
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const NICKNAME_GROUPS = [
  ['mom', 'mum', 'mother'],
  ['dad', 'father'],
  ['grandma', 'nana', 'granny'],
  ['grandpa', 'papa'],
];

const RECENT_SENDER_DAYS = 180;

function isValidEmail(address) {
  return typeof address === 'string' && EMAIL_RE.test(address.trim());
}

// Lowercase, punctuation stripped, whitespace collapsed.
function normalizeTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Contacts table
// ---------------------------------------------------------------------------

// Adds (or updates) a contact. Validates and lowercases the address; throws
// a plain-worded Error if the name or address is missing or the address does
// not look like an email address.
export function addContact(db, profileId, { name, address, source = 'typed' } = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    throw new Error('A contact needs a name.');
  }
  if (!isValidEmail(address)) {
    throw new Error('That does not look like an email address.');
  }
  const cleanAddress = String(address).trim().toLowerCase();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO contacts (profile_id, name, address, source, created_utc)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, address) DO UPDATE SET
       name = excluded.name,
       source = excluded.source`,
    [profileId, cleanName, cleanAddress, source, now],
  );

  return { name: cleanName, address: cleanAddress, source };
}

// All contacts for a profile, alphabetical by name.
export function listContacts(db, profileId) {
  return db
    .all('SELECT name, address, source, created_utc FROM contacts WHERE profile_id = ? ORDER BY name', [profileId])
    .map((row) => ({ ...row }));
}

// Removes a contact by address. Returns true if a row was deleted.
export function removeContact(db, profileId, address) {
  const cleanAddress = String(address || '').trim().toLowerCase();
  const result = db.run('DELETE FROM contacts WHERE profile_id = ? AND address = ?', [profileId, cleanAddress]);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Resolving a spoken name
// ---------------------------------------------------------------------------

function collectCandidates(db, profileId) {
  const cutoff = new Date(Date.now() - RECENT_SENDER_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const contactRows = db.all('SELECT name, address FROM contacts WHERE profile_id = ?', [profileId]);
  const senderRows = db.all(
    `SELECT DISTINCT from_name AS name, from_addr AS address FROM messages
     WHERE profile_id = ? AND date_utc >= ? AND from_addr IS NOT NULL AND from_addr != ''`,
    [profileId, cutoff],
  );

  // Contacts win over a recent-sender row for the same address: they carry
  // a name the human chose on purpose.
  const byAddress = new Map();
  for (const row of [...contactRows, ...senderRows]) {
    if (!row.address) continue;
    const address = String(row.address).trim().toLowerCase();
    if (!address || byAddress.has(address)) continue;
    const name = (row.name && String(row.name).trim()) || address;
    byAddress.set(address, { name, address });
  }
  return [...byAddress.values()];
}

function scoreMatch(spokenTokens, spokenJoined, nameTokens) {
  if (nameTokens.length === 0) return 0;
  const nameJoined = nameTokens.join(' ');
  let score = 0;

  if (spokenJoined === nameJoined) score = Math.max(score, 3);
  if (spokenTokens.every((t) => nameTokens.includes(t))) score = Math.max(score, 2);
  if (spokenTokens[0] === nameTokens[0]) score = Math.max(score, 1);
  if (spokenTokens[0] && nameTokens[0] && spokenTokens[0][0] === nameTokens[0][0]) {
    score = Math.max(score, 0.5);
  }

  for (const group of NICKNAME_GROUPS) {
    const spokenIsNickname = spokenTokens.some((t) => group.includes(t));
    const nameHasNickname = nameTokens.some((t) => group.includes(t));
    if (spokenIsNickname && nameHasNickname) score = Math.max(score, 2);
  }

  return score;
}

// Resolves a spoken name against known contacts and recent senders (last 180
// days). Never invents an address: every candidate comes from one of those
// two tables.
//
// Returns { status: 'one', contact } when exactly one candidate has the top
// score and that score is at least 2; { status: 'many', candidates } (up to
// 5, highest score first) when there is a tie or the best score is between 1
// and 2; { status: 'none' } otherwise.
export function resolveRecipient(db, profileId, spoken) {
  const spokenTokens = normalizeTokens(spoken);
  if (spokenTokens.length === 0) return { status: 'none' };
  const spokenJoined = spokenTokens.join(' ');

  const candidates = collectCandidates(db, profileId);
  const scored = candidates
    .map((c) => ({ ...c, score: scoreMatch(spokenTokens, spokenJoined, normalizeTokens(c.name)) }))
    .filter((c) => c.score >= 1);

  if (scored.length === 0) return { status: 'none' };

  const topScore = Math.max(...scored.map((c) => c.score));
  const top = scored.filter((c) => c.score === topScore);

  if (top.length === 1 && topScore >= 2) {
    const { score, ...contact } = top[0];
    return { status: 'one', contact };
  }

  const candidatesOut = scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ score, ...c }) => c);
  return { status: 'many', candidates: candidatesOut };
}

// Called after a reply is sent to someone not already in contacts: offers to
// remember them. Adds with source 'reply' only if the address is not already
// known; returns the added contact, or null if it was invalid or already
// present.
export function suggestAddFromReply(db, profileId, { name, address } = {}) {
  if (!isValidEmail(address)) return null;
  const cleanAddress = String(address).trim().toLowerCase();
  const existing = db.get('SELECT address FROM contacts WHERE profile_id = ? AND address = ?', [
    profileId,
    cleanAddress,
  ]);
  if (existing) return null;
  return addContact(db, profileId, { name: name || cleanAddress, address: cleanAddress, source: 'reply' });
}
