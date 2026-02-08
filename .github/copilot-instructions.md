# GitHub Copilot Coding Agent Instructions (Brood)

Follow `AGENTS.md` for repo conventions, commands, and style.

## Intake / Discovery (Preferred)
- Read `llms.txt` first.
- If outbound HTTPS is allowed, call the Agent Intake Protocol (AIP) endpoint described in `agent-intake.json` to get curated entrypoints and optional context pack URLs.
- Use coarse `task.tags[]` from `agent-intake.json` (avoid raw prompts). Never send secrets.
- If AIP is unavailable, use `agent-intake.json` -> `fallback_entrypoints`.

## High-Signal Entry Points
- Engine CLI routing: `brood_engine/cli.py`
- Engine orchestration: `brood_engine/engine.py`
- Desktop canvas + Quick Actions: `desktop/src/canvas_app.js`
- Tauri backend + FS scope: `desktop/src-tauri/src/main.rs`, `desktop/src-tauri/tauri.conf.json`

## Validation
- Run `python -m pytest` for engine changes.
- Keep desktop terminal output stable and machine-readable via `events.jsonl`.
