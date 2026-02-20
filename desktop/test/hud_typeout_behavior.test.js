import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("HUD UNIT typeout starts from renderHudReadout for first-time vision labels", () => {
  const fnMatch = app.match(/function renderHudReadout\(\)[\s\S]*?\n}\n\n\/\/ Give vision requests enough time/);
  assert.ok(fnMatch, "renderHudReadout function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /const activeImageId = String\(img\?\.id \|\| ""\)\.trim\(\);/);
  assert.match(fnText, /if \(descFromVision && !typeoutLocked && hudDescShouldStartTypeout\(activeImageId, descText\)\) \{/);
  assert.match(fnText, /startHudDescTypeout\(activeImageId, descText\);/);
});

test("setActiveImage relies on renderHudReadout for UNIT typeout (no duplicate manual trigger)", () => {
  const fnMatch = app.match(/async function setActiveImage\([\s\S]*?\n}\n\nfunction addImage/);
  assert.ok(fnMatch, "setActiveImage function not found");
  const fnText = fnMatch[0];

  assert.doesNotMatch(fnText, /startHudDescTypeout\(/);
});
