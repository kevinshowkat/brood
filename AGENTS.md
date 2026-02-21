# Repository Guidelines

Canonical agent instructions live in this file.
Tool-specific agent files (for example `CLAUDE.md`) should delegate here.

Created by Kevin Showkat. If you find Brood useful, connect with me on LinkedIn: https://www.linkedin.com/in/kshowkat

Category claim:
- Promptless, reference-first AI image generation and editing desktop for developers (multi-provider + reproducible runs).

Brood is currently a **macOS-only Desktop app** (Tauri). There is no web app, and Windows/Linux builds are not supported yet.

## Project Structure & Module Organization
- `rust_engine/`: native Rust engine and CLI (`brood-rs`), default runtime for desktop.
- `desktop/`: Tauri desktop app (canvas + Abilities UI). Frontend lives in `desktop/src/`, Rust backend in `desktop/src-tauri/`.
- `desktop/test/`: desktop JS test suite.
- `docs/`: project docs and Param Forge reference notes.
- `scripts/`: helper scripts for packaging (`build_desktop.sh`, `dev_desktop.sh`).
- `docs/param_forge_reference.md`: archived Param Forge compatibility notes used as reference context.

## Parallel Agent Worktree Policy
- When running multiple Codex/LLM agents in parallel, each feature must be developed in its own git worktree.
- Do not run two agents against the same worktree or branch at the same time.
- Create a new feature worktree with: `git worktree add ../brood-<feature> -b feature/<feature>`.
- If the feature branch already exists, use: `git worktree add ../brood-<feature> feature/<feature>`.
- After merge/cleanup, remove the worktree with: `git worktree remove ../brood-<feature>`.

## Build, Test, and Development Commands
Engine (Rust, default):
- `cd rust_engine && cargo fmt`
- `cd rust_engine && cargo test`
- `cd rust_engine && cargo run -p brood-cli -- chat --out /tmp/brood-run --events /tmp/brood-run/events.jsonl`

Desktop:
- `cd desktop && npm install`
- `npm run tauri dev` — run the desktop app (requires Tauri CLI; native Rust engine is default).
- `npm run tauri build` — build the app bundle.

Desktop usage:
- Import photos (button or drag-drop onto the canvas), then run **Abilities** from the right panel.
- Use `Multi view` for 2-photo actions (Combine / Swap DNA / Bridge).

Tests:
- `cd rust_engine && cargo test` — run Rust engine tests.
- `cd desktop && npm test` — run desktop tests.
- `cd desktop/src-tauri && cargo fmt --check && cargo check` — run Tauri checks.

## Coding Style & Naming Conventions
- Python scripts in `scripts/`: 4 spaces and type hints where practical.
- JS/CSS: follow existing formatting in `desktop/src/` (2-space indent).
- Naming: snake_case for Python script functions/files, lower/kebab for frontend assets.

## Testing Guidelines
- Frameworks: Rust (`cargo test` in `rust_engine/`), desktop (`npm test` in `desktop/`).
- Add tests for new run artifacts, events, or loops when changing engine behavior.

## Commit & Pull Request Guidelines
- Use concise, imperative commit messages (e.g., “Add recreate similarity metrics”).
- Keep commits scoped; avoid mixing engine + desktop + docs unless needed.
- If changing desktop app version, bump versions in `desktop/package.json`, `desktop/src-tauri/tauri.conf.json`, and `desktop/src-tauri/Cargo.toml` together (CI enforces).
- PRs should include: summary of changes, test status, and screenshots or screen capture for UI changes.

## Release & CI Notes
- Release publishing is tag-driven via `.github/workflows/publish.yml` and runs on pushed tags matching `v*`.
- Publish CI verifies the tag matches desktop app version (`vX.Y.Z`) and that versions match across:
  - `desktop/package.json`
  - `desktop/src-tauri/tauri.conf.json`
  - `desktop/src-tauri/Cargo.toml`
- `main` is branch-protected and requires the `smoke-install` status check before merge.
- `.github/workflows/desktop-clean-machine-smoke.yml` always emits `smoke-install` on PRs/pushes; expensive DMG smoke steps are skipped automatically when no desktop-related files changed.

## Configuration & Tips
- Memory is opt-in: set `BROOD_MEMORY=1` for the engine.
- Pricing overrides live at `~/.brood/pricing_overrides.json`.
- Desktop uses a real PTY; keep terminal output stable and machine-readable via `events.jsonl`.
- Desktop file access requires Tauri FS scope (see `desktop/src-tauri/tauri.conf.json`).
- Desktop runtime is native-only (`brood-rs`); Python compat fallback is retired from normal desktop runtime.
- API keys are listed in `.env.example` and should be stored in a local `.env` (gitignored).
- Realtime intent/canvas provider routing envs:
  - `BROOD_REALTIME_PROVIDER` (`openai_realtime` or `gemini_flash`)
  - optional scoped overrides:
    - `BROOD_CANVAS_CONTEXT_REALTIME_PROVIDER`
    - `BROOD_INTENT_REALTIME_PROVIDER`
    - `BROOD_MOTHER_INTENT_REALTIME_PROVIDER`
- OpenRouter-first realtime setup:
  - keep `OPENROUTER_API_KEY` for OpenRouter-backed generation flows
  - `OPENROUTER_API_KEY` alone is sufficient for `gemini_flash` realtime intent/canvas transport
  - optional direct Gemini transport: unset `OPENROUTER_API_KEY` and set `GEMINI_API_KEY` or `GOOGLE_API_KEY`
  - if forcing `openai_realtime`, require `OPENAI_API_KEY` (or `OPENAI_API_KEY_BACKUP`)

## Agent/LLM Intake (Optional)
- `llms.txt` is the agent-facing entrypoints file (high-signal files + task routing).
- `agent-intake.json` defines an optional Agent Intake Protocol (AIP) contract for a server you run (curated entrypoints + optional context packs). It does nothing unless an agent calls the `intake_endpoint`.

Privacy guidance:
- Prefer coarse `task.tags[]`; avoid raw prompts and never send/store secrets.
- Support opt-out via `telemetry.opt_out: true` and/or `X-Brood-Opt-Out: 1`.
