# Param Forge reference notes (for Brood)

This doc records the Param Forge receipt schema and loop patterns to mirror. It is based on the reference tarball in `param_forge_ref/` (see `scripts/forge_image_api/*`, `scripts/param_forge.py`, and `docs/`).

## Receipt schema (Param Forge)
Defined in `param_forge_ref/param_forge/scripts/forge_image_api/core/receipts.py` and `core/contracts.py`.

Top-level keys (schema_version = 1):
- `schema_version` (int)
- `request` (ImageRequest serialized)
  - prompt, mode, size, n, seed, output_format, background
  - inputs (init_image, mask, reference_images)
  - provider, provider_options, user, out_dir, stream, partial_images, model
  - metadata (free-form)
- `resolved` (ResolvedRequest serialized)
  - provider, model, size, width, height, output_format, background, seed, n
  - user, prompt, inputs, stream, partial_images
  - provider_params (provider-specific resolved params)
  - warnings
- `provider_request` (sanitized provider payload)
- `provider_response` (sanitized provider payload)
- `warnings` (list of strings)
- `artifacts`
  - image_path
  - receipt_path
- `result_metadata` (free-form; expanded post-run)

Observed `result_metadata` fields from Param Forge:
- `render_seconds` (float)
- `render_started_at` / `render_completed_at` (ISO strings; documented in `docs/llm_review_context.md`)
- `llm_scores` (object: adherence, quality, model, version)
- `llm_retrieval` (object: score, axes, packet, model, gated, gate_reasons)
- `image_quality_metrics` (object: metrics, gates, version)

Notes:
- Provider request/response are sanitized to omit raw image bytes.
- Receipts are immutable in intent, but Param Forge appends metadata fields after generation.

## Loop patterns to mirror

### 1) Interactive optimize loop (core UX)
Pattern in `scripts/param_forge.py`:
- Collect provider/model/size/params and prompt.
- Generate images + receipts.
- Post-run analysis (optional): LLM-based receipt analysis recommends param changes.
- Show diffs (settings + prompt) between current and recommended.
- User accepts or rejects recommendations; repeat if accepted.

Loop shape: `generate -> evaluate -> recommend -> accept -> regenerate`.

### 2) Batch run (plan -> execute -> resume)
Pattern in `docs/experiment_mode_spec.md`:
- Build a plan from prompts + matrix + limits.
- Write a run manifest (run.json) before execution.
- Execute with concurrency + budget enforcement.
- Resume by skipping completed jobs.

Loop shape: `plan -> execute -> summarize -> resume if needed`.

### 3) Viewer & winner selection
Pattern in `param_forge.py view`:
- Load receipts + manifest.
- Render grid, enable compare, winner pick, and copy snippet.
- Use receipts as the source of truth for prompt + params.

Loop shape: `browse -> compare -> select winner -> copy/branch`.

These patterns inform Brood's receipt-driven event stream, iterative agent loops, and deterministic versioning.
