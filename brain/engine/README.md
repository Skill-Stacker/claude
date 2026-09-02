# engine: the local Brain index

A small, dependency-free toolkit that turns the markdown vault into a searchable
local database. Plain Python 3 and the standard library only. No pip install, no
build step, nothing leaves the machine.

The files stay canonical. This reads them and builds an index; it never writes to
your notes.

## Commands

```
python brainctl.py index                    # (re)build the index from the vault
python brainctl.py search "query"            # keyword search
python brainctl.py search "query" --semantic # search by meaning (needs embeddings)
python brainctl.py stats                     # counts, link health, embedding coverage
python brainctl.py embed                     # backend-later: fill embeddings
```

Common flags on `search`: `--type feedback`, `--tag ai-tech-dad`,
`--folder "Claude Memory"`, `--limit 10`, `--json`.

## Files

- `schema.sql` - the base tables (notes, note_tags, links, meta).
- `brain_index.py` - walks the vault, parses frontmatter and `[[wikilinks]]`,
  writes the index. Safe to run any time; it fully reconciles (adds, updates,
  removes).
- `brain_search.py` - keyword search (FTS5, with a LIKE fallback) and semantic
  search (once embeddings exist).
- `brain_embed.py` - the embedding step. Off by default. Talks to a local,
  OpenAI-compatible embedding server when you turn it on.
- `brainctl.py` - the single entry point that wires the above together.
- `brain.config.json` - paths and the embedding provider. Sensible defaults; you
  rarely need to touch it.

## Config

`brain.config.json`. Empty `vault_path` and `db_path` use safe defaults:
the vault is the folder above `engine/`, and the database is
`~/Brain-index/brain.db` (outside the vault on purpose). `ignore_dirs` lists
folders the indexer skips. `embedding` is off (`"provider": "none"`) until you
wire a local server; see `../docs/backend-later.md`.

## Scheduling a rebuild (optional)

The index only reflects the vault as of the last `index` run. To keep it fresh,
run `python brainctl.py index --quiet` on a schedule (Windows Task Scheduler),
the same way the vault already snapshots memory hourly. The indexer is cheap and
idempotent, so running it often is fine.

## Requirements

Python 3.8 or newer with SQLite. FTS5 (full-text search) is used when the Python
build includes it, which the standard python.org Windows build does; if it is
missing, search automatically falls back to a slower LIKE scan and still works.
