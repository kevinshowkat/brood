import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "src", "index.html");
const appPath = join(here, "..", "src", "canvas_app.js");
const html = readFileSync(htmlPath, "utf8");
const app = readFileSync(appPath, "utf8");

test("Top metrics ribbon places API chip after COST", () => {
  assert.match(
    html,
    /id=\"top-metric-cost\"[\s\S]*id=\"top-metric-cost-value\"[\s\S]*id=\"top-metric-api-calls\"[\s\S]*id=\"top-metric-api-calls-value\"[\s\S]*id=\"top-metric-queue\"/
  );
});

test("Top metrics renderer binds API chip value to sessionApiCalls", () => {
  const fnMatch = app.match(/function renderTopMetricsGrid\(\)[\s\S]*?\n}\n\nfunction resetTopMetrics/);
  assert.ok(fnMatch, "renderTopMetricsGrid function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /if \(els\.topMetricApiCalls\) \{/);
  assert.match(fnText, /els\.topMetricApiCalls\.dataset\.heat = "nodata";/);
  assert.match(fnText, /if \(els\.topMetricApiCallsValue\) \{/);
  assert.match(fnText, /const apiCalls = Math\.max\(0, Number\(state\.sessionApiCalls\) \|\| 0\);/);
  assert.match(fnText, /els\.topMetricApiCallsValue\.textContent = Number\.isFinite\(apiCalls\)/);
});
