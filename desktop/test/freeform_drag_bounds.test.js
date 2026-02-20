import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Freeform drag bounds: workspace clamp helper allows offscreen movement", () => {
  assert.match(app, /function freeformWorkspaceClampOptions\(canvasCssW, canvasCssH, \{ minSize = 44 \} = \{\}\)/);
  assert.match(app, /const workspaceMargin = -Math\.max\(2000, span \* 4\);/);
});

test("Freeform drag bounds: move and resize use workspace clamp options", () => {
  assert.match(app, /const clampOpts = freeformWorkspaceClampOptions\(canvasCssW, canvasCssH, \{ minSize: 44 \}\);/);
  assert.match(app, /clampFreeformRectCss\([\s\S]*canvasCssW,[\s\S]*canvasCssH,[\s\S]*clampOpts[\s\S]*\);/);
  assert.match(app, /resizeFreeformRectFromCorner\([\s\S]*worldPointerCss,[\s\S]*canvasCssW,[\s\S]*canvasCssH,[\s\S]*clampOpts[\s\S]*\)/);
});
