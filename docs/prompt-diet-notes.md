# Prompt Diet Notes

Status: draft

## Summary

This note tracks a cleanup of Mother generation prompts.

The goal is simple:
- keep prompt text short
- keep more decision data in structured fields
- move fallback handling out of natural-language prompt text

## Current issue

Some prompts repeat rules that already exist in metadata. That makes runs harder to read and compare.

## Target state

- short prompt text
- structured metadata for the detailed control data
- runtime retries for fallback behavior

## Main files

- `desktop/src/canvas_app.js`
- `rust_engine/crates/brood-cli/src/main.rs`
- `rust_engine/crates/brood-engine/src/lib.rs`

## Checks

- prompt text should get shorter
- required constraints should still reach every provider path
- run artifacts should stay easy to inspect
