export const EFFECT_TOKEN_LIFECYCLE = Object.freeze({
  EXTRACTING: "extracting",
  READY: "ready",
  DRAGGING: "dragging",
  DROP_PREVIEW: "drop_preview",
  APPLYING: "applying",
  CONSUMED: "consumed",
});

export function isValidEffectDrop(sourceImageId, targetImageId) {
  const source = String(sourceImageId || "").trim();
  const target = String(targetImageId || "").trim();
  return Boolean(source && target && source !== target);
}

export function createEffectTokenState({
  id,
  type,
  sourceImageId,
  sourceImagePath = "",
  palette = [],
  colors = [],
  materials = [],
  emotion = "",
  summary = "",
  source = null,
  model = null,
  createdAt = Date.now(),
} = {}) {
  const tokenId = String(id || "").trim();
  const tokenType = String(type || "").trim();
  const sourceId = String(sourceImageId || "").trim();
  if (!tokenId || !tokenType || !sourceId) return null;
  return {
    id: tokenId,
    type: tokenType,
    sourceImageId: sourceId,
    sourceImagePath: String(sourceImagePath || ""),
    palette: Array.isArray(palette) ? palette.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 8) : [],
    colors: Array.isArray(colors) ? colors.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 8) : [],
    materials: Array.isArray(materials)
      ? materials.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 8)
      : [],
    emotion: String(emotion || "").trim(),
    summary: String(summary || "").trim(),
    source: source ? String(source) : null,
    model: model ? String(model) : null,
    lifecycle: EFFECT_TOKEN_LIFECYCLE.READY,
    dragX: 0,
    dragY: 0,
    dropTargetImageId: "",
    applyTargetImageId: "",
    applyDispatchId: 0,
    applyStartedAt: 0,
    createdAt: Number(createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

export function transitionEffectTokenLifecycle(token, lifecycle) {
  if (!token || typeof token !== "object") return token || null;
  const next = String(lifecycle || "").trim();
  if (!next) return token;
  token.lifecycle = next;
  token.updatedAt = Date.now();
  return token;
}

export function beginEffectTokenDrag(token, { x = 0, y = 0 } = {}) {
  if (!token || typeof token !== "object") return null;
  const lifecycle = String(token.lifecycle || "");
  if (lifecycle === EFFECT_TOKEN_LIFECYCLE.APPLYING || lifecycle === EFFECT_TOKEN_LIFECYCLE.CONSUMED) {
    return null;
  }
  token.dragX = Number(x) || 0;
  token.dragY = Number(y) || 0;
  token.dropTargetImageId = "";
  transitionEffectTokenLifecycle(token, EFFECT_TOKEN_LIFECYCLE.DRAGGING);
  return token;
}

export function updateEffectTokenDrag(token, { x = 0, y = 0, targetImageId = "" } = {}) {
  if (!token || typeof token !== "object") return null;
  const lifecycle = String(token.lifecycle || "");
  if (lifecycle !== EFFECT_TOKEN_LIFECYCLE.DRAGGING && lifecycle !== EFFECT_TOKEN_LIFECYCLE.DROP_PREVIEW) {
    return null;
  }
  token.dragX = Number(x) || 0;
  token.dragY = Number(y) || 0;
  const sourceId = String(token.sourceImageId || "").trim();
  const targetId = String(targetImageId || "").trim();
  if (isValidEffectDrop(sourceId, targetId)) {
    token.dropTargetImageId = targetId;
    transitionEffectTokenLifecycle(token, EFFECT_TOKEN_LIFECYCLE.DROP_PREVIEW);
  } else {
    token.dropTargetImageId = "";
    transitionEffectTokenLifecycle(token, EFFECT_TOKEN_LIFECYCLE.DRAGGING);
  }
  return token;
}

export function cancelEffectTokenDrag(token) {
  if (!token || typeof token !== "object") return null;
  if (String(token.lifecycle || "") === EFFECT_TOKEN_LIFECYCLE.CONSUMED) return token;
  token.dropTargetImageId = "";
  transitionEffectTokenLifecycle(token, EFFECT_TOKEN_LIFECYCLE.READY);
  return token;
}

export function beginEffectTokenApply(token, targetImageId, nowMs = Date.now()) {
  if (!token || typeof token !== "object") return null;
  const targetId = String(targetImageId || "").trim();
  if (!isValidEffectDrop(token.sourceImageId, targetId)) return null;
  const lifecycle = String(token.lifecycle || "");
  if (lifecycle === EFFECT_TOKEN_LIFECYCLE.APPLYING || lifecycle === EFFECT_TOKEN_LIFECYCLE.CONSUMED) return null;
  const nextDispatch = Math.max(0, Number(token.applyDispatchId) || 0) + 1;
  token.applyDispatchId = nextDispatch;
  token.applyTargetImageId = targetId;
  token.applyStartedAt = Number(nowMs) || Date.now();
  token.dropTargetImageId = targetId;
  transitionEffectTokenLifecycle(token, EFFECT_TOKEN_LIFECYCLE.APPLYING);
  return nextDispatch;
}

export function recoverEffectTokenApply(token) {
  if (!token || typeof token !== "object") return null;
  if (String(token.lifecycle || "") === EFFECT_TOKEN_LIFECYCLE.CONSUMED) return token;
  token.applyTargetImageId = "";
  token.applyStartedAt = 0;
  token.dropTargetImageId = "";
  transitionEffectTokenLifecycle(token, EFFECT_TOKEN_LIFECYCLE.READY);
  return token;
}

export function consumeEffectToken(token) {
  if (!token || typeof token !== "object") return null;
  token.applyTargetImageId = "";
  token.applyStartedAt = 0;
  token.dropTargetImageId = "";
  transitionEffectTokenLifecycle(token, EFFECT_TOKEN_LIFECYCLE.CONSUMED);
  return token;
}

export function effectTokenCanDispatchApply(token, dispatchId, targetImageId) {
  if (!token || typeof token !== "object") return false;
  const expectedDispatchId = Math.max(0, Number(dispatchId) || 0);
  const tokenDispatchId = Math.max(0, Number(token.applyDispatchId) || 0);
  const targetId = String(targetImageId || "").trim();
  return (
    expectedDispatchId > 0 &&
    tokenDispatchId === expectedDispatchId &&
    String(token.lifecycle || "") === EFFECT_TOKEN_LIFECYCLE.APPLYING &&
    String(token.applyTargetImageId || "").trim() === targetId
  );
}

export function createPendingEffectExtractionState(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const sourceIds = [];
  const sourcePaths = [];
  const sourceSlots = [];
  for (const item of list) {
    const imageId = String(item?.id || "").trim();
    const path = String(item?.path || "").trim();
    if (!imageId || !path) continue;
    sourceIds.push(imageId);
    sourcePaths.push(path);
    sourceSlots.push({
      imageId,
      path,
      resolved: false,
    });
  }
  return {
    sourceIds,
    sourcePaths,
    sourceSlots,
    startedAt: Date.now(),
  };
}

export function consumePendingEffectSourceSlot(pending, imagePath, nowMs = Date.now()) {
  const path = String(imagePath || "").trim();
  if (!pending || typeof pending !== "object" || !path) {
    return { matchedImageId: null, unresolvedCount: 0 };
  }
  if (!Array.isArray(pending.sourceSlots) || !pending.sourceSlots.length) {
    const ids = Array.isArray(pending.sourceIds) ? pending.sourceIds : [];
    const paths = Array.isArray(pending.sourcePaths) ? pending.sourcePaths : [];
    pending.sourceSlots = paths.map((slotPath, idx) => ({
      imageId: String(ids[idx] || "").trim(),
      path: String(slotPath || "").trim(),
      resolved: false,
    }));
  }
  let matchedImageId = null;
  for (const slot of pending.sourceSlots) {
    if (!slot || slot.resolved) continue;
    if (String(slot.path || "").trim() !== path) continue;
    slot.resolved = true;
    slot.resolvedAt = Number(nowMs) || Date.now();
    matchedImageId = String(slot.imageId || "").trim() || null;
    break;
  }
  const unresolvedCount = pending.sourceSlots.filter((slot) => slot && !slot.resolved).length;
  return { matchedImageId, unresolvedCount };
}
