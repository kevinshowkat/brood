# Product Spec: Spawn (v0, True Cold Start, Local-Only)

## North Star
Spawn is the cold-start hook: Brood proves it understands the user's visual identity before asking for an image prompt.

## When It Appears
- Spawn is hotkey `9` in the 3x3 action grid (replaces Respawn).
- Spawn is only enabled when the active canvas has `0` images (true cold start).
- If images exist, Spawn is disabled and explains why (tooltip/toast).

## User Input (One Thing Only)
- v0 is local-only. Spawn asks for one local source:
  - "Select a folder of your work" (one directory).
- No additional fields. No onboarding steps.

## On-Canvas Sequence (15–20s Target, Visible The Whole Time)
1. Second 0–5: The Swarm
   - Enumerate ~20–30 images from the selected folder.
   - Thumbnails cascade onto the canvas (small, lively motion; slight randomness).
   - User immediately sees their own work inside the tool.
2. Second 5–10: The Cluster
   - The swarm self-organizes into 3–4 clusters based on visual similarity (local embeddings).
   - Clusters animate into grouped piles/constellations.
   - Each cluster gets a relational label (not generic tags), e.g.:
     - "your quieter, type-led work"
     - "your bolder, image-dominant work"
     - "your most commercially restrained pieces"
3. Second 10–15: The Spawn
   - System picks the strongest cluster (tightest coherence).
   - Generate one new image that plausibly fits that cluster's aesthetic.
   - Generated image appears center canvas, larger than thumbnails, and pulses once.
   - This generated image becomes the user's first real working artifact.
4. Second 15–20: The Dossier
   - HUD readout (UNIT/DESC/SEL/GEN) prints a creative read seeded from the portfolio clusters.
     - `UNIT` Spawned from [folder name]
     - `DESC` 2–3 line creative fingerprint
     - `SEL` Strongest cluster: [cluster label]
     - `GEN` First spawn complete — 4 clusters mapped
   - In the right "AGENTS" area, show the user's fingerprint as an informational card only.
     - Important: it does not automatically affect future generations in v0.

## UI / Visual Requirements
- Replace action-grid button `9` entirely.
- "Spawn" keycap should feel egg-like (StarCraft hatchery energy) while staying visually consistent with:
  - Existing 90s yellow keycaps
  - Depressed-active tool behavior
- No larvae visuals.
- No UI layout shifting when selecting tools.
- Session controls remain minimal/distinct from Quick Actions.

## Non-Goals (v0)
- No URL crawling; no Instagram handling.
- No persistence of the swarmed portfolio thumbnails or clusters into the run directory (ephemeral).
- Fingerprint does not modify prompts/models automatically.

---

# Technical Spec: Spawn (v0)

## High-Level Architecture
- Desktop (JS canvas) owns the Spawn state machine and all animations.
- A macOS-only embedding service computes "CLIP-like" similarity using Apple-native vision embeddings ("Apple CLIP").
- Engine is used for one image generation (Spawn output) and optionally dossier text.

## State Machine
Add `state.spawn` in `desktop/src/canvas_app.js`:
- `stage`: `idle | picking | swarming | embedding | clustering | generating | dossier | done | error | cancelled`
- `source_dir`: string
- `candidates`: list of `{ path, thumb_img, pos, vel, cluster_id }`
- `clusters`: list of `{ id, member_paths, centroid, label, coherence_score }`
- `chosen_cluster_id`
- `spawn_output_artifact_id` (engine artifact)
- `started_at`, `error`

## Local-Only Ingestion (Ephemeral)
- Use a directory picker to select one folder.
- Enumerate images (`png/jpg/jpeg/webp/heic`) up to a cap (target `30`).
- Do not copy into `runDir/inputs`, do not write receipts, do not add to filmstrip.
- Thumbnails are loaded for rendering only; all swarm data lives in memory.
- Clearing conditions:
  - New Run/Open Run
  - Escape/cancel
  - After `done` (configurable whether swarm remains as a backdrop)

## Embeddings ("Apple CLIP")
macOS implementation detail (recommended):
- Use Vision feature prints (`VNGenerateImageFeaturePrintRequest`) as the embedding vector.
- Compute similarity via Vision's distance metric or normalized cosine distance.

Expose a Tauri command (Rust backend), e.g.:
- `spawn_compute_embeddings(paths[]) -> { embeddings: float[][] }`

Performance target:
- Compute embeddings incrementally as thumbs appear so clustering can start quickly.

## Clustering
Goal: 3–4 clusters.

Algorithm (simple + robust for n≈30):
- Try `k = 3..4` and pick best by silhouette or lowest within-cluster distance with minimum cluster size constraints.
- Score each cluster coherence as mean pairwise similarity (or distance to centroid).

"Strongest cluster" selection:
- Highest coherence score, with a minimum size threshold (e.g. `>= 5`).

## Cluster Labels (No Generic Tags)
v0 labeling should be local and fast:
- Extract cheap signals per image/cluster:
  - Text density via Vision OCR (type-led vs image-led)
  - Color warmth/saturation (quiet vs bold)
  - Background/whitespace proxy (commercial restraint)
- Map to a small template set that produces relational phrasing ("your ... work").

Optional v0.1:
- Use a text model to refine labels from these signals, without sending portfolio images.

## Spawn Generation (Engine Call)
Implement a new engine slash command: `/spawn` (or `/spawn_cluster`) that accepts multiple reference image paths:
- `/spawn "<ref1>" "<ref2>" ... "<refN>"`

Engine behavior:
- `settings["reference_images"] = [refs...]`
- `settings["n"] = 1`
- Prompt tuned to intent:
  - "Generate a new image that fits the aesthetic DNA of these references."
  - "Not a collage, not a copy; invent a new composition consistent with the cluster's decisions."

Model choice (v0 recommendation):
- Prefer a fast Gemini image model for the 15–20s target (fallback to `gemini-3-pro-image-preview` if needed).

Desktop behavior:
- While generating, keep swarm/clusters visible and animate subtle "energy" around the chosen cluster.
- When artifact arrives, add it as a real run image and select it.

## Dossier Output
Populate HUD fields from Spawn results:
- folder name as identity seed
- chosen cluster label
- cluster count
- 1–2 sentence fingerprint

Implementation options:
- Local-only heuristic dossier (fastest, no extra calls).
- Optional text-model call seeded with cluster stats (no images) and emit an event `spawn_dossier`.

## AGENTS Integration (Display Only)
Add a "Fingerprint" entry in the AGENTS area:
- Contains the dossier summary and cluster label.
- Explicitly marked informational and not automatically applied.

## Remove Respawn Entirely
- Remove the action-grid button `9`'s old behavior and any timers/UI that exist solely to "respawn" on-canvas actions.
- Spawnbar/on-canvas quick actions remain hidden/removed.

## Testing
- Engine/unit:
  - Extend intent parsing tests for `/spawn` if implemented as a slash command.
- Desktop build:
  - `cd desktop && npm run build`
- Engine tests:
  - `python -m pytest`

## Open Risks
- macOS-only embedding requires native Vision plumbing via Tauri (Rust <-> Apple frameworks).
- File access scope: directory selection must reliably grant read access to the selected images without copying into the run.

