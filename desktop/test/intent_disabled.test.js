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

test("Intent Canvas: onboarding decider is disabled (HUD + deck visible by default)", () => {
  assert.match(app, /const INTENT_CANVAS_ENABLED = false/);
  assert.match(app, /function intentModeActive\(\) \{\n\s*if \(!INTENT_CANVAS_ENABLED\) return false;/);
  assert.match(app, /intent:\s*\{[\s\S]*locked:\s*true,/);
  assert.match(app, /state\.intent\.locked = true;/);
  assert.match(app, /const intentActive = intentModeActive\(\);/);
});

test("Intent Canvas: CSS still exists but won't hide HUD without intent-mode class", () => {
  assert.match(css, /\.canvas-wrap\.intent-mode\s+\.hud/);
  assert.match(css, /\.canvas-wrap\.intent-mode\s+\.canvas-bumper/);
});
