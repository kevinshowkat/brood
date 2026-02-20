# Skill: Swap DNA

## What it does
Transfers structure from one image and surface treatment from another.

## Requirements
- Exactly 2 selected images.
- Active image is treated as structure source by default.
- Hold Shift to invert structure/surface assignment.

## How it works
- Sends `/swap_dna <structure> <surface>` over PTY.
- Prompt contract prioritizes structure from image A and surface from image B.

## Desired effect
One coherent output preserving layout/geometry from structure source,
with color/material/lighting finish from surface source.
