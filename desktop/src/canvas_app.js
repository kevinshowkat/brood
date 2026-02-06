import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import {
  readDir,
  exists,
  readTextFile,
  readBinaryFile,
  writeTextFile,
  writeBinaryFile,
  createDir,
  copyFile,
} from "@tauri-apps/api/fs";

const THUMB_PLACEHOLDER_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

const els = {
  runInfo: document.getElementById("run-info"),
  engineStatus: document.getElementById("engine-status"),
  newRun: document.getElementById("new-run"),
  openRun: document.getElementById("open-run"),
  import: document.getElementById("import"),
  canvasImport: document.getElementById("canvas-import"),
  export: document.getElementById("export"),
  settingsToggle: document.getElementById("settings-toggle"),
  settingsDrawer: document.getElementById("settings-drawer"),
  settingsClose: document.getElementById("settings-close"),
  memoryToggle: document.getElementById("memory-toggle"),
  textModel: document.getElementById("text-model"),
  imageModel: document.getElementById("image-model"),
  keyStatus: document.getElementById("key-status"),
  canvasWrap: document.getElementById("canvas-wrap"),
  dropHint: document.getElementById("drop-hint"),
  workCanvas: document.getElementById("work-canvas"),
  imageFx: document.getElementById("image-fx"),
  overlayCanvas: document.getElementById("overlay-canvas"),
  hud: document.getElementById("hud"),
  hudUnitName: document.getElementById("hud-unit-name"),
  hudUnitDesc: document.getElementById("hud-unit-desc"),
  hudUnitSel: document.getElementById("hud-unit-sel"),
  hudUnitStat: document.getElementById("hud-unit-stat"),
  filmstrip: document.getElementById("filmstrip"),
  spawnbar: document.getElementById("spawnbar"),
  toast: document.getElementById("toast"),
  portraitDock: document.getElementById("portrait-dock"),
  agentSlotPrimary: document.getElementById("agent-slot-primary"),
  agentSlotSecondary: document.getElementById("agent-slot-secondary"),
  portraitTitle: document.getElementById("portrait-title"),
  portraitAvatar: document.getElementById("portrait-avatar"),
  portraitVideo: document.getElementById("portrait-video"),
  portraitTitle2: document.getElementById("portrait-title-2"),
  portraitAvatar2: document.getElementById("portrait-avatar-2"),
  portraitVideo2: document.getElementById("portrait-video-2"),
  selectionMeta: document.getElementById("selection-meta"),
  tipsText: document.getElementById("tips-text"),
  actionBgWhite: document.getElementById("action-bg-white"),
  actionBgSweep: document.getElementById("action-bg-sweep"),
  actionCropSquare: document.getElementById("action-crop-square"),
  actionVariations: document.getElementById("action-variations"),
  toolButtons: Array.from(document.querySelectorAll(".tool[data-tool]")),
};

const settings = {
  memory: localStorage.getItem("brood.memory") === "1",
  textModel: localStorage.getItem("brood.textModel") || "gpt-5.2",
  imageModel: localStorage.getItem("brood.imageModel") || "gemini-2.5-flash-image",
};

const state = {
  runDir: null,
  eventsPath: null,
  ptySpawned: false,
  poller: null,
  pollInFlight: false,
  eventsByteOffset: 0,
  eventsTail: "",
  images: [],
  imagesById: new Map(),
  activeId: null,
  imageCache: new Map(), // path -> { url: string|null, urlPromise: Promise<string>|null, imgPromise: Promise<HTMLImageElement>|null }
  thumbsById: new Map(), // artifactId -> { rootEl, imgEl, labelEl }
  canvasMode: "single", // "single" renders the active image; "multi" renders all images for pair actions (Combine demo).
  multiRects: new Map(), // imageId -> { x, y, w, h } in canvas device pixels (for hit-testing).
  pendingBlend: null, // { sourceIds: [string, string], startedAt: number }
  pendingGeneration: null, // { remaining: number, provider: string|null, model: string|null }
  view: {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  },
  tool: "pan",
  pointer: {
    active: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
  },
  selection: null, // { points: [{x,y}], closed: true }
  lassoDraft: [],
  needsRender: false,
  lastInteractionAt: Date.now(),
  spawnNodes: [],
  spawnTimer: null,
  larvaTargets: [], // { turbEl, dispEl, seed }
  larvaUid: 0,
  spawnCooldowns: new Map(), // `${imageId}::${nodeId}` -> untilMs
  describePendingPath: null,
  expectingArtifacts: false,
  pendingReplace: null, // { targetId, startedAt, label }
  lastRecreatePrompt: null,
  lastAction: null,
  lastCostLatency: null, // { provider, model, cost_total_usd, cost_per_1k_images_usd, latency_per_image_s, at }
  fallbackToFullRead: false,
  keyStatus: null, // { openai, gemini, imagen, flux, anthropic }
  imageFx: {
    active: false,
    label: null,
  },
  portrait: {
    provider: null,
    title: "",
    busy: false,
  },
  portrait2: {
    provider: null,
    title: "",
    busy: false,
  },
  portraitMedia: {
    dir: null, // string|null
    dirChecked: false,
    dirPromise: null, // Promise<string|null>|null
    index: null, // { [agent: string]: { idle: string|null, working: string|null } }|null
    indexChecked: false,
    indexPromise: null, // Promise<object>|null
    activeKey1: null,
    activeKey2: null,
  },
};

const DEFAULT_TIP = "Click Studio White to replace the background. Use L to lasso if you want a manual mask.";

function formatUsd(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 1) return `${value.toFixed(2)}s`;
  if (value < 10) return `${value.toFixed(1)}s`;
  return `${Math.round(value)}s`;
}

function clampText(text, maxLen) {
  const s = String(text || "").trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

function renderHudReadout() {
  if (!els.hud) return;
  const img = getActiveImage();
  const hasImage = Boolean(img);
  els.hud.classList.toggle("hidden", !hasImage);
  if (!hasImage) return;

  const name = basename(img.path) || "Untitled";
  const dims = img?.width && img?.height ? ` (${img.width}x${img.height})` : "";
  if (els.hudUnitName) els.hudUnitName.textContent = `${name}${dims}`;

  let desc = "";
  if (img?.visionDesc) {
    desc = clampText(img.visionDesc, 32);
  } else if (img?.visionPending) {
    desc = "SCANNING…";
  } else {
    const allowVision = state.keyStatus ? Boolean(state.keyStatus.openai || state.keyStatus.gemini) : true;
    desc = allowVision ? "—" : "NO VISION KEYS";
  }
  if (els.hudUnitDesc) els.hudUnitDesc.textContent = desc || "—";

  const sel = state.selection?.points?.length >= 3 ? `${state.selection.points.length} pts` : "none";
  const zoomPct = Math.round((state.view.scale || 1) * 100);
  if (els.hudUnitSel) els.hudUnitSel.textContent = `${sel} · ${state.tool} · ${zoomPct}%`;

  const model = settings.imageModel || "unknown";
  const action = state.lastAction || "Idle";
  const cost = formatUsd(state.lastCostLatency?.cost_total_usd);
  const lat = formatSeconds(state.lastCostLatency?.latency_per_image_s);
  const pieces = [`${providerFromModel(model) || "unknown"}:${model}`, action];
  if (cost) pieces.push(cost);
  if (lat) pieces.push(`${lat}/img`);
  if (els.hudUnitStat) els.hudUnitStat.textContent = pieces.join(" · ");
}

let describeTimer = null;
function scheduleVisionDescribe(path) {
  if (!state.ptySpawned) return;
  if (!path) return;
  const allowVision = state.keyStatus ? Boolean(state.keyStatus.openai || state.keyStatus.gemini) : true;
  if (!allowVision) return;
  const prevPath = state.describePendingPath;
  if (prevPath && prevPath !== path) {
    const prevItem = state.images.find((img) => img?.path === prevPath);
    if (prevItem && prevItem.visionPending && !prevItem.visionDesc) prevItem.visionPending = false;
  }
  const item = state.images.find((img) => img?.path === path) || null;
  if (item) {
    if (item.visionDesc) return;
    if (item.visionPending) return;
    item.visionPending = true;
    item.visionPendingAt = Date.now();
    state.describePendingPath = path;
    renderHudReadout();
  }
  clearTimeout(describeTimer);
  describeTimer = setTimeout(() => {
    invoke("write_pty", { data: `/describe ${path}\n` }).catch(() => {});
    // Safety valve: clear "SCANNING…" if the engine doesn't return an event.
    if (item) {
      setTimeout(() => {
        if (!item.visionPending || item.visionDesc) return;
        const startedAt = item.visionPendingAt || 0;
        if (Date.now() - startedAt < 8000) return;
        item.visionPending = false;
        if (getActiveImage()?.path === path) renderHudReadout();
      }, 8200);
    }
  }, 360);
}

let thumbObserver = null;
function ensureThumbObserver() {
  if (thumbObserver) return;
  if (!("IntersectionObserver" in window)) return;
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const imgEl = entry.target;
        const path = imgEl?.dataset?.path;
        if (!path) continue;
        thumbObserver.unobserve(imgEl);
        ensureImageUrl(path)
          .then((url) => {
            if (url) imgEl.src = url;
          })
          .catch(() => {});
      }
    },
    { root: els.filmstrip || null, rootMargin: "220px" }
  );
}

function getOrCreateImageCacheRecord(path) {
  const existing = state.imageCache.get(path);
  if (existing) return existing;
  const rec = { url: null, urlPromise: null, imgPromise: null };
  state.imageCache.set(path, rec);
  return rec;
}

async function ensureImageUrl(path) {
  if (!path) return null;
  const rec = getOrCreateImageCacheRecord(path);
  if (rec.url) return rec.url;
  if (rec.urlPromise) return await rec.urlPromise;
  rec.urlPromise = (async () => {
    const data = await readBinaryFile(path);
    const blob = new Blob([data], { type: mimeFromPath(path) });
    const url = URL.createObjectURL(blob);
    rec.url = url;
    return url;
  })();
  try {
    return await rec.urlPromise;
  } catch (err) {
    rec.urlPromise = null;
    throw err;
  }
}

function providerFromModel(model) {
  const name = String(model || "").toLowerCase();
  if (!name) return null;
  if (name.startsWith("gemini")) return "gemini";
  if (name.startsWith("imagen") || name.includes("imagen")) return "imagen";
  if (name.startsWith("gpt-image") || name.startsWith("gptimage") || name.startsWith("openai")) return "openai";
  if (name.startsWith("flux")) return "flux";
  if (name.startsWith("sdxl")) return "sdxl";
  if (name.startsWith("dryrun")) return "dryrun";
  if (name.includes("claude")) return "anthropic";
  if (name.includes("gpt-") || name.includes("o1")) return "openai";
  return "unknown";
}

function pickGeminiImageModel() {
  // Prefer the stronger multi-image model, but fall back to any Gemini option in the UI.
  const preferred = ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"];
  for (const candidate of preferred) {
    if (providerFromModel(candidate) !== "gemini") continue;
    if (!els.imageModel) return candidate;
    if (Array.from(els.imageModel.options || []).some((opt) => opt?.value === candidate)) return candidate;
  }
  if (els.imageModel) {
    const opt = Array.from(els.imageModel.options || []).find(
      (o) => providerFromModel(o?.value) === "gemini"
    );
    if (opt?.value) return opt.value;
  }
  return "gemini-3-pro-image-preview";
}

async function ensureGeminiForBlend() {
  const provider = providerFromModel(settings.imageModel);
  if (provider === "gemini") return true;
  const nextModel = pickGeminiImageModel();
  settings.imageModel = nextModel;
  localStorage.setItem("brood.imageModel", settings.imageModel);
  if (els.imageModel) els.imageModel.value = settings.imageModel;
  updatePortraitIdle();
  if (state.ptySpawned) {
    await invoke("write_pty", { data: `/image_model ${settings.imageModel}\n` }).catch(() => {});
  }
  showToast(`Combine requires Gemini. Switched image model to ${settings.imageModel}.`, "tip", 3200);
  return providerFromModel(settings.imageModel) === "gemini";
}

function providerDisplay(provider) {
  if (!provider) return "Unknown";
  if (provider === "openai") return "OpenAI";
  if (provider === "gemini") return "Gemini";
  if (provider === "imagen") return "Imagen";
  if (provider === "flux") return "Flux";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "sdxl") return "SDXL";
  if (provider === "dryrun") return "Dryrun";
  return String(provider);
}

const PORTRAITS_DIR_LS_KEY = "brood.portraitsDir";

function portraitAgentFromProvider(provider) {
  const p = String(provider || "").toLowerCase();
  // Requested swap: OpenAI uses Stability clips; Stability (SDXL) uses OpenAI clips.
  if (p === "openai") return "stability";
  if (p === "sdxl" || p === "stability") return "openai";
  if (p === "gemini") return "gemini";
  if (p === "imagen") return "imagen";
  if (p === "flux") return "flux";
  if (p === "dryrun") return "dryrun";
  return "dryrun";
}

async function resolvePortraitsDir() {
  if (state.portraitMedia.dirChecked) return state.portraitMedia.dir;
  if (state.portraitMedia.dirPromise) return await state.portraitMedia.dirPromise;
  state.portraitMedia.dirPromise = (async () => {
    const candidates = [];
    const fromLs = localStorage.getItem(PORTRAITS_DIR_LS_KEY);
    if (fromLs) candidates.push(String(fromLs));

    // Dev convenience: use repo-local outputs if we can locate the repo root.
    try {
      const repoRoot = await invoke("get_repo_root");
      if (repoRoot) candidates.push(await join(repoRoot, "outputs", "sora_portraits"));
    } catch (_) {}

    // Default persisted location (recommended for packaged builds).
    try {
      const home = await homeDir();
      if (home) {
        candidates.push(await join(home, ".brood", "portraits"));
        candidates.push(await join(home, "brood_runs", "portraits"));
      }
    } catch (_) {}

    for (const dir of candidates) {
      try {
        if (await exists(dir)) return dir;
      } catch (_) {}
    }
    return null;
  })();
  try {
    state.portraitMedia.dir = await state.portraitMedia.dirPromise;
    state.portraitMedia.dirChecked = true;
    return state.portraitMedia.dir;
  } finally {
    state.portraitMedia.dirPromise = null;
  }
}

function extractPortraitStamp(name) {
  const matches = String(name || "").match(/\d{8}_\d{6}/g);
  if (!matches || matches.length === 0) return "";
  return matches[matches.length - 1] || "";
}

function isStablePortraitName(name, agent, clipState) {
  const target = `${agent}_${clipState}.mp4`;
  return String(name || "").toLowerCase() === target;
}

async function buildPortraitIndex(dir) {
  const index = {
    dryrun: { idle: null, working: null },
    openai: { idle: null, working: null },
    gemini: { idle: null, working: null },
    imagen: { idle: null, working: null },
    flux: { idle: null, working: null },
    stability: { idle: null, working: null },
  };

  let entries = [];
  try {
    entries = await readDir(dir, { recursive: false });
  } catch (_) {
    return index;
  }

  const candidates = entries
    .map((e) => ({ path: e?.path, name: e?.name || basename(e?.path) }))
    .filter((e) => e.path && extname(e.path) === ".mp4");

  for (const item of candidates) {
    const name = String(item.name || "").toLowerCase();
    const match = name.match(/^(dryrun|openai|gemini|imagen|flux|stability)_(idle|working)(?:_|\\.)/);
    if (!match) continue;
    const agent = match[1];
    const clipState = match[2];
    const stamp = extractPortraitStamp(name);
    const priority = isStablePortraitName(name, agent, clipState) ? 2 : 1;
    const slot = index[agent]?.[clipState];
    if (!slot) {
      // First one wins until a higher-priority / newer candidate arrives.
      index[agent][clipState] = { path: item.path, priority, stamp };
      continue;
    }
    const slotPrio = slot.priority || 0;
    const slotStamp = slot.stamp || "";
    const isBetter =
      priority > slotPrio || (priority === slotPrio && stamp && (!slotStamp || stamp > slotStamp));
    if (isBetter) {
      index[agent][clipState] = { path: item.path, priority, stamp };
    }
  }

  // Strip metadata: callers only care about a path or null.
  for (const agent of Object.keys(index)) {
    for (const clipState of ["idle", "working"]) {
      const v = index[agent][clipState];
      index[agent][clipState] = v && v.path ? v.path : null;
    }
  }
  return index;
}

async function ensurePortraitIndex() {
  if (state.portraitMedia.indexChecked) return state.portraitMedia.index;
  if (state.portraitMedia.indexPromise) return await state.portraitMedia.indexPromise;
  state.portraitMedia.indexPromise = (async () => {
    const dir = await resolvePortraitsDir();
    if (!dir) return null;
    return await buildPortraitIndex(dir);
  })();
  try {
    state.portraitMedia.index = await state.portraitMedia.indexPromise;
    state.portraitMedia.indexChecked = true;
    return state.portraitMedia.index;
  } finally {
    state.portraitMedia.indexPromise = null;
  }
}

async function refreshPortraitVideo() {
  // Back-compat shim: older callers still invoke refreshPortraitVideo(). Keep it
  // delegating to the new multi-slot portrait implementation.
  await refreshAgentPortraitVideos();
}

function secondaryProviderFor(primaryProvider, index = null) {
  // For now: always show Flux as the secondary portrait when possible.
  // If primary is already Flux or Flux clips are missing, fall back to any
  // other available provider so the second portrait is never empty.
  const primary = String(primaryProvider || "").toLowerCase();
  const candidates = ["flux", "gemini", "openai", "imagen", "sdxl", "dryrun"];
  const ordered = ["flux", ...candidates.filter((p) => p !== "flux")];

  function hasIdle(provider) {
    if (!index) return true; // optimistic until the index loads
    const agent = portraitAgentFromProvider(provider);
    return Boolean(index?.[agent]?.idle || index?.[agent]?.working);
  }

  for (const provider of ordered) {
    if (provider === primary) continue;
    if (hasIdle(provider)) return provider;
  }
  return primary || "dryrun";
}

async function refreshPortraitVideoSlot({ videoEl, provider, busy, activeKeyField }) {
  if (!videoEl) return;
  const visible = Boolean(state.activeId) && els.portraitDock && !els.portraitDock.classList.contains("hidden");
  if (!visible) {
    try {
      videoEl.pause();
    } catch (_) {}
    videoEl.classList.add("hidden");
    state.portraitMedia[activeKeyField] = null;
    return;
  }

  const agent = portraitAgentFromProvider(provider);
  const clipState = busy ? "working" : "idle";
  const index = (await ensurePortraitIndex()) || {};

  let clipPath = index?.[agent]?.[clipState] || null;
  if (!clipPath && clipState === "working") clipPath = index?.[agent]?.idle || null;
  if (!clipPath && agent !== "dryrun") {
    clipPath = index?.dryrun?.[clipState] || index?.dryrun?.idle || null;
  }

  if (!clipPath) {
    try {
      videoEl.pause();
    } catch (_) {}
    videoEl.classList.add("hidden");
    state.portraitMedia[activeKeyField] = null;
    return;
  }

  let url = null;
  try {
    url = await ensureImageUrl(clipPath);
  } catch (_) {
    url = null;
  }
  if (!url) {
    videoEl.classList.add("hidden");
    state.portraitMedia[activeKeyField] = null;
    return;
  }

  const key = `${clipPath}:${clipState}`;
  if (state.portraitMedia[activeKeyField] !== key) {
    state.portraitMedia[activeKeyField] = key;
    videoEl.classList.remove("hidden");
    videoEl.src = url;
    try {
      videoEl.currentTime = 0;
    } catch (_) {}
    try {
      videoEl.load();
    } catch (_) {}
  }

  try {
    const p = videoEl.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
}

async function refreshAgentPortraitVideos() {
  await Promise.all([
    refreshPortraitVideoSlot({
      videoEl: els.portraitVideo,
      provider: state.portrait.provider,
      busy: state.portrait.busy,
      activeKeyField: "activeKey1",
    }),
    refreshPortraitVideoSlot({
      videoEl: els.portraitVideo2,
      provider: state.portrait2.provider,
      busy: state.portrait2.busy,
      activeKeyField: "activeKey2",
    }),
  ]);
}

function setPortrait({ title, provider, busy, visible } = {}) {
  if (typeof visible === "boolean") {
    if (els.portraitDock) els.portraitDock.classList.toggle("hidden", !visible);
  }
  if (typeof busy === "boolean") {
    state.portrait.busy = busy;
    if (els.agentSlotPrimary) els.agentSlotPrimary.classList.toggle("busy", busy);
  }
  if (provider !== undefined) {
    state.portrait.provider = provider;
    if (els.portraitAvatar) {
      els.portraitAvatar.dataset.provider = provider || "";
    }
  }
  if (title !== undefined) {
    state.portrait.title = title;
    if (els.portraitTitle) els.portraitTitle.textContent = title || "";
  }
  renderHudReadout();
  refreshAgentPortraitVideos().catch(() => {});
}

function setPortrait2({ title, provider, busy, visible } = {}) {
  if (typeof visible === "boolean") {
    if (els.portraitDock) els.portraitDock.classList.toggle("hidden", !visible);
  }
  if (typeof busy === "boolean") {
    state.portrait2.busy = busy;
    if (els.agentSlotSecondary) els.agentSlotSecondary.classList.toggle("busy", busy);
  }
  if (provider !== undefined) {
    state.portrait2.provider = provider;
    if (els.portraitAvatar2) {
      els.portraitAvatar2.dataset.provider = provider || "";
    }
  }
  if (title !== undefined) {
    state.portrait2.title = title;
    if (els.portraitTitle2) els.portraitTitle2.textContent = title || "";
  }
  renderHudReadout();
  refreshAgentPortraitVideos().catch(() => {});
}

function updatePortraitIdle() {
  const provider = providerFromModel(settings.imageModel);
  const hasImage = Boolean(state.activeId);
  const index = state.portraitMedia.index;
  const provider2 = secondaryProviderFor(provider, index);
  setPortrait({
    visible: hasImage,
    busy: false,
    provider,
    title: providerDisplay(provider),
  });
  setPortrait2({
    visible: hasImage,
    busy: false,
    provider: provider2,
    title: providerDisplay(provider2),
  });
  renderHudReadout();
}

function portraitWorking(_actionLabel, { providerOverride = null } = {}) {
  const provider = providerOverride || providerFromModel(settings.imageModel);
  setPortrait({
    visible: Boolean(state.activeId),
    busy: true,
    provider,
    title: providerDisplay(provider),
  });
  // Secondary portrait is display-only for now (idle loop).
  if (!state.portrait2.provider) {
    const provider2 = secondaryProviderFor(provider, state.portraitMedia.index);
    setPortrait2({
      visible: Boolean(state.activeId),
      busy: false,
      provider: provider2,
      title: providerDisplay(provider2),
    });
  } else {
    setPortrait2({
      visible: Boolean(state.activeId),
      busy: false,
    });
  }
  renderHudReadout();
}

function renderKeyStatus(status) {
  if (!els.keyStatus) return;
  if (!status || typeof status !== "object") {
    els.keyStatus.textContent = "Key detection unavailable.";
    return;
  }
  const lines = [];
  lines.push(`OpenAI: ${status.openai ? "ok" : "missing"}`);
  lines.push(`Gemini: ${status.gemini ? "ok" : "missing"}`);
  lines.push(`Imagen: ${status.imagen ? "ok" : "missing"}`);
  lines.push(`Flux: ${status.flux ? "ok" : "missing"}`);
  lines.push(`Anthropic: ${status.anthropic ? "ok" : "missing"}`);
  els.keyStatus.textContent = lines.join("\n");
}

async function refreshKeyStatus() {
  try {
    const status = await invoke("get_key_status");
    state.keyStatus = status;
    renderKeyStatus(status);
  } catch (err) {
    console.warn("Key detection failed:", err);
    state.keyStatus = null;
    renderKeyStatus(null);
  }
}

function setStatus(message, isError = false) {
  if (!els.engineStatus) return;
  els.engineStatus.textContent = message;
  els.engineStatus.classList.toggle("error", isError);
}

let toastTimer = null;
function showToast(message, kind = "info", timeoutMs = 2400) {
  if (!els.toast) return;
  els.toast.textContent = String(message || "");
  els.toast.dataset.kind = kind;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  if (timeoutMs > 0) {
    toastTimer = setTimeout(() => {
      if (!els.toast) return;
      els.toast.classList.add("hidden");
    }, timeoutMs);
  }
}

function setTip(message) {
  if (!els.tipsText) return;
  els.tipsText.textContent = String(message || "");
}

function pulseTool(tool) {
  const btn = els.toolButtons.find((b) => b?.dataset?.tool === tool);
  if (!btn) return;
  btn.classList.remove("pulse");
  // Trigger reflow so the animation restarts.
  void btn.offsetWidth; // eslint-disable-line no-unused-expressions
  btn.classList.add("pulse");
  setTimeout(() => btn.classList.remove("pulse"), 900);
}

function setRunInfo(message) {
  if (!els.runInfo) return;
  els.runInfo.textContent = message;
}

function bumpInteraction() {
  state.lastInteractionAt = Date.now();
}

function basename(path) {
  if (!path) return "";
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function extname(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "";
  return name.slice(dot).toLowerCase();
}

function mimeFromPath(path) {
  const ext = extname(path);
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".heic") return "image/heic";
  if (ext === ".mp4") return "video/mp4";
  return "application/octet-stream";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getDpr() {
  return Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
}

function ensureCanvasSize() {
  if (!els.canvasWrap || !els.workCanvas || !els.overlayCanvas) return;
  const rect = els.canvasWrap.getBoundingClientRect();
  const dpr = getDpr();
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (els.workCanvas.width !== width || els.workCanvas.height !== height) {
    els.workCanvas.width = width;
    els.workCanvas.height = height;
    els.overlayCanvas.width = width;
    els.overlayCanvas.height = height;
    resetViewToFit();
  }
}

function canvasPointFromEvent(event) {
  const dpr = getDpr();
  // Prefer offsetX/Y to avoid triggering layout (getBoundingClientRect) on hot paths.
  const ox = event?.offsetX;
  const oy = event?.offsetY;
  if (typeof ox === "number" && typeof oy === "number" && Number.isFinite(ox) && Number.isFinite(oy)) {
    return { x: ox * dpr, y: oy * dpr };
  }
  const rect = els.overlayCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * dpr;
  const y = (event.clientY - rect.top) * dpr;
  return { x, y };
}

function canvasToImage(pt) {
  const img = getActiveImage();
  if (!img) return { x: 0, y: 0 };
  return {
    x: (pt.x - state.view.offsetX) / state.view.scale,
    y: (pt.y - state.view.offsetY) / state.view.scale,
  };
}

function imageToCanvas(pt) {
  return {
    x: state.view.offsetX + pt.x * state.view.scale,
    y: state.view.offsetY + pt.y * state.view.scale,
  };
}

function requestRender() {
  if (state.needsRender) return;
  state.needsRender = true;
  requestAnimationFrame(() => {
    state.needsRender = false;
    render();
  });
}

async function loadImage(path) {
  if (!path) return null;
  const rec = getOrCreateImageCacheRecord(path);
  if (rec.imgPromise) return await rec.imgPromise;
  rec.imgPromise = (async () => {
    // Always use a blob URL to keep the canvas untainted for local edits (toBlob, etc).
    const url = await ensureImageUrl(path);
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (err) => reject(err);
      img.src = url;
    });
  })();
  return await rec.imgPromise;
}

function clearImageCache() {
  for (const value of state.imageCache.values()) {
    const url = value?.url;
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
  }
  state.imageCache.clear();
}

function getActiveImage() {
  if (!state.activeId) return null;
  return state.imagesById.get(state.activeId) || null;
}

function setCanvasMode(mode) {
  const next = mode === "multi" ? "multi" : "single";
  if (state.canvasMode === next) return;
  state.canvasMode = next;
  state.multiRects.clear();
  state.pointer.active = false;
  state.selection = null;
  state.lassoDraft = [];
  // Multi-view is a tile layout; lasso doesn't have well-defined coordinates.
  if (next === "multi" && state.tool === "lasso") {
    setTool("pan");
  }
  chooseSpawnNodes();
  renderSelectionMeta();
  requestRender();
}

function ensureCanvasImageLoaded(item) {
  if (!item || !item.path) return;
  if (item.img) return;
  if (item.imgLoading) return;
  item.imgLoading = true;
  loadImage(item.path)
    .then((img) => {
      item.img = img;
      item.width = img?.naturalWidth || null;
      item.height = img?.naturalHeight || null;
    })
    .catch((err) => {
      console.warn("Failed to load image for canvas:", err);
    })
    .finally(() => {
      item.imgLoading = false;
      requestRender();
    });
}

function computeMultiRects(items, canvasW, canvasH) {
  const n = Array.isArray(items) ? items.length : 0;
  if (!n) return new Map();
  const dpr = getDpr();
  const isMobile =
    window.matchMedia && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 980px)").matches
      : false;
  const padX = Math.round(26 * dpr);
  const padTop = Math.round((isMobile ? 18 : 26) * dpr);
  // Keep the bottom "control surface" clear (spawnbar + HUD).
  const padBottom = Math.round((isMobile ? 210 : 250) * dpr);
  const gap = Math.round(18 * dpr);

  let cols = 1;
  if (n === 2) cols = 2;
  else if (n <= 4) cols = 2;
  else cols = 3;
  const rows = Math.ceil(n / cols);

  const usableW = Math.max(1, canvasW - padX * 2);
  const usableH = Math.max(1, canvasH - padTop - padBottom);
  const cellW = Math.max(1, (usableW - gap * (cols - 1)) / cols);
  const cellH = Math.max(1, (usableH - gap * (rows - 1)) / rows);

  const rects = new Map();
  for (let i = 0; i < n; i += 1) {
    const item = items[i];
    if (!item?.id) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellX = padX + col * (cellW + gap);
    const cellY = padTop + row * (cellH + gap);
    const iw = item?.img?.naturalWidth || item?.width || null;
    const ih = item?.img?.naturalHeight || item?.height || null;
    let x = Math.round(cellX);
    let y = Math.round(cellY);
    let w = Math.max(1, Math.round(cellW));
    let h = Math.max(1, Math.round(cellH));
    if (iw && ih) {
      const scale = Math.min(cellW / iw, cellH / ih);
      w = Math.max(1, Math.round(iw * scale));
      h = Math.max(1, Math.round(ih * scale));
      x = Math.round(cellX + (cellW - w) / 2);
      y = Math.round(cellY + (cellH - h) / 2);
    }
    rects.set(item.id, { x, y, w, h, cellX, cellY, cellW, cellH });
  }
  return rects;
}

function hitTestMulti(pt) {
  if (!pt) return null;
  const entries = Array.from(state.multiRects.entries());
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [id, rect] = entries[i];
    if (!rect) continue;
    if (pt.x < rect.x || pt.x > rect.x + rect.w) continue;
    if (pt.y < rect.y || pt.y > rect.y + rect.h) continue;
    return id;
  }
  return null;
}

function resetViewToFit() {
  if (state.canvasMode !== "single") return;
  const img = getActiveImage();
  if (!img || !img.img) return;
  const canvas = els.workCanvas;
  if (!canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (!cw || !ch) return;
  const iw = img.img.naturalWidth || img.width || 1;
  const ih = img.img.naturalHeight || img.height || 1;
  const isMobile =
    window.matchMedia && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 980px)").matches
      : false;
  // Keep the image smaller than full-bleed so the HUD/spawnbar have breathing room.
  const maxWidthFrac = isMobile ? 0.92 : 0.6;
  const maxHeightFrac = isMobile ? 0.9 : 0.86;
  const scale = Math.min((cw * maxWidthFrac) / iw, (ch * maxHeightFrac) / ih);
  state.view.scale = clamp(scale, 0.05, 20);
  const slackX = cw - iw * state.view.scale;
  const slackY = ch - ih * state.view.scale;
  state.view.offsetX = slackX / 2;

  // Bias images toward the top so the bottom HUD/spawnbar feels like "control surface" space.
  const desiredTop = Math.round(ch * (isMobile ? 0.04 : 0.06));
  state.view.offsetY = slackY <= desiredTop ? slackY / 2 : desiredTop;
  renderHudReadout();
  requestRender();
}

function getActiveImageRectCss() {
  const dpr = getDpr();
  if (state.canvasMode === "multi") {
    const rect = state.activeId ? state.multiRects.get(state.activeId) : null;
    if (!rect) return null;
    return {
      left: rect.x / dpr,
      top: rect.y / dpr,
      width: rect.w / dpr,
      height: rect.h / dpr,
    };
  }
  if (state.canvasMode !== "single") return null;
  const item = getActiveImage();
  const img = item?.img;
  if (!item || !img) return null;
  const iw = img.naturalWidth || item.width || 1;
  const ih = img.naturalHeight || item.height || 1;
  return {
    left: state.view.offsetX / dpr,
    top: state.view.offsetY / dpr,
    width: (iw * state.view.scale) / dpr,
    height: (ih * state.view.scale) / dpr,
  };
}

function updateImageFxRect() {
  if (!els.imageFx) return;
  if (els.imageFx.classList.contains("hidden")) return;
  const rect = getActiveImageRectCss();
  if (!rect) return;
  els.imageFx.style.left = `${rect.left.toFixed(2)}px`;
  els.imageFx.style.top = `${rect.top.toFixed(2)}px`;
  els.imageFx.style.width = `${Math.max(0, rect.width).toFixed(2)}px`;
  els.imageFx.style.height = `${Math.max(0, rect.height).toFixed(2)}px`;
}

function setImageFxActive(active, label = null) {
  state.imageFx.active = Boolean(active);
  state.imageFx.label = label || null;
  if (!els.imageFx) return;
  els.imageFx.classList.toggle("hidden", !state.imageFx.active);
  if (state.imageFx.active) updateImageFxRect();
  requestRender();
}

function beginPendingReplace(targetId, label) {
  if (!targetId) return;
  state.pendingReplace = { targetId, startedAt: Date.now(), label: label || null };
}

function clearPendingReplace() {
  state.pendingReplace = null;
}

function clearSelection() {
  state.selection = null;
  state.lassoDraft = [];
  setTip(DEFAULT_TIP);
  requestRender();
  renderSelectionMeta();
  renderHudReadout();
}

function setTool(tool) {
  const allowed = new Set(["pan", "lasso"]);
  if (!allowed.has(tool)) return;
  if (tool === "lasso" && state.canvasMode === "multi") {
    showToast("Lasso is disabled in multi-view. Combine or click an image to focus it first.", "tip", 2600);
    return;
  }
  state.tool = tool;
  for (const btn of els.toolButtons) {
    const t = btn.dataset.tool;
    btn.classList.toggle("selected", t === tool);
  }
  renderSelectionMeta();
  renderHudReadout();
  if (tool === "lasso") {
    setTip("Lasso your product, then click Studio White. Or skip lasso and let the model infer the subject.");
  } else {
    setTip(DEFAULT_TIP);
  }
}

function showDropHint(show) {
  if (!els.dropHint) return;
  els.dropHint.classList.toggle("hidden", !show);
}

function renderSelectionMeta() {
  const img = getActiveImage();
  if (!img) {
    if (els.selectionMeta) els.selectionMeta.textContent = "No image selected.";
    renderHudReadout();
    return;
  }
  const name = basename(img.path);
  const sel = state.selection ? `${state.selection.points.length} pts` : "none";
  if (els.selectionMeta) els.selectionMeta.textContent = `${name}\nSelection: ${sel}`;
  renderHudReadout();
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

function svgEl(name) {
  return document.createElementNS(SVG_NS, name);
}

function rand01(seed) {
  // Deterministic 0..1 value for a given number seed.
  const x = Math.sin(seed * 999.123) * 43758.5453123;
  return x - Math.floor(x);
}

function hash32(value) {
  // FNV-1a-ish 32-bit hash for stable per-node motion patterns.
  const s = String(value || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

let larvaRaf = null;
let larvaStartedAt = null;
function stopLarvaAnimator() {
  if (!larvaRaf) return;
  try {
    cancelAnimationFrame(larvaRaf);
  } catch {
    // ignore
  }
  larvaRaf = null;
}

function ensureLarvaAnimator() {
  if (larvaRaf) return;
  if (!state.larvaTargets || state.larvaTargets.length === 0) return;
  if (document.hidden) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (larvaStartedAt == null) larvaStartedAt = performance.now();
  const TAU = Math.PI * 2;
  const LOOP_MS = 4000; // Perfect loop: all larva motion repeats exactly every 4s.
  const tick = (now) => {
    if (document.hidden) {
      larvaRaf = null;
      return;
    }
    const targets = state.larvaTargets || [];
    if (targets.length === 0) {
      larvaRaf = null;
      return;
    }
    const phase = ((now - larvaStartedAt) % LOOP_MS) / LOOP_MS; // 0..1
    const w = TAU * phase;
    for (const target of targets) {
      const seed = Number(target?.seed || 0);
      const svg = target?.svgEl;
      const btnEl = target?.btnEl;
      const headEl = target?.headEl;
      const tailEl = target?.tailEl;
      if (target?.exploding) continue;

      if (svg) {
        const tilt = target?.tiltDeg || 0;
        const rotAmp = target?.rotAmp || 0.8;
        const nRot = target?.nRot || 2;
        const nSquish = target?.nSquish || 2;
        const pRot = target?.phaseRot || 0;
        const pSquish = target?.phaseSquish || 0;
        const squishAmp = target?.squishAmp || 0.0065;
        const rot = tilt + rotAmp * Math.sin(w * nRot + pRot + seed * 0.01);
        const squish = 1 + squishAmp * Math.sin(w * nSquish + pSquish + seed * 0.01);
        // Keep the larva "on the surface"; motion reads mostly as head/tail movement.
        svg.style.transform = `rotate(${rot.toFixed(2)}deg) scale(${squish.toFixed(4)})`;
      }

      if (headEl) {
        const nHead = target?.nHead || 2;
        const nHeadRot = target?.nHeadRot || nHead;
        const ampHX = target?.headAmpX || 1.3;
        const ampHY = target?.headAmpY || 0.9;
        const ampHRot = target?.headRotAmp || 8;
        const pHX = target?.phaseHeadX || 0;
        const pHY = target?.phaseHeadY || 0;
        const pHRot = target?.phaseHeadRot || 0;
        const hx = ampHX * Math.sin(w * nHead + pHX + seed * 0.01);
        const hy = ampHY * Math.cos(w * nHead + pHY + seed * 0.01);
        const ha = ampHRot * Math.sin(w * nHeadRot + pHRot + seed * 0.01);
        headEl.setAttribute(
          "transform",
          `translate(${hx.toFixed(2)} ${hy.toFixed(2)}) rotate(${ha.toFixed(2)} 54 44)`
        );
      }

      if (tailEl) {
        const nTail = target?.nTail || 2;
        const nTailRot = target?.nTailRot || nTail;
        const ampTX = target?.tailAmpX || 1.0;
        const ampTY = target?.tailAmpY || 0.7;
        const ampTRot = target?.tailRotAmp || 6;
        const pTX = target?.phaseTailX || 0;
        const pTY = target?.phaseTailY || 0;
        const pTRot = target?.phaseTailRot || 0;
        const tx = ampTX * Math.sin(w * nTail + pTX + seed * 0.01);
        const ty = ampTY * Math.cos(w * nTail + pTY + seed * 0.01);
        const ta = ampTRot * Math.sin(w * nTailRot + pTRot + seed * 0.01);
        tailEl.setAttribute(
          "transform",
          `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) rotate(${ta.toFixed(2)} 302 44)`
        );
      }

      if (btnEl) {
        const nShadow = target?.nShadow || 2;
        const pShadow = target?.phaseShadow || 0;
        const sh = 0.92 + 0.08 * Math.sin(w * nShadow + pShadow + seed * 0.01);
        const sh2 = 0.70 + 0.06 * Math.sin(w * nShadow + pShadow + seed * 0.01 + 1.2);
        const shA = 0.72 + 0.10 * Math.sin(w * nShadow + pShadow + seed * 0.01 + 2.4);
        btnEl.style.setProperty("--larva-shadow-sx", sh.toFixed(3));
        btnEl.style.setProperty("--larva-shadow-sy", sh2.toFixed(3));
        btnEl.style.setProperty("--larva-shadow-a", shA.toFixed(3));
      }
    }
    larvaRaf = requestAnimationFrame(tick);
  };
  larvaRaf = requestAnimationFrame(tick);
}

function buildLarvaSvg(label, { uid, seed } = {}) {
  const title = String(label || "").toUpperCase();
  const safeUid = uid || `larva-${state.larvaUid++}`;
  const bodyId = `larva-body-${safeUid}`;
  const glowId = `larva-glow-${safeUid}`;
  const curveId = `larva-curve-${safeUid}`;
  const filterId = `larva-wiggle-${safeUid}`;

  const svg = svgEl("svg");
  svg.setAttribute("class", "larva-svg");
  svg.setAttribute("viewBox", "0 0 320 84");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("preserveAspectRatio", "none");

  const defs = svgEl("defs");

  const bodyGrad = svgEl("radialGradient");
  bodyGrad.setAttribute("id", bodyId);
  bodyGrad.setAttribute("cx", "34%");
  bodyGrad.setAttribute("cy", "26%");
  bodyGrad.setAttribute("r", "90%");
  {
    const stop1 = svgEl("stop");
    stop1.setAttribute("offset", "0%");
    stop1.setAttribute("stop-color", "#ff8fd4");
    bodyGrad.appendChild(stop1);
    const stop2 = svgEl("stop");
    stop2.setAttribute("offset", "42%");
    stop2.setAttribute("stop-color", "#ff2f9c");
    bodyGrad.appendChild(stop2);
    const stop3 = svgEl("stop");
    stop3.setAttribute("offset", "100%");
    stop3.setAttribute("stop-color", "#1f020e");
    bodyGrad.appendChild(stop3);
  }
  defs.appendChild(bodyGrad);

  const glowGrad = svgEl("radialGradient");
  glowGrad.setAttribute("id", glowId);
  glowGrad.setAttribute("cx", "40%");
  glowGrad.setAttribute("cy", "40%");
  glowGrad.setAttribute("r", "80%");
  {
    const stop1 = svgEl("stop");
    stop1.setAttribute("offset", "0%");
    stop1.setAttribute("stop-color", "#ff5ebe");
    stop1.setAttribute("stop-opacity", "0.40");
    glowGrad.appendChild(stop1);
    const stop2 = svgEl("stop");
    stop2.setAttribute("offset", "60%");
    stop2.setAttribute("stop-color", "#c56bff");
    stop2.setAttribute("stop-opacity", "0.12");
    glowGrad.appendChild(stop2);
    const stop3 = svgEl("stop");
    stop3.setAttribute("offset", "100%");
    stop3.setAttribute("stop-color", "#000000");
    stop3.setAttribute("stop-opacity", "0");
    glowGrad.appendChild(stop3);
  }
  defs.appendChild(glowGrad);

  const filter = svgEl("filter");
  filter.setAttribute("id", filterId);
  filter.setAttribute("x", "-30");
  filter.setAttribute("y", "-30");
  filter.setAttribute("width", "380");
  filter.setAttribute("height", "160");
  filter.setAttribute("filterUnits", "userSpaceOnUse");

  const turb = svgEl("feTurbulence");
  turb.setAttribute("type", "turbulence");
  turb.setAttribute("baseFrequency", "0.012 0.020");
  turb.setAttribute("numOctaves", "2");
  turb.setAttribute("seed", String(seed ?? 2));
  turb.setAttribute("result", "noise");
  filter.appendChild(turb);

  const disp = svgEl("feDisplacementMap");
  disp.setAttribute("in", "SourceGraphic");
  disp.setAttribute("in2", "noise");
  disp.setAttribute("scale", "10");
  disp.setAttribute("xChannelSelector", "R");
  disp.setAttribute("yChannelSelector", "G");
  filter.appendChild(disp);

  defs.appendChild(filter);
  svg.appendChild(defs);

  const g = svgEl("g");
  g.setAttribute("filter", `url(#${filterId})`);

  const aura = svgEl("path");
  aura.setAttribute(
    "d",
    "M24 44 C32 22 78 14 124 18 C176 22 236 14 280 20 C300 22 312 30 316 42 C320 54 312 64 294 66 C244 74 176 78 122 74 C76 70 34 62 24 44 Z"
  );
  aura.setAttribute("fill", `url(#${glowId})`);
  aura.setAttribute("opacity", "0.62");
  g.appendChild(aura);

  const body = svgEl("path");
  body.setAttribute(
    "d",
    "M28 44 C36 24 82 16 128 20 C186 24 248 16 286 22 C302 24 312 32 316 42 C320 52 312 60 296 64 C248 72 180 74 128 70 C82 66 40 58 28 44 Z"
  );
  body.setAttribute("fill", `url(#${bodyId})`);
  body.setAttribute("stroke", "rgba(170, 40, 110, 0.62)");
  body.setAttribute("stroke-width", "2");
  g.appendChild(body);

  const headGroup = svgEl("g");
  headGroup.dataset.part = "head";
  // Head cap (subtle) so head/tail motion reads as "alive" without looking like a UI widget.
  const headCap = svgEl("ellipse");
  headCap.setAttribute("cx", "54");
  headCap.setAttribute("cy", "44");
  headCap.setAttribute("rx", "22");
  headCap.setAttribute("ry", "18");
  headCap.setAttribute("fill", "rgba(0, 0, 0, 0.14)");
  headGroup.appendChild(headCap);

  const headSheen = svgEl("ellipse");
  headSheen.setAttribute("cx", "48");
  headSheen.setAttribute("cy", "38");
  headSheen.setAttribute("rx", "14");
  headSheen.setAttribute("ry", "10");
  headSheen.setAttribute("fill", "rgba(255, 255, 255, 0.12)");
  headSheen.setAttribute("opacity", "0.7");
  headGroup.appendChild(headSheen);

  const headDot1 = svgEl("circle");
  headDot1.setAttribute("cx", "44");
  headDot1.setAttribute("cy", "48");
  headDot1.setAttribute("r", "2.0");
  headDot1.setAttribute("fill", "rgba(255, 255, 255, 0.10)");
  headGroup.appendChild(headDot1);

  const headDot2 = svgEl("circle");
  headDot2.setAttribute("cx", "52");
  headDot2.setAttribute("cy", "50");
  headDot2.setAttribute("r", "1.4");
  headDot2.setAttribute("fill", "rgba(255, 255, 255, 0.08)");
  headGroup.appendChild(headDot2);

  g.appendChild(headGroup);

  const tailGroup = svgEl("g");
  tailGroup.dataset.part = "tail";
  const tailTip = svgEl("path");
  tailTip.setAttribute("d", "M302 40 L318 44 L302 48 Z");
  tailTip.setAttribute("fill", "rgba(70, 10, 120, 0.55)");
  tailGroup.appendChild(tailTip);

  const tailShine = svgEl("path");
  tailShine.setAttribute("d", "M300 38 C308 38 314 40 318 44 C314 48 308 50 300 50");
  tailShine.setAttribute("stroke", "rgba(255, 255, 255, 0.10)");
  tailShine.setAttribute("stroke-width", "2");
  tailShine.setAttribute("stroke-linecap", "round");
  tailGroup.appendChild(tailShine);
  g.appendChild(tailGroup);

  // Segment ridges (worm rings).
  for (let i = 0; i < 10; i += 1) {
    const x = 68 + i * 22;
    const ridge = svgEl("path");
    ridge.setAttribute("d", `M${x} 18 Q${x - 10} 42 ${x} 66`);
    ridge.setAttribute("stroke", "rgba(255, 255, 255, 0.17)");
    ridge.setAttribute("stroke-width", "3");
    ridge.setAttribute("stroke-linecap", "round");
    ridge.setAttribute("opacity", "0.55");
    g.appendChild(ridge);

    const shadow = svgEl("path");
    shadow.setAttribute("d", `M${x + 2} 22 Q${x - 6} 44 ${x + 2} 62`);
    shadow.setAttribute("stroke", "rgba(0, 0, 0, 0.18)");
    shadow.setAttribute("stroke-width", "3");
    shadow.setAttribute("stroke-linecap", "round");
    shadow.setAttribute("opacity", "0.55");
    g.appendChild(shadow);
  }

  // Gloss highlight.
  const gloss = svgEl("path");
  gloss.setAttribute("d", "M54 34 C124 16 204 16 286 30");
  gloss.setAttribute("stroke", "rgba(255, 255, 255, 0.18)");
  gloss.setAttribute("stroke-width", "9");
  gloss.setAttribute("stroke-linecap", "round");
  gloss.setAttribute("opacity", "0.46");
  g.appendChild(gloss);

  // Speckles.
  for (let i = 0; i < 14; i += 1) {
    const c = svgEl("circle");
    const cx = 56 + ((i * 19 + (seed ?? 0) * 17) % 220);
    const cy = 26 + ((i * 13 + (seed ?? 0) * 11) % 32);
    const r = 1.1 + ((i + (seed ?? 0)) % 3) * 0.5;
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", String(cy));
    c.setAttribute("r", String(r));
    c.setAttribute("fill", "rgba(255, 255, 255, 0.11)");
    g.appendChild(c);
  }

  // Slight curve so the text feels "painted onto" the larva.
  const curve = svgEl("path");
  curve.setAttribute("id", curveId);
  // Keep the label centered on the thickest part of the body.
  curve.setAttribute("d", "M62 52 C136 50 210 50 282 52");
  curve.setAttribute("fill", "none");
  g.appendChild(curve);

  const tight = title.replace(/\s+/g, "").length;
  let fontSize = 26;
  if (tight >= 12) fontSize = 24;
  if (tight >= 14) fontSize = 22;
  if (tight >= 16) fontSize = 20;

  const text = svgEl("text");
  text.setAttribute("fill", "rgba(255, 246, 252, 0.96)");
  text.setAttribute("stroke", "rgba(0, 0, 0, 0.40)");
  text.setAttribute("stroke-width", "6");
  text.setAttribute("font-family", "Space Grotesk, sans-serif");
  text.setAttribute("font-weight", "800");
  text.setAttribute("font-size", String(fontSize));
  text.setAttribute("letter-spacing", "3");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("paint-order", "stroke fill");

  const textPath = svgEl("textPath");
  textPath.setAttribute("startOffset", "50%");
  textPath.setAttribute("href", `#${curveId}`);
  textPath.setAttributeNS(XLINK_NS, "xlink:href", `#${curveId}`);
  textPath.textContent = title;
  text.appendChild(textPath);
  g.appendChild(text);

  svg.appendChild(g);
  return { svg, turbEl: turb, dispEl: disp, headEl: headGroup, tailEl: tailGroup };
}

function spawnCooldownKey(nodeId, imageId) {
  return `${String(imageId || "")}::${String(nodeId || "")}`;
}

function isSpawnNodeOnCooldown(nodeId, imageId) {
  const key = spawnCooldownKey(nodeId, imageId);
  const until = state.spawnCooldowns.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    state.spawnCooldowns.delete(key);
    return false;
  }
  return true;
}

function setSpawnNodeCooldown(nodeId, imageId, ms = 60_000) {
  const key = spawnCooldownKey(nodeId, imageId);
  state.spawnCooldowns.set(key, Date.now() + Math.max(1_000, Number(ms) || 60_000));
}

function explodeSpawnNode(btnEl, nodeId, imageId) {
  if (!btnEl || !nodeId) return;
  if (btnEl.classList.contains("exploding")) return;
  setSpawnNodeCooldown(nodeId, imageId, 60_000);

  // Stop per-frame warping so the explosion animation can take over cleanly.
  for (const target of state.larvaTargets) {
    if (target?.btnEl === btnEl) {
      target.exploding = true;
      try {
        if (target.svgEl) target.svgEl.style.transform = "";
      } catch {
        // ignore
      }
      break;
    }
  }

  btnEl.classList.add("exploding");
  btnEl.setAttribute("disabled", "disabled");

  // Let the pop animation play, then rebuild the spawnbar without this node.
  setTimeout(() => {
    if (btnEl?.isConnected) {
      try {
        btnEl.remove();
      } catch {
        // ignore
      }
    }
    chooseSpawnNodes();
  }, 680);

  // After cooldown, refresh if the same image is still selected.
  setTimeout(() => {
    const active = getActiveImage();
    if (active?.id && active.id === imageId) chooseSpawnNodes();
  }, 60_200);
}

function renderSpawnbar() {
  if (!els.spawnbar) return;
  els.spawnbar.innerHTML = "";
  state.larvaTargets = [];
  if (!state.activeId) return;
  const activeItem = getActiveImage();
  const activeId = activeItem?.id || state.activeId || "";
  const activePath = activeItem?.path || "";
  const frag = document.createDocumentFragment();
  for (const node of state.spawnNodes) {
    if (isSpawnNodeOnCooldown(node.id, activeId)) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "spawn-node";
    btn.setAttribute("aria-label", node.title || "Action");
    const text = String(node.title || "");
    const rawWidth = (120 + text.length * 10) * 0.8;
    const width = clamp(Math.round(rawWidth), 150, 240);
    btn.style.setProperty("--larva-w", `${width}px`);
    btn.style.setProperty("--larva-h", "46px");
    const stable = hash32(`${node.id}::${activeId}`);
    const uid = `larva-${node.id}-${stable.toString(16)}-${state.larvaUid++}`;
    const seed = stable % 1000;
    const built = buildLarvaSvg(text, { uid, seed });
    const r1 = rand01(stable + 1.1);
    const r2 = rand01(stable + 2.2);
    const r3 = rand01(stable + 3.3);
    const r4 = rand01(stable + 4.4);
    const tilt = (r1 - 0.5) * 7.0; // ~[-3.5..3.5]deg
    btn.style.setProperty("--larva-tilt", `${tilt.toFixed(2)}deg`);
    built.svg.style.transform = `rotate(${tilt.toFixed(2)}deg)`;
    btn.appendChild(built.svg);

    // Static organic warp; we animate head/tail (not full-body squiggle).
    const baseF1 = 0.0095 + r2 * 0.0040;
    const baseF2 = 0.0140 + r3 * 0.0050;
    const warpScale = 5.2 + r3 * 1.6;
    try {
      if (built.turbEl) built.turbEl.setAttribute("baseFrequency", `${baseF1.toFixed(4)} ${baseF2.toFixed(4)}`);
      if (built.dispEl) built.dispEl.setAttribute("scale", `${warpScale.toFixed(1)}`);
    } catch {
      // ignore
    }

    state.larvaTargets.push({
      nodeId: node.id,
      imagePath: activePath,
      btnEl: btn,
      svgEl: built.svg,
      turbEl: built.turbEl,
      dispEl: built.dispEl,
      headEl: built.headEl,
      tailEl: built.tailEl,
      seed,
      tiltDeg: tilt,
      rotAmp: 0.16 + r4 * 0.55,
      nRot: 1 + Math.floor(r3 * 3),
      nSquish: 1 + Math.floor(r4 * 3),
      phaseRot: r4 * Math.PI * 2,
      phaseSquish: r1 * Math.PI * 2,
      squishAmp: 0.0045 + r2 * 0.0035,
      nHead: 1 + Math.floor(r2 * 3),
      nHeadRot: 1 + Math.floor(r3 * 3),
      headAmpX: 1.0 + r1 * 1.6,
      headAmpY: 0.6 + r2 * 1.2,
      headRotAmp: 5 + r4 * 10,
      phaseHeadX: r2 * Math.PI * 2,
      phaseHeadY: r3 * Math.PI * 2,
      phaseHeadRot: r4 * Math.PI * 2,
      nTail: 1 + Math.floor(r3 * 3),
      nTailRot: 1 + Math.floor(r4 * 3),
      tailAmpX: 0.8 + r2 * 1.4,
      tailAmpY: 0.5 + r1 * 1.0,
      tailRotAmp: 4 + r3 * 8,
      phaseTailX: r3 * Math.PI * 2,
      phaseTailY: r4 * Math.PI * 2,
      phaseTailRot: r1 * Math.PI * 2,
      nShadow: 1 + Math.floor(r2 * 3),
      phaseShadow: r4 * Math.PI * 2,
    });
    btn.addEventListener("click", () => {
      bumpInteraction();
      const imageId = getActiveImage()?.id || activeId;
      explodeSpawnNode(btn, node.id, imageId);
      handleSpawnNode(node).catch((err) => {
        console.error(err);
        showToast(err?.message || String(err), "error");
      });
    });
    frag.appendChild(btn);
  }
  els.spawnbar.appendChild(frag);
  ensureLarvaAnimator();
}

function chooseSpawnNodes() {
  if (state.canvasMode === "multi") {
    const canBlend = state.images.length === 2 && !state.pendingBlend;
    state.spawnNodes = canBlend
      ? [{ id: "blend_pair", title: "Combine", action: "blend_pair" }]
      : [];
    renderSpawnbar();
    return;
  }
  if (!state.activeId) {
    state.spawnNodes = [];
    renderSpawnbar();
    return;
  }
  const img = getActiveImage();
  const items = [];
  items.push({ id: "bg_white", title: "Studio White", action: "bg_white" });
  items.push({ id: "variations", title: "Variations", action: "variations" });
  if (img?.img) {
    const w = img.img.naturalWidth;
    const h = img.img.naturalHeight;
    if (w && h && Math.abs(w - h) > 8) {
      items.push({ id: "crop_square", title: "Square Crop", action: "crop_square" });
    } else {
      items.push({ id: "bg_sweep", title: "Soft Sweep", action: "bg_sweep" });
    }
  } else {
    items.push({ id: "bg_sweep", title: "Soft Sweep", action: "bg_sweep" });
  }
  // Keep it to 3 kernels.
  const imageId = img?.id || state.activeId || "";
  const available = items.filter((item) => !isSpawnNodeOnCooldown(item.id, imageId));
  state.spawnNodes = available.slice(0, 3);
  renderSpawnbar();
}

async function handleSpawnNode(node) {
  if (!node) return;
  if (node.action === "blend_pair") {
    await runBlendPair();
    return;
  }
  if (node.action === "bg_white") {
    await applyBackground("white");
    return;
  }
  if (node.action === "bg_sweep") {
    await applyBackground("sweep");
    return;
  }
  if (node.action === "crop_square") {
    await cropSquare();
    return;
  }
  if (node.action === "variations") {
    await runVariations();
    return;
  }
}

function renderFilmstrip() {
  if (!els.filmstrip) return;
  ensureThumbObserver();
  // Avoid accumulating observed nodes when we teardown/rebuild the filmstrip.
  if (thumbObserver) {
    try {
      thumbObserver.disconnect();
    } catch {
      // ignore
    }
  }
  state.thumbsById.clear();
  els.filmstrip.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const item of state.images) {
    const div = document.createElement("div");
    div.className = "thumb" + (item.id === state.activeId ? " selected" : "");
    div.dataset.id = item.id;
    const img = document.createElement("img");
    img.alt = item.label || basename(item.path) || "Artifact";
    img.loading = "lazy";
    img.decoding = "async";
    img.dataset.path = item.path;
    // Give it something valid to avoid broken-image glyphs before we swap in a blob URL.
    img.src = THUMB_PLACEHOLDER_SRC;
    if (thumbObserver) {
      thumbObserver.observe(img);
    } else {
      ensureImageUrl(item.path)
        .then((url) => {
          if (url) img.src = url;
        })
        .catch(() => {});
    }
    div.appendChild(img);
    const label = document.createElement("div");
    label.className = "thumb-label";
    label.textContent = item.label || basename(item.path);
    div.appendChild(label);
    state.thumbsById.set(item.id, { rootEl: div, imgEl: img, labelEl: label });
    frag.appendChild(div);
  }
  els.filmstrip.appendChild(frag);
}

function appendFilmstripThumb(item) {
  if (!els.filmstrip || !item?.id || !item?.path) return;
  if (state.thumbsById.has(item.id)) return;
  ensureThumbObserver();
  const div = document.createElement("div");
  div.className = "thumb" + (item.id === state.activeId ? " selected" : "");
  div.dataset.id = item.id;
  const img = document.createElement("img");
  img.alt = item.label || basename(item.path) || "Artifact";
  img.loading = "lazy";
  img.decoding = "async";
  img.dataset.path = item.path;
  img.src = THUMB_PLACEHOLDER_SRC;
  if (thumbObserver) {
    thumbObserver.observe(img);
  } else {
    ensureImageUrl(item.path)
      .then((url) => {
        if (url) img.src = url;
      })
      .catch(() => {});
  }
  div.appendChild(img);
  const label = document.createElement("div");
  label.className = "thumb-label";
  label.textContent = item.label || basename(item.path);
  div.appendChild(label);
  state.thumbsById.set(item.id, { rootEl: div, imgEl: img, labelEl: label });
  els.filmstrip.appendChild(div);
}

function setFilmstripSelected(prevId, nextId) {
  if (prevId && prevId !== nextId) {
    const prev = state.thumbsById.get(prevId);
    if (prev?.rootEl) prev.rootEl.classList.remove("selected");
  }
  const next = state.thumbsById.get(nextId);
  if (next?.rootEl) next.rootEl.classList.add("selected");
}

function updateFilmstripThumb(item) {
  if (!item?.id) return;
  const rec = state.thumbsById.get(item.id);
  if (!rec) return;
  if (rec.labelEl) rec.labelEl.textContent = item.label || basename(item.path);
  if (rec.imgEl && item.path) {
    rec.imgEl.alt = item.label || basename(item.path) || "Artifact";
    rec.imgEl.dataset.path = item.path;
    rec.imgEl.src = THUMB_PLACEHOLDER_SRC;
    if (thumbObserver) {
      thumbObserver.observe(rec.imgEl);
    } else {
      ensureImageUrl(item.path)
        .then((url) => {
          if (url) rec.imgEl.src = url;
        })
        .catch(() => {});
    }
  }
}

async function setActiveImage(id) {
  const item = state.imagesById.get(id);
  if (!item) return;
  const prevActive = state.activeId;
  state.activeId = id;
  setFilmstripSelected(prevActive, id);
  clearSelection();
  showDropHint(false);
  renderSelectionMeta();
  chooseSpawnNodes();
  updatePortraitIdle();
  await setEngineActiveImage(item.path);
  if (!item.visionDesc) {
    scheduleVisionDescribe(item.path);
  }
  try {
    item.img = await loadImage(item.path);
    item.width = item.img?.naturalWidth || null;
    item.height = item.img?.naturalHeight || null;
  } catch (err) {
    console.error(err);
  }
  renderHudReadout();
  resetViewToFit();
  requestRender();
}

function addImage(item, { select = false } = {}) {
  if (!item || !item.id || !item.path) return;
  if (state.imagesById.has(item.id)) return;
  state.imagesById.set(item.id, item);
  state.images.push(item);
  appendFilmstripThumb(item);
  showDropHint(state.images.length === 0);
  if (select || !state.activeId) {
    setActiveImage(item.id).catch(() => {});
  }
}

function invalidateImageCache(path) {
  if (!path) return;
  const rec = state.imageCache.get(path);
  if (!rec) return;
  if (rec.url) {
    try {
      URL.revokeObjectURL(rec.url);
    } catch {
      // ignore
    }
  }
  state.imageCache.delete(path);
}

async function replaceImageInPlace(
  targetId,
  { path, receiptPath = null, kind = null, label = null, clearVision = true } = {}
) {
  const item = state.imagesById.get(targetId);
  if (!item || !path) return false;
  const oldPath = item.path;
  if (oldPath && oldPath !== path) invalidateImageCache(oldPath);
  // New paths are always new files; no need to invalidate unless we overwrite, but be safe.
  invalidateImageCache(path);

  item.path = path;
  item.receiptPath = receiptPath;
  if (kind) item.kind = kind;
  if (label && !item.label) item.label = label;
  item.img = null;
  item.width = null;
  item.height = null;
  if (clearVision) {
    item.visionDesc = null;
    item.visionPending = false;
    if (state.describePendingPath === oldPath) state.describePendingPath = null;
  }

  updateFilmstripThumb(item);
  if (state.activeId === targetId) {
    try {
      item.img = await loadImage(item.path);
      item.width = item.img?.naturalWidth || null;
      item.height = item.img?.naturalHeight || null;
    } catch (err) {
      console.error(err);
    }
    await setEngineActiveImage(item.path);
    if (!item.visionDesc) scheduleVisionDescribe(item.path);
    renderSelectionMeta();
    chooseSpawnNodes();
    renderHudReadout();
    resetViewToFit();
    requestRender();
  }
  return true;
}

async function setEngineActiveImage(path) {
  if (!state.ptySpawned) return;
  if (!path) return;
  await invoke("write_pty", { data: `/use ${path}\n` }).catch(() => {});
}

async function writeLocalReceipt({ artifactId, imagePath, operation, meta = {} }) {
  if (!state.runDir) return null;
  const receiptPath = `${state.runDir}/receipt-${artifactId}.json`;
  const payload = {
    schema_version: 1,
    request: {
      prompt: "",
      mode: "local",
      size: null,
      n: 1,
      seed: null,
      output_format: extname(imagePath).replace(".", "") || "png",
      inputs: { init_image: null, mask: null, reference_images: [] },
      provider: "local",
      model: null,
      provider_options: {},
      out_dir: state.runDir,
      metadata: { operation },
    },
    resolved: {
      provider: "local",
      model: null,
      size: null,
      width: null,
      height: null,
      output_format: extname(imagePath).replace(".", "") || "png",
      background: null,
      seed: null,
      n: 1,
      user: null,
      prompt: "",
      inputs: { init_image: null, mask: null, reference_images: [] },
      stream: false,
      partial_images: null,
      provider_params: {},
      warnings: [],
    },
    provider_request: {},
    provider_response: {},
    warnings: [],
    artifacts: { image_path: imagePath, receipt_path: receiptPath },
    result_metadata: { operation, ...meta, created_at: new Date().toISOString() },
  };
  await writeTextFile(receiptPath, JSON.stringify(payload, null, 2));
  return receiptPath;
}

async function importPhotos() {
  bumpInteraction();
  setStatus("Engine: pick photos…");
  const picked = await open({
    multiple: true,
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "heic"] },
    ],
  });
  const pickedPaths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (pickedPaths.length === 0) {
    setStatus("Engine: ready");
    return;
  }
  await ensureRun();
  const inputsDir = `${state.runDir}/inputs`;
  await createDir(inputsDir, { recursive: true }).catch(() => {});
  const stamp = Date.now();
  let ok = 0;
  let failed = 0;
  let lastErr = null;
  for (let idx = 0; idx < pickedPaths.length; idx += 1) {
    const src = pickedPaths[idx];
    if (typeof src !== "string" || !src) continue;
    try {
      const ext = extname(src);
      const safeExt = ext && ext.length <= 8 ? ext : ".png";
      const artifactId = `input-${stamp}-${String(idx).padStart(2, "0")}`;
      const dest = `${inputsDir}/${artifactId}${safeExt}`;
      await copyFile(src, dest);
      const receiptPath = await writeLocalReceipt({
        artifactId,
        imagePath: dest,
        operation: "import",
        meta: { source_path: src },
      });
      addImage(
        {
          id: artifactId,
          kind: "import",
          path: dest,
          receiptPath,
          label: basename(src),
        },
        { select: ok === 0 && !state.activeId }
      );
      ok += 1;
    } catch (err) {
      failed += 1;
      lastErr = err;
      console.error("Import failed:", src, err);
    }
  }
  if (ok > 0) {
    const suffix = failed ? ` (${failed} failed)` : "";
    setStatus(`Engine: imported ${ok} photo${ok === 1 ? "" : "s"}${suffix}`, failed > 0);
    const importedOnly =
      state.images.length === 2 && state.images.every((item) => item?.kind === "import");
    if (importedOnly) {
      setCanvasMode("multi");
      setTip("Suggested: Combine the two photos into a single image.");
      showToast("Suggested action: Combine", "tip", 2600);
    }
  } else {
    const msg = lastErr?.message || String(lastErr || "unknown error");
    setStatus(`Engine: import failed (${msg})`, true);
  }
}

async function cropSquare() {
  bumpInteraction();
  state.lastAction = "Square Crop";
  const imgItem = getActiveImage();
  if (!imgItem || !imgItem.img) return;
  await ensureRun();
  setImageFxActive(true, "Square Crop");
  portraitWorking("Square Crop");
  const img = imgItem.img;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const size = Math.min(w, h);
  const sx = Math.floor((w - size) / 2);
  const sy = Math.floor((h - size) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, size, size, 0, 0, size, size);
  try {
    await saveCanvasAsArtifact(canvas, {
      operation: "crop_square",
      label: "Square crop",
      replaceActive: true,
      targetId: imgItem.id,
    });
  } finally {
    setImageFxActive(false);
    updatePortraitIdle();
  }
}

async function aiReplaceBackground(style) {
  const imgItem = getActiveImage();
  if (!imgItem) {
    showToast("No image selected.", "error");
    return;
  }
  await ensureRun();
  const label = style === "sweep" ? "Soft Sweep" : "Studio White";
  setImageFxActive(true, label);
  portraitWorking(label);
  beginPendingReplace(imgItem.id, label);
  try {
    if (!state.ptySpawned) {
      await spawnEngine();
    }
    await setEngineActiveImage(imgItem.path);
    state.expectingArtifacts = true;
    state.lastAction = label;
    setStatus(`Engine: ${label}…`);
    showToast(`Morphing: ${label}`, "info", 2200);

    // Must start with "replace" for Brood's edit detection.
    const prompt =
      style === "sweep"
        ? "replace the background with a soft studio sweep background. keep the subject exactly the same. preserve logos and text. do not crop."
        : "replace the background with a seamless studio white background. keep the subject exactly the same. preserve logos and text. do not crop.";
    await invoke("write_pty", { data: `${prompt}\n` });
  } catch (err) {
    clearPendingReplace();
    setImageFxActive(false);
    updatePortraitIdle();
    throw err;
  }
}

async function applyBackground(style) {
  bumpInteraction();
  const imgItem = getActiveImage();
  if (!imgItem) {
    showToast("No image selected.", "error");
    return;
  }
  if (!imgItem.img) {
    setStatus("Engine: loading image…");
    try {
      imgItem.img = await loadImage(imgItem.path);
    } catch (err) {
      showToast("Failed to load image.", "error");
      setStatus("Engine: ready");
      return;
    }
    setStatus("Engine: ready");
  }
  // If the user hasn't lassoed, fall back to model-powered background replacement.
  if (!state.selection || !state.selection.points || state.selection.points.length < 3) {
    await aiReplaceBackground(style);
    return;
  }
  const label = style === "sweep" ? "Soft Sweep" : "Studio White";
  state.lastAction = `${label} (local)`;
  await ensureRun();
  setImageFxActive(true, label);
  portraitWorking(label);
  const img = imgItem.img;
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  const fgCanvas = document.createElement("canvas");
  fgCanvas.width = w;
  fgCanvas.height = h;
  const fgCtx = fgCanvas.getContext("2d");
  fgCtx.drawImage(img, 0, 0);

  // Build polygon mask in image pixel space.
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = w;
  maskCanvas.height = h;
  const maskCtx = maskCanvas.getContext("2d");
  maskCtx.clearRect(0, 0, w, h);
  maskCtx.fillStyle = "#fff";
  maskCtx.beginPath();
  const pts = state.selection.points;
  maskCtx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i += 1) {
    maskCtx.lineTo(pts[i].x, pts[i].y);
  }
  maskCtx.closePath();
  maskCtx.fill();

  fgCtx.globalCompositeOperation = "destination-in";
  fgCtx.drawImage(maskCanvas, 0, 0);
  fgCtx.globalCompositeOperation = "source-over";

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const outCtx = out.getContext("2d");
  if (style === "sweep") {
    const g = outCtx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(1, "#e9eef5");
    outCtx.fillStyle = g;
  } else {
    outCtx.fillStyle = "#ffffff";
  }
  outCtx.fillRect(0, 0, w, h);
  outCtx.drawImage(fgCanvas, 0, 0);

  try {
    await saveCanvasAsArtifact(out, {
      operation: "bg_replace",
      label: style === "sweep" ? "BG sweep" : "BG white",
      meta: { style, selection_points: pts.length },
      replaceActive: true,
      targetId: imgItem.id,
    });
    clearSelection();
    chooseSpawnNodes();
  } finally {
    setImageFxActive(false);
    updatePortraitIdle();
  }
}

async function saveCanvasAsArtifact(canvas, { operation, label, meta = {}, replaceActive = false, targetId = null }) {
  if (!state.runDir) return;
  const stamp = Date.now();
  const artifactId = `local-${operation}-${stamp}`;
  const imagePath = `${state.runDir}/artifact-${stamp}-${operation}.png`;
  setStatus("Engine: writing artifact…");
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Failed to encode PNG");
  const buf = new Uint8Array(await blob.arrayBuffer());
  await writeBinaryFile(imagePath, buf);
  const receiptPath = await writeLocalReceipt({
    artifactId,
    imagePath,
    operation,
    meta,
  });
  if (replaceActive) {
    const id = targetId || state.activeId;
    const ok = id ? await replaceImageInPlace(id, { path: imagePath, receiptPath, kind: "local" }) : false;
    if (!ok) {
      addImage(
        {
          id: artifactId,
          kind: "local",
          path: imagePath,
          receiptPath,
          label: label || operation,
        },
        { select: true }
      );
    }
  } else {
    addImage(
      {
        id: artifactId,
        kind: "local",
        path: imagePath,
        receiptPath,
        label: label || operation,
      },
      { select: true }
    );
  }
  setStatus("Engine: ready");
}

async function runVariations() {
  bumpInteraction();
  state.lastAction = "Variations";
  const imgItem = getActiveImage();
  if (!imgItem) return;
  await ensureRun();
  setImageFxActive(true, "Variations");
  portraitWorking("Variations");
  try {
    if (!state.ptySpawned) {
      await spawnEngine();
    }
    state.expectingArtifacts = true;
    setStatus("Engine: variations…");
    await invoke("write_pty", { data: `/recreate ${imgItem.path}\n` });
  } catch (err) {
    setImageFxActive(false);
    updatePortraitIdle();
    throw err;
  }
}

function quoteForPtyArg(value) {
  const raw = String(value || "");
  const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

async function runBlendPair() {
  bumpInteraction();
  if (state.pendingBlend) {
    showToast("Combine already running.", "tip", 2600);
    return;
  }
  if (!state.runDir) {
    await ensureRun();
  }
  if (state.images.length !== 2) {
    showToast("Combine needs exactly 2 photos in the run.", "error", 3200);
    return;
  }
  const okProvider = await ensureGeminiForBlend();
  if (!okProvider) {
    showToast("Combine requires a Gemini image model (multi-image).", "error", 3600);
    return;
  }
  const a = state.images[0];
  const b = state.images[1];
  if (!a?.path || !b?.path) {
    showToast("Combine failed: missing image paths.", "error", 3200);
    return;
  }

  if (!state.ptySpawned) {
    await spawnEngine();
  }
  setImageFxActive(true, "Combine");
  state.expectingArtifacts = true;
  state.pendingBlend = { sourceIds: [a.id, b.id], startedAt: Date.now() };
  state.lastAction = "Combine";
  setStatus("Engine: combine…");
  portraitWorking("Combine");
  showToast("Combining photos…", "info", 2200);
  requestRender();

  try {
    await invoke("write_pty", {
      data: `/blend ${quoteForPtyArg(a.path)} ${quoteForPtyArg(b.path)}\n`,
    });
  } catch (err) {
    console.error(err);
    state.expectingArtifacts = false;
    state.pendingBlend = null;
    setStatus(`Engine: combine failed (${err?.message || err})`, true);
    showToast("Combine failed to start.", "error", 3200);
    setImageFxActive(false);
    updatePortraitIdle();
  }
}

async function exportRun() {
  bumpInteraction();
  if (!state.runDir) return;
  const outPath = `${state.runDir}/export.html`;
  await invoke("export_run", { runDir: state.runDir, outPath });
  setStatus(`Engine: exported ${basename(outPath)}`);
}

async function ensureRun() {
  if (state.runDir) return;
  await createRun();
}

async function createRun() {
  setStatus("Engine: creating run…");
  const payload = await invoke("create_run_dir");
  state.runDir = payload.run_dir;
  state.eventsPath = payload.events_path;
  state.eventsByteOffset = 0;
  state.eventsTail = "";
  state.fallbackToFullRead = false;
  fallbackLineOffset = 0;
  state.images = [];
  state.imagesById.clear();
  state.activeId = null;
  state.canvasMode = "single";
  state.multiRects.clear();
  state.pendingBlend = null;
  clearImageCache();
  state.selection = null;
  state.lassoDraft = [];
  state.expectingArtifacts = false;
  state.lastRecreatePrompt = null;
  setRunInfo(`Run: ${state.runDir}`);
  setTip(DEFAULT_TIP);
  showDropHint(true);
  renderFilmstrip();
  chooseSpawnNodes();
  await spawnEngine();
  await startEventsPolling();
  setStatus("Engine: ready");
}

async function openExistingRun() {
  bumpInteraction();
  const selected = await open({ directory: true, multiple: false });
  if (!selected) return;
  state.runDir = selected;
  state.eventsPath = `${selected}/events.jsonl`;
  state.eventsByteOffset = 0;
  state.eventsTail = "";
  state.fallbackToFullRead = false;
  fallbackLineOffset = 0;
  state.images = [];
  state.imagesById.clear();
  state.activeId = null;
  state.canvasMode = "single";
  state.multiRects.clear();
  state.pendingBlend = null;
  renderFilmstrip();
  clearImageCache();
  state.selection = null;
  state.lassoDraft = [];
  state.expectingArtifacts = false;
  state.lastRecreatePrompt = null;
  setRunInfo(`Run: ${state.runDir}`);
  setTip(DEFAULT_TIP);
  showDropHint(true);
  await loadExistingArtifacts();
  await spawnEngine();
  await startEventsPolling();
  setStatus("Engine: ready");
}

async function loadExistingArtifacts() {
  if (!state.runDir) return;
  const entries = await readDir(state.runDir, { recursive: false }).catch(() => []);
  for (const entry of entries) {
    if (!entry?.name) continue;
    if (!entry.name.startsWith("receipt-") || !entry.name.endsWith(".json")) continue;
    const receiptPath = entry.path;
    let payload = null;
    try {
      payload = JSON.parse(await readTextFile(receiptPath));
    } catch {
      continue;
    }
    const imagePath = payload?.artifacts?.image_path;
    if (typeof imagePath !== "string" || !imagePath) continue;
    const artifactId = entry.name.slice("receipt-".length).replace(/\\.json$/, "");
    addImage(
      {
        id: artifactId,
        kind: "receipt",
        path: imagePath,
        receiptPath,
        label: basename(imagePath),
      },
      { select: false }
    );
  }
  // Select latest.
  if (state.images.length > 0 && !state.activeId) {
    await setActiveImage(state.images[state.images.length - 1].id);
  }
}

async function spawnEngine() {
  if (!state.runDir || !state.eventsPath) return;
  setStatus("Engine: starting…");
  try {
    await invoke("spawn_pty", {
      command: "brood",
      args: ["chat", "--out", state.runDir, "--events", state.eventsPath],
      cwd: state.runDir,
      env: { BROOD_MEMORY: settings.memory ? "1" : "0" },
    });
    state.ptySpawned = true;
    await invoke("write_pty", { data: `/text_model ${settings.textModel}\n` }).catch(() => {});
    await invoke("write_pty", { data: `/image_model ${settings.imageModel}\n` }).catch(() => {});
    setStatus("Engine: started");
  } catch (err) {
    console.error(err);
    setStatus(`Engine: failed (${err?.message || err})`, true);
  }
}

function startEventsPolling() {
  if (state.poller) return;
  // Poll fast, but incrementally (offset-based) for responsiveness.
  state.poller = setInterval(() => {
    pollEventsOnce().catch(() => {});
  }, 250);
}

async function pollEventsOnce() {
  if (!state.eventsPath) return;
  if (!(await exists(state.eventsPath))) return;
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    if (state.fallbackToFullRead) {
      await pollEventsFallback();
      return;
    }
    const resp = await invoke("read_file_since", {
      path: state.eventsPath,
      offset: state.eventsByteOffset,
      maxBytes: 1024 * 256,
    });
    const chunk = resp?.chunk || "";
    const newOffset = resp?.new_offset;
    if (typeof newOffset === "number") state.eventsByteOffset = newOffset;
    if (!chunk) return;
    state.eventsTail += chunk;
    const lines = state.eventsTail.split("\n");
    state.eventsTail = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleEvent(JSON.parse(trimmed));
      } catch {
        // ignore malformed
      }
    }
  } catch (err) {
    // Command missing or invoke failed; use old approach.
    console.warn("Incremental event reader failed, falling back:", err);
    state.fallbackToFullRead = true;
  } finally {
    state.pollInFlight = false;
  }
}

let fallbackLineOffset = 0;
async function pollEventsFallback() {
  const content = await readTextFile(state.eventsPath);
  const lines = content.trim().split("\n").filter(Boolean);
  for (let i = fallbackLineOffset; i < lines.length; i += 1) {
    try {
      handleEvent(JSON.parse(lines[i]));
    } catch {
      // ignore
    }
  }
  fallbackLineOffset = lines.length;
}

function handleEvent(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "artifact_created") {
    const id = event.artifact_id;
    const path = event.image_path;
    if (!id || !path) return;
    const wasBlend = Boolean(state.pendingBlend);
    if (wasBlend) {
      state.pendingBlend = null;
      state.canvasMode = "single";
      state.multiRects.clear();
      setTip(DEFAULT_TIP);
      showToast("Combine complete.", "tip", 2400);
    }
    const pending = state.pendingReplace;
    if (pending?.targetId) {
      const targetId = pending.targetId;
      clearPendingReplace();
      replaceImageInPlace(targetId, {
        path,
        receiptPath: event.receipt_path || null,
        kind: "engine",
      }).catch((err) => console.error(err));
    } else {
      addImage(
        {
          id,
          kind: "engine",
          path,
          receiptPath: event.receipt_path || null,
          label: basename(path),
        },
        { select: state.expectingArtifacts || !state.activeId }
      );
    }
    state.expectingArtifacts = false;
    setStatus("Engine: ready");
    updatePortraitIdle();
    setImageFxActive(false);
    renderHudReadout();
  } else if (event.type === "generation_failed") {
    const msg = event.error ? `Generation failed: ${event.error}` : "Generation failed.";
    setStatus(`Engine: ${msg}`, true);
    showToast(msg, "error", 3200);
    state.expectingArtifacts = false;
    state.pendingBlend = null;
    clearPendingReplace();
    updatePortraitIdle();
    setImageFxActive(false);
    renderHudReadout();
    chooseSpawnNodes();
    requestRender();
  } else if (event.type === "cost_latency_update") {
    state.lastCostLatency = {
      provider: event.provider,
      model: event.model,
      cost_total_usd: event.cost_total_usd,
      cost_per_1k_images_usd: event.cost_per_1k_images_usd,
      latency_per_image_s: event.latency_per_image_s,
      at: Date.now(),
    };
    renderHudReadout();
  } else if (event.type === "image_description") {
    const path = event.image_path;
    const desc = event.description;
    if (typeof path === "string" && typeof desc === "string" && desc.trim()) {
      const cleaned = desc.trim();
      for (const item of state.images) {
        if (item?.path === path) {
          item.visionDesc = cleaned;
          item.visionPending = false;
          item.visionDescMeta = {
            source: event.source || null,
            model: event.model || null,
            at: Date.now(),
          };
          break;
        }
      }
      if (state.describePendingPath === path) state.describePendingPath = null;
      if (getActiveImage()?.path === path) renderHudReadout();
    }
  } else if (event.type === "recreate_prompt_inferred") {
    const prompt = event.prompt;
    if (typeof prompt === "string") {
      state.lastRecreatePrompt = prompt;
      const ref = event.reference;
      if (typeof ref === "string" && ref) {
        for (const item of state.images) {
          if (item?.path === ref) {
            item.recreatePrompt = prompt;
            break;
          }
        }
      }
      setStatus("Engine: recreate (zero-prompt) running…");
    }
    renderHudReadout();
  } else if (event.type === "recreate_iteration_update") {
    const iter = event.iteration;
    const sim = event.similarity;
    if (typeof iter === "number") {
      const pct = typeof sim === "number" ? `${Math.round(sim * 100)}%` : "—";
      setStatus(`Engine: recreate iter ${iter} (best ${pct})`);
    }
    renderHudReadout();
  }
}

function renderMultiCanvas(wctx, octx, canvasW, canvasH) {
  const items = state.images || [];
  for (const item of items) {
    ensureCanvasImageLoaded(item);
  }

  state.multiRects = computeMultiRects(items, canvasW, canvasH);

  const dpr = getDpr();
  wctx.save();
  wctx.imageSmoothingEnabled = true;
  wctx.imageSmoothingQuality = "high";

  for (const item of items) {
    const rect = item?.id ? state.multiRects.get(item.id) : null;
    if (!rect) continue;
    const x = rect.x;
    const y = rect.y;
    const w = rect.w;
    const h = rect.h;
    if (item?.img) {
      wctx.drawImage(item.img, x, y, w, h);
    } else {
      const g = wctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, "rgba(18, 26, 37, 0.90)");
      g.addColorStop(1, "rgba(6, 8, 12, 0.96)");
      wctx.fillStyle = g;
      wctx.fillRect(x, y, w, h);
      wctx.fillStyle = "rgba(230, 237, 243, 0.65)";
      wctx.font = `${Math.max(11, Math.round(12 * dpr))}px IBM Plex Mono`;
      wctx.fillText("LOADING…", x + Math.round(12 * dpr), y + Math.round(22 * dpr));
    }

    // Tile frame.
    wctx.save();
    wctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
    wctx.strokeStyle = "rgba(54, 76, 106, 0.58)";
    wctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    wctx.shadowBlur = Math.round(10 * dpr);
    wctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    wctx.restore();
  }
  wctx.restore();

  // Active highlight.
  const activeRect = state.activeId ? state.multiRects.get(state.activeId) : null;
  if (activeRect) {
    octx.save();
    octx.lineWidth = Math.max(1, Math.round(2.0 * dpr));
    octx.strokeStyle = "rgba(255, 212, 0, 0.88)";
    octx.shadowColor = "rgba(255, 212, 0, 0.20)";
    octx.shadowBlur = Math.round(22 * dpr);
    octx.strokeRect(activeRect.x - 2, activeRect.y - 2, activeRect.w + 4, activeRect.h + 4);
    octx.restore();
  }

  const canSuggestBlend = items.length === 2 && !state.pendingBlend;
  if (!canSuggestBlend) return;
  const aRect = items[0]?.id ? state.multiRects.get(items[0].id) : null;
  const bRect = items[1]?.id ? state.multiRects.get(items[1].id) : null;
  if (!aRect || !bRect) return;

  const ax = aRect.x + aRect.w;
  const ay = aRect.y + aRect.h * 0.5;
  const bx = bRect.x;
  const by = bRect.y + bRect.h * 0.5;
  const mx = (ax + bx) * 0.5;
  const my = (ay + by) * 0.5;

  octx.save();
  octx.lineWidth = Math.max(1, Math.round(2 * dpr));
  octx.setLineDash([Math.round(10 * dpr), Math.round(8 * dpr)]);
  octx.strokeStyle = "rgba(255, 212, 0, 0.28)";
  octx.shadowColor = "rgba(255, 212, 0, 0.12)";
  octx.shadowBlur = Math.round(14 * dpr);
  octx.beginPath();
  octx.moveTo(ax + Math.round(8 * dpr), ay);
  octx.lineTo(bx - Math.round(8 * dpr), by);
  octx.stroke();
  octx.setLineDash([]);

  // Small tag that reads like a "system suggestion" connecting the two tiles.
  const label = "SUGGESTED: COMBINE";
  octx.font = `${Math.max(10, Math.round(11.5 * dpr))}px IBM Plex Mono`;
  const textW = octx.measureText(label).width;
  const padX = Math.round(10 * dpr);
  const padY = Math.round(6 * dpr);
  const tagW = Math.round(textW + padX * 2);
  const tagH = Math.round(22 * dpr);
  const tagX = Math.round(mx - tagW / 2);
  const tagY = Math.round(my - tagH / 2);
  const r = Math.round(9 * dpr);
  const roundRect = (ctx, x, y, w, h, radius) => {
    const rr = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  };
  roundRect(octx, tagX, tagY, tagW, tagH, r);
  octx.fillStyle = "rgba(8, 10, 14, 0.76)";
  octx.fill();
  octx.lineWidth = Math.max(1, Math.round(1 * dpr));
  octx.strokeStyle = "rgba(255, 212, 0, 0.32)";
  octx.stroke();
  octx.fillStyle = "rgba(255, 212, 0, 0.86)";
  octx.fillText(label, tagX + padX, tagY + tagH - padY);
  octx.restore();
}

function render() {
  const work = els.workCanvas;
  const overlay = els.overlayCanvas;
  if (!work || !overlay) return;
  const wctx = work.getContext("2d");
  const octx = overlay.getContext("2d");
  if (!wctx || !octx) return;

  wctx.clearRect(0, 0, work.width, work.height);
  octx.clearRect(0, 0, overlay.width, overlay.height);

  if (state.canvasMode === "multi") {
    renderMultiCanvas(wctx, octx, work.width, work.height);
    updateImageFxRect();
    return;
  }

  const item = getActiveImage();
  const img = item?.img;
  if (img) {
    wctx.save();
    wctx.setTransform(state.view.scale, 0, 0, state.view.scale, state.view.offsetX, state.view.offsetY);
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = "high";
    wctx.drawImage(img, 0, 0);
    wctx.restore();
  }
  updateImageFxRect();

  const pts = state.selection?.points || state.lassoDraft;
  if (pts && pts.length >= 2) {
    octx.save();
    octx.lineWidth = Math.max(1, Math.round(2 * getDpr()));
    octx.strokeStyle = "rgba(255, 179, 0, 0.95)";
    octx.fillStyle = "rgba(255, 179, 0, 0.12)";
    octx.beginPath();
    const c0 = imageToCanvas(pts[0]);
    octx.moveTo(c0.x, c0.y);
    for (let i = 1; i < pts.length; i += 1) {
      const c = imageToCanvas(pts[i]);
      octx.lineTo(c.x, c.y);
    }
    if (state.selection && state.selection.closed) {
      octx.closePath();
      octx.fill();
    }
    octx.stroke();
    octx.restore();
  }
}

function startSpawnTimer() {
  clearInterval(state.spawnTimer);
  state.spawnTimer = setInterval(() => {
    const idleForMs = Date.now() - state.lastInteractionAt;
    if (idleForMs < 18000) return;
    if (!state.activeId) return;
    if (state.tool === "lasso" && state.lassoDraft.length > 0) return;
    chooseSpawnNodes();
  }, 5000);
}

function installCanvasHandlers() {
  if (!els.overlayCanvas) return;

  els.overlayCanvas.addEventListener("pointerdown", (event) => {
    bumpInteraction();
    if (state.canvasMode === "multi") {
      const p = canvasPointFromEvent(event);
      const hit = hitTestMulti(p);
      if (hit) {
        setCanvasMode("single");
        setActiveImage(hit).catch(() => {});
      }
      return;
    }
    const img = getActiveImage();
    if (!img) return;
    els.overlayCanvas.setPointerCapture(event.pointerId);
    const p = canvasPointFromEvent(event);
    state.pointer.active = true;
    state.pointer.startX = p.x;
    state.pointer.startY = p.y;
    state.pointer.lastX = p.x;
    state.pointer.lastY = p.y;
    state.pointer.startOffsetX = state.view.offsetX;
    state.pointer.startOffsetY = state.view.offsetY;

    if (state.tool === "lasso") {
      state.selection = null;
      state.lassoDraft = [canvasToImage(p)];
      requestRender();
    }
  });

  els.overlayCanvas.addEventListener("pointermove", (event) => {
    if (!state.pointer.active) return;
    bumpInteraction();
    const p = canvasPointFromEvent(event);
    const dx = p.x - state.pointer.startX;
    const dy = p.y - state.pointer.startY;
    state.pointer.lastX = p.x;
    state.pointer.lastY = p.y;
    if (state.tool === "pan") {
      state.view.offsetX = state.pointer.startOffsetX + dx;
      state.view.offsetY = state.pointer.startOffsetY + dy;
      requestRender();
      return;
    }
    if (state.tool === "lasso") {
      const imgPt = canvasToImage(p);
      const last = state.lassoDraft[state.lassoDraft.length - 1];
      const dist2 = (imgPt.x - last.x) ** 2 + (imgPt.y - last.y) ** 2;
      const minDist = 4 / Math.max(state.view.scale, 0.25);
      if (dist2 >= minDist * minDist) {
        state.lassoDraft.push(imgPt);
        requestRender();
      }
    }
  });

  function finalizePointer(event) {
    if (!state.pointer.active) return;
    bumpInteraction();
    state.pointer.active = false;
    if (state.tool === "lasso") {
      if (state.lassoDraft.length >= 3) {
        state.selection = { points: state.lassoDraft.slice(), closed: true };
      } else {
        state.selection = null;
      }
      state.lassoDraft = [];
      renderSelectionMeta();
      chooseSpawnNodes();
      requestRender();
    }
    try {
      els.overlayCanvas.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  }

  els.overlayCanvas.addEventListener("pointerup", finalizePointer);
  els.overlayCanvas.addEventListener("pointercancel", finalizePointer);

  els.overlayCanvas.addEventListener(
    "wheel",
    (event) => {
      bumpInteraction();
      if (!getActiveImage()) return;
      if (state.canvasMode === "multi") {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const p = canvasPointFromEvent(event);
      const before = canvasToImage(p);
      const factor = Math.exp(-event.deltaY * 0.0012);
      const next = clamp(state.view.scale * factor, 0.05, 40);
      state.view.scale = next;
      state.view.offsetX = p.x - before.x * state.view.scale;
      state.view.offsetY = p.y - before.y * state.view.scale;
      renderHudReadout();
      requestRender();
    },
    { passive: false }
  );
}

function installDnD() {
  if (!els.canvasWrap) return;

  function stop(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  els.canvasWrap.addEventListener("dragover", stop);
  els.canvasWrap.addEventListener("dragenter", stop);
  els.canvasWrap.addEventListener("drop", async (event) => {
    stop(event);
    bumpInteraction();
    const files = Array.from(event.dataTransfer?.files || []);
    const paths = files.map((f) => f?.path).filter(Boolean);
    if (paths.length === 0) return;
    await ensureRun();
    const inputsDir = `${state.runDir}/inputs`;
    await createDir(inputsDir, { recursive: true }).catch(() => {});
    const stamp = Date.now();
    for (let idx = 0; idx < paths.length; idx += 1) {
      const src = paths[idx];
      const ext = extname(src);
      const safeExt = ext && ext.length <= 8 ? ext : ".png";
      const artifactId = `drop-${stamp}-${String(idx).padStart(2, "0")}`;
      const dest = `${inputsDir}/${artifactId}${safeExt}`;
      await copyFile(src, dest);
      const receiptPath = await writeLocalReceipt({
        artifactId,
        imagePath: dest,
        operation: "import",
        meta: { source_path: src },
      });
      addImage(
        {
          id: artifactId,
          kind: "import",
          path: dest,
          receiptPath,
          label: basename(src),
        },
        { select: idx === 0 && !state.activeId }
      );
    }
    setStatus(`Engine: imported ${paths.length} dropped file${paths.length === 1 ? "" : "s"}`);
    const importedOnly =
      state.images.length === 2 && state.images.every((item) => item?.kind === "import");
    if (importedOnly) {
      setCanvasMode("multi");
      setTip("Suggested: Combine the two photos into a single image.");
      showToast("Suggested action: Combine", "tip", 2600);
    }
  });
}

function installUi() {
  if (els.newRun) els.newRun.addEventListener("click", () => createRun().catch((e) => console.error(e)));
  if (els.openRun) els.openRun.addEventListener("click", () => openExistingRun().catch((e) => console.error(e)));
  if (els.import) els.import.addEventListener("click", () => importPhotos().catch((e) => console.error(e)));
  if (els.canvasImport) {
    els.canvasImport.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      importPhotos().catch((e) => console.error(e));
    });
  }
  if (els.export) els.export.addEventListener("click", () => exportRun().catch((e) => console.error(e)));

  if (els.settingsToggle && els.settingsDrawer) {
    els.settingsToggle.addEventListener("click", () => {
      bumpInteraction();
      els.settingsDrawer.classList.remove("hidden");
      refreshKeyStatus().catch(() => {});
    });
  }
  if (els.settingsClose && els.settingsDrawer) {
    els.settingsClose.addEventListener("click", () => {
      bumpInteraction();
      els.settingsDrawer.classList.add("hidden");
    });
  }

  if (els.memoryToggle) {
    els.memoryToggle.checked = settings.memory;
    els.memoryToggle.addEventListener("change", () => {
      bumpInteraction();
      settings.memory = els.memoryToggle.checked;
      localStorage.setItem("brood.memory", settings.memory ? "1" : "0");
      setStatus("Engine: memory applies next run");
    });
  }
  if (els.textModel) {
    els.textModel.value = settings.textModel;
    els.textModel.addEventListener("change", () => {
      bumpInteraction();
      settings.textModel = els.textModel.value;
      localStorage.setItem("brood.textModel", settings.textModel);
      if (state.ptySpawned) {
        invoke("write_pty", { data: `/text_model ${settings.textModel}\n` }).catch(() => {});
      }
    });
  }
  if (els.imageModel) {
    els.imageModel.value = settings.imageModel;
    els.imageModel.addEventListener("change", () => {
      bumpInteraction();
      settings.imageModel = els.imageModel.value;
      localStorage.setItem("brood.imageModel", settings.imageModel);
      updatePortraitIdle();
      if (state.ptySpawned) {
        invoke("write_pty", { data: `/image_model ${settings.imageModel}\n` }).catch(() => {});
      }
    });
  }

  for (const btn of els.toolButtons) {
    btn.addEventListener("click", () => {
      bumpInteraction();
      const tool = btn.dataset.tool;
      if (tool === "pan" || tool === "lasso") {
        setTool(tool);
        return;
      }
      if (tool === "bg") {
        applyBackground("white").catch((e) => console.error(e));
        return;
      }
      if (tool === "variations") {
        runVariations().catch((e) => console.error(e));
        return;
      }
    });
  }

  if (els.actionBgWhite) els.actionBgWhite.addEventListener("click", () => applyBackground("white").catch(() => {}));
  if (els.actionBgSweep) els.actionBgSweep.addEventListener("click", () => applyBackground("sweep").catch(() => {}));
  if (els.actionCropSquare) els.actionCropSquare.addEventListener("click", () => cropSquare().catch(() => {}));
  if (els.actionVariations) els.actionVariations.addEventListener("click", () => runVariations().catch(() => {}));

  if (els.filmstrip) {
    els.filmstrip.addEventListener("click", (event) => {
      const thumb = event?.target?.closest ? event.target.closest(".thumb") : null;
      if (!thumb || !els.filmstrip.contains(thumb)) return;
      const id = thumb.dataset?.id;
      if (!id) return;
      bumpInteraction();
      setActiveImage(id).catch(() => {});
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      clearSelection();
    } else if (event.key.toLowerCase() === "l") {
      setTool("lasso");
    } else if (event.key.toLowerCase() === "v") {
      setTool("pan");
    } else if (event.key.toLowerCase() === "f") {
      resetViewToFit();
    }
  });
}

async function boot() {
  if (!els.workCanvas || !els.overlayCanvas) {
    setStatus("Engine: UI error (missing canvas)", true);
    return;
  }

  setStatus("Engine: booting…");
  setRunInfo("No run");
  refreshKeyStatus().catch(() => {});
  ensurePortraitIndex().catch(() => {});
  showDropHint(true);
  renderSelectionMeta();
  chooseSpawnNodes();
  renderFilmstrip();
  ensureCanvasSize();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopLarvaAnimator();
    } else {
      ensureLarvaAnimator();
    }
  });

  new ResizeObserver(() => {
    ensureCanvasSize();
    requestRender();
  }).observe(els.canvasWrap);

  installCanvasHandlers();
  installDnD();
  installUi();
  startSpawnTimer();

  await listen("pty-exit", () => {
    setStatus("Engine: exited", true);
    state.ptySpawned = false;
    state.expectingArtifacts = false;
    state.pendingBlend = null;
    clearPendingReplace();
    setImageFxActive(false);
    updatePortraitIdle();
  });

  // Auto-create a run for speed; users can always "Open Run" later.
  await createRun();
  requestRender();
}

boot().catch((err) => {
  console.error(err);
  setStatus(`Engine: boot failed (${err?.message || err})`, true);
});
