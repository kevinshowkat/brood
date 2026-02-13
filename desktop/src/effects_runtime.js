import { Application, Container, Graphics } from "pixi.js";

import { getEffectSpec, normalizeEffectType } from "./effect_specs.js";
import { EFFECT_TOKEN_LIFECYCLE } from "./effect_interactions.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
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

function hasSceneWork(scene) {
  if (!scene) return false;
  if (Array.isArray(scene.extracting) && scene.extracting.length) return true;
  if (Array.isArray(scene.tokens) && scene.tokens.length) return true;
  if (scene.drag) return true;
  return false;
}

export function createEffectsRuntime({ canvas } = {}) {
  let app = null;
  let tickerAttached = false;
  let suspended = false;
  let viewport = { width: 1, height: 1, dpr: 1 };
  let scene = { extracting: [], tokens: [], drag: null };
  let tokenHitZones = [];
  let dropAnimation = null;

  const extractionLayer = new Container();
  const tokenLayer = new Container();
  const dragLayer = new Container();

  const extractionNodes = new Map();
  const tokenNodes = new Map();
  const dragTokenGfx = new Graphics();
  const dragTargetGfx = new Graphics();
  const dropAnimGfx = new Graphics();

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
    scene = { extracting: [], tokens: [], drag: null };
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
