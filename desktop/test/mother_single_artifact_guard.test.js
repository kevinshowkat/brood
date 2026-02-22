import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Mother single-artifact guard: success path marks first suggestion as generated", () => {
  assert.match(app, /const MOTHER_V2_SINGLE_RESULT_GUARD_WINDOW_MS = 20_000;/);
  assert.match(
    app,
    /idle\.generatedImageId = id;[\s\S]*idle\.generatedVersionId = incomingVersionId \|\| null;[\s\S]*idle\.lastSuggestionAt = Date\.now\(\);[\s\S]*idle\.hasGeneratedSinceInteraction = true;[\s\S]*idle\.suppressFailureUntil = idle\.lastSuggestionAt \+ MOTHER_V2_SINGLE_RESULT_GUARD_WINDOW_MS;/
  );
  assert.match(app, /Boolean\(motherIdle\?\.hasGeneratedSinceInteraction\)/);
  assert.match(app, /MOTHER_V2_SINGLE_RESULT_GUARD_WINDOW_MS/);
});

test("Mother single-artifact guard: lifecycle reset occurs on interaction and fresh dispatch", () => {
  assert.match(
    app,
    /if \(userInteraction\) \{[\s\S]*idle\.hasGeneratedSinceInteraction = false;[\s\S]*idle\.generatedImageId = null;[\s\S]*idle\.generatedVersionId = null;[\s\S]*idle\.suppressFailureUntil = 0;/
  );
  assert.match(
    app,
    /function motherV2DispatchCompiledPrompt\(compiled = \{\}\) \{[\s\S]*idle\.hasGeneratedSinceInteraction = false;[\s\S]*idle\.generatedImageId = null;[\s\S]*idle\.generatedVersionId = null;[\s\S]*idle\.suppressFailureUntil = 0;[\s\S]*idle\.pendingGeneration = true;/
  );
});
