import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "src", "index.html");
const appPath = join(here, "..", "src", "canvas_app.js");
const html = readFileSync(htmlPath, "utf8");
const app = readFileSync(appPath, "utf8");

test("Prompt Generate modal is present in index markup", () => {
  assert.match(html, /id="prompt-generate-panel"/);
  assert.match(html, /id="prompt-generate-model"/);
  assert.match(html, /id="prompt-generate-text"/);
  assert.match(html, /id="prompt-generate-send"/);
});

test("Prompt Generate skill is wired into action grid and dispatch path", () => {
  assert.match(app, /if \(key === "prompt_generate"\)/);
  assert.match(app, /showPromptGeneratePanel\(\)/);
  assert.match(app, /async function runPromptGenerate\(/);
  assert.match(app, /state\.pendingPromptGenerate/);
  assert.match(app, /function currentPromptGenerateAnchorCss\(/);
  assert.match(app, /function renderPromptGeneratePlaceholder\(/);
  assert.match(app, /seedPromptGeneratePlacementRectCss\(id, promptGenerate\)/);
  assert.match(app, /anchorCss:\s*resolvedAnchorCss/);
  assert.match(app, /anchorWorldCss:\s*resolvedAnchorWorldCss/);
  assert.match(app, /if \(targetKey === "prompt_generate"\)/);
});

test("Prompt Generate normalizes edit-style prompts to standalone generation", () => {
  assert.match(app, /function normalizePromptGeneratePrompt\(/);
  assert.match(app, /generate a brand-new image from text only:/);
});
