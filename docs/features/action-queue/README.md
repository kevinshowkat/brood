# Action Queue (Hardened Queue Foundation)

## Problem
Brood currently rejects or overlaps user actions when the engine is busy (e.g. rapid clicks on Abilities or the HUD action grid). This causes:

- Lost intent: clicks are ignored with "already running" toasts.
- Accidental concurrency: some actions can be triggered while other engine work is in-flight.
- Unreliable sequencing: users cannot stack actions to run one after another.

## UX
- Actions are now *queueable*. If the engine is busy, clicking an action enqueues it instead of rejecting it.
- A toast confirms enqueue: `Queued: <Action>`.
- Abilities remain clickable even while an action is running (they enqueue).
- The queue executes actions sequentially (one at a time) and resumes automatically on completion/failure events.

Notes:
- Queue semantics are "execute on the then-current canvas state" (not a snapshot of state at click-time), except for Annotate, which captures the box + instruction when queued so it stays stable.

## Implementation
Primary file: `desktop/src/canvas_app.js`

### State
- `state.actionQueue`: pending actions.
- `state.actionQueueActive`: the action currently dispatched and waiting to finish.
- `state.actionQueueRunning`: re-entrancy guard for queue draining.
- `state.pendingRecreate`: blocks the queue while `/recreate` (Variations) is running until a completion signal arrives.

### Core Helpers
- `isEngineBusy()`: single source of truth for "can we dispatch the next queued action?".
- `enqueueAction(...)`: adds a queue item with optional `key` de-dupe and `priority`, bounds queue size, triggers a drain.
- `processActionQueue()`: drains queued items when idle, and holds when an engine-driven action transitions to busy.
- `resetActionQueue()`: clears queue state on run reset / engine exit.

### Making Actions Queueable
Most action entrypoints now accept `{ fromQueue = false }` and do:
- If busy and not `fromQueue`: enqueue a closure that re-invokes the action with `{ fromQueue: true }`.
- Otherwise: run normally.

This was applied to:
- 2-image actions: Combine, Bridge, Swap DNA, Argue
- Single-image actions: Diagnose, Recast
- HUD action grid actions: Background replace (local + AI), Remove People, Surprise Me, Variations, Crop: Square
- Annotate: captures `targetId`, bounding box, instruction text, and requested model when queued; clears the panel immediately to match "send" UX.

### Variations Completion Signal
Variations uses `/recreate`, which can emit multiple `artifact_created` events before the recreate loop finishes. Starting another engine action before the loop completes can misattribute artifacts.

To fix this, the engine now emits a dedicated completion event:
- `recreate_done` (always emitted via `finally`)

Changes:
- `rust_engine/crates/brood-cli/src/main.rs`: emits `recreate_done` with `success` and `error`.
- `desktop/src/canvas_app.js`: clears `state.pendingRecreate` on `recreate_done`.

### Preventing Background Describe From Competing
Vision describe is treated as background work:
- `processDescribeQueue()` returns early if the engine is busy or actions are queued/active.

## Testing
Standard regression set:
- `cd rust_engine && cargo test`
- `cd desktop && npm run build`

## Follow-Ups / Next Steps
- Add an optional queue UI (count + current item) in the HUD.
- Add user controls: cancel queued items, reprioritize, or "clear queue".
- Unify other background tasks (e.g. background canvas diagnose / always-on vision) to enqueue at lower priority instead of direct PTY writes.
