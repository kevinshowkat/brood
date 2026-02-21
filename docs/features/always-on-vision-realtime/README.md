# Always-On Vision (Realtime, Persistent Session)

## Problem
The baseline Always-On Vision feature extracts "Canvas Context" by making a fresh batch vision request for each
snapshot. That works, but it adds latency and doesn't stream incremental context.

This feature implements the "Option 2" design: a provider-routed realtime session that ingests an
optimized canvas snapshot in the background and streams back Canvas Context continuously, without blocking
foreground UX.

## UX
- Settings includes an **Always-On Vision** toggle and a **Canvas Context** readout.
- When enabled:
  - Readout shows `Connecting…` while the realtime session comes up.
  - Periodically (idle + throttled), Brood captures a small collage snapshot and sends it to the realtime session.
  - Readout shows `ANALYZING…` during the request, then fills with streaming text as it arrives.
- On fatal failures (missing keys, network/API error):
  - Readout shows `DISABLED: <reason>`.
  - The always-on loop is stopped to avoid silent thrashing.

Note: `/canvas_context` still exists as the batch (Responses API) implementation. Realtime models are never
called via `/responses`.

## Implementation
### Desktop
Primary file: `desktop/src/canvas_app.js`

- Snapshot generation is unchanged:
  - up to 6 images collaged into a 900px-max PNG at `runDir/alwayson-<ts>.png`.
  - tokenized extraction sources (`Extract DNA` / `Soul Leech`) are excluded from visible-image snapshots until consumed.
  - DNA/Soul glyphs are Pixi-overlay visuals and are not baked into the work-canvas snapshot.
- Dispatch:
  - start session: `/canvas_context_rt_start`
  - send snapshot: `/canvas_context_rt <snapshotPath>`
  - stop session: `/canvas_context_rt_stop`
- Gating:
  - the loop is debounced + throttled and refuses to run while foreground actions or the action queue are active.
- Readout states:
  - Off
  - Connecting…
  - ANALYZING…
  - Last streamed text (clipped in the drawer)
  - Fatal error disables the loop and shows `DISABLED: ...`

### Engine
Primary files:
- `rust_engine/crates/brood-contracts/src/chat/intent_parser.rs` (new slash intents)
- `rust_engine/crates/brood-cli/src/main.rs` (handlers + background realtime session worker)

Slash commands:
- `/canvas_context_rt_start`
  - Validates config (keys, kill switch, dependency), then starts a background thread.
- `/canvas_context_rt <path>`
  - Enqueues a snapshot job for the background thread (non-blocking).
  - `openai_realtime` provider: uses a persistent Realtime WebSocket session and streams deltas.
  - `gemini_flash` provider:
    - prefers OpenRouter `responses` first (with `chat/completions` fallback) when `OPENROUTER_API_KEY` is present
    - otherwise uses per-snapshot Gemini `generateContent` when `GEMINI_API_KEY`/`GOOGLE_API_KEY` is present
    - emits finalized `canvas_context` payloads.
- `/canvas_context_rt_stop`
  - Stops the background thread and closes the realtime session.

Events:
- `canvas_context`: `{ image_path, text, source, model, partial? }`
- `canvas_context_failed`: `{ image_path, error, source, model, fatal? }`

Threading:
- The realtime websocket client runs off the synchronous chat loop in a dedicated background thread.
- `rust_engine/crates/brood-contracts/src/events.rs` uses a lock to keep `events.jsonl` append operations safe across threads.

## Config
- `BROOD_REALTIME_PROVIDER` (default auto-routing):
  - OpenAI key present -> `openai_realtime`
  - otherwise OpenRouter/Gemini presence -> `gemini_flash`
- `BROOD_CANVAS_CONTEXT_REALTIME_PROVIDER` to override canvas-context provider only.
- Provider credentials:
  - `openai_realtime`: `OPENAI_API_KEY` (or `OPENAI_API_KEY_BACKUP`)
  - `gemini_flash`: `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) or `OPENROUTER_API_KEY`
- Desktop readiness behavior:
  - realtime readiness is fail-closed until key status resolves (prevents brief false-ready UI states on startup/key refresh)
- `BROOD_CANVAS_CONTEXT_REALTIME_MODEL` (default by provider):
  - OpenAI: `gpt-realtime-mini`
  - Gemini: `gemini-3-flash-preview` (OpenRouter normalized to `google/gemini-3-flash-preview`)
- `BROOD_CANVAS_CONTEXT_REALTIME_DISABLED=1` to hard-disable realtime canvas context.

## Manual Test
1. `./scripts/dev_desktop.sh`
2. Import 2-3 photos.
3. Enable **Always-On Vision**.
4. Confirm:
   - Readout goes `Connecting…` then `ANALYZING…` then fills with text.
   - Updates after canvas changes (within throttle).
   - No noticeable UI lag while using Abilities / queue.
   - Disabling the toggle stops updates.
5. Inspect `events.jsonl` for `canvas_context` lines with `source=openai_realtime` or `source=gemini_flash`.

## Failure Modes
- Missing key: engine emits `canvas_context_failed` with `fatal=true` and the desktop disables the loop.
- Network/API error: same behavior; no silent retry thrash.
