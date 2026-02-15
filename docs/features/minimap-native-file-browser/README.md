# Minimap -> Native File Browser Dock

## Goal
Replace the current bottom minimap with a native-backed file browser panel so users can drag local images from that panel onto the canvas.

Primary outcome:
- Faster import workflow without repeatedly opening the file picker.
- Visual browsing of source folders directly in the app.
- Drag from browser panel -> drop on canvas -> image imported into run.

## Current State
- The minimap is rendered in `#minimap` / `#minimap-surface` and is non-interactive (`pointer-events: none`).
- Import currently relies on file picker (`open(...)`) via `importPhotosAtCanvasPoint(...)`.
- External OS drag/drop import is intentionally disabled (`ENABLE_DRAG_DROP_IMPORT = false`), though file-drop navigation is still blocked for safety.

Relevant files:
- `desktop/src/index.html`
- `desktop/src/styles.css`
- `desktop/src/canvas_app.js`

## Proposed UX

### 1) Replace Minimap Area with Browser Dock
- Reuse the same footprint in the control strip (where minimap currently lives).
- Show a compact file browser with:
  - Current folder label
  - `Choose Folder` button (native directory picker)
  - Optional `Up` and `Refresh` controls
  - Scrollable thumbnail/file list

### 2) Drag-and-Drop from Dock to Canvas
- User drags an image thumbnail from browser dock.
- Canvas shows import-drop affordance (same visual language as existing import placement).
- On drop:
  - File is copied into `run_dir/inputs/`
  - Local import receipt is written
  - Image is added to canvas using existing `addImage(...)` path
  - Placement uses drop point (same behavior as `importPhotosAtCanvasPoint(pointCss)`)

### 3) Keyboard/Click Fallback
- Single-click file imports to default import point.
- Double-click imports and focuses.
- Enter key on selected browser item imports.

## Native Backing Model
"Native file browser" here means native-backed file system access (Tauri APIs), not embedding Finder itself.

Use:
- `@tauri-apps/api/dialog` `open({ directory: true })` for folder selection.
- `@tauri-apps/api/fs` `readDir`, `exists`, `readBinaryFile`/asset URL path flow for listing and thumbnails.

macOS scope notes:
- Current Tauri scope already allows `$HOME/**` and `$DESKTOP/**`.
- Browser should gracefully show permission/scope errors in-panel.

## Data Model (Frontend State)
Add `state.fileBrowser` in `desktop/src/canvas_app.js`:
- `enabled: true`
- `rootDir: string | null`
- `cwd: string | null`
- `entries: Array<{ name, path, kind, ext, size, mtime, thumbUrl }>`
- `selectedPath: string | null`
- `loading: boolean`
- `error: string | null`
- `draggingPath: string | null`
- `history: string[]`

Persist:
- `brood.fileBrowser.rootDir` in `localStorage` for restart continuity.

## Drag/Drop Contract
Define internal DnD payload type:
- MIME: `application/x-brood-local-image-path`
- Payload: absolute file path (string)

Behavior:
1. Browser item `dragstart` sets payload.
2. Canvas drop target validates extension (`png/jpg/jpeg/webp/heic`).
3. Import runs through shared helper:
   - copy file to run inputs
   - write receipt
   - `addImage(...)`
   - trigger `requestRender()`

Important:
- Keep external OS drop disabled by default.
- Enable internal app drag path regardless of `ENABLE_DRAG_DROP_IMPORT`.

## UI Specification

### Panel States
- `empty`: no folder selected; show CTA `Choose Folder`.
- `loading`: skeleton rows/thumbnail placeholders.
- `ready`: thumbnail grid/list.
- `error`: concise error line + retry action.

### Entry Rendering
- Directories first, then image files.
- Non-image files hidden by default.
- Each tile shows:
  - Thumbnail
  - File name (ellipsized)
  - Optional dimensions on hover/tooltip

### Performance Constraints
- Lazy-load thumbnail URLs.
- Virtualize list if entry count is large (>300).
- Debounce refresh during rapid folder navigation.

## Integration Plan

### HTML
- Replace minimap subtree in `desktop/src/index.html` with:
  - `#file-browser-dock`
  - `#file-browser-header`
  - `#file-browser-list`

### CSS
- Replace minimap styles (`.minimap*`) with browser dock styles preserving existing HUD/control-strip proportions.
- Keep visual identity consistent with Brood’s bottom control surface.

### JS
- Add file browser state + renderer.
- Add folder selection + directory read helpers.
- Add thumbnail URL lifecycle management (revoke on refresh/unmount).
- Add internal drag handlers and canvas drop ingestion.
- Refactor import logic into shared helper used by:
  - picker import
  - browser click import
  - browser drag-drop import

## Acceptance Criteria
- Minimap region is replaced by file browser dock in the bottom strip.
- User can choose a local folder and see image thumbnails.
- User can drag image from dock onto canvas and it imports correctly.
- Imported image appears in run artifacts (`inputs/`, receipt, canvas state) same as existing import flow.
- External OS file drop remains disabled unless explicitly re-enabled.
- Behavior remains stable with 500+ files in a folder (no UI lockup).

## Risks and Mitigations
- Large directories can freeze UI.
  - Mitigation: chunked rendering + thumbnail lazy loading + optional pagination.
- Broken/missing file permissions.
  - Mitigation: explicit in-panel errors and quick re-pick flow.
- Drag/drop conflicts with existing canvas gestures.
  - Mitigation: handle only custom MIME payload on canvas drop; ignore others.

## Rollout
1. Ship behind flag: `ENABLE_FILE_BROWSER_DOCK`.
2. Keep old minimap rendering code path during rollout.
3. If stable, remove minimap DOM/CSS/renderer and default flag to enabled.
