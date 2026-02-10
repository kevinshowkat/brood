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

test("Action Grid: depressed class is applied only when an action is actively running", () => {
  assert.match(app, /const runningKey = currentRunningActionKey\(\);/);
  assert.match(app, /if \(runningKey && runningKey === key\) btn\.classList\.add\(\"depressed\"\);/);
});

test("Action Grid: currentRunningActionKey maps pending actions to a single depressed key", () => {
  for (const key of [
    "pendingBlend",
    "pendingBridge",
    "pendingSwapDna",
    "pendingArgue",
    "pendingExtractRule",
    "pendingOddOneOut",
    "pendingTriforce",
  ]) {
    assert.match(app, new RegExp(`state\\.${key}`));
  }
});

test("Action Grid: local actions use runningActionKey so depressed state shows while running", () => {
  assert.match(app, /runningActionKey:\s*null/);
  assert.match(app, /if\s*\(state\.runningActionKey\)\s*return\s*state\.runningActionKey/);
  assert.match(app, /beginRunningAction\(\"bg\"\)/);
  assert.match(app, /clearRunningAction\(\"bg\"\)/);
});

test("CSS: depressed state has a down/pressed transform", () => {
  assert.match(css, /\.tool\.depressed\s*\{/);
  assert.match(css, /transform:\s*translate3d\(0,\s*2px,\s*0\)/);
});
