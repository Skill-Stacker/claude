#!/usr/bin/env bash
# Brain bootstrap for Linux. ONE self-contained script. Nothing else to download.
#
# Run it like this (no clone, no chmod, nothing to unpack):
#   curl -fsSL https://raw.githubusercontent.com/Skill-Stacker/claude/claude/brain-migration-google-drive-cbtnq6/brain/bootstrap-linux.sh -o ~/bootstrap-brain.sh
#   bash ~/bootstrap-brain.sh
#
# What it does, in order:
#   1. installs python3, rclone and fuse if they are missing
#   2. connects Google Drive (the one time you sign in)
#   3. mounts your Drive "Brain" vault at ~/BrainDrive and keeps it mounted
#   4. installs the brain-mcp and brain-index launchers plus a 30 minute timer
#   5. builds the search index once, right now
#   6. registers the Brain MCP server into Claude Desktop, Claude Code and Cursor
#
# Nothing is uploaded. The search database stays local at ~/Brain-index.
# Safe to run again any time; every step looks before it changes anything.
#
#   bash bootstrap-brain.sh            # do the setup
#   bash bootstrap-brain.sh --check    # just report what is wrong, change nothing
#
# Env overrides:  REMOTE=gdrive  MOUNT="$HOME/BrainDrive"  SUBPATH=Brain

# --- run under bash, even if invoked with sh/dash --------------------------
# (kept POSIX so `sh bootstrap-brain.sh` reaches this line before any bash-ism)
if [ -z "${BASH_VERSION:-}" ]; then
  if [ -f "$0" ] && command -v bash >/dev/null 2>&1; then exec bash "$0" "$@"; fi
  echo "Please run this with bash:  bash $0" >&2
  exit 1
fi

set -euo pipefail

REMOTE="${REMOTE:-gdrive}"
MOUNT="${MOUNT:-$HOME/BrainDrive}"
SUBPATH="${SUBPATH:-Brain}"
USER="${USER:-$(id -un)}"          # su and cron do not always set $USER
BIN="$HOME/.local/bin"
UNITS="$HOME/.config/systemd/user"
DB="$HOME/Brain-index/brain.db"
ENGINE="$MOUNT/engine"                    # the engine as shipped in the vault
LOCAL_ENGINE="$HOME/.local/share/brain-engine"   # the copy we actually run

STEP=0
say() { STEP=$((STEP + 1)); printf '\n=== %d/6  %s ===\n' "$STEP" "$1"; }
die() { echo; echo "STOPPED: $1" >&2; shift; for l in "$@"; do echo "  $l" >&2; done; exit 1; }

mounted() {
  if command -v mountpoint >/dev/null 2>&1; then mountpoint -q "$MOUNT"
  else grep -qs " ${MOUNT} " /proc/mounts; fi
}

# systemd user services need a session bus. Over plain ssh it is often not set
# up in the environment even though it exists, so try to point at it first.
systemd_user_ok() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1 && return 0
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
  systemctl --user show-environment >/dev/null 2>&1
}

fuser_bin() { command -v fusermount3 || command -v fusermount; }

# --- --check / --help ------------------------------------------------------
if [ "${1:-}" = "--check" ] || [ "${1:-}" = "-c" ]; then
  echo "Brain bootstrap check (nothing will be changed)"
  echo "  bash             : $BASH_VERSION"
  echo "  user             : $(id -un) (uid $(id -u))"
  echo "  home             : $HOME"
  printf '  python3          : '; command -v python3 || echo MISSING
  printf '  rclone           : '; command -v rclone || echo MISSING
  printf '  fuse             : '; fuser_bin || echo MISSING
  if systemd_user_ok; then echo "  systemd --user   : ok"
  else echo "  systemd --user   : NOT AVAILABLE (XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-unset})"; fi
  if command -v rclone >/dev/null 2>&1; then
    echo "  rclone remotes   : $(rclone listremotes 2>/dev/null | tr '\n' ' ')"
    if rclone listremotes 2>/dev/null | grep -qx "${REMOTE}:"; then
      if CHKERR="$(rclone lsd "${REMOTE}:" 2>&1 >/dev/null)"; then
        if rclone lsd "${REMOTE}:${SUBPATH}" >/dev/null 2>&1
        then echo "  ${REMOTE}:${SUBPATH}      : visible"
        else echo "  ${REMOTE}:${SUBPATH}      : folder not found (Drive itself is reachable)"; fi
      else
        echo "  ${REMOTE}: sign in      : BROKEN -> $CHKERR"
        echo "  fix              : run this script again, it will reconnect for you"
      fi
    fi
  fi
  echo "  mount            : $MOUNT $(mounted && echo '(mounted)' || echo '(not mounted)')"
  echo "  engine on mount  : $([ -f "$ENGINE/brainctl.py" ] && echo yes || echo no)"
  echo "  index database   : $([ -f "$DB" ] && echo yes || echo no)"
  echo "  launchers        : $([ -x "$BIN/brain-mcp" ] && echo yes || echo no)"
  echo "  local engine     : $([ -f "$LOCAL_ENGINE/brain_mcp.py" ] && echo "$LOCAL_ENGINE" || echo MISSING)"
  # Actually speak MCP to the server. This is what Claude Desktop does, so if it
  # fails here you get the real reason instead of "Server disconnected".
  if [ -x "$BIN/brain-mcp" ]; then
    MCPOUT="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' \
      | "$BIN/brain-mcp" 2>&1)" || true
    case "$MCPOUT" in
      *'"serverInfo"'*) echo "  MCP handshake    : ok" ;;
      '')              echo "  MCP handshake    : FAILED (server produced nothing and exited)" ;;
      *)               echo "  MCP handshake    : FAILED"
                       printf '%s\n' "$MCPOUT" | sed 's/^/      /' ;;
    esac
  fi
  exit 0
fi
case "${1:-}" in -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac

if [ "$(id -u)" -eq 0 ]; then
  die "Do not run this with sudo or as root." \
      "It installs into your own home and your own systemd session." \
      "Run it as yourself:  bash $0"
fi

# ---------------------------------------------------------------------------
say "Prerequisites (python3, rclone, fuse)"

FUSE_PKG="fuse3"
NEED=""
command -v python3 >/dev/null 2>&1 || NEED="$NEED python3"
command -v rclone  >/dev/null 2>&1 || NEED="$NEED rclone"
fuser_bin >/dev/null 2>&1 || NEED="$NEED $FUSE_PKG"

if [ -n "$NEED" ]; then
  echo "Missing:$NEED"
  echo "Installing (sudo will ask for your password) ..."
  # If an install fails, keep going: the explicit checks below report it clearly.
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y || true
    # older releases call it fuse, not fuse3
    sudo apt-get install -y $NEED || sudo apt-get install -y ${NEED/fuse3/fuse} || true
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y $NEED || sudo dnf install -y ${NEED/fuse3/fuse} || true
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm $NEED || sudo pacman -Sy --noconfirm ${NEED/fuse3/fuse} || true
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y $NEED || sudo zypper install -y ${NEED/fuse3/fuse} || true
  else
    echo "No apt/dnf/pacman/zypper here." >&2
    command -v rclone >/dev/null 2>&1 || { echo "Installing rclone from rclone.org ..."; curl -fsSL https://rclone.org/install.sh | sudo bash; }
  fi
fi

command -v python3 >/dev/null 2>&1 || die "python3 is still missing." "Install it, then run this again."
command -v rclone  >/dev/null 2>&1 || die "rclone is still missing." "Install it, then run this again." "  https://rclone.org/install/"
fuser_bin >/dev/null 2>&1 || die "fuse is still missing (no fusermount3 or fusermount)." \
  "Install the fuse3 package (or fuse on older releases), then run this again."
PY="$(command -v python3)"
echo "python3: $PY"
echo "rclone : $(command -v rclone)"
echo "fuse   : $(fuser_bin)"

if ! systemd_user_ok; then
  die "systemd user services are not reachable from this shell." \
      "That usually means you are on a text-only ssh session with no user bus." \
      "Fix it once, then run this again:" \
      "  sudo loginctl enable-linger $USER" \
      "  (or just run this from the desktop terminal on the machine itself)"
fi

# ---------------------------------------------------------------------------
say "Connect Google Drive (rclone remote '$REMOTE')"

create_remote() {
  echo "A browser will open so you can sign in to Google."
  echo "This is the one thing you have to do by hand. Everything after is automatic."
  echo
  rclone config create "$REMOTE" drive scope=drive \
    || rclone config create "$REMOTE" drive \
    || die "Could not create the rclone remote." \
           "No browser on this box? Run this on a machine that has one:" \
           "  rclone authorize \"drive\"" \
           "then copy the token here and run:  rclone config"
}

if rclone listremotes 2>/dev/null | grep -qx "${REMOTE}:"; then
  echo "Remote '${REMOTE}:' already exists. Checking that it still works ..."
else
  create_remote
  echo "Created rclone remote '${REMOTE}:'."
fi

# Does the remote actually answer? A sign in that was cancelled or that expired
# leaves a [gdrive] stanza with no usable token, and listremotes still reports
# it as present. Without this probe a dead token looks exactly like a missing
# folder, and the script would confidently blame the wrong thing.
# ERR="$(cmd 2>&1 >/dev/null)" captures stderr only and keeps rclone's status.
if ! ERR="$(rclone lsd "${REMOTE}:" 2>&1 >/dev/null)"; then
  case "$ERR" in
    *token*|*oauth*|*auth*|*401*|*invalid_grant*|*"config reconnect"*)
      echo "The Google sign in for '${REMOTE}:' never finished, or it has expired."
      echo "Opening the browser again to reconnect ..."
      # Keep a one-time copy of rclone.conf before repairing it.
      RCONF="$(rclone config file 2>/dev/null | tail -1)"
      if [ -f "$RCONF" ] && [ ! -f "$RCONF.before-brain-bootstrap" ]; then
        cp "$RCONF" "$RCONF.before-brain-bootstrap" 2>/dev/null || true
        echo "(saved a copy of your rclone config at $RCONF.before-brain-bootstrap)"
      fi
      rclone --auto-confirm config reconnect "${REMOTE}:" \
        || rclone config reconnect "${REMOTE}:" \
        || { rclone config delete "$REMOTE" && create_remote; } \
        || die "Could not reconnect '${REMOTE}:'." "rclone said:" "  $ERR"
      ERR="$(rclone lsd "${REMOTE}:" 2>&1 >/dev/null)" \
        || die "Still cannot reach Google Drive after signing in." "rclone said:" "  $ERR"
      ;;
    *)
      die "Could not reach Google Drive at all (this is not a folder name problem)." \
          "rclone said:" "  $ERR" \
          "Check the network, then run this again."
      ;;
  esac
fi

echo "Looking for ${REMOTE}:${SUBPATH} ..."
if ! ERR="$(rclone lsd "${REMOTE}:${SUBPATH}" 2>&1 >/dev/null)"; then
  echo "Could not see ${REMOTE}:${SUBPATH}. rclone said:" >&2
  echo "  $ERR" >&2
  echo "Top level of your Drive:" >&2
  rclone lsd "${REMOTE}:" 2>&1 | sed 's/^/    /' >&2 || true
  die "The folder '${SUBPATH}' is not at the root of that Drive." \
      "If your vault folder has another name or lives deeper, say so:" \
      "  SUBPATH='Some Folder/Brain' bash $0"
fi
echo "Found it."

# ---------------------------------------------------------------------------
say "Mount the vault at $MOUNT"

# An rclone mount that died without unmounting (crash, kill, a reboot with no
# linger, an earlier failed attempt) leaves $MOUNT as a stale FUSE endpoint.
# Every stat on it returns ENOTCONN, so even "mkdir -p" fails. Do NOT guard this
# with [ -e "$MOUNT" ]: test uses stat(), so -e is FALSE on a stale endpoint and
# the guard would never fire. Check /proc/mounts instead. Stopping the unit is
# not enough on its own: ExecStop does not run when the main process is gone.
systemctl --user stop brain-drive.service >/dev/null 2>&1 || true
if grep -qs " ${MOUNT} " /proc/mounts && ! ls "$MOUNT" >/dev/null 2>&1; then
  echo "Clearing a dead mount left behind at $MOUNT ..."
  "$(fuser_bin)" -uz "$MOUNT" 2>/dev/null || sudo umount -l "$MOUNT" 2>/dev/null || true
fi

mkdir -p "$MOUNT" 2>/dev/null || die "Cannot use $MOUNT." \
  "A dead mount is probably still stuck on it (Transport endpoint is not connected)." \
  "Clear it, then run this again:" \
  "  $(fuser_bin) -uz \"$MOUNT\"" \
  "  (or, if that will not do it:  sudo umount -l \"$MOUNT\")"

if ! mounted && [ -n "$(ls -A "$MOUNT" 2>/dev/null || true)" ]; then
  die "$MOUNT already has files in it and is not a mount." \
      "rclone will not mount over a non-empty folder." \
      "Move or delete what is in there, or pick another spot:" \
      "  MOUNT=\$HOME/Brain-drive bash $0"
fi

mkdir -p "$UNITS"
cat > "$UNITS/brain-drive.service" <<UNIT
[Unit]
Description=rclone mount of the Google Drive Brain vault
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=$(command -v rclone) mount "${REMOTE}:${SUBPATH}" "${MOUNT}" --vfs-cache-mode full --dir-cache-time 1m --poll-interval 15s --umask 022
ExecStop=/bin/sh -c 'fusermount3 -uz "${MOUNT}" 2>/dev/null || fusermount -uz "${MOUNT}"'
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
UNIT

# Failures here are reported by the wait loop below, with the service log.
systemctl --user daemon-reload || true
systemctl --user enable brain-drive.service >/dev/null 2>&1 || true
systemctl --user restart brain-drive.service || true

printf 'waiting for the mount '
i=0
while [ $i -lt 30 ] && ! mounted; do printf '.'; sleep 1; i=$((i + 1)); done
echo
if ! mounted; then
  echo "--- last 20 lines from the mount service ---" >&2
  systemctl --user status brain-drive.service --no-pager -n 20 2>&1 | sed 's/^/    /' >&2 || true
  die "The mount did not come up." \
      "Most common cause: the Google sign in did not finish, or fuse is blocked." \
      "See the log above, then try again."
fi
echo "Mounted: $MOUNT"

# The engine lives on the mount; give Drive a moment to list it.
i=0
while [ $i -lt 20 ] && [ ! -f "$ENGINE/brainctl.py" ]; do sleep 1; i=$((i + 1)); done
[ -f "$ENGINE/brainctl.py" ] \
  && echo "Engine found: $ENGINE" \
  || echo "note: $ENGINE/brainctl.py is not there yet. The rest still installs." >&2

# ---------------------------------------------------------------------------
say "Install the launchers and the 30 minute index timer"

mkdir -p "$BIN" "$LOCAL_ENGINE"

# Run the engine from LOCAL disk, not from the Drive mount. Claude Desktop and
# Cowork start their MCP servers when the app launches, which can easily be
# before the rclone mount is up. A server whose .py file lives on the mount just
# exits, and the client reports "Server disconnected / Connection closed".
# The engine is code, so a local copy is cheap; the vault stays the source of
# truth and is read through BRAIN_VAULT below.
if [ -f "$ENGINE/brain_mcp.py" ]; then
  cp "$ENGINE"/*.py "$ENGINE/schema.sql" "$LOCAL_ENGINE/" 2>/dev/null || true
  # The engine defaults its vault to the folder ABOVE itself, which is wrong for
  # a local copy, so pin vault_path and db_path in the local config. Rewritten
  # from the vault's own config so sections and ignore rules carry over.
  "$PY" - "$ENGINE/brain.config.json" "$LOCAL_ENGINE/brain.config.json" "$MOUNT" "$DB" <<'CFG'
import json, sys
src, dst, vault, db = sys.argv[1:5]
try:
    with open(src) as fh:
        cfg = json.load(fh)
except Exception:
    cfg = {}
cfg["vault_path"] = vault
cfg["db_path"] = db
with open(dst, "w") as fh:
    json.dump(cfg, fh, indent=2)
CFG
  echo "engine    : copied to $LOCAL_ENGINE (runs even when the mount is down)"
else
  echo "note: no engine on the mount yet, so $LOCAL_ENGINE may be stale or empty." >&2
fi

cat > "$BIN/brain-mcp" <<LAUNCH
#!/usr/bin/env bash
# Never depends on the Drive mount being up: the code is local and the search
# database is local. Only reading a note's full text needs the vault.
export PYTHONDONTWRITEBYTECODE=1
export BRAIN_VAULT="\${BRAIN_VAULT:-$MOUNT}"
export BRAIN_DB="\${BRAIN_DB:-$DB}"
exec "$PY" "$LOCAL_ENGINE/brain_mcp.py" "\$@"
LAUNCH
chmod +x "$BIN/brain-mcp"

cat > "$BIN/brain-index" <<LAUNCH
#!/usr/bin/env bash
export PYTHONDONTWRITEBYTECODE=1
export BRAIN_VAULT="\${BRAIN_VAULT:-$MOUNT}"
export BRAIN_DB="\${BRAIN_DB:-$DB}"
# Indexing genuinely needs the vault, so skip quietly when it is not mounted.
if command -v mountpoint >/dev/null 2>&1 && ! mountpoint -q "$MOUNT"; then
  echo "Brain vault not mounted at $MOUNT; skipping index." >&2
  exit 0
fi
exec "$PY" "$LOCAL_ENGINE/brainctl.py" index --quiet
LAUNCH
chmod +x "$BIN/brain-index"

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
systemctl --user enable --now brain-index.timer >/dev/null 2>&1 \
  || systemctl --user enable brain-index.timer || true
echo "launchers : $BIN/brain-mcp and $BIN/brain-index"
echo "timer     : brain-index.timer (every 30 minutes)"

# ---------------------------------------------------------------------------
say "Build the search index once, now"

if [ -f "$LOCAL_ENGINE/brainctl.py" ]; then
  "$BIN/brain-index" || echo "(that reported a problem; the timer retries every 30 minutes)"
  PYTHONDONTWRITEBYTECODE=1 BRAIN_DB="$DB" "$PY" "$LOCAL_ENGINE/brainctl.py" stats 2>/dev/null \
    || echo "(no stats yet; the timer will build it)"
else
  echo "Skipped: the engine is not on the mount yet."
fi

# ---------------------------------------------------------------------------
say "Register the Brain MCP server with your AI clients"

"$PY" - "$BIN/brain-mcp" <<'PY'
import json, os, sys
cmd = sys.argv[1]
home = os.path.expanduser("~")
entry = {"command": cmd}
targets = [
    os.path.join(home, ".config/Claude/claude_desktop_config.json"),  # Claude Desktop
    os.path.join(home, ".claude.json"),                               # Claude Code
    os.path.join(home, ".cursor/mcp.json"),                           # Cursor
]
for path in targets:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = {}
    if os.path.exists(path):
        try:
            with open(path) as fh:
                data = json.load(fh)
        except Exception:
            print("  %s: not valid JSON, left untouched" % path)
            continue
        # Back up ONCE, so re-running never overwrites the pristine original.
        if not os.path.exists(path + ".bak"):
            with open(path + ".bak", "w") as fh:
                json.dump(data, fh, indent=2)
    if not isinstance(data, dict):
        data = {}
    ms = data.get("mcpServers")
    if not isinstance(ms, dict):                   # ~/.claude.json can carry []
        ms = {}
    ms["brain"] = entry
    data["mcpServers"] = ms
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
    print("  registered brain -> %s" % path)
PY

# Keep the mount alive when you are not logged in (best effort).
if command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
  sudo -n loginctl enable-linger "$USER" 2>/dev/null \
    || echo "(optional) to keep the mount up when logged out: sudo loginctl enable-linger $USER"
fi

cat <<DONE

Done. The vault is mounted, indexed, refreshing every 30 minutes, and your AI
clients know about it. Restart Claude Desktop and Cursor to pick up the MCP
server (Claude Code and Hermes read it on next start).

Check it any time:
  bash $0 --check
  "$PY" "$ENGINE/brainctl.py" search "backups"
  systemctl --user list-timers | grep brain
DONE
