#!/usr/bin/env bash
# Mount the Google Drive "Brain" vault on this Linux box with rclone, as a
# systemd USER service so it survives reboots.
#
# Run this AFTER you have created an rclone remote named "gdrive" pointing at
# your Google account (see the numbered steps: `rclone config`).
#
#   bash mount-brain-drive.sh                       # mounts gdrive:Brain at ~/BrainDrive
#   bash mount-brain-drive.sh gdrive ~/BrainDrive   # explicit remote + mountpoint
#
# The database still lives OUTSIDE the mount (~/Brain-index), so Drive never
# syncs a binary. Nothing here uploads anything; it only mounts.

set -euo pipefail

USER="${USER:-$(id -un)}"   # some shells (su, cron) do not set $USER
REMOTE="${1:-gdrive}"
MOUNT="${2:-$HOME/BrainDrive}"
SUBPATH="Brain"

command -v rclone >/dev/null || { echo "rclone is not installed. Do step 1 first." >&2; exit 1; }
RCLONE="$(command -v rclone)"

if ! rclone listremotes | grep -qx "${REMOTE}:"; then
  echo "No rclone remote named '${REMOTE}'. Run 'rclone config' first (step 2)." >&2
  echo "Remotes found: $(rclone listremotes | tr '\n' ' ')" >&2
  exit 1
fi

echo "Checking the remote can see the vault (${REMOTE}:${SUBPATH}) ..."
rclone lsd "${REMOTE}:${SUBPATH}" >/dev/null || {
  echo "Cannot list ${REMOTE}:${SUBPATH}. Is the Brain folder at your Drive root?" >&2
  exit 1
}

mkdir -p "$MOUNT"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/brain-drive.service" <<UNIT
[Unit]
Description=rclone mount of the Google Drive Brain vault
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=${RCLONE} mount ${REMOTE}:${SUBPATH} ${MOUNT} --vfs-cache-mode full --dir-cache-time 1m --poll-interval 15s --umask 022
ExecStop=/bin/sh -c 'fusermount3 -uz ${MOUNT} 2>/dev/null || fusermount -uz ${MOUNT}'
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
UNIT

echo "Wrote $UNIT_DIR/brain-drive.service"
systemctl --user daemon-reload
systemctl --user enable --now brain-drive.service
sleep 3

if command -v mountpoint >/dev/null && mountpoint -q "$MOUNT"; then
  echo "Mounted: $MOUNT"
  ls "$MOUNT" | head
else
  echo "Mount did not come up yet. Check: systemctl --user status brain-drive.service" >&2
  exit 1
fi

cat <<NEXT

So it stays mounted without you logged in (run once):
  sudo loginctl enable-linger $USER

Now index your REAL notes (engine and notes both live on the mount):
  cd "$MOUNT"
  PYTHONDONTWRITEBYTECODE=1 python3 engine/brainctl.py index
  python3 engine/brainctl.py search "backups"

To unmount / stop:  systemctl --user disable --now brain-drive.service
NEXT
