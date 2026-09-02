-- StickOS v3 local cache. One file per stick, shared by all profiles; rows carry profile_id.
-- Times are ISO 8601 UTC strings. Events are pre-expanded instances, never raw RRULEs.

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'child',        -- 'child' (helper modes only) or 'adult'
  pin_salt BLOB, pin_hash BLOB,
  kdf_n INTEGER, kdf_r INTEGER, kdf_p INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until_utc TEXT,
  auto_lock_minutes INTEGER NOT NULL DEFAULT 10,
  created_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  profile_id INTEGER NOT NULL,
  gm_msgid TEXT NOT NULL,                    -- Gmail X-GM-MSGID, stable across label moves
  gm_thrid TEXT,
  folder TEXT, uid INTEGER,
  message_id TEXT,                           -- RFC 5322 Message-ID
  from_name TEXT, from_addr TEXT,
  to_addrs TEXT,                             -- JSON array
  subject TEXT,
  date_utc TEXT,
  is_unread INTEGER NOT NULL DEFAULT 0,
  is_flagged INTEGER NOT NULL DEFAULT 0,
  labels TEXT,                               -- JSON array from X-GM-LABELS
  snippet TEXT,
  body_text TEXT,                            -- capped plain text, HTML stripped
  size INTEGER,
  synced_utc TEXT,
  PRIMARY KEY (profile_id, gm_msgid)
);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(profile_id, gm_thrid, date_utc);
CREATE INDEX IF NOT EXISTS idx_msg_unread ON messages(profile_id, is_unread, from_addr, date_utc);
CREATE INDEX IF NOT EXISTS idx_msg_date ON messages(profile_id, date_utc);

CREATE TABLE IF NOT EXISTS threads (
  profile_id INTEGER NOT NULL,
  gm_thrid TEXT NOT NULL,
  subject TEXT,
  participants TEXT,                         -- JSON array of addresses
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_date_utc TEXT,
  last_snippet TEXT,
  PRIMARY KEY (profile_id, gm_thrid)
);

CREATE TABLE IF NOT EXISTS events (
  profile_id INTEGER NOT NULL,
  instance_id TEXT NOT NULL,                 -- uid + '@' + recurrence start for expanded instances
  uid TEXT NOT NULL,
  calendar_name TEXT,
  summary TEXT,
  location TEXT,
  description TEXT,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  tzid TEXT,                                 -- the event's own zone, never the machine's
  status TEXT,
  organizer TEXT,
  rrule_raw TEXT,
  last_seen_utc TEXT,
  PRIMARY KEY (profile_id, instance_id)
);
CREATE INDEX IF NOT EXISTS idx_events_window ON events(profile_id, start_utc, end_utc);

CREATE TABLE IF NOT EXISTS aliases (
  profile_id INTEGER NOT NULL,
  label TEXT NOT NULL,                       -- "the kids' school"
  match_type TEXT NOT NULL,                  -- 'domain' | 'address' | 'name'
  match_value TEXT NOT NULL,
  PRIMARY KEY (profile_id, label)
);

CREATE TABLE IF NOT EXISTS contacts (
  profile_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'typed',      -- 'typed' | 'reply'
  created_utc TEXT NOT NULL,
  PRIMARY KEY (profile_id, address)
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  due_utc TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL,
  gm_thrid TEXT,
  to_addr TEXT NOT NULL,
  to_name TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  in_reply_to TEXT,
  message_id TEXT NOT NULL,                  -- our own generated Message-ID, used to confirm delivery in Sent
  state TEXT NOT NULL DEFAULT 'draft',       -- 'draft' | 'sending' | 'sent' | 'failed' | 'unknown'
  created_utc TEXT NOT NULL,
  updated_utc TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                        -- JSON
);
