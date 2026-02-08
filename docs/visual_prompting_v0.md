# Visual Prompting: Visual Grammar v0 + Serialization

## Product North Star
Visual prompting is a composition language: layout (arrangement + whitespace) communicates intent, and explicit marks (circles/boxes/arrows/labels) disambiguate what to edit.

This doc proposes a minimal "visual grammar v0" and the first thin-slice implementation: emit a machine-readable `visual_prompt.json` from the desktop canvas, plus one new annotation primitive (red circle labels).

## Visual Grammar v0 (Spec)

### 1) Layout Rules (implicit semantics)
- **Side-by-side (2-up)**: "blend / combine A + B"
  - In Brood today: multi-canvas + `Combine` quick action (`/blend`) is the canonical behavior.
- **Vertical stack**: "sequential states" (A -> B -> C)
  - Interpretation: treat as a timeline; compare deltas; generate next state.
- **Grid (2x2 / 3x3)**: "variants / compare"
  - Interpretation: same prompt family; prefer describing differences over fusing.
- **Whitespace separation**: grouping boundary
  - Interpretation: distinct groups are separate tasks unless a mark/label explicitly links them.

### 2) Annotation Primitives (explicit semantics)
- **Point** (existing): designate `Subject` / `Reference` / `Object`
  - Purpose: attach a role to a specific pixel location.
- **Box** (existing): bounded edit region
  - Default semantic: "edit only inside" (green box).
- **Circle** (new): attention / "fix this"
  - Default semantic: **red circle = fix this area**.
- **Arrow** (v0 concept; not implemented yet): relationship / transfer / movement
  - Default semantic: "move/replace from A to B" (tail = source, head = target).
- **Text label** (v0 concept; partially implemented via circle label): literal instruction string
  - Always treated as verbatim instruction text.

### 3) Color Semantics (v0)
- **Red circle**: "fix this"
- **Green box**: "edit only inside"
- **Cyan point**: designation role marker
- **Yellow lasso**: subject mask candidate / selection

### 4) Examples (mental model)
- Two product photos side-by-side + label "blend lighting + keep logo sharp" -> combine/blend behavior.
- Screenshot stack (3-up) + red circles on each -> "fix these issues in sequence".
- Green box around background + label "make background pure white" -> edit within region only.

## Visual Prompt Serialization v0 (JSON)

### File location
- Written to the current run directory as: `runDir/visual_prompt.json`
- Produced by the desktop app (`desktop/src/canvas_app.js`).

### Shape (current)
Top-level fields:
- `schema`, `schema_version`
- `visual_grammar_version`
- `updated_at`
- `run_dir`
- `canvas`: mode, DPR, canvas size, active image id, tool, view transforms, and multi-layout rects
- `images`: image ids + paths + dimensions
- `marks`: normalized mark list (per-mark metadata + image-space geometry)

Mark shape:
- `id`
- `type`: `lasso_polygon` | `designate_point` | `box` | `circle`
- `color`: CSS RGBA string
- `label`: optional string (literal instruction/label)
- `target_image_id`
- `image_space`: geometry in image pixel coordinates
- `created_at`

Notes:
- `multi_rects_px` are in **canvas device pixels** (DPR-scaled), and `multi_view.offset_*` are the pan offsets applied on top.
- In v0, the annotate **box mark is only serialized while it exists in the UI** (it is cleared after sending/canceling). Persisted box history is a next step.

## Smallest Shippable Implementation Plan
1. **Spec-first**: keep this doc updated as the "contract" for how layout + marks map to meaning.
2. **Always-on serialization**: write `visual_prompt.json` on key state changes (run init, image import, tool interactions, marks created/edited/deleted, pan/zoom).
3. **One new primitive**: add **red circle labels**:
   - Create via Shift + drag (Annotate tool)
   - Render as overlay + label
   - Edit label via a small panel
   - Delete via panel or Delete/Backspace
4. **Next thin slice (recommended)**:
   - Add a `Fix` action that targets the last/selected red circle:
     - Convert circle -> normalized region coords
     - Compose edit prompt from circle label + region
     - Call engine edit path end-to-end
