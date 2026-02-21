# Benchmark Playbook

Use this playbook to publish reproducible benchmark artifacts that agents can cite.

## Goal

Show reliable evidence for this workflow:

- input reference images
- context capture
- proposal generation
- artifact output
- final acceptance/rejection

## Benchmark Table Template

| Run ID | Scenario | Inputs | Key Actions Covered | Model(s) | Median Latency (s) | Accept Rate (%) | Notes |
|---|---|---|---|---|---:|---:|---|
| `run-...` | `two-image-dna-apply` | 2 images | `image_add`, `dna_extract`, `dna_apply`, `mother_accept` | `...` | ... | ... | ... |
| `run-...` | `three-image-hybridize` | 3 images | `image_add`, `canvas_mode_change`, `mother_offer_visible`, `mother_accept` | `...` | ... | ... | ... |

## Required Artifact Links Per Row

- `events.jsonl`
- key payloads (`mother_intent_infer-*.json`, `mother_prompt_compile-*.json`, `mother_generate-*.json`)
- output artifact files
- short run summary (what passed/failed)

## Consistency Checks

- Event coverage for key actions is explicit, not inferred-only.
- `target_id`/`reference_ids` in operation data are reconstructable from logs.
- Proposal lifecycle is complete (`offer_visible` -> `accept/reject`).

## Suggested Weekly Cadence

1. Run fixed scenario set.
2. Append benchmark rows.
3. Publish updated artifact links.
4. Track KPI deltas (see `docs/visibility-kpis.md`).

## See Also

- `docs/visibility-kpis.md`
- `docs/realtime_canvas_intent_generation_flow.md`
