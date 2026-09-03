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

## Set up on a Linux box (one command)

On a Linux machine (like the SER8), one script does the whole thing: installs
rclone, connects Google Drive, mounts your `Brain` vault at `~/BrainDrive`,
installs a timer that refreshes the search index every 30 minutes, builds the
index once, and registers the MCP server into Claude Desktop, Claude Code, and
Cursor.

```
cd <repo>/brain && bash bootstrap-linux.sh
```

The only thing you type is one Google sign in (rclone needs it, once). Nothing
is uploaded; the database stays local at `~/Brain-index`. It is safe to re-run.
Want a local vault with no Google Drive? Use `setup-brain.sh` instead. The
pieces are also available as separate scripts (`mount-brain-drive.sh`,
`setup-brain-services.sh`, `wire-brain-mcp.sh`) if you want to run just one.

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
| `Local AI Master/` | Archived course platform. Now its own wiki section (see below), kept out of the main index. |
| `Attachments/` | Pasted images and files. |

New in the Open Brain layout:

| Folder | What it is |
|---|---|
| `engine/` | The local search index toolkit: schema, indexer, search, embeddings, and the MCP server (`brain_mcp.py`). Run `python engine/brainctl.py`. |
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

## Sections (separate wikis)

Bulky reference material can live in its own section: a subfolder indexed into
its own database and kept OUT of the main brain index, so it does not drown out
memory and sessions. `Local AI Master/` is set up this way.

```
python engine/brainctl.py sections                              # list sections
python engine/brainctl.py --section local-ai-master index        # build its wiki
python engine/brainctl.py --section local-ai-master search "rag" # search only it
```

Sections are configured in `engine/brain.config.json`.

## Make an AI use it

Register the MCP server (`engine/brain_mcp.py`) in any assistant, Claude Code,
Claude Desktop, Cursor, or Hermes, and it gets `brain_search`, `brain_get`, and
`brain_sections` as tools it can call. Agents with a terminal can also just run
`python engine/brainctl.py search "query"`. Full per-client setup, Hermes
included, is in `docs/use-from-an-ai.md`.

## Where the database lives

Outside the vault, at `~/Brain-index/brain.db` by default, exactly like the
`Brain-HTML/` render output lives outside the vault. It is derived and
rebuildable, so keeping it off Drive means Drive is not re-syncing a binary
every time the index is rebuilt.
