import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

function loadIntentParserFns() {
  const start = app.indexOf("function _stripJsonFences(");
  const end = app.indexOf("function _normalizeVisionLabel(");
  assert.ok(start >= 0, "parser start marker missing");
  assert.ok(end > start, "parser end marker missing");
  const parserChunk = app.slice(start, end);

  const clamp = (value, min, max) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, num));
  };
  const allowedModes = new Set([
    "amplify",
    "transcend",
    "destabilize",
    "purify",
    "hybridize",
    "mythologize",
    "monumentalize",
    "fracture",
    "romanticize",
    "alienate",
  ]);
  const motherV2MaybeTransformationMode = (raw) => {
    const mode = String(raw || "").trim().toLowerCase();
    return allowedModes.has(mode) ? mode : null;
  };

  return new Function(
    "clamp",
    "motherV2MaybeTransformationMode",
    `${parserChunk}\nreturn { parseIntentIconsJsonDetailed, classifyIntentIconsRouting };`
  )(clamp, motherV2MaybeTransformationMode);
}

const { parseIntentIconsJsonDetailed, classifyIntentIconsRouting } = loadIntentParserFns();

function baseIntentPayload() {
  return {
    frame_id: "mother-intent-a7-123",
    schema: "brood.intent_icons",
    schema_version: 1,
    transformation_mode: "hybridize",
    intent_icons: [{ icon_id: "IMAGE_GENERATION", confidence: 0.93, position_hint: "primary" }],
    branches: [{ branch_id: "content_engine", confidence: 0.82, icons: ["CONTENT_ENGINE"], lane_position: "left" }],
    checkpoint: { icons: ["YES_TOKEN", "NO_TOKEN", "MAYBE_TOKEN"], applies_to: "content_engine" },
  };
}

function payloadText(indent = 2) {
  return JSON.stringify(baseIntentPayload(), null, indent);
}

test("parse intent icons: valid raw JSON object", () => {
  const parsed = parseIntentIconsJsonDetailed(payloadText());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.schema, "brood.intent_icons");
  assert.equal(parsed.value.intent_icons[0].icon_id, "IMAGE_GENERATION");
});

test("parse intent icons: fenced JSON", () => {
  const wrapped = `\`\`\`json\n${payloadText()}\n\`\`\``;
  const parsed = parseIntentIconsJsonDetailed(wrapped);
  assert.equal(parsed.ok, true);
  assert.match(parsed.strategy, /fenced|raw_unfenced|balanced_block/);
});

test("parse intent icons: prose plus fenced JSON", () => {
  const wrapped = `Here is the structured output:\n\`\`\`json\n${payloadText()}\n\`\`\`\nDone.`;
  const parsed = parseIntentIconsJsonDetailed(wrapped);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.schema, "brood.intent_icons");
});

test("parse intent icons: duplicated concatenated objects", () => {
  const raw = payloadText();
  const duplicated = `${raw}${raw}`;
  const parsed = parseIntentIconsJsonDetailed(duplicated);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.frame_id, "mother-intent-a7-123");
});

test("parse intent icons: nested payload in data object", () => {
  const wrapped = JSON.stringify({ data: baseIntentPayload() });
  const parsed = parseIntentIconsJsonDetailed(wrapped);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.branches[0].branch_id, "content_engine");
});

test("parse intent icons: nested payload in result string", () => {
  const wrapped = JSON.stringify({ result: payloadText() });
  const parsed = parseIntentIconsJsonDetailed(wrapped);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.transformation_mode, "hybridize");
});

test("parse intent icons: trailing commas are tolerated", () => {
  const withTrailingCommas = `{
  "schema": "brood.intent_icons",
  "schema_version": 1,
  "transformation_mode": "hybridize",
  "intent_icons": [
    {
      "icon_id": "IMAGE_GENERATION",
      "confidence": 0.9,
      "position_hint": "primary",
    },
  ],
  "branches": [
    {
      "branch_id": "content_engine",
      "confidence": 0.8,
      "icons": ["CONTENT_ENGINE",],
      "lane_position": "left",
    },
  ],
}`;
  const parsed = parseIntentIconsJsonDetailed(withTrailingCommas);
  assert.equal(parsed.ok, true);
  assert.match(parsed.strategy, /trailing_commas_removed/);
});

test("parse intent icons: real truncated payload shape is classified as truncated_json", () => {
  const truncatedFromRunLog =
    '{\n  "frame_id": "mother-intent-a0-1771156098794-a00",\n  "schema": "brood.intent_icons",\n  "schema_version": 1,\n  "intent_icons": [{"icon_id":"IMAGE_GENERATION","confidence":0.9,"position_hint":"primary"}],\n  "branches": [{"branch_id":"content_engine","confidence":0.7,"icons":["CONTENT_ENGINE"],"lane_position":"left"}],\n  "checkpoint": {\n    "icons';
  const parsed = parseIntentIconsJsonDetailed(truncatedFromRunLog);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "truncated_json");
});

test("intent routing: stale path mismatch is classified separately from parse failure", () => {
  const routing = classifyIntentIconsRouting({
    path: "/tmp/mother-intent-2.png",
    intentPendingPath: "/tmp/intent-ambient-1.png",
    ambientPendingPath: "/tmp/intent-ambient-1.png",
    motherCanAcceptRealtime: true,
    motherRealtimePath: "/tmp/mother-intent-1.png",
    motherActionVersion: 5,
    eventActionVersion: 5,
  });
  assert.equal(routing.matchMother, false);
  assert.equal(routing.ignoreReason, "snapshot_path_mismatch");
});
