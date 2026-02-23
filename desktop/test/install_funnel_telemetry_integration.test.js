import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Install funnel telemetry: first proposal lifecycle events are wired", () => {
  assert.match(app, /function maybeEmitFirstProposalProposed\(fields = \{\}\)/);
  assert.match(app, /emitInstallTelemetryAsync\("first_proposal_proposed", fields\);/);
  assert.match(app, /function maybeEmitFirstProposalAccepted\(fields = \{\}\)/);
  assert.match(app, /emitInstallTelemetryAsync\("first_proposal_accepted", fields\);/);
  assert.match(app, /maybeEmitFirstProposalProposed\(\{\s*source: "mother_draft_ready"/);
  assert.match(app, /maybeEmitFirstProposalAccepted\(\{\s*source: "mother_confirm_waiting_for_user"/);
});

test("Install funnel telemetry: smoke automation import and local ability paths are wired", () => {
  assert.match(app, /else if \(action === "import_local_paths"\)/);
  assert.match(app, /else if \(action === "mother_inject_local_draft"\)/);
  assert.match(app, /seededSyntheticDispatch = !idle\.pendingDispatchToken && !idle\.pendingGeneration/);
  assert.match(app, /motherIdleTransitionTo\(MOTHER_IDLE_EVENTS\.CONFIRM\)/);
  assert.match(app, /importLocalPathsAtCanvasPoint\(/);
  assert.match(app, /reason: "import_local_paths"/);
  assert.match(app, /maybeEmitFirstAbilitySuccess\(\{\s*source: "local_artifact"/);
});
