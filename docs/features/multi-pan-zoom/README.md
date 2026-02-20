# Multi View Pan and Zoom

## Problem
When 2 images are loaded, Brood switches to `Multi view` for pair actions. In this mode, the mouse wheel zoom handler was explicitly disabled, which made it impossible to zoom out (or back in) while using Pan. Users can easily end up in a state where they want to zoom to re-frame both images but cannot.

## UX
- In `Multi view`, `Pan` now supports wheel zoom.
- Zoom centers on the cursor (same behavior as single-image mode).
- HUD zoom percentage reflects the active view mode (single vs multi).

## Implementation
- Added `state.multiView.scale` alongside `offsetX/offsetY`.
- Updated multi-mode hit-testing and coordinate transforms to account for `multiView.scale`.
- Updated multi-mode rendering math to scale tile rects and overlays.
- Updated the wheel handler to zoom `multiView` when `canvasMode === "multi"`.

Files:
- `desktop/src/canvas_app.js`

## Test Plan
- `cd desktop && npm run build`
- `cd rust_engine && cargo test`
- Manual:
  - Load 2 images, enter `Multi view`, select `Pan`.
  - Scroll wheel to zoom out: tiles should shrink and stay under the cursor.
  - Pan around while zoomed: tiles should move smoothly.

