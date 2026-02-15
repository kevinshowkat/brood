# Top Strip Metrics Heatmap Grid

## Goal
Replace the current single `API calls` readout in the top strip with a compact heatmap-style `2 x 2` metrics grid that surfaces session health in real time.

Required metrics:
- Sparkline charts showing tokens in and tokens out over the past `30m`
- Estimated cost of session
- Queued calls
- Average render time (seconds)

## Placement
- Current element: `#engine-status` in `desktop/src/index.html`
- New location: same `brand-strip` area, replacing or expanding `#engine-status` inside `.brand-stack`
- Keep this visible at all times during a run

## Layout (Heatmap Grid)
Use four equal metric tiles:

```text
+---------------------------+---------------------------+
| Tokens In/Out (30m)       | Estimated Session Cost    |
| In: 42.1k  Out: 18.7k     | $1.83                     |
| ▁▂▃▅▄▃▂▁▂▃▅...            |                           |
| ▂▁▁▂▃▄▃▂▂▁▂...            |                           |
+---------------------------+---------------------------+
| Queued Calls              | Avg Render Time (s)       |
| Pending: 3  Running: 1    | 12.4s                     |
| Queue depth trend: ▁▁▂▃▂  | Last 20 renders           |
+---------------------------+---------------------------+
```

Each tile should have a heat level background:
- `cool` (healthy): low intensity
- `warm` (watch): medium intensity
- `hot` (risk): high intensity
- `nodata`: neutral

## Metric Definitions

| Tile | Definition | Window | Display |
|---|---|---|---|
| Tokens In/Out | Sum of `input` and `output` tokens per minute | Last 30 minutes | Two values (`In`, `Out`) + two sparklines (30 points each) |
| Estimated Session Cost | Running sum of estimated USD cost for this session | Session | Dollar amount with 2-4 decimals |
| Queued Calls | Current action queue pressure | Live | `Pending` and `Running` counts |
| Avg Render Time (s) | Mean render duration for successful generations | Rolling last 20 renders (or 30m) | One numeric value in seconds |

## Heat Thresholds (Initial)

| Metric | Cool | Warm | Hot |
|---|---|---|---|
| Tokens total per minute (`in + out`) | `< 2k` | `2k-8k` | `> 8k` |
| Estimated session cost | `< $1` | `$1-$5` | `> $5` |
| Queued calls (`pending + running`) | `0-1` | `2-3` | `>= 4` |
| Avg render time | `< 8s` | `8s-18s` | `> 18s` |

These thresholds should be configurable (constants first, settings later).

## Data Hooks in Current App
Primary file: `desktop/src/canvas_app.js`

- Existing top strip value:
  - `renderSessionApiCallsReadout()`
  - `state.sessionApiCalls`
- Existing cost/latency event:
  - `DESKTOP_EVENT_TYPES.COST_LATENCY_UPDATE`
  - `state.lastCostLatency`
- Existing queue state:
  - `state.actionQueue`
  - `state.actionQueueActive`
- Render completion/failure events:
  - `DESKTOP_EVENT_TYPES.ARTIFACT_CREATED`
  - `DESKTOP_EVENT_TYPES.GENERATION_FAILED`

## Implementation Notes
1. Create a new `state.topMetrics` object with:
   - minute-bucket ring buffers for tokens in/out (30 buckets)
   - running `sessionEstimatedCostUsd`
   - queue counters derived from queue state
   - recent render duration samples
2. Replace `renderSessionApiCallsReadout()` with `renderTopMetricsGrid()` (or call both during migration).
3. Keep `API calls` available as a compact sub-label in one tile tooltip.
4. For token sparklines:
   - prefer structured token usage from events/receipts
   - if unavailable, show `No token telemetry` and keep tile in `nodata`
5. Recompute heat class per tile at each render tick/event update.

## Acceptance Criteria
- Top strip shows exactly four tiles in a heatmap-like `2 x 2` grid.
- Tokens tile displays two 30-minute sparklines (`in` and `out`).
- Session cost updates during the run without manual refresh.
- Queue tile updates when actions are enqueued/dequeued/active.
- Avg render time updates after new successful renders.
- Layout remains readable on standard desktop widths used by Brood.
