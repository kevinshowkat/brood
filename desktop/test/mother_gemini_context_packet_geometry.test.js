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
