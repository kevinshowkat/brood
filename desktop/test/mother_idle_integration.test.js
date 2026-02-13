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

test("Mother v2 idle/cooldown timing constants are explicit", () => {
  assert.match(app, /MOTHER_V2_WATCH_IDLE_MS\s*=\s*800/);
  assert.match(app, /MOTHER_V2_INTENT_IDLE_MS\s*=\s*1500/);
  assert.match(app, /MOTHER_V2_COOLDOWN_AFTER_COMMIT_MS\s*=\s*2000/);
  assert.match(app, /MOTHER_V2_COOLDOWN_AFTER_REJECT_MS\s*=\s*1200/);
  assert.match(app, /function motherIdleArmFirstTimer\(/);
  assert.match(app, /motherIdleTransitionTo\(MOTHER_IDLE_EVENTS\.IDLE_WINDOW_ELAPSED\);[\s\S]*motherIdleArmIntentTimer\(\);/);
  assert.match(app, /function motherIdleArmIntentTimer\(/);
  assert.match(app, /if \(state\.motherIdle\?\.phase !== MOTHER_IDLE_STATES\.WATCHING\) return;[\s\S]*await motherV2RequestIntentInference\(\);/);
  assert.match(app, /motherIdleTransitionTo\(MOTHER_IDLE_EVENTS\.COOLDOWN_DONE\)/);
});

test("Mother v2 separates structured intent from prompt compilation", () => {
  assert.match(app, /function motherV2IntentPayload\(/);
  assert.match(app, /function motherV2AmbientIntentHints\(/);
  assert.match(app, /function motherV2AmbientTransformationModeHints\(/);
  assert.match(app, /function motherV2PreferredTransformationModeHint\(/);
  assert.match(app, /const parsedMode = motherV2MaybeTransformationMode\(obj\.transformation_mode\);/);
  assert.match(app, /obj\.transformation_mode_candidates = modeCandidates\.map/);
  assert.match(app, /function motherV2CanvasContextSummaryHint\(/);
  assert.match(app, /function motherV2IntentRequiredImageIds\(/);
  assert.match(app, /function motherV2VisionReadyForIntent\(/);
  assert.match(app, /function motherV2RequestIntentInference\(/);
  assert.match(app, /let transformationMode = ambientModeHint \|\| MOTHER_V2_DEFAULT_TRANSFORMATION_MODE;/);
  assert.match(app, /const visionGate = motherV2VisionReadyForIntent\(\{ schedule: true \}\);/);
  assert.match(app, /if \(!visionGate\.ready\) \{/);
  assert.match(app, /idle\.pendingVisionImageIds = visionGate\.missingIds\.slice\(\);/);
  assert.match(app, /scheduleVisionDescribe\(item\.path,\s*\{ priority: true \}\);/);
  assert.match(app, /motherV2RequestIntentInference\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(app, /Mother is reading image context before proposing…/);
  assert.match(app, /await invoke\(\"write_pty\", \{ data: `\/intent_infer \$\{quoteForPtyArg\(payloadPath\)\}\\n` \}\)/);
  assert.match(app, /function motherV2RequestPromptCompile\(/);
  assert.match(app, /await invoke\(\"write_pty\", \{ data: `\/prompt_compile \$\{quoteForPtyArg\(payloadPath\)\}\\n` \}\)/);
  assert.match(app, /function motherV2CollectGenerationImagePaths\(/);
  assert.match(app, /pushMany\(motherIdleBaseImageItems\(\)\.map\(\(item\) => String\(item\?\.id \|\| \"\"\)\.trim\(\)\)\);/);
  assert.match(app, /const referenceImages = paths\.slice\(1\);/);
  assert.match(app, /function motherV2DispatchViaImagePayload\(/);
  assert.match(app, /\/mother_generate \$\{quoteForPtyArg\(payloadPath\)\}\\n/);
  assert.match(app, /function motherV2DispatchCompiledPrompt\(/);
  assert.match(app, /MOTHER_CREATIVE_DIRECTIVE\s*=\s*\"stunningly awe-inspiring and tearfully joyous\"/);
  assert.match(app, /creative_directive:\s*MOTHER_CREATIVE_DIRECTIVE/);
  assert.match(app, /transformation_mode:\s*motherV2NormalizeTransformationMode\(idle\.intent\?\.transformation_mode\)/);
  assert.match(app, /intensity:\s*clamp\(Number\(idle\.intensity\)/);
  assert.match(app, /preferred_transformation_mode:\s*motherV2PreferredTransformationModeHint\(\)/);
  assert.match(app, /canvas_context_summary:\s*canvasSummary \|\| null/);
  assert.match(app, /ambient_intent:\s*\(ambientBranches\.length \|\| ambientModeHints\.preferredMode\)/);
  assert.match(app, /preferred_transformation_mode:\s*ambientModeHints\.preferredMode \|\| null/);
  assert.match(app, /transformation_mode_candidates:\s*ambientModeHints\.candidates/);
  assert.match(app, /rect_norm:\s*rect/);
});

test("Mother v2 layered panel exposes sentence-first default and on-demand structure controls", () => {
  assert.match(html, /id=\"mother-refine-toggle\"/);
  assert.match(html, /id=\"mother-intensity\"/);
  assert.match(html, /id=\"mother-advanced\"/);
  assert.match(html, /id=\"mother-transformation-mode\"/);
  assert.match(html, /id=\"mother-role-subject\"/);
  assert.match(html, /id=\"mother-role-model\"/);
  assert.match(html, /id=\"mother-role-mediator\"/);
  assert.match(html, /id=\"mother-role-object\"/);
  assert.match(app, /return `\$\{sentence\}\\nV confirm  M reject`;/);
  assert.match(app, /if \(mode === \"hybridize\"\) \{[\s\S]*if \(uniqueIds\.size >= 3\) return \"Fuse all references into one coherent visual world\.\";/);
  assert.match(app, /function motherV2SyncLayeredPanel\(/);
  assert.match(app, /mother-refine-toggle|Refine structure/);
});

test("Mother confirm/reject buttons do not reset interaction state before handling", () => {
  assert.match(
    app,
    /els\.motherConfirm\.addEventListener\(\"click\", \(\) => \{\s*startMotherTakeover\(\)\.catch\(\(\) => \{\}\);\s*\}\);/
  );
  assert.match(app, /els\.motherStop\.addEventListener\(\"click\", \(\) => \{\s*stopMotherTakeover\(\);\s*\}\);/);
});

test("Mother v2 generation is staged as drafts before deployment", () => {
  assert.match(app, /MOTHER_GENERATION_MODEL\s*=\s*\"gemini-2\.5-flash-image\"/);
  assert.match(app, /if \(state\.pointer\.active\) return false;/);
  assert.match(app, /idle\.drafts = \[draft\];/);
  assert.match(app, /motherIdleTransitionTo\(MOTHER_IDLE_EVENTS\.DRAFT_READY\)/);
  assert.match(app, /if \(idle\.phase !== MOTHER_IDLE_STATES\.DRAFTING\) return false;/);
});

test("Mother v2 commits only on explicit deploy and never auto-selects inserted artifacts", () => {
  assert.match(app, /function motherV2CommitSelectedDraft\(/);
  assert.match(app, /motherIdleTransitionTo\(MOTHER_IDLE_EVENTS\.DEPLOY\)/);
  assert.match(app, /if \(policy === \"replace\" && targetId && state\.imagesById\.has\(targetId\)\)/);
  assert.match(app, /replaceImageInPlace\(targetId,\s*\{[\s\S]*label:\s*basename\(draft\.path\)/);
  assert.match(app, /addImage\([\s\S]*select:\s*false[\s\S]*\)/);
  assert.match(app, /motherIdleTransitionTo\(MOTHER_IDLE_EVENTS\.COMMIT_DONE\)/);
});

test("Mother replace-in-place keeps labels synced to the new artifact path", () => {
  assert.match(app, /const oldPathLabel = basename\(oldPath \|\| \"\"\);/);
  assert.match(app, /const nextPathLabel = basename\(path \|\| \"\"\);/);
  assert.match(app, /if \(!currentLabel \|\| \(oldPathLabel && currentLabel === oldPathLabel\)\) \{/);
});

test("Mother v2 placement policy rules are explicit", () => {
  assert.match(app, /function motherIdleComputePlacementCss\(\{ policy = \"adjacent\"/);
  assert.match(app, /if \(policy === \"replace\" && baseRect\)/);
  assert.match(app, /const gap = 24;/);
  assert.match(app, /if \(policy === \"grid\"\)/);
  assert.match(app, /collidesWithExisting\(/);
});

test("Mother v2 stale/cancel safety guards are explicit", () => {
  assert.match(app, /if \(Number\(idle\.pendingActionVersion\) !== Number\(idle\.actionVersion\)\)/);
  assert.match(app, /function motherV2MarkStale\(/);
  assert.match(app, /function motherV2CancelInFlight\(/);
  assert.match(app, /idle\.cancelArtifactUntil = Date\.now\(\) \+ 14_000/);
  assert.match(app, /discard_artifact_after_cancel/);
});

test("Mother v2 role glyphs render only during hypothesizing/offering and support drag reassign", () => {
  assert.match(app, /function renderMotherRoleGlyphs\(/);
  assert.match(app, /phase === MOTHER_IDLE_STATES\.INTENT_HYPOTHESIZING \|\| phase === MOTHER_IDLE_STATES\.OFFERING/);
  assert.match(app, /const advancedVisible = motherV2IsAdvancedVisible\(\);/);
  assert.match(app, /const hintsVisible = motherV2HintsVisible\(\);/);
  assert.match(app, /if \(!advancedVisible && !hintsVisible\)/);
  assert.match(app, /MOTHER_V2_ROLE_LABEL\[role\] \|\| role\.toUpperCase\(\)/);
  assert.match(app, /MOTHER_V2_ROLE_GLYPH\[role\]/);
  assert.match(app, /const yInset = Math\.max\(4, Math\.round\(8 \* dpr\)\)/);
  assert.match(app, /const x0 = Math\.round\(rx \+ \(rw - totalW\) \/ 2\)/);
  assert.match(app, /const y = Math\.round\(ry \+ rh - glyphSize - yInset\)/);
  assert.match(app, /function hitTestMotherRoleGlyph\(/);
  assert.match(app, /state\.pointer\.kind = \"mother_role_drag\"/);
  assert.match(app, /motherV2SetRoleIds\(/);
  assert.match(app, /if \(motherRoleHit && event\.button === 0\) \{[\s\S]*bumpInteraction\(\{ semantic: false \}\);/);
  assert.match(app, /if \(state\.pointer\.kind === \"mother_role_drag\"\) \{[\s\S]*bumpInteraction\(\{ semantic: false \}\);/);
  assert.doesNotMatch(app, /els\.overlayCanvas\.addEventListener\(\"pointerdown\", \(event\) => \{\s*bumpInteraction\(\);/);
});

test("Mother v2 telemetry includes minimal trace fields", () => {
  assert.match(app, /MOTHER_TRACE_FILENAME\s*=\s*\"mother_trace\.jsonl\"/);
  assert.match(app, /accepted:\s*0/);
  assert.match(app, /rejected:\s*0/);
  assert.match(app, /deployed:\s*0/);
  assert.match(app, /stale:\s*0/);
  assert.match(app, /function appendMotherTraceLog\(/);
});

test("Mother-generated artifacts still use metadata + green visual treatment", () => {
  assert.match(app, /MOTHER_GENERATED_SOURCE\s*=\s*\"mother_generated\"/);
  assert.match(app, /source:\s*MOTHER_GENERATED_SOURCE/);
  assert.match(app, /isMotherGeneratedImageItem\(/);
  assert.match(app, /rgba\(82,\s*255,\s*148/);
});

test("Mother follow-up inference includes mother-generated images in base context", () => {
  assert.match(app, /function motherIdleBaseImageItems\(\)\s*\{\s*\/\/ Mother v2 follow-ups should be able to reason over newly generated outputs too\.\s*return \(state\.images \|\| \[\]\)\.filter\(\(item\) => item\?\.id\);\s*\}/);
});

test("Mother event correlation: binds one dispatch version and ignores stale out-of-band events", () => {
  assert.match(app, /pendingVersionId:\s*null/);
  assert.match(app, /ignoredVersionIds:\s*new Set\(\)/);
  assert.match(app, /function motherIdleTrackVersionCreated\(/);
  assert.match(app, /function motherIdleDispatchVersionMatches\(/);
  assert.match(app, /if \(event\.type === \"version_created\"\)\s*\{\s*motherIdleTrackVersionCreated\(event\);\s*return;\s*\}/);
  assert.match(app, /if \(eventVersionId && motherIdleIsIgnoredVersion\(eventVersionId\)\)/);
});

test("Mother event correlation resets cleanly between runs and allows one timeout extension", () => {
  assert.match(app, /motherIdleResetDispatchCorrelation\(\{ rememberPendingVersion: true \}\);\s*idle\.dispatchTimeoutExtensions = 0;[\s\S]*idle\.pendingGeneration = true;/);
  assert.match(app, /if \(!idle\.pendingVersionId && incomingVersionId\) idle\.pendingVersionId = incomingVersionId;[\s\S]*motherIdleResetDispatchCorrelation\(\{ rememberPendingVersion: true \}\);/);
  assert.match(app, /function motherIdleArmDispatchTimeout\([\s\S]*allowExtension = false[\s\S]*dispatch_timeout_extended/);
  assert.match(app, /motherIdleArmDispatchTimeout\([\s\S]*allowExtension:\s*true/);
  assert.match(app, /if \(!idle\.pendingPromptCompile \|\| idle\.pendingGeneration \|\| Boolean\(idle\.pendingDispatchToken\)\) \{/);
  assert.match(app, /kind:\s*\"prompt_compiled_ignored\"/);
});

test("Mother reject queues a follow-up hypothesis cycle after cooldown", () => {
  assert.match(app, /pendingFollowupAfterCooldown:\s*false/);
  assert.match(app, /pendingFollowupReason:\s*null/);
  assert.match(app, /lastRejectedProposal:\s*null/);
  assert.match(app, /rejectedModeHistoryByContext:\s*\{\}/);
  assert.match(app, /async function motherV2StartFollowupProposal\(/);
  assert.match(app, /function motherV2RejectedModesForContext\(/);
  assert.match(app, /function motherV2IntentImageSetSignature\(/);
  assert.match(app, /function motherV2RememberRejectedMode\(/);
  assert.match(app, /function motherV2DiversifyIntentForRejectFollowup\(/);
  assert.match(app, /function motherV2RejectOrDismiss\(\{ queueFollowup = false \} = \{\}\)/);
  assert.match(app, /idle\.lastRejectedProposal = \{/);
  assert.match(app, /motherV2RememberRejectedMode\(contextSig,\s*rejectedMode\);/);
  assert.match(app, /if \(imageSetSig && imageSetSig !== contextSig\) motherV2RememberRejectedMode\(imageSetSig,\s*rejectedMode\);/);
  assert.match(app, /const sigs = Array\.from\(new Set\(\[contextSig,\s*imageSetSig\]/);
  assert.match(app, /for \(const sig of sigs\) \{/);
  assert.match(app, /normalizedIntent = motherV2DiversifyIntentForRejectFollowup\(normalizedIntent\);/);
  assert.match(app, /idle\.pendingFollowupAfterCooldown = shouldQueueFollowup;/);
  assert.match(app, /const queueFollowupAfterCooldown = rejected && Boolean\(idle\.pendingFollowupAfterCooldown\)/);
  assert.match(app, /motherV2StartFollowupProposal\(\{ reason: \"reject_followup\" \}\)/);
  assert.match(app, /motherV2RejectOrDismiss\(\{ queueFollowup: true \}\);/);
});

test("Mother follow-up reject gating uses live undo availability instead of stale commitUndo state", () => {
  assert.match(app, /function motherV2CommitUndoAvailable\(/);
  assert.match(app, /if \(Date\.now\(\) <= \(Number\(idle\.commitUndo\.expiresAt\) \|\| 0\)\) return true;/);
  assert.match(app, /idle\.commitUndo = null;/);
  assert.match(app, /!motherV2CommitUndoAvailable\(\)/);
});

test("Mother v2 viewport-only movement does not reset inferred intent state", () => {
  assert.match(app, /function motherIdleSyncFromInteraction\(\{ userInteraction = false, semantic = true \} = \{\}\)/);
  assert.match(app, /if \(!semantic\) \{[\s\S]*return;/);
  assert.match(app, /bumpInteraction\(\{ semantic: false \}\)/);
  assert.match(app, /bumpInteraction\(\{ motherHot: false, semantic: false \}\)/);
});

test("Vision describe queue drops stale paths on replace/remove to avoid file-not-found loops", () => {
  assert.match(app, /function dropVisionDescribePath\(path,\s*\{ cancelInFlight = true \} = \{\}\)/);
  assert.match(app, /if \(!item\) continue;/);
  assert.match(app, /if \(!item\) return;/);
  assert.match(app, /dropVisionDescribePath\(item\.path,\s*\{ cancelInFlight: true \}\);/);
  assert.match(app, /dropVisionDescribePath\(oldPath,\s*\{ cancelInFlight: true \}\);/);
});

test("Mother idle re-arms after drag release and keeps role-drag semantic state", () => {
  assert.match(
    app,
    /function finalizePointer\(event\)\s*\{[\s\S]*const motherRoleDrag = kind === \"mother_role_drag\";[\s\S]*const effectTokenDrag = kind === \"effect_token_drag\";[\s\S]*if \(!motherRoleDrag && !effectTokenDrag\) bumpInteraction\(\);/
  );
  assert.match(app, /if \(kind === \"mother_role_drag\"\) \{[\s\S]*bumpInteraction\(\{ semantic: false \}\);/);
});

test("Mother v2 drafting visuals include role-aware context images", () => {
  assert.match(app, /pendingMotherDraft:\s*null/);
  assert.match(app, /sourceIds:\s*motherV2RoleContextIds\(\)/);
  assert.match(app, /const motherSourceIds = state\.pendingMotherDraft\?\.sourceIds/);
  assert.doesNotMatch(app, /motherSourceIds\.slice\(0,\s*2\)/);
  assert.match(app, /function ensureImageFxOverlays\(/);
  assert.match(app, /const overlays = ensureImageFxOverlays\(Math\.max\(1,\s*targets\.length\)\)/);
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
