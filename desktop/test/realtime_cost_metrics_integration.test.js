import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Realtime pricing constants include OpenAI and Gemini realtime token rates", () => {
  assert.match(
    app,
    /REALTIME_TOKEN_PRICING_USD_PER_1K = Object\.freeze\([\s\S]*"gpt-realtime-mini"\s*:\s*Object\.freeze\(\{\s*input:\s*0\.0006,\s*output:\s*0\.0024\s*\}\)/
  );
  assert.match(
    app,
    /REALTIME_TOKEN_PRICING_USD_PER_1K = Object\.freeze\([\s\S]*"gpt-4o-mini"\s*:\s*Object\.freeze\(\{\s*input:\s*0\.00015,\s*output:\s*0\.0006\s*\}\)/
  );
  assert.match(
    app,
    /REALTIME_TOKEN_PRICING_USD_PER_1K = Object\.freeze\([\s\S]*"gemini-3-flash-preview"\s*:\s*Object\.freeze\(\{\s*input:\s*0\.0005,\s*output:\s*0\.003\s*\}\)/
  );
});

test("Realtime pricing model helper maps OpenRouter-prefixed and Gemini Flash aliases", () => {
  const fnMatch = app.match(/function topMetricRealtimePricingForModel\(model\) \{[\s\S]*?\n}\n\nfunction estimateRealtimeTokenCostUsd/);
  assert.ok(fnMatch, "topMetricRealtimePricingForModel function not found");
  const fnText = fnMatch[0];
  assert.match(fnText, /replace\(\s*\/\^openai\\\//);
  assert.match(fnText, /replace\(\s*\/\^google\\\//);
  assert.match(fnText, /replace\(\s*\/\^openrouter\\\//);
  assert.match(fnText, /normalized\.startsWith\("gpt-4o-mini"\)/);
  assert.match(fnText, /normalized\.startsWith\("gemini-3-flash-preview"\)/);
  assert.match(fnText, /normalized\.startsWith\("gemini-3\.0-flash"\)/);
});

test("Realtime cost ingest helper gates on finalized supported realtime payloads", () => {
  const fnMatch = app.match(/function topMetricIngestRealtimeCostFromPayload\(payload, \{ render = false \} = \{\}\) \{[\s\S]*?\n}\n\nfunction topMetricIngestCost/);
  assert.ok(fnMatch, "topMetricIngestRealtimeCostFromPayload function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /if \(payload\.partial\) return false;/);
  assert.match(fnText, /const source = String\(payload\.source \|\| ""\)\.trim\(\)\.toLowerCase\(\);/);
  assert.match(fnText, /if \(!realtimeSourceSupported\(source\)\) return false;/);
  assert.match(fnText, /const tokens = extractTokenUsage\(payload\);/);
  assert.match(fnText, /const pricingModel = payload\.provider_model \|\| payload\.model;/);
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
