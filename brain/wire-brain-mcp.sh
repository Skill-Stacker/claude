#!/usr/bin/env bash
# Register the Brain MCP server into your MCP clients on this machine, by
# MERGING a "brain" entry into each config (existing settings are preserved and
# a .bak is written first). Handles:
#   ~/.config/Claude/claude_desktop_config.json   (Claude Desktop)
#   ~/.claude.json                                (Claude Code)
#   ~/.cursor/mcp.json                            (Cursor)
#
#   bash wire-brain-mcp.sh
#   bash wire-brain-mcp.sh /path/to/brain-mcp        # explicit launcher
#   bash wire-brain-mcp.sh /path/to/engine/brain_mcp.py
#
# It finds the server automatically if you ran setup-brain-services.sh (the
# brain-mcp launcher) or have the vault mounted at ~/BrainDrive.

set -euo pipefail

CMD=""; ARGS="[]"
if [ "${1:-}" != "" ]; then
  case "$1" in
    *.py) CMD="$(command -v python3)"; ARGS="[\"$1\"]" ;;
    *)    CMD="$1" ;;
  esac
elif [ -x "$HOME/.local/bin/brain-mcp" ]; then
  CMD="$HOME/.local/bin/brain-mcp"
else
  for e in "$HOME/BrainDrive/engine/brain_mcp.py" "$HOME/Brain/engine/brain_mcp.py"; do
    if [ -f "$e" ]; then CMD="$(command -v python3)"; ARGS="[\"$e\"]"; break; fi
  done
fi

if [ -z "$CMD" ]; then
  echo "Could not find the brain MCP server." >&2
  echo "Run setup-brain-services.sh first, or pass the path:" >&2
  echo "  bash wire-brain-mcp.sh ~/BrainDrive/engine/brain_mcp.py" >&2
  exit 1
fi
echo "Registering brain MCP server as: $CMD $([ "$ARGS" != "[]" ] && echo "$ARGS")"

python3 - "$CMD" "$ARGS" <<'PY'
import json, os, sys
cmd, args = sys.argv[1], json.loads(sys.argv[2])
home = os.path.expanduser("~")
entry = {"command": cmd}
if args:
    entry["args"] = args

targets = [
    os.path.join(home, ".config/Claude/claude_desktop_config.json"),
    os.path.join(home, ".claude.json"),
    os.path.join(home, ".cursor/mcp.json"),
]
for path in targets:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = {}
    if os.path.exists(path):
        try:
            with open(path) as fh:
                data = json.load(fh)
        except Exception:
            print(f"  {path}: existing file is not valid JSON, left untouched")
            continue
        with open(path + ".bak", "w") as fh:   # backup before touching it
            json.dump(data, fh, indent=2)
    if not isinstance(data, dict):
        data = {}
    ms = data.get("mcpServers")
    if not isinstance(ms, dict):   # ~/.claude.json can carry [] here
        ms = {}
    ms["brain"] = entry
    data["mcpServers"] = ms
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
    print(f"  wrote brain -> {path}")

print("Done. Restart Claude Desktop and Cursor; Claude Code picks it up on next start.")
PY
