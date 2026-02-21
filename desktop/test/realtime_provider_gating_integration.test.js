import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Realtime scope readiness fails closed until key status is available", () => {
  assert.match(
    app,
    /function realtimeScopeReady\(scope = "intent"\) \{[\s\S]*if \(!status \|\| typeof status !== "object"\) return false;/
  );
});

test("Intent realtime gating checks provider readiness without keyStatus guard", () => {
  assert.match(
    app,
    /function allowAmbientIntentRealtime\(\) \{[\s\S]*if \(!realtimeScopeReady\("intent"\)\) return false;/
  );
  assert.match(
    app,
    /function allowIntentRealtime\(\) \{[\s\S]*if \(!realtimeScopeReady\("intent"\)\) return false;/
  );
});

test("OpenRouter onboarding restart waits for PTY running confirmation", () => {
  assert.match(
    app,
    /async function restartEngineAfterOpenRouterKeySave\(\) \{[\s\S]*invoke\("get_pty_status"\)[\s\S]*engine did not report ready after restart/
  );
});
