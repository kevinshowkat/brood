# Three-Image Abilities

## Problem
Brood previously only had multi-image Abilities for exactly two images (Combine / Bridge / Swap DNA / Argue). When users import three images, the UI had no purpose-built actions even though three references is the minimum for pattern recognition.

This feature adds a 3-image action set that turns a 3-up canvas into a first-class input:
- **Extract the Rule** (pattern recognition, text + lightweight visual annotation)
- **Odd One Out** (portfolio/mood-board critique, text + highlight)
- **Triforce** (generate the centroid image across 3 references)

## UX
- When `canvasMode === "multi"` and exactly **3** images are loaded, the Abilities list shows:
  - `Extract the Rule`
  - `Odd One Out`
  - `Triforce`
- Results:
  - **Extract the Rule** writes a concise principle into the HUD Director readout (`RULE`) and optionally draws a few annotation points on the multi-canvas overlay (cyan markers).
  - **Odd One Out** writes critique into the HUD Director readout (`ODD`) and highlights the chosen “odd” image with a dashed red outline on the multi-canvas overlay.
  - **Triforce** generates a single image artifact and then switches to single view (same behavior as other multi-image generations).

## Implementation

### Desktop
Files:
- `desktop/src/canvas_app.js`

Key changes:
- `computeQuickActions()` now has a 3-image branch when `state.canvasMode === "multi"` and `state.images.length === 3`.
- New runners:
  - `runExtractRuleTriplet()` sends `/extract_rule "<a>" "<b>" "<c>"`
  - `runOddOneOutTriplet()` sends `/odd_one_out "<a>" "<b>" "<c>"`
  - `runTriforceTriplet()` sends `/triforce "<a>" "<b>" "<c>"`
- New state:
  - `pendingExtractRule`, `pendingOddOneOut`, `pendingTriforce`
  - `tripletRuleAnnotations: Map<imageId, {x,y,label}[]>`
  - `tripletOddOneOutId`
- New events handled:
  - `triplet_rule` / `triplet_rule_failed`
  - `triplet_odd_one_out` / `triplet_odd_one_out_failed`
- Overlay rendering:
  - `renderMultiCanvas()` draws `tripletOddOneOutId` as a dashed red frame.
  - `renderMultiCanvas()` draws `tripletRuleAnnotations` as cyan point markers with labels.

Notes:
- Annotations are stored as percentages (`x`,`y` in `[0,1]`) so they map cleanly onto the multi-canvas tile rects.
- Triforce uses the active image as the `init_image` anchor and the other two as references; this matches existing 2-image action behavior (active image is “A”).

### Engine
Files:
- `brood_engine/chat/intent_parser.py` (adds slash commands)
- `brood_engine/cli.py` (desktop uses this chat loop via PTY)
- `brood_engine/chat/loop.py` (parity)
- `brood_engine/recreate/triplet.py` (new module)

New slash commands:
- `/extract_rule <a> <b> <c>`
- `/odd_one_out <a> <b> <c>`
- `/triforce <a> <b> <c>`

Engine events emitted:
- `triplet_rule`:
  - `image_paths`, `principle`, `evidence[]`, `annotations[]`, `source`, `model`, `confidence`
- `triplet_odd_one_out`:
  - `image_paths`, `odd_image`, `odd_index`, `pattern`, `explanation`, `source`, `model`, `confidence`
- Failure variants: `triplet_rule_failed`, `triplet_odd_one_out_failed`

Model routing:
- **Extract the Rule / Odd One Out**: uses OpenAI vision when available (Gemini fallback if installed/configured).
  - Env overrides:
    - `BROOD_EXTRACT_RULE_MODEL` / `OPENAI_EXTRACT_RULE_MODEL`
    - `BROOD_ODD_ONE_OUT_MODEL` / `OPENAI_ODD_ONE_OUT_MODEL`
- **Triforce**: uses the engine’s current `image_model` selection (desktop tries to keep this on a Gemini multi-image model).

## Testing
Standard regression set for this feature branch:
- `python -m pytest`
- `cd desktop && npm run build`

## Future Work
- Ask the model for a richer annotation schema (boxes + multiple labels per image).
- Allow “Odd One Out” to return both a strict pick and a “closest alternative” when confidence is low.
- Consider rendering a dedicated “analysis card” in the UI instead of only the HUD Director readout.

