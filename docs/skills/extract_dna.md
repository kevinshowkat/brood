# Skill: Extract DNA

## What it does
Extracts transferable visual DNA (palette/material cues) from selected images.

## Requirements
- At least 1 selected image.

## How it works
- Sends `/extract_dna` over PTY for each source image.
- Engine emits `image_dna_extracted` events.
- UI stores emitted DNA tokens for later apply operations.

## Desired effect
Reusable style/material tokens that can be applied to other canvas images.
