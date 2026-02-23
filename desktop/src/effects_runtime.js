import { Application, Container, Graphics } from "pixi.js";

import { getEffectSpec, normalizeEffectType } from "./effect_specs.js";
import { EFFECT_TOKEN_LIFECYCLE } from "./effect_interactions.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function rand01(seed) {
  const n = Number(seed) || 0;
  const hashed = Math.sin(n * 12.9898 + 78.233) * 43758.5453123;
  return hashed - Math.floor(hashed);
}

function easeInCubic(t) {
  const x = clamp(Number(t) || 0, 0, 1);
  return x * x * x;
}

function easeOutCubic(t) {
  const x = clamp(Number(t) || 0, 0, 1);
  return 1 - (1 - x) * (1 - x) * (1 - x);
}

function normalizeRect(rect) {
  const x = Number(rect?.x);
  const y = Number(rect?.y);
  const w = Number(rect?.w);
  const h = Number(rect?.h);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function roundedRect(gfx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(Math.min(w, h) * 0.5, Number(r) || 0));
  gfx.drawRoundedRect(x, y, w, h, radius);
}

function hardRect(gfx, x, y, w, h) {
  gfx.drawRect(x, y, w, h);
}

function normalizeColorInt(value, fallback = 0xc8d8f2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(0, Math.min(0xffffff, Math.round(n)));
  return clamped;
}

const MOTHER_SIPHON_PARTICLE_CAP = 168;
const MOTHER_SIPHON_PER_SOURCE_MAX = 52;

function hasSceneWork(scene) {
  if (!scene) return false;
  if (Array.isArray(scene.extracting) && scene.extracting.length) return true;
  if (Array.isArray(scene.tokens) && scene.tokens.length) return true;
  if (scene.drag) return true;
  const motherDrafting = scene.motherDrafting;
  if (motherDrafting?.targetRect && Array.isArray(motherDrafting.sources) && motherDrafting.sources.length) return true;
  return false;
}

export function createEffectsRuntime({ canvas } = {}) {
  let app = null;
  let tickerAttached = false;
  let suspended = false;
  let viewport = { width: 1, height: 1, dpr: 1 };
  let scene = { extracting: [], tokens: [], drag: null, motherDrafting: null };
  let tokenHitZones = [];
  let dropAnimation = null;

  const extractionLayer = new Container();
  const motherDraftingLayer = new Container();
  const tokenLayer = new Container();
  const dragLayer = new Container();

  const extractionNodes = new Map();
  const tokenNodes = new Map();
  const dragTokenGfx = new Graphics();
  const dragTargetGfx = new Graphics();
  const dropAnimGfx = new Graphics();
  const motherDraftingGfx = new Graphics();

  motherDraftingLayer.addChild(motherDraftingGfx);
  dragLayer.addChild(dragTargetGfx);
  dragLayer.addChild(dragTokenGfx);
  dragLayer.addChild(dropAnimGfx);

  function ensureApp() {
    if (app || !canvas) return Boolean(app);
    app = new Application({
      view: canvas,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: false,
      resolution: 1,
    });
    app.stage.addChild(extractionLayer);
    app.stage.addChild(motherDraftingLayer);
    app.stage.addChild(tokenLayer);
    app.stage.addChild(dragLayer);
    return true;
  }

  function shouldTick() {
    if (!app || suspended) return false;
    if (dropAnimation) return true;
    return hasSceneWork(scene);
  }

  function stopTicker() {
    if (!app) return;
    app.ticker.stop();
  }

  function startTicker() {
    if (!app) return;
    if (!tickerAttached) {
      app.ticker.add(onTick);
      tickerAttached = true;
    }
    if (shouldTick()) app.ticker.start();
  }

  function ensureExtractionNode(key) {
    const nodeKey = String(key || "").trim();
    if (!nodeKey) return null;
    let node = extractionNodes.get(nodeKey);
    if (node) return node;
    const container = new Container();
    const mask = new Graphics();
    const gfx = new Graphics();
    gfx.mask = mask;
    container.addChild(gfx);
    container.addChild(mask);
    extractionLayer.addChild(container);
    node = { key: nodeKey, container, mask, gfx };
    extractionNodes.set(nodeKey, node);
    return node;
  }

  function removeStaleExtractionNodes(liveKeys) {
    for (const [key, node] of extractionNodes.entries()) {
      if (liveKeys.has(key)) continue;
      extractionLayer.removeChild(node.container);
      node.gfx.destroy();
      node.mask.destroy();
      node.container.destroy();
      extractionNodes.delete(key);
    }
  }

  function ensureTokenNode(tokenId) {
    const id = String(tokenId || "").trim();
    if (!id) return null;
    let node = tokenNodes.get(id);
    if (node) return node;
    const container = new Container();
    const gfx = new Graphics();
    container.addChild(gfx);
    tokenLayer.addChild(container);
    node = { id, container, gfx };
    tokenNodes.set(id, node);
    return node;
  }

  function removeStaleTokenNodes(liveIds) {
    for (const [id, node] of tokenNodes.entries()) {
      if (liveIds.has(id)) continue;
      tokenLayer.removeChild(node.container);
      node.gfx.destroy();
      node.container.destroy();
      tokenNodes.delete(id);
    }
  }

  function drawExtraction(nowMs) {
    const live = new Set();
    for (const entry of scene.extracting || []) {
      const rect = normalizeRect(entry?.rect);
      const imageId = String(entry?.imageId || "").trim();
      const effectType = normalizeEffectType(entry?.effectType);
      if (!rect || !imageId) continue;
      const key = `${effectType}:${imageId}`;
      const node = ensureExtractionNode(key);
      if (!node) continue;
      live.add(key);
      node.container.position.set(rect.x, rect.y);
      node.mask.clear();
      node.mask.beginFill(0xffffff, 1);
      hardRect(node.mask, 0, 0, rect.w, rect.h);
      node.mask.endFill();
      const spec = getEffectSpec(effectType);
      spec.drawExtraction(node.gfx, { x: 0, y: 0, w: rect.w, h: rect.h }, nowMs, {
        imageId,
        effectType,
      });
    }
    removeStaleExtractionNodes(live);
  }

  function drawStaticTokens(nowMs) {
    tokenHitZones = [];
    const live = new Set();
    for (const token of scene.tokens || []) {
      const tokenId = String(token?.tokenId || "").trim();
      const imageId = String(token?.imageId || "").trim();
      const effectType = normalizeEffectType(token?.effectType);
      const lifecycle = String(token?.lifecycle || "");
      const rect = normalizeRect(token?.rect);
      if (!tokenId || !imageId || !rect) continue;

      const node = ensureTokenNode(tokenId);
      if (!node) continue;
      live.add(tokenId);

      const hiddenByDrag = scene.drag && String(scene.drag.tokenId || "") === tokenId;
      const hiddenByDropAnimation = dropAnimation && String(dropAnimation.tokenId || "") === tokenId;
      const visible = !hiddenByDrag && !hiddenByDropAnimation && (
        lifecycle === EFFECT_TOKEN_LIFECYCLE.READY ||
        lifecycle === EFFECT_TOKEN_LIFECYCLE.APPLYING
      );
      node.container.visible = visible;
      if (!visible) {
        node.gfx.clear();
        continue;
      }

      const cx = rect.x + rect.w * 0.5;
      const cy = rect.y + rect.h * 0.5;
      const baseSize = clamp(Math.min(rect.w, rect.h) * 0.35, 40, 116);
      const size = effectType === "extract_dna" ? clamp(baseSize * 1.75, 70, 203) : baseSize;
      const spec = getEffectSpec(effectType);
      spec.drawToken(node.gfx, {
        size,
        nowMs,
        data: token,
        alpha: lifecycle === EFFECT_TOKEN_LIFECYCLE.APPLYING ? 0.68 : 1,
      });
      const sway = Math.sin(nowMs * 0.0012 + tokenId.length * 0.17);
      node.container.position.set(cx, cy);
      node.container.rotation = -0.14 + sway * 0.05;
      node.container.scale.set(1 + sway * 0.07, 1 + Math.cos(nowMs * 0.0009 + tokenId.length) * 0.04);
      if (lifecycle === EFFECT_TOKEN_LIFECYCLE.READY) {
        tokenHitZones.push({
          tokenId,
          imageId,
          effectType,
          x: cx,
          y: cy,
          radius: Math.max(14, size * 0.54),
        });
      }
    }
    removeStaleTokenNodes(live);
  }

  function drawDragPreview(nowMs) {
    dragTokenGfx.clear();
    dragTargetGfx.clear();

    const drag = scene.drag;
    if (!drag) return;
    if (dropAnimation && String(dropAnimation.tokenId || "") === String(drag.tokenId || "")) return;

    const x = Number(drag.x) || 0;
    const y = Number(drag.y) || 0;
    const effectType = normalizeEffectType(drag.effectType);
    const defaultSize = effectType === "extract_dna" ? 130 : 74;
    const size = clamp(Number(drag.size) || defaultSize, 40, 220);
    const spec = getEffectSpec(effectType);
    spec.drawToken(dragTokenGfx, {
      size,
      nowMs,
      data: drag.data || null,
      alpha: 0.96,
    });
    dragTokenGfx.position.set(x, y);
    dragTokenGfx.rotation = -0.2;
    dragTokenGfx.scale.set(1.04, 1.04);

    const targetRect = normalizeRect(drag.targetRect);
    if (!targetRect) return;
    const pulse = 0.55 + 0.45 * Math.sin(nowMs * 0.01);
    const glow = effectType === "soul_leech" ? 0xff90cf : 0x52ff94;
    dragTargetGfx.lineStyle(Math.max(1, targetRect.w * 0.01), glow, 0.42 + pulse * 0.28);
    roundedRect(
      dragTargetGfx,
      targetRect.x - 4,
      targetRect.y - 4,
      targetRect.w + 8,
      targetRect.h + 8,
      Math.max(10, Math.min(targetRect.w, targetRect.h) * 0.08)
    );
  }

  function drawMotherDraftingSiphon(nowMs) {
    motherDraftingGfx.clear();
    const drafting = scene.motherDrafting;
    if (!drafting || typeof drafting !== "object") return;
    const targetRect = normalizeRect(drafting.targetRect);
    if (!targetRect) return;
    const rawSources = Array.isArray(drafting.sources) ? drafting.sources : [];
    if (!rawSources.length) return;

    const uncertainty = drafting.uncertainty && typeof drafting.uncertainty === "object" ? drafting.uncertainty : {};
    const elapsedMs = Math.max(0, Number(uncertainty.elapsedMs) || 0);
    const lowMs = Math.max(1_000, Number(uncertainty.lowMs) || 18_000);
    const highMs = Math.max(lowMs + 1_000, Number(uncertainty.highMs) || 42_000);
    const takingLongerThanUsual = Boolean(uncertainty.takingLongerThanUsual) || elapsedMs > highMs;
    const uncertaintySpan = Math.max(1_000, highMs - lowMs);
    const phase = nowMs * 0.001;
    const seed = Number(drafting.seed) || 1;
    const progressNorm = clamp((elapsedMs - lowMs) / uncertaintySpan, -0.6, 1.8);
    const entropy = takingLongerThanUsual ? 1.35 : 1;
    const pulse = 0.5 + 0.5 * Math.sin(phase * 2.2 + seed * 0.0009);
    const visibilityGain = takingLongerThanUsual ? 1.34 : 1.22;

    const liveSources = [];
    for (const source of rawSources) {
      const rect = normalizeRect(source?.rect);
      if (!rect) continue;
      const keypoints = Array.isArray(source?.keypoints) ? source.keypoints : [];
      liveSources.push({
        imageId: String(source?.imageId || ""),
        rect,
        keypoints,
      });
    }
    if (!liveSources.length) return;

    const perSourceCap = clamp(
      Math.floor(MOTHER_SIPHON_PARTICLE_CAP / Math.max(1, liveSources.length)),
      12,
      MOTHER_SIPHON_PER_SOURCE_MAX
    );

    for (let s = 0; s < liveSources.length; s += 1) {
      const source = liveSources[s];
      const rect = source.rect;
      const sourceSeed = seed + (s + 1) * 97;
      const keypoints = source.keypoints.length
        ? source.keypoints
        : [{ x: 0.5, y: 0.5, weight: 0.55, color: 0xc7d9f5 }];
      const emission = clamp(
        0.76 + progressNorm * 0.1 + Math.sin(phase * 1.8 + sourceSeed * 0.004) * 0.08 + (takingLongerThanUsual ? 0.16 : 0),
        0.68,
        1.5
      );
      const particleCount = clamp(Math.round(keypoints.length * (2.4 + emission * 1.2)), 14, perSourceCap);
      const laneGridCols = clamp(Math.round(Math.sqrt(particleCount)), 4, 10);
      const laneGridRows = clamp(Math.ceil(particleCount / laneGridCols), 4, 12);
      const laneSlots = laneGridCols * laneGridRows;

      const guideCount = Math.min(3, keypoints.length);
      for (let g = 0; g < guideCount; g += 1) {
        const keypoint = keypoints[g];
        const kx = clamp(Number(keypoint?.x) || 0.5, 0, 1);
        const ky = clamp(Number(keypoint?.y) || 0.5, 0, 1);
        const sx = rect.x + kx * rect.w;
        const sy = rect.y + ky * rect.h;
        const guideSeed = sourceSeed + (g + 1) * 41 + (Number(keypoint?.weight) || 0) * 113;
        const guideSlot = (g * 5 + s * 7 + Math.floor(rand01(guideSeed * 0.071 + seed * 0.01) * 13)) % 16;
        const guideCol = guideSlot % 4;
        const guideRow = Math.floor(guideSlot / 4);
        const stratNormX = (guideCol + 0.2 + rand01(guideSeed * 0.029 + seed * 0.0012) * 0.6) / 4;
        const stratNormY = (guideRow + 0.2 + rand01(guideSeed * 0.037 + seed * 0.0017 + 0.19) * 0.6) / 4;
        const randomNormX = 0.08 + rand01(guideSeed * 0.019 + seed * 0.002) * 0.84;
        const randomNormY = 0.08 + rand01(guideSeed * 0.023 + seed * 0.004 + 0.31) * 0.84;
        const strategicNormX = lerp(kx, stratNormX, takingLongerThanUsual ? 0.72 : 0.64);
        const strategicNormY = lerp(ky, stratNormY, takingLongerThanUsual ? 0.72 : 0.64);
        const guideSpreadMix = takingLongerThanUsual ? 0.68 : 0.56;
        const targetNormX = clamp(lerp(strategicNormX, randomNormX, guideSpreadMix * 0.58), 0.06, 0.94);
        const targetNormY = clamp(lerp(strategicNormY, randomNormY, guideSpreadMix * 0.58), 0.06, 0.94);
        const tx = targetRect.x + targetNormX * targetRect.w;
        const ty = targetRect.y + targetNormY * targetRect.h;
        const dx = tx - sx;
        const dy = ty - sy;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const nx = dx / dist;
        const ny = dy / dist;
        const px = -ny;
        const py = nx;
        const arcMag = dist * (0.16 + 0.08 * ((g + 1) / (guideCount + 1))) * entropy;
        const curveSign = (g % 2 === 0 ? 1 : -1) * (s % 2 === 0 ? 1 : -1);
        const cx = lerp(sx, tx, 0.47) + px * arcMag * curveSign;
        const cy = lerp(sy, ty, 0.47) + py * arcMag * curveSign;
        const guideColor = normalizeColorInt(keypoint?.color, takingLongerThanUsual ? 0xffc18e : 0xc8daf6);
        const guideAlpha = (takingLongerThanUsual ? 0.24 : 0.18) * visibilityGain * (0.84 + pulse * 0.16);
        motherDraftingGfx.lineStyle(2.2, guideColor, guideAlpha);
        motherDraftingGfx.moveTo(sx, sy);
        motherDraftingGfx.quadraticCurveTo(cx, cy, tx, ty);
        motherDraftingGfx.lineStyle(1.1, 0xf0f5ff, guideAlpha * 0.34);
        motherDraftingGfx.moveTo(sx, sy);
        motherDraftingGfx.quadraticCurveTo(cx, cy, tx, ty);
      }

      for (let i = 0; i < particleCount; i += 1) {
        const keypoint = keypoints[i % keypoints.length] || keypoints[0];
        const kx = clamp(Number(keypoint?.x) || 0.5, 0, 1);
        const ky = clamp(Number(keypoint?.y) || 0.5, 0, 1);
        const sx = rect.x + kx * rect.w;
        const sy = rect.y + ky * rect.h;
        const laneSeed = sourceSeed + (i + 1) * 37 + (Number(keypoint?.weight) || 0) * 190;
        const laneSlot = (i * 7 + s * 11 + Math.floor(rand01(laneSeed * 0.071 + seed * 0.003) * laneSlots)) % laneSlots;
        const laneCol = laneSlot % laneGridCols;
        const laneRow = Math.floor(laneSlot / laneGridCols);
        const stratNormX = (laneCol + 0.17 + rand01(laneSeed * 0.033 + seed * 0.0011 + 0.13) * 0.66) / laneGridCols;
        const stratNormY = (laneRow + 0.17 + rand01(laneSeed * 0.039 + seed * 0.0015 + 0.47) * 0.66) / laneGridRows;
        const randomNormX = 0.08 + rand01(laneSeed * 0.017 + seed * 0.0013) * 0.84;
        const randomNormY = 0.08 + rand01(laneSeed * 0.021 + seed * 0.0021 + 0.51) * 0.84;
        const strategicNormX = lerp(kx, stratNormX, takingLongerThanUsual ? 0.74 : 0.66);
        const strategicNormY = lerp(ky, stratNormY, takingLongerThanUsual ? 0.74 : 0.66);
        const spreadMix = clamp(0.24 + Math.max(0, progressNorm) * 0.1 + (takingLongerThanUsual ? 0.1 : 0), 0.18, 0.5);
        const targetNormX = clamp(lerp(strategicNormX, randomNormX, spreadMix), 0.06, 0.94);
        const targetNormY = clamp(lerp(strategicNormY, randomNormY, spreadMix), 0.06, 0.94);
        const tx = targetRect.x + targetNormX * targetRect.w;
        const ty = targetRect.y + targetNormY * targetRect.h;
        const dx = tx - sx;
        const dy = ty - sy;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const nx = dx / dist;
        const ny = dy / dist;
        const px = -ny;
        const py = nx;
        const speed = (0.22 + Math.abs(Math.sin(laneSeed * 0.017)) * 0.28) * (takingLongerThanUsual ? 1.08 : 1);
        const phaseOffset = Math.abs(Math.sin(laneSeed * 0.031)) * 2.8;
        const t = (phase * speed + phaseOffset) % 1;
        const jitterMag = (takingLongerThanUsual ? 2.8 : 1.5) * (0.75 + Math.abs(Math.sin(phase * 2.2 + laneSeed * 0.01)));
        const arcMag = dist * (0.17 + Math.abs(Math.sin(laneSeed * 0.013)) * 0.17) * entropy;
        const curveSign = (i % 2 === 0 ? 1 : -1) * (s % 2 === 0 ? 1 : -1);
        const jitter = Math.sin(phase * 3 + laneSeed * 0.009) * jitterMag;
        const cx = lerp(sx, tx, 0.46) + px * arcMag * curveSign + nx * jitter;
        const cy = lerp(sy, ty, 0.46) + py * arcMag * curveSign + py * jitter * 0.58;
        const invT = 1 - t;
        const pxPos = invT * invT * sx + 2 * invT * t * cx + t * t * tx;
        const pyPos = invT * invT * sy + 2 * invT * t * cy + t * t * ty;
        const weight = clamp(Number(keypoint?.weight) || 0.55, 0.08, 1);
        let alpha = (0.34 + weight * 0.6) * (0.66 + 0.34 * Math.sin(t * Math.PI));
        if (takingLongerThanUsual) alpha *= 1.1;
        const sourceFade = clamp((t - 0.08) / 0.26, 0, 1);
        alpha *= 0.6 + sourceFade * 0.4;
        alpha = clamp(alpha, 0.14, 0.94);
        const radius = clamp(1 + weight * 1.9 + (t > 0.86 ? (t - 0.86) * 6.2 : 0), 1, 4.4);
        const color = normalizeColorInt(keypoint?.color, takingLongerThanUsual ? 0xffc18e : 0xc8daf6);
        const trailT = clamp(t - (0.08 + 0.06 * (1 - weight)), 0, 1);
        const trailInvT = 1 - trailT;
        const trailX = trailInvT * trailInvT * sx + 2 * trailInvT * trailT * cx + trailT * trailT * tx;
        const trailY = trailInvT * trailInvT * sy + 2 * trailInvT * trailT * cy + trailT * trailT * ty;
        if (i % 2 === 0) {
          motherDraftingGfx.lineStyle(Math.max(1, radius * 0.56), color, alpha * 0.34);
          motherDraftingGfx.moveTo(trailX, trailY);
          motherDraftingGfx.lineTo(pxPos, pyPos);
        }
        motherDraftingGfx.beginFill(color, alpha * 0.34);
        motherDraftingGfx.drawCircle(pxPos, pyPos, radius * (1.52 + weight * 0.16));
        motherDraftingGfx.endFill();
        motherDraftingGfx.beginFill(color, alpha);
        motherDraftingGfx.drawCircle(pxPos, pyPos, radius);
        motherDraftingGfx.endFill();
      }
    }
  }

  function drawDropAnimation(nowMs) {
    dropAnimGfx.clear();
    const anim = dropAnimation;
    if (!anim) return;

    const targetRect = normalizeRect(anim.targetRect);
    if (!targetRect) {
      const resolve = anim.resolve;
      dropAnimation = null;
      if (typeof resolve === "function") resolve();
      return;
    }

    const elapsed = Math.max(0, nowMs - anim.startedAt);
    const t = clamp(elapsed / Math.max(1, anim.durationMs), 0, 1);
    const easing = anim.kind === "cancel" ? easeOutCubic(t) : easeInCubic(t);
    const tx = targetRect.x + targetRect.w * 0.5;
    const ty = targetRect.y + targetRect.h * 0.5;
    const x = lerp(anim.fromX, tx, easing);
    const y = lerp(anim.fromY, ty, easing);
    const scale = anim.kind === "cancel" ? 1 - Math.sin(t * Math.PI) * 0.16 : 1 - easing * 0.86;
    const alpha = anim.kind === "cancel" ? 0.9 : 1 - easing * 0.9;
    const ringColor = anim.effectType === "soul_leech" ? 0xff92d0 : 0x74f0ff;

    dropAnimGfx.lineStyle(Math.max(1, targetRect.w * 0.008), ringColor, 0.24 + (1 - t) * 0.34);
    roundedRect(
      dropAnimGfx,
      targetRect.x - 5,
      targetRect.y - 5,
      targetRect.w + 10,
      targetRect.h + 10,
      Math.max(10, Math.min(targetRect.w, targetRect.h) * 0.08)
    );
    dropAnimGfx.beginFill(ringColor, 0.08 + (1 - t) * 0.24);
    dropAnimGfx.drawCircle(tx, ty, Math.max(8, Math.min(targetRect.w, targetRect.h) * (0.1 + (1 - t) * 0.2)));
    dropAnimGfx.endFill();

    const spec = getEffectSpec(anim.effectType);
    spec.drawToken(dropAnimGfx, {
      size: anim.size * scale,
      nowMs,
      data: anim.data || null,
      alpha,
    });
    dropAnimGfx.position.set(x, y);
    dropAnimGfx.rotation = -0.16 + (1 - t) * 0.08;

    if (t >= 1) {
      const resolve = anim.resolve;
      dropAnimation = null;
      if (typeof resolve === "function") resolve();
    }
  }

  function resolveDropAnimation() {
    if (!dropAnimation) return;
    const resolve = dropAnimation.resolve;
    dropAnimation = null;
    if (typeof resolve === "function") resolve();
  }

  function clearVisuals() {
    for (const node of extractionNodes.values()) {
      node.gfx.clear();
      node.mask.clear();
    }
    motherDraftingGfx.clear();
    for (const node of tokenNodes.values()) {
      node.gfx.clear();
      node.container.visible = false;
    }
    dragTokenGfx.clear();
    dragTargetGfx.clear();
    dropAnimGfx.clear();
    tokenHitZones = [];
  }

  function presentNow() {
    if (!app) return;
    try {
      app.renderer.render(app.stage);
    } catch {
      // ignore
    }
  }

  function onTick() {
    if (!app || suspended) {
      stopTicker();
      return;
    }
    const nowMs = performance.now ? performance.now() : Date.now();
    drawExtraction(nowMs);
    drawMotherDraftingSiphon(nowMs);
    drawStaticTokens(nowMs);
    drawDragPreview(nowMs);
    drawDropAnimation(nowMs);
    if (!shouldTick()) {
      clearVisuals();
      presentNow();
      stopTicker();
    }
  }

  function resize({ width, height, dpr } = {}) {
    if (!ensureApp()) return;
    const nextWidth = Math.max(1, Math.round(Number(width) || viewport.width || 1));
    const nextHeight = Math.max(1, Math.round(Number(height) || viewport.height || 1));
    const nextDpr = clamp(Number(dpr) || viewport.dpr || 1, 1, 3);
    viewport = { width: nextWidth, height: nextHeight, dpr: nextDpr };
    app.renderer.resolution = 1;
    app.renderer.resize(nextWidth, nextHeight);
    if (!suspended) startTicker();
  }

  function syncScene(nextScene = {}) {
    if (!ensureApp()) return;
    scene = {
      extracting: Array.isArray(nextScene.extracting) ? nextScene.extracting : [],
      tokens: Array.isArray(nextScene.tokens) ? nextScene.tokens : [],
      drag: nextScene.drag || null,
      motherDrafting: nextScene.motherDrafting || null,
    };
    if (suspended) {
      resolveDropAnimation();
      clearVisuals();
      presentNow();
      stopTicker();
      return;
    }
    if (!shouldTick()) {
      clearVisuals();
      presentNow();
      stopTicker();
      return;
    }
    startTicker();
  }

  function setSuspended(nextSuspended) {
    suspended = Boolean(nextSuspended);
    if (!app) return;
    if (suspended) {
      resolveDropAnimation();
      stopTicker();
      clearVisuals();
      presentNow();
      return;
    }
    if (shouldTick()) startTicker();
  }

  function hitTestToken(point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (let i = tokenHitZones.length - 1; i >= 0; i -= 1) {
      const zone = tokenHitZones[i];
      const dx = x - zone.x;
      const dy = y - zone.y;
      if (dx * dx + dy * dy <= zone.radius * zone.radius) {
        return {
          tokenId: zone.tokenId,
          imageId: zone.imageId,
          effectType: zone.effectType,
        };
      }
    }
    return null;
  }

  function enqueueAnimation({
    kind = "apply",
    tokenId,
    effectType,
    fromX,
    fromY,
    targetRect,
    size = 74,
    durationMs = 320,
    data = null,
  } = {}) {
    if (!ensureApp()) return Promise.resolve();
    if (dropAnimation && typeof dropAnimation.resolve === "function") {
      dropAnimation.resolve();
    }
    return new Promise((resolve) => {
      dropAnimation = {
        kind: String(kind || "apply"),
        tokenId: String(tokenId || ""),
        effectType: normalizeEffectType(effectType),
        fromX: Number(fromX) || 0,
        fromY: Number(fromY) || 0,
        targetRect: normalizeRect(targetRect),
        size: clamp(Number(size) || 74, 24, 240),
        durationMs: Math.max(120, Number(durationMs) || 320),
        startedAt: performance.now ? performance.now() : Date.now(),
        data,
        resolve,
      };
      if (!suspended) startTicker();
    });
  }

  function playDropIntoTarget(payload = {}) {
    return enqueueAnimation({ ...payload, kind: "apply" });
  }

  function playCancelToSource(payload = {}) {
    return enqueueAnimation({ ...payload, kind: "cancel", durationMs: payload.durationMs || 220 });
  }

  function destroy() {
    resolveDropAnimation();
    tokenHitZones = [];
    scene = { extracting: [], tokens: [], drag: null, motherDrafting: null };
    if (!app) return;
    if (tickerAttached) {
      app.ticker.remove(onTick);
      tickerAttached = false;
    }
    app.destroy(true, { children: true });
    app = null;
  }

  return {
    resize,
    syncScene,
    setSuspended,
    hitTestToken,
    playDropIntoTarget,
    playCancelToSource,
    destroy,
  };
}
