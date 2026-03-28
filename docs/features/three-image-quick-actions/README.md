# Three-Image Abilities

This change adds a dedicated tool set for exactly three images.

## User view

When three images are loaded in `Multi view`, Brood can show:
- `Extract the Rule`
- `Odd One Out`
- `Triforce`

## Results

- `Extract the Rule`: writes a short principle to the HUD
- `Odd One Out`: highlights the image that breaks the pattern
- `Triforce`: generates a new image from all three references

## Main files

- `desktop/src/canvas_app.js`
- `rust_engine/crates/brood-contracts/src/chat/intent_parser.rs`
- `rust_engine/crates/brood-cli/src/main.rs`
- `rust_engine/crates/brood-engine/src/lib.rs`
