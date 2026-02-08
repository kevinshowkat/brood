# Background Canvas Diagnose (Auto)

## Problem
When users upload multiple images, Brood should proactively extract meaning across the whole canvas without the user explicitly clicking `Diagnose`. The goal is to be one step ahead and reduce "what should I do next?" friction.

## UX
- When 2+ images are loaded, Brood runs a background canvas diagnosis automatically.
- Results appear in the Director output (HUD) as a diagnose-style critique/insight.
- This runs quietly: no "Diagnose ready" toast for the background run.

## Implementation
- Desktop builds a downscaled snapshot of the current multi-image canvas layout (offscreen canvas).
- Snapshot is saved to a temporary PNG in the run directory (no filmstrip artifact).
- Desktop triggers the engine `/diagnose <snapshot>` in the background.
- Event handler treats diagnosis events that match the snapshot path as "canvas diagnose" and suppresses foreground toasts.
- Uses a signature + throttle to avoid re-diagnosing the same canvas continuously.

Files:
- `desktop/src/canvas_app.js`

## Test Plan
- `python -m pytest`
- `cd desktop && npm run build`
- Manual:
  - Import 2 images and wait ~1-2 seconds.
  - Confirm a diagnose output appears without clicking `Diagnose`.
  - Confirm no "Diagnose ready" toast appears for the background run.

