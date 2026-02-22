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
  assert.match(app, /invoke\(\"openrouter_oauth_pkce_sign_in\", \{ timeoutSeconds: 240 \}\)/);
  assert.match(app, /await refreshKeyStatus\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(app, /if \(!state\?\.keyStatus\?\.openrouter\)/);
  assert.match(app, /function restartEngineAfterOpenRouterKeySave\(\)/);
  assert.match(app, /async function signInWithOpenRouterOauthPkce\(\)/);
  assert.match(app, /await restartEngineAfterOpenRouterKeySave\(\);/);
  assert.match(app, /invoke\("get_pty_status"\)/);
  assert.match(app, /engine did not report ready after restart/);
  assert.match(app, /OpenRouter connected/);
});

test("OpenRouter onboarding: oauth-first copy, manual reveal, and bottom progress dots are concise", () => {
  assert.match(app, /Brood works best with OpenRouter/);
  assert.match(app, /const dotCount = 2;/);
  assert.doesNotMatch(app, /openrouter-onboarding-progress-dot-label/);
  assert.match(app, /Sign in with OpenRouter to connect your key automatically\./);
  assert.match(app, /Sign in with OpenRouter/);
  assert.match(app, /data-openrouter-action="oauth_sign_in"/);
  assert.match(app, /Use API key manually instead/);
  assert.match(app, /data-openrouter-action="show_manual"/);
  assert.doesNotMatch(app, /Brood will open your browser, then finish setup automatically\./);
  assert.doesNotMatch(app, /Stored locally in <code>~\/\.brood\/\.env<\/code>\./);
  assert.match(app, /Skip for now keeps image generation disabled until you connect a key\./);
  assert.match(app, /const manualSaveVisible = stepIndex !== 0 \|\| openrouterOnboardingState\.manualEntryVisible;/);
  assert.match(app, /const nextText = stepIndex === 0 \? "Save key" : "Done";/);
});

test("OpenRouter onboarding: OAuth progress and recovery actions are wired", () => {
  assert.match(app, /Opening browser…/);
  assert.match(app, /Waiting for OpenRouter approval…/);
  assert.match(app, /Finishing setup…/);
  assert.match(app, /Try again/);
  assert.match(app, /Use manual key/);
  assert.match(app, /Copy error details/);
  assert.match(app, /data-openrouter-action="oauth_retry"/);
  assert.match(app, /data-openrouter-action="copy_error"/);
  assert.match(app, /function classifyOpenRouterOauthError\(/);
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
  assert.match(css, /\.openrouter-onboarding-oauth-row\s*\{/);
  assert.match(css, /\.openrouter-onboarding-divider\s*\{/);
  assert.match(css, /\.openrouter-onboarding-success\s*\{/);
  assert.match(app, /OPENROUTER_ONBOARDING_LOGO_WHITE_SRC/);
  assert.match(css, /\.openrouter-onboarding-key-lede\s*\{/);
});
