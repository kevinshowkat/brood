#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MAX_ATTEMPTS="${TAURI_DMG_BUILD_ATTEMPTS:-3}"
RETRY_DELAY_SECONDS="${TAURI_DMG_BUILD_RETRY_DELAY_SECONDS:-15}"

cleanup_failed_bundle_artifacts() {
  find "$REPO_ROOT/desktop/src-tauri/target/release/bundle" \
    -type f \
    \( -path '*/dmg/*.dmg' -o -path '*/macos/rw.*.dmg' \) \
    -delete 2>/dev/null || true
}

cd "$REPO_ROOT/desktop"

cmd=(npm run tauri build -- --bundles dmg "$@")

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "[ci] Building macOS DMG (attempt ${attempt}/${MAX_ATTEMPTS})"
  if "${cmd[@]}"; then
    exit 0
  fi

  if [[ "$attempt" == "$MAX_ATTEMPTS" ]]; then
    echo "[ci] DMG build failed after ${MAX_ATTEMPTS} attempts" >&2
    exit 1
  fi

  echo "[ci] DMG build failed; cleaning bundle artifacts and retrying in ${RETRY_DELAY_SECONDS}s" >&2
  cleanup_failed_bundle_artifacts
  sleep "$RETRY_DELAY_SECONDS"
done
