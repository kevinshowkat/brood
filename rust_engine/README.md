# Rust Engine

This workspace contains the native Rust engine that powers the desktop app.

## What is here

- `brood-rs` CLI entrypoints for `chat`, `run`, `recreate`, and `export`
- event writing for `events.jsonl`
- receipts and summary payloads
- cache and feedback support
- provider and model routing

## Common commands

```bash
cd rust_engine
cargo test
cargo run -p brood-cli -- chat --out /tmp/brood-rs-run --events /tmp/brood-rs-run/events.jsonl
```

Dry-run example:

```bash
cargo run -p brood-cli -- run --prompt "boat" --out /tmp/brood-rs-native --image-model dryrun-image-1
```
