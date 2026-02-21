import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "src", "index.html");
const appPath = join(here, "..", "src", "canvas_app.js");
const cssPath = join(here, "..", "src", "styles.css");
const html = readFileSync(htmlPath, "utf8");
const app = readFileSync(appPath, "utf8");
const css = readFileSync(cssPath, "utf8");

test("OpenRouter onboarding: settings card exposes trigger + status controls", () => {
  assert.match(html, /id=\"openrouter-onboarding-status\"/);
  assert.match(html, /id=\"openrouter-onboarding-open\"/);
  assert.match(html, /id=\"openrouter-onboarding-reset\"/);
});

test("OpenRouter onboarding: modal scaffolding is present", () => {
  assert.match(html, /id=\"openrouter-onboarding-modal\"/);
  assert.match(html, /id=\"openrouter-onboarding-title\"/);
  assert.match(html, /id=\"openrouter-onboarding-body\"/);
  assert.match(html, /id=\"openrouter-onboarding-next\"/);
});

test("OpenRouter onboarding: first-run auto open and settings relaunch are wired", () => {
  assert.match(app, /function maybeAutoOpenOpenRouterOnboarding\(/);
  assert.match(app, /setTimeout\(\(\) => \{\s*maybeAutoOpenOpenRouterOnboarding\(\);/);
  assert.match(app, /openOpenRouterOnboardingModal\(\{\s*force:\s*true,\s*source:\s*\"settings\"\s*\}\)/);
});

test("OpenRouter onboarding: key save invokes backend persistence + verification", () => {
  assert.match(app, /invoke\(\"save_openrouter_api_key\", \{ apiKey \}\)/);
  assert.match(app, /await refreshKeyStatus\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(app, /if \(!state\?\.keyStatus\?\.openrouter\)/);
  assert.match(app, /function restartEngineAfterOpenRouterKeySave\(\)/);
  assert.match(app, /await restartEngineAfterOpenRouterKeySave\(\);/);
  assert.match(app, /OpenRouter key confirmed/);
});

test("OpenRouter onboarding: intro copy and bottom progress dots are concise", () => {
  assert.match(app, /Brood works best with OpenRouter/);
  assert.match(app, /const dotCount = 3;/);
  assert.doesNotMatch(app, /openrouter-onboarding-progress-dot-label/);
  assert.match(app, /Next: paste your key and click Save key\. Brood stores it in ~\/\.brood\/\.env\./);
});

test("OpenRouter onboarding: progress row renders above footer buttons", () => {
  assert.match(
    html,
    /id=\"openrouter-onboarding-progress\"[\s\S]*?<div class=\"openrouter-onboarding-footer\">/
  );
});

test("OpenRouter onboarding: right-side portrait video placeholder is reserved", () => {
  assert.match(html, /id=\"openrouter-onboarding-media-slot\"/);
  assert.match(html, /id=\"openrouter-onboarding-media-video\"/);
  assert.match(css, /\.openrouter-onboarding-media-slot[\s\S]*aspect-ratio:\s*9\s*\/\s*16/);
  assert.match(app, /OPENROUTER_ONBOARDING_SORA_VIDEO_SRC/);
});

test("OpenRouter onboarding: dark themed modal styles exist", () => {
  assert.match(css, /\.openrouter-onboarding-modal\s*\{/);
  assert.match(css, /\.openrouter-onboarding-shell\s*\{/);
  assert.match(css, /\.openrouter-onboarding-success\s*\{/);
});
