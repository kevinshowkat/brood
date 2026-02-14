import { test } from "node:test";
import assert from "node:assert/strict";

import { computeActionGridSlots } from "../src/action_grid_logic.js";

function slotKeys(slots) {
  return slots.map((slot) => (slot ? slot.key : null));
}

test("computeActionGridSlots: returns 9 slots with base tools first", () => {
  const slots = computeActionGridSlots({ selectionCount: 0, hasImage: false, alwaysOnVisionEnabled: false });
  assert.equal(slots.length, 9);
  assert.deepEqual(slotKeys(slots).slice(0, 4), ["annotate", "pan", "lasso", "designate"]);
});

test("computeActionGridSlots: no image -> tools only", () => {
  const slots = computeActionGridSlots({ selectionCount: 3, hasImage: false, alwaysOnVisionEnabled: true });
  assert.deepEqual(slotKeys(slots), ["annotate", "pan", "lasso", "designate", null, null, null, null, null]);
});

test("computeActionGridSlots: 1 selected -> single-image abilities (DIAG when AOV off)", () => {
  const slots = computeActionGridSlots({ selectionCount: 1, hasImage: true, alwaysOnVisionEnabled: false });
  assert.deepEqual(slotKeys(slots), [
    "extract_dna",
    "pan",
    "lasso",
    "designate",
    "annotate",
    "soul_leech",
    "bg",
    "variations",
    "diagnose",
  ]);
});

test("computeActionGridSlots: 1 selected -> Square when AOV on", () => {
  const slots = computeActionGridSlots({ selectionCount: 1, hasImage: true, alwaysOnVisionEnabled: true });
  assert.equal(slots[8]?.key, "crop_square");
});

test("computeActionGridSlots: 2 selected -> only 2-image abilities (colored multi)", () => {
  const slots = computeActionGridSlots({ selectionCount: 2, hasImage: true, alwaysOnVisionEnabled: false });
  assert.deepEqual(slotKeys(slots), [
    "annotate",
    "pan",
    "lasso",
    "designate",
    "combine",
    "bridge",
    "swap_dna",
    "argue",
    null,
  ]);
  for (const slot of slots.slice(4, 8)) {
    assert.equal(slot?.kind, "ability_multi");
  }
});

test("computeActionGridSlots: 3 selected -> only 3-image abilities", () => {
  const slots = computeActionGridSlots({ selectionCount: 3, hasImage: true, alwaysOnVisionEnabled: false });
  assert.deepEqual(slotKeys(slots), [
    "annotate",
    "pan",
    "lasso",
    "designate",
    "extract_rule",
    "odd_one_out",
    "triforce",
    null,
    null,
  ]);
});

test("computeActionGridSlots: 4+ selected -> tools only", () => {
  const slots = computeActionGridSlots({ selectionCount: 4, hasImage: true, alwaysOnVisionEnabled: false });
  assert.deepEqual(slotKeys(slots), ["annotate", "pan", "lasso", "designate", null, null, null, null, null]);
});
