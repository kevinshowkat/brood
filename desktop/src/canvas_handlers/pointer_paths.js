export const POINTER_KINDS = Object.freeze({
  FREEFORM_IMPORT: "freeform_import",
  FREEFORM_WHEEL: "freeform_wheel",
  MOTHER_ROLE_DRAG: "mother_role_drag",
  EFFECT_TOKEN_DRAG: "effect_token_drag",
  FREEFORM_RESIZE: "freeform_resize",
  FREEFORM_MOVE: "freeform_move",
  SINGLE_PAN: "single_pan",
});

export function isAnnotateOrLassoTool(tool) {
  const t = String(tool || "");
  return t === "annotate" || t === "lasso";
}

export function isMotherRolePath(kind) {
  return String(kind || "") === POINTER_KINDS.MOTHER_ROLE_DRAG;
}

export function isEffectTokenPath(kind) {
  return String(kind || "") === POINTER_KINDS.EFFECT_TOKEN_DRAG;
}

export function isPanPath(kind) {
  const k = String(kind || "");
  return k === POINTER_KINDS.FREEFORM_MOVE || k === POINTER_KINDS.FREEFORM_RESIZE || k === POINTER_KINDS.SINGLE_PAN;
}
