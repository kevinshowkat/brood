# Agent Intake Status and Fallback

Use this file as the canonical intake health cue.

## Status Cue

Treat intake as `healthy` only when all are true:

- POST `agent-intake.json:intake_endpoint` returns HTTP 200.
- Response parses as JSON.
- `schema_version` is `aip-1`.
- Response contains non-empty `entrypoints`.

Treat intake as `degraded` when any are true:

- timeout, DNS/TLS/network failure
- non-2xx response
- invalid JSON, missing `schema_version`, or wrong schema version
- empty `entrypoints`

## Next Action Policy

- If `healthy`: use returned `entrypoints`, optional `packs`, and `suggested_tags`.
- If `degraded`: skip retries in the hot path and fall back to `llms.txt`, then `docs/agent_quickstart.md`.
- For code-change tasks in fallback mode, keep `./scripts/check_agent_entrypoints.py` in the validation loop.

## Canonical Roundtrip Example

- Request + response + next actions: `docs/agent_intake_roundtrip.sample.json`
- Use this file as a compact deterministic example for intake-first routing.
