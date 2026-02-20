# Realtime Canvas, Intent Proposal, and Generation Flow

This diagram shows how the desktop canvas talks to realtime intent proposal and how accepted actions flow into native generation.

## Components

![Components diagram](./assets/diagrams/realtime_canvas_intent_generation_flow/components.svg)

SVG: `docs/assets/diagrams/realtime_canvas_intent_generation_flow/components.svg`  
PNG: `docs/assets/diagrams/realtime_canvas_intent_generation_flow/components.png`  
Source: `docs/assets/diagrams/realtime_canvas_intent_generation_flow/src/components.mmd`

```mermaid
flowchart LR
  subgraph Desktop["Desktop App (Tauri)"]
    UI["Canvas UI<br/>desktop/src/canvas_app.js"]
    Poller["Event poller<br/>read_file_since(events.jsonl)"]
    PTY["Tauri PTY bridge<br/>spawn_pty / write_pty"]
  end

  subgraph Engine["Native Engine Runtime"]
    CLI["brood-rs chat<br/>rust_engine/crates/brood-cli/src/main.rs"]
    RT["Realtime workers<br/>IntentIconsRealtimeSession<br/>CanvasContextRealtimeSession"]
    Core["BroodEngine<br/>preview_plan + generate"]
    Providers["Native providers<br/>(FAL/OpenAI/etc)"]
    Events["events.jsonl<br/>append-only event log"]
  end

  UI -->|invoke write_pty| PTY --> CLI
  UI -->|invoke read_file_since| Poller --> Events
  CLI --> RT
  RT -->|intent_icons / canvas_context| Events
  CLI -->|generation commands| Core --> Providers
  Core -->|plan_preview -> version_created -> artifact_created -> cost_latency_update| Events
  Events --> Poller --> UI
```

## Realtime Intent Loop (Ambient + Mother)

![Realtime intent loop sequence diagram](./assets/diagrams/realtime_canvas_intent_generation_flow/realtime_intent_loop.svg)

SVG: `docs/assets/diagrams/realtime_canvas_intent_generation_flow/realtime_intent_loop.svg`  
PNG: `docs/assets/diagrams/realtime_canvas_intent_generation_flow/realtime_intent_loop.png`  
Source: `docs/assets/diagrams/realtime_canvas_intent_generation_flow/src/realtime_intent_loop.mmd`

```mermaid
sequenceDiagram
  participant User as User
  participant Canvas as Canvas UI (canvas_app.js)
  participant Tauri as Tauri PTY bridge
  participant CLI as brood-rs chat
  participant RT as IntentIconsRealtimeSession
  participant Log as events.jsonl

  User->>Canvas: Import/move/resize/select images
  Canvas->>Canvas: scheduleAmbientIntentInference() / motherV2RequestIntentInference()
  Canvas->>Canvas: writeIntentSnapshot() + writeIntentContextEnvelope()
  Canvas->>Tauri: /intent_rt_start or /intent_rt_mother_start
  Canvas->>Tauri: /intent_rt "<snapshot>" or /intent_rt_mother "<snapshot>"
  Tauri->>CLI: PTY line
  CLI->>RT: submit_snapshot(path)
  RT-->>Log: intent_icons (partial=true, streaming deltas)
  RT-->>Log: intent_icons (partial=false, final payload)
  Canvas->>Log: poll with read_file_since(events.jsonl)
  Canvas->>Canvas: parseIntentIconsJsonDetailed(text)
  alt payload parses
    Canvas->>Canvas: update iconState (intent/ambient)
    Canvas->>Canvas: rebuild ambient suggestions + update per-image vision_desc
    Canvas->>Canvas: motherV2ApplyIntent() when mother-scoped
  else parse/error/timeout/fatal
    Canvas->>Canvas: local fallback icon state + retry policy
  end
```

## Generation Loop (Action Grid or Mother Dispatch)

![Generation loop sequence diagram](./assets/diagrams/realtime_canvas_intent_generation_flow/generation_loop.svg)

SVG: `docs/assets/diagrams/realtime_canvas_intent_generation_flow/generation_loop.svg`  
PNG: `docs/assets/diagrams/realtime_canvas_intent_generation_flow/generation_loop.png`  
Source: `docs/assets/diagrams/realtime_canvas_intent_generation_flow/src/generation_loop.mmd`

```mermaid
sequenceDiagram
  participant User as User
  participant Canvas as Canvas UI
  participant Tauri as Tauri PTY bridge
  participant CLI as brood-rs chat
  participant Engine as BroodEngine::generate
  participant Provider as Native provider
  participant Log as events.jsonl

  User->>Canvas: Run skill (Combine/Bridge/Swap/Recast/Mother)
  Canvas->>Tauri: /blend | /bridge | /swap_dna | /recast | /mother_generate <payload>
  Tauri->>CLI: PTY line
  CLI->>Engine: preview_plan(prompt, settings, intent)
  Engine-->>Log: plan_preview
  CLI->>Engine: generate(prompt, settings, intent)
  Engine-->>Log: version_created
  Engine->>Provider: provider.generate(...)
  Provider-->>Engine: result image(s)
  Engine-->>Log: artifact_created (1..N)
  Engine-->>Log: cost_latency_update
  Canvas->>Log: poll with read_file_since(events.jsonl)
  Canvas->>Canvas: add image/timeline, clear pending state, render updates
  opt generation error
    Engine-->>Log: generation_failed
    Canvas->>Canvas: show error, keep UI responsive
  end
```

## PTY Command and Event Map

| PTY command | Primary emitted events |
| --- | --- |
| `/intent_rt` | `intent_icons`, `intent_icons_failed` |
| `/intent_rt_mother` | `intent_icons`, `intent_icons_failed` (mother-scoped) |
| `/canvas_context_rt` | `canvas_context`, `canvas_context_failed` |
| `/mother_generate`, `/blend`, `/bridge`, `/swap_dna`, `/recast`, `/triforce` | `plan_preview`, `version_created`, `artifact_created`, `cost_latency_update` (or `generation_failed`) |

## Ordering Contract

For successful generation flows, event order must stay:

1. `plan_preview`
2. `version_created`
3. `artifact_created`
4. `cost_latency_update`

This order is emitted in `rust_engine/crates/brood-engine/src/lib.rs` and covered by engine tests in the same file.
