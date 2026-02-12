import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "src", "index.html");
const cssPath = join(here, "..", "src", "styles.css");
const appPath = join(here, "..", "src", "canvas_app.js");

const html = readFileSync(htmlPath, "utf8");
const css = readFileSync(cssPath, "utf8");
const app = readFileSync(appPath, "utf8");

test("Mother wheel: menu exists, is icon-only, and exposes add photo/add role actions", () => {
  assert.match(html, /id=\"mother-wheel-menu\"/);
  assert.match(html, /class=\"mother-wheel-action\"[\s\S]*data-action=\"add_photo\"/);
  assert.match(html, /class=\"mother-wheel-action\"[\s\S]*data-action=\"add_role\"/);
  assert.match(html, /aria-label=\"Add photo\"/);
  assert.match(html, /aria-label=\"Add role\"/);
});

test("Mother wheel: native-style open/close and dispatch hooks are wired", () => {
  assert.match(app, /function openMotherWheelMenuAt\(/);
  assert.match(app, /function closeMotherWheelMenu\(/);
  assert.match(app, /function dispatchMotherWheelAction\(/);
  assert.match(app, /raw === \"add_photo\"[\s\S]*importPhotosAtCanvasPoint\(/);
  assert.match(app, /raw === \"add_role\"[\s\S]*seedRoleDesignationFromWheelAnchor\(/);
  assert.match(app, /state\.pointer\.kind = \"freeform_wheel\"/);
});

test("Mother idle flow: 5s idle gate + 10s no-response takeover are explicit", () => {
  assert.match(app, /MOTHER_IDLE_FIRST_IDLE_MS\s*=\s*5000/);
  assert.match(app, /MOTHER_IDLE_TAKEOVER_IDLE_MS\s*=\s*10_?000/);
  assert.match(app, /const dueAt = Date\.now\(\) \+ MOTHER_IDLE_FIRST_IDLE_MS/);
  assert.match(app, /if \(quietFor < MOTHER_IDLE_FIRST_IDLE_MS\)/);
  assert.match(app, /function motherIdleArmTakeoverTimer\(/);
  assert.match(app, /const quietFor = Date\.now\(\) - \(due - MOTHER_IDLE_TAKEOVER_IDLE_MS\)/);
  assert.match(app, /if \(quietFor < MOTHER_IDLE_TAKEOVER_IDLE_MS\)/);
  assert.match(app, /motherIdleTransitionTo\(MOTHER_IDLE_EVENTS\.IDLE_WINDOW_ELAPSED\)/);
  assert.match(app, /motherIdleTransitionTo\(MOTHER_IDLE_EVENTS\.GENERATION_DISPATCHED\)/);
  assert.match(app, /motherIdleTransitionTo\(MOTHER_IDLE_EVENTS\.GENERATION_INSERTED\)/);
  assert.match(app, /motherIdleTransitionTo\(MOTHER_IDLE_EVENTS\.USER_RESPONSE_TIMEOUT\)/);
});

test("Mother generation: dispatches via Gemini flash image from vision-only context", () => {
  assert.match(app, /MOTHER_GENERATION_MODEL\s*=\s*\"gemini-2\.5-flash-image\"/);
  assert.match(app, /function motherIdleBuildVisionOnlyPrompt\(/);
  assert.match(app, /function motherIdlePromptLineForPty\(/);
  assert.match(app, /replace\(\/\\r\?\\n\+\/g,\s*\" \"\)/);
  assert.match(app, /const promptLine = motherIdlePromptLineForPty\(suggestionIntent\.prompt\)/);
  assert.match(app, /await invoke\(\"write_pty\",\s*\{\s*data:\s*`\$\{promptLine\}\\n`\s*\}\)/);
  assert.match(app, /prompt_line:\s*promptLine/);
  assert.match(app, /exploratory image suggestion that helps discover the user's likely Brood intent lane/i);
  assert.match(app, /Primary lane hypothesis:/);
  assert.match(app, /Focus ONLY on the primary lane for this generation\./);
  assert.match(app, /Do NOT include any text, letters, words, typography, captions, or watermarks in the image\./);
  assert.match(app, /You MAY use non-text visual diagram cues such as arrows, lines, circles, and callout shapes to clarify flow or emphasis\./);
  assert.match(app, /function motherIdlePickIntentHypotheses\(/);
  assert.match(app, /function motherIdleGenerationModelCandidates\(/);
  assert.match(app, /function motherIdlePickRetryModel\(/);
  assert.match(app, /await maybeOverrideEngineImageModel\(selectedModel\)/);
});

test("Mother-generated artifacts: source metadata + replacement + green visual treatment", () => {
  assert.match(app, /MOTHER_GENERATED_SOURCE\s*=\s*\"mother_generated\"/);
  assert.match(app, /source:\s*MOTHER_GENERATED_SOURCE/);
  assert.match(app, /removeImageFromCanvas\(idle\.generatedImageId\)/);
  assert.match(app, /isMotherGeneratedImageItem\(/);
  assert.match(app, /rgba\(82,\s*255,\s*148/);
});

test("Mother suggestion logging: writes dispatch/result/failure data with WHAT and WHY fields", () => {
  assert.match(app, /MOTHER_SUGGESTION_LOG_FILENAME\s*=\s*\"mother_suggestions\.jsonl\"/);
  assert.match(app, /stage:\s*isRetry\s*\?\s*\"dispatch_retry\"\s*:\s*\"dispatch\"/);
  assert.match(app, /stage:\s*\"result\"/);
  assert.match(app, /stage:\s*\"failed\"/);
  assert.match(app, /stage:\s*\"version_bound\"/);
  assert.match(app, /stage:\s*\"extra_version_ignored\"/);
  assert.match(app, /stage:\s*\"out_of_band_result_ignored\"/);
  assert.match(app, /stage:\s*\"late_result_ignored\"/);
  assert.match(app, /stage:\s*\"out_of_band_failed_ignored\"/);
  assert.match(app, /stage:\s*\"late_failed_ignored\"/);
  assert.match(app, /stage:\s*\"spurious_failed_after_success\"/);
  assert.match(app, /stage:\s*\"extra_result_ignored\"/);
  assert.match(app, /stage:\s*\"retry_scheduled\"/);
  assert.match(app, /intent_primary_usecase/);
  assert.match(app, /intent_alternate_usecase/);
  assert.match(app, /console\.info\(isRetry \? "\[mother_suggestion\] dispatch_retry" : "\[mother_suggestion\] dispatch"/);
  assert.match(app, /console\.info\(\"\[mother_suggestion\] result\"/);
  assert.match(app, /motherSingleSuggestionGuard/);
  assert.match(app, /ignored extra artifact/);
});

test("Mother event correlation: binds one dispatch version and ignores stale out-of-band events", () => {
  assert.match(app, /pendingVersionId:\s*null/);
  assert.match(app, /ignoredVersionIds:\s*new Set\(\)/);
  assert.match(app, /function motherIdleTrackVersionCreated\(/);
  assert.match(app, /function motherIdleDispatchVersionMatches\(/);
  assert.match(app, /if \(event\.type === \"version_created\"\)\s*\{\s*motherIdleTrackVersionCreated\(event\);\s*return;\s*\}/);
  assert.match(app, /if \(eventVersionId && motherIdleIsIgnoredVersion\(eventVersionId\)\)/);
});

test("Mother realtime border/video: gated by idle state machine phase", () => {
  assert.match(app, /const idlePhase = state\.motherIdle\?\.phase/);
  assert.match(app, /motherIdleUsesRealtimeVisual\(idlePhase\)/);
  assert.match(app, /videoEl\.classList\.remove\(\"hidden\"\)/);
});

test("Mother wheel visuals: uses app-menu-like treatment with unfurl animation", () => {
  assert.match(css, /\.mother-wheel-menu\s*\{/);
  assert.match(css, /\.mother-wheel-menu::before\s*\{/);
  assert.match(css, /\.mother-wheel-menu\.is-open\s*\{/);
  assert.match(css, /\.mother-wheel-action\s*\{/);
  assert.match(css, /--wheel-open-ms/);
});
