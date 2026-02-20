import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Mother prompt composer supports MUST tail and optional full repeat", () => {
  const fnMatch = app.match(
    /function motherV2BuildPromptComposerResult\(compiled = \{\}\) \{[\s\S]*?\n\}\n\nfunction motherV2PromptLineFromCompiled/
  );
  assert.ok(fnMatch, "motherV2BuildPromptComposerResult function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /const strategyMode = normalizePromptStrategyMode\(settings\.promptStrategyMode\)/);
  assert.match(fnText, /if \(strategyMode === "tail" && constraints\.length\) \{/);
  assert.match(fnText, /lines\.push\(`MUST: \$\{constraints\.join\("; "\)\}`\)/);
  assert.match(fnText, /if \(repeatFull && rawPrompt\) \{/);
  assert.match(fnText, /rawPrompt = `\$\{rawPrompt\}\\n\$\{rawPrompt\}`/);
  assert.match(fnText, /strategy: repeatFull \? "repeat" : strategyMode/);
});

test("Mother dispatch registers benchmark trial and records dispatch failure", () => {
  const fnMatch = app.match(/async function motherV2DispatchCompiledPrompt\(compiled = \{\}\) \{[\s\S]*?return true;\n\}/);
  assert.ok(fnMatch, "motherV2DispatchCompiledPrompt function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /const promptComposer = motherV2BuildPromptComposerResult\(compiled\)/);
  assert.match(fnText, /const benchmarkTrialId = promptBenchmarkRegisterDispatch\(\{/);
  assert.match(fnText, /strategy: promptComposer\.strategy/);
  assert.match(fnText, /if \(!sentViaPayload\) \{/);
  assert.match(fnText, /promptBenchmarkFinalizeTrial\(benchmarkTrialId, \{/);
});

test("Desktop event pipeline updates prompt benchmark on version, artifact, failure, and cost", () => {
  const fnMatch = app.match(
    /async function handleEventLegacy\(event\) \{[\s\S]*?\n\}\n\nfunction hitTestEffectToken/
  );
  assert.ok(fnMatch, "handleEventLegacy function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /promptBenchmarkBindVersion\(motherEventVersionId\(event\)\);/);
  assert.match(fnText, /promptBenchmarkMarkSuccessFromArtifactEvent\(event\);/);
  assert.match(fnText, /promptBenchmarkMarkFailureFromGenerationFailedEvent\(event\);/);
  assert.match(fnText, /promptBenchmarkAttachCostLatencyEvent\(event\);/);
});

test("Settings UI exposes prompt strategy controls and benchmark reset action", () => {
  const fnMatch = app.match(/function installUi\(\) \{[\s\S]*?\n\}\n\nasync function boot/);
  assert.ok(fnMatch, "installUi function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /if \(els\.promptStrategyMode\) \{/);
  assert.match(fnText, /localStorage\.setItem\(PROMPT_STRATEGY_MODE_KEY, settings\.promptStrategyMode\);/);
  assert.match(fnText, /if \(els\.promptRepeatFullToggle\) \{/);
  assert.match(fnText, /localStorage\.setItem\(PROMPT_REPEAT_FULL_KEY, settings\.promptRepeatFull \? "1" : "0"\);/);
  assert.match(fnText, /if \(els\.promptBenchmarkReset\) \{/);
  assert.match(fnText, /promptBenchmarkReset\(\);/);
});
