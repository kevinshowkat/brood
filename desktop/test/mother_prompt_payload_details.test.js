import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

function loadNamedFunction(name) {
  const pattern = new RegExp(
    `function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n\\n(?:async\\s+)?function\\s+`,
    "m"
  );
  const match = app.match(pattern);
  assert.ok(match, `${name} function not found`);
  const source = match[0].replace(/\n\n(?:async\s+)?function\s+[\s\S]*$/, "").trim();
  return new Function(`return (${source});`)();
}

test("receipt prompt payload extraction keeps text prompt and strips binary image data", () => {
  const extractReceiptPromptApiPayload = loadNamedFunction("extractReceiptPromptApiPayload");
  const payload = {
    provider_request: {
      endpoint: "https://openrouter.ai/api/v1/responses",
      payload: {
        transport: "openrouter_responses",
        payload: {
          model: "google/gemini-3-pro-image-preview",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "A vivid portrait with warm lighting" },
                { type: "input_image", image_url: "data:image/png;base64,AAAABBBBCCCC" },
              ],
            },
          ],
        },
      },
    },
    request: {
      prompt: "fallback prompt",
      model: "gemini-3-pro-image-preview",
    },
  };
  const out = extractReceiptPromptApiPayload(payload);
  assert.equal(out.transport, "openrouter_responses");
  assert.equal(out.endpoint, "https://openrouter.ai/api/v1/responses");
  assert.equal(out.model, "google/gemini-3-pro-image-preview");
  assert.equal(out.input[0].content[0].text, "A vivid portrait with warm lighting");
  assert.match(String(out.input[0].content[1].image_url || ""), /<omitted/i);
});

test("receipt cue extraction reads shot, lighting, and lens guidance from metadata", () => {
  const extractReceiptCreativeCues = loadNamedFunction("extractReceiptCreativeCues");
  const out = extractReceiptCreativeCues({
    request: {
      metadata: {
        gemini_context_packet: {
          proposal_lock: {
            shot_type: "low-angle hero shot",
            alternate_shot_type: "epic wide establishing shot",
            lighting_profile: "high-contrast directional key with rim backlight",
            alternate_lighting_profile: "golden-hour edge light",
            lens_guidance: "24-35mm low-angle heroic perspective",
            alternate_lens_guidance: "24mm epic establishing perspective",
          },
        },
      },
    },
  });
  assert.equal(out.shot_type, "low-angle hero shot");
  assert.equal(out.alternate_shot_type, "epic wide establishing shot");
  assert.equal(out.lighting_profile, "high-contrast directional key with rim backlight");
  assert.equal(out.alternate_lighting_profile, "golden-hour edge light");
  assert.equal(out.lens_guidance, "24-35mm low-angle heroic perspective");
  assert.equal(out.alternate_lens_guidance, "24mm epic establishing perspective");
});

test("details rows include prompt payload heading and JSON lines", () => {
  const motherV2PromptPayloadDetailRows = loadNamedFunction("motherV2PromptPayloadDetailRows");
  const rows = motherV2PromptPayloadDetailRows({
    model: "google/gemini-3-pro-image-preview",
    prompt: "Create one cinematic image.",
  });
  assert.ok(Array.isArray(rows));
  assert.equal(rows[0], "Prompt Payload JSON:");
  assert.ok(rows.some((row) => String(row).includes('"model": "google/gemini-3-pro-image-preview"')));
  assert.ok(rows.some((row) => String(row).includes('"prompt": "Create one cinematic image."')));
});
