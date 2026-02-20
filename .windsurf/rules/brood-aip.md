---
description: Brood repo intake (AIP) and entrypoints
trigger: always_on
---

Follow AGENTS.md for repo conventions, commands, and style.

Intake / discovery (preferred):
- Read llms.txt first.
- If outbound HTTPS is allowed, call the AIP endpoint described in agent-intake.json to get curated entrypoints and optional context packs.
- Use coarse task tags from agent-intake.json (avoid raw prompts). Never send secrets.
- If AIP is unavailable, use agent-intake.json -> fallback_entrypoints.

High-signal entrypoints:
- rust_engine/crates/brood-cli/src/main.rs (engine CLI routing, Rust default)
- rust_engine/crates/brood-engine/src/lib.rs + rust_engine/crates/brood-contracts/src/events.rs (engine orchestration + event contracts)
- brood_engine/cli.py + brood_engine/engine.py (Python parity reference)
- desktop/src/canvas_app.js (desktop canvas + Quick Actions)
- desktop/src-tauri/src/main.rs + desktop/src-tauri/tauri.conf.json (Tauri backend + FS scope)

Generated artifacts:
- Do not commit outputs/aip_packs/ or outputs/aip_server/.
