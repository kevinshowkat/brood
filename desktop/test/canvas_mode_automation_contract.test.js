import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Automation canvas mode contract: single mode is explicitly rejected", () => {
  assert.match(app, /function _resolveAutomationCanvasMode\(value,\s*actionName = "canvas_action"\)/);
  assert.match(app, /mode=single is no longer supported; use mode=multi/);
  assert.match(app, /const modeResult = _resolveAutomationCanvasMode\(actionPayload\.mode,\s*"set_canvas_mode"\)/);
  assert.doesNotMatch(app, /const mode = rawMode === "single" \? "single" : "multi";/);
});

test("Automation canvas actions validate mode before mutating view state", () => {
  assert.match(app, /_resolveAutomationCanvasMode\(payload\.mode,\s*"canvas_pan"\)/);
  assert.match(app, /_resolveAutomationCanvasMode\(payload\.mode,\s*"canvas_zoom"\)/);
  assert.match(app, /_resolveAutomationCanvasMode\(payload\.mode,\s*"canvas_fit_all"\)/);
});
