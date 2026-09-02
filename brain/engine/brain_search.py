"""Query the local index.

Two kinds of search, exactly as designed:

  keyword  (default) - structured full-text search over the notes. Uses FTS5
                       when available, and falls back to LIKE automatically so
                       it always returns something.

  semantic (--semantic) - nearest notes by meaning, using the vectors in the
                       `embedding` column. Only works after the backend-later
                       step (`brainctl.py embed`) has filled those vectors;
                       until then it prints how to turn it on and stops.

Both can be narrowed with --type, --tag, and --folder, and both are also plain
SQL underneath, so anything the CLI does not expose you can still get with a
direct query against the database.
"""

import argparse
import json
import math
import os
import sqlite3
import struct


def connect(db_path):
    if not os.path.exists(db_path):
        raise SystemExit(
            "No index database at %s. Run `python brainctl.py index` first." % db_path
        )
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _has_fts(conn):
    row = conn.execute("SELECT value FROM meta WHERE key = 'fts'").fetchone()
    return bool(row) and row["value"] == "ok"


def _fts_query(text):
    # Turn a plain query into a safe FTS5 expression: quote each bare term so
    # punctuation in the query cannot become FTS operators, and OR the terms.
    terms = [t for t in ''.join(c if c.isalnum() else ' ' for c in text).split() if t]
    if not terms:
        return None
    return " OR ".join('"%s"' % t for t in terms)


def keyword_search(conn, query, note_type=None, tag=None, folder=None, limit=20):
    where, params = [], []
    if note_type:
        where.append("notes.type = ?")
        params.append(note_type)
    if folder:
        where.append("notes.folder = ?")
        params.append(folder)
    if tag:
        where.append("notes.id IN (SELECT note_id FROM note_tags WHERE lower(tag) = ?)")
        params.append(tag.lower())

    if _has_fts(conn):
        match = _fts_query(query)
        if match is None:
            return []
        sql = [
            "SELECT notes.path, notes.title, notes.type, notes.folder,",
            "       notes.description, notes.tags,",
            "       snippet(notes_fts, 3, '', '', ' ... ', 12) AS snippet,",
            "       bm25(notes_fts) AS rank",
            "FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid",
            "WHERE notes_fts MATCH ?",
        ]
        p = [match] + params
        if where:
            sql.append("AND " + " AND ".join(where))
        sql.append("ORDER BY rank LIMIT ?")
        p.append(limit)
        return [dict(r) for r in conn.execute("\n".join(sql), p).fetchall()]

    # LIKE fallback: no ranking, but still filtered and bounded.
    like = "%" + query.strip() + "%"
    sql = [
        "SELECT path, title, type, folder, description, tags,",
        "       substr(body, 1, 160) AS snippet, 0 AS rank",
        "FROM notes",
        "WHERE (title LIKE ? OR description LIKE ? OR body LIKE ? OR tags LIKE ?)",
    ]
    p = [like, like, like, like] + params
    if where:
        sql.append("AND " + " AND ".join(where))
    sql.append("ORDER BY modified DESC LIMIT ?")
    p.append(limit)
    return [dict(r) for r in conn.execute("\n".join(sql), p).fetchall()]


# ---------------------------------------------------------------------------
# Semantic search (active once embeddings exist)
# ---------------------------------------------------------------------------

def unpack_vector(blob):
    return struct.unpack("<%df" % (len(blob) // 4), blob)


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def semantic_search(conn, query, note_type=None, tag=None, folder=None, limit=20):
    embedded = conn.execute("SELECT COUNT(*) FROM notes WHERE embedding IS NOT NULL").fetchone()[0]
    if embedded == 0:
        raise SystemExit(
            "Semantic search is not set up yet: no notes have embeddings.\n"
            "This is the backend-later step. Configure an embedding provider in\n"
            "brain.config.json, then run `python brainctl.py embed`. See\n"
            "docs/backend-later.md for the walkthrough. Keyword search works now."
        )
    # Import lazily so keyword-only users never need a provider configured.
    from brain_embed import get_provider
    provider = get_provider()
    query_vec = provider.embed([query])[0]

    rows = conn.execute(
        "SELECT id, path, title, type, folder, description, tags, embedding FROM notes "
        "WHERE embedding IS NOT NULL"
    ).fetchall()
    scored = []
    for r in rows:
        if note_type and r["type"] != note_type:
            continue
        if folder and r["folder"] != folder:
            continue
        vec = unpack_vector(r["embedding"])
        scored.append((cosine(query_vec, vec), r))
    scored.sort(key=lambda x: x[0], reverse=True)

    out = []
    for score, r in scored[:limit]:
        d = dict(r)
        d.pop("embedding", None)
        d.pop("id", None)
        d["rank"] = -score  # keep the "lower is better" convention of bm25
        d["snippet"] = (r["description"] or "")[:160]
        out.append(d)
    return out


# ---------------------------------------------------------------------------
# Presentation
# ---------------------------------------------------------------------------

def format_results(results, as_json=False):
    if as_json:
        return json.dumps(results, ensure_ascii=False, indent=2)
    if not results:
        return "No matches."
    lines = []
    for r in results:
        tags = ""
        try:
            parsed = json.loads(r.get("tags") or "[]")
            if parsed:
                tags = "  #" + " #".join(parsed)
        except (ValueError, TypeError):
            pass
        lines.append("%s  [%s]%s" % (r["title"], r.get("type") or "note", tags))
        lines.append("  %s" % r["path"])
        snip = (r.get("snippet") or r.get("description") or "").strip().replace("\n", " ")
        if snip:
            lines.append("  %s" % snip)
        lines.append("")
    return "\n".join(lines).rstrip()


def search(db_path, query, semantic=False, note_type=None, tag=None, folder=None, limit=20):
    conn = connect(db_path)
    try:
        if semantic:
            return semantic_search(conn, query, note_type, tag, folder, limit)
        return keyword_search(conn, query, note_type, tag, folder, limit)
    finally:
        conn.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Search the local Brain index.")
    parser.add_argument("query", help="What to search for")
    parser.add_argument("--db", required=True, help="Path to the SQLite index database")
    parser.add_argument("--semantic", action="store_true", help="Search by meaning (needs embeddings)")
    parser.add_argument("--type", dest="note_type", help="Filter by note type")
    parser.add_argument("--tag", help="Filter by tag")
    parser.add_argument("--folder", help="Filter by top-level folder")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--json", action="store_true", help="Machine-readable output")
    args = parser.parse_args(argv)
    results = search(
        args.db, args.query, semantic=args.semantic, note_type=args.note_type,
        tag=args.tag, folder=args.folder, limit=args.limit,
    )
    print(format_results(results, as_json=args.json))


if __name__ == "__main__":
    main()
