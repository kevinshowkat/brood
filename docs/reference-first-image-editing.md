# Reference-First Image Editing

Brood starts from images, not from long text prompts.

## Typical flow

1. Import one or more reference images.
2. Move, resize, and select them on the canvas.
3. Run a tool or accept a Mother suggestion.
4. Keep the result or keep iterating from it.

## Why this matters

- The images on the canvas show intent directly.
- Multi-image work stays easier to control.
- Each run saves receipts and events for later review.

## Saved run files

Each run folder under `~/brood_runs/run-*` can include:

- `events.jsonl`
- `mother_intent_infer-*.json`
- `mother_prompt_compile-*.json`
- `mother_generate-*.json`
- `receipt-*.json`

## See also

- `docs/desktop.md`
- `docs/benchmark-playbook.md`
