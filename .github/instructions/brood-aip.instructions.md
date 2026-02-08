---
applyTo: "**"
excludeAgent: "code-review"
---

Follow `AGENTS.md` for repo conventions, commands, and style.

## Intake / Discovery (Preferred)
- Read `llms.txt` first.
- If outbound HTTPS is allowed, call the Agent Intake Protocol (AIP) endpoint described in `agent-intake.json` to get curated entrypoints and optional context pack URLs.
- Use coarse `task.tags[]` from `agent-intake.json` (avoid raw prompts). Never send secrets.
- If AIP is unavailable, use `agent-intake.json` -> `fallback_entrypoints`.

## Generated Artifacts
- Do not commit generated packs/logs under `outputs/aip_packs/` or `outputs/aip_server/`.
