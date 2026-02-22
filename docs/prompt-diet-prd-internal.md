# Internal PRD: Prompt Diet (Image-First Generation)

Status: Draft  
Owner: Desktop + Engine  
Last updated: 2026-02-21

## Summary

Brood should let images do most of the instruction work. Today, Mother generation prompts contain too much natural-language policy (especially shot/lighting fallbacks and repeated constraints). This PRD proposes a prompt-diet architecture: move policy decisions into realtime intent + context envelopes, keep prompt text minimal, and run fallback behavior in runtime logic instead of `if/then` prose.

## Problem

Current prompt assembly is verbose and mixes concerns:

- Prompt text includes policy/fallback logic (`if subject weak, try alternate shot/lighting`).
- Prompt text often repeats rules already present in structured metadata.
- Constraints can be duplicated (`Avoid` + `MUST` + compile constraints).
- Long prompts reduce clarity, increase token usage, and make provider behavior less predictable.

Result: harder tuning, noisier runs, and weaker image-first behavior.

## Goals

1. Make prompt text minimal and declarative.
2. Keep decision logic in structured intent/envelope fields.
3. Preserve or improve generation quality and acceptance rate.
4. Reduce prompt size and repetition without losing constraints.
5. Keep multi-provider behavior safe (Gemini + non-Gemini).

## Non-Goals

- Replacing realtime intent inference.
- Removing context envelopes.
- Introducing a new UI surface for prompt editing.
- Provider-specific model retraining or fine-tuning.

## Product Principles

1. Envelope decides, prompt declares.
2. One primary cue per axis (shot, lighting, lens) in prompt text.
3. Fallbacks are runtime strategy, not natural-language prose.
4. Structured constraints should be authoritative; prompt mirrors only essential pieces.
5. Default behavior should be image-first and concise.

## Proposed Design

## 1) Keep rich policy in structured metadata

Primary location:

- `gemini_context_packet.proposal_lock`
- `gemini_context_packet.shot_type_hints`
- `model_context_envelopes.*`

These fields remain detailed (primary + alternate shot/lighting/lens + confidence + rationale).

## 2) Prompt Diet format (default path)

Build a short prompt block with only:

1. Transformation mode
2. Intent objective summary
3. Primary composition/camera/lighting directives
4. Minimal constraints (top N hard constraints)

No conditional language (`if ... then ...`) in prompt text.

Example shape:

```text
Mode: mythologize.
Objective: elevate scene into heroic, photoreal storytelling.
Shot: low-angle hero shot.
Lighting: high-contrast directional key with rim backlight and atmospheric haze.
Lens: 24-35mm low-angle heroic perspective.
Constraints: no text/logos/watermarks; coherent anatomy; no ghost overlays.
```

## 3) Runtime fallback loop

Fallback behavior moves to runtime policy:

1. Attempt A: primary shot/lighting/lens from envelope.
2. Evaluate output against existing quality checks.
3. If fail and retry budget exists, run Attempt B with alternate cues from envelope.

This keeps prompt prose stable while still benefiting from alternate creative policy.

## 4) Constraint simplification

- Keep hard constraints capped (for example top 3-6).
- Deduplicate overlaps between compile constraints, negative prompt, and envelope must-not.
- Ensure non-Gemini providers still receive required constraints through supported payload paths.

## 5) Provider safety

- Gemini: consumes packet + concise prompt.
- Non-Gemini: concise prompt plus provider envelope/fields where supported.
- If provider cannot consume structured constraints, inject required constraints directly (without re-expanding into verbose prose).

## Implementation Scope

Primary files:

- `desktop/src/canvas_app.js`
  - `motherV2CompilePromptLocal`
  - `motherV2BuildPromptComposerResult`
  - shot/lighting/lens cue assembly paths
- `rust_engine/crates/brood-cli/src/main.rs`
  - generation retry policy hooks (if needed for alternate-cue rerun)
- `rust_engine/crates/brood-engine/src/lib.rs`
  - provider-safe constraint routing

Docs/tests:

- Add tests for prompt length, zero conditional fallback text, and fallback retry behavior.
- Update benchmark playbook references for prompt-size and acceptance tracking.

## Rollout Plan

## Phase 0: Instrument only

- Track prompt length metrics (chars/tokens) by model and strategy.
- Track fallback usage and attempt count.

## Phase 1: Prompt Diet v1 (behind flag)

- Feature flag: `BROOD_PROMPT_DIET=1` (or equivalent settings key).
- Remove conditional fallback phrases from prompt text.
- Keep full envelope metadata unchanged.

## Phase 2: Runtime fallback ownership

- Execute alternates only in runtime retry path.
- Keep prompt static between attempts except selected cue set.

## Phase 3: Default on

- Make prompt-diet default if quality and acceptance metrics are neutral or improved.
- Keep emergency fallback toggle to legacy verbose mode.

## Success Metrics

Primary:

- Prompt length reduction (P50/P95 chars or tokens) by at least 40%.
- No drop in Mother acceptance rate.
- No increase in obvious regression categories (anatomy/text artifacts/identity drift).

Secondary:

- Lower cost per successful accepted generation.
- Reduced reroll rate for the same intent.
- Faster operator debugging (clearer payloads, less duplicated text).

## Risks and Mitigations

1. Risk: too little text reduces provider adherence.  
Mitigation: keep hard constraints in provider-compatible fields; fallback to direct injection only where required.

2. Risk: alternate policy not applied consistently.  
Mitigation: explicit runtime retry state and event logging for cue-set A/B.

3. Risk: non-Gemini regression.  
Mitigation: regression tests ensuring required constraints reach non-Gemini paths.

## Acceptance Criteria

1. Prompt text contains no `if/then` fallback phrasing for shot/lighting/lens.
2. Primary cue set appears at top of prompt.
3. Alternates are available in metadata and used only by retry logic.
4. Non-Gemini constraint path remains intact (no dropped must-not constraints).
5. Benchmarks show prompt-size reduction and no quality regression at comparable settings.

## Open Questions

1. Should fallback attempt happen automatically once, or only on explicit reroll?
2. Which quality gate should trigger alternate cues (provider response quality signal vs post-check heuristics)?
3. Should prompt-diet apply to all abilities immediately, or Mother-first then expand?

