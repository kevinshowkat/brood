# Right Click: Remove Image From Canvas

## Problem
In multi-image workflows, users need a fast way to remove an image from the current canvas without restarting the run.

## UX
- Right click an image on the canvas to open an image context menu.
- Menu action: `Remove from canvas`.
- Removing the active image selects a sensible next image.
- If only one image remains, Brood exits `Multi view` back to single-image mode.

## Implementation
- Added a lightweight `#image-menu` context menu (HTML + CSS).
- Added a `contextmenu` handler on the overlay canvas:
  - In `Multi view`, hit-tests which tile was clicked and targets that image.
  - In single mode, targets the active image.
- Implemented `removeImageFromCanvas()` which updates:
  - `state.images`, `state.imagesById`, `state.thumbsById`
  - selection/marks maps for the removed image
  - canvas mode transitions (`multi` -> `single` when needed)

Files:
- `desktop/src/index.html`
- `desktop/src/styles.css`
- `desktop/src/canvas_app.js`

## Test Plan
- `python -m pytest`
- `cd desktop && npm run build`
- Manual:
  - Load 2 images, right click one tile, remove it: verify only one image remains and view returns to single.
  - Load 3+ images, remove a non-active image: verify filmstrip and canvas update correctly.

