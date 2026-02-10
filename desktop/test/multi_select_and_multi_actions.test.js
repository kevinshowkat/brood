import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Multi-select: state.selectedIds exists and selection is capped at 3", () => {
  assert.match(app, /selectedIds:\s*\[\]/);
  assert.match(app, /Cap multi-select to 3 images/);
  assert.match(app, /if\s*\(next\.length\s*>\s*3\)\s*next\s*=\s*next\.slice/);
});

test("Multi-select: modifier-click toggles selection in multi canvas (Cmd/Ctrl + Shift)", () => {
  assert.match(app, /const toggle = Boolean\(event\.metaKey \|\| event\.ctrlKey \|\| \(event\.shiftKey && state\.tool !== \"annotate\"\)\)/);
  assert.match(app, /selectCanvasImage\(hit,\s*\{\s*toggle\s*\}\)/);
});

test("Multi-image abilities: pair + triplet actions use selected images, not total run image count", () => {
  for (const count of [2, 3]) {
    assert.match(app, new RegExp(`getSelectedImagesActiveFirst\\(\\{ requireCount: ${count} \\}\\)`));
  }
  assert.doesNotMatch(app, /state\.images\.length\s*!==\s*2/);
  assert.doesNotMatch(app, /state\.images\.length\s*!==\s*3/);
});

test("Multi-select: selected borders are uniform when multiple images are selected", () => {
  assert.match(app, /Multi-select highlight: keep all selected borders identical/);
  assert.match(app, /const multiSelectMode = selectedIds\.length > 1/);
});
