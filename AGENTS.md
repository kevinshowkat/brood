# Repository Guidelines

## Project Structure & Module Organization
- `brood_engine/`: core Python engine and CLI (providers, runs, memory, pricing, recreate, chat).
- `desktop/`: Tauri desktop app (canvas + Quick Actions UI). Frontend lives in `desktop/src/`, Rust backend in `desktop/src-tauri/`.
- `tests/`: pytest suite for engine components.
- `docs/`: project docs and Param Forge reference notes.
- `scripts/`: helper scripts for packaging (`build_engine.sh`, `dev_desktop.sh`).
- `param_forge_ref/`: reference codebase (read-only; keep as input/compatibility reference).

## Build, Test, and Development Commands
Engine:
- `python -m venv .venv && source .venv/bin/activate`
- `pip install -e .` — install the engine locally.
- `brood chat --out /tmp/brood-run --events /tmp/brood-run/events.jsonl` — interactive CLI.
- `brood recreate --reference <image> --out /tmp/brood-recreate` — recreate flow.

Desktop:
- `cd desktop && npm install`
- `npm run tauri dev` — run the desktop app (requires Tauri CLI).
- `npm run tauri build` — build the app bundle.

Desktop usage:
- Import photos (button or drag-drop onto the canvas), then run **Quick Actions** from the right panel.
- Use `Multi view` for 2-photo actions (Combine / Swap DNA / Bridge / Argue).
- `Diagnose` / `Argue` output prints in the bottom HUD as `DIAG` / `ARG`.

Tests:
- `python -m pytest` — run all engine tests.

## Coding Style & Naming Conventions
- Python: 4 spaces; prefer type hints; line length ~100 (see `pyproject.toml`).
- JS/CSS: follow existing formatting in `desktop/src/` (2-space indent).
- Naming: snake_case for Python functions/files, lower/kebab for frontend assets.

## Testing Guidelines
- Framework: `pytest` in `tests/`.
- Test naming: `tests/test_*.py` with descriptive function names (e.g., `test_context_tracker_alerts`).
- Add tests for new run artifacts, events, or loops when changing engine behavior.

## Commit & Pull Request Guidelines
- Git history currently has only an initial commit; no established convention yet.
- Use concise, imperative commit messages (e.g., “Add recreate similarity metrics”).
- PRs should include: summary of changes, test status, and screenshots or screen capture for UI changes.

## Configuration & Tips
- Memory is opt-in: set `BROOD_MEMORY=1` for the engine.
- Pricing overrides live at `~/.brood/pricing_overrides.json`.
- Desktop uses a real PTY; keep terminal output stable and machine-readable via `events.jsonl`.
- Desktop file access requires Tauri FS scope (see `desktop/src-tauri/tauri.conf.json`).
- API keys are listed in `.env.example` and should be stored in a local `.env` (gitignored).

## Agent/LLM Intake (Optional)
- `llms.txt` is the agent-facing entrypoints file (high-signal files + task routing).
- `agent-intake.json` defines an optional Agent Intake Protocol (AIP) contract for a server you run (curated entrypoints + optional context packs). It does nothing unless an agent calls the `intake_endpoint`.

Local test (stdlib-only):
- Build packs: `python3 scripts/aip_build_packs.py --all --out-dir outputs/aip_packs --write-index`
- Run stub server: `python3 scripts/aip_server.py --port 8787 --packs-dir outputs/aip_packs`

Privacy guidance:
- Prefer coarse `task.tags[]`; avoid raw prompts and never send/store secrets.
- Support opt-out via `telemetry.opt_out: true` and/or `X-Brood-Opt-Out: 1`.
