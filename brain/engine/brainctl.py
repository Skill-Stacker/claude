#!/usr/bin/env python3
"""brainctl: one command to run the local Brain index.

    python brainctl.py index                 # (re)build the index from the vault
    python brainctl.py search "query"         # keyword search
    python brainctl.py search "query" --semantic   # search by meaning (needs embeddings)
    python brainctl.py stats                  # what is in the index
    python brainctl.py embed                  # backend-later: fill embeddings

Paths come from brain.config.json next to this file. You rarely need flags; the
defaults assume this file lives at Brain/engine/ and the vault is its parent.
The database is written OUTSIDE the vault by default (like the Brain-HTML
render output) so Google Drive is not re-syncing a binary on every reindex.
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

DEFAULT_IGNORE_DIRS = [
    ".git", ".obsidian", ".trash", "node_modules", "__pycache__",
    "Attachments", "_legacy-2026-09-02", "Josh needs to delete me",
]


def load_config():
    path = os.path.join(HERE, "brain.config.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}


def expand(path):
    return os.path.expanduser(os.path.expandvars(path))


def resolve_vault(config, override=None):
    if override:
        return os.path.abspath(expand(override))
    configured = config.get("vault_path")
    if configured:
        return os.path.abspath(expand(configured))
    # Default: the parent of engine/, i.e., the Brain vault root.
    return os.path.abspath(os.path.join(HERE, ".."))


def resolve_db(config, override=None):
    if override:
        return os.path.abspath(expand(override))
    configured = config.get("db_path")
    if configured:
        return os.path.abspath(expand(configured))
    # Default: outside the vault so Drive never syncs it.
    return os.path.abspath(expand(os.path.join("~", "Brain-index", "brain.db")))


def resolve_ignore(config):
    return config.get("ignore_dirs") or DEFAULT_IGNORE_DIRS


def cmd_index(args, config):
    import brain_index
    brain_index.index_vault.ignore_dirs = resolve_ignore(config)
    vault = resolve_vault(config, args.vault)
    db = resolve_db(config, args.db)
    brain_index.index_vault(vault, db, verbose=not args.quiet)


def cmd_search(args, config):
    import brain_search
    db = resolve_db(config, args.db)
    results = brain_search.search(
        db, args.query, semantic=args.semantic, note_type=args.note_type,
        tag=args.tag, folder=args.folder, limit=args.limit,
    )
    print(brain_search.format_results(results, as_json=args.json))


def cmd_stats(args, config):
    import sqlite3
    db = resolve_db(config, args.db)
    if not os.path.exists(db):
        raise SystemExit("No index at %s. Run `python brainctl.py index` first." % db)
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    total = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
    print("Index: %s" % db)
    row = conn.execute("SELECT value FROM meta WHERE key='last_indexed'").fetchone()
    if row:
        print("Last indexed: %s" % row["value"])
    row = conn.execute("SELECT value FROM meta WHERE key='fts'").fetchone()
    print("Full-text search: %s" % ("FTS5" if row and row["value"] == "ok" else "LIKE fallback"))
    print("Notes: %d" % total)
    print("\nBy type:")
    for r in conn.execute("SELECT type, COUNT(*) n FROM notes GROUP BY type ORDER BY n DESC"):
        print("  %-12s %d" % (r["type"] or "(none)", r["n"]))
    print("\nBy folder:")
    for r in conn.execute("SELECT folder, COUNT(*) n FROM notes GROUP BY folder ORDER BY n DESC"):
        print("  %-18s %d" % (r["folder"] or "(root)", r["n"]))
    links = conn.execute("SELECT COUNT(*) FROM links").fetchone()[0]
    broken = conn.execute("SELECT COUNT(*) FROM links WHERE target_id IS NULL").fetchone()[0]
    embedded = conn.execute("SELECT COUNT(*) FROM notes WHERE embedding IS NOT NULL").fetchone()[0]
    print("\nWikilinks: %d total, %d point at notes not yet written" % (links, broken))
    print("Embeddings: %d / %d notes (semantic search %s)" % (
        embedded, total, "on" if embedded else "off, run `brainctl.py embed`"))
    conn.close()


def cmd_embed(args, config):
    import brain_embed
    db = resolve_db(config, args.db)
    if not os.path.exists(db):
        raise SystemExit("No index at %s. Run `python brainctl.py index` first." % db)
    brain_embed.embed_all(db, batch_size=args.batch_size)


def build_parser():
    parser = argparse.ArgumentParser(prog="brainctl", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", help="Override the database path")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("index", help="(Re)build the index from the vault")
    p.add_argument("--vault", help="Override the vault path")
    p.add_argument("--quiet", action="store_true")
    p.set_defaults(func=cmd_index)

    p = sub.add_parser("search", help="Search the index")
    p.add_argument("query")
    p.add_argument("--semantic", action="store_true")
    p.add_argument("--type", dest="note_type")
    p.add_argument("--tag")
    p.add_argument("--folder")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("stats", help="Show what is in the index")
    p.set_defaults(func=cmd_stats)

    p = sub.add_parser("embed", help="Fill embeddings (backend-later step)")
    p.add_argument("--batch-size", type=int, default=16)
    p.set_defaults(func=cmd_embed)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    config = load_config()
    args.func(args, config)


if __name__ == "__main__":
    main()
