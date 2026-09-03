#!/usr/bin/env bash
# Create a Brain vault + engine on this machine (Linux or macOS).
#
# Run it from inside the repo's brain/ folder:
#   cd <repo>/brain && bash setup-brain.sh
#
# Optional first argument is where to create the vault (default: ~/Brain):
#   bash setup-brain.sh /data/Brain
#
# It creates the vault skeleton and copies the engine (Python + schema +
# config) plus the docs and skills. Your actual notes are not here yet; this
# just makes the directory so the tools run. See the note it prints at the end.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$HOME/Brain}"

if [ ! -f "$SRC/engine/brainctl.py" ]; then
  echo "Cannot find the engine next to this script (looked in $SRC/engine)." >&2
  echo "Run this from the repo's brain/ folder, or clone the repo first:" >&2
  echo "  git clone https://github.com/Skill-Stacker/claude" >&2
  echo "  cd claude/brain && bash setup-brain.sh" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is not installed. On Ubuntu: sudo apt install python3" >&2
  exit 1
fi

echo "Creating Brain vault at: $DEST"
mkdir -p \
  "$DEST/engine" \
  "$DEST/Claude Memory" \
  "$DEST/Sessions" \
  "$DEST/Ventures" \
  "$DEST/Inbox" \
  "$DEST/Outbox" \
  "$DEST/Workbench" \
  "$DEST/Writing" \
  "$DEST/Attachments"

cp "$SRC/engine/"*.py "$SRC/engine/schema.sql" "$SRC/engine/brain.config.json" "$DEST/engine/"
cp -R "$SRC/docs" "$DEST/docs"
cp -R "$SRC/skills" "$DEST/skills"
[ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$DEST/README.md"

echo
echo "Done. The engine is at $DEST/engine"
echo
echo "Try it:"
echo "  cd \"$DEST\""
echo "  python3 engine/brainctl.py index"
echo "  python3 engine/brainctl.py search \"index\""
echo
echo "Note: this vault is empty except the docs. Your real notes still live on"
echo "the Windows side (G:\\My Drive\\Brain). Copy or sync them into $DEST and"
echo "re-run index, or ask Claude to set up an rclone Google Drive mount."
