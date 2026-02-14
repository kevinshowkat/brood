import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "src", "index.html");
const cssPath = join(here, "..", "src", "styles.css");
const html = readFileSync(htmlPath, "utf8");
const css = readFileSync(cssPath, "utf8");

test("Menu: gear toggle + popover exist and include core actions", () => {
  assert.match(html, /id=\"app-menu-toggle\"/);
  assert.match(html, /id=\"app-menu\"/);

  for (const id of ["new-run", "open-run", "import", "export", "settings-toggle"]) {
    assert.match(html, new RegExp(`id=\\"${id}\\"`));
  }
});

test("Menu: AUTO toggle is inside the menu popover", () => {
  assert.match(html, /id=\"app-menu\"[\s\S]*id=\"auto-accept-suggested-ability-toggle\"/);
});

test("Menu: menu items close the popover via data-menu-close", () => {
  for (const id of ["new-run", "open-run", "import", "export", "settings-toggle"]) {
    assert.match(html, new RegExp(`id=\\"${id}\\"[^>]*data-menu-close=\\"1\\"`));
  }
});

test("Reel mode is buried in Settings admin tools (not top-level UI)", () => {
  assert.doesNotMatch(html, /id=\"reel-mode-toggle\"/);
  assert.doesNotMatch(html, /id=\"reel-size-button\"/);
  assert.match(html, /id=\"settings-drawer\"[\s\S]*key-status-title\">Admin/);
  assert.match(html, /id=\"reel-admin-toggle\"/);
});

test("Layout: legacy inspector/right panel is removed (canvas expands)", () => {
  assert.doesNotMatch(html, /class=\"inspector\"/);
  assert.doesNotMatch(html, /<aside\b/);
});

test("Menu: z-index is above canvas and other overlays", () => {
  assert.match(css, /\.brand-strip\s*\{[\s\S]*z-index:\s*1000/);
  assert.match(css, /\.app-menu\s*\{[\s\S]*z-index:\s*1100/);
});
