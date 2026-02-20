import { test } from "node:test";
import assert from "node:assert/strict";

import { computeActionGridSlots } from "../src/action_grid_logic.js";

function slotKeys(slots) {
  return slots.map((slot) => (slot ? slot.key : null));
}

test("computeActionGridSlots: returns 9 slots with base tools first", () => {
  const slots = computeActionGridSlots({ selectionCount: 0, hasImage: false, alwaysOnVisionEnabled: false });
  assert.equal(slots.length, 9);
  assert.deepEqual(slotKeys(slots).slice(0, 4), ["annotate", "lasso", "bg", "variations"]);
});

test("computeActionGridSlots: no image -> dense fallback slots", () => {
  const slots = computeActionGridSlots({ selectionCount: 3, hasImage: false, alwaysOnVisionEnabled: true });
  assert.deepEqual(slotKeys(slots), [
    "annotate",
    "lasso",
    "bg",
    "variations",
    "extract_dna",
    "soul_leech",
    "create_layers",
    "recast",
    "crop_square",
  ]);
});

test("computeActionGridSlots: 1 selected -> single-image abilities", () => {
  const slots = computeActionGridSlots({ selectionCount: 1, hasImage: true, alwaysOnVisionEnabled: false });
  assert.deepEqual(slotKeys(slots), [
    "annotate",
    "lasso",
    "extract_dna",
    "soul_leech",
    "create_layers",
    "bg",
    "variations",
    "recast",
    "crop_square",
  ]);
});

test("computeActionGridSlots: 1 selected -> Square when AOV on", () => {
  const slots = computeActionGridSlots({ selectionCount: 1, hasImage: true, alwaysOnVisionEnabled: true });
  assert.equal(slots[8]?.key, "crop_square");
});

test("computeActionGridSlots: 2 selected -> 2-image abilities are promoted", () => {
  const slots = computeActionGridSlots({ selectionCount: 2, hasImage: true, alwaysOnVisionEnabled: false });
  assert.deepEqual(slotKeys(slots), [
    "annotate",
    "lasso",
    "combine",
    "bridge",
    "swap_dna",
    "extract_dna",
    "soul_leech",
    "bg",
    "variations",
  ]);
  for (const slot of slots.slice(2, 5)) {
    assert.equal(slot?.kind, "ability_multi");
  }
});

test("computeActionGridSlots: 3 selected -> only 3-image abilities are promoted", () => {
  const slots = computeActionGridSlots({ selectionCount: 3, hasImage: true, alwaysOnVisionEnabled: false });
  assert.deepEqual(slotKeys(slots), [
    "annotate",
    "lasso",
    "extract_rule",
    "odd_one_out",
    "triforce",
    "extract_dna",
    "soul_leech",
    "bg",
    "variations",
  ]);
});

test("computeActionGridSlots: 4+ selected -> dense fallback without gaps", () => {
  const slots = computeActionGridSlots({ selectionCount: 4, hasImage: true, alwaysOnVisionEnabled: false });
  assert.deepEqual(slotKeys(slots), [
    "annotate",
    "lasso",
    "extract_dna",
    "soul_leech",
    "bg",
    "variations",
    "recast",
    "crop_square",
    "remove_people",
  ]);
});

test("computeActionGridSlots: hotkeys are sequential 1-9", () => {
  const slots = computeActionGridSlots({ selectionCount: 1, hasImage: true, alwaysOnVisionEnabled: false });
  assert.deepEqual(
    slots.map((slot) => String(slot?.hotkey || "")),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
  );
});
