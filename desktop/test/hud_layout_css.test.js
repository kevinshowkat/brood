import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "src", "styles.css");
const css = readFileSync(cssPath, "utf8");

test("HUD: width/center preserve legacy right-rail pixel geometry", () => {
  assert.match(css, /--right-rail-w:\s*432px/);
  assert.match(css, /--hud-w:\s*calc\(\(100% - var\(--right-rail-w\)\) \* 0\.8\)/);
  assert.match(css, /--hud-x:\s*calc\(\(100% - var\(--right-rail-w\)\) \/ 2\)/);
  assert.match(css, /\.hud\s*\{[\s\S]*left:\s*var\(--hud-x\)/);
  assert.match(css, /\.hud\s*\{[\s\S]*width:\s*var\(--hud-w\)/);
});

test("Bumpers: right bumper reaches screen edge", () => {
  assert.match(css, /--bumper-right-w:\s*max\(/);
  assert.match(css, /\.canvas-bumper--right\s*\{[\s\S]*right:\s*0/);
  assert.match(css, /\.canvas-bumper--right\s*\{[\s\S]*width:\s*var\(--bumper-right-w\)/);
});

