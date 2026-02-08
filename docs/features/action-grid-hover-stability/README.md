# Action Grid Hover Stability

## Problem
On macOS (WKWebView), the Action Grid (Quick Actions) buttons had a subtle hover “shimmer” where the button/text looked like it slightly tweaked when the mouse entered/exited.

Root cause: the hover state used CSS `filter: drop-shadow(...)`. Toggling `filter` on/off can change compositing/rasterization and cause a perceptible jitter.

## UX
- Hovering Quick Action buttons should feel stable.
- Keep the same “lift + glow” intent, but without the hover jitter.

## Implementation
Files:
- `desktop/src/styles.css`

Changes:
- Removed `filter`-based hover drop-shadows from `.panel-body.actions button:hover`.
- Replaced them with a slightly stronger `box-shadow` + a subtle background gradient shift on hover.
- Removed `filter` from the transition list and added `background` to keep hover transitions smooth.

## Testing
Standard regression set:
- `python -m pytest`
- `cd desktop && npm run build`

