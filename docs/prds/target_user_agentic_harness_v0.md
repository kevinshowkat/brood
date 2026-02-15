# Product + Technical Spec: Target User Usability Harness (v0)

Status: PRD draft (not implemented).

## Objective
Build a repeatable harness that simulates a target-user usability panel to surface pain points before human testing:
- import realistic photo sets,
- provide project context and constraints,
- drive Mother + Abilities over multiple turns,
- capture explicit "open pondering" and friction observations each turn,
- take UI screenshot evidence at key junctures so simulated users can react to visible state,
- produce scored, reproducible run artifacts with clustered pain-point evidence.

This harness is not a replacement for live user interviews; it is a pre-screening signal generator for likely UX friction in common scenarios.

## Screenshot Requirement (Required)
- Every turn is driven by a screenshot captured from the app state.
- The simulator chooses actions from the latest image + events, not from hidden internal state alone.
- Screenshot paths are immutable and versioned in run artifacts.
- Reflection records must include which screenshot drove the decision and what changed since last capture.

## Usability Framing
The harness should answer:
- Where do users stall or issue repeated fallback instructions?
- Which abilities are difficult to discover or sequence correctly?
- Which steps cause avoidable retries, confusion, or explicit user uncertainty?
- What error or ambiguity patterns recur across personas and scenarios?
- Which interface actions are too slow or feel fragile for target workflows?

## Feasibility Snapshot
Feasibility is high because the required primitives already exist:
- `brood chat --out ... --events ...` supports multi-turn interaction.
- Abilities already exist as slash commands (`/diagnose`, `/argue`, `/bridge`, `/swap_dna`, `/triforce`, etc.).
- `events.jsonl` is append-only and machine-readable.
- `brood_engine/harness` already handles deterministic multi-step experiment runs and telemetry patterns.
- `desktop/src/canvas_app.js` already has snapshot capture helpers that write image files under `runDir` for intent/inference flows.

The missing piece is orchestration for persona-driven user behavior and pain extraction, not core model capability.

## v0 Scope
- Adapter: CLI-first (`brood chat` PTY) for speed and determinism.
- Persona + scenario pack input (JSON) with explicit usability hypotheses and expected friction points.
- Agentic turn loop with explicit reflection logging.
- Pain-point capture and severity scoring as first-class output.
- Ability coverage tracking and stop conditions.
- Scorecard per scenario and aggregate usability report.
- Key-juncture screenshot capture and reaction coupling.

## Proposed Pain Output Contract
Every scenario run should produce:
- A per-turn friction stream with structured tags.
- A scenario-level pain summary grouped by category.
- Actionable mitigations where confidence allows, as suggestions for backlog triage.

## Non-Goals (v0)
- Pixel-perfect desktop UI automation (v0 supports coarse scripted UI gestures only).
- Perfect simulation of human behavior.
- Using reflection text as hidden reasoning. Reflection is explicit, user-visible artifact data.

## Pain Taxonomy (v0)
- `discoverability`: user does not know which ability or flow to use next.
- `intent_ambiguity`: unclear how to translate goal into a command.
- `setup_friction`: import/context/setup actions are too cumbersome.
- `error_recovery`: recoveries from provider or ability failures are slow/confusing.
- `control_confidence`: user is uncertain whether output matches goal.
- `speed_timing`: waiting or latency creates stress.
- `sequence_break`: user cannot compose a correct multi-step sequence.
- `output_quality_gap`: produced results are off-spec and require multiple retries.
- `handoff_confusion`: user is unsure how to continue after an intermediate output.

## Architecture
Components:
- Scenario pack loader: validates persona/scenario config.
- Session runner: executes one scenario against one persona.
- Chat adapter: sends utterances/commands to `brood chat`, tails `events.jsonl`.
- Screenshot adapter: captures, versions, and records app screenshots for each turn.
- Policy layer: chooses next action from scenario goals + recent events + latest screenshot.
- Reflection writer: writes explicit turn reflections to `reflections.jsonl` with pain tags.
- Pain extractor: normalizes and validates friction observations and aggregates them by scenario.
- Evaluator: computes success and rubric scores from artifacts/events/reflections.

Suggested code placement:
- `brood_engine/harness/user_sim.py` (core loop + data models)
- `scripts/target_user_harness.py` (CLI entrypoint)
- `docs/target_user_harness.schema.json` (config contract)
- `docs/target_user_harness_pain.schema.json` (if formalized later for shared validator usage)

## Run Artifacts
For each scenario run:
- `session.json`: resolved persona/scenario/policy.
- `events.jsonl`: raw engine events (from Brood run dir).
- `transcript.jsonl`: adapter-level IO (`user_input`, `assistant_output`, `command`).
- `screenshots.jsonl`: ordered screenshot events (`phase`, `path`, `turn`, `pre_or_post`).
- `reflections.jsonl`: explicit per-turn pondering.
- `pain_points.jsonl`: structured friction annotations with taxonomy tags + severity.
- `scorecard.json`: rubric + pass/fail result.
- `summary.json`: compact outcome for dashboarding.
- `usability_report.md`: concise, human-readable pain-point review and priority list.

Across the full harness invocation:
- `ux_improvements.md`: prioritized cross-scenario UX improvements with evidence counts and suggested success metrics.
- `ten_x_competitive_edge.md`: candidate feature bets and problem-solving angles that could create a 10x competitive advantage.

## State Machine
States:
1. `init`
2. `capture_snapshot`
3. `start_chat`
4. `import_inputs`
5. `plan_turn`
6. `act`
7. `observe`
8. `reflect`
9. `score_checkpoint`
10. `done`
11. `error`

Transitions:
- `init -> capture_snapshot` for initial baseline screenshot.
- `capture_snapshot -> start_chat` when scenario initializes and screenshot is saved.
- `start_chat -> import_inputs` when PTY and events are live.
- `import_inputs -> capture_snapshot` before turn planning begins.
- `capture_snapshot -> plan_turn` after bootstrap imports are reflected in UI.
- `plan_turn -> act` when next action is chosen.
- `act -> capture_snapshot` immediately after dispatch.
- `capture_snapshot -> observe` after screenshot write.
- `observe -> reflect` after event delta window closes.
- `reflect -> capture_snapshot` before next action (except terminal states).
- `capture_snapshot -> score_checkpoint` when scenario is done or failed.
- `score_checkpoint -> plan_turn` while stop condition is unmet.
- `score_checkpoint -> done` on success, budget exhaustion, or max turns.
- Any state -> `error` on unrecoverable adapter/engine failure.

Screenshot policy:
- Capture `pre_action` and `post_action` in each turn where available.
- Capture mandatory junctions: boot, import completion, generation completion, failure branch, and completion.
- In CLI mode, default capture strategy is `auto`: source-dir image, then live macOS window capture, then synthetic fallback.

Stop conditions:
- Success criteria satisfied.
- `max_turns` reached.
- `max_cost_usd` reached.
- `max_runtime_s` reached.
- Consecutive failure threshold reached.

## Action Model
Three action forms are supported:
- `utterance`: natural language sent to Mother.
- `command`: explicit slash command to an Ability.
- `ui`: coarse desktop interaction (for `desktop_ui` adapter), such as focus, click, drag, keystroke, and wait.
  - Includes Mother controls: `mother_next_proposal`, `mother_confirm_suggestion`, `mother_reject_suggestion`.

Supported `command.name` in v0:
- `use`
- `diagnose`
- `describe`
- `canvas_context`
- `blend`
- `bridge`
- `swap_dna`
- `argue`
- `extract_rule`
- `odd_one_out`
- `triforce`
- `recast`
- `quality`
- `fast`
- `cheaper`
- `better`

Interpretation:
- Use `utterance` when simulating ambiguous user intent.
- Use `command` when simulating power-user behavior and explicit Ability invocation.
- Use `ui` when you need visible interaction traces (e.g., clicking canvas controls, moving images) before screenshot capture.
- `ui` actions are treated as setup/interaction steps and do not consume `max_turns`; `max_turns` gates chat/command turns.

## Open Pondering Contract
Each turn must write one reflection record:
- `turn`: integer
- `action_taken`: normalized action record
- `observed_signals`: key events/artifacts in that turn
- `what_worked`: short text
- `what_failed`: short text
- `open_questions`: array of unresolved user-style questions
- `next_hypothesis`: what the simulated user will try next
- `confidence`: float `0.0..1.0`
- `screenshot_path`: screenshot used for reasoning.
- `screenshot_phase`: `pre_action` or `post_action`
- `screenshot_delta`: list of notable visual changes.
- `pain_points`: array of objects
  - `category`: one of the taxonomy values
  - `severity`: `0.0..1.0`
  - `symptom`: short sentence describing user pain
  - `evidence`: event/event-id references or transcript snippets
  - `likely_cause`: optional diagnosis hypothesis
- `mitigation_hint`: suggested improvement to reduce this pain in one sentence

This keeps usability issues explicit, auditable, and easy to triage across scenarios.

## Scoring (v0)
Per scenario score is weighted:
- `goal_progress` (35%)
- `artifact_quality_proxy` (20%)
- `ability_usage_quality` (12%)
- `efficiency_cost_time` (12%)
- `resilience` (8%)
- `reflection_quality` (5%)
- `friction_profile` (18%)

`friction_profile` is derived from:
- weighted pain-point severity per scenario,
- pain recurrence on unresolved questions,
- count of distinct taxonomy categories triggered.

Pass gate:
- `goal_progress >= 0.7`
- at least one required ability used
- no fatal adapter errors
- `friction_profile >= 0.6` (higher is better; pain-adjusted score)

## Benchmark Scenarios (v0)
1. `image_feature_regression_triage`
- Persona: product engineer shipping in-app image features.
- Inputs: source image + failing release output + target reference.
- Goal: isolate likely failure causes and produce one improved direction.
- Required abilities: `diagnose`, `canvas_context`, `argue`.
- Likely pain targets: `error_recovery`, `intent_ambiguity`, `sequence_break`.

2. `creative_direction_iteration_lane`
- Persona: creative technologist / design-infra operator.
- Inputs: primary subject + two style references.
- Goal: create two distinct directions, then select one production-safe path.
- Required abilities: `swap_dna`, `bridge`, `argue`.
- Likely pain targets: `discoverability`, `control_confidence`, `output_quality_gap`.

3. `multi_provider_cost_reliability_sweep`
- Persona: AI agency/studio ops lead.
- Inputs: client source + campaign reference + known baseline output.
- Goal: produce a client-ready output and a cheaper fallback path.
- Required abilities: `cheaper`, `blend`, `argue`.
- Likely pain targets: `speed_timing`, `output_quality_gap`, `handoff_confusion`.

4. `agent_intake_discoverability_check` (secondary but intentional)
- Persona: founder/devrel owner optimizing agent discoverability.
- Inputs: screenshots of `llms.txt` entrypoints, intake contract, visibility probe.
- Goal: validate what an external agent can infer and identify one doc improvement.
- Required abilities: `describe`, `canvas_context`, `extract_rule`.
- Likely pain targets: `discoverability`, `intent_ambiguity`, `setup_friction`.

## Rollout Plan
Phase 1 (engine-level):
- Implement CLI adapter and deterministic loop.
- Add screenshot-aware transcript/transition model and dryrun policy.
- Run scenario pack using dryrun and one live provider profile.

Phase 2 (evaluation hardening):
- Add score calibration and failure taxonomy.
- Add aggregate report for multi-run comparisons and recurring pain clusters.
- Add screenshot integrity checks and screenshot-derived reaction evidence.

Phase 3 (desktop fidelity):
- Ship desktop adapter that captures live app screenshots at each transition state.
- Add deterministic desktop playback harness and comparison snapshots.

## Risks and Mitigations
- Simulation drift from real users.
  Mitigation: calibrate scenario pack from real anonymized usage motifs.
- Agent over-optimizes rubric.
  Mitigation: separate actor policy from evaluator policy/model.
- Flaky provider/network responses.
  Mitigation: retries, bounded backoff, and deterministic seeds where possible.

## Acceptance Criteria
- Run all benchmark scenarios from one JSON pack.
- Produce complete artifact bundle per scenario.
- Emit structured pain record each turn, including screenshot evidence fields.
- Generate deterministic summary for repeated seeded runs.
- Aggregate recurring pain themes into a usability summary with severity ranking.
- Capture all required screenshots with stable filenames and references.
- Complete without manual intervention in desktop adapter mode.
