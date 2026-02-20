# Annotate Box Edits (Bounded + Single Output)

## Problem
`Annotate` was previously implemented as a plain text instruction ("apply change only inside this bounding box …"). In practice, models often ignore that and edit outside the box (for example recoloring the whole beanie instead of just the selected patch). Users also reported seeing multiple extra outputs after an annotate submit; the expectation is a single edited version of the original image.

## UX
- The `Annotate` tool edits only the pixels inside the drawn box.
- Submitting an annotate instruction results in a single updated version of the original image (no extra images added to the run).

## Implementation
### Desktop (enforce box-bounded edits)
We enforce the box constraint by changing the data we send to the engine:
1. Crop the selected box region from the active image into a temporary PNG inside the run directory.
2. `/use` that cropped image in the engine.
3. Send `edit the image: <instruction>` so the engine edits only the crop.
4. When the engine returns the edited crop artifact, composite it back onto the original base image at the box coordinates.
5. Save the composite as a local artifact and replace the active image in place.

This guarantees the edit is confined to the box regardless of model behavior.

### Engine (cap Gemini outputs to `n`)
Gemini can return multiple image parts per candidate. We cap the number of blobs written to disk to `request.n` so "n=1" stays a single output.

Files:
- `desktop/src/canvas_app.js`
- `rust_engine/crates/brood-engine/src/lib.rs`

## Test Plan
- `cd rust_engine && cargo test`
- `cd desktop && npm run build`
- Manual:
  - Load an image, draw an annotate box on a small sub-region, prompt: "Make this black".
  - Verify only the selected region changes and the rest of the image is unchanged.
  - Verify no additional images are appended to the filmstrip.

## Notes / Follow-ups
- The engine still writes an intermediate receipt/artifact for the edited crop; the UI does not surface it. A future lineage/timeline feature can decide whether to keep or hide these intermediates.
