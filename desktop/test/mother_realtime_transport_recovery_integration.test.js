import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Mother realtime recovery: retry decision is wired before hard failure", () => {
  assert.match(app, /nextMotherRealtimeIntentFailureAction\(\{/);
  assert.match(app, /if \(retryDecision\.action === "retry"\) \{/);
  assert.match(app, /const retried = await motherV2RetryRealtimeIntentTransport\(\{/);
  assert.match(app, /if \(retried\) \{\s*setStatus\("Mother: retrying realtime intent…"\);[\s\S]*return;/);
  assert.match(app, /if \(retryDecision\.retryable && retryDecision\.action === "fail"\) \{/);
  assert.match(app, /kind:\s*"intent_realtime_retry_exhausted"/);
  assert.match(app, /motherIdleHandleGenerationFailed\(`Mother realtime intent failed\. \${msg}`\);/);
});

