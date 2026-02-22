import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Mother intent coalesces rapid realtime intent request dispatches", () => {
  assert.match(app, /const MOTHER_V2_INTENT_REQUEST_COALESCE_MS = 900;/);
  assert.match(
    app,
    /if \(sinceLastIntentRequestMs < MOTHER_V2_INTENT_REQUEST_COALESCE_MS\) \{[\s\S]*motherV2QueueIntentReplay\("coalesce_window"\);[\s\S]*motherV2ScheduleIntentReplayArm\(\{[\s\S]*reason: "coalesce_window_elapsed",[\s\S]*\}\);[\s\S]*return false;/
  );
  assert.match(
    app,
    /const requestStartedAt = Date\.now\(\);[\s\S]*idle\.lastIntentRequestAt = requestStartedAt;[\s\S]*idle\.pendingIntentStartedAt = requestStartedAt;/
  );
});

test("Mother reject telemetry increments only in rejectable phases", () => {
  assert.match(
    app,
    /const rejectablePhase =[\s\S]*phase === MOTHER_IDLE_STATES\.INTENT_HYPOTHESIZING[\s\S]*phase === MOTHER_IDLE_STATES\.OFFERING[\s\S]*phase === MOTHER_IDLE_STATES\.DRAFTING;/
  );
  assert.match(
    app,
    /if \(!rejectablePhase\) \{[\s\S]*kind: "rejected_ignored"[\s\S]*reason: "phase_not_rejectable"[\s\S]*return;/
  );
  assert.match(app, /idle\.telemetry\.rejected = \(Number\(idle\.telemetry\?\.rejected\) \|\| 0\) \+ 1;/);
});

test("Mother intent icons early no-route drops are explicitly traced", () => {
  assert.match(
    app,
    /if \(!intent && !ambient && !motherCanAcceptRealtime\) \{[\s\S]*kind: "intent_icons_ignored"[\s\S]*reason: "no_pending_route"[\s\S]*event_action_version:[\s\S]*return;/
  );
});

test("Mother intent replay in hypothesizing phase dispatches before consuming queue", () => {
  assert.match(
    app,
    /if \(String\(idle\.phase \|\| ""\) === MOTHER_IDLE_STATES\.INTENT_HYPOTHESIZING\) \{[\s\S]*const dispatched = await motherV2RequestIntentInference\(\)\.catch\(\(\) => false\);[\s\S]*if \(dispatched\) \{[\s\S]*latest\.intentReplayQueued = false;[\s\S]*dispatch: "direct",/
  );
});

test("Mother proposal guidance consistently uses M dismiss", () => {
  assert.match(app, /Proposal ready\. ✓ deploy, M dismiss, R reroll\./);
  assert.match(app, /Mother proposal ready\. ✓ deploy, M dismiss, R reroll\./);
  assert.doesNotMatch(app, /✕ dismiss/);
});
