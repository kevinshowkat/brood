# Intent Canvas (Onboarding + Intent Lock)

## Summary
When the app first launches, the user lands in an **Intent Mode** where the canvas is "alive" but the standard HUD/action grid/bumpers and Abilities are hidden/locked until the user locks an intent.

The user can click anywhere on the canvas to import photos. Imported photos are placed at the click location (centered). The user can drag to reposition and resize photos. Spatial layout is treated as a primary signal to infer "what the user wants to build" and "how they are choosing to build it".

The user has **60 seconds (max)** from the moment the first photo is placed to lock in an intent via a guided, icon-only flow. After 3 rounds of model proposals + user selection, the user must choose an intent and Abilities unlock.

Mental model: a strategy-game opening where you choose what to build and where to place it, but here the "units" are visual media (photos/references) and the layout is the strategy signal.

## Goals
- Make the first minute feel like a guided "place images, reveal intent" flow.
- Replace drag/drop as the primary entrypoint with click-to-upload at a chosen canvas point.
- Treat spatial placement and relative sizing as first-class context.
- Lock Abilities until intent is established with high confidence (guided selection rounds).
- Keep the freeform spatial canvas as the primary canvas mode after intent lock.

## Non-Goals
- Explaining intent or "why" to the user.
- Asking the user open-ended questions during intent inference.
- Assuming a specific domain (marketing, SaaS, etc.) as part of the model output.
- Perfect iconography on day 1.

## User-Visible UX Requirements
### Initial Launch (Intent Mode)
- On app launch, until intent is locked: HUD is hidden.
- On app launch, until intent is locked: action grid is hidden.
- On app launch, until intent is locked: decorative canvas bumpers are hidden.
- On app launch, until intent is locked: Abilities panel remains present but shows a locked state (no ability execution).
- Canvas hover: pointer icon changes to indicate "click to place import".
- Canvas click: opens the macOS photo picker dialog.
- Drag/drop is disabled in Intent Mode (click-to-upload is the import path).

### Import Placement
- The click location is captured at click time and used as the placement anchor for the imported photo(s).
- Placement anchor is the image center.
- Multi-select placement (N files from one picker): place images in a compact grid centered around the click point.
- Multi-select placement: keep a consistent default size for all newly imported images.
- Multi-select placement: ensure no image is placed entirely off-canvas. If needed, shift the whole cluster to fit.
- Intent Mode photo limit: up to 5 photos count toward intent inference. If the user tries to import more than 5 during Intent Mode, force them to lock intent first.

### Freeform Manipulation
- Users can reposition images by dragging.
- Users can resize images by dragging corner handles.
- Resizing preserves aspect ratio.
- If a free-aspect mode is desired later, it must be a deliberate modifier key or explicit toggle.
- The layout of images is preserved as the core context; auto-tiling should not override user placement.

### Countdown Timer
- A 60s countdown begins when the first image is successfully placed on the canvas.
- Timer UI: LED-style timer readout.
- Timer UI: positioned top-center of the canvas.
- Timer UI: always visible during Intent Mode.
- On timeout without intent lock: the system must force a choice (see "Forcing Choice").

## Intent Locking Requirements
### Rounds
- Intent lock requires exactly 3 rounds.
- Round structure: model emits candidate icon branches/clusters.
- Round structure: user makes an explicit selection to narrow ambiguity (YES/NO/MAYBE tokens or branch selection).
- Round structure: model updates candidates using the selection signal.
- Round indicator: UI must communicate "round 1/3", "round 2/3", "round 3/3" without relying on prose.
- Round indicator: acceptable forms include numeric chips, dots, or segmented indicators.

### Forcing Choice
- If the user does not complete lock within the 60s window: present a forced-choice UI overlay on the canvas.
- Forced-choice: the user must select one of the currently proposed branches/clusters to proceed.
- Forced-choice fallback: if there are no valid branches due to model failure, fall back to a minimal default branch and require confirmation.

### Unlocking Abilities
- Abilities remain locked until intent is locked.
- Once locked: HUD/action grid/bumpers become visible.
- Once locked: Abilities become executable.
- Once locked: the locked intent remains available as context for recommendations and prompting.

## Realtime "Canvas-to-Intent Icon Engine" Requirements
### Model Output Contract
- The model outputs **JSON only**.
- No prose, no labels, no user-facing text in the model output.
- Intent must be communicated exclusively via icon IDs, spatial grouping, highlights, and branching lanes.

### Intent JSON Shape
Use the strict format below (schema versioning required):
```json
{
  "frame_id": "<input frame id>",
  "schema": "brood.intent_icons",
  "schema_version": 1,
  "intent_icons": [
    {
      "icon_id": "<from taxonomy>",
      "confidence": 0.0,
      "position_hint": "primary"
    }
  ],
  "relations": [
    {
      "from_icon": "<icon_id>",
      "to_icon": "<icon_id>",
      "relation_type": "FLOW"
    }
  ],
  "branches": [
    {
      "branch_id": "<id>",
      "icons": ["MAKE", "GENERATE"],
      "lane_position": "left"
    }
  ],
  "checkpoint": {
    "icons": ["YES_TOKEN", "NO_TOKEN", "MAYBE_TOKEN"],
    "applies_to": "<branch_id or icon cluster>"
  }
}
```

Notes:
- `schema` and `schema_version` are required for forward compatibility.
- The UI must tolerate partial/invalid JSON in streaming by keeping the last valid state.

### Icon Taxonomy (Strict)
Intent Archetypes (HOW):
- MAKE
- TRADE
- TEACH
- HEAL
- PLAY
- LEAD
- EXPLORE
- GUARD
- MEASURE_HOW
- ORGANIZE

System Actions (WHAT):
- INPUT
- INTERPRET
- DECIDE
- GENERATE
- TRANSFORM
- STORE
- FETCH
- ORCHESTRATE
- PUBLISH
- MEASURE_WHAT
- FEEDBACK
- AGENT

Relations:
- FLOW
- DEPENDENCY
- FEEDBACK

Checkpoints:
- YES_TOKEN
- NO_TOKEN
- MAYBE_TOKEN

Disambiguation requirement:
- `MEASURE` must not be duplicated across HOW and WHAT. Use distinct IDs (`MEASURE_HOW`, `MEASURE_WHAT`) or equivalent.

### Spatial Context Envelope
The realtime engine must receive a per-frame "context envelope" describing:
- Canvas size.
- Each image: asset id.
- Each image: current position (x,y) in canvas coordinates.
- Each image: size (w,h).
- Each image: z-order (if relevant).
- Each image: import order index.
- Current round index and remaining time.
- User selection state for prior rounds (branch chosen, token applied).

The intent engine must treat:
- Left-to-right placement as flow.
- Top-to-bottom as hierarchy.
- Clusters as coupling.
- Isolation as emphasis.
- Relative size as emphasis/importance.

## On-Canvas Rendering Requirements
### Icon Glyph Rendering (Stub v1)
- Render intent icons directly on the canvas as glyphs.
- V1 glyph stub can be: small, high-contrast badges showing `icon_id` text (monospace caps).
- V1 glyph stub can be: simple connecting lines for relations.
- V1 glyph stub can be: lanes/columns for branches.
- Do not display explanatory text.
- Icons must remain legible over images: use a backing plate (semi-opaque).
- Icons must remain legible over images: avoid covering image centers by default.

### Interaction
- The user must be able to select among branches/clusters using the on-canvas glyph UI.
- Checkpoint tokens (YES/NO/MAYBE) must be clickable.
- User input from selection updates the next inference round.

## Image-Generation Use Case Coverage (Examples)
These are exemplar intent "destinations" to ensure the icon engine supports common image-generation workflows without hard-coding domain assumptions:
- Product photography for a webstore (camera roll to listing-ready images)
- Put this object on a model (on-model generation)
- Creative exploration (generate new directions from references)
- Furniture staging (place object into a room defined by references)

The icon engine should be able to represent each of the above as 1 primary + 1-3 alternative icon paths using the strict taxonomy (no labels).

## Persistence Requirements
- Intent Mode state must persist during the run: current round.
- Intent Mode state must persist during the run: last valid intent icon JSON.
- Intent Mode state must persist during the run: user selections.
- Intent Mode state must persist during the run: timer start timestamp.
- After intent lock, the locked intent should be saved as a run artifact (machine-readable) for: ability recommendations.
- After intent lock, the locked intent should be saved as a run artifact (machine-readable) for: prompt generation.
- After intent lock, the locked intent should be saved as a run artifact (machine-readable) for: recreates/edits metadata.

## Accessibility & Input
- Canvas click-to-upload must be keyboard accessible (focusable canvas, Enter/Space triggers upload at a sensible default point).
- Ensure pointer interactions do not block basic navigation (Escape cancels forced-choice overlay).

## Acceptance Criteria (MVP)
- Launch shows no HUD/action grid/bumpers and Abilities are locked.
- Hovering canvas changes cursor; clicking opens photo picker.
- Imported image appears centered at click location.
- User can drag-move and corner-resize the image.
- 60s timer starts on first placed image and is visible top-center.
- The system shows icon branches and supports 3 rounds of user selection.
- Abilities remain locked until intent lock; forced-choice triggers on timeout.
- After lock, HUD/action grid/bumpers appear and Abilities unlock.
- Freeform spatial canvas remains (no auto-tiling override).
