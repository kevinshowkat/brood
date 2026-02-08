# Visual Timeline / Lineage

## Problem
Brood edits frequently replace the active image "in place" (e.g. background replace, crop, annotate). This keeps the canvas clean, but it also means:

- Users cannot easily jump back to earlier versions of an image.
- There's no explicit lineage showing what action produced what output (especially for multi-image actions).

## UX
- A Timeline is available from **Settings** via the `Open Timeline` button.
- The Timeline appears as a filmstrip-like overlay containing thumbnails of the run's "points in time".
- Clicking a timeline card jumps the corresponding image back to that version (by swapping the image path in place).
- The Timeline is hidden by default and only rendered/visible when opened.

## Implementation
Primary files:
- `desktop/src/canvas_app.js`
- `desktop/src/index.html`
- `desktop/src/styles.css`

### Data Model
Timeline nodes live entirely in the desktop frontend state:

- `state.timelineNodes`: array of nodes
- `state.timelineNodesById`: map for lookup
- `item.timelineNodeId`: the currently checked-out node for each canvas image slot

Each node records:
- `nodeId`: unique timeline node id
- `imageId`: which canvas image slot the node belongs to
- `path`, `receiptPath`
- `action`: best-effort label for what produced it (e.g. Combine / Bridge / Recast)
- `parents`: parent node ids (lineage)
- `createdAt`: timestamp

### Recording Lineage
- `addImage(...)` calls `ensureTimelineNodeForImageItem(...)` which records a node for new images.
- Engine artifacts (`artifact_created`) now attach `timelineAction` and `timelineParents` to the new image before `addImage(...)`.
- In-place engine edits (`pendingReplace`) record a new node after `replaceImageInPlace(...)` succeeds, with the previous node as a parent.
- Local artifacts recorded via `saveCanvasAsArtifact(...)` similarly write timeline nodes (including for in-place replacements).

### Rendering / Navigation
- Timeline overlay markup: `#timeline-overlay` (hidden by default).
- `renderTimeline()` builds the strip from `state.timelineNodes` and highlights the active node.
- `jumpToTimelineNode(nodeId)` selects the owning image slot and swaps the image back to the historical `path`.

## Testing
Standard regression set:
- `python -m pytest`
- `cd desktop && npm run build`

## Notes / Follow-Ups
- This is a first-pass lineage system. It records parents, but the UI currently presents a chronological filmstrip (not a full DAG graph).
- We can extend the detail view to show parent thumbnails and add a "branch" visualization later.

