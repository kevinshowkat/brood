# Visual Prompting v0

Brood can save the current canvas layout and marks as `visual_prompt.json`.

## What the file is for

It captures:
- which images are on the canvas
- how they are arranged
- which marks were added
- which image each mark belongs to

## Current mark types

- `lasso_polygon`
- `box`
- `circle`

## Current color meaning

- red circle: draw attention to an area
- green box: edit only inside this area
- yellow lasso: selected region

## File location

- `runDir/visual_prompt.json`

## Main fields

- `schema`
- `schema_version`
- `visual_grammar_version`
- `updated_at`
- `run_dir`
- `canvas`
- `images`
- `marks`

## Notes

- The file is written by the desktop app.
- Marks are stored in image-space coordinates.
- The annotate box is only saved while it still exists in the UI.
