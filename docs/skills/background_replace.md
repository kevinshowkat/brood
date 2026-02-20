# Skill: Background Replace

## What it does
Replaces background with `White` or `Sweep`.

## Requirements
- 1 active image.

## How it works
- If lasso region exists: performs local masked composite.
- Otherwise: runs model-backed replace flow.

## Desired effect
Clean isolated subject with studio-style background.
