# Always-On Vision (Background Canvas Context Foundation)

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

### Desktop (Scheduler + Snapshot)
- Toggle state is persisted via `localStorage` key `brood.alwaysOnVision`.
- Background work is driven by:
  - `scheduleAlwaysOnVision()` (debounce)
  - `runAlwaysOnVisionOnce()` (throttle + idle gating + dispatch)
- The scheduler refuses to run while foreground actions are running (generation, replace, etc.).
- Snapshot generation:
  - Builds a small collage (up to 6 images) on a temporary canvas.
  - Encodes to JPEG and writes to the current `runDir` as `alwayson-<timestamp>.jpg`.
  - Dispatches `/canvas_context <snapshotPath>` to the engine PTY.

### Engine (New Slash Command + Inference)
- New intent: `/canvas_context <path>`
- CLI emits:
  - `canvas_context` with `{ image_path, text, source, model }`
  - `canvas_context_failed` with `{ image_path, error }`
- Inference implementation lives in `brood_engine/recreate/caption.py` as `infer_canvas_context(...)`.
  - Defaults to `gpt-realtime-mini` via the OpenAI Responses API (override with `BROOD_CANVAS_CONTEXT_MODEL` / `OPENAI_CANVAS_CONTEXT_MODEL`).
  - Falls back to `gpt-4o-mini` if the requested model fails.
  - Optional Gemini fallback if keys + dependency are present.

### Notes On "gpt-realtime-mini"
This branch uses `gpt-realtime-mini` through the standard Responses endpoint. It does not yet create a persistent Realtime session (WebRTC/WebSocket). The code is structured so a future iteration can swap the backend implementation to a true realtime session without changing the desktop UX contract.

## Testing
Standard regression set:
- `python -m pytest`
- `cd desktop && npm run build`

## Follow-Ups / Next Steps
- Add a dedicated `canvas_context` HUD surface and/or action recommendations UI.
- Route always-on vision through the hardened action queue (low priority) so it never competes with user clicks.
- Optionally store context artifacts as receipts to make runs reproducible.

