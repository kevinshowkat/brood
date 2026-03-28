# Background Canvas Diagnose

This feature lets Brood run a quiet diagnose pass when multiple images are on the canvas.

## User view

- With two or more images loaded, Brood can analyze the whole canvas automatically.
- Results appear in the HUD output without a foreground toast.

## Main file

- `desktop/src/canvas_app.js`

## Checks

- `cd rust_engine && cargo test`
- `cd desktop && npm run build`
