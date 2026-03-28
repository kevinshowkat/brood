# Action Queue

This change lets users queue actions instead of losing clicks while the engine is busy.

## User view

- Clicking an action while another one is running adds it to a queue.
- Queued actions run one at a time.
- Variations wait for the recreate flow to finish before the next action starts.

## Main files

- `desktop/src/canvas_app.js`
- `rust_engine/crates/brood-cli/src/main.rs`

## Checks

- `cd rust_engine && cargo test`
- `cd desktop && npm run build`
