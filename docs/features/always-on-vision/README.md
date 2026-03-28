# Always-On Vision

This feature runs lightweight canvas analysis in the background.

## User view

- Settings includes an **Always-On Vision** toggle.
- Brood periodically scans a small canvas snapshot.
- The latest summary appears in the **Canvas Context** readout.

## Main files

- `desktop/src/canvas_app.js`
- `desktop/src/index.html`
- `rust_engine/crates/brood-contracts/src/chat/intent_parser.rs`
- `rust_engine/crates/brood-cli/src/main.rs`

## Related note

- `docs/features/always-on-vision-realtime/README.md`
