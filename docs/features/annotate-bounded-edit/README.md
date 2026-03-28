# Annotate Box Edits

This change keeps annotate edits inside the selected box and returns a single updated image.

## User view

- Only the boxed region should change.
- Annotate replaces the current image instead of adding extra outputs.

## Main files

- `desktop/src/canvas_app.js`
- `rust_engine/crates/brood-engine/src/lib.rs`

## Checks

- `cd rust_engine && cargo test`
- `cd desktop && npm run build`
