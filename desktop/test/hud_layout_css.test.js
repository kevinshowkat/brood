import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "src", "styles.css");
const css = readFileSync(cssPath, "utf8");

test("HUD: width/center preserve legacy right-rail pixel geometry", () => {
  assert.match(css, /--hud-main-w:\s*clamp\(/);
  assert.match(css, /--control-strip-h:\s*calc\(var\(--hud-keybar-h\)\s*\+\s*2px\)/);
  assert.match(css, /\.hud\s*\{[\s\S]*width:\s*var\(--hud-main-w\)/);
  assert.match(css, /\.control-strip\s*\{[\s\S]*height:\s*var\(--control-strip-h\)/);
});

test("Bumpers: right bumper reaches screen edge", () => {
  assert.match(css, /\.canvas-bumper\s*\{[\s\S]*flex:\s*1\s+1\s+0/);
  assert.match(css, /\.canvas-bumper\s*\{[\s\S]*height:\s*var\(--control-strip-h\)/);
  assert.match(css, /\.canvas-bumper--right\s*\{/);
});
