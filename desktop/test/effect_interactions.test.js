import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EFFECT_TOKEN_LIFECYCLE,
  beginEffectTokenApply,
  beginEffectTokenDrag,
  consumePendingEffectSourceSlot,
  createEffectTokenState,
  createPendingEffectExtractionState,
  effectTokenCanDispatchApply,
  isValidEffectDrop,
  updateEffectTokenDrag,
} from "../src/effect_interactions.js";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const runtimePath = join(here, "..", "src", "effects_runtime.js");
const htmlPath = join(here, "..", "src", "index.html");
const cssPath = join(here, "..", "src", "styles.css");
const app = readFileSync(appPath, "utf8");
const runtime = readFileSync(runtimePath, "utf8");
const html = readFileSync(htmlPath, "utf8");
const css = readFileSync(cssPath, "utf8");

test("pixi layer: dedicated transparent effects canvas sits between work and interaction overlays", () => {
  assert.match(html, /id=\"work-canvas\"[\s\S]*id=\"effects-canvas\"[\s\S]*id=\"overlay-canvas\"/);
  assert.match(css, /#effects-canvas\s*\{[\s\S]*pointer-events:\s*none/);
  assert.match(css, /#effects-canvas\s*\{[\s\S]*z-index:\s*2/);
});

test("effects runtime wiring: initialized once, resized, and synced from render loop", () => {
  assert.match(app, /effectsRuntime = createEffectsRuntime\(\{ canvas: els\.effectsCanvas \}\);/);
  assert.match(app, /effectsRuntime\.resize\(\{\s*width,\s*height,\s*dpr\s*\}\);/);
  assert.match(app, /function syncEffectsRuntimeScene\(\)/);
  assert.match(app, /syncEffectsRuntimeScene\(\);\s*updateImageFxRect\(\);/);
  assert.match(runtime, /function createEffectsRuntime\(/);
  assert.match(runtime, /function presentNow\(\)/);
  assert.match(runtime, /function resolveDropAnimation\(\)/);
  assert.match(runtime, /clearVisuals\(\);\s*presentNow\(\);\s*stopTicker\(\);/);
  assert.match(runtime, /if \(suspended\) \{[\s\S]*resolveDropAnimation\(\);[\s\S]*stopTicker\(\);/);
  assert.match(runtime, /function resize\(\{ width, height, dpr \} = \{\}\)/);
});

test("effect token drag lifecycle: drag follows pointer coordinates and valid target enters drop preview", () => {
  const token = createEffectTokenState({
    id: "fx-1",
    type: "extract_dna",
    sourceImageId: "img-a",
  });
  assert.ok(token);
  assert.equal(token.lifecycle, EFFECT_TOKEN_LIFECYCLE.READY);

  beginEffectTokenDrag(token, { x: 14, y: 22 });
  assert.equal(token.lifecycle, EFFECT_TOKEN_LIFECYCLE.DRAGGING);
  assert.equal(token.dragX, 14);
  assert.equal(token.dragY, 22);

  updateEffectTokenDrag(token, { x: 140, y: 260, targetImageId: "img-b" });
  assert.equal(token.dragX, 140);
  assert.equal(token.dragY, 260);
  assert.equal(token.lifecycle, EFFECT_TOKEN_LIFECYCLE.DROP_PREVIEW);
  assert.equal(token.dropTargetImageId, "img-b");
});

test("effect token apply guard: valid drop dispatches once, duplicate dispatch is blocked", () => {
  const token = createEffectTokenState({
    id: "fx-2",
    type: "extract_dna",
    sourceImageId: "img-source",
  });
  const first = beginEffectTokenApply(token, "img-target", 123);
  const second = beginEffectTokenApply(token, "img-target-2", 124);

  assert.equal(first, 1);
  assert.equal(second, null);
  assert.equal(effectTokenCanDispatchApply(token, first, "img-target"), true);
  assert.equal(effectTokenCanDispatchApply(token, first, "img-target-2"), false);
});

test("effect token apply guard: invalid drops dispatch nothing", () => {
  const token = createEffectTokenState({
    id: "fx-3",
    type: "extract_dna",
    sourceImageId: "img-1",
  });
  assert.equal(isValidEffectDrop("img-1", "img-1"), false);
  assert.equal(isValidEffectDrop("img-1", ""), false);
  assert.equal(beginEffectTokenApply(token, "img-1", 1000), null);
});

test("dna and soul tokens share one interaction pipeline", () => {
  const dna = createEffectTokenState({ id: "dna-1", type: "extract_dna", sourceImageId: "img-a" });
  const soul = createEffectTokenState({ id: "soul-1", type: "soul_leech", sourceImageId: "img-b" });

  beginEffectTokenDrag(dna, { x: 10, y: 10 });
  beginEffectTokenDrag(soul, { x: 20, y: 20 });
  updateEffectTokenDrag(dna, { x: 30, y: 30, targetImageId: "img-c" });
  updateEffectTokenDrag(soul, { x: 40, y: 40, targetImageId: "img-c" });

  assert.equal(dna.lifecycle, EFFECT_TOKEN_LIFECYCLE.DROP_PREVIEW);
  assert.equal(soul.lifecycle, EFFECT_TOKEN_LIFECYCLE.DROP_PREVIEW);
});

test("dna apply prompt preserves target subject shape and blocks literal helix transforms", () => {
  assert.match(app, /function buildEffectTokenEditPrompt\(/);
  assert.match(app, /keep the target subject class, silhouette, geometry, and object boundaries unchanged\./i);
  assert.match(app, /Do not turn the subject into a DNA strand, helix, genome icon, or abstract ribbon\./);
});

test("effect token apply consumes token and removes extracted source image tile", () => {
  assert.match(app, /if \(effectTokenId\) \{[\s\S]*const sourceImageId = String\(token\?\.sourceImageId \|\| pending\.source_image_id \|\| \"\"\)\.trim\(\);/);
  assert.match(app, /if \(token\) \{[\s\S]*consumeEffectToken\(token\);/);
  assert.match(app, /clearEffectTokenForImageId\(sourceImageId\);/);
  assert.match(app, /await removeImageFromCanvas\(sourceImageId\)\.catch\(\(\) => \{\}\);/);
});

test("effect token apply early exits recover token lifecycle and clear lock", () => {
  assert.match(app, /if \(!requireIntentUnlocked\(\)\) \{[\s\S]*state\.effectTokenApplyLocks\.delete\(tokenKey\);[\s\S]*recoverEffectTokenApply\(token\);/);
  assert.match(app, /if \(!token \|\| !target\?\.path\) \{[\s\S]*state\.effectTokenApplyLocks\.delete\(tokenKey\);[\s\S]*recoverEffectTokenApply\(token\);/);
  assert.match(app, /if \(!isValidEffectDrop\(token\.sourceImageId,\s*target\.id\)\) \{[\s\S]*state\.effectTokenApplyLocks\.delete\(tokenKey\);[\s\S]*recoverEffectTokenApply\(token\);/);
});

test("pending extraction state: duplicate source paths resolve per image slot", () => {
  const pending = createPendingEffectExtractionState([
    { id: "img-1", path: "/tmp/dup.png" },
    { id: "img-2", path: "/tmp/dup.png" },
    { id: "img-3", path: "/tmp/other.png" },
  ]);

  const first = consumePendingEffectSourceSlot(pending, "/tmp/dup.png", 10);
  const second = consumePendingEffectSourceSlot(pending, "/tmp/dup.png", 20);
  const third = consumePendingEffectSourceSlot(pending, "/tmp/other.png", 30);

  assert.equal(first.matchedImageId, "img-1");
  assert.equal(second.matchedImageId, "img-2");
  assert.equal(third.matchedImageId, "img-3");
  assert.equal(third.unresolvedCount, 0);
});

test("extraction success events can resolve image id by path without pending ui slots", () => {
  assert.match(app, /function resolveExtractionEventImageIdByPath\(imagePath\)/);
  assert.match(app, /const resolvedImageId = matchedImageId \|\| resolveExtractionEventImageIdByPath\(path\);/);
  assert.match(app, /DESKTOP_EVENT_TYPES\.IMAGE_DNA_EXTRACTED/);
  assert.match(app, /DESKTOP_EVENT_TYPES\.IMAGE_SOUL_EXTRACTED/);
});
