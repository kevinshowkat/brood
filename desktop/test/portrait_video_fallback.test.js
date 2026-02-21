import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Portrait videos: refresh path falls back from native agent to legacy swapped clips without dryrun", () => {
  assert.match(app, /function portraitFallbackAgentFromProvider\(/);
  assert.match(app, /function portraitProviderForActiveKey\(/);
  assert.match(app, /if \(requestedProvider !== currentProvider\) return;/);
  assert.match(app, /if \(requestedProvider !== currentProviderAfterIndex\) return;/);
  assert.match(app, /clipPath = portraitClipPathForAgent\(index, agent, clipState\);/);
  assert.match(app, /if \(!clipPath && fallbackAgent && fallbackAgent !== agent\)/);
  assert.match(app, /clipPath = portraitClipPathForAgent\(index, fallbackAgent, clipState\);/);
  assert.doesNotMatch(app, /clipPath = portraitClipPathForAgent\(index, "dryrun", clipState\);/);
});

test("Portrait videos: OpenAI realtime activity keeps OpenAI slots in working state with cooldown", () => {
  assert.match(app, /const OPENAI_REALTIME_PORTRAIT_COOLDOWN_MS = 5_000;/);
  assert.match(app, /function isOpenAiRealtimeSignal\(\{ source = null, model = null \} = \{\}\)/);
  assert.match(app, /function markOpenAiRealtimePortraitActivity\(\{ extendMs = OPENAI_REALTIME_PORTRAIT_COOLDOWN_MS \} = \{\}\)/);
  assert.match(app, /const openAiBoost = openaiRealtimePortraitBoostActive && isOpenAiProvider\(provider\);/);
  assert.match(app, /const clipState = busy \|\| openAiBoost \? "working" : "idle";/);
  assert.match(app, /isOpenAiRealtimeSignal\(\{ source: event.source, model: event.model \}\)/);
  assert.match(app, /portraitWorking\(\"Intent Realtime\", \{\s*providerOverride: intentRtProvider,\s*forceProvider: true,/);
  assert.match(app, /function portraitWorking\(_actionLabel, \{ providerOverride = null, forceProvider = false, clearDirector = true \} = \{\}\)/);
});
