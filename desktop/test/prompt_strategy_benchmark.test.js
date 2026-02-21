import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

function extractFunctionSource(pattern, label) {
  const match = app.match(pattern);
  assert.ok(match, `${label} function not found`);
  return match[0].replace(/\n\nfunction\s+[\s\S]*$/, "").trim();
}

function loadPromptBenchmarkAutoHarness() {
  const normalizeModeSource = extractFunctionSource(
    /function normalizePromptStrategyMode\(raw\) \{[\s\S]*?\n\}\n\nfunction loadPromptBenchmarkTrials/,
    "normalizePromptStrategyMode"
  );
  const normalizeStrategySource = extractFunctionSource(
    /function normalizePromptBenchmarkStrategy\(raw\) \{[\s\S]*?\n\}\n\nfunction normalizePromptBenchmarkModel/,
    "normalizePromptBenchmarkStrategy"
  );
  const normalizeModelSource = extractFunctionSource(
    /function normalizePromptBenchmarkModel\(raw\) \{[\s\S]*?\n\}\n\nfunction promptBenchmarkHydrateState/,
    "normalizePromptBenchmarkModel"
  );
  const autoSource = extractFunctionSource(
    /function promptBenchmarkAutoStrategyForModel\(model = "", \{ fallback = "tail", minTrials = 4 \} = \{\}\) \{[\s\S]*?\n\}\n\nfunction promptBenchmarkRegisterDispatch/,
    "promptBenchmarkAutoStrategyForModel"
  );
  return new Function(`
    let state = { promptBenchmark: { trials: [] } };
    ${normalizeModeSource}
    ${normalizeStrategySource}
    ${normalizeModelSource}
    ${autoSource}
    return {
      setState(next) {
        state = next;
      },
      resolve(model, options) {
        return promptBenchmarkAutoStrategyForModel(model, options);
      },
    };
  `)();
}

test("Mother prompt composer supports MUST tail and optional full repeat", () => {
  const fnMatch = app.match(
    /function motherV2BuildPromptComposerResult\(compiled = \{\}\) \{[\s\S]*?\n\}\n\nfunction motherV2PromptLineFromCompiled/
  );
  assert.ok(fnMatch, "motherV2BuildPromptComposerResult function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /const configuredMode = normalizePromptStrategyMode\(settings\.promptStrategyMode\)/);
  assert.match(fnText, /configuredMode === "auto"/);
  assert.match(fnText, /promptBenchmarkAutoStrategyForModel\(/);
  assert.match(fnText, /const strategyMode = configuredMode === "auto" \? resolvedAuto\?\.strategy \|\| "tail" : configuredMode/);
  assert.match(fnText, /if \(negative\) lines\.push\(`Avoid: \$\{negative\}`\);/);
  assert.match(fnText, /if \(strategyMode === "tail" && constraints\.length\) \{/);
  assert.match(fnText, /lines\.push\(`MUST: \$\{constraints\.join\("; "\)\}`\)/);
  assert.match(fnText, /if \(repeatFull && rawPrompt\) \{/);
  assert.match(fnText, /rawPrompt = `\$\{rawPrompt\}\\n\$\{rawPrompt\}`/);
  assert.match(fnText, /strategy: repeatFull \? "repeat" : strategyMode/);
});

test("Prompt benchmark exposes auto strategy resolver for model-scoped selection", () => {
  const fnMatch = app.match(
    /function promptBenchmarkAutoStrategyForModel\(model = "", \{ fallback = "tail", minTrials = 4 \} = \{\}\) \{[\s\S]*?\n\}\n\nfunction promptBenchmarkRegisterDispatch/
  );
  assert.ok(fnMatch, "promptBenchmarkAutoStrategyForModel function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /const byStrategy = new Map\(\[\s*\["tail", \[\]\],\s*\["baseline", \[\]\],\s*\]\)/);
  assert.match(fnText, /const smoothedSuccess = \(success \+ 1\) \/ \(attempts \+ 2\)/);
  assert.match(fnText, /reason: "insufficient_data"/);
  assert.match(fnText, /reason: "benchmark"/);
});

test("Auto strategy ranking treats zero-cost benchmark rows as valid cost data", () => {
  const harness = loadPromptBenchmarkAutoHarness();
  harness.setState({
    promptBenchmark: {
      trials: [
        { strategy: "tail", model: "gemini-3-pro-image-preview", status: "success", latencyS: 2.0, costUsd: 1.0 },
        { strategy: "tail", model: "gemini-3-pro-image-preview", status: "success", latencyS: 2.0, costUsd: 1.0 },
        { strategy: "baseline", model: "gemini-3-pro-image-preview", status: "success", latencyS: 2.0, costUsd: 0.0 },
        { strategy: "baseline", model: "gemini-3-pro-image-preview", status: "success", latencyS: 2.0, costUsd: 0.0 },
      ],
    },
  });

  const result = harness.resolve("gemini-3-pro-image-preview", { fallback: "tail", minTrials: 4 });
  assert.equal(result.reason, "benchmark");
  assert.equal(result.strategy, "baseline");
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
