# Repository Guidelines

## Project Structure & Module Organization
- `brood_engine/`: core Python engine and CLI (providers, runs, memory, pricing, recreate, chat).
- `desktop/`: Tauri desktop app (xterm PTY + canvas UI). Frontend lives in `desktop/src/`, Rust backend in `desktop/src-tauri/`.
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
