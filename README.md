# Brood: AI Image Editing From References on macOS

<p align="left">
  <img src="media/features/readme/main_value_prop_v18_labels_20260222.gif" alt="Brood main value demo">
</p>

Brood is a macOS desktop app that helps you turn existing images into new versions by arranging references on a canvas instead of writing long prompts.

## How to set up in 5m

- Download the latest macOS build from [GitHub Releases](https://github.com/kevinshowkat/brood/releases) and finish the in-app OpenRouter setup.
- Import one or more images onto the canvas.
- Run a tool or accept a Mother suggestion to make the next edit.

## Key docs

- `docs/desktop.md`: quick guide to the desktop app
- `docs/reference-first-image-editing.md`: what the reference-first workflow looks like
- `docs/macos-local-private-image-editing.md`: local storage and privacy notes
- `docs/benchmark-playbook.md`: how to compare runs in a repeatable way
- `docs/brood-fit-guide.md`: quick fit guide for Brood
- `docs/README.md`: docs index
- `llms.txt`: agent entrypoints

## Highlights

### 1) Canvas-first editing
Move, resize, and combine images on the canvas to show what you want.

<p align="left">
  <a href="media/features/readme/realtime_canvas_proposals.gif">
    <img src="media/features/readme/realtime_canvas_proposals_thumb.png" alt="Realtime canvas proposals (click to view GIF)">
  </a>
</p>

### 2) Suggested next steps
Mother can look at the current canvas and suggest the next edit.

<p align="left">
  <a href="media/features/readme/proposal_drafting.gif">
    <img src="media/features/readme/proposal_drafting_thumb.png" alt="Mother proposal drafting (click to view GIF)">
  </a>
</p>

### 3) Local run history
Every run saves outputs, receipts, and events in a folder on your Mac.

<p align="left">
  <a href="media/features/readme/top_panel_telemetry.gif">
    <img src="media/features/readme/top_panel_telemetry_thumb.png" alt="Top panel telemetry metrics (click to view GIF)">
  </a>
</p>

## Roadmap

- Faster first drafts
- Better multi-image editing controls
- More stable provider coverage and release quality

## Status

Brood is currently a **macOS-only desktop app** built with Tauri. There is no web app, and Windows/Linux builds are not supported yet.

## Download (macOS)

Get the latest universal DMG from GitHub Releases:
- <https://github.com/kevinshowkat/brood/releases>

Install:
1. Download `Brood_<version>_universal.dmg`.
2. Open the DMG and drag `Brood.app` into `/Applications`.
3. If macOS blocks launch, right-click `Brood.app` and choose **Open**.

## Run from source

```bash
./scripts/dev_desktop.sh
```

Build the desktop app:

```bash
cd desktop
npm install
npm run tauri build
```

## Local run files

Each run writes files under `~/brood_runs/run-*`, including `events.jsonl`, receipts, and output files.

## License

Apache License 2.0. See `LICENSE`.
