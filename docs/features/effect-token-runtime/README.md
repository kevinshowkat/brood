# Effect Token Runtime

This note covers the runtime used for `Extract DNA` and `Soul Leech`.

## User view

- Extraction plays on a dedicated overlay.
- A source image becomes a draggable token.
- Dropping the token onto another image applies the effect once.
- Failed applies return the token to a usable state.

## Main files

- `desktop/src/effects_runtime.js`
- `desktop/src/effect_specs.js`
- `desktop/src/effect_interactions.js`
- `desktop/src/canvas_app.js`

## Notes

- Token graphics are separate from the base work canvas.
- Tokenized source images are excluded from normal canvas context.
