import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Ambient intent: edit triggers schedule background inference", () => {
  assert.match(app, /scheduleAmbientIntentInference\(\{\s*immediate:\s*true,\s*reason:\s*"add"/);
  assert.match(app, /scheduleAmbientIntentInference\(\{\s*immediate:\s*false,\s*reason:\s*"import_batch"/);
  assert.match(app, /scheduleAmbientIntentInference\(\{\s*immediate:\s*true,\s*reason:\s*"remove"/);
  assert.match(app, /scheduleAmbientIntentInference\(\{\s*reason:\s*"move"/);
  assert.match(app, /scheduleAmbientIntentInference\(\{\s*reason:\s*"resize"/);
  assert.match(app, /scheduleAmbientIntentInference\(\{\s*immediate:\s*true,\s*reason:\s*"replace"/);
});

test("Ambient intent: viewport wheel/gesture handlers do not schedule inference", () => {
  const wheel = app.match(/const handleOverlayWheel = \(event\) => \{[\s\S]*?\n\s*\};/);
  assert.ok(wheel, "wheel handler not found");
  assert.doesNotMatch(wheel[0], /scheduleAmbientIntentInference\(/);

  const gesture = app.match(/const onGestureChange = \(event\) => \{[\s\S]*?const onGestureEnd = \(event\) => \{/);
  assert.ok(gesture, "gesture handlers not found");
  assert.doesNotMatch(gesture[0], /scheduleAmbientIntentInference\(/);
});

test("Ambient intent: realtime failures flow through ambient fallback", () => {
  assert.match(app, /applyAmbientIntentFallback\("realtime_disabled"/);
  assert.match(app, /applyAmbientIntentFallback\("engine_unavailable"/);
  assert.match(app, /applyAmbientIntentFallback\("timeout"/);
  assert.match(app, /applyAmbientIntentFallback\("dispatch_failed"/);
  assert.match(app, /applyAmbientIntentFallback\("parse_failed"/);
  assert.match(app, /applyAmbientIntentFallback\("failed"/);
});

test("Ambient intent: nudges are clickable and use larger visual sizing", () => {
  assert.match(app, /function hitTestAmbientIntentNudge\(/);
  assert.match(app, /function activateAmbientIntentNudge\(/);
  assert.match(app, /const ambientHit = intentAmbientActive\(\) \? hitTestAmbientIntentNudge\(p\) : null;/);
  assert.match(app, /setOverlayCursor\("pointer"\)/);
  assert.match(app, /const minPx = Math\.max\(28, Math\.round\(72 \* dpr\)\)/);
});

test("Ambient intent: realtime event de-staling requires a matching active pending path", () => {
  assert.match(app, /const routing = classifyIntentIconsRouting\(\{/);
  assert.match(app, /const \{ matchAmbient, matchIntent, matchMother, ignoreReason \} = routing;/);
  assert.match(app, /if \(ignoreReason === "snapshot_path_mismatch" \|\| ignoreReason === "path_mismatch"\) \{/);
  assert.doesNotMatch(app, /const matchesAmbient = !path \|\| !ambient\?\.pendingPath \|\| path === ambient\.pendingPath/);
});

test("Ambient intent: allows specific realtime vision labels to replace bland early labels", () => {
  assert.match(app, /function shouldPreferIncomingVisionLabel\(/);
  assert.match(app, /function _compactVisionCaptionFragment\(/);
  assert.match(app, /function _visionLabelNameTokenCount\(/);
  assert.match(app, /VISION_LABEL_AUX_TOKENS = new Set\(\["is", "are", "was", "were"\]\)/);
  assert.match(app, /if \(existingGeneric && !incomingGeneric\) return true;/);
  assert.match(app, /if \(incomingNameTokens >= 2 && existingNameTokens < 2\) return true;/);
  assert.match(app, /if \(incomingScore > existingScore\) return true;/);
  assert.match(app, /const s = _compactVisionCaptionFragment\(raw\);/);
  assert.match(app, /const keepExplicitDescribe =[\s\S]*prevSource === "openai_realtime_describe" \|\| prevSource === "openai_vision"/);
  assert.match(app, /maybeScheduleVisionDescribeFallback\(imgItem, prevLabel\);/);
  assert.match(app, /maybeScheduleVisionDescribeFallback\(imgItem, label\);/);
  assert.match(app, /const cleaned = _normalizeVisionLabel\(desc,\s*\{\s*maxChars:\s*REALTIME_VISION_LABEL_MAX_CHARS\s*\}\) \|\| desc\.trim\(\);/);
});

test("Ambient intent: missing realtime image_descriptions queues fallback describe", () => {
  assert.match(app, /function maybeScheduleVisionDescribeFallbackForAmbientRealtime\(/);
  assert.match(app, /if \(!isPartial && matchAmbient\) {\s*maybeScheduleVisionDescribeFallbackForAmbientRealtime\(ambient, imageDescs\);/);
});

test("Ambient intent: empty vision hints are filtered before building realtime context", () => {
  assert.match(app, /function normalizeVisionHintForIntent\(/);
  assert.match(app, /if \(shouldBackfillVisionLabel\(label\)\) return null;/);
  assert.match(app, /function shouldBackfillVisionLabel\(/);
  assert.match(app, /return !label;/);
  assert.match(app, /const label = _normalizeVisionLabel\(labelRaw,\s*\{\s*maxChars:\s*REALTIME_VISION_LABEL_MAX_CHARS\s*\}\);/);
  assert.match(app, /vision_desc:\s*normalizeVisionHintForIntent\(image\.vision_desc,\s*\{\s*maxChars:\s*REALTIME_VISION_LABEL_MAX_CHARS\s*\}\)/);
  assert.match(app, /const visionDesc = normalizeVisionHintForIntent\(item\?\.visionDesc,\s*\{\s*maxChars:\s*REALTIME_VISION_LABEL_MAX_CHARS\s*\}\);/);
});

test("Ambient intent: proactive per-image describe scheduling stays fallback-gated", () => {
  assert.match(app, /scheduleVisionDescribe\(unique\[i\], \{ priority: Boolean\(priority\) && i < burstLimit, fallback: true \}\);/);
  assert.match(app, /if \(active\?\.path\) scheduleVisionDescribe\(active\.path, \{ priority: true, fallback: true \}\);/);
  assert.match(app, /scheduleVisionDescribe\(item\.path, \{ fallback: true \}\);/);
});

test("Ambient intent: parse\/failure paths queue fallback describe for touched images", () => {
  assert.match(app, /applyAmbientIntentFallback\("parse_failed", \{ message: intentParseMessage \}\);\s*maybeScheduleVisionDescribeFallbackForAmbientRealtime\(ambient, \[\]\);/);
  assert.match(app, /applyAmbientIntentFallback\("failed", \{ message: msg, hardDisable \}\);\s*maybeScheduleVisionDescribeFallbackForAmbientRealtime\(ambient, \[\]\);/);
});

test("Ambient nudge mapping: multi-canvas world->canvas conversion applies DPR", () => {
  assert.match(app, /x:\s*x \* dpr \* s \+ ox/);
  assert.match(app, /y:\s*y \* dpr \* s \+ oy/);
  assert.match(app, /w:\s*w \* dpr \* s/);
  assert.match(app, /h:\s*h \* dpr \* s/);
});
