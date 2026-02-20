# Skill: Create Layers

## What it does
Splits one image into four transparent layer artifacts.

## Requirements
- Exactly 1 selected/active image.

## How it works
- Loads source pixels locally.
- Partitions pixels into 4 non-overlapping checkerboard layers.
- Writes each layer as a local artifact + receipt.

## Desired effect
When all produced layers are stacked with normal alpha compositing,
the original image is reconstituted.
