const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hash32(input) {
  const str = String(input || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rand01(seed) {
  const x = Math.sin(Number(seed) * 12.9898 + 78.233) * 43758.5453123;
  return x - Math.floor(x);
}

function roundedRect(gfx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(Math.min(w, h) * 0.5, Number(r) || 0));
  gfx.drawRoundedRect(x, y, w, h, radius);
}

function drawDnaToken(gfx, { size, nowMs, data, alpha = 1 } = {}) {
  gfx.clear();
  const s = Math.max(24, Number(size) || 64);
  const t = (Number(nowMs) || Date.now()) * 0.001;
  const palette = Array.isArray(data?.palette) && data.palette.length
    ? data.palette.slice(0, 6)
    : ["#74f0ff", "#9bb8ff", "#b9ffcb", "#ffd57c"];
  const h = s * 1.2;
  const amp = s * 0.28;
  const top = -h * 0.5;
  const steps = 20;
  const spin = t * 1.65;

  gfx.lineStyle(Math.max(1, s * 0.03), 0xd6efff, 0.36 * alpha);
  gfx.moveTo(0, top);
  gfx.lineTo(0, top + h);

  for (let i = 0; i <= steps; i += 1) {
    const n = i / Math.max(1, steps);
    const y = top + h * n;
    const phase = spin + n * TAU * 2.7;
    const xA = Math.sin(phase) * amp;
    const xB = -xA;
    const depth = (Math.cos(phase) + 1) * 0.5;
    const colorA = Number.parseInt(String(palette[i % palette.length] || "#74f0ff").replace("#", ""), 16) || 0x74f0ff;
    const colorB =
      Number.parseInt(String(palette[(i + 1) % palette.length] || "#9bb8ff").replace("#", ""), 16) || 0x9bb8ff;

    gfx.lineStyle(Math.max(1, s * 0.014), 0xd4edff, (0.14 + depth * 0.28) * alpha);
    gfx.moveTo(xA, y);
    gfx.lineTo(xB, y + h / steps);

    gfx.beginFill(colorA, (0.38 + depth * 0.54) * alpha);
    gfx.drawCircle(xA, y, s * (0.03 + depth * 0.017));
    gfx.endFill();

    gfx.beginFill(colorB, (0.24 + (1 - depth) * 0.54) * alpha);
    gfx.drawCircle(xB, y, s * (0.03 + (1 - depth) * 0.017));
    gfx.endFill();
  }

}

function drawSoulToken(gfx, { size, nowMs, alpha = 1 } = {}) {
  gfx.clear();
  const s = Math.max(24, Number(size) || 64);
  const t = (Number(nowMs) || Date.now()) * 0.001;
  const sway = Math.sin(t * 1.1) * s * 0.02;

  gfx.beginFill(0xff9cd0, 0.22 * alpha);
  gfx.drawCircle(sway, -s * 0.04, s * 0.62);
  gfx.endFill();

  gfx.lineStyle(Math.max(1, s * 0.02), 0xffb9de, 0.62 * alpha);
  gfx.beginFill(0xff94c8, 0.7 * alpha);
  gfx.moveTo(-s * 0.38, -s * 0.08);
  gfx.quadraticCurveTo(0, -s * 0.66, s * 0.38, -s * 0.08);
  gfx.lineTo(s * 0.29, s * 0.3);
  gfx.quadraticCurveTo(0, s * 0.54, -s * 0.29, s * 0.3);
  gfx.closePath();
  gfx.endFill();

  gfx.beginFill(0x220f1b, 0.9 * alpha);
  gfx.drawCircle(-s * 0.12, -s * 0.05, s * 0.055);
  gfx.drawCircle(s * 0.12, -s * 0.05, s * 0.055);
  gfx.endFill();

  gfx.lineStyle(Math.max(1, s * 0.015), 0x24111c, 0.86 * alpha);
  gfx.arc(0, s * 0.07, s * 0.18, 0.1 * Math.PI, 0.9 * Math.PI);
}

function drawExtractionSwarm(gfx, rect, nowMs, { seedBase, soul = false } = {}) {
  gfx.clear();
  const w = Math.max(1, Number(rect?.w) || 1);
  const h = Math.max(1, Number(rect?.h) || 1);
  const t = (Number(nowMs) || Date.now()) * 0.001;
  const seed = hash32(seedBase || "fx");

  const hazeColor = soul ? 0x2b1024 : 0x0b1a2c;
  const flashColor = soul ? 0xff94ce : 0x7edbff;
  const moteColor = soul ? 0xffc7e7 : 0xd0eeff;

  const rounds = 4;
  for (let i = 0; i < rounds; i += 1) {
    const pulse = 0.5 + 0.5 * Math.sin(t * (1.2 + i * 0.23) + rand01(seed + i * 3.1) * TAU);
    gfx.lineStyle(Math.max(1, (2.4 - i * 0.4) * (w + h) * 0.0014), flashColor, 0.1 + pulse * 0.2);
    roundedRect(gfx, i * 3, i * 3, Math.max(1, w - i * 6), Math.max(1, h - i * 6), 0);
  }

  gfx.beginFill(hazeColor, soul ? 0.54 : 0.5);
  roundedRect(gfx, 0, 0, w, h, 0);
  gfx.endFill();

  const centerX = w * (0.5 + 0.08 * Math.sin(t * 0.6 + rand01(seed + 7.2) * TAU));
  const centerY = h * (0.5 + 0.07 * Math.cos(t * 0.55 + rand01(seed + 9.8) * TAU));
  const swarmCount = clamp(Math.round((w * h) / 1400), 130, 320);
  for (let i = 0; i < swarmCount; i += 1) {
    const p1 = rand01(seed + i * 1.37 + 0.4);
    const p2 = rand01(seed + i * 1.91 + 2.1);
    const p3 = rand01(seed + i * 2.67 + 4.4);
    const angle = t * (0.9 + p3 * 2.1) + p1 * TAU;
    const rx = w * (0.1 + p1 * 0.45);
    const ry = h * (0.1 + p2 * 0.45);
    const x = centerX + Math.cos(angle) * rx;
    const y = centerY + Math.sin(angle * (1.08 + p2 * 0.2)) * ry;
    const a = 0.2 + p3 * 0.56;
    const r = 0.8 + p3 * 2.5;
    gfx.beginFill(moteColor, a);
    gfx.drawCircle(x, y, r);
    gfx.endFill();
  }

  const streaks = clamp(Math.round((w + h) / 18), 24, 90);
  for (let i = 0; i < streaks; i += 1) {
    const p1 = rand01(seed + i * 3.17 + 1.1);
    const p2 = rand01(seed + i * 4.09 + 2.4);
    const p3 = rand01(seed + i * 5.23 + 6.6);
    const y = (p1 + t * (0.05 + p3 * 0.11)) % 1;
    const x0 = ((p2 + t * (0.07 + p1 * 0.12)) % 1) * w;
    const len = w * (0.04 + p3 * 0.08);
    gfx.lineStyle(Math.max(1, 0.6 + p3 * 1.3), flashColor, 0.08 + p3 * 0.14);
    gfx.moveTo(x0, y * h);
    gfx.lineTo(x0 + len, y * h);
  }
}

export const EFFECT_SPEC_REGISTRY = Object.freeze({
  extract_dna: Object.freeze({
    key: "extract_dna",
    tokenType: "extract_dna",
    drawToken(gfx, ctx) {
      drawDnaToken(gfx, ctx);
    },
    drawExtraction(gfx, rect, nowMs, ctx) {
      drawExtractionSwarm(gfx, rect, nowMs, { seedBase: `${ctx?.imageId || "dna"}:extract`, soul: false });
    },
  }),
  soul_leech: Object.freeze({
    key: "soul_leech",
    tokenType: "soul_leech",
    drawToken(gfx, ctx) {
      drawSoulToken(gfx, ctx);
    },
    drawExtraction(gfx, rect, nowMs, ctx) {
      drawExtractionSwarm(gfx, rect, nowMs, { seedBase: `${ctx?.imageId || "soul"}:extract`, soul: true });
    },
  }),
});

export function normalizeEffectType(effectType) {
  const key = String(effectType || "").trim();
  if (key === "soul_leech") return "soul_leech";
  return "extract_dna";
}

export function effectTypeFromTokenType(tokenType) {
  return normalizeEffectType(tokenType);
}

export function getEffectSpec(effectType) {
  const key = normalizeEffectType(effectType);
  return EFFECT_SPEC_REGISTRY[key] || EFFECT_SPEC_REGISTRY.extract_dna;
}
