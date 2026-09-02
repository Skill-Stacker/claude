#!/usr/bin/env python3
"""Brain MCP server: the local brain search, exposed as tools any AI can call.

This is a Model Context Protocol (MCP) server over stdio. Register it in any MCP
client (Claude Code, Claude Desktop, Cursor, Hermes Agent, ...) and the assistant
gets first-class tools instead of having to know a shell command:

  brain_search    - find notes by keyword (optionally in a section wiki)
  brain_get       - read the full markdown of a note the search returned
  brain_sections  - list the section wikis (e.g. local-ai-master)
  brain_index     - rebuild the index from the vault

It reuses the same engine as brainctl.py, reads the vault read-only (except
brain_index, which only writes the derived database), and never makes a network
call. The vault files stay canonical.

Config comes from brain.config.json next to this file, same as brainctl. Two
environment variables override the defaults, which is handy when a client passes
env in its server config: BRAIN_VAULT (vault root) and BRAIN_DB (main database).

The protocol here is newline-delimited JSON-RPC 2.0: one JSON message per line in,
one per line out, logs to stderr. That is the standard MCP stdio transport, and
it is small enough to implement without any dependency.
"""

import json
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import brainctl
import brain_search

SERVER_NAME = "brain"
SERVER_VERSION = "1.0.0"
DEFAULT_PROTOCOL = "2024-11-05"

TOOLS = [
    {
        "name": "brain_search",
        "description": (
            "Search Josh's local brain vault (memory notes, sessions, ventures, "
            "machine notes, and more) by keyword. Returns matching notes with their "
            "vault-relative path. Use this to recall a fact before answering, and to "
            "check for an existing note before writing a new one. Read a full match "
            "with brain_get."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to search for"},
                "section": {"type": "string", "description": "Optional section wiki to search instead of the main brain, e.g. 'local-ai-master'"},
                "type": {"type": "string", "description": "Optional filter by note type (user, feedback, project, reference, session, ...)"},
                "tag": {"type": "string", "description": "Optional filter by tag"},
                "folder": {"type": "string", "description": "Optional filter by top-level folder"},
                "limit": {"type": "integer", "description": "Max results (default 10)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "brain_get",
        "description": (
            "Read the full markdown of a note by its vault-relative path (as returned "
            "by brain_search). The .md files are the source of truth."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Vault-relative path, e.g. 'Claude Memory/no-em-dashes.md'"},
                "section": {"type": "string", "description": "Optional section the path belongs to, e.g. 'local-ai-master'"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "brain_sections",
        "description": "List the configured section wikis. Each can be searched by passing its name as brain_search's 'section'.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "brain_index",
        "description": "Rebuild the search index from the vault (or a section). Run this after notes change so search is current. Writes only the derived database, never the notes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "section": {"type": "string", "description": "Optional section to rebuild instead of the main brain"},
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _db_for(config, section, section_name):
    if section_name:
        return brainctl.resolve_db(config, None, section, section_name)
    return os.environ.get("BRAIN_DB") or brainctl.resolve_db(config, None, None, None)


def _vault_for(config, section):
    override = os.environ.get("BRAIN_VAULT")
    return brainctl.resolve_vault(config, override, section)


def tool_brain_search(args):
    config = brainctl.load_config()
    section_name = args.get("section") or None
    section = brainctl.get_section(config, section_name)  # raises SystemExit if unknown
    db = _db_for(config, section, section_name)
    if not os.path.exists(db):
        return ("No index database yet at %s. Run brain_index (or "
                "`python brainctl.py index`) first." % db), False
    results = brain_search.search(
        db, args["query"], semantic=False, note_type=args.get("type"),
        tag=args.get("tag"), folder=args.get("folder"), limit=int(args.get("limit", 10)),
    )
    return brain_search.format_results(results, as_json=True), False


def tool_brain_get(args):
    config = brainctl.load_config()
    section = brainctl.get_section(config, args.get("section") or None)
    vault = os.path.abspath(_vault_for(config, section))
    target = os.path.abspath(os.path.join(vault, args["path"]))
    # Path containment: never read outside the vault (or section) root.
    if target != vault and not target.startswith(vault + os.sep):
        return "Refused: path is outside the vault.", True
    if not os.path.isfile(target):
        return "No file at %s" % args["path"], True
    with open(target, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read(), False


def tool_brain_sections(args):
    config = brainctl.load_config()
    secs = brainctl.all_sections(config)
    if not secs:
        return "No sections configured. The whole vault is the main brain.", False
    lines = []
    for name, s in secs.items():
        lines.append("%s -> %s" % (name, s.get("path", "")))
        if s.get("description"):
            lines.append("    %s" % s["description"])
    return "\n".join(lines), False


def tool_brain_index(args):
    import brain_index
    config = brainctl.load_config()
    section_name = args.get("section") or None
    section = brainctl.get_section(config, section_name)
    brain_index.index_vault.ignore_dirs = brainctl.resolve_ignore(config, section)
    vault = _vault_for(config, section)
    db = _db_for(config, section, section_name)
    n = brain_index.index_vault(vault, db, verbose=False)
    return "Indexed %d notes into %s (%s)." % (n, db, section_name or "main brain"), False


DISPATCH = {
    "brain_search": tool_brain_search,
    "brain_get": tool_brain_get,
    "brain_sections": tool_brain_sections,
    "brain_index": tool_brain_index,
}


# ---------------------------------------------------------------------------
# JSON-RPC / MCP plumbing
# ---------------------------------------------------------------------------

def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def reply(mid, result):
    send({"jsonrpc": "2.0", "id": mid, "result": result})


def reply_error(mid, code, message):
    send({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}})


def handle_tools_call(mid, params):
    name = params.get("name")
    args = params.get("arguments") or {}
    fn = DISPATCH.get(name)
    if fn is None:
        reply(mid, {"content": [{"type": "text", "text": "Unknown tool: %s" % name}], "isError": True})
        return
    try:
        text, is_error = fn(args)
    except SystemExit as e:
        text, is_error = str(e), True
    except Exception:
        text, is_error = "Error running %s:\n%s" % (name, traceback.format_exc()), True
    reply(mid, {"content": [{"type": "text", "text": text}], "isError": bool(is_error)})


def handle(msg):
    method = msg.get("method")
    mid = msg.get("id")
    params = msg.get("params") or {}

    if method == "initialize":
        requested = params.get("protocolVersion") or DEFAULT_PROTOCOL
        reply(mid, {
            "protocolVersion": requested,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
    elif method == "tools/list":
        reply(mid, {"tools": TOOLS})
    elif method == "tools/call":
        handle_tools_call(mid, params)
    elif method == "ping":
        reply(mid, {})
    elif method is not None and method.startswith("notifications/"):
        pass  # notifications get no response
    elif mid is not None:
        reply_error(mid, -32601, "Method not found: %s" % method)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        try:
            handle(msg)
        except Exception:
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()


if __name__ == "__main__":
    main()
