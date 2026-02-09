# Remove Suggested: Combine Overlay

## Problem
When exactly two imported images are loaded, Brood renders an attention-grabbing "SUGGESTED: COMBINE" overlay on the canvas and also emits a tip/toast suggesting Combine. This reads like a button overlaying the images and competes with the user's own intent.

## UX
- When 2 images are loaded, Brood still supports `Multi view` and the 2-image Abilities.
- No automatic "Suggested: Combine" tag/connector is drawn between the two images.
- No automatic toast/tip is shown that suggests Combine on import/drop.

## Implementation
- Desktop-only change.
- Removed the post-import/drop "Suggested action: Combine" toast/tip logic.
- Removed the `renderMultiCanvas()` suggestion connector + label drawing block.

Files:
- `desktop/src/canvas_app.js`

## Test Plan
- `cd desktop && npm run build`
- Manual:
  - Import exactly 2 images: confirm there is no "SUGGESTED: COMBINE" overlay and no toast.
  - Click `Multi view`: confirm 2-image Abilities still appear and work.

## Notes
- This does not remove the actual `Combine` Ability; it only removes the proactive suggestion UI.

