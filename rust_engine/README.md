# Rust Engine Scaffold

This workspace is the starting point for the Brood engine rewrite in Rust.

Current scope:
- `brood-rs` CLI entrypoint for native `chat`, `run`, `recreate`, `export`.
- Native Rust contract modules (ported from Python) for:
  - chat intent parsing
  - event writing (`events.jsonl`)
  - thread manifests
  - receipts
  - summary payloads
  - cache store
  - feedback writer
  - model/provider selection primitives
- Parity-focused unit tests for these contracts.

## Dev usage

```bash
cd rust_engine
cargo test
cargo run -p brood-cli -- chat --out /tmp/brood-rs-run --events /tmp/brood-rs-run/events.jsonl
```

Native dryrun execution example:

```bash
cargo run -p brood-cli -- run --prompt "boat" --out /tmp/brood-rs-native --image-model dryrun-image-1
```
