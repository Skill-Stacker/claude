"""Build the local search index from the markdown vault.

Files stay canonical. This walks the vault, reads every .md note, parses its
YAML-ish frontmatter and its [[wikilinks]], and writes rows into a SQLite
database that `brain_search.py` queries. It is safe to run any time: it reads
the vault read-only and fully reconciles the database (new notes added, changed
notes updated, deleted notes removed).

Run it with `python brainctl.py index` (see brainctl.py), or directly:

    python brain_index.py --vault /path/to/Brain --db /path/to/brain.db

The frontmatter parser here is deliberately small and tolerant rather than a
full YAML engine: this vault's frontmatter is plain key/value plus a one-level
`metadata:` block and simple tag lists, and staying dependency-free matches the
vault's "no library unless a hand-written version would be materially worse"
rule.
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Frontmatter and body
# ---------------------------------------------------------------------------

FRONTMATTER_RE = re.compile(r"^﻿?---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


def split_frontmatter(text):
    """Return (frontmatter_dict, body). Missing or malformed block gives {}."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    block = m.group(1)
    body = text[m.end():]
    try:
        return parse_frontmatter(block), body
    except Exception:
        # A note with unparseable frontmatter still gets indexed by its body;
        # never let one bad header stop the whole run.
        return {}, body


def parse_frontmatter(block):
    """Parse a small subset of YAML: scalars, one-level nesting, and lists.

    Handles the shapes this vault actually uses:
        name: some-slug
        description: one line
        metadata:
          type: project
          tags: [a, b, c]
        tags:
          - session
          - ai-tech-dad
    """
    root = {}
    stack = [(-1, root)]  # (indent, container) stack for one-level nesting
    pending_list_key = None
    pending_list_indent = None

    for raw_line in block.split("\n"):
        line = raw_line.rstrip()
        if not line.strip() or line.strip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()

        # Block-list item: "- value" under the most recent key.
        if stripped.startswith("- ") or stripped == "-":
            if pending_list_key is not None:
                container = _container_for_indent(stack, pending_list_indent)
                # An empty-value key ("tags:") was provisionally stored as {} in
                # case it was a nested map; a "- item" line proves it is a list,
                # so coerce it before appending.
                if not isinstance(container.get(pending_list_key), list):
                    container[pending_list_key] = []
                val = stripped[1:].strip()
                if val:
                    container[pending_list_key].append(_scalar(val))
            continue

        if ":" not in stripped:
            continue

        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip()

        container = _container_for_indent(stack, indent)

        if value == "":
            # Either a nested map (metadata:) or the header of a block list.
            # Decide lazily: create a dict, but remember the key so a following
            # "- item" line can turn it into a list instead.
            container[key] = {}
            stack = [(i, c) for (i, c) in stack if i < indent]
            stack.append((indent, container[key]))
            pending_list_key = key
            pending_list_indent = indent
            continue

        container[key] = _parse_value(value)
        pending_list_key = key
        pending_list_indent = indent

    _prune_empty_maps(root)
    return root


def _container_for_indent(stack, indent):
    while len(stack) > 1 and stack[-1][0] >= indent:
        stack.pop()
    return stack[-1][1]


def _prune_empty_maps(d):
    # A "key:" with nothing under it parsed as an empty dict; drop those so
    # callers see a clean absence rather than {}.
    for k in list(d.keys()):
        v = d[k]
        if isinstance(v, dict):
            _prune_empty_maps(v)
            if not v:
                del d[k]


def _parse_value(value):
    # Inline list: [a, b, c]
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [_scalar(p) for p in _split_list(inner)]
    return _scalar(value)


def _split_list(inner):
    parts, buf, depth = [], [], 0
    for ch in inner:
        if ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf))
    return [p.strip() for p in parts if p.strip()]


def _scalar(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


# ---------------------------------------------------------------------------
# Field extraction
# ---------------------------------------------------------------------------

def slugify(text):
    text = text.strip().lower()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    return text.strip("-")


def normalize_link_target(target):
    """[[Target|alias]] and [[Target#heading]] both point at Target."""
    target = target.split("|", 1)[0]
    target = target.split("#", 1)[0]
    return target.strip().lower()


def extract_tags(front):
    tags = []
    for source in (front.get("tags"), front.get("metadata", {}).get("tags")):
        if isinstance(source, list):
            tags.extend(str(t).strip() for t in source if str(t).strip())
        elif isinstance(source, str) and source.strip():
            tags.append(source.strip())
    # De-duplicate, preserve order.
    seen, out = set(), []
    for t in tags:
        key = t.lower()
        if key not in seen:
            seen.add(key)
            out.append(t)
    return out


def resolve_type(front, folder):
    meta = front.get("metadata", {}) if isinstance(front.get("metadata"), dict) else {}
    t = front.get("type") or meta.get("type")
    if t:
        return str(t).strip()
    # Fall back to the folder's role when the note does not declare a type.
    folder_types = {
        "Claude Memory": "memory",
        "Sessions": "session",
        "Ventures": "venture",
        "Writing": "writing",
        "Local AI Master": "reference",
        "Workbench": "workbench",
        "Outbox": "outbox",
        "Inbox": "inbox",
    }
    return folder_types.get(folder, "note")


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()


# ---------------------------------------------------------------------------
# Walking the vault
# ---------------------------------------------------------------------------

def iter_markdown(vault_path, ignore_dirs):
    ignore = {d.lower() for d in ignore_dirs}
    for root, dirs, files in os.walk(vault_path):
        # Prune ignored directories in place so os.walk does not descend them.
        dirs[:] = [d for d in dirs if d.lower() not in ignore and not d.startswith(".")]
        for name in files:
            if name.lower().endswith(".md"):
                yield os.path.join(root, name)


def top_folder(vault_path, full_path):
    rel = os.path.relpath(full_path, vault_path)
    parts = rel.replace("\\", "/").split("/")
    return parts[0] if len(parts) > 1 else ""


def build_note(vault_path, full_path):
    with open(full_path, "r", encoding="utf-8", errors="replace") as fh:
        raw = fh.read()
    front, body = split_frontmatter(raw)
    rel = os.path.relpath(full_path, vault_path).replace("\\", "/")
    stem = os.path.splitext(os.path.basename(full_path))[0]
    folder = top_folder(vault_path, full_path)

    name = str(front.get("name") or "").strip()
    slug = name or slugify(stem)
    title = str(front.get("title") or name or stem).strip()
    description = str(front.get("description") or "").strip()
    tags = extract_tags(front)
    note_type = resolve_type(front, folder)

    st = os.stat(full_path)
    created = (
        str(front.get("date") or front.get("created") or "").strip()
        or iso(getattr(st, "st_ctime", st.st_mtime))
    )
    modified = iso(st.st_mtime)

    targets = []
    for m in WIKILINK_RE.finditer(body):
        norm = normalize_link_target(m.group(1))
        if norm:
            targets.append((norm, m.group(1).strip()))

    return {
        "slug": slug,
        "path": rel,
        "folder": folder,
        "title": title,
        "description": description,
        "type": note_type,
        "tags": tags,
        "body": body.strip(),
        "frontmatter": json.dumps(front, ensure_ascii=False),
        "word_count": len(body.split()),
        "created": created,
        "modified": modified,
        "content_hash": hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest(),
        "stem": stem,
        "targets": targets,
    }


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def connect(db_path):
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def apply_schema(conn):
    schema_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")
    with open(schema_path, "r", encoding="utf-8") as fh:
        conn.executescript(fh.read())


def fts_available(conn):
    try:
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x)")
        conn.execute("DROP TABLE IF EXISTS _fts_probe")
        return True
    except sqlite3.OperationalError:
        return False


def rebuild_fts(conn):
    """(Re)build the external-content FTS table from notes. Returns True on success."""
    if not fts_available(conn):
        conn.execute("DELETE FROM meta WHERE key = 'fts'")
        conn.execute("INSERT INTO meta(key, value) VALUES ('fts', 'missing')")
        return False
    conn.execute("DROP TABLE IF EXISTS notes_fts")
    conn.execute(
        """
        CREATE VIRTUAL TABLE notes_fts USING fts5(
            title, description, tags, body,
            content='notes', content_rowid='id',
            tokenize='unicode61'
        )
        """
    )
    conn.execute(
        """
        INSERT INTO notes_fts(rowid, title, description, tags, body)
        SELECT id, title, description, tags, body FROM notes
        """
    )
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('fts', 'ok')")
    return True


DEFAULT_WORKERS = 16


def _read_notes(vault_path, paths, verbose):
    """Read and parse every note, concurrently.

    A vault on a network mount (Google Drive through rclone) is latency bound,
    not CPU bound: one file at a time means one round trip at a time, so a big
    vault can take many minutes. build_note only opens, reads and parses, and
    holds no shared state, so a thread pool turns that into concurrent round
    trips. Local disk is unaffected. Set BRAIN_WORKERS=1 to force serial.
    """
    total = len(paths)
    if verbose:
        print("Reading %d notes from %s" % (total, vault_path))

    try:
        workers = int(os.environ.get("BRAIN_WORKERS") or DEFAULT_WORKERS)
    except ValueError:
        workers = DEFAULT_WORKERS
    workers = max(1, min(workers, total or 1))

    def read_one(path):
        # One unreadable file (a Drive hiccup, an odd permission) must not throw
        # away the whole pass.
        try:
            return build_note(vault_path, path)
        except Exception as exc:
            sys.stderr.write("skipped %s (%s)\n" % (path, exc))
            return None

    if workers > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=workers) as pool:
            return _drain(pool.map(read_one, paths), total, verbose)
    return _drain((read_one(p) for p in paths), total, verbose)


def _drain(produced, total, verbose):
    """Collect the notes, showing progress so a slow mount never looks frozen."""
    notes = []
    done = 0
    for note in produced:
        done += 1
        if note is not None:
            notes.append(note)
        if verbose and (done % 20 == 0 or done == total):
            # stderr on purpose: stdout is a data channel for other callers.
            sys.stderr.write("\r  read %d/%d" % (done, total))
            sys.stderr.flush()
    if verbose and total:
        sys.stderr.write("\n")
    return notes


def index_vault(vault_path, db_path, verbose=True):
    vault_path = os.path.abspath(vault_path)
    if not os.path.isdir(vault_path):
        raise SystemExit("Vault path not found: %s" % vault_path)

    conn = connect(db_path)
    apply_schema(conn)

    seen_paths = set()
    alias_map = {}   # normalized alias -> slug, for wikilink resolution

    paths = list(iter_markdown(vault_path, index_vault.ignore_dirs))
    notes = _read_notes(vault_path, paths, verbose)

    for note in notes:
        seen_paths.add(note["path"])
        for alias in (note["slug"], note["stem"], note["title"]):
            if alias:
                alias_map.setdefault(alias.strip().lower(), note["slug"])

    # Guard against two files resolving to the same slug (would break UNIQUE).
    notes = _dedupe_slugs(notes)

    with conn:
        for note in notes:
            _upsert_note(conn, note)
        # Remove notes whose file is gone.
        placeholders = ",".join("?" for _ in seen_paths) or "''"
        conn.execute(
            "DELETE FROM notes WHERE path NOT IN (%s)" % placeholders,
            tuple(seen_paths),
        )
        _rebuild_links(conn, notes, alias_map)
        fts_ok = rebuild_fts(conn)
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('last_indexed', ?)",
            (datetime.now(timezone.utc).isoformat(),),
        )
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('vault_path', ?)",
            (vault_path,),
        )
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('note_count', ?)",
            (str(len(notes)),),
        )

    if verbose:
        broken = conn.execute("SELECT COUNT(*) FROM links WHERE target_id IS NULL").fetchone()[0]
        embedded = conn.execute("SELECT COUNT(*) FROM notes WHERE embedding IS NOT NULL").fetchone()[0]
        print("Indexed %d notes from %s" % (len(notes), vault_path))
        print("Database: %s" % os.path.abspath(db_path))
        print("Full-text search: %s" % ("FTS5" if fts_ok else "LIKE fallback (FTS5 not compiled in)"))
        print("Wikilinks to notes not yet written: %d" % broken)
        print("Notes with embeddings: %d (run `brainctl.py embed` to add semantic search)" % embedded)
    conn.close()
    return len(notes)


# Attribute set from config/CLI before index_vault runs; defaults are safe.
index_vault.ignore_dirs = [".git", ".obsidian", ".trash", "node_modules"]


def _dedupe_slugs(notes):
    counts = {}
    out = []
    for note in notes:
        slug = note["slug"]
        if slug in counts:
            counts[slug] += 1
            note = dict(note)
            note["slug"] = "%s-%d" % (slug, counts[slug])
        else:
            counts[slug] = 0
        out.append(note)
    return out


def _upsert_note(conn, note):
    existing = conn.execute(
        "SELECT id, content_hash FROM notes WHERE path = ?", (note["path"],)
    ).fetchone()
    tags_json = json.dumps(note["tags"], ensure_ascii=False)
    if existing and existing["content_hash"] == note["content_hash"]:
        note_id = existing["id"]
    else:
        cur = conn.execute(
            """
            INSERT INTO notes
                (slug, path, folder, title, description, type, tags, body,
                 frontmatter, word_count, created, modified, content_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                slug=excluded.slug, folder=excluded.folder, title=excluded.title,
                description=excluded.description, type=excluded.type, tags=excluded.tags,
                body=excluded.body, frontmatter=excluded.frontmatter,
                word_count=excluded.word_count, created=excluded.created,
                modified=excluded.modified, content_hash=excluded.content_hash,
                embedding=NULL, embedding_model=NULL
            """,
            (
                note["slug"], note["path"], note["folder"], note["title"],
                note["description"], note["type"], tags_json, note["body"],
                note["frontmatter"], note["word_count"], note["created"],
                note["modified"], note["content_hash"],
            ),
        )
        note_id = conn.execute(
            "SELECT id FROM notes WHERE path = ?", (note["path"],)
        ).fetchone()["id"]
    note["_id"] = note_id
    conn.execute("DELETE FROM note_tags WHERE note_id = ?", (note_id,))
    for tag in note["tags"]:
        conn.execute("INSERT INTO note_tags(note_id, tag) VALUES (?, ?)", (note_id, tag))


def _rebuild_links(conn, notes, alias_map):
    slug_to_id = {
        row["slug"]: row["id"] for row in conn.execute("SELECT id, slug FROM notes")
    }
    conn.execute("DELETE FROM links")
    for note in notes:
        source_id = note.get("_id")
        if source_id is None:
            continue
        for norm, raw in note["targets"]:
            target_slug = alias_map.get(norm)
            target_id = slug_to_id.get(target_slug) if target_slug else None
            conn.execute(
                "INSERT INTO links(source_id, target_norm, target_id, raw) VALUES (?, ?, ?, ?)",
                (source_id, norm, target_id, raw),
            )


def main(argv=None):
    parser = argparse.ArgumentParser(description="Index the markdown vault into the local search database.")
    parser.add_argument("--vault", required=True, help="Path to the Brain vault root")
    parser.add_argument("--db", required=True, help="Path to the SQLite index database")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    index_vault(args.vault, args.db, verbose=not args.quiet)


if __name__ == "__main__":
    main()
