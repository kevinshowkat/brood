import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Mother drafting placeholder renderer is wired into overlay pass", () => {
  assert.match(app, /function renderMotherDraftingPlaceholder\(/);
  assert.match(app, /renderMotherDraftingPlaceholder\(octx,\s*work\.width,\s*work\.height\);/);
});

test("Mother drafting dispatch arms preview placement metadata", () => {
  const primeMatch = app.match(/function motherIdlePrimeDraftFx\(\)[\s\S]*?\n}/);
  assert.ok(primeMatch, "motherIdlePrimeDraftFx function not found");
  assert.match(primeMatch[0], /state\.pendingMotherDraft = \{/);
  assert.match(primeMatch[0], /previewPolicy:\s*previewPlacement\.policy/);
  assert.match(primeMatch[0], /previewTargetId:\s*previewPlacement\.targetId \|\| null/);
  assert.match(
    primeMatch[0],
    /previewRectCss:\s*previewPlacement\.rectCss\s*\?\s*\{\s*\.\.\.previewPlacement\.rectCss\s*\}\s*:\s*null/
  );
  assert.match(primeMatch[0], /timeoutCeilingMs:\s*motherDraftingTimeoutCeilingMs\(/);
  assert.match(primeMatch[0], /idle\.draftCommitRectCss = previewPlacement\.rectCss \? \{ \.\.\.previewPlacement\.rectCss \} : null;/);

  const dispatchMatch = app.match(/async function motherV2DispatchCompiledPrompt[\s\S]*?return true;\n}/);
  assert.ok(dispatchMatch, "motherV2DispatchCompiledPrompt function not found");
  assert.match(dispatchMatch[0], /const previewPlacement = motherDraftingResolvePlacement\(idle\.intent\);/);
  assert.match(dispatchMatch[0], /previewPolicy:\s*previewPlacement\.policy/);
  assert.match(dispatchMatch[0], /idle\.draftCommitRectCss = previewPlacement\.rectCss \? \{ \.\.\.previewPlacement\.rectCss \} : null;/);
});

test("Mother drafting preview state clears on success, failure, cancel, and reset paths", () => {
  assert.match(app, /async function motherIdleHandleSuggestionArtifact[\s\S]*state\.pendingMotherDraft = null;/);
  assert.match(app, /function motherIdleHandleGenerationFailed[\s\S]*state\.pendingMotherDraft = null;/);
  assert.match(app, /function motherV2CancelInFlight[\s\S]*state\.pendingMotherDraft = null;/);
  assert.match(app, /function motherV2ResetInteractionState[\s\S]*state\.pendingMotherDraft = null;/);
  assert.match(app, /function motherV2ResetInteractionState[\s\S]*idle\.draftCommitRectCss = null;/);
  assert.match(app, /function motherV2ClearIntentAndDrafts[\s\S]*idle\.draftCommitRectCss = null;/);
});

test("Mother drafting placeholder drag can reposition commit placement", () => {
  assert.match(app, /function hitTestMotherDraftingPreviewRect\(/);
  assert.match(app, /state\.pointer\.kind = POINTER_KINDS\.MOTHER_DRAFT_PREVIEW_DRAG;/);
  assert.match(app, /if \(state\.pointer\.kind === POINTER_KINDS\.MOTHER_DRAFT_PREVIEW_DRAG\) \{/);
  assert.match(app, /pending\.previewRectCss = \{/);
  assert.match(app, /idle\.draftCommitRectCss = \{ \.\.\.pending\.previewRectCss \};/);
  assert.match(app, /const motherDraftPreviewDrag = kind === POINTER_KINDS\.MOTHER_DRAFT_PREVIEW_DRAG;/);
  assert.match(app, /if \(!motherRoleDrag && !effectTokenDrag && !motherDraftPreviewDrag\) \{/);
  assert.match(app, /const manualRect = policy === "replace" \? null : motherDraftingNormalizeRectCss\(idle\.draftCommitRectCss\);/);
  assert.match(app, /if \(!manualRect && !predictedOfferRect\) \{/);
});

test("Mother drafting placeholder uses visual uncertainty progress without text labels", () => {
  const fnMatch = app.match(/function renderMotherDraftingPlaceholder[\s\S]*?\n}\n\nfunction renderPromptGeneratePlaceholder/);
  assert.ok(fnMatch, "renderMotherDraftingPlaceholder block not found");
  const fnText = fnMatch[0];

  assert.match(app, /function motherDraftingComputeUncertaintyEnvelope\(/);
  assert.match(fnText, /const historicalMaxMs = sortedSamples\.length/);
  assert.match(fnText, /const p50MsRaw = sortedSamples\.length/);
  assert.match(fnText, /const p95MsRaw = sortedSamples\.length >= 2/);
  assert.match(fnText, /const dialDurationMs = Math\.max\(1_000, historicalMaxMs\);/);
  assert.match(fnText, /const progressRatioRaw = elapsedMs \/ dialDurationMs;/);
  assert.match(fnText, /const p50Ratio = clamp\(p50Ms \/ dialDurationMs, 0, 1\);/);
  assert.match(fnText, /const p95Ratio = clamp\(p95Ms \/ dialDurationMs, p50Ratio, 1\);/);
  assert.match(fnText, /const takingLongerThanUsual = Boolean\(envelope\?\.takingLongerThanUsual\) \|\| elapsedMs > highMs;/);
  assert.match(fnText, /const p50Angle = ringStart \+ ringSweep \* p50Ratio;/);
  assert.match(fnText, /const p95Angle = ringStart \+ ringSweep \* p95Ratio;/);
  assert.match(fnText, /const progressAngle = ringStart \+ ringSweep \* progressRatio;/);
  assert.match(fnText, /octx\.arc\(dialCx,\s*dialCy,\s*dialR,\s*ringStart,\s*ringStart \+ ringSweep\);/);
  assert.match(fnText, /octx\.arc\(dialCx,\s*dialCy,\s*dialR,\s*bandStart,\s*bandEnd\);/);
  assert.match(fnText, /octx\.arc\(dialCx,\s*dialCy,\s*dialR,\s*ringStart,\s*progressAngle\);/);
  assert.match(fnText, /const progressDotX = dialCx \+ Math\.cos\(progressAngle\) \* dialR;/);
  assert.doesNotMatch(fnText, /fillText\(/);
  assert.doesNotMatch(fnText, /Mother drafting\.\.\.|Elapsed\s|Likely\s|Taking longer than usual/i);
  assert.doesNotMatch(fnText, /% complete/i);
});
