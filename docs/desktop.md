# Desktop App (Tauri)

Supported platform: **macOS only** (Desktop app). There is no web app, and Windows/Linux builds are not supported yet.

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

Two-image actions (require `Multi view` and **exactly 2** photos loaded):
- `Combine`: blend the two images into one (`/blend`).
- `Swap DNA`: structure from one + surface qualities from the other (`/swap_dna`). Shift-click to invert.
- `Bridge`: synthesize the aesthetic midpoint between two references (`/bridge`).
- `Argue`: debate which direction is stronger. Output appears in the HUD as `ARG`.

Notes:
- Some actions auto-switch the **Image Model** (e.g. 2-photo actions prefer `gemini-3-pro-image-preview`). The agent portraits update to match.
- After a 2-photo action completes, Brood switches back to `Single view` showing the output-only image. Use `Multi view` to return to the tiled layout.

## HUD + Tools
- The HUD prints `UNIT / DESC / SEL / GEN` for the active image.
- While `DIAG` / `ARG` text is present, the HUD hides the other lines to stay focused.
- The HUD keybar (buttons `1`-`9`) activates canvas tools/actions. Common hotkeys:
  - `L` lasso
  - `D` designate subject/reference/object
  - `F` fit-to-view
  - `Esc` clear selection / close panels

## Files Written To The Run
- `run_dir/inputs/`: imported photos
- `run_dir/receipt-*.json`: generation/edit receipts
- `run_dir/events.jsonl`: event stream consumed by the desktop UI
- `run_dir/visual_prompt.json`: serialized canvas marks/layout (see `docs/visual_prompting_v0.md`)
