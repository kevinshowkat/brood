import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Mother generate payload uses minimal brood.mother.generate.v2 envelope", () => {
  const fnMatch = app.match(
    /async function motherV2DispatchViaImagePayload[\s\S]*?const payload = \{([\s\S]*?)\n\s*\};/
  );
  assert.ok(fnMatch, "motherV2DispatchViaImagePayload payload block not found");
  const payloadText = fnMatch[1];

  assert.match(payloadText, /schema:\s*"brood\.mother\.generate\.v2"/);
  assert.match(payloadText, /prompt:\s*finalPromptLine/);
  assert.match(payloadText, /init_image:\s*imagePayload\.initImage/);
  assert.match(payloadText, /reference_images:\s*imagePayload\.referenceImages/);

  assert.doesNotMatch(payloadText, /\bintent\s*:/);
  assert.doesNotMatch(payloadText, /\bpositive_prompt\s*:/);
  assert.doesNotMatch(payloadText, /\bnegative_prompt\s*:/);
  assert.doesNotMatch(payloadText, /\bsource_images\s*:/);
});

test("Mother generate payload can carry model context envelopes for non-Gemini providers", () => {
  const fnMatch = app.match(/async function motherV2DispatchViaImagePayload[\s\S]*?return true;\n}/);
  assert.ok(fnMatch, "motherV2DispatchViaImagePayload function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /motherV2BuildModelContextEnvelopes\(/);
  assert.match(fnText, /payload\.model_context_envelopes\s*=\s*modelContextEnvelopes/);
});

test("Mother dispatch uses preferred current image model instead of hard-pinning Gemini", () => {
  const fnMatch = app.match(/async function motherV2DispatchCompiledPrompt[\s\S]*?return true;\n}/);
  assert.ok(fnMatch, "motherV2DispatchCompiledPrompt function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /const selectedModel = motherPreferredGenerationModel\(\)/);
  assert.match(fnText, /await maybeOverrideEngineImageModel\(selectedModel\)/);
});

test("Mother dispatch primes image FX immediately and rolls back when dispatch does not arm", () => {
  const primeMatch = app.match(/function motherIdlePrimeDraftFx\(\)[\s\S]*?\n}/);
  assert.ok(primeMatch, "motherIdlePrimeDraftFx function not found");
  assert.match(primeMatch[0], /state\.pendingMotherDraft = \{/);
  assert.match(primeMatch[0], /sourceIds:\s*motherV2RoleContextIds\(\)/);
  assert.match(primeMatch[0], /setImageFxActive\(true,\s*"Mother Draft"\)/);

  const fnMatch = app.match(/async function motherIdleDispatchGeneration\(\)[\s\S]*?return true;\n}/);
  assert.ok(fnMatch, "motherIdleDispatchGeneration function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /motherIdlePrimeDraftFx\(\);/);
  assert.match(fnText, /const ok = await ensureEngineSpawned\(\{ reason: "mother_drafting" \}\);/);
  assert.match(fnText, /if \(!ok\) \{\s*motherIdleRollbackDraftFxIfDispatchUnarmed\(\);/);
  assert.match(fnText, /const dispatchArmed = Boolean\(idle\.pendingPromptCompile \|\| idle\.pendingGeneration \|\| idle\.pendingDispatchToken\);/);
  assert.match(fnText, /if \(!dispatchArmed\) \{\s*motherIdleRollbackDraftFxIfDispatchUnarmed\(\);/);
});

test("Mother model context envelopes normalize SDXL provider key to replicate", () => {
  const fnMatch = app.match(/function motherV2BuildModelContextEnvelopes[\s\S]*?\n}\n\nfunction motherV2BuildGeminiContextPacket/);
  assert.ok(fnMatch, "motherV2BuildModelContextEnvelopes block not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /const providerKey = provider === \"sdxl\" \? \"replicate\" : provider/);
  assert.match(fnText, /return \{ \[providerKey\]: envelope \}/);
});
