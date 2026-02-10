import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "src", "styles.css");
const css = readFileSync(cssPath, "utf8");

test("Tool hover: bevel stays stable (no hover-induced pixel jiggle)", () => {
  assert.match(css, /\.tool:hover\s*\{[\s\S]*border-top-color:\s*rgba\(255,\s*255,\s*255,\s*0\.14\)/);
  assert.match(css, /\.tool:hover\s*\{[\s\S]*border-left-color:\s*rgba\(255,\s*255,\s*255,\s*0\.12\)/);
});

