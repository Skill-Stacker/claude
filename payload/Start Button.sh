#!/bin/bash
# ============================================================
#   STICKOS - Start Button (Linux)
#   One double-click, or one run from a terminal. First run gets
#   portable Node (35 to 50 MB, usually well under a minute), then
#   starts the app server, which downloads everything else with
#   progress shown in the browser, not in this window. Everything
#   stays on this USB; the app server is 127.0.0.1 only.
#
#   FIRST TIME on Linux: if double-clicking does nothing, this file
#   may be missing its executable bit. Right-click it and look for
#   an "Allow executing as program" option, or open a terminal here
#   and run once:  chmod +x "Start Button.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Closing this window should stop the whole tree, including
# anything still starting up in the background waiter below.
trap 'kill -- -$$ >/dev/null 2>&1 || true' EXIT

# ---- Node version pinned in app/manifest.json. build-installer
# ---- keeps the version and URL below in sync with that file; do
# ---- not point this at a floating tag. ----
NODE_VERSION="24.20.0"
NODE_TARNAME="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARNAME}"
NODE_SHASUMS="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

export STICKOS_HOME="$ROOT"
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

# Preflight: some managed laptops block software from running off
# a USB stick on purpose. Find that out now, in plain words,
# instead of failing partway through a download later.
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
    stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null || echo 0
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
  actual="$(sha256sum "$file" 2>/dev/null | awk '{print $1}' || true)"
  [ -n "$actual" ] || return 1
  [ "$actual" = "$expected" ]
}

# ================= 1) NODE (portable runtime) =================
RUNTIME="$ROOT/bin/node/bin/node"
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
      rm -rf "$ROOT/bin/node"
      mv "$EXTRACTED" "$ROOT/bin/node"
      chmod +x "$ROOT/bin/node/bin/node" 2>/dev/null || true
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
  echo ""
  read -r -p "   Press Enter to close..." _
  exit 1
fi

# ================= 2) APP (server + web UI) =================
# Pulls "app_version" out of settings.json with grep and sed, no
# JSON parser needed: settings.json writes one key per line with
# a plain quoted string value, and build-installer must keep that
# shape when it updates app_version.
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
  APPURL="https://github.com/Skill-Stacker/claude/releases/download/v${APP_VERSION}/stickos-app-${APP_VERSION}-linux-x64.zip"
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
  local port="$1" sc="$ROOT/Open Assistant.desktop"
  {
    printf '[Desktop Entry]\n'
    printf 'Type=Application\n'
    printf 'Name=Open Assistant\n'
    printf 'Exec=xdg-open http://127.0.0.1:%s/\n' "$port"
    printf 'Terminal=false\n'
  } > "$sc"
  chmod +x "$sc" 2>/dev/null || true
}

launch_browser() {
  local port="$1" bin
  for bin in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge microsoft-edge-stable; do
    if command -v "$bin" >/dev/null 2>&1; then
      "$bin" "--app=http://127.0.0.1:$port/" "--user-data-dir=$ROOT/cache/browser" >/dev/null 2>&1 &
      return 0
    fi
  done
  xdg-open "http://127.0.0.1:$port/" >/dev/null 2>&1 || true
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
echo "   folder, or open the address this window prints."
echo "   (To stop: close this window, or press Ctrl+C.)"
echo ""

set +e
"$RUNTIME" "$ROOT/app/server.js"
STATUS=$?
set -e

if [ "$STATUS" -ne 0 ]; then
  echo ""
  echo "   !! StickOS stopped with an error."
  echo "      Run Start Button again; anything that was removed is"
  echo "      fetched again automatically."
  echo ""
  read -r -p "   Press Enter to close..." _
  exit 1
fi

echo ""
echo "   StickOS stopped. Everything stayed on the USB. See you next time!"
exit 0
