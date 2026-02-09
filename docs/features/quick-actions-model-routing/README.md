# Abilities Model Routing

## Problem
Brood previously relied on the user's global `Image Model` setting for most engine-driven Abilities, with a few ad-hoc overrides. This leads to:
- Poor UX when the global model doesn't support image-to-image edits (many providers ignore `init_image`).
- Unnecessary cost/latency when a high-end model is used for simple, iterative edits.
- Inconsistent quality for multi-image actions if a weaker model is selected.

## Goals
Assign models per Ability based on practical tradeoffs:
- Multi-image coherence and hard edits: prefer higher quality models.
- Simple iterative edits: prefer faster/cheaper models.
- Keep user settings intact: actions can temporarily override the engine model and then restore it.

## Policy (Current Defaults)
Image edits are routed to Gemini models because the engine's edit path relies on `init_image`.

- Background replace: `gemini-2.5-flash-image` (fast iteration, lower cost)
- Surprise Me: `gemini-2.5-flash-image` (fast iteration)
- Remove People: `gemini-3-pro-image-preview` (harder inpainting; quality-first)
- Combine / Swap DNA / Bridge: `gemini-3-pro-image-preview` (multi-image coherence)
- Recast: `gemini-3-pro-image-preview` (quality-first creative leap)

Costs in `brood_engine/pricing/default_pricing.json` suggest `gemini-3-pro-image-preview` is materially more expensive than `gemini-2.5-flash-image`, so we reserve it for the actions that benefit most.

## Implementation
- Added an `ACTION_IMAGE_MODEL` mapping in `desktop/src/canvas_app.js`.
- Added `maybeOverrideEngineImageModel()` which temporarily sets `/image_model <desired>` on the engine and records a restore target.
- Updated engine-driven Abilities to use action-specific model overrides and to set `portraitWorking()` with a provider override that matches the routed model.

Files:
- `desktop/src/canvas_app.js`

## Test Plan
- `python -m pytest`
- `cd desktop && npm run build`
- Manual:
  - Set global image model to a non-Gemini option (e.g. `flux-2`).
  - Run `Background: White` and `Combine` and verify the engine switches to Gemini for the action and produces an edit.

