# PARAM FORGE — External LLM Review Context

This document is meant to accompany a tarball of the repo so an outside LLM can review the product and codebase without prior context. The goal is to identify improvements that can make the product 10x more valuable.

## What is PARAM FORGE?
Param Forge is a local, terminal-first workbench for independent image-model experimenters who run prompts across providers, save reproducible receipts, and pick winners fast.

## Primary user need
Rapidly compare models/providers/params for a prompt, keep a reproducible paper trail, and iterate without writing a custom harness.

## Desired outcome of this review
Provide targeted feedback that leads to 10x improvements in:
- Time-to-decision (fast winner picking).
- Reproducibility (minimal, correct API call snippets).
- Insight density (cost + latency + quality signals at a glance).
- Demo/readability (a “run → view → pick → copy” narrative).

## Key flows
### Optimize (interactive)
- Entry point: `python scripts/param_forge.py`
- Steps: Mode → Provider → Model → Prompt → Size → Images per prompt → Output dir
- Generates images + receipts, then (optionally) analyzes and applies recommendations.
- Use the `view` command to open the local receipt viewer after interactive runs.
- Optional: user can opt into local run history to improve future Optimize recommendations.

### API Explore (interactive)
- UI label: "API Explore" (read-only parameter reference).
- Lets you browse provider/model params and cost notes without running a job.
- Prompts for provider/model selection to filter the reference list.

### Batch run (interactive + CLI)
- UI label: “Batch run” (select providers/models, size, concurrency, budgets).
- CLI subcommand: `python scripts/param_forge.py batch-run --prompts ... --matrix ... --out ...`
- Writes a `run.json` manifest that indexes every job/output.

### Receipt analysis & recommendations
- Analyzer choices: `anthropic`, `openai`, `council`.
- Council aggregates multiple LLMs and synthesizes a final recommendation.
- Recommendations are filtered to allowed settings per provider.

### Local receipt viewer
- Command: `python scripts/param_forge.py view outputs/param_forge`
- Generates a local HTML page with a grid view, side-by-side compare, winner picking, and “copy snippet”.

## Outputs and data contracts
### Receipt files
Receipts are JSON written next to images, e.g.:
```
outputs/param_forge/
  receipt-openai-20260106T181400Z-00.json
  openai-20260106T181400Z-00.jpg
```

The receipt schema (abbreviated) lives in:
- `scripts/forge_image_api/core/receipts.py`
- `scripts/forge_image_api/core/contracts.py`

Key receipt fields:
- `request`: prompt, size, n, model, provider options
- `resolved`: provider/model + resolved params
- `provider_request` / `provider_response`: sanitized
- `artifacts.image_path` / `artifacts.receipt_path`
- `result_metadata` (augmented post-run):
  - `render_seconds` (float)
  - `render_started_at` / `render_completed_at` (ISO strings)
  - `llm_scores` (adherence, quality, model)
  - `llm_retrieval` (optional)
  - `image_quality_metrics` (optional)

### Pricing reference
Used for cost estimates:
- `docs/pricing_reference.json`

## Important files & entry points
- `scripts/param_forge.py` — main CLI, interactive UI, analysis, receipt viewer
- `scripts/forge_image_api/api.py` — provider routing + receipt writing
- `scripts/forge_image_api/core/receipts.py` — receipt serialization
- `scripts/forge_image_api/core/contracts.py` — typed request/result contracts
- `docs/pricing_reference.json` — local cost reference
- `docs/experiment_mode_spec.md` — batch run spec (CLI subcommand: `batch-run`)

## What’s in scope for feedback
- UX and information architecture of the viewer (grid, compare, snippets, winners).
- Which metadata is most valuable to surface (cost, latency, scores).
- Prompt/analysis instructions and recommendation safety.
- Structure of receipts and run outputs.
- Any 10x value features that can be achieved without a hosted service.

## Known constraints / non-goals
- No cloud dashboard; everything is local.
- Batch run is local-only (no hosted scheduler).
- Providers are accessed via their official SDKs; user supplies API keys.

## Suggested focus for a “10x” review
- Reduce friction to pick a winner and copy a reproducible API call.
- Make comparisons obvious in <10 seconds for ~50 images.
- Enable demos that are “run → view → pick → copy snippet”.
- Identify missing metadata that would unlock huge gains.
