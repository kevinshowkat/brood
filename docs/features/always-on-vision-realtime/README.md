# Always-On Vision (Realtime)

This feature keeps a background canvas-context session open and updates the readout as the canvas changes.

## User view

- Settings includes an **Always-On Vision** toggle.
- When enabled, Brood sends small canvas snapshots in the background.
- The readout can show `Connecting…`, `ANALYZING…`, streamed text, or a disabled error state.

## Main files

- `desktop/src/canvas_app.js`
- `rust_engine/crates/brood-contracts/src/chat/intent_parser.rs`
- `rust_engine/crates/brood-cli/src/main.rs`

## Config

- `BROOD_REALTIME_PROVIDER`
- `BROOD_CANVAS_CONTEXT_REALTIME_PROVIDER`
