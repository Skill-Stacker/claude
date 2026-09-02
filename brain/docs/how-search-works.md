# How search works

Two kinds of search sit on the same local database. Both are just SQL
underneath, so anything the commands do not expose, you can still get with a
direct query.

## Keyword search (on now)

The default. Full-text search over each note's title, description, tags, and
body, using SQLite's FTS5 when it is available and a plain LIKE scan when it is
not, so it always returns something.

```
python engine/brainctl.py search "google drive junction"
python engine/brainctl.py search "upload" --type session --tag ai-tech-dad
python engine/brainctl.py search "royalty" --folder "Claude Memory" --limit 5
```

Good for finding a note when you remember a word that is in it.

## Semantic search (scaffolded, off until you turn it on)

Finds notes by meaning rather than exact words, so "what did I decide about
keeping backups" can surface the right note even if it never says "backup." It
compares the query against a vector stored on each note in the `embedding`
column.

That column is empty until the backend-later step fills it. Until then,
`search --semantic` explains how to turn it on and stops. See
`backend-later.md`.

## Sections: separate wikis

A section is a subfolder indexed into its own database and kept out of the main
brain index, so bulky reference material does not crowd out memory and sessions.
`Local AI Master/` is one. Configure sections in `engine/brain.config.json`.

```
python engine/brainctl.py sections                               # list them
python engine/brainctl.py --section local-ai-master index         # build its wiki
python engine/brainctl.py --section local-ai-master search "rag"  # search only it
```

Each section is a normal index underneath, so everything below applies to it too.

## The schema at a glance

- `notes` - one row per note: `slug`, `path`, `folder`, `title`, `description`,
  `type`, `tags` (JSON), `body`, `created`, `modified`, `content_hash`,
  `embedding` (reserved).
- `note_tags` - one row per (note, tag), for clean filtering and counts.
- `links` - the `[[wikilink]]` graph: `source_id`, `target_norm`, `target_id`
  (NULL when the target note does not exist yet), `raw`.
- `meta` - index bookkeeping (last indexed time, note count, whether FTS is on).

## Querying it directly

The database is a plain SQLite file (`~/Brain-index/brain.db` by default). Any
SQLite tool can read it. Examples:

```sql
-- All feedback notes, newest first
SELECT title, path FROM notes WHERE type = 'feedback' ORDER BY modified DESC;

-- The most-linked-to notes (the hubs)
SELECT n.title, COUNT(*) AS inbound
FROM links l JOIN notes n ON n.id = l.target_id
GROUP BY l.target_id ORDER BY inbound DESC LIMIT 20;

-- Wikilinks that point at notes not written yet (things worth writing)
SELECT DISTINCT target_norm FROM links WHERE target_id IS NULL ORDER BY 1;

-- Every note tagged a given way
SELECT n.title FROM notes n JOIN note_tags t ON t.note_id = n.id
WHERE t.tag = 'ai-tech-dad';
```

## Keeping it fresh

The index reflects the vault as of the last `index` run. Re-run
`python engine/brainctl.py index` after a batch of note edits, or schedule it.
It is idempotent and only touches notes whose content changed, so running it
often is cheap.
