#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This smoke script only runs on macOS."
  exit 1
fi

DMG_PATH="${1:-${DMG_PATH:-}}"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
WAIT_SECONDS="${WAIT_SECONDS:-30}"
MOUNT_POINT=""
INSTALLED_APP_PATH=""

log() {
  printf '[smoke] %s\n' "$*"
}

warn() {
  printf '[smoke][warn] %s\n' "$*" >&2
}

cleanup() {
  if [[ -n "${INSTALLED_APP_PATH:-}" ]]; then
    local bin_name="${INSTALLED_APP_PATH##*/}"
    bin_name="${bin_name%.app}"
    osascript -e "tell application \"${bin_name}\" to quit" >/dev/null 2>&1 || true
    pkill -f "${INSTALLED_APP_PATH}/Contents/MacOS" >/dev/null 2>&1 || true
  fi
  if [[ -n "${MOUNT_POINT:-}" ]] && mount | awk '{print $3}' | grep -Fxq "$MOUNT_POINT"; then
    hdiutil detach "$MOUNT_POINT" -quiet || true
  fi
}
trap cleanup EXIT

find_latest_dmg() {
  local found
  found="$(
    find desktop/src-tauri/target -type f -name '*.dmg' -print 2>/dev/null \
      | sort \
      | tail -n 1
  )"
  printf '%s' "$found"
}

if [[ -z "$DMG_PATH" ]]; then
  DMG_PATH="$(find_latest_dmg)"
fi

if [[ -z "$DMG_PATH" || ! -f "$DMG_PATH" ]]; then
  echo "No DMG found. Pass one explicitly: scripts/macos_clean_machine_smoke.sh /path/to/Brood.dmg"
  exit 1
fi

log "Using DMG: $DMG_PATH"
attach_out="$(hdiutil attach "$DMG_PATH" -nobrowse -readonly)"
MOUNT_POINT="$(printf '%s\n' "$attach_out" | awk '/\/Volumes\// {print $NF}' | tail -n 1)"
if [[ -z "$MOUNT_POINT" || ! -d "$MOUNT_POINT" ]]; then
  echo "Failed to determine mounted DMG volume."
  exit 1
fi
log "Mounted at: $MOUNT_POINT"

SOURCE_APP_PATH="$(
  find "$MOUNT_POINT" -maxdepth 2 -type d -name '*.app' -print \
    | head -n 1
)"
if [[ -z "$SOURCE_APP_PATH" ]]; then
  echo "No .app bundle found in mounted DMG."
  exit 1
fi
APP_BUNDLE_NAME="$(basename "$SOURCE_APP_PATH")"

if [[ ! -d "$INSTALL_DIR" ]]; then
  mkdir -p "$INSTALL_DIR" 2>/dev/null || true
fi
if [[ ! -w "$INSTALL_DIR" ]]; then
  INSTALL_DIR="$HOME/Applications"
  mkdir -p "$INSTALL_DIR"
fi

INSTALLED_APP_PATH="$INSTALL_DIR/$APP_BUNDLE_NAME"
log "Installing app bundle to: $INSTALLED_APP_PATH"
rm -rf "$INSTALLED_APP_PATH"
cp -R "$SOURCE_APP_PATH" "$INSTALLED_APP_PATH"

log "Running quick integrity checks (best-effort)"
codesign --verify --deep --strict --verbose=2 "$INSTALLED_APP_PATH" >/dev/null 2>&1 || warn "codesign verify failed"
spctl --assess --type execute -vv "$INSTALLED_APP_PATH" >/dev/null 2>&1 || warn "spctl assess failed"

log "Launching app"
open -a "$INSTALLED_APP_PATH"

bin_name="${APP_BUNDLE_NAME%.app}"
deadline=$((SECONDS + WAIT_SECONDS))
launched=0
while ((SECONDS < deadline)); do
  if pgrep -x "$bin_name" >/dev/null 2>&1; then
    launched=1
    break
  fi
  if pgrep -f "${INSTALLED_APP_PATH}/Contents/MacOS" >/dev/null 2>&1; then
    launched=1
    break
  fi
  sleep 1
done

if [[ "$launched" -ne 1 ]]; then
  echo "App failed to launch within ${WAIT_SECONDS}s."
  exit 1
fi

log "Launch confirmed"
log "Smoke test passed"
