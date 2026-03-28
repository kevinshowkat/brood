# Desktop App

Brood is a **macOS-only** desktop app. There is no web app.

## What you do in Brood

1. Start a new run.
2. Import one or more images.
3. Arrange them on the canvas.
4. Run a tool or accept a Mother suggestion.
5. Export or keep iterating.

## Main views

- `Single view`: one active image with its output history
- `Multi view`: a tiled layout used for multi-image work

## Main tools

Single-image tools:
- `Recast`
- `Create Layers`
- `Background: White`
- `Background: Sweep`
- `Crop: Square`
- `Variations`

Multi-image tools:
- `Combine`
- `Swap DNA`
- `Bridge`
- `Extract the Rule`
- `Odd One Out`
- `Triforce`

## Effect tokens

`Extract DNA` and `Soul Leech` turn a source image into a draggable token.

- Drag the token onto another image to apply it.
- The source image is removed after a successful apply.
- Token graphics are not treated as normal canvas images.

## Mother suggestions

Mother can watch the current canvas and suggest the next edit.

- Suggestions are based on the visible images and recent canvas actions.
- You can accept, reject, or ask for another option.

## What gets saved

Each run writes files under `~/brood_runs/run-*`.

Common files:
- `inputs/`: imported images
- `events.jsonl`: event stream
- `receipt-*.json`: generation or edit receipts
- `visual_prompt.json`: saved canvas marks and layout

## Useful keys

- `L`: lasso
- `F`: fit to view
- `Esc`: clear selection or close panels
- `1` to `9`: HUD tools
