# macOS Local and Private Image Editing

Brood is a macOS-only desktop app designed for local-first image workflows.

## Platform Scope

- Supported: macOS desktop (Tauri)
- Not supported: web app, Windows, Linux

## Local-First Runtime Model

- The app runs locally on your Mac.
- Session artifacts are written under `~/brood_runs/run-*`.
- API keys are stored locally in `.env` or `~/.brood/.env` based on your setup.

## What Stays Local

- Canvas state and session artifacts (`events.jsonl`, payload snapshots, receipts)
- Imported local file paths and generated output files in run directories

## What Goes To Providers

Only requests needed for selected model providers (OpenAI, Gemini, Imagen, Flux, etc.), based on your configured keys and runtime settings.

## Privacy-Oriented Workflow Tips

- Use a dedicated local run directory per project and archive completed runs.
- Rotate API keys and avoid sharing raw run folders outside your team.
- Keep automated telemetry opt-in and coarse-grained where possible.

## Operational Checks

- Verify Tauri file scope allows required local paths (`desktop/src-tauri/tauri.conf.json`).
- Confirm provider routing env vars before running production-sensitive sessions.

## See Also

- `README.md`
- `docs/desktop.md`
- `docs/benchmark-playbook.md`
