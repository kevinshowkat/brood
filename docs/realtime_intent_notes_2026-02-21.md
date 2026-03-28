# Realtime Intent Notes (2026-02-21)

## Scope

This note records a review of the realtime `context -> proposal -> generation` flow for one session.

## Current files

- `desktop/src/canvas_app.js`
- `rust_engine/crates/brood-cli/src/main.rs`

## Main findings

- selection and explicit actions appear to matter more than simple movement
- some important transitions still rely on inferred events
- confidence can become too high when layout changes are strong but intent signals are weak

## Suggested follow-up

- add explicit events for major user actions
- reduce the amount of guesswork in proposal weighting
- keep target and reference IDs cleanly separated

## Validation

- replay a known session
- compare behavior before and after changes
- keep desktop and Tauri checks in the loop
