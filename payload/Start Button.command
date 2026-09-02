#!/bin/bash
# ============================================================
#   STICKOS - Start Button (macOS)
#   One double-click. First run gets portable Node (35 to 50 MB,
#   usually well under a minute), then starts the app server,
#   which downloads everything else with progress shown in the
#   browser, not in this window. Everything stays on this USB;
#   the app server is 127.0.0.1 only.
#
#   FIRST TIME on a Mac: if double-clicking opens this in a text
#   editor instead of running it, do ONE of these once:
#     * right-click this file in Finder, choose Open, OR
#     * open Terminal and run:  chmod +x "Start Button.command"
#   (macOS strips the runnable flag from files copied off the web.)
#
#   NOTE FOR EDITORS: nothing executes off an exFAT USB stick on
#   macOS. Every real executable (Node now, later the AI engine
#   and anything else the app places under bin/) gets copied to a
#   real folder on this Mac first, at Library/Application Support
#   under the real home folder. RUNTIME below always points there,
#   never at a path under ROOT.
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Closing this window should stop the whole tree, including
# anything still starting up in the background waiter below.
trap 'kill -- -$$ >/dev/null 2>&1 || true' EXIT

# ---- Node version pinned in app/manifest.json. build-installer
# ---- keeps the version and both URLs below in sync with that
# ---- file; do not point this at a floating tag. manifest.json
# ---- only names darwin-arm64, but nodejs.org publishes the
# ---- darwin-x64 build at the same path with x64 swapped in, so
# ---- the Intel URL is derived here the same way. ----
NODE_VERSION="24.20.0"
NODE_SHASUMS="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  NODE_PLATFORM="darwin-arm64"
else
  NODE_PLATFORM="darwin-x64"
fi
NODE_TARNAME="node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARNAME}"

# Remember the real home before HOME gets redirected onto the
# stick, so the exec cache lands in this Mac's actual profile
# and not somewhere on the USB stick that cannot run programs.
HOME_REAL="$HOME"
EXEC_CACHE="$HOME_REAL/Library/Application Support/StickOS/bin"
mkdir -p "$EXEC_CACHE" 2>/dev/null || true

export STICKOS_HOME="$ROOT"
export STICKOS_EXEC_CACHE="$EXEC_CACHE"
export HOME="$ROOT"
export TMPDIR="$ROOT/tmp"
export XDG_CACHE_HOME="$ROOT/cache"
export HF_HOME="$ROOT/voices/hf-cache"

mkdir -p "$ROOT/tmp" "$ROOT/cache" "$ROOT/bin" "$ROOT/models" "$ROOT/voices" \
         "$ROOT/data" "$ROOT/state" "$ROOT/chats" "$ROOT/sessions" "$ROOT/app" 2>/dev/null || true

clear
echo ""
echo "   ================================================"
echo "       S T I C K O S      *  Start Button  *"
echo "       your private assistant, running from this USB"
echo "   ================================================"
echo ""

# macOS Gatekeeper shows a different fix depending on the OS
# version; work out which one applies once, up front.
gatekeeper_hint() {
  local ver major
  ver="$(sw_vers -productVersion 2>/dev/null || echo "0")"
  major="${ver%%.*}"
  case "$major" in
    ''|*[!0-9]*) major=0 ;;
  esac
  if [ "$major" -ge 15 ]; then
    echo "      If macOS blocked it: open System Settings, then Privacy"
    echo "      and Security, then choose Open Anyway."
  else
    echo "      If macOS blocked it: right-click the file and choose Open."
  fi
}

# Preflight: some workplace laptops, and some locked-down Macs,
# block software from running off a USB stick on purpose. Find
# that out now, in plain words, instead of failing partway
# through a download later.
if ! ( : > "$ROOT/state/write-test.txt" ) 2>/dev/null; then
  echo "   !! This folder cannot be written to."
  echo "      StickOS needs a personal, unmanaged computer to run from a"
  echo "      USB stick. Many workplace laptops block software on USB"
  echo "      sticks on purpose, and there is no way around that from"
  echo "      here. Try a personal computer instead."
  echo ""
  read -r -p "   Press Enter to close..." _
  exit 1
fi
rm -f "$ROOT/state/write-test.txt"

fsize() {
  if [ -f "$1" ]; then
    stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

# download $1 -> $2, then delete it if it came back smaller than $3 bytes
fetch() {
  local url="$1" out="$2" min="$3"
  if [ -f "$out" ] && [ "$(fsize "$out")" -lt "$min" ]; then rm -f "$out"; fi
  if [ ! -f "$out" ]; then
    curl -L -C - --fail --retry 3 --retry-delay 2 --progress-bar -o "$out" "$url" || true
  fi
  if [ -f "$out" ] && [ "$(fsize "$out")" -lt "$min" ]; then rm -f "$out"; fi
}

# $1 = file to verify  $2 = SHASUMS256.txt path  $3 = filename to look up
sha_ok() {
  local file="$1" list="$2" name="$3" expected actual
  [ -f "$file" ] || return 1
  [ -f "$list" ] || return 1
  expected="$(grep "$name" "$list" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
  [ -n "$expected" ] || return 1
  actual="$(shasum -a 256 "$file" 2>/dev/null | awk '{print $1}' || true)"
  [ -n "$actual" ] || return 1
  [ "$actual" = "$expected" ]
}

# ================= 1) NODE (portable runtime) =================
RUNTIME="$EXEC_CACHE/node"
if [ ! -x "$RUNTIME" ]; then
  echo "   [1/3] First-time setup: getting the Node runtime (35 to 50 MB,"
  echo "         usually well under a minute) ..."
  rm -rf "$ROOT/bin/node-tmp"
  mkdir -p "$ROOT/bin/node-tmp" || true
  fetch "$NODE_URL" "$ROOT/bin/node-tmp/$NODE_TARNAME" 20000000
  fetch "$NODE_SHASUMS" "$ROOT/bin/node-tmp/SHASUMS256.txt" 0
  if [ -f "$ROOT/bin/node-tmp/$NODE_TARNAME" ] && sha_ok "$ROOT/bin/node-tmp/$NODE_TARNAME" "$ROOT/bin/node-tmp/SHASUMS256.txt" "$NODE_TARNAME"; then
    tar -xf "$ROOT/bin/node-tmp/$NODE_TARNAME" -C "$ROOT/bin/node-tmp" || true
    EXTRACTED="$(find "$ROOT/bin/node-tmp" -maxdepth 1 -type d -name 'node-v*' 2>/dev/null | head -n1 || true)"
    if [ -n "$EXTRACTED" ] && [ -f "$EXTRACTED/bin/node" ]; then
      cp "$EXTRACTED/bin/node" "$RUNTIME"
      chmod +x "$RUNTIME" 2>/dev/null || true
      xattr -d com.apple.quarantine "$RUNTIME" 2>/dev/null || true
    fi
  else
    echo "   !! The Node download did not match its checksum. Removing it"
    echo "      so the next run tries again."
    rm -f "$ROOT/bin/node-tmp/$NODE_TARNAME"
  fi
  rm -rf "$ROOT/bin/node-tmp"
fi
if [ -x "$RUNTIME" ]; then
  echo "   [1/3] Node runtime .... ready"
else
  echo ""
  echo "   !! Could not get the Node runtime automatically."
  echo "      Check your internet connection and run Start Button again."
  gatekeeper_hint
  echo ""
  read -r -p "   Press Enter to close..." _
  exit 1
fi

# ================= 2) APP (server + web UI) =================
# Pulls "app_version" out of settings.json with grep and sed, no
# JSON parser needed: settings.json writes one key per line with
# a plain quoted string value, and build-installer must keep
# that shape when it updates app_version.
read_app_version() {
  grep '"app_version"' "$ROOT/settings.json" 2>/dev/null | head -n1 \
    | sed -E 's/.*"app_version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || true
}

if [ ! -f "$ROOT/app/server.js" ]; then
  APP_VERSION="$(read_app_version)"
  if [ -z "$APP_VERSION" ]; then
    echo ""
    echo "   !! Could not read app_version out of settings.json."
    echo ""
    read -r -p "   Press Enter to close..." _
    exit 1
  fi
  echo "   [2/3] First-time setup: getting the StickOS app (version $APP_VERSION) ..."
  # The app zip is only published for darwin-arm64 right now; an
  # Intel build would need its own release before this line could
  # follow the same arch switch used for Node above.
  APPURL="https://github.com/Skill-Stacker/claude/releases/download/v${APP_VERSION}/stickos-app-${APP_VERSION}-darwin-arm64.zip"
  rm -rf "$ROOT/app-tmp"
  mkdir -p "$ROOT/app-tmp" || true
  fetch "$APPURL" "$ROOT/app-tmp/app.zip" 5000000
  if [ -f "$ROOT/app-tmp/app.zip" ]; then
    tar -xf "$ROOT/app-tmp/app.zip" -C "$ROOT/app-tmp" || true
  fi
  if [ -d "$ROOT/app-tmp/app" ]; then
    rm -rf "$ROOT/app"
    mv "$ROOT/app-tmp/app" "$ROOT/app"
  fi
  rm -rf "$ROOT/app-tmp"
fi
if [ -f "$ROOT/app/server.js" ]; then
  echo "   [2/3] StickOS app ..... ready"
else
  echo ""
  echo "   !! Could not download or unpack the StickOS app."
  echo "      Check your internet connection and run Start Button again."
  echo ""
  read -r -p "   Press Enter to close..." _
  exit 1
fi

# ================= 3) LAUNCH =================
# A stale port.txt from an earlier run would make the background
# waiter below open an old, no-longer-listening port, so clear it
# before the server has a chance to write a fresh one.
rm -f "$ROOT/state/port.txt"

write_shortcut() {
  # A .command and not a .webloc on purpose: a webloc is an XML
  # plist, and the installer page that carries this file is served
  # as PHP, which eats an XML declaration and takes the page down
  # with it.
  local port="$1" sc="$ROOT/Open Assistant.command"
  {
    printf '#!/bin/bash\n'
    printf 'open "http://127.0.0.1:%s/" 2>/dev/null || xdg-open "http://127.0.0.1:%s/" 2>/dev/null\n' "$port" "$port"
  } > "$sc"
  chmod +x "$sc" 2>/dev/null || true
}

launch_browser() {
  local port="$1"
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -a "Google Chrome" --args --app="http://127.0.0.1:$port/" --user-data-dir="$ROOT/cache/browser" >/dev/null 2>&1 && return 0
  fi
  if [ -d "/Applications/Microsoft Edge.app" ]; then
    open -a "Microsoft Edge" --args --app="http://127.0.0.1:$port/" --user-data-dir="$ROOT/cache/browser" >/dev/null 2>&1 && return 0
  fi
  echo "   Scout is opening in Safari, so a couple of things look slightly different."
  open "http://127.0.0.1:$port/" >/dev/null 2>&1 || true
}

(
  n=0
  while [ "$n" -lt 600 ] && [ ! -f "$ROOT/state/port.txt" ]; do
    n=$((n + 1))
    sleep 1
  done
  if [ -f "$ROOT/state/port.txt" ]; then
    PORT_FOUND="$(cat "$ROOT/state/port.txt" 2>/dev/null || true)"
    if [ -n "$PORT_FOUND" ]; then
      write_shortcut "$PORT_FOUND"
      launch_browser "$PORT_FOUND"
    fi
  fi
) &

echo "   [3/3] Starting Scout ..."
echo "   Your browser will open in a moment, once the app server is"
echo "   ready. If it doesn't, double-click \"Open Assistant\" in this"
echo "   folder. (To stop: close this window, or press Ctrl+C.)"
echo ""

set +e
"$RUNTIME" "$ROOT/app/server.js"
STATUS=$?
set -e

if [ "$STATUS" -ne 0 ]; then
  echo ""
  echo "   !! StickOS stopped with an error."
  echo "      Security software may have quietly removed a downloaded"
  echo "      file; run Start Button again and it will be fetched again"
  echo "      automatically."
  gatekeeper_hint
  echo ""
  read -r -p "   Press Enter to close..." _
  exit 1
fi

echo ""
echo "   StickOS stopped. Everything stayed on the USB. See you next time!"
exit 0
