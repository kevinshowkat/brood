# Skill: Soul Leech

## What it does
Extracts emotional/style signature tokens from selected images.

## Requirements
- At least 1 selected image.

## How it works
- Sends `/soul_leech` over PTY.
- Engine emits `image_soul_extracted` events.
- UI stores soul tokens for transfer onto targets.

## Desired effect
Reusable mood/energy transfers while preserving target identity.
