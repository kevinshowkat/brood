# Product + Technical Spec: Target User Agentic Harness (v0)

Status: PRD draft (not implemented).

## Objective
Build a repeatable harness that simulates how real target users interact with Brood:
- import realistic photo sets,
- provide project context,
- use Mother + Abilities over multiple turns,
- log explicit "open pondering" questions each turn,
- produce scored, reproducible run artifacts.

## Feasibility Snapshot
Feasibility is high because the required primitives already exist:
- `brood chat --out ... --events ...` supports multi-turn interaction.
- Abilities already exist as slash commands (`/diagnose`, `/argue`, `/bridge`, `/swap_dna`, `/triforce`, etc.).
- `events.jsonl` is append-only and machine-readable.
- `brood_engine/harness` already handles deterministic multi-step experiment runs and telemetry patterns.

The missing piece is orchestration for persona-driven user behavior, not core model capability.

## v0 Scope
- Adapter: CLI-first (`brood chat` PTY) for speed and determinism.
- Persona + scenario pack input (JSON).
- Agentic turn loop with explicit reflection logging.
- Ability coverage tracking and stop conditions.
- Scorecard per scenario and aggregate report.

## Non-Goals (v0)
- Pixel-level desktop UI automation.
- Perfect simulation of human behavior.
- Using reflection text as hidden reasoning. Reflection is explicit, user-visible artifact data.

## Architecture
Components:
- Scenario pack loader: validates persona/scenario config.
- Session runner: executes one scenario against one persona.
- Chat adapter: sends utterances/commands to `brood chat`, tails `events.jsonl`.
- Policy layer: chooses next action from scenario goals + recent events.
- Reflection writer: writes explicit turn reflections to `reflections.jsonl`.
- Evaluator: computes success and rubric scores from artifacts/events/reflections.

Suggested code placement:
- `brood_engine/harness/user_sim.py` (core loop + data models)
- `scripts/target_user_harness.py` (CLI entrypoint)
- `docs/target_user_harness.schema.json` (config contract)

## Run Artifacts
For each scenario run:
- `session.json`: resolved persona/scenario/policy.
- `events.jsonl`: raw engine events (from Brood run dir).
- `transcript.jsonl`: adapter-level IO (`user_input`, `assistant_output`, `command`).
- `reflections.jsonl`: explicit per-turn pondering.
- `scorecard.json`: rubric + pass/fail result.
- `summary.json`: compact outcome for dashboarding.

## State Machine
States:
1. `init`
2. `start_chat`
3. `import_inputs`
4. `plan_turn`
5. `act`
6. `observe`
7. `reflect`
8. `score_checkpoint`
9. `done`
10. `error`

Transitions:
- `init -> start_chat` when scenario validates.
- `start_chat -> import_inputs` when PTY and events are live.
- `import_inputs -> plan_turn` after `/use` and required multi-image context setup.
- `plan_turn -> act` when next action is chosen.
- `act -> observe` after command/utterance dispatch.
- `observe -> reflect` after event delta window closes.
- `reflect -> score_checkpoint` every turn.
- `score_checkpoint -> plan_turn` while stop condition is unmet.
- `score_checkpoint -> done` on success, budget exhaustion, or max turns.
- Any state -> `error` on unrecoverable adapter/engine failure.

Stop conditions:
- Success criteria satisfied.
- `max_turns` reached.
- `max_cost_usd` reached.
- `max_runtime_s` reached.
- Consecutive failure threshold reached.

## Action Model
Two action forms are supported:
- `utterance`: natural language sent to Mother.
- `command`: explicit slash command to an Ability.

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

This keeps reasoning explicit and auditable.

## Scoring (v0)
Per scenario score is weighted:
- `goal_progress` (35%)
- `artifact_quality_proxy` (20%)
- `ability_usage_quality` (15%)
- `efficiency_cost_time` (15%)
- `resilience` (10%)
- `reflection_quality` (5%)

Pass gate:
- `goal_progress >= 0.7`
- at least one required ability used
- no fatal adapter errors

## Three Benchmark Scenarios (v0)
1. `drop_lookbook_rescue`
- Persona: indie streetwear founder.
- Inputs: 3 rough iPhone product/lifestyle photos.
- Goal: produce 2 hero images for a launch post in <12 turns.
- Required abilities: `diagnose`, `bridge` or `blend`, `argue`.

2. `tattoo_flash_direction_find`
- Persona: tattoo artist exploring a motif system.
- Inputs: 2 references + 1 sketch.
- Goal: produce one coherent "centroid" concept + rule extraction.
- Required abilities: `triforce`, `extract_rule`, `odd_one_out`.

3. `creator_thumbnail_pack`
- Persona: solo creator shipping a video by tonight.
- Inputs: selfie + screenshot + mood reference.
- Goal: produce 3 viable thumbnail candidates and select one direction.
- Required abilities: `swap_dna` or `bridge`, `diagnose`, `argue`.

Concrete sample config for these scenarios is in `docs/target_user_harness.scenarios.sample.json`.

## Rollout Plan
Phase 1 (engine-level):
- Implement CLI adapter and deterministic loop.
- Run scenario pack using dryrun and one live provider profile.

Phase 2 (evaluation hardening):
- Add score calibration and failure taxonomy.
- Add aggregate report for multi-run comparisons.

Phase 3 (desktop fidelity):
- Add optional desktop adapter for true upload/canvas flow parity.

## Risks and Mitigations
- Simulation drift from real users.
  Mitigation: calibrate scenario pack from real anonymized usage motifs.
- Agent over-optimizes rubric.
  Mitigation: separate actor policy from evaluator policy/model.
- Flaky provider/network responses.
  Mitigation: retries, bounded backoff, and deterministic seeds where possible.

## Acceptance Criteria
- Run all three benchmark scenarios from one JSON pack.
- Produce complete artifact bundle per scenario.
- Emit reflection record every turn.
- Generate deterministic summary for repeated seeded runs.
- Complete without manual intervention in CLI adapter mode.
