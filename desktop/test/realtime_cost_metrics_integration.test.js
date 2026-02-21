import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Realtime pricing constants include gpt-realtime-mini token rates", () => {
  assert.match(
    app,
    /REALTIME_TOKEN_PRICING_USD_PER_1K = Object\.freeze\([\s\S]*"gpt-realtime-mini"\s*:\s*Object\.freeze\(\{\s*input:\s*0\.0006,\s*output:\s*0\.0024\s*\}\)/
  );
});

test("Realtime cost ingest helper gates on finalized supported realtime payloads", () => {
  const fnMatch = app.match(/function topMetricIngestRealtimeCostFromPayload\(payload, \{ render = false \} = \{\}\) \{[\s\S]*?\n}\n\nfunction topMetricIngestCost/);
  assert.ok(fnMatch, "topMetricIngestRealtimeCostFromPayload function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /if \(payload\.partial\) return false;/);
  assert.match(fnText, /const source = String\(payload\.source \|\| ""\)\.trim\(\)\.toLowerCase\(\);/);
  assert.match(fnText, /if \(!realtimeSourceSupported\(source\)\) return false;/);
  assert.match(fnText, /const tokens = extractTokenUsage\(payload\);/);
  assert.match(fnText, /const estimate = estimateRealtimeTokenCostUsd\(\{/);
  assert.match(fnText, /topMetricIngestCost\(estimate\);/);
});

test("Realtime source helper accepts openai and gemini realtime source tags", () => {
  assert.match(
    app,
    /function realtimeSourceSupported\(source\) \{[\s\S]*normalized === "openai_realtime" \|\| normalized === "gemini_flash";/
  );
});

test("Realtime final canvas/intents events feed estimated realtime cost into COST", () => {
  assert.match(
    app,
    /eventType === DESKTOP_EVENT_TYPES\.CANVAS_CONTEXT[\s\S]*const isPartial = Boolean\(event\.partial\);[\s\S]*if \(!isPartial\) \{[\s\S]*topMetricIngestRealtimeCostFromPayload\(event, \{ render: true \}\);/
  );
  assert.match(
    app,
    /event\.type === DESKTOP_EVENT_TYPES\.INTENT_ICONS[\s\S]*const isPartial = Boolean\(event\.partial\);[\s\S]*if \(!isPartial\) \{[\s\S]*topMetricIngestRealtimeCostFromPayload\(event, \{ render: true \}\);/
  );
});
