# Reference-First Image Editing

Brood is built for reference-first image editing: you start from real images, not long prompts.

## Who This Is For

- Developers shipping image workflows inside products
- Creative technologists running fast concept/variant loops
- Teams that need consistent brand variants from existing assets

## Core Job To Be Done

Turn existing brand/reference images into many high-quality creative variants quickly, without prompt engineering.

## How It Works In Brood

1. Import one or more reference images.
2. Arrange, resize, and select to express intent on canvas.
3. Use abilities (`Combine`, `Swap DNA`, `Bridge`, `Extract DNA`, `Soul Leech`) or accept Mother proposals.
4. Keep or reject results; iterate from committed outputs.

## Why Reference-First Matters

- Better control: image relationships are explicit (target/reference/selection state).
- Faster iteration: intent comes from canvas actions, not repeated prompt rewrites.
- Better reproducibility: run artifacts and events are stored per session.

## Reproducibility Artifacts

Each run writes to `~/brood_runs/run-*` with:

- `events.jsonl`
- payload snapshots (`mother_intent_infer-*.json`, `mother_prompt_compile-*.json`, `mother_generate-*.json`)
- `receipt-*.json`

## See Also

- `docs/desktop.md`
- `docs/benchmark-playbook.md`
