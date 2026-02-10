import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "src", "styles.css");
const appPath = join(here, "..", "src", "canvas_app.js");
const css = readFileSync(cssPath, "utf8");
const app = readFileSync(appPath, "utf8");

test("Settings drawer: offset uses --brand-strip-h so the close button isn't hidden behind the top bar", () => {
  assert.match(css, /--brand-strip-h:\s*52px/);
  assert.match(css, /\.drawer\s*\{[\s\S]*top:\s*var\(--brand-strip-h\)/);
  assert.match(css, /\.drawer\s*\{[\s\S]*height:\s*calc\(100vh - var\(--brand-strip-h\)\)/);
  assert.match(app, /function syncBrandStripHeightVar\(\)/);
  assert.match(app, /setProperty\(\"--brand-strip-h\"/);
});

