export function computeActionGridSlots({
  selectionCount = 0,
  hasImage = false,
} = {}) {
  const n = Math.max(0, Math.min(99, Number(selectionCount) || 0));
  const slots = new Array(9).fill(null);

  const baseTools = [
    { key: "annotate", label: "Annotate", kind: "tool" },
    { key: "lasso", label: "Lasso", kind: "tool" },
  ];

  const noImageFallback = [
    { key: "bg", label: "BG", kind: "ability" },
    { key: "variations", label: "Vars", kind: "ability" },
    { key: "extract_dna", label: "DNA", kind: "ability" },
    { key: "soul_leech", label: "Soul", kind: "ability" },
    { key: "create_layers", label: "Layers", kind: "ability" },
    { key: "recast", label: "Recast", kind: "ability" },
    { key: "crop_square", label: "Square", kind: "ability" },
  ];

  const singleImage = [
    { key: "extract_dna", label: "DNA", kind: "ability" },
    { key: "soul_leech", label: "Soul", kind: "ability" },
    { key: "create_layers", label: "Layers", kind: "ability" },
    { key: "bg", label: "BG", kind: "ability" },
    { key: "variations", label: "Vars", kind: "ability" },
    { key: "recast", label: "Recast", kind: "ability" },
    { key: "crop_square", label: "Square", kind: "ability" },
  ];

  const twoImage = [
    { key: "combine", label: "Combine", kind: "ability_multi" },
    { key: "bridge", label: "Bridge", kind: "ability_multi" },
    { key: "swap_dna", label: "Swap", kind: "ability_multi" },
    { key: "extract_dna", label: "DNA", kind: "ability" },
    { key: "soul_leech", label: "Soul", kind: "ability" },
    { key: "bg", label: "BG", kind: "ability" },
    { key: "variations", label: "Vars", kind: "ability" },
  ];

  const threeImage = [
    { key: "extract_rule", label: "Rule", kind: "ability_multi" },
    { key: "odd_one_out", label: "Odd", kind: "ability_multi" },
    { key: "triforce", label: "Tri", kind: "ability_multi" },
    { key: "extract_dna", label: "DNA", kind: "ability" },
    { key: "soul_leech", label: "Soul", kind: "ability" },
    { key: "bg", label: "BG", kind: "ability" },
    { key: "variations", label: "Vars", kind: "ability" },
  ];

  const manyImage = [
    { key: "extract_dna", label: "DNA", kind: "ability" },
    { key: "soul_leech", label: "Soul", kind: "ability" },
    { key: "bg", label: "BG", kind: "ability" },
    { key: "variations", label: "Vars", kind: "ability" },
    { key: "recast", label: "Recast", kind: "ability" },
    { key: "crop_square", label: "Square", kind: "ability" },
    { key: "remove_people", label: "No People", kind: "ability" },
  ];

  let ordered = [...baseTools];
  if (!hasImage || n <= 0) {
    ordered = ordered.concat(noImageFallback);
  } else if (n === 1) {
    ordered = ordered.concat(singleImage);
  } else if (n === 2) {
    ordered = ordered.concat(twoImage);
  } else if (n === 3) {
    ordered = ordered.concat(threeImage);
  } else {
    ordered = ordered.concat(manyImage);
  }

  for (let i = 0; i < slots.length && i < ordered.length; i += 1) {
    slots[i] = { ...ordered[i], hotkey: String(i + 1) };
  }
  return slots;
}
