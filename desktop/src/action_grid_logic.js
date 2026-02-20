export function computeActionGridSlots({
  selectionCount = 0,
  hasImage = false,
} = {}) {
  const n = Math.max(0, Math.min(99, Number(selectionCount) || 0));
  const slots = new Array(9).fill(null);

  const baseTools = [
    { key: "annotate", label: "Annotate", kind: "tool", hotkey: "1" },
    { key: "pan", label: "Pan", kind: "tool", hotkey: "2" },
    { key: "lasso", label: "Lasso", kind: "tool", hotkey: "3" },
  ];
  for (let i = 0; i < baseTools.length; i += 1) {
    slots[i] = baseTools[i];
  }

  if (!hasImage || n <= 0) return slots;

  if (n === 1) {
    // Promote DNA extraction to key 1 and move annotate to key 5 for single-image flow.
    slots[0] = { key: "extract_dna", label: "DNA", kind: "ability", hotkey: "1" };
    const abilities = [
      { key: "annotate", label: "Annotate", kind: "tool", hotkey: "5" },
      { key: "soul_leech", label: "Soul", kind: "ability", hotkey: "6" },
      { key: "bg", label: "BG", kind: "ability", hotkey: "7" },
      { key: "create_layers", label: "Layers", kind: "ability", hotkey: "8" },
      { key: "crop_square", label: "Square", kind: "ability", hotkey: "9" },
    ];
    for (let i = 0; i < abilities.length; i += 1) {
      slots[4 + i] = abilities[i];
    }
    return slots;
  }

  if (n === 2) {
    const abilities = [
      { key: "combine", label: "Combine", kind: "ability_multi", hotkey: "5" },
      { key: "bridge", label: "Bridge", kind: "ability_multi", hotkey: "6" },
      { key: "swap_dna", label: "Swap", kind: "ability_multi", hotkey: "7" },
    ];
    for (let i = 0; i < abilities.length; i += 1) {
      slots[4 + i] = abilities[i];
    }
    return slots;
  }

  if (n === 3) {
    const abilities = [
      { key: "extract_rule", label: "Rule", kind: "ability_multi", hotkey: "5" },
      { key: "odd_one_out", label: "Odd", kind: "ability_multi", hotkey: "6" },
      { key: "triforce", label: "Tri", kind: "ability_multi", hotkey: "7" },
    ];
    for (let i = 0; i < abilities.length; i += 1) {
      slots[4 + i] = abilities[i];
    }
    return slots;
  }

  // 4+ selected: only keep the base tools visible.
  return slots;
}
