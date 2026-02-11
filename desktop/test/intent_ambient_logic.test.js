import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mergeAmbientSuggestions,
  placeAmbientSuggestions,
  shouldScheduleAmbientIntent,
} from "../src/intent_ambient.js";

function overlaps(a, b, pad = 0) {
  const ax0 = a.x - pad;
  const ay0 = a.y - pad;
  const ax1 = a.x + a.w + pad;
  const ay1 = a.y + a.h + pad;
  const bx0 = b.x - pad;
  const by0 = b.y - pad;
  const bx1 = b.x + b.w + pad;
  const by1 = b.y + b.h + pad;
  return !(ax1 <= bx0 || bx1 <= ax0 || ay1 <= by0 || by1 <= ay0);
}

test("Ambient intent: schedules on edit actions", () => {
  for (const reason of ["add", "import", "remove", "move", "resize", "replace", "describe", "composition_change"]) {
    assert.equal(shouldScheduleAmbientIntent(reason), true, reason);
  }
});

test("Ambient intent: does not schedule on viewport-only navigation reasons", () => {
  for (const reason of ["wheel", "zoom", "pan", "gesture", "viewport"]) {
    assert.equal(shouldScheduleAmbientIntent(reason), false, reason);
  }
});

test("Ambient nudge placement: clamps nudges inside viewport bounds", () => {
  const out = placeAmbientSuggestions({
    branches: [
      {
        branch_id: "content_engine",
        asset_type: "icon",
        asset_key: "content_engine",
        confidence: 0.81,
        evidence_image_ids: ["a"],
      },
      {
        branch_id: "game_dev_assets",
        asset_type: "icon",
        asset_key: "game_dev_assets",
        confidence: 0.72,
        evidence_image_ids: ["b"],
      },
    ],
    imageRectsById: {
      a: { x: 6, y: 8, w: 120, h: 90 },
      b: { x: 220, y: 200, w: 90, h: 90 },
    },
    touchedImageIds: ["b", "a"],
    viewportWorldBounds: { minX: 0, minY: 0, maxX: 320, maxY: 280 },
    maxSuggestions: 3,
    iconWorldSize: 86,
  });

  assert.equal(out.length, 2);
  for (const rec of out) {
    const r = rec.world_rect;
    assert.ok(r.x >= 0);
    assert.ok(r.y >= 0);
    assert.ok(r.x + r.w <= 320);
    assert.ok(r.y + r.h <= 280);
    assert.equal(rec.asset_type, "icon");
    assert.ok(rec.asset_key);
    assert.ok(rec.anchor?.world);
  }
});

test("Ambient nudge placement: avoids collisions between suggestions", () => {
  const out = placeAmbientSuggestions({
    branches: [
      { branch_id: "content_engine", asset_type: "icon", asset_key: "content_engine", evidence_image_ids: ["a"] },
      { branch_id: "streaming_content", asset_type: "icon", asset_key: "streaming_content", evidence_image_ids: ["a"] },
      { branch_id: "uiux_prototyping", asset_type: "icon", asset_key: "uiux_prototyping", evidence_image_ids: ["a"] },
    ],
    imageRectsById: {
      a: { x: 120, y: 80, w: 80, h: 80 },
    },
    viewportWorldBounds: { minX: 0, minY: 0, maxX: 360, maxY: 260 },
    maxSuggestions: 3,
    iconWorldSize: 74,
    collisionPadWorld: 10,
  });

  assert.equal(out.length, 3);
  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      assert.equal(overlaps(out[i].world_rect, out[j].world_rect, 8), false);
    }
  }
});

test("Ambient suggestions merge: preserves created timestamp and refreshes updated timestamp", () => {
  const prev = [
    {
      id: "ambient:content_engine:content_engine",
      branch_id: "content_engine",
      asset_type: "icon",
      asset_key: "content_engine",
      world_rect: { x: 20, y: 20, w: 50, h: 50 },
      created_at_ms: 10,
      updated_at_ms: 10,
    },
  ];
  const next = [
    {
      id: "ambient:content_engine:content_engine",
      branch_id: "content_engine",
      asset_type: "icon",
      asset_key: "content_engine",
      world_rect: { x: 30, y: 30, w: 50, h: 50 },
    },
  ];
  const merged = mergeAmbientSuggestions(prev, next, { nowMs: 90 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].created_at_ms, 10);
  assert.equal(merged[0].updated_at_ms, 90);
});
