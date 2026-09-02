# Brain: the Open Brain layout

This is Josh's brain vault, re-set-up in the Open Brain (OB1) style on
2026-09-02. It is still the same thing it always was: an Obsidian vault of plain
markdown notes with YAML frontmatter and `[[wikilinks]]`, living on Google Drive
at `G:\My Drive\Brain`, serving as shared memory for Josh and every AI that
works with him.

What is new is a search layer on top. The notes are still the source of truth,
but a small local database is now built from them so the vault is queryable, by
keyword now and by meaning later, the way an OB1 database is, without moving
anything into the cloud.

## The two rules that shape everything here

1. **Files stay canonical.** Every note is authored, edited, linked, and read as
   a `.md` file. The database is built FROM the files and can be deleted and
   rebuilt any time. Nothing in the database is a source of truth. If the notes
   and the database ever disagree, the notes win.
2. **Nothing leaves the machine.** The index is a local SQLite file. Semantic
   search, when it is turned on, runs against a local embedding server. There is
   no cloud database and no API key. This keeps the vault's standing rule that
   memory does not leave the machine.

## Read these first

- `AGENTS.md` is the contract for any AI working in the vault. Read it before
  touching anything.
- `Home.md` is the human tour.
- `Claude Memory/MEMORY.md` is the index of durable memory notes.

## The layout

The working folders are unchanged and still hold the real content:

| Folder | What it is |
|---|---|
| `Claude Memory/` | Durable facts about Josh, his ventures, this machine. `MEMORY.md` is the index. |
| `Inbox/` | Raw capture only. |
| `Workbench/` | Work in progress, one folder per project. |
| `Outbox/` | Finished deliverables waiting on Josh to publish. |
| `Ventures/` | One folder per business line, the published record. |
| `Sessions/` | Dated session write-ups. |
| `Writing/` | Josh's 2020 daily blog, the voice reference. |
| `Local AI Master/` | Archived course platform, reference. |
| `Attachments/` | Pasted images and files. |

New in the Open Brain layout:

| Folder | What it is |
|---|---|
| `engine/` | The local search index toolkit: schema, indexer, search, embeddings. Run `python engine/brainctl.py`. |
| `docs/` | How the migration mapped the old vault into this, how search works, and how to turn on semantic search. |
| `skills/` | Plain-text skill packs an agent loads: how to recall from the index, how to capture a session. |
| `_legacy-2026-09-02/` | The old top-level system docs, archived on migration day. Reference only, superseded by `AGENTS.md` and `docs/`. |

## Using the search

```
python engine/brainctl.py index            # (re)build the index from the vault
python engine/brainctl.py search "backups"  # keyword search
python engine/brainctl.py stats             # what is in the index
```

Semantic search ("find notes about X by meaning") is scaffolded but off until
you point it at a local embedding server. See `docs/backend-later.md`.

## Where the database lives

Outside the vault, at `~/Brain-index/brain.db` by default, exactly like the
`Brain-HTML/` render output lives outside the vault. It is derived and
rebuildable, so keeping it off Drive means Drive is not re-syncing a binary
every time the index is rebuilt.
