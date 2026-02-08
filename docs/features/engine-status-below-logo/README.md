# Move Engine Status Below Logo

## Problem
The engine status pill (e.g. `Engine: imported 2 photos`) was positioned on the top-right of the app header. This makes it easy to miss and visually disconnects it from the Brood brand.

## UX
- The engine status pill is placed directly under the Brood logo in the top-left header area.
- Status text remains truncated with ellipsis when long.

## Implementation
- Wrapped the logo + status in a `.brand-stack` container.
- Removed the right-aligned header styling and replaced it with a left-aligned stacked layout.

Files:
- `desktop/src/index.html`
- `desktop/src/styles.css`

## Test Plan
- `cd desktop && npm run build`
- Manual:
  - Import photos and confirm the status updates appear under the logo.
  - Trigger an error status and confirm styling still applies.

