# Skill: Annotate

## What it does
Uses a user-drawn box + instruction to run a targeted edit on only that region.

## Requirements
- Exactly 1 active image.
- A non-empty instruction.
- A valid annotate box.

## How it works
- Crops the selected box into a temporary image.
- Sends an edit prompt to the engine for that crop.
- Composites the edited crop back into the original image.

## Desired effect
Only the selected region changes, while surrounding pixels remain intact.
