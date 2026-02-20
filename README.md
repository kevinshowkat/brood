# Brood: Promptless Canvas for Creative Mutation

<p align="left">
  <img src="media/features/readme/main_value_prop.gif" alt="Brood main value demo">
</p>

Brood is a reference-first AI image generation and editing desktop for developers.
You steer outputs by arranging and combining images on a canvas, then applying abilities.

## Live Workflow Highlights

### Realtime Canvas Proposals
Mother watches your on-canvas edits (move/resize/select), infers what you are emphasizing, and proposes the next best transformation without requiring a typed prompt.

<p align="left">
  <img src="media/features/readme/realtime_canvas_proposals.gif" alt="Realtime canvas proposals">
</p>

### Top Panel Telemetry Metrics
The top panel shows four live chips users can read at a glance: `TOK` (30m in/out token sparklines + API calls), `COST` (estimated session spend), `QUEUE` (pending/running actions + queue trend), and `AVG` (rolling render time), each heat-coded from cool to hot.

<p align="left">
  <img src="media/features/readme/top_panel_telemetry.gif" alt="Top panel telemetry metrics">
</p>

### Proposal Drafting
Mother (Brood's realtime proposal copilot) enters a drafting phase, assembles proposal context from the canvas state, then renders a candidate you can confirm, reject, or iterate.

<p align="left">
  <img src="media/features/readme/proposal_drafting.gif" alt="Mother proposal drafting">
</p>

## Status

Brood is currently a **macOS-only desktop app** (Tauri).
There is no web app, and Windows/Linux builds are not supported yet.

## Rust Migration Roadmap

### Current State (v0.1.6)

- Desktop runtime defaults to native Rust (`brood-rs`).
- macOS release packaging/signing/notarization includes the staged Rust engine binary.
- Legacy Python runtime paths have been retired from the repository.

### Near-Term (Next Milestones)

- Expand Rust provider parity coverage for desktop-critical image/edit/reference flows.
- Keep event/artifact compatibility stable (`events.jsonl`, receipt/thread/summary payload shapes).
- Complete broader live-probe validation and eliminate remaining migration edge cases.

## Download (macOS)

Get the latest universal DMG from GitHub Releases:
- <https://github.com/kevinshowkat/brood/releases>

Install:
1. Download `Brood_<version>_universal.dmg`.
2. Open the DMG and drag `Brood.app` into `/Applications`.
3. If macOS blocks launch, right-click `Brood.app` and choose **Open**.

## Current App Surface

- Canvas-first desktop with `Single view` and `Multi view`, plus pan/zoom/fit controls.
- Action Grid + bottom HUD workflow for tooling and execution feedback.
- Built-in local file-browser dock import flow, plus canvas import drag/drop.
- Multi-provider model support: OpenAI, Gemini, Imagen, Flux, SDXL.

### Abilities by Image Selection

- 1 image: `Diagnose`, `Recast`, `Background: White`, `Background: Sweep`, `Crop: Square`, `Variations`.
- 2 images: `Combine`, `Swap DNA`, `Bridge`, `Argue`.
- Multi-view effect-token pipeline: `Extract DNA`, `Soul Leech`, then drag token onto a target image.

### Mother Workflow

- Mother observes your canvas and proposes edits.
- Proposal loop supports next/propose, confirm/deploy, reject/stop, and reroll-style follow-ups.
- Proposal intent and generation are fed by structured context packets (see below).

## First 5 Minutes (Desktop)

1. Import one or more images.
2. Arrange/resize on canvas to communicate intent.
3. Let Mother propose, then confirm or reject.
4. Run direct Abilities as needed and inspect HUD output (`DIAG` / `ARG`).

More usage details: `docs/desktop.md`.

## Mother Context Packets

Brood now ships compact context packets for both proposal inference and Gemini generation:
- `brood.mother.proposal_context.v1` (intent/proposal soft priors)
- `brood.gemini.context_packet.v2` (generation-time proposal lock + spatial hints)

Details and scoring math:
- `docs/desktop.md#mother-proposal--gemini-context-v2`

## Run Artifacts and Debugging

Each desktop run writes artifacts under `~/brood_runs/run-*`, including:
- `events.jsonl` (desktop/engine event stream)
- `mother_intent_infer-*.json`, `mother_prompt_compile-*.json`, `mother_generate-*.json`
- `receipt-*.json` (generation/edit receipts)

For Gemini wire-level inspection:
- set `BROOD_DEBUG_GEMINI_WIRE=1` before launching the app
- inspect `_raw_provider_outputs/gemini-send-message-*.json` and `gemini-receipt-*.json`

## Hotkeys

- `L` lasso
- `D` designate
- `F` fit-to-view
- `Esc` clear selection
- `1`-`9` activate HUD tools

## Run From Source (Desktop)

```bash
./scripts/dev_desktop.sh
```

This runs the Tauri app in dev mode (`desktop/`) with the native Rust engine path.
Desktop runtime no longer includes Python compat fallback paths.

Build desktop app:

```bash
cd desktop
npm install
npm run tauri build
```

## Engine / CLI Quickstart

The native Rust CLI powers the desktop app and can also run standalone.

### Rust CLI (default)

```bash
cd rust_engine

# Chat loop
cargo run -p brood-cli -- chat --out /tmp/brood-run --events /tmp/brood-run/events.jsonl

# Single run
cargo run -p brood-cli -- run --prompt "hero image for Series A" --out /tmp/brood-run

# Recreate flow
cargo run -p brood-cli -- recreate --reference path/to/image.png --out /tmp/brood-recreate
```

## API Keys

- Copy `.env.example` to `.env` and fill provider keys.
- Supported key families: OpenAI, Anthropic, Gemini/Google, Imagen/Vertex, Flux/BFL.
- For OpenAI image models:
  - set `OPENAI_API_KEY` (or `OPENAI_API_KEY_BACKUP`)
  - use `/image_model gpt-image-1` in chat or `--image-model gpt-image-1` on CLI
  - optional: `OPENAI_IMAGE_USE_RESPONSES=1`, `OPENAI_IMAGE_STREAM=1`

## Optional Configuration

Enable local memory:

```bash
export BROOD_MEMORY=1
```

Pricing/latency override file:

- `~/.brood/pricing_overrides.json`

## Troubleshooting (Desktop)

- **App failed to initialize: Importing binding name ... not found**  
  Repo expects Tauri v1 APIs (`@tauri-apps/api` v1 and v1 CLI).
- **Images not rendering**  
  Tauri must allow file access under `$HOME/**` (see `desktop/src-tauri/tauri.conf.json`).
- **Import Photos fails or does nothing**  
  Selected files must be inside allowed FS scope (`$HOME/**` by default).

## Project Layout

- `rust_engine/` native engine and CLI (default desktop runtime)
- `desktop/` Tauri desktop app
- `desktop/test/` desktop JS tests
- `docs/param_forge_reference.md` Param Forge reference notes
- `docs/desktop.md` desktop UI notes (abilities + workflows)

## Agent / LLM Entrypoints

- `llms.txt` high-signal entrypoints and task routing
- `llms-full.txt` expanded inlined context (`python3 scripts/build_llms_full.py`)
- `agent-intake.json` optional Agent Intake Protocol (AIP) contract
- `scripts/aip_build_packs.py` build JSON context packs to `outputs/aip_packs/`
- `scripts/aip_server.py` stdlib-only local AIP stub server

## License

Apache License 2.0. See `LICENSE`.
