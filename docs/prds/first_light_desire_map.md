# First Light: Creative Desire Map (PRD Draft)

## Summary
First Light is a 90-second onboarding scan that produces a "desire map": an aggregated, local-first read of a creator's aesthetic fixation and aspiration. The goal is to make Brood feel personal on day one, without feeling invasive.

This doc captures:
- The product intent (what we want the user to feel and do).
- A concrete technical architecture that is fast and local-first.
- An LLM prompt for turning scan outputs into (1) an internal dossier and (2) a user-facing read.

## Problem
Most AI creative tools feel generic on day one because they start with no taste context. Users either:
- Spend time teaching the tool via prompts, or
- Get generic outputs and churn.

We want Brood to arrive "already knowing" the direction the user is reaching for, derived from weak but high-signal local proxies (references saved, revisitation, created work, fonts, and timing patterns).

## Goals
- Produce a useful "creative read" within 90 seconds of first launch.
- Keep it local-first and non-creepy:
  - Prefer metadata over file contents.
  - Store aggregated features, not raw personal data.
  - Avoid naming specific creators/models in the user-facing read.
- Turn the artifact into something actionable in Brood:
  - Default prompt shaping (mode/chips) based on the desire map.
  - A "passport" card in settings to revise/steer.

## Non-Goals
- Any claim of psychological diagnosis.
- Any user-facing disclosure of source URLs, file paths, timestamps, or identifiable individuals.
- Any need to upload the user's whole library to a server.

## User Experience
On first run:
1. One clear permission dialog explaining what is scanned (metadata + thumbnails where necessary) and what is *not* scanned.
2. A short "creative read" that feels like a good creative director, not surveillance.
3. An actionable next step:
   - Suggested starter prompts.
   - A default "style bias" mode (Comfort / Blend / Aspiration).

In settings:
- "Brood Passport" card that shows:
  - Aesthetic fingerprint (palette + clusters).
  - Desire delta (what you reach for vs what you ship).
  - A mode toggle and a few chips that actually affect generation/editing.
  - A rescan button.

## Data Artifact
The scan should emit a single artifact (example name):
- `first_light.json`: aggregated signals, plus an optional list of per-item embeddings/metadata if needed for future iterations.

Downstream derived profile:
- `passport.json`: the distilled, explicitly user-facing version (no sensitive fields).

## Technical Approach (Draft)
Run phases concurrently. Emphasize "fast proxies" over perfect semantics.

### Phase 1: Filesystem Desire Graph (0–30s)
Use macOS Spotlight metadata (not file contents) via `mdfind` + `mdls` attributes:
- `kMDItemFSCreationDate`
- `kMDItemFSContentChangeDate`
- `kMDItemLastUsedDate`
- `kMDItemUseCount`
- `kMDItemWhereFroms`
- `kMDItemPixelHeight/Width`
- `kMDItemColorSpace`
- `kMDItemFonts`
- `kMDItemCreator`

Key: `kMDItemWhereFroms` (source URL). Cluster source URLs by domain/path; rank by revisit intensity (revisits over time since download).

### Phase 2: Shadow Portfolio (0–30s, parallel)
Identify authored creative work via `kMDItemCreator`/UTI patterns (Figma, Adobe, Sketch, etc.).

Compute embeddings locally (CLIP or Apple Vision featureprints) for a bounded sample:
- Saved references
- Created work

Compute "desire gap" = distance between admired centroid and produced centroid.

### Phase 3: Temporal Rhythm (15–45s, parallel)
Use `kMDItemLastUsedDate` and `kMDItemUseCount` to categorize references:
- Preparatory (opened before sessions)
- Recurring (opened without subsequent creation)
- Reactive (opened after new downloads)

### Phase 4: Font Fingerprint (5s, parallel)
Scan installed fonts (`~/Library/Fonts`, `/Library/Fonts`) and map to a shipped static database:
- font -> studio lineage / movement / archetype cues

## Privacy / Trust Principles
- Default to aggregated stats and derived features.
- Make raw per-item lists optional and strictly local.
- Allow "exclude folders" and "rescan scope" controls.
- Provide a "What we saw (high level)" explainer without revealing private specifics.

## Risks / Open Questions
- Spotlight metadata completeness varies (e.g., `kMDItemWhereFroms` not always present).
- `kMDItemUseCount` / `kMDItemLastUsedDate` can be sparse or inaccurate for some apps.
- Font mapping database can become stale; needs curation.
- Embedding compute budget: define a cap (e.g., top N references by revisit + recent created work).

## Appendix A: Raw Draft (Architecture)

> We're solving the problem that every AI creative tool feels generic on day one by mining the user's local machine for the hidden structure of their aesthetic desire — who they admire, what they covet, and the gap between what they save and what they ship — so the tool arrives already knowing who they wish they were.
>
> "This is where it gets real. You need to extract a Girardian desire map in under 90 seconds without creeping the user out. Here's the specific technical architecture.
>
> ---
>
> ## The "First Light" Scan
>
> Call it First Light internally. One permission dialog, one scan, three phases running concurrently.
>
> ---
>
> ### Phase 1: The Filesystem Desire Graph (0–30 seconds)
>
> **Use macOS Spotlight metadata, not file contents.**
>
> You never need to open a single file. The `mdls` command on macOS exposes rich metadata on every file without reading it. Specifically:
>
> `kMDItemFSCreationDate` — when it was created
> `kMDItemFSContentChangeDate` — last modified
> `kMDItemLastUsedDate` — last opened
> `kMDItemUseCount` — how many times opened
> `kMDItemWhereFroms` — the URL it was downloaded from
> `kMDItemPixelHeight/Width` — image dimensions
> `kMDItemColorSpace` — color profile
> `kMDItemFonts` — fonts used in the document
> `kMDItemCreator` — which app made it
>
> The key field is **`kMDItemWhereFroms`**. Every image saved from a browser retains the source URL. This is the single most Girardian data point on the machine. You can run a Spotlight query across the entire home directory in seconds:
>
> ```bash
> mdfind "kMDItemContentTypeTree == 'public.image'" \
>   -attr kMDItemWhereFroms \
>   -attr kMDItemLastUsedDate \
>   -attr kMDItemUseCount
> ```
>
> This gives you every image on the machine, where it came from, and how often they returned to it. Now cluster the source URLs by domain and path:
>
> - `behance.net/studioname` — that's a model
> - `instagram.com/p/xxxxx` — resolve to a creator, that's a model
> - `dribbble.com/designer` — model
> - `are.na/channel/xxxxx` — aspirational identity signal
> - `fonts.google.com`, `typewolf.com` — typographic desire vector
>
> **The crucial metric is the ratio of `kMDItemUseCount` to `kMDItemLastUsedDate` minus `kMDItemFSCreationDate`.** An image downloaded once and never opened is noise. An image downloaded six months ago and opened eleven times is a *fixation object.* Rank every image by this revisit intensity score. The top 20 images are the user's mimetic core — the work they can't stop looking at.
>
> Now the unconventional part: **cross-reference the source URLs against each other.** If 14 of the top 50 revisited images all come from the same Behance profile or Instagram account, you've found the *primary mediator of desire.* You don't even need to analyze the images yet. The URL clustering alone gives you the person.
>
> ---
>
> ### Phase 2: The Shadow Portfolio (0–30 seconds, parallel)
>
> **Diff the creation dates against modification dates across all creative files.**
>
> ```bash
> mdfind "kMDItemContentTypeTree == 'public.image' && \
>   kMDItemCreator == '*Photoshop*' || \
>   kMDItemCreator == '*Figma*' || \
>   kMDItemCreator == '*Illustrator*'"
> ```
>
> This gets you every file the user actually *made* (not downloaded). Now you have two populations: **things they saved from others** (Phase 1) and **things they made themselves** (Phase 2).
>
> Run both sets through a CLIP embedding model locally. This is the critical step — CLIP gives you a shared vector space where you can measure the *distance between what they admire and what they produce.* You're not doing generation, just embedding, so even a laptop GPU handles this in seconds for a few hundred images.
>
> The gap in this vector space *is* the Girardian desire. It's the measurable distance between who they are and who they want to be. Cluster the admired-but-not-produced region of the embedding space — that's where the AI should bias its suggestions. Not toward their existing style. Toward the style they're *reaching for.*
>
> **The files they made that are closest in embedding space to work by their primary mediator (from Phase 1) but were sent to the trash?** Those are the killed imitations. Flag them separately. They represent the *anxiety boundary* — how close they'll let themselves get to the model before self-censoring. The AI should learn to suggest work that sits just inside that boundary. Close enough to the desire, not so close it triggers shame.
>
> ---
>
> ### Phase 3: The Temporal Rhythm (15–45 seconds, parallel)
>
> **Use macOS Extended Attributes and FSEvents to build a behavioral timeline.**
>
> The file system records access times. Using `kMDItemLastUsedDate` and `kMDItemUseCount` across the whole image corpus, you can reconstruct a *temporal pattern of desire:*
>
> - Which reference images get opened late at night? (private desire, unperformed)
> - Which get opened right before a client meeting? (instrumental, identity-performing)
> - Which get opened right after a competitor posts new work? (rivalry trigger)
>
> You don't need screen time APIs. The file access timestamps alone reconstruct the emotional rhythm. Build three categories:
>
> **Preparatory references** — opened in clusters before creation sessions. These are *conscious* influences. Important but sanitized.
>
> **Recurring references** — opened periodically with no creation session following. These are *contemplative fixations.* Girard's pure desire. The user isn't using these for work. They're using them for longing.
>
> **Reactive references** — opened in tight temporal proximity to downloads from a specific external source (a competitor's new portfolio drop, for example). These are *rivalry signals.* Someone published something and the user immediately went back to their own reference library to reassess. The timestamps tell the story.
>
> ---
>
> ### Phase 4: The Font Fingerprint (5 seconds, parallel)
>
> Scan `~/Library/Fonts` and `/Library/Fonts`. Cross-reference against a pre-built database that maps typefaces to the studios, brands, and designers most associated with them. This is static data you can ship with the app.
>
> If the user has Neue Haas Grotesk, Untitled Sans, Diatype, and ABC Favorit installed — you don't need AI to know they're tracking a very specific lineage of contemporary Swiss-adjacent studios. The font library is a *purchase history of aesthetic allegiance.* Every font is a vote for a worldview.
>
> Map the fonts to known studios and designers. These become additional nodes in the desire graph.
>
> ---
>
> ### Synthesis: The Desire Dossier (final 15 seconds)
>
> Now you merge all four phases into a single data structure:
>
> ```json
> {
>   "primary_mediators": [
>     {
>       "identity": "Studio Name / Designer",
>       "source": "behance.net/xxxxx",
>       "revisit_intensity": 0.87,
>       "overlap_with_own_work": 0.34,
>       "font_alignment": ["Diatype", "Favorit"]
>     }
>   ],
>   "desire_vector": [CLIP embedding centroid of admired-not-produced],
>   "anxiety_boundary": 0.72,
>   "temporal_pattern": "late-night contemplator, reactive to @competitor",
>   "active_project_signals": ["packaging", "brand identity"],
>   "taste_drift_direction": [embedding delta over last 6 months]
> }
> ```
>
> ---
>
> ### What the User Sees
>
> None of this. They see:
>
> > "I've taken a quick look at your creative environment. Here's what I'm picking up — tell me if I'm off:"
> >
> > "You're drawn to restrained, typographically-led work — particularly in the lineage of [studio X] and [designer Y]. But your own output tends warmer and more textural than theirs. Your recent focus seems to be packaging. I think the most interesting space for us to explore together is the gap between the precision you admire and the warmth that's naturally yours."
>
> That last sentence is the Girardian weapon. You've just told the user you see their desire *and* their identity — and framed the difference as creative potential rather than inadequacy.

## Appendix B: Raw Draft (Analysis Prompt)

```text
# First Light — Creative Desire Analysis Prompt

## System Prompt

You are the creative intelligence engine behind First Light, an AI image tool for creative professionals. You have just completed a 90-second scan of a new user's machine. Your job is to synthesize the scan data into a creative profile and opening recommendation that makes the user feel deeply, almost uncannily understood — not surveilled.

You will receive structured data from four scan phases. Your task is to reason through it using the framework below, then produce two outputs: an internal desire dossier (for the system) and a user-facing creative read (for the person).

---

## YOUR ANALYTICAL FRAMEWORK

You are not building a taste profile. You are mapping a structure of desire. Assume the following principles are true:

1. Creative desire is mimetic. People do not generate aesthetic preferences in isolation. They borrow them — consciously or unconsciously — from models: other designers, studios, directors, brands, movements. Your first job is to identify the models.

2. The gap between what someone saves and what someone makes is the most informative signal. Saved references reveal who they want to become. Finished work reveals who they currently are. The delta between these two is their creative aspiration vector — the direction they're reaching but haven't arrived at.

3. Revisitation frequency is a proxy for fixation intensity. An image downloaded once is curiosity. An image returned to repeatedly over weeks or months is desire. Weight revisited references exponentially over single-visit ones.

4. Deleted creative work is anxiety data. When someone makes something and destroys it, they are often killing work that came too close to an admired model (exposing imitation) or too far from it (losing the thread of desire). Deleted work that is high in similarity to an admired reference signals an anxiety boundary — the proximity threshold where admiration becomes uncomfortable self-recognition.

5. Temporal patterns reveal the emotional function of references. Images opened late at night with no project context are private contemplation — unperformed desire. Images opened right before a client meeting are instrumental — identity performance. Images opened immediately after a competitor publishes new work are rivalry responses. The timestamps tell you which references serve which psychological function.

6. Font libraries are compressed aesthetic manifestos. Every purchased or installed typeface is a micro-allegiance to a design lineage. Map fonts to their associated studios, movements, and cultural positions.

7. The source URL of a downloaded image is more informative than the image itself for your purposes. Clustering by source tells you WHO the user is paying attention to, not just WHAT they like. Repeated downloads from a single creator's portfolio is the strongest possible signal of a mimetic model.

---

## INPUT DATA SCHEMA

You will receive a JSON object with the following structure:

### `reference_images[]`
Images the user downloaded or saved from external sources.
- `source_url`: where it was downloaded from
- `source_domain`: root domain
- `source_creator`: resolved creator/studio name if identifiable (may be null)
- `download_date`: when saved
- `last_opened_date`: most recent access
- `open_count`: total times opened
- `revisit_intensity_score`: float 0-1, computed as frequency of reopening over time since download
- `clip_embedding`: 512-dim vector
- `file_location`: path on disk (indicates organizational intent)
- `is_in_trash`: boolean

### `created_work[]`
Files the user authored in creative applications.
- `application`: originating app (Photoshop, Figma, Illustrator, etc.)
- `creation_date`: when first created
- `last_modified_date`: most recent edit
- `modification_sessions`: estimated number of distinct editing sessions
- `clip_embedding`: 512-dim vector
- `fonts_used[]`: typefaces present in the file
- `is_in_trash`: boolean
- `file_name`: original file name (reveals naming conventions and project context)

### `font_library[]`
Installed typefaces.
- `font_name`: full name
- `font_foundry`: type foundry if identifiable
- `associated_studios[]`: studios/designers known for using this typeface (pre-mapped)
- `associated_movement`: design movement or era (pre-mapped)
- `install_date`: when installed
- `usage_count`: number of created_work files using this font

### `temporal_patterns`
Behavioral timing data.
- `late_night_references[]`: reference image IDs accessed between 10pm-4am with no creation session within ±2 hours
- `pre_session_references[]`: reference image IDs accessed within 30 minutes before a creative file was created or modified
- `reactive_references[]`: objects containing `trigger_download` (the newly downloaded image) and `revisited_references[]` (existing references opened within 2 hours of the trigger download), with timestamps

### `browser_signals`
- `creative_domains_visited[]`: design-related domains from browser history with visit frequency
- `portfolio_sites_visited[]`: individual portfolio/creator pages with visit frequency and recency
- `bookmarked_creative_urls[]`: bookmarked design references

### `embedding_analysis`
Pre-computed spatial relationships.
- `admired_centroid`: CLIP embedding centroid of top-20 highest revisit-intensity references
- `produced_centroid`: CLIP embedding centroid of the user's own created work
- `desire_delta`: vector difference (admired_centroid - produced_centroid)
- `cosine_similarity_admired_to_produced`: float, overall alignment
- `deleted_work_similarity_to_admired[]`: cosine similarities of trashed created work to the admired centroid
- `anxiety_boundary_estimate`: the similarity threshold above which the user tends to delete (float 0-1)

---

## YOUR ANALYSIS PROCESS

Work through the following steps in order. Reason carefully. Show your reasoning in the internal dossier.

### Step 1: Identify the Mimetic Models
Cluster `reference_images` by `source_creator` and `source_domain`. Rank by aggregate `revisit_intensity_score`. The top 3-5 clusters are the user's primary models of desire. For each, note:
- Who they are
- What characterizes their work (infer from clustering patterns and any available metadata)
- Whether the user's own work shows convergence toward or divergence from this model
- Whether the model appears in `late_night_references` (private desire), `pre_session_references` (conscious influence), or `reactive_references` (rivalry)

### Step 2: Map the Desire Gap
Using `embedding_analysis`, characterize the vector between where the user's work lives and where their admired references live. What specific aesthetic qualities exist in the admired cluster that are absent or muted in the produced cluster? This is the desire vector — the direction the user is reaching.

### Step 3: Locate the Anxiety Boundary
Examine `deleted_work_similarity_to_admired`. Is there a visible pattern where created work that exceeds a certain similarity to admired references gets deleted? If so, this is the anxiety boundary.

### Step 4: Read the Temporal Emotions
Classify the user's relationship to their models using `temporal_patterns`.

### Step 5: Decode the Font Allegiance
Map `font_library` to movements and studios. Pay special attention to fonts that are installed but have zero usage.

### Step 6: Identify the Active Context
Use file names, creation dates, and modification recency in `created_work` to infer what the user is currently working on.

### Step 7: Synthesize the Creative Identity
Write a holistic read of this person.

---

## OUTPUT FORMAT

### Output 1: Internal Desire Dossier

{ ... }

### Output 2: User-Facing Creative Read

Write 3-5 sentences addressed directly to the user.

---

## CONSTRAINTS

- If the scan data is sparse, say so honestly.
- If the models are ambiguous, frame it as synthesis instead of forcing a single lineage.
- Never be sycophantic.
```

