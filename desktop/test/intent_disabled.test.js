import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const cssPath = join(here, "..", "src", "styles.css");
const app = readFileSync(appPath, "utf8");
const css = readFileSync(cssPath, "utf8");

test("Intent Canvas: onboarding gate stays disabled while ambient inference is enabled", () => {
  assert.match(app, /const INTENT_CANVAS_ENABLED = false/);
  assert.match(app, /const INTENT_AMBIENT_ENABLED = true/);
  assert.match(app, /const INTENT_AMBIENT_ICON_PLACEMENT_ENABLED = false/);
  assert.match(app, /intentAmbient:\s*\{/);
  assert.match(app, /function intentAmbientActive\(\)/);
});

test("Intent Canvas: ambient suggestion model uses future-ready asset fields", () => {
  assert.match(app, /asset_type/);
  assert.match(app, /asset_key/);
  assert.match(app, /asset_src/);
  assert.match(app, /renderAmbientIntentNudges\(/);
});

test("Intent Canvas: CSS still hides HUD only for explicit intent-mode onboarding", () => {
  assert.match(css, /\.canvas-wrap\.intent-mode\s+\.hud/);
  assert.match(css, /\.canvas-wrap\.intent-mode\s+#spawnbar/);
  assert.match(css, /\.canvas-wrap\.intent-ambient-rt-active::after/);
});

test("Intent Canvas: ambient icon placement/rendering is hard-gated off", () => {
  assert.match(app, /if \(!INTENT_AMBIENT_ICON_PLACEMENT_ENABLED\) return false;\s*const ambient = state\.intentAmbient;/);
  assert.match(app, /if \(!INTENT_AMBIENT_ICON_PLACEMENT_ENABLED\) return null;/);
  assert.match(app, /if \(!INTENT_AMBIENT_ICON_PLACEMENT_ENABLED\) \{\s*if \(ambient\) ambient\.uiHits = \[\];\s*return;\s*\}/);
});
