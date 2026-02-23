import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const runtimePath = join(here, "..", "src", "effects_runtime.js");
const app = readFileSync(appPath, "utf8");
const runtime = readFileSync(runtimePath, "utf8");

test("Mother keypoint siphon: canvas app builds drafting scene payload and helpers", () => {
  assert.match(app, /function motherDraftingExtractImageKeypoints\(/);
  assert.match(app, /function motherDraftingResolveSourceKeypoints\(/);
  assert.match(app, /function motherDraftingRectCssToCanvasRectPx\(/);
  assert.match(app, /function buildMotherDraftingEffectsScene\(/);
  assert.match(app, /const targetRect = motherDraftingRectCssToCanvasRectPx\(previewRectCss\);/);
  assert.match(app, /const sources = \[\];/);
  assert.match(app, /const uncertaintyRaw = motherDraftingComputeUncertaintyEnvelope\(pending\) \|\| null;/);
  assert.match(app, /return \{\s*targetRect,\s*sources,\s*uncertainty,\s*seed,\s*\};/);
  assert.match(app, /const motherDrafting = buildMotherDraftingEffectsScene\(transform\);/);
  assert.match(app, /return \{ extracting, tokens, drag, motherDrafting \};/);
});

test("Mother keypoint siphon: fallback keypoint path exists when image/keypoints unavailable", () => {
  assert.match(app, /function motherDraftingFallbackKeypoints\(/);
  assert.match(app, /if \(!img \|\| !sourceW \|\| !sourceH\) \{\s*return motherDraftingFallbackKeypoints/);
  assert.match(app, /if \(!sampler\) return motherDraftingFallbackKeypoints/);
  assert.match(app, /if \(!candidates\.length\) return motherDraftingFallbackKeypoints/);
  assert.match(app, /catch \{\s*return motherDraftingFallbackKeypoints/);
  assert.match(app, /pending\.keypointCache = new Map\(\)/);
});

test("Mother keypoint siphon: runtime draws siphon from sources to target with uncertainty modulation", () => {
  assert.match(runtime, /function rand01\(seed\)/);
  assert.match(runtime, /const MOTHER_SIPHON_PARTICLE_CAP = 240;/);
  assert.match(runtime, /const MOTHER_SIPHON_PER_SOURCE_MAX = 68;/);
  assert.match(runtime, /function drawMotherDraftingSiphon\(nowMs\)/);
  assert.match(runtime, /const drafting = scene\.motherDrafting;/);
  assert.match(runtime, /const targetRect = normalizeRect\(drafting\.targetRect\);/);
  assert.match(runtime, /const rawSources = Array\.isArray\(drafting\.sources\) \? drafting\.sources : \[\];/);
  assert.match(runtime, /const takingLongerThanUsual = Boolean\(uncertainty\.takingLongerThanUsual\) \|\| elapsedMs > highMs;/);
  assert.match(runtime, /const perSourceCap = clamp\(/);
  assert.match(runtime, /const laneGridCols = clamp\(Math\.round\(Math\.sqrt\(particleCount\)\), 4, 10\);/);
  assert.match(runtime, /const laneSlot = \(i \* 7 \+ s \* 11/);
  assert.match(runtime, /const targetNormX = clamp\(lerp\(strategicNormX, randomNormX, spreadMix\), 0\.06, 0\.94\);/);
  assert.match(runtime, /const sourceFade = clamp\(\(t - 0\.08\) \/ 0\.26, 0, 1\);/);
  assert.match(runtime, /motherDraftingGfx\.quadraticCurveTo\(/);
  assert.match(runtime, /drawMotherDraftingSiphon\(nowMs\);/);
});
