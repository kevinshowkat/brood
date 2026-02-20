# Skill: Create Layers

## What it does
Splits one image into three semantic layer artifacts.

## Requirements
- Exactly 1 selected/active image.

## How it works
- Runs 3 sequential semantic extraction passes:
- `Layer 1/3 - Background` (background reconstruction)
- `Layer 2/3 - Main Subject` (subject isolation)
- `Layer 3/3 - Key Props` (detachable foreground props)
- For subject/props, generated images are chroma-keyed (`#00FF00`) into transparency before saving local artifacts.
- Writes each layer as a local artifact + receipt.

## Desired effect
When stacked in order (background -> subject -> props), the layers should approximate the source image while remaining editable independently.

## Notes
- This is best-effort semantic decomposition, not mathematically exact pixel partitioning.
