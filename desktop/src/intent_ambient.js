const AMBIENT_DEFAULT_OFFSETS = [
  [126, -102],
  [164, -30],
  [152, 44],
  [92, 118],
  [0, 146],
  [-94, 118],
  [-154, 42],
  [-166, -32],
  [-128, -104],
  [0, -144],
];

export const AMBIENT_INTENT_EDIT_REASONS = new Set([
  "add",
  "import",
  "remove",
  "move",
  "resize",
  "replace",
  "describe",
  "composition_change",
]);

function _num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _clamp(value, min, max) {
  if (min > max) return min;
  return Math.min(max, Math.max(min, value));
}

function _normalizeRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  const x = _num(rect.x, 0);
  const y = _num(rect.y, 0);
  const w = Math.max(1, _num(rect.w, 0));
  const h = Math.max(1, _num(rect.h, 0));
  return { x, y, w, h };
}

function _rectCenter(rect) {
  return {
    x: rect.x + rect.w * 0.5,
    y: rect.y + rect.h * 0.5,
  };
}

function _overlapArea(a, b, pad = 0) {
  const p = Math.max(0, _num(pad, 0));
  const ax0 = a.x - p;
  const ay0 = a.y - p;
  const ax1 = a.x + a.w + p;
  const ay1 = a.y + a.h + p;
  const bx0 = b.x - p;
  const by0 = b.y - p;
  const bx1 = b.x + b.w + p;
  const by1 = b.y + b.h + p;
  const w = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
  const h = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  return w * h;
}

function _hash32(input) {
  const text = String(input || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function _normalizeViewport(bounds) {
  const minX = _num(bounds?.minX, 0);
  const minY = _num(bounds?.minY, 0);
  const maxX = _num(bounds?.maxX, 2048);
  const maxY = _num(bounds?.maxY, 2048);
  if (maxX <= minX || maxY <= minY) {
    return { minX: 0, minY: 0, maxX: 2048, maxY: 2048 };
  }
  return { minX, minY, maxX, maxY };
}

function _normalizeRectsMap(imageRectsById) {
  const out = new Map();
  if (!imageRectsById) return out;

  if (imageRectsById instanceof Map) {
    for (const [id, rect] of imageRectsById.entries()) {
      const key = String(id || "").trim();
      const r = _normalizeRect(rect);
      if (!key || !r) continue;
      out.set(key, r);
    }
    return out;
  }

  if (typeof imageRectsById === "object") {
    for (const [id, rect] of Object.entries(imageRectsById)) {
      const key = String(id || "").trim();
      const r = _normalizeRect(rect);
      if (!key || !r) continue;
      out.set(key, r);
    }
  }
  return out;
}

function _centroidFromIds(ids, rectMap, fallback) {
  const keys = [];
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const rawId of ids || []) {
    const id = String(rawId || "").trim();
    if (!id) continue;
    const rect = rectMap.get(id);
    if (!rect) continue;
    const c = _rectCenter(rect);
    sx += c.x;
    sy += c.y;
    n += 1;
    keys.push(id);
  }
  if (!n) return { x: fallback.x, y: fallback.y, imageIds: [] };
  return { x: sx / n, y: sy / n, imageIds: keys };
}

function _distance(a, b) {
  const dx = _num(a?.x, 0) - _num(b?.x, 0);
  const dy = _num(a?.y, 0) - _num(b?.y, 0);
  return Math.hypot(dx, dy);
}

function _clampRectToViewport(rect, viewport, margin = 0) {
  const m = Math.max(0, _num(margin, 0));
  const minX = viewport.minX + m;
  const minY = viewport.minY + m;
  const maxX = viewport.maxX - m - rect.w;
  const maxY = viewport.maxY - m - rect.h;
  return {
    x: _clamp(rect.x, minX, maxX),
    y: _clamp(rect.y, minY, maxY),
    w: rect.w,
    h: rect.h,
  };
}

export function shouldScheduleAmbientIntent(reason) {
  const key = String(reason || "")
    .trim()
    .toLowerCase();
  return AMBIENT_INTENT_EDIT_REASONS.has(key);
}

export function placeAmbientSuggestions({
  branches = [],
  imageRectsById = null,
  touchedImageIds = [],
  viewportWorldBounds = null,
  maxSuggestions = 3,
  iconWorldSize = 72,
  collisionPadWorld = 14,
} = {}) {
  const viewport = _normalizeViewport(viewportWorldBounds);
  const rectMap = _normalizeRectsMap(imageRectsById);
  const rectIds = Array.from(rectMap.keys());
  const maxNudges = Math.max(0, Math.min(6, Math.floor(_num(maxSuggestions, 3))));
  if (!maxNudges) return [];

  const allCenters = rectIds.map((id) => _rectCenter(rectMap.get(id)));
  const fallbackCenter = allCenters.length
    ? {
        x: allCenters.reduce((acc, c) => acc + c.x, 0) / allCenters.length,
        y: allCenters.reduce((acc, c) => acc + c.y, 0) / allCenters.length,
      }
    : {
        x: (viewport.minX + viewport.maxX) * 0.5,
        y: (viewport.minY + viewport.maxY) * 0.5,
      };

  const sorted = (Array.isArray(branches) ? branches : [])
    .filter((b) => b && typeof b === "object")
    .filter((b) => String(b.asset_type || "icon") === "icon" && String(b.asset_key || "").trim())
    .map((b, idx) => {
      const confidence = Number.isFinite(Number(b.confidence)) ? _clamp(Number(b.confidence), 0, 1) : null;
      return {
        _idx: idx,
        branch_id: String(b.branch_id || "").trim() || `branch-${idx}`,
        asset_type: "icon",
        asset_key: String(b.asset_key || "").trim(),
        asset_src: b.asset_src ? String(b.asset_src) : null,
        confidence,
        evidence_image_ids: Array.isArray(b.evidence_image_ids)
          ? b.evidence_image_ids.map((v) => String(v || "").trim()).filter(Boolean)
          : [],
      };
    });

  sorted.sort((a, b) => {
    const ac = typeof a.confidence === "number" ? a.confidence : -1;
    const bc = typeof b.confidence === "number" ? b.confidence : -1;
    if (bc !== ac) return bc - ac;
    return a._idx - b._idx;
  });

  const picked = sorted.slice(0, maxNudges);
  const placedRects = [];
  const out = [];
  const size = Math.max(24, _num(iconWorldSize, 72));
  const offsets = AMBIENT_DEFAULT_OFFSETS.map(([x, y]) => [x * (size / 72), y * (size / 72)]);
  const collisionPad = Math.max(0, _num(collisionPadWorld, 14));
  const edgePad = Math.max(2, Math.round(size * 0.14));

  for (const branch of picked) {
    const touched = Array.isArray(touchedImageIds) ? touchedImageIds.map((v) => String(v || "").trim()).filter(Boolean) : [];
    const evidence = branch.evidence_image_ids.filter((id) => rectMap.has(id));
    const touchedExisting = touched.filter((id) => rectMap.has(id));
    const anchorIds = evidence.length ? evidence : touchedExisting.length ? touchedExisting : rectIds.slice(0, 3);
    const anchor = _centroidFromIds(anchorIds, rectMap, fallbackCenter);

    const start = _hash32(`${branch.branch_id}|${branch.asset_key}`) % offsets.length;
    let bestRect = null;
    let bestScore = Number.POSITIVE_INFINITY;
    const anchorSet = new Set(anchorIds);

    for (let i = 0; i < offsets.length; i += 1) {
      const [dx, dy] = offsets[(start + i) % offsets.length];
      const cand = _clampRectToViewport(
        {
          x: anchor.x + dx - size * 0.5,
          y: anchor.y + dy - size * 0.5,
          w: size,
          h: size,
        },
        viewport,
        edgePad
      );
      let score = 0;
      for (const placed of placedRects) {
        score += _overlapArea(cand, placed, collisionPad);
      }
      for (const [imageId, imageRect] of rectMap.entries()) {
        const overlap = _overlapArea(cand, imageRect, collisionPad);
        if (overlap <= 0) continue;
        score += overlap * (anchorSet.has(imageId) ? 7 : 3);
      }
      // Prefer closer candidates when overlap score ties, but keep overlap avoidance dominant.
      score += _distance(_rectCenter(cand), { x: anchor.x, y: anchor.y }) * 0.04;
      if (score < bestScore) {
        bestScore = score;
        bestRect = cand;
      }
      if (score <= 0) break;
    }

    if (!bestRect) {
      bestRect = _clampRectToViewport(
        {
          x: anchor.x - size * 0.5,
          y: anchor.y - size * 0.5,
          w: size,
          h: size,
        },
        viewport,
        edgePad
      );
    }

    placedRects.push(bestRect);
    out.push({
      id: `ambient:${branch.branch_id}:${branch.asset_key}`,
      branch_id: branch.branch_id,
      asset_type: branch.asset_type,
      asset_key: branch.asset_key,
      asset_src: branch.asset_src,
      confidence: branch.confidence,
      anchor: {
        kind: anchor.imageIds.length ? "image_cluster" : "viewport",
        image_ids: anchor.imageIds,
        world: { x: anchor.x, y: anchor.y },
      },
      world_rect: bestRect,
    });
  }

  return out;
}

export function mergeAmbientSuggestions(previous, next, { nowMs = Date.now() } = {}) {
  const now = _num(nowMs, Date.now());
  const prevMap = new Map();
  for (const item of Array.isArray(previous) ? previous : []) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    prevMap.set(id, item);
  }

  const out = [];
  for (const raw of Array.isArray(next) ? next : []) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "").trim();
    if (!id) continue;
    const prev = prevMap.get(id) || null;
    out.push({
      ...raw,
      created_at_ms: prev ? _num(prev.created_at_ms, now) : now,
      updated_at_ms: now,
    });
  }
  return out;
}
