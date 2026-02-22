# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog (https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.3] - 2026-02-22
- Fix Mother realtime timeout failures firing after proposal confirm by clearing stale in-flight intent requests before drafting.
- Fix orphaned Mother `pendingIntent` latch when cancel/reject happens during realtime intent setup.
- Add transform-aware prompt compile context and mother role tether updates for proposal/generation alignment.
- Update Mother generate payload test expectation to match the finalized prompt variable wiring.

## [0.2.2] - 2026-02-22
- Add first-run OpenRouter onboarding in desktop (key capture, save, and connectivity verification).
- Add provider-aware realtime routing/gating, including Gemini Flash realtime path support and OpenRouter-first transport behavior.
- Improve Mother realtime proposal flow/recovery behavior and tighten proposal ranking/output shaping.
- Add in-canvas `Set Vibe` mood steering (`Joyous`, `Nefarious`, `Somber`, `Angry`) for Mother proposals.
- Improve prompt strategy benchmark reliability and Mother prompt workflow consistency.

## [0.2.1] - 2026-02-21
- Retire desktop Python compatibility fallback paths; startup/export now fail explicitly when native engine launch fails.
- Remove the legacy `brood_engine/` package, Python parity `tests/`, and Python runtime packaging metadata.
- Move default pricing table ownership to `rust_engine/crates/brood-engine/resources/default_pricing.json`.
- Remove single-view runtime mode and reject legacy automation requests targeting `single`.
- Add `Prompt Generate` as an Action Grid skill with model selection modal, cursor-anchored insert placement, and pending shimmer placeholder.
- Prevent auto-accept suggestion passes from being consumed by `Prompt Generate` (manual-input-only action).
- Stabilize Action Grid slot positions between empty/single-image states and remove dedicated pan tile.
- Upgrade `Create Layers` to a semantic background/subject/props pipeline.
- Remove generated artifact payloads and legacy root archive files from the repository, and sanitize sample harness paths.

## [0.1.7] - 2026-02-20
- Fix Mother realtime intent recovery races by revalidating pending request state after async retry decisions.
- Defer timeout-driven Mother realtime retries until the worker timeout window elapses to avoid duplicate in-flight realtime calls.
- Restore native Rust cost/latency estimate parity in receipt metadata and `cost_latency_update` events so desktop top-ribbon cost updates correctly.

## [0.1.6] - 2026-02-20
- Fix macOS publish notarization by signing staged `resources/brood-rs` with Developer ID, hardened runtime, and secure timestamp during release builds.

## [0.1.5] - 2026-02-20
- Move desktop runtime to native Rust engine by default while preserving explicit emergency compat fallback via `BROOD_EMERGENCY_COMPAT_FALLBACK`.
- Keep PTY/slash-command and event-contract compatibility while routing Mother `/intent_infer` and `/prompt_compile` through provider-backed Rust paths.
- Improve desktop-used provider parity for image edit/reference flows (OpenAI/Gemini/Flux/Imagen), including option normalization and metadata/warnings handling.
- Harden always-on realtime vision labeling for faster, more specific per-image HUD descriptions without heuristic name injection.
- Package and prefer repo-local/staged `brood-rs` binary paths across desktop/Tauri startup and export flows.

## [0.1.2] - 2026-02-14
- Fix single-canvas pan tap detection so tap-to-open Mother wheel remains reliable after bridge output flows.
- Restore add-photo visibility after single-view bridge flows by returning to multi canvas when multiple images are present.
- Ensure Mother draft acceptance dispatches only through structured payloads so full canvas image context is included.
- Improve clean-machine smoke DMG selection by choosing the newest artifact by modification time.

## [0.1.1] - 2026-02-13
- Polish Mother proposal/readout UI with panel-native icon states and smoother transitions.
- Fix Mother proposal cycling and intent inference races (including late-event request matching).
- Improve proposal tooltip accuracy by using full intent context.

## [0.1.0] - 2026-02-12
- Initial version.
