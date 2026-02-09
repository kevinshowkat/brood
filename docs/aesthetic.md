# Aesthetic Capture (Planned)

Note: The "Build aesthetic" wizard described below is **not currently present** in the desktop UI.
This doc is retained as a product/design note for a future feature.

For current desktop workflows, import images into a run via **Import Photos** (or drag-drop) and use Abilities.

## Intended workflow (future)

1. In the UI, click **Build aesthetic**.
2. Step 1 (Select): choose a folder or select multiple files.
   - Supported types: .png, .jpg, .jpeg, .webp, .heic
   - Folder scans are non-recursive.
   - Recommended: 10-20 images. A warning appears if fewer than 10 or more than 50.
3. Click **Import** to advance to Step 2 (Summary).
4. Review the import summary and click **Done** to close the wizard.

Re-importing replaces the existing aesthetic set. Use **Clear** in the top bar to remove the current set.

## What gets written

All data would live inside the current run directory:

- `run_dir/aesthetic/` contains the copied reference images.
- `run_dir/aesthetic/annotations/` contains placeholders for future pairwise scoring:
  - `aesthetic_pairs_seed.csv`
  - `aesthetic_votes.jsonl`
- `run_dir/aesthetic/aesthetic_scores.json` is a placeholder for BT scores.

`run_dir/run.json` is updated with an `aesthetic` block that includes:

- `images` (relative paths under `run_dir`)
- `imported_at`
- `source_paths`
- `count`
- `source_kind` / `source_dir`
- `scan_recursive`

## Notes

- The intended learning flow mirrors the oscillo arousal training pattern: BT scores -> Ridge on CLIP embeddings + image metrics.
- File access is limited by Tauri FS scope (see `desktop/src-tauri/tauri.conf.json`). If your images live outside `$HOME`, you may need to widen the scope.
