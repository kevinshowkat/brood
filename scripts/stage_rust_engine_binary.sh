#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUST_ENGINE_DIR="$ROOT_DIR/rust_engine"
DEST_DIR="$ROOT_DIR/desktop/src-tauri/resources"
DEST_BIN="$DEST_DIR/brood-rs"
HOST_BIN="$RUST_ENGINE_DIR/target/release/brood-rs"

mkdir -p "$DEST_DIR"

build_host_release() {
  echo "[brood] building native engine (host release)"
  (cd "$RUST_ENGINE_DIR" && cargo build --release -p brood-cli)
}

build_macos_universal() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 1
  fi
  if ! command -v lipo >/dev/null 2>&1; then
    return 1
  fi

  local aarch_bin="$RUST_ENGINE_DIR/target/aarch64-apple-darwin/release/brood-rs"
  local x64_bin="$RUST_ENGINE_DIR/target/x86_64-apple-darwin/release/brood-rs"

  echo "[brood] attempting universal native engine build (aarch64 + x86_64)"
  if ! (cd "$RUST_ENGINE_DIR" && cargo build --release -p brood-cli --target aarch64-apple-darwin); then
    return 1
  fi
  if ! (cd "$RUST_ENGINE_DIR" && cargo build --release -p brood-cli --target x86_64-apple-darwin); then
    return 1
  fi
  if [[ ! -f "$aarch_bin" || ! -f "$x64_bin" ]]; then
    return 1
  fi

  lipo -create "$aarch_bin" "$x64_bin" -output "$DEST_BIN"
  chmod +x "$DEST_BIN"
  echo "[brood] staged universal native engine at $DEST_BIN"
  return 0
}

if ! build_macos_universal; then
  build_host_release
  if [[ ! -f "$HOST_BIN" ]]; then
    echo "[brood] native engine binary missing after build: $HOST_BIN" >&2
    exit 1
  fi
  cp "$HOST_BIN" "$DEST_BIN"
  chmod +x "$DEST_BIN"
  echo "[brood] staged host native engine at $DEST_BIN"
fi
