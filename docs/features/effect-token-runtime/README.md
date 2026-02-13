# Pixi Extraction Runtime + Effect Tokens (DNA + Soul)

## Problem
Extraction effects and token drag/apply interactions previously behaved like ad-hoc canvas overlays. That made it hard to:
- keep extraction visuals cinematic without polluting core canvas rendering,
- guarantee consistent drag/drop behavior across DNA and Soul,
- avoid stale async states (double dispatch, stuck applying, unresolved animation waits),
- keep Mother/realtime context aligned with what is actually "present" on canvas.

## UX
- `Extract DNA` and `Soul Leech` share one pipeline.
- During extraction, each source tile gets a high-activity swarm storm over the exact image bounds.
- After extraction completes, the source tile is replaced by a compact draggable glyph (DNA or Soul).
- Dragging keeps the glyph attached to pointer movement continuously.
- Valid drop targets get an obvious highlight.
- Dropping onto a valid target plays a "drop into image" sink animation, then dispatches one apply call.
- Invalid drop plays a cancel/return animation and dispatches no apply.
- After successful apply, both the extracted source and token are removed from the canvas.

## Architecture
Primary files:
- `desktop/src/effects_runtime.js`
- `desktop/src/effect_specs.js`
- `desktop/src/effect_interactions.js`
- `desktop/src/canvas_app.js`
- `desktop/src/index.html` (`#effects-canvas`)
- `desktop/src/styles.css` (overlay layering)

Design:
- Pixi is a dedicated transparent compositor layer above the base canvas.
- Visual specs are pluggable via `EFFECT_SPEC_REGISTRY` (`extract_dna`, `soul_leech`).
- Interaction/state logic lives in app state + lifecycle helpers, not in draw code.
- Coordinate transforms are centralized from multi-view world rects to screen rects before rendering.
- Runtime lifecycle is explicit: initialize once, resize with DPR changes, tick only when scene work exists, suspend/resume safely, destroy on teardown.

## Token Lifecycle + Drop Rules
Lifecycle:
- `extracting`
- `ready`
- `dragging`
- `drop_preview`
- `applying`
- `consumed`

Rules:
- Valid target must be different from source image.
- Apply dispatch is lock-protected and dispatch-id checked to prevent double apply.
- While locked/pending, duplicate apply attempts are ignored.
- Invalid drops never call the apply path.

## Event Compatibility
Existing backend events remain the source of truth:
- `image_dna_extracted` / `image_dna_extracted_failed`
- `image_soul_extracted` / `image_soul_extracted_failed`

Resolution strategy:
- Pending extraction slots track per-image IDs (safe with duplicate source paths).
- Successful extraction can still resolve by `image_path` when there is no pending UI slot (for terminal-driven `/extract_dna` or `/soul_leech` flows).
- Late/stale apply/extraction events are ignored when dispatch or target checks fail.

## Mother + Realtime Visibility Rules
- Tokenized source images are excluded from visible-canvas selection/reference sets.
- DNA/Soul glyphs render only on the Pixi overlay (`#effects-canvas`), not on the work canvas bitmap.
- Always-on snapshots and intent snapshots therefore ignore token glyphs and tokenized source tiles.
- Practical effect: reference counts reflect visible images (`n - 1` after one extraction from `n` inputs).

## Reliability Guarantees
- If apply is blocked (for example by Intent lock), token state is recovered to `ready`.
- If target image is missing at apply time, apply lock is released and token recovers cleanly.
- If runtime is suspended while a drop animation is active, the pending animation promise is resolved so apply flow does not hang.
- Failed apply restores UI state (no stuck `applying` token).

## Manual QA
DNA flow:
1. Load 2 images in multi view.
2. Extract DNA from one image.
3. Verify swarm overlays the source tile bounds exactly.
4. Verify source tile is replaced by only a draggable DNA glyph.
5. Drag over the other image, confirm highlight, drop, confirm sink animation then one apply dispatch.
6. Confirm source + glyph are both gone after apply.

Soul parity:
1. Repeat with Soul Leech.
2. Confirm same lifecycle and drag/drop behavior.

Edge cases:
1. Import duplicate files and extract from multiple selected tiles.
2. Remove a target before queued apply dispatch runs; confirm lock recovery.
3. Suspend/hide app during drop animation; confirm apply flow resumes without hanging.
