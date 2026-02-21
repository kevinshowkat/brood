import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Shot type mapping includes requested amplify and mythologize defaults", () => {
  assert.match(
    app,
    /const MOTHER_V2_SHOT_HINTS_BY_MODE = Object\.freeze\(\{[\s\S]*?amplify:\s*Object\.freeze\(\{[\s\S]*?primary:\s*"close-up detail shot"/
  );
  assert.match(
    app,
    /const MOTHER_V2_SHOT_HINTS_BY_MODE = Object\.freeze\(\{[\s\S]*?mythologize:\s*Object\.freeze\(\{[\s\S]*?primary:\s*"low-angle hero shot"/
  );
  assert.match(app, /lighting_profile:\s*"/);
  assert.match(app, /lens_guidance:\s*"/);
  assert.match(app, /function motherV2ShotTypeHints\(\{ preferredMode = "", candidateModes = \[\] \} = \{\}\)/);
  assert.match(app, /alternate_shot_type:/);
  assert.match(app, /primary_lighting_profile:/);
  assert.match(app, /primary_lens_guidance:/);
});

test("Mother compile prompt includes shot type guidance and alternates", () => {
  const fnMatch = app.match(/function motherV2CompilePromptLocal[\s\S]*?\n}\n\nasync function motherV2WritePayloadFile/);
  assert.ok(fnMatch, "motherV2CompilePromptLocal function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /const shotTypeHints = motherV2ShotTypeHints\(/);
  assert.match(
    fnText,
    /const positiveLines = \[\s*`Transformation mode: \$\{transformationMode\}\.`,\s*`Shot type guidance: \$\{shotTypeHints\.shot_instruction\}`,\s*`Lighting guidance: \$\{shotTypeHints\.lighting_instruction\}`,\s*shotTypeHints\.lens_instruction,\s*`Creative directive: \$\{creativeDirective\}\.`,\s*`Intent summary: \$\{summary\}\.`,\s*`Role anchors: \$\{roleText\}\.`,\s*\]/
  );
  assert.doesNotMatch(fnText, /positiveLines\.push\(`Shot type guidance: \$\{shotTypeHints\.shot_instruction\}`\);/);
  assert.doesNotMatch(fnText, /positiveLines\.push\(`Lighting guidance: \$\{shotTypeHints\.lighting_instruction\}`\);/);
  assert.doesNotMatch(fnText, /positiveLines\.push\(`Lens guidance: \$\{shotTypeHints\.lens_instruction\}`\);/);
  assert.match(fnText, /shot_type:\s*shotTypeHints\.primary_shot_type/);
  assert.match(fnText, /alternate_shot_type:\s*shotTypeHints\.alternate_shot_type/);
  assert.match(fnText, /lighting_profile:\s*shotTypeHints\.primary_lighting_profile/);
  assert.match(fnText, /lens_guidance:\s*shotTypeHints\.primary_lens_guidance/);
});

test("Gemini and non-Gemini context payloads carry shot type hints", () => {
  const nonGeminiMatch = app.match(
    /function motherV2BuildNonGeminiModelContextEnvelope[\s\S]*?\n}\n\nfunction motherV2BuildModelContextEnvelopes/
  );
  assert.ok(nonGeminiMatch, "motherV2BuildNonGeminiModelContextEnvelope function not found");
  const nonGeminiText = nonGeminiMatch[0];
  assert.match(nonGeminiText, /const shotTypeHints = motherV2ShotTypeHints\(/);
  assert.match(nonGeminiText, /shot_type:\s*shotTypeHints\.primary_shot_type/);
  assert.match(nonGeminiText, /alternate_shot_type:\s*shotTypeHints\.alternate_shot_type/);
  assert.match(nonGeminiText, /lighting_profile:\s*shotTypeHints\.primary_lighting_profile/);
  assert.match(nonGeminiText, /lens_guidance:\s*shotTypeHints\.primary_lens_guidance/);

  const geminiMatch = app.match(
    /function motherV2BuildGeminiContextPacket[\s\S]*?\n}\n\nasync function motherV2DispatchViaImagePayload/
  );
  assert.ok(geminiMatch, "motherV2BuildGeminiContextPacket function not found");
  const geminiText = geminiMatch[0];
  assert.match(geminiText, /const shotTypeHints = motherV2ShotTypeHints\(/);
  assert.match(geminiText, /shot_type_hints:\s*shotTypeHints/);
  assert.match(geminiText, /shot_type:\s*shotTypeHints\.primary_shot_type/);
  assert.match(geminiText, /alternate_shot_type:\s*shotTypeHints\.alternate_shot_type/);
  assert.match(geminiText, /lighting_profile:\s*shotTypeHints\.primary_lighting_profile/);
  assert.match(geminiText, /lens_guidance:\s*shotTypeHints\.primary_lens_guidance/);
});

test("Details popover renders dedicated shot and lighting rows ahead of JSON blob", () => {
  const fnMatch = app.match(/function motherRenderDetailsBadgeAndPopover[\s\S]*?\n}\n\nfunction hitTestMotherRoleGlyph/);
  assert.ok(fnMatch, "motherRenderDetailsBadgeAndPopover function not found");
  const fnText = fnMatch[0];

  assert.match(fnText, /if \(cues\?\.shot_type\) rows\.push\(`Shot: \$\{clampText\(cues\.shot_type, 52\)\}`\);/);
  assert.match(fnText, /if \(cues\?\.lighting_profile\) rows\.push\(`Lighting: \$\{clampText\(cues\.lighting_profile, 52\)\}`\);/);
  assert.match(fnText, /if \(cues\?\.lens_guidance\) rows\.push\(`Lens: \$\{clampText\(cues\.lens_guidance, 52\)\}`\);/);
});
