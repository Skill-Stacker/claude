#!/usr/bin/env bash
# One command to set up the Brain on this Linux box (like the SER8).
#
# It folds the four smaller scripts into one, so there is a single thing to run
# instead of a list of manual steps:
#   1. make sure rclone and fuse are installed
#   2. connect Google Drive (the one time you sign in)
#   3. mount your Drive "Brain" vault at ~/BrainDrive (survives reboots)
#   4. install the brain-mcp and brain-index launchers and the 30 minute timer
#   5. build the search index once, right now
#   6. register the Brain MCP server into Claude Desktop, Claude Code, and Cursor
#
#   cd <repo>/brain && bash bootstrap-linux.sh
#
# The only thing you type is one Google sign in (rclone needs it, once). After
# that it is hands off. Nothing is uploaded; the search database stays local at
# ~/Brain-index. Run it again any time; every step is safe to repeat.
#
# Override the defaults with env vars if you must:
#   REMOTE=gdrive  MOUNT="$HOME/BrainDrive"  bash bootstrap-linux.sh
#
# Want a local vault with no Google Drive instead? Use setup-brain.sh.

set -euo pipefail

case "${1:-}" in
  -h|--help)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
esac

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER="${USER:-$(id -un)}"   # some shells (su, cron) do not set $USER
REMOTE="${REMOTE:-gdrive}"
MOUNT="${MOUNT:-$HOME/BrainDrive}"

STEP=0
say() { STEP=$((STEP + 1)); printf '\n=== %d/6  %s ===\n' "$STEP" "$1"; }

need_script() {
  # A sibling script this bootstrap orchestrates; fail clearly if it is missing.
  if [ ! -f "$SRC/$1" ]; then
    echo "Cannot find $1 next to this script (looked in $SRC)." >&2
    echo "Run bootstrap-linux.sh from the repo's brain/ folder (clone the repo first)." >&2
    exit 1
  fi
}
need_script mount-brain-drive.sh
need_script setup-brain-services.sh
need_script wire-brain-mcp.sh

# ---------------------------------------------------------------------------
say "Prerequisites (python3, rclone, fuse)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is not installed. On Ubuntu: sudo apt install python3" >&2
  exit 1
fi
echo "python3: $(command -v python3)"

need_pkgs=()
command -v rclone >/dev/null 2>&1 || need_pkgs+=(rclone)
if ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; then
  need_pkgs+=(fuse3)
fi

if [ ${#need_pkgs[@]} -gt 0 ]; then
  echo "Installing: ${need_pkgs[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y && sudo apt-get install -y "${need_pkgs[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y "${need_pkgs[@]}"
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm "${need_pkgs[@]}"
  else
    # No known package manager. rclone can still self install; fuse cannot here.
    if command -v rclone >/dev/null 2>&1; then :; else
      echo "Installing rclone from rclone.org ..."
      curl -fsSL https://rclone.org/install.sh | sudo bash
    fi
    if ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; then
      echo "Could not install fuse automatically. Install 'fuse3' with your package manager, then re-run." >&2
      exit 1
    fi
  fi
else
  echo "rclone and fuse are already present."
fi
echo "rclone: $(command -v rclone)"

# ---------------------------------------------------------------------------
say "Connect Google Drive (rclone remote '$REMOTE')"

if rclone listremotes 2>/dev/null | grep -qx "${REMOTE}:"; then
  echo "Remote '${REMOTE}:' already exists; leaving it as is."
else
  echo "A browser window will open for you to sign in to Google. This is the"
  echo "one manual step; everything after it is automatic."
  echo "(No browser on this box? Cancel, run 'rclone authorize \"drive\"' on a"
  echo " machine that has one, then paste the token: 'rclone config create $REMOTE drive'.)"
  echo
  rclone config create "$REMOTE" drive scope=drive
  echo "Created rclone remote '${REMOTE}:'."
fi

# ---------------------------------------------------------------------------
say "Mount the Drive Brain vault at $MOUNT"
bash "$SRC/mount-brain-drive.sh" "$REMOTE" "$MOUNT"

# ---------------------------------------------------------------------------
say "Install the launchers and the 30 minute index timer"
bash "$SRC/setup-brain-services.sh" "$MOUNT"

# ---------------------------------------------------------------------------
say "Build the search index once, now"
INDEXER="$HOME/.local/bin/brain-index"
if [ -x "$INDEXER" ]; then
  "$INDEXER" || echo "(index run reported a problem; the timer will retry every 30 min)"
else
  echo "brain-index launcher missing; skipping the first build (the timer still runs)."
fi
if [ -f "$MOUNT/engine/brainctl.py" ]; then
  PYTHONDONTWRITEBYTECODE=1 python3 "$MOUNT/engine/brainctl.py" stats 2>/dev/null \
    || echo "(index is still filling in; give the mount a moment, it reindexes every 30 min)"
fi

# ---------------------------------------------------------------------------
say "Register the Brain MCP server into your AI clients"
bash "$SRC/wire-brain-mcp.sh"

# Keep the mount alive when you are logged out (best effort, needs sudo once).
if command -v loginctl >/dev/null 2>&1; then
  sudo loginctl enable-linger "$USER" 2>/dev/null \
    || echo "(optional) to keep the mount up when logged out: sudo loginctl enable-linger $USER"
fi

cat <<DONE

All set. The Brain is mounted, indexed, on a 30 minute refresh, and registered
with your AI clients. Restart Claude Desktop and Cursor to pick up the MCP
server (Claude Code and Hermes read it on next start).

Prove it by hand any time:
  python3 "$MOUNT/engine/brainctl.py" search "backups"
  systemctl --user list-timers | grep brain
DONE
