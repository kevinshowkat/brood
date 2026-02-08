# Always-On Vision (Background Canvas Context)

## Problem
Brood can feel reactive: the user edits the canvas, then decides what to do next. For a "desktop Image IDE", we want Brood to be one step ahead by continuously extracting lightweight context from the current canvas without slowing UX.

## UX
- Settings now includes an **Always-On Vision** toggle.
- When enabled, Brood periodically (and quietly) scans an optimized snapshot of the current canvas in the background.
- Results are shown as **Canvas Context** in the Settings drawer (for now).
- The background scan is throttled and debounced to avoid interfering with user actions or responsiveness.

## Implementation
Primary files:
- `desktop/src/canvas_app.js`
- `desktop/src/index.html`
- `brood_engine/chat/intent_parser.py`
- `brood_engine/cli.py`
- `brood_engine/recreate/caption.py`
- `brood_engine/realtime/openai_realtime.py` (realtime backend)

### Desktop (Scheduler + Snapshot)
- Toggle state is persisted via `localStorage` key `brood.alwaysOnVision`.
- Background work is driven by:
  - `scheduleAlwaysOnVision()` (debounce)
  - `runAlwaysOnVisionOnce()` (throttle + idle gating + dispatch)
- The scheduler refuses to run while foreground actions are running (generation, replace, etc.).
- Snapshot generation:
  - Builds a small collage (up to 6 images) on a temporary canvas.
  - Encodes to JPEG and writes to the current `runDir` as `alwayson-<timestamp>.jpg`.
  - Dispatches realtime commands to the engine PTY:
    - `/canvas_context_rt_start`
    - `/canvas_context_rt <snapshotPath>`
    - `/canvas_context_rt_stop`

### Engine (Batch + Realtime)
Batch (Responses API):
- Slash command: `/canvas_context <path>`
- Inference: `brood_engine/recreate/caption.py::infer_canvas_context(...)`
  - Defaults to `gpt-4o-mini` via the OpenAI Responses API.
  - Explicitly avoids `*realtime*` models on this path.
  - Optional Gemini fallback if keys + dependency are present.

Realtime (OpenAI Realtime API):
- Slash commands:
  - `/canvas_context_rt_start`
  - `/canvas_context_rt_stop`
  - `/canvas_context_rt <path>`
- Implementation: `brood_engine/realtime/openai_realtime.py`
  - Spawns a background websocket worker and streams `canvas_context` events as text deltas arrive.

### Notes On Realtime Models
Realtime models require the Realtime API (WebRTC/WebSocket) and must not be called via the Responses endpoint.
See `docs/features/always-on-vision-realtime/README.md` for the persistent-session implementation details.

## Testing
Standard regression set:
- `python -m pytest`
- `cd desktop && npm run build`

## Follow-Ups / Next Steps
- Add a dedicated `canvas_context` HUD surface and/or action recommendations UI.
- Route always-on vision through the hardened action queue (low priority) so it never competes with user clicks.
- Optionally store context artifacts as receipts to make runs reproducible.
