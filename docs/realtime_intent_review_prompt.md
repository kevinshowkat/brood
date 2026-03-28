# Realtime Intent Review Prompt

Use this prompt when reviewing a recorded Brood session.

## Inputs

- ordered screenshots from one session
- `events.jsonl` for the same session
- a short description of the expected flow

## What the review should produce

1. coverage of important event types
2. a frame-to-frame transition dataset
3. prioritized fixes
4. a weight-tuning recommendation

## Rules

- prefer event-backed interpretations
- separate observed actions from inferred actions
- keep confidence lower for guesses
- keep target and reference IDs separate unless evidence shows otherwise
