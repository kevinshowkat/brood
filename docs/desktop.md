# Desktop App (Tauri)

Supported platform: **macOS only** (Desktop app). There is no web app, and Windows/Linux builds are not supported yet.

Category claim:
- Promptless, reference-first AI image generation and editing desktop for developers (multi-provider + reproducible runs).

The desktop app is image-first: import images, run Abilities, and inspect results in the bottom HUD.

## Core Concepts
- **Run**: a folder on disk (created under `~/brood_runs/`) that stores inputs, artifacts, receipts, and `events.jsonl`.
- **Unit**: the currently selected image (shown on the canvas in single view).
- **Views**:
  - `Single view`: one image on the canvas, with a filmstrip to browse artifacts.
  - `Multi view`: tiled layout of all images in the run (used for 2-photo actions).

## Basic Workflow
1. Click **New Run** (creates a run directory and starts the engine).
2. Click **Import Photos** or drag-drop onto the canvas (copies files into `run_dir/inputs/`).
3. Use **Abilities** (right panel) to generate edits/variants.
4. Use **Export** to write `run_dir/export.html` for a lightweight shareable viewer.

## Abilities

Single-image actions (work in `Single view`):
- `Diagnose`: creative-director critique. Output appears in the HUD as `DIAG`.
- `Recast`: reimagine the image in a different medium/context (image output).
- `Background: White` / `Background: Sweep`: background replacement edits.
- `Crop: Square`: local crop (no model call).
- `Variations`: zero-prompt variations of the active image.

Extraction actions (work from selected source images, typically in `Multi view`):
- `Extract DNA`: collapse each selected source into a draggable DNA glyph.
- `Soul Leech`: collapse each selected source into a draggable Soul glyph.

Two-image actions (require `Multi view` and **exactly 2** photos loaded):
- `Combine`: blend the two images into one (`/blend`).
- `Swap DNA`: structure from one + surface qualities from the other (`/swap_dna`). Shift-click to invert.
- `Bridge`: synthesize the aesthetic midpoint between two references (`/bridge`).
- `Argue`: debate which direction is stronger. Output appears in the HUD as `ARG`.

Notes:
- Some actions auto-switch the **Image Model** (e.g. 2-photo actions prefer `gemini-3-pro-image-preview`). The agent portraits update to match.
- After a 2-photo action completes, Brood switches back to `Single view` showing the output-only image. Use `Multi view` to return to the tiled layout.

## Effect Tokens (DNA / Soul)
- Extraction visuals run on a dedicated Pixi overlay (`#effects-canvas`) and are clipped exactly to the source tile bounds.
- When extraction completes, the source tile is tokenized: the source image box is removed from normal canvas interaction and replaced by a floating draggable glyph.
- The token lifecycle is explicit: `extracting -> ready -> dragging -> drop_preview -> applying -> consumed`.
- Drag/drop rules:
  - Valid drop target must be a different image than the source.
  - Valid targets get a strong hover highlight.
  - Drop plays a sink/absorb animation, then dispatches apply exactly once.
  - Invalid drop cancels without dispatching apply.
- On successful apply:
  - Target is edited in place (DNA/Soul transfer).
  - The token is consumed.
  - The extracted source image is removed from the canvas.
- On failed apply:
  - Token recovers to a draggable `ready` state (no stuck `applying` lock).

### Canvas Context + Mother Reference Counts
- Tokenized source images are excluded from visible-canvas counts and selection logic.
- Effect glyphs are rendered only on the Pixi overlay (not the base work canvas), so realtime/intent snapshots do not include DNA/Soul glyphs.
- Practical result: after one extraction from `n` images, Mother context and reference counts use `n - 1` visible images until the effect is applied.

## HUD + Tools
- The HUD prints `UNIT / DESC / SEL / GEN` for the active image.
- While `DIAG` / `ARG` text is present, the HUD hides the other lines to stay focused.
- The HUD keybar (buttons `1`-`9`) activates canvas tools/actions. Common hotkeys:
  - `L` lasso
  - `D` designate subject/reference/object
  - `F` fit-to-view
  - `Esc` clear selection / close panels

## Mother Proposal + Gemini Context (v2)
Brood now sends two compact context packets that preserve user-selected proposal flow while making model behavior more aware of what happened on canvas.

- `brood.mother.proposal_context.v1` (during intent/proposal inference):
  - Added to `mother_intent_infer-*.json` as `proposal_context`.
  - Encodes soft priors only: interaction focus, geometry hints, and compact spatial relations.
  - Does not override explicit proposal lock semantics (`active_id`, `selected_ids`, chosen proposal mode).
- `brood.gemini.context_packet.v2` (during image generation):
  - Added to `mother_generate-*.json` as `gemini_context_packet`.
  - Includes `proposal_lock`, ranked image slots, compact relations, and a capped `must_not` list.
  - Includes a tiny `geometry_trace` per image: `cx`, `cy`, `relative_scale`, `iou_to_primary`.

### Scoring Math (high level)
Per-image interaction and geometry are normalized and combined into a soft weighting prior.

- Saturating interaction transform:
  - `sat(c, k) = min(1, ln(1 + c) / ln(1 + k))`
- Interaction base:
  - `E = 0.35*sat(move,8) + 0.35*sat(resize,4) + 0.25*sat(selection,8) + 0.05*sat(action_grid,4)`
- Recency + staleness:
  - decay `exp(-age_ms / 90000)`
  - hard stale cutoff on transform activity: `age_transform_ms > 600000` (10 min) => interaction contribution `0`
- Geometry score:
  - size term uses `sqrt(area_ratio)` normalization
  - centrality term uses distance to `(0.5, 0.5)`
  - combined as `0.8*size + 0.2*centrality`, then normalized
- Combined score (soft prior):
  - intent proposal context uses:
    - `(1 + 0.8*focus_score) * (1 + 0.5*geometry_score) * (1 + selected_bonus + active_bonus)`
  - Gemini generation context uses role priors and single-target guardrails.

### Guardrails and compactness
- Single-target clamp logic is applied only when exactly one target exists.
- `must_not` is deduped and capped to exactly 6 constraints.
- Relations are compact and confidence-gated (`OVERLAP` / directional `ADJACENT`) to reduce prompt noise.

### Debugging and verification
- Enable Gemini wire debug:
  - `BROOD_DEBUG_GEMINI_WIRE=1 npm --prefix desktop run tauri dev`
- Inspect the latest run:
  - `~/brood_runs/run-*/mother_intent_infer-*.json` -> `proposal_context`
  - `~/brood_runs/run-*/_raw_provider_outputs/gemini-send-message-*.json` -> exact Gemini `chat.send_message` payload parts
  - `~/brood_runs/run-*/_raw_provider_outputs/gemini-receipt-*.json` -> provider receipt copy
  - `~/brood_runs/run-*/mother_generate-*.json` -> generation payload containing `gemini_context_packet`

## Files Written To The Run
- `run_dir/inputs/`: imported photos
- `run_dir/receipt-*.json`: generation/edit receipts
- `run_dir/events.jsonl`: event stream consumed by the desktop UI
- `run_dir/visual_prompt.json`: serialized canvas marks/layout (see `docs/visual_prompting_v0.md`)
