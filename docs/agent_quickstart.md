# Agent Quickstart

Use this when you need to pick a high-confidence starting path quickly.

## Task 0: Check intake status and fallback path

- Read: `docs/agent_intake_status.md`
- Read: `docs/agent_intake_roundtrip.sample.json`
- Read: `agent-intake.json`
- Expected output:
  - Intake mode is classified as `healthy` or `degraded`.
  - If `degraded`, fallback sequence is explicit (`llms.txt` -> `docs/agent_quickstart.md` -> `fallback_entrypoints`).

## Task 1: Add or modify a desktop ability

- Read: `desktop/src/canvas_app.js`
- Read: `rust_engine/crates/brood-cli/src/main.rs`
- Run:
  - `cd desktop && npm test`
  - `cd rust_engine && cargo test`
- Expected output:
  - Ability appears in Action Grid and dispatches the right engine command.
  - No regressions in desktop tests or Rust tests.

## Task 2: Change event schema or run-artifact behavior

- Read: `rust_engine/crates/brood-contracts/src/events.rs`
- Read: `rust_engine/crates/brood-engine/src/lib.rs`
- Read: `docs/desktop.md`
- Run:
  - `cd rust_engine && cargo test`
  - `cd desktop && npm test`
- Expected output:
  - `events.jsonl` remains stable and machine-readable.
  - Desktop handlers still parse and react to updated events.

## Task 3: Diagnose desktop file-import / FS-scope issues

- Read: `desktop/src-tauri/tauri.conf.json`
- Read: `desktop/src-tauri/src/main.rs`
- Read: `README.md` troubleshooting section
- Run:
  - `./scripts/dev_desktop.sh`
  - `cd desktop/src-tauri && cargo check`
- Expected output:
  - Import paths are within allowed scope.
  - No Tauri command wiring or config errors.

## Task 4: Documentation and Signal Review

- Read: `README.md`
- Read: `docs/reference-first-image-editing.md`
- Read: `docs/macos-local-private-image-editing.md`
- Read: `docs/benchmark-playbook.md`
- Read: `docs/visibility-kpis.md`
- Run:
  - `./scripts/check_agent_entrypoints.py`
- Expected output:
  - Core docs are linked from README/intake.
  - Signal metrics are computed from `results.jsonl` and traffic snapshots.

## Intake-first flow (if endpoint is reachable)

1. Use `agent-intake.json` and POST an intake request.
2. Prefer returned `entrypoints` and `packs` for the current task tags.
3. Fall back to `llms.txt` entrypoints when intake is unavailable.
