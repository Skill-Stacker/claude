#!/usr/bin/env bash
# Install two things on this Linux box:
#   1. a systemd USER timer that refreshes the Brain index every 30 minutes
#   2. a `brain-mcp` launcher on PATH, so any MCP client (Hermes, Claude
#      Desktop, Cursor) registers the server with a single stable command
#
# Run it after the Drive mount is set up (mount-brain-drive.sh). Pass the mount
# path if you used a non-default one:
#   bash setup-brain-services.sh                 # assumes ~/BrainDrive
#   bash setup-brain-services.sh /data/BrainDrive
#
# It writes nothing to the vault and uploads nothing; the index database stays
# local at ~/Brain-index.

set -euo pipefail

MOUNT="${1:-$HOME/BrainDrive}"
ENGINE="$MOUNT/engine"
PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "python3 not found. sudo apt install python3" >&2; exit 1; }

[ -f "$ENGINE/brain_mcp.py" ] || echo "note: $ENGINE not present yet (mount not up?). Installing anyway; it will work once the mount is live." >&2

BIN="$HOME/.local/bin"
UNITS="$HOME/.config/systemd/user"
mkdir -p "$BIN" "$UNITS"

# --- launcher: brain-mcp (the MCP server) ---
cat > "$BIN/brain-mcp" <<LAUNCH
#!/usr/bin/env bash
export PYTHONDONTWRITEBYTECODE=1
exec "$PY" "$ENGINE/brain_mcp.py" "\$@"
LAUNCH
chmod +x "$BIN/brain-mcp"

# --- launcher: brain-index (used by the timer, and handy by hand) ---
cat > "$BIN/brain-index" <<LAUNCH
#!/usr/bin/env bash
export PYTHONDONTWRITEBYTECODE=1
if command -v mountpoint >/dev/null 2>&1 && ! mountpoint -q "$MOUNT"; then
  echo "Brain vault not mounted at $MOUNT; skipping index." >&2
  exit 0
fi
exec "$PY" "$ENGINE/brainctl.py" index --quiet
LAUNCH
chmod +x "$BIN/brain-index"

# --- timer: refresh the index every 30 minutes ---
cat > "$UNITS/brain-index.service" <<UNIT
[Unit]
Description=Refresh the Brain search index
After=brain-drive.service

[Service]
Type=oneshot
ExecStart=$BIN/brain-index
UNIT

cat > "$UNITS/brain-index.timer" <<UNIT
[Unit]
Description=Refresh the Brain search index every 30 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=30min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now brain-index.timer

echo
echo "Installed:"
echo "  timer     : brain-index.timer (every 30 min)  ->  systemctl --user list-timers"
echo "  launchers : $BIN/brain-mcp  and  $BIN/brain-index"
echo
echo "Register the MCP server with any client using this command:"
echo "  $BIN/brain-mcp"
echo
echo "For example, the standard mcpServers block (Hermes, Claude Desktop, Cursor):"
cat <<JSON
  { "mcpServers": { "brain": { "command": "$BIN/brain-mcp" } } }
JSON
echo
echo "Run one now to prove it:  brain-index && python3 \"$ENGINE/brainctl.py\" stats"
