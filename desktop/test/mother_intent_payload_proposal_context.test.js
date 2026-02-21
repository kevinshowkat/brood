import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Mother intent payload includes proposal_context soft priors", () => {
  const fnMatch = app.match(/function motherV2IntentPayload[\s\S]*?\n}\n\nfunction motherV2BuildIntentRequestId/);
  assert.ok(fnMatch, "motherV2IntentPayload block not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /const proposalContext = motherV2BuildProposalContextForIntentPayload\(/);
  assert.match(fnText, /proposal_context:\s*proposalContext/);
  assert.match(fnText, /schema:\s*"brood\.mother\.intent_infer\.v1"/);
});

test("Mother proposal_context builder includes interaction staleness and compact geometry priors", () => {
  const fnMatch = app.match(
    /function motherV2BuildProposalContextForIntentPayload[\s\S]*?\n}\n\nfunction motherV2IntentPayload/
  );
  assert.ok(fnMatch, "motherV2BuildProposalContextForIntentPayload block not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /schema:\s*"brood\.mother\.proposal_context\.v1"/);
  assert.match(fnText, /\bINTERACTION_STALE_CUTOFF_MS = 10 \* 60 \* 1000\b/);
  assert.match(fnText, /\binteraction_stale_cutoff_ms:\s*INTERACTION_STALE_CUTOFF_MS\b/);
  assert.match(fnText, /\bweight_hint\b/);
  assert.match(fnText, /\bfocus_score\b/);
  assert.match(fnText, /\bgeometry_score\b/);
  assert.match(fnText, /\bgeometry_trace\b/);
  assert.match(fnText, /\bconst shotTypeHints = motherV2ShotTypeHints\(/);
  assert.match(fnText, /\bpreferred_shot_type:\s*shotTypeHints\.primary_shot_type\b/);
  assert.match(fnText, /\balternate_shot_type:\s*shotTypeHints\.alternate_shot_type\b/);
  assert.match(fnText, /\bpreferred_lighting_profile:\s*shotTypeHints\.primary_lighting_profile\b/);
  assert.match(fnText, /\balternate_lighting_profile:\s*shotTypeHints\.alternate_lighting_profile\b/);
  assert.match(fnText, /\bpreferred_lens_guidance:\s*shotTypeHints\.primary_lens_guidance\b/);
  assert.match(fnText, /\balternate_lens_guidance:\s*shotTypeHints\.alternate_lens_guidance\b/);
  assert.match(fnText, /\bshot_type_hints:\s*shotTypeHints\b/);
  assert.match(fnText, /\brelations:\s*relations\.slice\(/);
});
