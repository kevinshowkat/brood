import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Mother Gemini context packet carries spatial size/proximity/overlap hints", () => {
  const fnMatch = app.match(/function motherV2BuildGeminiContextPacket[\s\S]*?\n}\n\nasync function motherV2DispatchViaImagePayload/);
  assert.ok(fnMatch, "motherV2BuildGeminiContextPacket block not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /\bcanvas_area_ratio\b/);
  assert.match(fnText, /\brelative_scale_to_largest\b/);
  assert.match(fnText, /\baspect_ratio_norm\b/);
  assert.match(fnText, /\bspatial_relations\b/);
  assert.match(fnText, /\bpairwise\b/);
  assert.match(fnText, /\boverlaps\b/);
  assert.match(fnText, /\boverlap:\s*overlaps/);
  assert.match(fnText, /\bon_a\b/);
  assert.match(fnText, /\bon_b\b/);
  assert.match(fnText, /\bregion\b/);
});

test("Mother Gemini context packet keeps weighting/staleness/constraint invariants", () => {
  const fnMatch = app.match(/function motherV2BuildGeminiContextPacket[\s\S]*?\n}\n\nasync function motherV2DispatchViaImagePayload/);
  assert.ok(fnMatch, "motherV2BuildGeminiContextPacket block not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /\bMUST_NOT_DEFAULTS\b/);
  assert.match(fnText, /\bINTERACTION_STALE_CUTOFF_MS = 10 \* 60 \* 1000\b/);
  assert.match(fnText, /\binteractionStale = transformAgeMs > INTERACTION_STALE_CUTOFF_MS\b/);
  assert.match(fnText, /Identity guardrails apply only for the single-target case/);
  assert.match(fnText, /if \(targetIdList\.length === 1\)/);
  assert.match(fnText, /const mustNotFinal = mustNot\.slice\(0, 6\)/);
  assert.match(fnText, /\bgeometry_trace\b/);
  assert.match(fnText, /\bcx:\s*round4\(entry\.rect_norm\?\.cx\s*\?\?\s*0\)/);
  assert.match(fnText, /\bcy:\s*round4\(entry\.rect_norm\?\.cy\s*\?\?\s*0\)/);
  assert.match(fnText, /\brelative_scale:\s*round4\(entry\.relative_scale_to_largest\)/);
  assert.match(fnText, /\biou_to_primary:\s*round4\(iouToPrimary\)/);
});
