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
  imageFx2: document.getElementById("image-fx-2"),
  overlayCanvas: document.getElementById("overlay-canvas"),
  annotatePanel: document.getElementById("annotate-panel"),
  annotateClose: document.getElementById("annotate-close"),
  annotateMeta: document.getElementById("annotate-meta"),
  annotateModel: document.getElementById("annotate-model"),
  annotateText: document.getElementById("annotate-text"),
  annotateCancel: document.getElementById("annotate-cancel"),
  annotateSend: document.getElementById("annotate-send"),
  markPanel: document.getElementById("mark-panel"),
  markTitle: document.getElementById("mark-title"),
  markClose: document.getElementById("mark-close"),
  markMeta: document.getElementById("mark-meta"),
  markText: document.getElementById("mark-text"),
  markDelete: document.getElementById("mark-delete"),
  markSave: document.getElementById("mark-save"),
  hud: document.getElementById("hud"),
  hudLineUnit: document.getElementById("hud-line-unit"),
  hudLineDirector: document.getElementById("hud-line-director"),
  hudDirectorKey: document.getElementById("hud-director-k"),
  hudDirectorVal: document.getElementById("hud-director-v"),
  hudLineDesc: document.getElementById("hud-line-desc"),
  hudLineSel: document.getElementById("hud-line-sel"),
  hudLineGen: document.getElementById("hud-line-gen"),
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
  designateMenu: document.getElementById("designate-menu"),
  imageMenu: document.getElementById("image-menu"),
  quickActions: document.getElementById("quick-actions"),
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
  ptySpawning: false,
  poller: null,
  pollInFlight: false,
  eventsByteOffset: 0,
  eventsTail: "",
  images: [],
  imagesById: new Map(),
  activeId: null,
  imageCache: new Map(), // path -> { url: string|null, urlPromise: Promise<string>|null, imgPromise: Promise<HTMLImageElement>|null }
  thumbsById: new Map(), // artifactId -> { rootEl, imgEl, labelEl }
  designationsByImageId: new Map(), // imageId -> [{ id, kind, x, y, at }]
  pendingDesignation: null, // { imageId, x, y, at } | null
  imageMenuTargetId: null,
  canvasMode: "single", // "single" renders the active image; "multi" renders all images for pair actions (Combine demo).
  multiRects: new Map(), // imageId -> { x, y, w, h } in canvas device pixels (for hit-testing).
  pendingBlend: null, // { sourceIds: [string, string], startedAt: number }
  pendingSwapDna: null, // { structureId: string, surfaceId: string, startedAt: number }
  pendingBridge: null, // { sourceIds: [string, string], startedAt: number }
  pendingArgue: null, // { sourceIds: [string, string], startedAt: number }
  pendingRecast: null, // { sourceId: string, startedAt: number }
  pendingDiagnose: null, // { sourceId: string, startedAt: number }
  pendingCanvasDiagnose: null, // { signature: string, startedAt: number, imagePath: string } | null
  autoCanvasDiagnoseSig: null,
  autoCanvasDiagnoseCompletedAt: 0,
  autoCanvasDiagnoseTimer: null,
  autoCanvasDiagnosePath: null,
  pendingGeneration: null, // { remaining: number, provider: string|null, model: string|null }
  pendingRecreate: null, // { startedAt: number } | null
  actionQueue: [],
  actionQueueActive: null, // { id, label, key, priority, enqueuedAt, source } | null
  actionQueueRunning: false,
  view: {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  },
  // Multi-mode doesn't use the single-image view transform, but users still expect panning.
  multiView: {
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
  annotateDraft: null, // { imageId, x0, y0, x1, y1, at } | null (image pixel space)
  annotateBox: null, // { imageId, x0, y0, x1, y1, at } | null (final box until dismissed)
  circleDraft: null, // { imageId, cx, cy, r, color, at } | null (image pixel space)
  circlesByImageId: new Map(), // imageId -> [{ id, cx, cy, r, color, label, at }]
  activeCircle: null, // { imageId, id } | null
  needsEngineModelResync: false, // restore `/image_model` to settings after one-off overrides.
  engineImageModelRestore: null, // string|null
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
  lastDirectorText: null,
  lastDirectorMeta: null, // { kind, source, model, at, paths }
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

const DEFAULT_TIP = "Click Studio White to replace the background. Use 4 (Lasso) if you want a manual mask.";
const VISUAL_PROMPT_FILENAME = "visual_prompt.json";
const VISUAL_PROMPT_SCHEMA_VERSION = 1;
const VISUAL_GRAMMAR_VERSION = "v0";

// Larva spawn buttons were a fun experiment, but we're turning them off for now.
// Keep the implementation in place so we can re-enable later.
const ENABLE_LARVA_SPAWN = false;
// Spawnbar actions (Studio White, Variations, etc) sit on the canvas "control surface".
// Disable by default; the inspector still contains Quick Actions.
const ENABLE_SPAWN_ACTIONS = false;

let visualPromptWriteTimer = null;
function scheduleVisualPromptWrite({ immediate = false } = {}) {
  if (!state.runDir) return;
  const delay = immediate ? 0 : 350;
  clearTimeout(visualPromptWriteTimer);
  visualPromptWriteTimer = setTimeout(() => {
    writeVisualPrompt().catch((err) => {
      console.warn("Failed to write visual prompt:", err);
    });
  }, delay);
}

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

function extractReceiptMeta(payload) {
  if (!payload || typeof payload !== "object") return null;
  const request = payload?.request || {};
  const resolved = payload?.resolved || {};
  const result = payload?.result_metadata || {};
  const provider = resolved?.provider || request?.provider || null;
  const model = resolved?.model || request?.model || null;
  const operation =
    request?.metadata?.operation ||
    request?.metadata?.action ||
    result?.operation ||
    request?.mode ||
    null;
  const cost_total_usd = typeof result?.cost_total_usd === "number" ? result.cost_total_usd : null;
  const latency_per_image_s = typeof result?.latency_per_image_s === "number" ? result.latency_per_image_s : null;
  return { provider, model, operation, cost_total_usd, latency_per_image_s };
}

async function ensureReceiptMeta(item) {
  if (!item?.receiptPath) return;
  if (item.receiptMetaChecked) return;
  if (item.receiptMetaLoading) return;
  item.receiptMetaLoading = true;
  try {
    const payload = JSON.parse(await readTextFile(item.receiptPath));
    item.receiptMeta = extractReceiptMeta(payload);
  } catch {
    item.receiptMeta = null;
  } finally {
    item.receiptMetaChecked = true;
    item.receiptMetaLoading = false;
  }
  if (getActiveImage()?.id === item.id) {
    renderHudReadout();
  }
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
  const zoomScale = state.canvasMode === "multi" ? state.multiView.scale || 1 : state.view.scale || 1;
  // HUD is always visible; show placeholders when no image is loaded.
  if (!hasImage) {
    const sel = state.selection?.points?.length >= 3 ? `${state.selection.points.length} pts` : "none";
    const zoomPct = Math.round(zoomScale * 100);
    if (els.hudUnitName) els.hudUnitName.textContent = "NO IMAGE";
    if (els.hudUnitDesc) els.hudUnitDesc.textContent = "Tap or drag to add photos";
    if (els.hudUnitSel) els.hudUnitSel.textContent = `${sel} · ${state.tool} · ${zoomPct}%`;
    if (els.hudUnitStat) els.hudUnitStat.textContent = state.ptySpawned ? "ready" : "engine offline";
    if (els.hudLineDirector) els.hudLineDirector.classList.add("hidden");
    if (els.hudDirectorVal) els.hudDirectorVal.textContent = "";
    if (els.hudDirectorKey) els.hudDirectorKey.textContent = "DIR";
    if (els.hudLineDesc) els.hudLineDesc.classList.remove("hidden");
    if (els.hudLineSel) els.hudLineSel.classList.remove("hidden");
    if (els.hudLineGen) els.hudLineGen.classList.remove("hidden");
    return;
  }

  // Best-effort per-image receipt metadata (provider/model/cost) for the HUD.
  if (img && img.receiptPath && !img.receiptMetaChecked && !img.receiptMetaLoading) {
    ensureReceiptMeta(img).catch(() => {});
  }

  const name = basename(img.path) || "Untitled";
  const dims = img?.width && img?.height ? ` (${img.width}x${img.height})` : "";
  if (els.hudUnitName) els.hudUnitName.textContent = `${name}${dims}`;

  let desc = "";
  if (img?.visionDesc) {
    desc = clampText(img.visionDesc, 32);
  } else if (img?.visionPending) {
    desc = "SCANNING…";
  } else if (img?.path && describeQueued.has(img.path)) {
    desc = state.ptySpawned ? "QUEUED…" : state.ptySpawning ? "STARTING…" : "ENGINE OFFLINE";
  } else {
    const allowVision = state.keyStatus ? Boolean(state.keyStatus.openai || state.keyStatus.gemini) : true;
    if (!state.ptySpawned) desc = "ENGINE OFFLINE";
    else desc = allowVision ? "—" : "NO VISION KEYS";
  }
  if (els.hudUnitDesc) els.hudUnitDesc.textContent = desc || "—";

  const sel = state.selection?.points?.length >= 3 ? `${state.selection.points.length} pts` : "none";
  const zoomPct = Math.round(zoomScale * 100);
  if (els.hudUnitSel) els.hudUnitSel.textContent = `${sel} · ${state.tool} · ${zoomPct}%`;

  const meta = img?.receiptMeta || null;
  const opRaw = meta?.operation || img?.kind || null;
  const operation = opRaw ? String(opRaw).replace(/_/g, " ").trim() : "";
  const provider = meta?.provider ? String(meta.provider) : "";
  const model = meta?.model ? String(meta.model) : "";
  const gen = provider && model ? `${provider}:${model}` : provider || model || "";
  const cost = formatUsd(meta?.cost_total_usd);
  const lat = formatSeconds(meta?.latency_per_image_s);
  const pieces = [];
  if (operation) pieces.push(operation);
  if (gen) pieces.push(gen);
  if (cost) pieces.push(cost);
  if (lat) pieces.push(`${lat}/img`);
  const vmeta = img?.visionDescMeta || null;
  if (vmeta && (vmeta.source || vmeta.model)) {
    const src = vmeta.source ? String(vmeta.source).replace(/_vision$/i, "") : "vision";
    const mdl = vmeta.model ? String(vmeta.model) : "";
    pieces.push(`vision:${src}${mdl ? `:${mdl}` : ""}`);
  }
  if (els.hudUnitStat) els.hudUnitStat.textContent = pieces.length ? pieces.join(" · ") : "—";

  const directorRaw = state.lastDirectorText ? String(state.lastDirectorText) : "";
  const directorMeta = state.lastDirectorMeta && typeof state.lastDirectorMeta === "object" ? state.lastDirectorMeta : null;
  const directorKind = directorMeta?.kind ? String(directorMeta.kind) : "";
  let directorText = directorRaw.trim();
  if (directorText.length > 8000) directorText = `${directorText.slice(0, 7999).trimEnd()}\n…`;
  const hasDirector = Boolean(directorText);

  if (els.hudDirectorKey) {
    let key = "DIR";
    if (directorKind === "diagnose") key = "DIAG";
    if (directorKind === "argue") key = "ARG";
    els.hudDirectorKey.textContent = key;
  }
  if (els.hudDirectorVal) els.hudDirectorVal.textContent = directorText || "";
  if (els.hudLineDirector) els.hudLineDirector.classList.toggle("hidden", !hasDirector);
  // Keep the HUD focused when CD output is present.
  if (els.hudLineDesc) els.hudLineDesc.classList.toggle("hidden", hasDirector);
  if (els.hudLineSel) els.hudLineSel.classList.toggle("hidden", hasDirector);
  if (els.hudLineGen) els.hudLineGen.classList.toggle("hidden", hasDirector);
}

// Give vision requests enough time to complete under normal network conditions.
// (Engine-side OpenAI timeout is ~22s; keep a little buffer.)
const DESCRIBE_TIMEOUT_MS = 30000;
let describeQueue = [];
let describeQueued = new Set(); // path strings
let describeInFlightPath = null;
let describeInFlightTimer = null;
let ptyLineBuffer = "";

let ptyStatusPromise = null;
async function ensureEngineSpawned({ reason = "engine" } = {}) {
  if (state.ptySpawned) return true;
  if (state.ptySpawning) return false;
  if (!state.runDir || !state.eventsPath) return false;

  // Try to re-sync with the Rust backend in dev/HMR scenarios where the PTY
  // may still be alive but the frontend state was reset.
  try {
    if (!ptyStatusPromise) {
      ptyStatusPromise = invoke("get_pty_status").finally(() => {
        ptyStatusPromise = null;
      });
    }
    const status = await ptyStatusPromise;
    if (status && typeof status === "object" && status.running) {
      state.ptySpawned = true;
      setStatus("Engine: connected");
      return true;
    }
  } catch (_) {
    // Ignore and fall back to spawning.
  }

  await spawnEngine();
  if (!state.ptySpawned) {
    showToast(`Engine failed to start for ${reason}.`, "error", 3200);
  }
  return Boolean(state.ptySpawned);
}

function allowVisionDescribe() {
  return state.keyStatus ? Boolean(state.keyStatus.openai || state.keyStatus.gemini) : true;
}

function resetDescribeQueue({ clearPending = false } = {}) {
  describeQueue = [];
  describeQueued.clear();
  describeInFlightPath = null;
  clearTimeout(describeInFlightTimer);
  describeInFlightTimer = null;
  state.describePendingPath = null;

  if (!clearPending) return;
  for (const item of state.images) {
    if (item && item.visionPending && !item.visionDesc) {
      item.visionPending = false;
    }
  }
  renderHudReadout();
}

function processDescribeQueue() {
  if (describeInFlightPath) return;
  // Treat describe as background work; don't compete with queued actions.
  if (state.actionQueueActive || state.actionQueue.length || isEngineBusy()) return;
  if (!state.ptySpawned) {
    if (describeQueue.length > 0) {
      ensureEngineSpawned({ reason: "vision" })
        .then(() => {
          processDescribeQueue();
        })
        .catch(() => {});
    }
    return;
  }
  if (!allowVisionDescribe()) {
    resetDescribeQueue({ clearPending: true });
    return;
  }

  while (describeQueue.length) {
    const path = describeQueue.shift();
    if (typeof path !== "string" || !path) continue;
    describeQueued.delete(path);

    const item = state.images.find((img) => img?.path === path) || null;
    if (item && item.visionDesc) {
      item.visionPending = false;
      continue;
    }

    if (item) {
      item.visionPending = true;
      item.visionPendingAt = Date.now();
    }

    describeInFlightPath = path;
    state.describePendingPath = path;
    if (getActiveImage()?.path === path) renderHudReadout();

    // NOTE: do not quote paths here. `/describe` uses a raw arg string (not shlex-split),
    // so adding quotes would become part of the path and fail to resolve.
    invoke("write_pty", { data: `/describe ${path}\n` }).catch(() => {
      // Backend PTY might have exited; re-spawn and continue.
      state.ptySpawned = false;
      _completeDescribeInFlight({
        description: null,
        errorMessage: "Engine disconnected. Restarting…",
      });
      ensureEngineSpawned({ reason: "vision" }).catch(() => {});
    });

    clearTimeout(describeInFlightTimer);
    describeInFlightTimer = setTimeout(() => {
      describeInFlightTimer = null;
      const inflight = describeInFlightPath;
      if (!inflight) return;
      const img = state.images.find((it) => it?.path === inflight) || null;
      if (img && img.visionPending && !img.visionDesc) img.visionPending = false;
      if (state.describePendingPath === inflight) state.describePendingPath = null;
      describeInFlightPath = null;
      if (getActiveImage()?.path === inflight) renderHudReadout();
      processDescribeQueue();
    }, DESCRIBE_TIMEOUT_MS);

    return;
  }
}

function scheduleVisionDescribe(path, { priority = false } = {}) {
  if (!path) return;
  if (!allowVisionDescribe()) return;

  const item = state.images.find((img) => img?.path === path) || null;
  if (item) {
    if (item.visionDesc) return;
  }

  if (describeInFlightPath === path) return;
  if (describeQueued.has(path)) {
    // If a user focuses an image, bump it to the front of the queue.
    if (priority) {
      describeQueue = [path, ...describeQueue.filter((p) => p !== path)];
      processDescribeQueue();
    }
    return;
  }
  if (priority) describeQueue.unshift(path);
  else describeQueue.push(path);
  describeQueued.add(path);
  if (getActiveImage()?.path === path) renderHudReadout();
  processDescribeQueue();
}

function _completeDescribeInFlight({
  description = null,
  meta = null, // { source, model }
  errorMessage = null,
} = {}) {
  const inflight = describeInFlightPath || state.describePendingPath || null;
  if (!inflight) return;
  const item = state.images.find((img) => img?.path === inflight) || null;
  if (item) {
    if (typeof description === "string" && description.trim()) {
      item.visionDesc = description.trim();
      item.visionDescMeta = {
        source: meta?.source || null,
        model: meta?.model || null,
        at: Date.now(),
      };
    }
    item.visionPending = false;
  }
  if (state.describePendingPath === inflight) state.describePendingPath = null;

  describeQueued.delete(inflight);
  describeInFlightPath = null;
  clearTimeout(describeInFlightTimer);
  describeInFlightTimer = null;

  if (errorMessage) {
    showToast(errorMessage, "error", 3200);
  }
  if (getActiveImage()?.path === inflight) renderHudReadout();
  processDescribeQueue();
}

function _handlePtyLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;

  // Successful describe output from engine:
  //   Description (openai_vision, gpt-5-nano): Purple surface plastic
  if (trimmed.startsWith("Description")) {
    const parts = trimmed.split(":", 2);
    if (parts.length >= 2) {
      const metaPart = parts[0] || "";
      const descPart = parts[1] || "";
      const desc = descPart.trim();
      if (!desc) return;

      let source = null;
      let model = null;
      const openIdx = metaPart.indexOf("(");
      const closeIdx = metaPart.indexOf(")");
      if (openIdx >= 0 && closeIdx > openIdx) {
        const raw = metaPart.slice(openIdx + 1, closeIdx);
        const items = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (items.length >= 1) source = items[0];
        if (items.length >= 2) model = items[1];
      }

      _completeDescribeInFlight({ description: desc, meta: { source, model } });
    }
    return;
  }

  // Common failure paths from engine when describe can't run.
  if (trimmed.startsWith("Describe unavailable")) {
    _completeDescribeInFlight({
      description: null,
      errorMessage: "Vision describe unavailable. Check OpenAI/Gemini keys and network.",
    });
    return;
  }
  if (trimmed.startsWith("Describe failed")) {
    _completeDescribeInFlight({
      description: null,
      errorMessage: trimmed,
    });
  }
}

function scheduleVisionDescribeAll() {
  if (!allowVisionDescribe()) return;
  const active = getActiveImage();
  if (active?.path) scheduleVisionDescribe(active.path, { priority: true });
  for (const item of state.images) {
    if (!item?.path) continue;
    if (active?.path && item.path === active.path) continue;
    scheduleVisionDescribe(item.path);
  }
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

function pickGeminiFastImageModel() {
  const desired = "gemini-2.5-flash-image";
  if (!els.imageModel) return desired;
  const hasDesired = Array.from(els.imageModel.options || []).some((opt) => opt?.value === desired);
  return hasDesired ? desired : pickGeminiImageModel();
}

// Action-specific model routing (quick actions / tools that drive the engine).
const ACTION_IMAGE_MODEL = {
  bg_replace: "gemini-2.5-flash-image",
  surprise: "gemini-2.5-flash-image",
  combine: "gemini-3-pro-image-preview",
  swap_dna: "gemini-3-pro-image-preview",
  bridge: "gemini-3-pro-image-preview",
  recast: "gemini-3-pro-image-preview",
  remove_people: "gemini-3-pro-image-preview",
};

async function ensureGeminiForBlend() {
  const provider = providerFromModel(settings.imageModel);
  if (provider === "gemini") return true;
  const nextModel = pickGeminiImageModel();
  settings.imageModel = nextModel;
  localStorage.setItem("brood.imageModel", settings.imageModel);
  if (els.imageModel) els.imageModel.value = settings.imageModel;
  updatePortraitIdle({ fromSettings: true });
  if (state.ptySpawned) {
    await invoke("write_pty", { data: `/image_model ${settings.imageModel}\n` }).catch(() => {});
  }
  showToast(`Combine requires Gemini. Switched image model to ${settings.imageModel}.`, "tip", 3200);
  return providerFromModel(settings.imageModel) === "gemini";
}

async function ensureGeminiProImagePreviewForAction(actionLabel = "This action") {
  const desired = "gemini-3-pro-image-preview";
  const provider = providerFromModel(settings.imageModel);
  if (provider === "gemini" && settings.imageModel === desired) return true;

  let nextModel = desired;
  if (els.imageModel) {
    const hasDesired = Array.from(els.imageModel.options || []).some((opt) => opt?.value === desired);
    if (!hasDesired) nextModel = pickGeminiImageModel();
  }

  const changed = settings.imageModel !== nextModel;
  settings.imageModel = nextModel;
  localStorage.setItem("brood.imageModel", settings.imageModel);
  if (els.imageModel) els.imageModel.value = settings.imageModel;
  updatePortraitIdle({ fromSettings: true });
  if (state.ptySpawned) {
    await invoke("write_pty", { data: `/image_model ${settings.imageModel}\n` }).catch(() => {});
  }

  if (changed) {
    if (nextModel === desired) {
      showToast(`${actionLabel} uses Gemini Pro. Switched image model to ${settings.imageModel}.`, "tip", 3200);
    } else {
      showToast(`${actionLabel} prefers ${desired}. Using ${settings.imageModel}.`, "tip", 3400);
    }
  }

  return providerFromModel(settings.imageModel) === "gemini";
}

async function ensureGeminiProImagePreviewForSwapDna() {
  return await ensureGeminiProImagePreviewForAction("Swap DNA");
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

function setPortrait({ title, provider, busy } = {}) {
  // Always show the portrait dock (blank placeholders when clips aren't available).
  if (els.portraitDock) els.portraitDock.classList.remove("hidden");
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

function setPortrait2({ title, provider, busy } = {}) {
  // Always show the portrait dock (blank placeholders when clips aren't available).
  if (els.portraitDock) els.portraitDock.classList.remove("hidden");
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

function updatePortraitIdle({ fromSettings = false } = {}) {
  // Persist the last provider we showed during an action until another action
  // replaces it (visual only; does not affect provider routing).
  //
  // When invoked from a settings change, prefer the selected model's provider.
  const providerDefault = providerFromModel(settings.imageModel);
  const provider = fromSettings ? providerDefault : state.portrait.provider || providerDefault;
  const hasImage = Boolean(state.activeId);
  const index = state.portraitMedia.index;
  const provider2Default = secondaryProviderFor(provider, index);
  const provider2 = fromSettings ? provider2Default : state.portrait2.provider || provider2Default;
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

function portraitWorking(_actionLabel, { providerOverride = null, clearDirector = true } = {}) {
  if (clearDirector && (state.lastDirectorText || state.lastDirectorMeta)) {
    state.lastDirectorText = null;
    state.lastDirectorMeta = null;
  }
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

function setDirectorText(text, meta = null) {
  state.lastDirectorText = text ? String(text) : null;
  state.lastDirectorMeta = meta && typeof meta === "object" ? meta : null;
  renderHudReadout();
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

let lastHudHeightCssPx = null;
let hudResizeObserver = null;
function syncHudHeightVar() {
  if (!els.canvasWrap || !els.hud) return;
  // "HUD" height should match the central readout shell, not the action grid.
  const hudShell = els.hud.querySelector(".hud-shell") || els.hud;
  const rect = hudShell.getBoundingClientRect();
  const h = Math.max(0, Math.round(rect.height));
  // Avoid setting 0px during early boot/layout churn; it would hide bumpers.
  if (!h) return;
  const next = `${h}px`;
  if (next === lastHudHeightCssPx) return;
  lastHudHeightCssPx = next;
  els.canvasWrap.style.setProperty("--hud-h", next);
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

let dprWatchMql = null;
let dprWatchListener = null;
function installDprWatcher() {
  if (!("matchMedia" in window)) return;

  if (dprWatchMql && dprWatchListener) {
    try {
      if (typeof dprWatchMql.removeEventListener === "function") dprWatchMql.removeEventListener("change", dprWatchListener);
      else if (typeof dprWatchMql.removeListener === "function") dprWatchMql.removeListener(dprWatchListener);
    } catch {
      // ignore
    }
  }

  // Watch DPR changes even when layout size doesn't change (multi-monitor scaling / backing scale changes).
  const dpr = window.devicePixelRatio || 1;
  dprWatchMql = window.matchMedia(`(resolution: ${dpr}dppx)`);
  dprWatchListener = () => {
    ensureCanvasSize();
    requestRender();
    // Re-arm the watcher for the new DPR value.
    installDprWatcher();
  };
  try {
    if (typeof dprWatchMql.addEventListener === "function") dprWatchMql.addEventListener("change", dprWatchListener);
    else if (typeof dprWatchMql.addListener === "function") dprWatchMql.addListener(dprWatchListener);
  } catch {
    // ignore
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

function canvasCssPointFromEvent(event) {
  const ox = event?.offsetX;
  const oy = event?.offsetY;
  if (typeof ox === "number" && typeof oy === "number" && Number.isFinite(ox) && Number.isFinite(oy)) {
    return { x: ox, y: oy };
  }
  const rect = els.overlayCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return { x, y };
}

function showDesignateMenuAt(ptCss) {
  const menu = els.designateMenu;
  const wrap = els.canvasWrap;
  if (!menu || !wrap || !ptCss) return;
  menu.classList.remove("dismissing");
  menu.classList.remove("hidden");

  const dx = 12;
  const dy = 12;
  const x0 = (Number(ptCss.x) || 0) + dx;
  const y0 = (Number(ptCss.y) || 0) + dy;

  menu.style.left = `${x0}px`;
  menu.style.top = `${y0}px`;

  requestAnimationFrame(() => {
    const mw = menu.offsetWidth || 0;
    const mh = menu.offsetHeight || 0;
    const maxX = Math.max(8, wrap.clientWidth - mw - 8);
    const maxY = Math.max(8, wrap.clientHeight - mh - 8);
    const x = clamp(x0, 8, maxX);
    const y = clamp(y0, 8, maxY);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  });
}

function canvasToImage(pt) {
  const img = getActiveImage();
  if (!img) return { x: 0, y: 0 };
  if (state.canvasMode === "multi") {
    const ms = state.multiView?.scale || 1;
    const mx = state.multiView?.offsetX || 0;
    const my = state.multiView?.offsetY || 0;
    const rect = img?.id ? state.multiRects.get(img.id) : null;
    if (rect) {
      const iw = img?.img?.naturalWidth || img?.width || rect.w || 1;
      const ih = img?.img?.naturalHeight || img?.height || rect.h || 1;
      const lx = (pt.x - mx) / Math.max(ms, 0.0001);
      const ly = (pt.y - my) / Math.max(ms, 0.0001);
      return {
        x: ((lx - rect.x) * iw) / Math.max(1, rect.w),
        y: ((ly - rect.y) * ih) / Math.max(1, rect.h),
      };
    }
  }
  return {
    x: (pt.x - state.view.offsetX) / state.view.scale,
    y: (pt.y - state.view.offsetY) / state.view.scale,
  };
}

function imageToCanvas(pt) {
  if (state.canvasMode === "multi") {
    const img = getActiveImage();
    const ms = state.multiView?.scale || 1;
    const mx = state.multiView?.offsetX || 0;
    const my = state.multiView?.offsetY || 0;
    const rect = img?.id ? state.multiRects.get(img.id) : null;
    if (img && rect) {
      const iw = img?.img?.naturalWidth || img?.width || rect.w || 1;
      const ih = img?.img?.naturalHeight || img?.height || rect.h || 1;
      const lx = rect.x + (pt.x * rect.w) / Math.max(1, iw);
      const ly = rect.y + (pt.y * rect.h) / Math.max(1, ih);
      return {
        x: mx + lx * ms,
        y: my + ly * ms,
      };
    }
  }
  return {
    x: state.view.offsetX + pt.x * state.view.scale,
    y: state.view.offsetY + pt.y * state.view.scale,
  };
}

function circleImageToCanvasGeom(circle) {
  if (!circle) return { cx: 0, cy: 0, r: 0 };
  const cxImg = Number(circle.cx) || 0;
  const cyImg = Number(circle.cy) || 0;
  const rImg = Math.max(0, Number(circle.r) || 0);
  const c = imageToCanvas({ x: cxImg, y: cyImg });
  const edge = imageToCanvas({ x: cxImg + rImg, y: cyImg });
  const rPx = Math.max(0, Math.hypot(edge.x - c.x, edge.y - c.y));
  return { cx: c.x, cy: c.y, r: rPx };
}

function hitTestCircleMarks(ptCanvas, circles) {
  if (!ptCanvas || !Array.isArray(circles) || circles.length === 0) return null;
  const tol = Math.max(8, Math.round(10 * getDpr()));
  for (let i = circles.length - 1; i >= 0; i -= 1) {
    const circle = circles[i];
    if (!circle) continue;
    const geom = circleImageToCanvasGeom(circle);
    if (!geom.r) continue;
    const dist = Math.hypot(ptCanvas.x - geom.cx, ptCanvas.y - geom.cy);
    if (Math.abs(dist - geom.r) <= tol) return circle;
    if (geom.r < tol && dist <= geom.r + tol) return circle;
  }
  return null;
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
  if (next === "multi") {
    state.multiView.scale = 1;
    state.multiView.offsetX = 0;
    state.multiView.offsetY = 0;
  }
  state.pointer.active = false;
  state.selection = null;
  state.lassoDraft = [];
  state.annotateDraft = null;
  state.annotateBox = null;
  hideAnnotatePanel();
  state.circleDraft = null;
  hideMarkPanel();
  state.pendingDesignation = null;
  hideDesignateMenu();
  chooseSpawnNodes();
  renderFilmstrip();
  if (next === "multi") {
    scheduleVisionDescribeAll();
  }
  renderSelectionMeta();
  scheduleVisualPromptWrite();
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

function computeAutoCanvasDiagnoseSignature() {
  const paths = (state.images || [])
    .map((item) => (item?.path ? String(item.path) : ""))
    .filter(Boolean)
    .sort();
  return paths.join("|");
}

function scheduleAutoCanvasDiagnose({ debounceMs = 1200 } = {}) {
  if (!state.runDir) return;
  if ((state.images?.length || 0) < 2) return;
  const signature = computeAutoCanvasDiagnoseSignature();
  if (!signature) return;
  const now = Date.now();
  // Avoid re-running constantly for the same canvas.
  if (signature === state.autoCanvasDiagnoseSig && now - (state.autoCanvasDiagnoseCompletedAt || 0) < 60_000) return;

  clearTimeout(state.autoCanvasDiagnoseTimer);
  state.autoCanvasDiagnoseTimer = setTimeout(() => {
    state.autoCanvasDiagnoseTimer = null;
    runAutoCanvasDiagnose(signature).catch((err) => console.error(err));
  }, Math.max(250, Number(debounceMs) || 1200));
}

async function runAutoCanvasDiagnose(signature) {
  if (!state.runDir) return;
  if ((state.images?.length || 0) < 2) return;
  if (!signature || signature !== computeAutoCanvasDiagnoseSignature()) return;
  if (state.pendingCanvasDiagnose) return;

  // Don't contend with foreground actions.
  if (
    state.pendingBlend ||
    state.pendingSwapDna ||
    state.pendingBridge ||
    state.pendingArgue ||
    state.pendingRecast ||
    state.pendingDiagnose ||
    state.expectingArtifacts ||
    state.pendingReplace
  ) {
    scheduleAutoCanvasDiagnose({ debounceMs: 1800 });
    return;
  }

  const ok = await ensureEngineSpawned({ reason: "canvas diagnose" });
  if (!ok) return;

  const snapshotCanvas = await renderCanvasSnapshotForDiagnose().catch((err) => {
    console.error(err);
    return null;
  });
  if (!snapshotCanvas) return;

  const outPath = `${state.runDir}/tmp-canvas-diagnose-${Date.now()}.png`;
  await writeCanvasPngToPath(snapshotCanvas, outPath);
  state.pendingCanvasDiagnose = { signature, startedAt: Date.now(), imagePath: outPath };
  state.autoCanvasDiagnosePath = outPath;
  setStatus("Director: canvas diagnose…");
  await invoke("write_pty", { data: `/diagnose ${quoteForPtyArg(outPath)}\n` }).catch(() => {});
}

async function renderCanvasSnapshotForDiagnose({ maxDimPx = 1200 } = {}) {
  const baseCanvas = els.workCanvas;
  const dpr = getDpr();
  const baseW = baseCanvas?.width || Math.round(900 * dpr);
  const baseH = baseCanvas?.height || Math.round(700 * dpr);
  const maxDim = Math.max(420 * dpr, Math.round(Number(maxDimPx) * dpr));
  const scale = Math.min(1, maxDim / Math.max(1, Math.max(baseW, baseH)));
  const w = Math.max(1, Math.round(baseW * scale));
  const h = Math.max(1, Math.round(baseH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "rgba(18, 26, 37, 0.92)");
  bg.addColorStop(1, "rgba(6, 8, 12, 0.96)");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const rects = computeMultiRects(state.images || [], w, h);
  for (const item of state.images || []) {
    if (!item?.id || !item?.path) continue;
    const rect = rects.get(item.id);
    if (!rect) continue;
    if (!item.img) {
      try {
        item.img = await loadImage(item.path);
        item.width = item.img?.naturalWidth || item.width || null;
        item.height = item.img?.naturalHeight || item.height || null;
      } catch {
        continue;
      }
    }
    if (!item.img) continue;
    ctx.drawImage(item.img, rect.x, rect.y, rect.w, rect.h);
  }
  return canvas;
}

function hitTestMulti(pt) {
  if (!pt) return null;
  const ms = state.multiView?.scale || 1;
  const mx = state.multiView?.offsetX || 0;
  const my = state.multiView?.offsetY || 0;
  const x = (pt.x - mx) / Math.max(ms, 0.0001);
  const y = (pt.y - my) / Math.max(ms, 0.0001);
  const entries = Array.from(state.multiRects.entries());
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [id, rect] = entries[i];
    if (!rect) continue;
    if (x < rect.x || x > rect.x + rect.w) continue;
    if (y < rect.y || y > rect.y + rect.h) continue;
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
  scheduleVisualPromptWrite();
  requestRender();
}

function getActiveImageRectCss() {
  const dpr = getDpr();
  if (state.canvasMode === "multi") {
    const ms = state.multiView?.scale || 1;
    const mx = state.multiView?.offsetX || 0;
    const my = state.multiView?.offsetY || 0;
    const rect = state.activeId ? state.multiRects.get(state.activeId) : null;
    if (!rect) return null;
    return {
      left: (mx + rect.x * ms) / dpr,
      top: (my + rect.y * ms) / dpr,
      width: (rect.w * ms) / dpr,
      height: (rect.h * ms) / dpr,
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

function getImageRectCss(imageId) {
  if (!imageId) return null;
  if (state.canvasMode === "multi") {
    const dpr = getDpr();
    const ms = state.multiView?.scale || 1;
    const mx = state.multiView?.offsetX || 0;
    const my = state.multiView?.offsetY || 0;
    const rect = state.multiRects.get(imageId) || null;
    if (!rect) return null;
    return {
      left: (mx + rect.x * ms) / dpr,
      top: (my + rect.y * ms) / dpr,
      width: (rect.w * ms) / dpr,
      height: (rect.h * ms) / dpr,
    };
  }
  if (state.canvasMode !== "single") return null;
  if (state.activeId !== imageId) return null;
  return getActiveImageRectCss();
}

function getImageFxTargets() {
  const swap = state.pendingSwapDna;
  if (swap?.structureId && swap?.surfaceId) return [swap.structureId, swap.surfaceId];

  const blend = state.pendingBlend?.sourceIds;
  if (Array.isArray(blend) && blend.length >= 2) return [blend[0], blend[1]];

  const bridge = state.pendingBridge?.sourceIds;
  if (Array.isArray(bridge) && bridge.length >= 2) return [bridge[0], bridge[1]];

  const replaceId = state.pendingReplace?.targetId;
  if (replaceId) return [replaceId];

  const recastId = state.pendingRecast?.sourceId;
  if (recastId) return [recastId];

  const activeId = state.activeId;
  if (activeId) return [activeId];
  return [];
}

function updateImageFxRect() {
  const fx1 = els.imageFx;
  const fx2 = els.imageFx2;
  if (!fx1) return;
  if (fx1.classList.contains("hidden")) {
    if (fx2) fx2.classList.add("hidden");
    return;
  }

  const setRect = (el, rect) => {
    if (!el) return;
    if (!rect) {
      el.style.width = "0px";
      el.style.height = "0px";
      return;
    }
    el.style.left = `${rect.left.toFixed(2)}px`;
    el.style.top = `${rect.top.toFixed(2)}px`;
    el.style.width = `${Math.max(0, rect.width).toFixed(2)}px`;
    el.style.height = `${Math.max(0, rect.height).toFixed(2)}px`;
  };

  const targets = getImageFxTargets();
  const rect1 = targets[0] ? getImageRectCss(targets[0]) : getActiveImageRectCss();
  setRect(fx1, rect1);

  if (!fx2) return;
  const rect2 = targets[1] ? getImageRectCss(targets[1]) : null;
  fx2.classList.toggle("hidden", !rect2);
  setRect(fx2, rect2);
}

function setImageFxActive(active, label = null) {
  state.imageFx.active = Boolean(active);
  state.imageFx.label = label || null;
  if (els.imageFx) els.imageFx.classList.toggle("hidden", !state.imageFx.active);
  if (els.imageFx2) els.imageFx2.classList.toggle("hidden", !state.imageFx.active);
  if (state.imageFx.active) updateImageFxRect();
  requestRender();
}

function beginPendingReplace(targetId, label, extra = null) {
  if (!targetId) return;
  const payload = { targetId, startedAt: Date.now(), label: label || null };
  if (extra && typeof extra === "object") {
    for (const [key, value] of Object.entries(extra)) {
      // Prevent accidental override of the core routing keys.
      if (key === "targetId" || key === "startedAt") continue;
      payload[key] = value;
    }
  }
  state.pendingReplace = payload;
}

function clearPendingReplace() {
  state.pendingReplace = null;
}

function clearSelection() {
  state.selection = null;
  state.lassoDraft = [];
  state.pendingDesignation = null;
  state.annotateDraft = null;
  state.annotateBox = null;
  state.circleDraft = null;
  hideMarkPanel();
  hideDesignateMenu();
  hideAnnotatePanel();
  setTip(DEFAULT_TIP);
  scheduleVisualPromptWrite();
  requestRender();
  renderSelectionMeta();
  renderHudReadout();
}

function setTool(tool) {
  const allowed = new Set(["annotate", "pan", "lasso", "designate"]);
  if (!allowed.has(tool)) return;
  if (tool !== "annotate") {
    state.annotateDraft = null;
    state.annotateBox = null;
    hideAnnotatePanel();
    state.circleDraft = null;
    hideMarkPanel();
  }
  if (tool !== "designate") state.pendingDesignation = null;
  hideDesignateMenu();
  state.tool = tool;
  for (const btn of els.toolButtons) {
    const t = btn.dataset.tool;
    btn.classList.toggle("selected", t === tool);
  }
  renderSelectionMeta();
  renderHudReadout();
  if (tool === "lasso") {
    setTip("Lasso your product, then click Studio White. Or skip lasso and let the model infer the subject.");
  } else if (tool === "annotate") {
    setTip("Annotate: drag a box to edit. Hold Shift to draw a red circle label.");
  } else if (tool === "designate") {
    setTip("Designate: click the image to place a point, then pick Subject/Reference/Object.");
  } else {
    setTip(DEFAULT_TIP);
  }
  scheduleVisualPromptWrite();
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
    state.pendingDesignation = null;
    hideDesignateMenu();
    return;
  }
  const name = basename(img.path);
  const sel = state.selection ? `${state.selection.points.length} pts` : "none";
  if (els.selectionMeta) els.selectionMeta.textContent = `${name}\nSelection: ${sel}`;
  renderHudReadout();
}

function _getDesignations(imageId) {
  const key = String(imageId || "");
  if (!key) return [];
  const existing = state.designationsByImageId.get(key);
  return Array.isArray(existing) ? existing : [];
}

function hideDesignateMenu() {
  hideDesignateMenuAnimated({ animate: false });
}

let designateMenuHideTimer = null;
function hideDesignateMenuAnimated({ animate = true } = {}) {
  const menu = els.designateMenu;
  if (!menu) return;
  clearTimeout(designateMenuHideTimer);
  designateMenuHideTimer = null;
  menu.classList.remove("dismissing");

  if (!animate) {
    for (const btn of menu.querySelectorAll("button.confirm")) {
      btn.classList.remove("confirm");
    }
    menu.classList.add("hidden");
    return;
  }
  if (menu.classList.contains("hidden")) return;
  menu.classList.add("dismissing");
  designateMenuHideTimer = setTimeout(() => {
    if (!els.designateMenu) return;
    els.designateMenu.classList.add("hidden");
    els.designateMenu.classList.remove("dismissing");
    for (const btn of els.designateMenu.querySelectorAll("button.confirm")) {
      btn.classList.remove("confirm");
    }
  }, 240);
}

function hideImageMenu() {
  if (!els.imageMenu) return;
  els.imageMenu.classList.add("hidden");
  state.imageMenuTargetId = null;
}

function showImageMenuAt(ptCss, imageId) {
  const menu = els.imageMenu;
  const wrap = els.canvasWrap;
  if (!menu || !wrap || !ptCss || !imageId) return;
  state.imageMenuTargetId = String(imageId);
  menu.classList.remove("hidden");

  const dx = 12;
  const dy = 12;
  const x0 = (Number(ptCss.x) || 0) + dx;
  const y0 = (Number(ptCss.y) || 0) + dy;

  menu.style.left = `${x0}px`;
  menu.style.top = `${y0}px`;

  requestAnimationFrame(() => {
    const mw = menu.offsetWidth || 0;
    const mh = menu.offsetHeight || 0;
    const maxX = Math.max(8, wrap.clientWidth - mw - 8);
    const maxY = Math.max(8, wrap.clientHeight - mh - 8);
    const x = clamp(x0, 8, maxX);
    const y = clamp(y0, 8, maxY);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  });
}

function showDesignateMenuAtHudKey() {
  const menu = els.designateMenu;
  const wrap = els.canvasWrap;
  if (!menu || !wrap) return;
  const btn = els.toolButtons.find((b) => b?.dataset?.tool === "designate") || null;
  if (!btn) return;
  const wrapRect = wrap.getBoundingClientRect();
  const keyRect = btn.getBoundingClientRect();
  const x = keyRect.left - wrapRect.left;
  const y = keyRect.bottom - wrapRect.top;
  showDesignateMenuAt({ x, y });
}

function hideAnnotatePanel() {
  if (!els.annotatePanel) return;
  els.annotatePanel.classList.add("hidden");
}

function _annotateBoxToCssRect(box) {
  if (!box) return null;
  const dpr = getDpr();
  const a = imageToCanvas({ x: Number(box.x0) || 0, y: Number(box.y0) || 0 });
  const b = imageToCanvas({ x: Number(box.x1) || 0, y: Number(box.y1) || 0 });
  const left = Math.min(a.x, b.x) / dpr;
  const top = Math.min(a.y, b.y) / dpr;
  const right = Math.max(a.x, b.x) / dpr;
  const bottom = Math.max(a.y, b.y) / dpr;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function _normalizeAnnotateBox(box, img) {
  if (!box) return null;
  const x0 = Number(box.x0) || 0;
  const y0 = Number(box.y0) || 0;
  const x1 = Number(box.x1) || 0;
  const y1 = Number(box.y1) || 0;
  let left = Math.min(x0, x1);
  let top = Math.min(y0, y1);
  let right = Math.max(x0, x1);
  let bottom = Math.max(y0, y1);
  const iw = img?.img?.naturalWidth || img?.width || null;
  const ih = img?.img?.naturalHeight || img?.height || null;
  if (iw && ih) {
    left = clamp(left, 0, iw);
    right = clamp(right, 0, iw);
    top = clamp(top, 0, ih);
    bottom = clamp(bottom, 0, ih);
  }
  return { imageId: box.imageId, x0: left, y0: top, x1: right, y1: bottom, at: box.at || Date.now() };
}

function showAnnotatePanelForBox() {
  const panel = els.annotatePanel;
  const wrap = els.canvasWrap;
  const img = getActiveImage();
  const box = state.annotateBox;
  if (!panel || !wrap || !img || !box || box.imageId !== img.id) return;

  // Populate model selector from the main image model dropdown.
  if (els.annotateModel && els.imageModel) {
    els.annotateModel.innerHTML = "";
    for (const opt of Array.from(els.imageModel.options || [])) {
      if (!opt?.value) continue;
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.textContent || opt.value;
      els.annotateModel.appendChild(o);
    }
    els.annotateModel.value = settings.imageModel;
  }

  const normalized = _normalizeAnnotateBox(box, img);
  if (!normalized) return;
  const iw = img?.img?.naturalWidth || img?.width || null;
  const ih = img?.img?.naturalHeight || img?.height || null;
  if (els.annotateMeta) {
    if (iw && ih) {
      const xPct = (normalized.x0 / iw) * 100;
      const yPct = (normalized.y0 / ih) * 100;
      const wPct = ((normalized.x1 - normalized.x0) / iw) * 100;
      const hPct = ((normalized.y1 - normalized.y0) / ih) * 100;
      els.annotateMeta.textContent = `Box: x ${xPct.toFixed(1)}% y ${yPct.toFixed(1)}% w ${wPct.toFixed(1)}% h ${hPct.toFixed(1)}%`;
    } else {
      const wPx = Math.max(0, normalized.x1 - normalized.x0);
      const hPx = Math.max(0, normalized.y1 - normalized.y0);
      els.annotateMeta.textContent = `Box: x ${Math.round(normalized.x0)} y ${Math.round(normalized.y0)} w ${Math.round(wPx)} h ${Math.round(hPx)}`;
    }
  }

  // Position near the box, clamped within canvas.
  panel.classList.remove("hidden");
  const rect = _annotateBoxToCssRect(normalized);
  const baseX = rect ? rect.right + 12 : 12;
  const baseY = rect ? rect.top : 12;
  panel.style.left = `${baseX}px`;
  panel.style.top = `${baseY}px`;

  requestAnimationFrame(() => {
    const pw = panel.offsetWidth || 0;
    const ph = panel.offsetHeight || 0;
    const maxX = Math.max(8, wrap.clientWidth - pw - 8);
    const maxY = Math.max(8, wrap.clientHeight - ph - 8);
    let x = clamp(baseX, 8, maxX);
    let y = clamp(baseY, 8, maxY);
    // If it doesn't fit to the right, prefer left of the box.
    if (rect && x >= maxX && rect.left - pw - 12 >= 8) {
      x = clamp(rect.left - pw - 12, 8, maxX);
    }
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });

  // Focus input for speed.
  setTimeout(() => {
    try {
      if (els.annotateText) els.annotateText.focus();
    } catch {
      // ignore
    }
  }, 0);
}

function _getCircles(imageId) {
  const key = String(imageId || "");
  if (!key) return [];
  const existing = state.circlesByImageId.get(key);
  return Array.isArray(existing) ? existing : [];
}

function hideMarkPanel() {
  if (!els.markPanel) return;
  els.markPanel.classList.add("hidden");
  state.activeCircle = null;
}

function showMarkPanelForCircle(circle) {
  const panel = els.markPanel;
  const wrap = els.canvasWrap;
  const img = getActiveImage();
  if (!panel || !wrap || !img || !circle || circle.imageId !== img.id) return;

  panel.classList.remove("hidden");
  state.activeCircle = { imageId: circle.imageId, id: circle.id };

  if (els.markTitle) {
    els.markTitle.textContent = "Circle";
  }

  const iw = img?.img?.naturalWidth || img?.width || null;
  const ih = img?.img?.naturalHeight || img?.height || null;
  if (els.markMeta) {
    if (iw && ih) {
      const xPct = (Number(circle.cx) / iw) * 100;
      const yPct = (Number(circle.cy) / ih) * 100;
      const rPct = (Number(circle.r) / Math.max(1, Math.min(iw, ih))) * 100;
      els.markMeta.textContent = `Circle: x ${xPct.toFixed(1)}% y ${yPct.toFixed(1)}% r ${rPct.toFixed(1)}%`;
    } else {
      els.markMeta.textContent = `Circle: x ${Math.round(Number(circle.cx) || 0)} y ${Math.round(Number(circle.cy) || 0)} r ${Math.round(
        Number(circle.r) || 0
      )} (px)`;
    }
  }

  if (els.markText) {
    els.markText.value = String(circle.label || "");
  }

  // Position near the circle (prefer right side), clamped within canvas.
  const dpr = getDpr();
  const c = imageToCanvas({ x: Number(circle.cx) || 0, y: Number(circle.cy) || 0 });
  const edge = imageToCanvas({ x: (Number(circle.cx) || 0) + (Number(circle.r) || 0), y: Number(circle.cy) || 0 });
  const rPx = Math.max(0, Math.hypot(edge.x - c.x, edge.y - c.y));
  const baseX = (c.x + rPx) / dpr + 12;
  const baseY = c.y / dpr - 10;
  panel.style.left = `${baseX}px`;
  panel.style.top = `${baseY}px`;

  requestAnimationFrame(() => {
    const pw = panel.offsetWidth || 0;
    const ph = panel.offsetHeight || 0;
    const maxX = Math.max(8, wrap.clientWidth - pw - 8);
    const maxY = Math.max(8, wrap.clientHeight - ph - 8);
    const x = clamp(baseX, 8, maxX);
    const y = clamp(baseY, 8, maxY);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });

  // Focus input for speed.
  setTimeout(() => {
    try {
      if (els.markText) els.markText.focus();
    } catch {
      // ignore
    }
  }, 0);
}

function getActiveCircle() {
  const sel = state.activeCircle;
  if (!sel?.imageId || !sel?.id) return null;
  const list = _getCircles(sel.imageId);
  return list.find((c) => c && c.id === sel.id) || null;
}

function updateActiveCircleLabel(label) {
  const sel = state.activeCircle;
  if (!sel?.imageId || !sel?.id) return false;
  const nextLabel = String(label || "").trim();
  const list = _getCircles(sel.imageId).slice();
  const idx = list.findIndex((c) => c && c.id === sel.id);
  if (idx < 0) return false;
  list[idx] = { ...list[idx], label: nextLabel };
  state.circlesByImageId.set(sel.imageId, list);
  scheduleVisualPromptWrite();
  requestRender();
  return true;
}

function deleteActiveCircle() {
  const sel = state.activeCircle;
  if (!sel?.imageId || !sel?.id) return false;
  const list = _getCircles(sel.imageId).slice();
  const next = list.filter((c) => c && c.id !== sel.id);
  state.circlesByImageId.set(sel.imageId, next);
  hideMarkPanel();
  scheduleVisualPromptWrite();
  requestRender();
  return true;
}

function _commitDesignation(kind) {
  const pending = state.pendingDesignation;
  const img = getActiveImage();
  if (!img || !pending || pending.imageId !== img.id) return false;
  const entry = {
    id: `d-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind: String(kind || "mark"),
    x: Number(pending.x) || 0,
    y: Number(pending.y) || 0,
    at: Date.now(),
  };
  const list = _getDesignations(img.id).slice();
  list.push(entry);
  state.designationsByImageId.set(img.id, list);
  state.pendingDesignation = null;
  scheduleVisualPromptWrite();
  requestRender();
  return true;
}

function _clearDesignations() {
  const img = getActiveImage();
  if (!img) return;
  state.designationsByImageId.delete(img.id);
  if (state.pendingDesignation?.imageId === img.id) state.pendingDesignation = null;
  scheduleVisualPromptWrite();
  requestRender();
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
  if (!ENABLE_SPAWN_ACTIONS) {
    els.spawnbar.innerHTML = "";
    els.spawnbar.classList.add("hidden");
    stopLarvaAnimator();
    state.larvaTargets = [];
    return;
  }
  els.spawnbar.classList.remove("hidden");
  els.spawnbar.innerHTML = "";
  stopLarvaAnimator();
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
    btn.className = ENABLE_LARVA_SPAWN ? "spawn-node" : "spawn-action";
    btn.setAttribute("aria-label", node.title || "Action");
    const text = String(node.title || "");
    if (!ENABLE_LARVA_SPAWN) {
      btn.textContent = text;
    } else {
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
    }
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
  if (ENABLE_LARVA_SPAWN) ensureLarvaAnimator();
}

function isMultiActionRunning() {
  return Boolean(state.pendingBlend || state.pendingSwapDna || state.pendingBridge || state.pendingArgue);
}

const ACTION_QUEUE_MAX = 32;
const ACTION_QUEUE_PRIORITY = {
  user: 100,
  background: 10,
};

function isEngineBusy() {
  return Boolean(
    state.ptySpawning ||
      state.pendingBlend ||
      state.pendingSwapDna ||
      state.pendingBridge ||
      state.pendingArgue ||
      state.pendingRecast ||
      state.pendingDiagnose ||
      state.pendingReplace ||
      state.pendingRecreate ||
      state.expectingArtifacts
  );
}

function resetActionQueue() {
  state.actionQueue = [];
  state.actionQueueActive = null;
  state.actionQueueRunning = false;
}

function _actionQueueMakeId() {
  return `aq-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function enqueueAction({ label, key = null, priority = ACTION_QUEUE_PRIORITY.user, source = "user", run } = {}) {
  const fn = typeof run === "function" ? run : null;
  if (!label || !fn) return false;

  if (key && state.actionQueueActive?.key && state.actionQueueActive.key === key) {
    showToast(`${label} already running.`, "tip", 1800);
    return false;
  }

  const now = Date.now();
  if (key) {
    // De-dupe repeated clicks; keep latest request.
    state.actionQueue = state.actionQueue.filter((item) => item?.key !== key);
  }

  state.actionQueue.push({
    id: _actionQueueMakeId(),
    label: String(label),
    key: key ? String(key) : null,
    priority: typeof priority === "number" ? priority : ACTION_QUEUE_PRIORITY.user,
    enqueuedAt: now,
    source: source ? String(source) : "user",
    run: fn,
  });

  // Keep queue bounded by dropping the lowest-priority oldest items.
  while (state.actionQueue.length > ACTION_QUEUE_MAX) {
    let dropIdx = 0;
    for (let i = 1; i < state.actionQueue.length; i += 1) {
      const a = state.actionQueue[i];
      const b = state.actionQueue[dropIdx];
      const ap = typeof a?.priority === "number" ? a.priority : 0;
      const bp = typeof b?.priority === "number" ? b.priority : 0;
      if (ap < bp) {
        dropIdx = i;
        continue;
      }
      if (ap === bp && (a?.enqueuedAt || 0) < (b?.enqueuedAt || 0)) {
        dropIdx = i;
      }
    }
    state.actionQueue.splice(dropIdx, 1);
  }

  showToast(`Queued: ${label}`, "tip", 1400);
  renderQuickActions();
  processActionQueue().catch(() => {});
  return true;
}

function _pickNextQueuedActionIndex() {
  if (!state.actionQueue.length) return -1;
  let bestIdx = 0;
  for (let i = 1; i < state.actionQueue.length; i += 1) {
    const a = state.actionQueue[i];
    const b = state.actionQueue[bestIdx];
    const ap = typeof a?.priority === "number" ? a.priority : 0;
    const bp = typeof b?.priority === "number" ? b.priority : 0;
    if (ap > bp) {
      bestIdx = i;
      continue;
    }
    if (ap === bp && (a?.enqueuedAt || 0) < (b?.enqueuedAt || 0)) {
      bestIdx = i;
    }
  }
  return bestIdx;
}

async function processActionQueue() {
  if (state.actionQueueRunning) return;
  state.actionQueueRunning = true;
  try {
    if (state.actionQueueActive && !isEngineBusy()) {
      state.actionQueueActive = null;
      renderQuickActions();
    }

    while (!state.actionQueueActive && !isEngineBusy() && state.actionQueue.length) {
      const idx = _pickNextQueuedActionIndex();
      if (idx < 0) return;
      const item = state.actionQueue.splice(idx, 1)[0];
      if (!item) return;

      state.actionQueueActive = {
        id: item.id,
        label: item.label,
        key: item.key || null,
        priority: item.priority,
        enqueuedAt: item.enqueuedAt,
        source: item.source || "user",
      };
      renderQuickActions();

      try {
        await Promise.resolve(item.run());
      } catch (err) {
        console.error("Queued action failed:", item?.label, err);
        showToast(`${item?.label || "Action"} failed to start.`, "error", 3200);
      }

      if (isEngineBusy()) {
        // Engine-driven action is in flight; completion events will resume the queue.
        return;
      }

      // Completed immediately (local action or no-op); continue draining.
      state.actionQueueActive = null;
      renderQuickActions();
    }
  } finally {
    state.actionQueueRunning = false;
  }
}

function chooseSpawnNodes() {
  if (!ENABLE_SPAWN_ACTIONS) {
    state.spawnNodes = [];
    renderSpawnbar();
    renderQuickActions();
    return;
  }
  if (!state.activeId) {
    state.spawnNodes = [];
    renderSpawnbar();
    renderQuickActions();
    return;
  }
  const img = getActiveImage();
  const items = [];
  if (state.canvasMode === "multi") {
    const canBlend = state.images.length === 2 && !isMultiActionRunning();
    if (canBlend) items.push({ id: "blend_pair", title: "Combine", action: "blend_pair" });
  }
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
  renderQuickActions();
}

function respawnActions() {
  bumpInteraction();
  if (!ENABLE_SPAWN_ACTIONS) {
    showToast("Canvas actions are hidden.", "tip", 2000);
    return;
  }
  const imgId = getActiveImage()?.id || state.activeId || null;
  if (!imgId) {
    showToast("No image selected.", "tip", 2200);
    return;
  }
  const prefix = `${String(imgId)}::`;
  for (const key of Array.from(state.spawnCooldowns.keys())) {
    if (String(key).startsWith(prefix)) state.spawnCooldowns.delete(key);
  }
  chooseSpawnNodes();
  showToast("Actions respawned.", "tip", 1600);
}

function computeQuickActions() {
  // Scaffolding: keep this as a pure function of current canvas state so we can
  // grow rules over time without entangling UI code.
  const actions = [];
  const active = getActiveImage();

  if (!active) {
    actions.push({
      id: "no_image",
      label: "Import photos to unlock actions",
      disabled: true,
    });
    return actions;
  }

  // When the canvas itself is multi-image, prefer multi-image actions and hide
  // single-image actions to reduce ambiguity.
  if (state.canvasMode === "multi") {
    actions.push({
      id: "single_view",
      label: "Single view",
      title: "Show one image at a time (restores single-image actions)",
      disabled: false,
      onClick: () => setCanvasMode("single"),
    });
    if (state.images.length === 2) {
      actions.push({
        id: "combine",
        label: state.pendingBlend ? "Combine (running…)" : "Combine",
        title: "Blend the two loaded photos into one",
        disabled: false,
        onClick: () => runBlendPair().catch((err) => console.error(err)),
      });
      actions.push({
        id: "bridge",
        label: state.pendingBridge ? "Bridge (running…)" : "Bridge",
        title: "Find the aesthetic midpoint between the two images (not a collage)",
        disabled: false,
        onClick: () => runBridgePair().catch((err) => console.error(err)),
      });
      actions.push({
        id: "swap_dna",
        label: state.pendingSwapDna ? "Swap DNA (running…)" : "Swap DNA",
        title: "Use structure from the selected image and surface qualities from the other (Shift-click to invert)",
        disabled: false,
        onClick: (ev) =>
          runSwapDnaPair({ invert: Boolean(ev?.shiftKey) }).catch((err) => console.error(err)),
      });
      actions.push({
        id: "argue",
        label: state.pendingArgue ? "Argue (running…)" : "Argue",
        title: "Debate the two directions (why each is stronger, with visual evidence)",
        disabled: false,
        onClick: () => runArguePair().catch((err) => console.error(err)),
      });
      return actions;
    }
    const n = state.images.length || 0;
    const hint =
      n <= 1
        ? "Multi-image actions need 2 photos in the run."
        : `Multi-image actions need exactly 2 photos (you have ${n}).`;
    actions.push({ id: "multi_hint", label: hint, disabled: true });
    // Fall through to single-image actions for the active image.
  }

  const iw = active?.img?.naturalWidth || active?.width || null;
  const ih = active?.img?.naturalHeight || active?.height || null;
  const canCropSquare = Boolean(iw && ih && Math.abs(iw - ih) > 8);

  if (state.canvasMode !== "multi" && state.images.length > 1) {
    actions.push({
      id: "multi_view",
      label: "Multi view",
      title: "Show all loaded photos (enables 2-photo actions when exactly 2 photos are loaded)",
      disabled: false,
      onClick: () => setCanvasMode("multi"),
    });
  }

  actions.push({
    id: "diagnose",
    label: state.pendingDiagnose ? "Diagnose (running…)" : "Diagnose",
    title: "Creative-director diagnosis: what's working, what isn't, and what to fix next",
    disabled: false,
    onClick: () => runDiagnose().catch((err) => console.error(err)),
  });
  actions.push({
    id: "recast",
    label: state.pendingRecast ? "Recast (running…)" : "Recast",
    title: "Reimagine the image in a totally different medium/context (lateral leap)",
    disabled: false,
    onClick: () => runRecast().catch((err) => console.error(err)),
  });

  actions.push({
    id: "bg_white",
    label: "Background: White",
    title: "Replace background with a clean studio white",
    disabled: false,
    onClick: () => applyBackground("white").catch((err) => console.error(err)),
  });
  actions.push({
    id: "bg_sweep",
    label: "Background: Sweep",
    title: "Replace background with a soft sweep gradient",
    disabled: false,
    onClick: () => applyBackground("sweep").catch((err) => console.error(err)),
  });
  actions.push({
    id: "crop_square",
    label: "Crop: Square",
    title: canCropSquare ? "Crop the active image to a centered square" : "Already square (or image size unknown)",
    disabled: !canCropSquare,
    onClick: canCropSquare ? () => cropSquare().catch((err) => console.error(err)) : null,
  });
  actions.push({
    id: "variations",
    label: "Variations",
    title: "Zero-prompt variations of the active image",
    disabled: false,
    onClick: () => runVariations().catch((err) => console.error(err)),
  });

  return actions;
}

function renderQuickActions() {
  const root = els.quickActions;
  if (!root) return;
  const actions = computeQuickActions();
  root.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (const action of actions) {
    if (!action?.id || !action?.label) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = String(action.label);
    if (action.title) btn.title = String(action.title);
    if (action.disabled) btn.setAttribute("disabled", "disabled");
    if (!action.disabled && typeof action.onClick === "function") {
      btn.addEventListener("click", (ev) => {
        bumpInteraction();
        action.onClick(ev);
      });
    }
    frag.appendChild(btn);
  }

  root.appendChild(frag);
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
  if (state.canvasMode === "multi") {
    els.filmstrip.classList.add("hidden");
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
    return;
  }
  els.filmstrip.classList.remove("hidden");
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
  if (state.canvasMode === "multi") return;
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
    scheduleVisionDescribe(item.path, { priority: true });
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
  if (state.canvasMode === "multi") {
    // Multi-canvas is the "working set"; keep HUD descriptions available for all tiles.
    scheduleVisionDescribe(item.path);
  }
  if (item.receiptPath && !item.receiptMetaChecked) {
    ensureReceiptMeta(item).catch(() => {});
  }
  showDropHint(state.images.length === 0);
  scheduleVisualPromptWrite();
  if (select || !state.activeId) {
    setActiveImage(item.id).catch(() => {});
  }
}

async function removeImageFromCanvas(imageId) {
  const id = String(imageId || "");
  if (!id) return false;
  const item = state.imagesById.get(id) || null;
  if (!item) return false;

  hideImageMenu();
  hideDesignateMenu();

  if (item?.path) invalidateImageCache(item.path);

  // Drop per-image marks.
  state.designationsByImageId.delete(id);
  state.circlesByImageId.delete(id);

  // Remove from collections.
  state.imagesById.delete(id);
  state.images = (state.images || []).filter((item) => item?.id !== id);
  state.multiRects.delete(id);

  // Remove filmstrip thumb if present (filmstrip might be hidden in multi mode).
  const thumb = state.thumbsById.get(id);
  if (thumb?.rootEl && thumb.rootEl.parentNode) {
    try {
      thumb.rootEl.parentNode.removeChild(thumb.rootEl);
    } catch {
      // ignore
    }
  }
  state.thumbsById.delete(id);

  // If we removed the active image, select a sensible next.
  if (state.activeId === id) {
    state.activeId = null;
    const next = state.images.length ? state.images[state.images.length - 1] : null;
    if (next?.id) {
      await setActiveImage(next.id);
    }
  }

  if (state.images.length === 0) {
    clearImageCache();
    state.activeId = null;
    state.canvasMode = "single";
    state.multiRects.clear();
    state.pendingBlend = null;
    state.pendingSwapDna = null;
    state.pendingBridge = null;
    state.pendingArgue = null;
    state.pendingRecast = null;
    state.pendingDiagnose = null;
    clearSelection();
    showDropHint(true);
    setTip(DEFAULT_TIP);
    setDirectorText(null, null);
    renderFilmstrip();
    renderQuickActions();
    renderHudReadout();
    requestRender();
    return true;
  }

  if (state.canvasMode === "multi" && state.images.length < 2) {
    setCanvasMode("single");
  } else {
    renderFilmstrip();
  }

  scheduleVisualPromptWrite();
  renderQuickActions();
  renderHudReadout();
  requestRender();
  return true;
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
  item.receiptMeta = null;
  item.receiptMetaChecked = false;
  item.receiptMetaLoading = false;
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
  if (item.receiptPath) ensureReceiptMeta(item).catch(() => {});
	  if (state.activeId === targetId) {
	    try {
	      item.img = await loadImage(item.path);
      item.width = item.img?.naturalWidth || null;
      item.height = item.img?.naturalHeight || null;
    } catch (err) {
      console.error(err);
    }
    await setEngineActiveImage(item.path);
    if (!item.visionDesc) scheduleVisionDescribe(item.path, { priority: true });
    renderSelectionMeta();
    chooseSpawnNodes();
    renderHudReadout();
	    resetViewToFit();
	    requestRender();
	  }
    scheduleVisualPromptWrite();
	  return true;
	}

async function setEngineActiveImage(path) {
  if (!path) return;
  if (!state.ptySpawned) {
    // Active image tracking is best-effort; don't block UI if engine isn't ready yet.
    return;
  }
  await invoke("write_pty", { data: `/use ${path}\n` }).catch(() => {
    state.ptySpawned = false;
  });
}

function restoreEngineImageModelIfNeeded() {
  const restore = state.engineImageModelRestore;
  if (!restore) return;
  state.engineImageModelRestore = null;
  if (!state.ptySpawned) return;
  invoke("write_pty", { data: `/image_model ${restore}\n` }).catch(() => {});
}

async function maybeOverrideEngineImageModel(desiredModel) {
  const desired = String(desiredModel || "").trim();
  if (!desired) return false;
  if (!state.ptySpawned) return false;
  if (desired === settings.imageModel) return false;
  state.engineImageModelRestore = settings.imageModel;
  await invoke("write_pty", { data: `/image_model ${desired}\n` }).catch(() => {});
  return true;
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

function isoFromMs(ms) {
  const t = typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now();
  try {
    return new Date(t).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function buildVisualPrompt() {
  const nowIso = new Date().toISOString();
  const canvas = els.workCanvas;
  const dpr = getDpr();
  const active = getActiveImage();

  let multiRects = null;
  if (state.canvasMode === "multi" && canvas) {
    const rectMap =
      state.multiRects && state.multiRects.size ? state.multiRects : computeMultiRects(state.images, canvas.width, canvas.height);
    multiRects = Array.from(rectMap.entries()).map(([imageId, rect]) => ({
      image_id: String(imageId),
      x: Number(rect?.x) || 0,
      y: Number(rect?.y) || 0,
      w: Number(rect?.w) || 0,
      h: Number(rect?.h) || 0,
      cell_x: Number(rect?.cellX) || 0,
      cell_y: Number(rect?.cellY) || 0,
      cell_w: Number(rect?.cellW) || 0,
      cell_h: Number(rect?.cellH) || 0,
    }));
  }

  const images = state.images.map((item) => ({
    id: String(item?.id || ""),
    kind: item?.kind ? String(item.kind) : null,
    path: item?.path ? String(item.path) : null,
    label: item?.label ? String(item.label) : null,
    width: Number(item?.img?.naturalWidth || item?.width) || null,
    height: Number(item?.img?.naturalHeight || item?.height) || null,
  }));

  const marks = [];

  // Lasso polygon (active image only).
  if (active?.id && state.selection?.points?.length >= 3) {
    const atMs = Number(state.selection?.at) || Date.now();
    marks.push({
      id: `lasso-${atMs}`,
      type: "lasso_polygon",
      color: "rgba(255, 179, 0, 0.95)",
      label: null,
      target_image_id: String(active.id),
      image_space: {
        points: state.selection.points.map((pt) => ({
          x: Number(pt?.x) || 0,
          y: Number(pt?.y) || 0,
        })),
      },
      created_at: isoFromMs(atMs),
    });
  }

  // Designate points.
  for (const [imageId, list] of Array.from(state.designationsByImageId.entries())) {
    const imageKey = String(imageId || "");
    if (!imageKey || !Array.isArray(list)) continue;
    for (const mark of list) {
      const atMs = Number(mark?.at) || Date.now();
      marks.push({
        id: String(mark?.id || `d-${atMs}`),
        type: "designate_point",
        color: "rgba(100, 210, 255, 0.82)",
        label: mark?.kind ? String(mark.kind) : null,
        target_image_id: imageKey,
        image_space: { x: Number(mark?.x) || 0, y: Number(mark?.y) || 0 },
        created_at: isoFromMs(atMs),
      });
    }
  }

  // Annotate box (draft/final, active image only).
  if (active?.id && state.annotateBox && state.annotateBox.imageId === active.id) {
    const atMs = Number(state.annotateBox?.at) || Date.now();
    const label = String(els.annotateText?.value || "").trim() || null;
    marks.push({
      id: `box-${atMs}`,
      type: "box",
      color: "rgba(82, 255, 148, 0.92)",
      label,
      target_image_id: String(active.id),
      image_space: {
        x0: Number(state.annotateBox?.x0) || 0,
        y0: Number(state.annotateBox?.y0) || 0,
        x1: Number(state.annotateBox?.x1) || 0,
        y1: Number(state.annotateBox?.y1) || 0,
      },
      created_at: isoFromMs(atMs),
    });
  }

  // Circles.
  for (const [imageId, list] of Array.from(state.circlesByImageId.entries())) {
    const imageKey = String(imageId || "");
    if (!imageKey || !Array.isArray(list)) continue;
    for (const circle of list) {
      const atMs = Number(circle?.at) || Date.now();
      marks.push({
        id: String(circle?.id || `c-${atMs}`),
        type: "circle",
        color: circle?.color ? String(circle.color) : "rgba(255, 95, 95, 0.92)",
        label: circle?.label ? String(circle.label) : null,
        target_image_id: imageKey,
        image_space: {
          cx: Number(circle?.cx) || 0,
          cy: Number(circle?.cy) || 0,
          r: Number(circle?.r) || 0,
        },
        created_at: isoFromMs(atMs),
      });
    }
  }

  return {
    schema: "brood.visual_prompt",
    schema_version: VISUAL_PROMPT_SCHEMA_VERSION,
    visual_grammar_version: VISUAL_GRAMMAR_VERSION,
    updated_at: nowIso,
    run_dir: state.runDir ? String(state.runDir) : null,
    canvas: {
      mode: state.canvasMode,
      dpr,
      size_px: canvas ? { w: canvas.width || 0, h: canvas.height || 0 } : null,
      tool: state.tool,
      active_image_id: state.activeId ? String(state.activeId) : null,
      view: {
        scale: Number(state.view?.scale) || 1,
        offset_x: Number(state.view?.offsetX) || 0,
        offset_y: Number(state.view?.offsetY) || 0,
      },
      multi_view: {
        scale: Number(state.multiView?.scale) || 1,
        offset_x: Number(state.multiView?.offsetX) || 0,
        offset_y: Number(state.multiView?.offsetY) || 0,
      },
      multi_rects_px: multiRects,
    },
    images,
    marks,
  };
}

async function writeVisualPrompt() {
  if (!state.runDir) return false;
  const outPath = `${state.runDir}/${VISUAL_PROMPT_FILENAME}`;
  const payload = buildVisualPrompt();
  await writeTextFile(outPath, JSON.stringify(payload, null, 2));
  return true;
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
    if (state.images.length > 1) {
      setCanvasMode("multi");
      setTip("Multiple photos loaded. Click a photo to select it. Use L to lasso or D to designate.");
      scheduleAutoCanvasDiagnose();
    }
  } else {
    const msg = lastErr?.message || String(lastErr || "unknown error");
    setStatus(`Engine: import failed (${msg})`, true);
  }
}

async function cropSquare({ fromQueue = false } = {}) {
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Crop: Square",
      key: "crop_square",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => cropSquare({ fromQueue: true }),
    });
    return;
  }
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
  portraitWorking(label, { providerOverride: providerFromModel(ACTION_IMAGE_MODEL.bg_replace) });
  beginPendingReplace(imgItem.id, label);
  try {
    const ok = await ensureEngineSpawned({ reason: label });
    if (!ok) throw new Error("Engine unavailable");
    await setEngineActiveImage(imgItem.path);
    await maybeOverrideEngineImageModel(ACTION_IMAGE_MODEL.bg_replace);
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

async function aiRemovePeople({ fromQueue = false } = {}) {
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Remove People",
      key: "remove_people",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => aiRemovePeople({ fromQueue: true }),
    });
    return;
  }
  const imgItem = getActiveImage();
  if (!imgItem) {
    showToast("No image selected.", "error");
    return;
  }

  const label = "Remove People";
  await ensureRun();
  setImageFxActive(true, label);
  portraitWorking(label, { providerOverride: providerFromModel(ACTION_IMAGE_MODEL.remove_people) || "gemini" });
  beginPendingReplace(imgItem.id, label);
  try {
    const ok = await ensureEngineSpawned({ reason: label });
    if (!ok) throw new Error("Engine unavailable");
    await setEngineActiveImage(imgItem.path);
    state.expectingArtifacts = true;
    state.lastAction = label;
    setStatus(`Engine: ${label}…`);
    showToast("Removing people…", "info", 2200);

    await maybeOverrideEngineImageModel(ACTION_IMAGE_MODEL.remove_people || pickGeminiImageModel());

    // Must start with "edit" or "replace" for Brood's edit detection.
    const prompt =
      "edit the image: remove any people (humans) from the image completely. " +
      "fill in the background naturally. keep everything else exactly the same. " +
      "preserve logos and text. do not crop.";
    await invoke("write_pty", { data: `${prompt}\n` });
  } catch (err) {
    state.expectingArtifacts = false;
    state.engineImageModelRestore = null;
    clearPendingReplace();
    setImageFxActive(false);
    updatePortraitIdle();
    throw err;
  }
}

async function aiSurpriseMe({ fromQueue = false } = {}) {
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Surprise Me",
      key: "surprise_me",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => aiSurpriseMe({ fromQueue: true }),
    });
    return;
  }
  const imgItem = getActiveImage();
  if (!imgItem) {
    showToast("No image selected.", "error");
    return;
  }

  const label = "Surprise Me";
  await ensureRun();
  setImageFxActive(true, label);
  portraitWorking(label, { providerOverride: providerFromModel(ACTION_IMAGE_MODEL.surprise) || "gemini" });
  beginPendingReplace(imgItem.id, label);
  try {
    const ok = await ensureEngineSpawned({ reason: label });
    if (!ok) throw new Error("Engine unavailable");
    await setEngineActiveImage(imgItem.path);
    state.expectingArtifacts = true;
    state.lastAction = label;
    setStatus(`Engine: ${label}…`);
    showToast("Surprising you…", "info", 2200);

    await maybeOverrideEngineImageModel(ACTION_IMAGE_MODEL.surprise || pickGeminiFastImageModel());

    const surprises = [
      "replace the background with a bold but clean gradient (no patterns) and add a subtle soft shadow under the product.",
      "make the lighting moodier and more dramatic (soft rim light + slightly deeper shadows) while keeping details crisp.",
      "add a minimal studio tabletop plane and a gentle vignette, keeping the product unchanged.",
      "add a tasteful subtle film look (slight contrast + very light grain), keeping all logos and text identical.",
      "replace the background with a bright high-key studio look with a soft floor reflection, keeping the subject exactly the same.",
    ];
    const chosen = surprises[Math.floor(Math.random() * surprises.length)] || surprises[0];

    // Must start with "edit" or "replace" for Brood's edit detection.
    const prompt =
      `edit the image: * surprise me.\n` +
      `${chosen}\n` +
      "Keep the subject exactly the same. Preserve all existing logos and text exactly. " +
      "Do not add any new people or readable text. Do not crop.";
    await invoke("write_pty", { data: `${prompt}\n` });
  } catch (err) {
    state.expectingArtifacts = false;
    state.engineImageModelRestore = null;
    clearPendingReplace();
    setImageFxActive(false);
    updatePortraitIdle();
    throw err;
  }
}

async function aiAnnotateEdit({
  fromQueue = false,
  targetId = null,
  boxOverride = null,
  instructionOverride = null,
  requestedModelOverride = null,
} = {}) {
  bumpInteraction();
  const activeItem = getActiveImage();
  const imgItem = targetId ? state.imagesById.get(targetId) || null : activeItem;
  if (!imgItem) {
    showToast("No image selected.", "error");
    return;
  }

  const box = boxOverride || state.annotateBox;
  if (!box || box.imageId !== imgItem.id) {
    showToast("Annotate: draw a box first.", "tip", 2200);
    return;
  }

  const instruction =
    typeof instructionOverride === "string"
      ? instructionOverride.trim()
      : String(els.annotateText?.value || "").trim();
  if (!instruction) {
    showToast("Annotate: enter an instruction.", "tip", 2200);
    return;
  }

  const requestedModel =
    typeof requestedModelOverride === "string"
      ? requestedModelOverride.trim()
      : String(els.annotateModel?.value || settings.imageModel || "").trim();

  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    const captured = {
      targetId: imgItem.id,
      box: { ...box },
      instruction,
      requestedModel,
    };

    // Mirror the "send" UX: clear the box + prompt input immediately, even if queued.
    if (els.annotateText) els.annotateText.value = "";
    state.annotateBox = null;
    state.annotateDraft = null;
    hideAnnotatePanel();
    scheduleVisualPromptWrite();
    requestRender();

    enqueueAction({
      label: "Annotate",
      key: `annotate:${captured.targetId}`,
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () =>
        aiAnnotateEdit({
          fromQueue: true,
          targetId: captured.targetId,
          boxOverride: captured.box,
          instructionOverride: captured.instruction,
          requestedModelOverride: captured.requestedModel,
        }),
    });
    return;
  }

  // Keep the target image visible when replaying queued edits.
  if (state.activeId !== imgItem.id) {
    await setActiveImage(imgItem.id).catch(() => {});
  }

  let effectiveModel = requestedModel || settings.imageModel;
  if (providerFromModel(effectiveModel) !== "gemini") {
    effectiveModel = pickGeminiImageModel();
    if (!fromQueue) {
      showToast(`Annotate box edits currently require Gemini. Using ${effectiveModel}.`, "tip", 3200);
    }
  }
  const provider = providerFromModel(effectiveModel);
  const label = "Annotate";
  await ensureRun();
  setImageFxActive(true, label);
  portraitWorking(label, { providerOverride: provider });
  try {
    const ok = await ensureEngineSpawned({ reason: label });
    if (!ok) throw new Error("Engine unavailable");

    if (!imgItem.img) {
      setStatus("Engine: loading image…");
      try {
        imgItem.img = await loadImage(imgItem.path);
        imgItem.width = imgItem.img?.naturalWidth || imgItem.width || null;
        imgItem.height = imgItem.img?.naturalHeight || imgItem.height || null;
      } catch (err) {
        showToast("Failed to load image.", "error", 3200);
        setStatus("Engine: ready");
        return;
      }
      setStatus("Engine: ready");
    }

    const normalized = _normalizeAnnotateBox(box, imgItem);
    if (!normalized) {
      showToast("Annotate: invalid box.", "error", 2600);
      return;
    }
    const x0 = Math.floor(Number(normalized.x0) || 0);
    const y0 = Math.floor(Number(normalized.y0) || 0);
    const x1 = Math.ceil(Number(normalized.x1) || 0);
    const y1 = Math.ceil(Number(normalized.y1) || 0);
    const wBox = Math.max(1, x1 - x0);
    const hBox = Math.max(1, y1 - y0);
    if (wBox < 8 || hBox < 8) {
      showToast("Annotate: box too small.", "tip", 2200);
      return;
    }

    // Crop the selection region so the model can only edit what's inside the box.
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = wBox;
    cropCanvas.height = hBox;
    const cropCtx = cropCanvas.getContext("2d");
    cropCtx.drawImage(imgItem.img, x0, y0, wBox, hBox, 0, 0, wBox, hBox);
    const cropPath = `${state.runDir}/tmp-annotate-crop-${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
    await writeCanvasPngToPath(cropCanvas, cropPath);

    beginPendingReplace(imgItem.id, label, {
      mode: "annotate_box",
      basePath: imgItem.path,
      box: { x0, y0, x1, y1, w: wBox, h: hBox },
      cropPath,
      instruction,
    });

    // Point the engine at the cropped image so "edit the image" edits the crop.
    await invoke("write_pty", { data: `/use ${quoteForPtyArg(cropPath)}\n` }).catch(() => {});

    state.expectingArtifacts = true;
    state.lastAction = label;
    setStatus(`Engine: ${label}…`);
    showToast("Annotate: editing…", "info", 2200);

    if (state.ptySpawned && effectiveModel && effectiveModel !== settings.imageModel) {
      state.engineImageModelRestore = settings.imageModel;
      await invoke("write_pty", { data: `/image_model ${effectiveModel}\n` }).catch(() => {});
    }

    // Must start with "edit" or "replace" for Brood's edit detection.
    const prompt =
      `edit the image: ${instruction}\n` +
      "Output ONE image. No split-screen or collage. Do not add any text or logos. Do not crop.";
    await invoke("write_pty", { data: `${prompt}\n` });

    // Clear UI selection now that the instruction is sent.
    if (els.annotateText) els.annotateText.value = "";
    state.annotateBox = null;
    state.annotateDraft = null;
    hideAnnotatePanel();
    scheduleVisualPromptWrite();
    requestRender();
  } catch (err) {
    state.expectingArtifacts = false;
    state.engineImageModelRestore = null;
    clearPendingReplace();
    setImageFxActive(false);
    updatePortraitIdle();
    throw err;
  }
}

async function compositeAnnotateBoxEdit(targetId, editedCropPath, { box, instruction = null } = {}) {
  if (!targetId || !editedCropPath || !box) return false;
  const item = state.imagesById.get(targetId) || null;
  if (!item?.path) return false;

  // Ensure base + crop images are loaded.
  if (!item.img) {
    try {
      item.img = await loadImage(item.path);
      item.width = item.img?.naturalWidth || item.width || null;
      item.height = item.img?.naturalHeight || item.height || null;
    } catch (err) {
      console.error("Annotate composite failed to load base image:", err);
      return false;
    }
  }

  let cropImg = null;
  try {
    cropImg = await loadImage(editedCropPath);
  } catch (err) {
    console.error("Annotate composite failed to load crop image:", err);
    return false;
  }

  const baseImg = item.img;
  const bw = baseImg?.naturalWidth || item.width || 1;
  const bh = baseImg?.naturalHeight || item.height || 1;
  const out = document.createElement("canvas");
  out.width = bw;
  out.height = bh;
  const ctx = out.getContext("2d");
  ctx.drawImage(baseImg, 0, 0);
  ctx.drawImage(cropImg, Number(box.x0) || 0, Number(box.y0) || 0, Number(box.w) || 1, Number(box.h) || 1);

  await saveCanvasAsArtifact(out, {
    operation: "annotate_box",
    label: "Annotate",
    meta: {
      instruction: instruction ? String(instruction) : null,
      box,
      edited_crop_path: String(editedCropPath),
    },
    replaceActive: true,
    targetId,
  });
  return true;
}

async function applyBackground(style, { fromQueue = false } = {}) {
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    const label = style === "sweep" ? "Background: Sweep" : "Background: White";
    enqueueAction({
      label,
      key: `bg:${String(style || "")}`,
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => applyBackground(style, { fromQueue: true }),
    });
    return;
  }
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

async function writeCanvasPngToPath(canvas, outPath) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Failed to encode PNG");
  const buf = new Uint8Array(await blob.arrayBuffer());
  await writeBinaryFile(outPath, buf);
  return outPath;
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

async function runVariations({ fromQueue = false } = {}) {
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Variations",
      key: "variations",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runVariations({ fromQueue: true }),
    });
    return;
  }
  state.lastAction = "Variations";
  const imgItem = getActiveImage();
  if (!imgItem) return;
  await ensureRun();
  setImageFxActive(true, "Variations");
  portraitWorking("Variations");
  try {
    const ok = await ensureEngineSpawned({ reason: "variations" });
    if (!ok) throw new Error("Engine unavailable");
    state.expectingArtifacts = true;
    state.pendingRecreate = { startedAt: Date.now() };
    setStatus("Engine: variations…");
    await invoke("write_pty", { data: `/recreate ${imgItem.path}\n` });
  } catch (err) {
    state.expectingArtifacts = false;
    state.pendingRecreate = null;
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

async function runBlendPair({ fromQueue = false } = {}) {
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Combine",
      key: "combine",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runBlendPair({ fromQueue: true }),
    });
    return;
  }
  if (!state.runDir) {
    await ensureRun();
  }
  if (state.images.length !== 2) {
    showToast("Combine needs exactly 2 photos in the run.", "error", 3200);
    return;
  }
  const a = state.images[0];
  const b = state.images[1];
  if (!a?.path || !b?.path) {
    showToast("Combine failed: missing image paths.", "error", 3200);
    return;
  }

  const okEngine = await ensureEngineSpawned({ reason: "combine" });
  if (!okEngine) return;
  await maybeOverrideEngineImageModel(ACTION_IMAGE_MODEL.combine);
  setImageFxActive(true, "Combine");
  state.expectingArtifacts = true;
  state.pendingBlend = { sourceIds: [a.id, b.id], startedAt: Date.now() };
  state.lastAction = "Combine";
  setStatus("Engine: combine…");
  portraitWorking("Combine", { providerOverride: providerFromModel(ACTION_IMAGE_MODEL.combine) });
  showToast("Combining photos…", "info", 2200);
  renderQuickActions();
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
    renderQuickActions();
  }
}

async function runSwapDnaPair({ invert = false, fromQueue = false } = {}) {
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Swap DNA",
      key: `swap_dna:${invert ? "1" : "0"}`,
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runSwapDnaPair({ invert, fromQueue: true }),
    });
    return;
  }
  if (!state.runDir) {
    await ensureRun();
  }
  if (state.images.length !== 2) {
    showToast("Swap DNA needs exactly 2 photos in the run.", "error", 3200);
    return;
  }

  const active = getActiveImage();
  const first = active || state.images[0];
  const second = state.images.find((item) => item?.id && item.id !== first?.id) || state.images[1];
  let structure = first;
  let surface = second;
  if (invert) {
    structure = second;
    surface = first;
  }
  if (!structure?.path || !surface?.path) {
    showToast("Swap DNA failed: missing image paths.", "error", 3200);
    return;
  }

  const okEngine = await ensureEngineSpawned({ reason: "swap dna" });
  if (!okEngine) return;
  await maybeOverrideEngineImageModel(ACTION_IMAGE_MODEL.swap_dna);
  setImageFxActive(true, "Swap DNA");
  state.expectingArtifacts = true;
  state.pendingSwapDna = { structureId: structure.id, surfaceId: surface.id, startedAt: Date.now() };
  state.lastAction = "Swap DNA";
  setStatus("Engine: swap dna…");
  portraitWorking("Swap DNA", { providerOverride: providerFromModel(ACTION_IMAGE_MODEL.swap_dna) });
  const structureLabel = structure.label || basename(structure.path) || "Image A";
  const surfaceLabel = surface.label || basename(surface.path) || "Image B";
  const invertNote = invert ? " (inverted)" : "";
  showToast(`Swap DNA${invertNote}: structure=${structureLabel} | surface=${surfaceLabel}`, "info", 3200);
  renderQuickActions();
  requestRender();

  try {
    await invoke("write_pty", {
      data: `/swap_dna ${quoteForPtyArg(structure.path)} ${quoteForPtyArg(surface.path)}\n`,
    });
  } catch (err) {
    console.error(err);
    state.expectingArtifacts = false;
    state.pendingSwapDna = null;
    setStatus(`Engine: swap dna failed (${err?.message || err})`, true);
    showToast("Swap DNA failed to start.", "error", 3200);
    setImageFxActive(false);
    updatePortraitIdle();
    renderQuickActions();
  }
}

async function runBridgePair({ fromQueue = false } = {}) {
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Bridge",
      key: "bridge",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runBridgePair({ fromQueue: true }),
    });
    return;
  }
  if (!state.runDir) {
    await ensureRun();
  }
  if (state.images.length !== 2) {
    showToast("Bridge needs exactly 2 photos in the run.", "error", 3200);
    return;
  }

  const active = getActiveImage();
  const first = active || state.images[0];
  const second = state.images.find((item) => item?.id && item.id !== first?.id) || state.images[1];
  if (!first?.path || !second?.path) {
    showToast("Bridge failed: missing image paths.", "error", 3200);
    return;
  }

  const okEngine = await ensureEngineSpawned({ reason: "bridge" });
  if (!okEngine) return;
  await maybeOverrideEngineImageModel(ACTION_IMAGE_MODEL.bridge);
  setImageFxActive(true, "Bridge");
  state.expectingArtifacts = true;
  state.pendingBridge = { sourceIds: [first.id, second.id], startedAt: Date.now() };
  state.lastAction = "Bridge";
  setStatus("Engine: bridge…");
  portraitWorking("Bridge", { providerOverride: providerFromModel(ACTION_IMAGE_MODEL.bridge) });
  const aLabel = first.label || basename(first.path) || "Image A";
  const bLabel = second.label || basename(second.path) || "Image B";
  showToast(`Bridging: ${aLabel} ↔ ${bLabel}`, "info", 3200);
  renderQuickActions();
  requestRender();

  try {
    await invoke("write_pty", {
      data: `/bridge ${quoteForPtyArg(first.path)} ${quoteForPtyArg(second.path)}\n`,
    });
  } catch (err) {
    console.error(err);
    state.expectingArtifacts = false;
    state.pendingBridge = null;
    setStatus(`Engine: bridge failed (${err?.message || err})`, true);
    showToast("Bridge failed to start.", "error", 3200);
    setImageFxActive(false);
    updatePortraitIdle();
    renderQuickActions();
  }
}

async function runArguePair({ fromQueue = false } = {}) {
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Argue",
      key: "argue",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runArguePair({ fromQueue: true }),
    });
    return;
  }
  if (!state.runDir) {
    await ensureRun();
  }
  if (state.images.length !== 2) {
    showToast("Argue needs exactly 2 photos in the run.", "error", 3200);
    return;
  }

  const active = getActiveImage();
  const first = active || state.images[0];
  const second = state.images.find((item) => item?.id && item.id !== first?.id) || state.images[1];
  if (!first?.path || !second?.path) {
    showToast("Argue failed: missing image paths.", "error", 3200);
    return;
  }

  const okEngine = await ensureEngineSpawned({ reason: "argue" });
  if (!okEngine) return;
  state.pendingArgue = { sourceIds: [first.id, second.id], startedAt: Date.now() };
  state.lastAction = "Argue";
  setStatus("Director: argue…");
  setDirectorText("Arguing…", { kind: "argue", at: Date.now(), paths: [first.path, second.path] });
  portraitWorking("Argue", { providerOverride: "gemini", clearDirector: false });
  const aLabel = first.label || basename(first.path) || "Image A";
  const bLabel = second.label || basename(second.path) || "Image B";
  showToast(`Arguing: ${aLabel} vs ${bLabel}`, "info", 3200);
  renderQuickActions();
  requestRender();

  try {
    await invoke("write_pty", {
      data: `/argue ${quoteForPtyArg(first.path)} ${quoteForPtyArg(second.path)}\n`,
    });
  } catch (err) {
    console.error(err);
    state.pendingArgue = null;
    setStatus(`Director: argue failed (${err?.message || err})`, true);
    showToast("Argue failed to start.", "error", 3200);
    updatePortraitIdle();
    renderQuickActions();
  }
}

async function runDiagnose({ fromQueue = false } = {}) {
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Diagnose",
      key: "diagnose",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runDiagnose({ fromQueue: true }),
    });
    return;
  }
  const imgItem = getActiveImage();
  if (!imgItem?.path) {
    showToast("No image selected.", "error", 2400);
    return;
  }
  await ensureRun();
  const okEngine = await ensureEngineSpawned({ reason: "diagnose" });
  if (!okEngine) return;
  state.pendingDiagnose = { sourceId: imgItem.id, startedAt: Date.now() };
  state.lastAction = "Diagnose";
  setStatus("Director: diagnose…");
  setDirectorText("Diagnosing…", { kind: "diagnose", at: Date.now(), paths: [imgItem.path] });
  portraitWorking("Diagnose", { providerOverride: "openai", clearDirector: false });
  showToast("Diagnosing…", "info", 2200);
  renderQuickActions();

  try {
    await invoke("write_pty", { data: `/diagnose ${quoteForPtyArg(imgItem.path)}\n` });
  } catch (err) {
    console.error(err);
    state.pendingDiagnose = null;
    setStatus(`Director: diagnose failed (${err?.message || err})`, true);
    showToast("Diagnose failed to start.", "error", 3200);
    updatePortraitIdle();
    renderQuickActions();
  }
}

async function runRecast({ fromQueue = false } = {}) {
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Recast",
      key: "recast",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runRecast({ fromQueue: true }),
    });
    return;
  }
  const imgItem = getActiveImage();
  if (!imgItem?.path) {
    showToast("No image selected.", "error", 2400);
    return;
  }

  const label = "Recast";
  await ensureRun();
  const okEngine = await ensureEngineSpawned({ reason: label });
  if (!okEngine) return;
  setImageFxActive(true, label);
  portraitWorking(label, { providerOverride: "gemini" });
  state.expectingArtifacts = true;
  state.pendingRecast = { sourceId: imgItem.id, startedAt: Date.now() };
  state.lastAction = label;
  setStatus(`Engine: ${label.toLowerCase()}…`);
  showToast("Recasting…", "info", 2200);
  renderQuickActions();
  requestRender();

  try {
    const desired = "gemini-3-pro-image-preview";
    if (state.ptySpawned && desired && desired !== settings.imageModel) {
      state.engineImageModelRestore = settings.imageModel;
      await invoke("write_pty", { data: `/image_model ${desired}\n` }).catch(() => {});
    }
    await invoke("write_pty", { data: `/recast ${quoteForPtyArg(imgItem.path)}\n` });
  } catch (err) {
    console.error(err);
    state.expectingArtifacts = false;
    state.pendingRecast = null;
    state.engineImageModelRestore = null;
    setStatus(`Engine: recast failed (${err?.message || err})`, true);
    showToast("Recast failed to start.", "error", 3200);
    setImageFxActive(false);
    updatePortraitIdle();
    renderQuickActions();
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
  resetDescribeQueue();
  state.images = [];
  state.imagesById.clear();
  state.activeId = null;
  state.designationsByImageId.clear();
  state.pendingDesignation = null;
  state.canvasMode = "single";
  state.multiRects.clear();
  state.pendingBlend = null;
  state.pendingSwapDna = null;
  state.pendingBridge = null;
  state.pendingArgue = null;
  state.pendingRecast = null;
  state.pendingDiagnose = null;
  state.pendingRecreate = null;
  resetActionQueue();
  clearImageCache();
  state.selection = null;
  state.lassoDraft = [];
  state.annotateDraft = null;
  state.annotateBox = null;
  hideAnnotatePanel();
  state.circleDraft = null;
  state.circlesByImageId.clear();
  hideMarkPanel();
  state.expectingArtifacts = false;
  state.lastRecreatePrompt = null;
  state.lastDirectorText = null;
  state.lastDirectorMeta = null;
  setRunInfo(`Run: ${state.runDir}`);
  setTip(DEFAULT_TIP);
  setDirectorText(null, null);
  showDropHint(true);
  renderFilmstrip();
  chooseSpawnNodes();
  scheduleVisualPromptWrite({ immediate: true });
  await spawnEngine();
  await startEventsPolling();
  if (state.ptySpawned) setStatus("Engine: ready");
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
  resetDescribeQueue();
  state.images = [];
  state.imagesById.clear();
  state.activeId = null;
  state.designationsByImageId.clear();
  state.pendingDesignation = null;
  state.canvasMode = "single";
  state.multiRects.clear();
  state.pendingBlend = null;
  state.pendingSwapDna = null;
  state.pendingBridge = null;
  state.pendingArgue = null;
  state.pendingRecast = null;
  state.pendingDiagnose = null;
  state.pendingRecreate = null;
  resetActionQueue();
  renderFilmstrip();
  clearImageCache();
  state.selection = null;
  state.lassoDraft = [];
  state.annotateDraft = null;
  state.annotateBox = null;
  hideAnnotatePanel();
  state.circleDraft = null;
  state.circlesByImageId.clear();
  hideMarkPanel();
  state.expectingArtifacts = false;
  state.lastRecreatePrompt = null;
  state.lastDirectorText = null;
  state.lastDirectorMeta = null;
  setRunInfo(`Run: ${state.runDir}`);
  setTip(DEFAULT_TIP);
  setDirectorText(null, null);
  showDropHint(true);
  await loadExistingArtifacts();
  await spawnEngine();
  await startEventsPolling();
  scheduleVisualPromptWrite({ immediate: true });
  if (state.ptySpawned) setStatus("Engine: ready");
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
        receiptMeta: extractReceiptMeta(payload),
        receiptMetaChecked: true,
        label: basename(imagePath),
      },
      { select: false }
    );
  }
  // Select latest.
  if (state.images.length > 0 && !state.activeId) {
    await setActiveImage(state.images[state.images.length - 1].id);
  }
  if (state.images.length > 1) {
    setCanvasMode("multi");
    setTip("Multiple photos loaded. Click a photo to focus it.");
  }
}

async function spawnEngine() {
  if (!state.runDir || !state.eventsPath) return;
  if (state.ptySpawning) return;
  state.ptySpawning = true;
  setStatus("Engine: starting…");
  state.ptySpawned = false;
  const env = { BROOD_MEMORY: settings.memory ? "1" : "0" };
  const broodArgs = ["chat", "--out", state.runDir, "--events", state.eventsPath];
  try {
    let spawned = false;
    let lastErr = null;

    // In dev, prefer running the engine directly from the repo so the desktop always
    // matches local engine changes (no need for `pip install -e .`).
    let repoRoot = null;
    try {
      repoRoot = await invoke("get_repo_root");
    } catch (_) {
      repoRoot = null;
    }

    if (repoRoot) {
      for (const py of ["python", "python3"]) {
        try {
          await invoke("spawn_pty", {
            command: py,
            args: ["-m", "brood_engine.cli", ...broodArgs],
            cwd: repoRoot,
            env,
          });
          spawned = true;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
    }

    // Fallback: use the installed CLI entrypoint.
    if (!spawned) {
      try {
        await invoke("spawn_pty", { command: "brood", args: broodArgs, cwd: state.runDir, env });
        spawned = true;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!spawned) throw lastErr;

    state.ptySpawned = true;
    await invoke("write_pty", { data: `/text_model ${settings.textModel}\n` }).catch(() => {});
    await invoke("write_pty", { data: `/image_model ${settings.imageModel}\n` }).catch(() => {});
    const active = getActiveImage();
    if (active?.path) {
      await invoke("write_pty", { data: `/use ${active.path}\n` }).catch(() => {});
      if (!active.visionDesc) scheduleVisionDescribe(active.path, { priority: true });
    }
    processDescribeQueue();
    setStatus("Engine: started");
  } catch (err) {
    console.error(err);
    setStatus(`Engine: failed (${err?.message || err})`, true);
  } finally {
    state.ptySpawning = false;
    processActionQueue().catch(() => {});
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
        await handleEvent(JSON.parse(trimmed));
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
      await handleEvent(JSON.parse(lines[i]));
    } catch {
      // ignore
    }
  }
  fallbackLineOffset = lines.length;
}

async function handleEvent(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "artifact_created") {
    const id = event.artifact_id;
    const path = event.image_path;
    if (!id || !path) return;
    const wasBlend = Boolean(state.pendingBlend);
    const wasSwapDna = Boolean(state.pendingSwapDna);
    const wasBridge = Boolean(state.pendingBridge);
    const wasRecast = Boolean(state.pendingRecast);
    const wasPairAction = wasBlend || wasSwapDna || wasBridge;
    if (wasBlend) {
      state.pendingBlend = null;
      setTip("Combine complete. Output selected.");
      showToast("Combine complete.", "tip", 2400);
    }
    if (wasSwapDna) {
      state.pendingSwapDna = null;
      setTip("Swap DNA complete. Output selected.");
      showToast("Swap DNA complete.", "tip", 2400);
    }
    if (wasBridge) {
      state.pendingBridge = null;
      setTip("Bridge complete. Output selected.");
      showToast("Bridge complete.", "tip", 2400);
    }
    if (wasRecast) {
      state.pendingRecast = null;
      setTip("Recast complete. Output selected.");
      showToast("Recast complete.", "tip", 2400);
    }
    const pending = state.pendingReplace;
    if (pending?.targetId) {
      const targetId = pending.targetId;
      const mode = pending.mode ? String(pending.mode) : "";
      const box = pending.box || null;
      const instruction = pending.instruction || null;
      clearPendingReplace();
      if (mode === "annotate_box") {
        const ok = await compositeAnnotateBoxEdit(targetId, path, { box, instruction }).catch((err) => {
          console.error(err);
          return false;
        });
        if (!ok) {
          showToast("Annotate failed to apply the box edit.", "error", 3600);
        }
      } else {
        await replaceImageInPlace(targetId, {
          path,
          receiptPath: event.receipt_path || null,
          kind: "engine",
        }).catch((err) => console.error(err));
      }
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

    // After 2-photo quick actions (Combine / Swap DNA / Bridge), show only the output
    // image on the canvas. The filmstrip retains sources for now (lineage TBD).
    if (wasPairAction) {
      setCanvasMode("single");
    }
    state.expectingArtifacts = false;
    restoreEngineImageModelIfNeeded();
    setStatus("Engine: ready");
    updatePortraitIdle();
    setImageFxActive(false);
    renderQuickActions();
    renderHudReadout();
    processActionQueue().catch(() => {});
  } else if (event.type === "generation_failed") {
    const msg = event.error ? `Generation failed: ${event.error}` : "Generation failed.";
    setStatus(`Engine: ${msg}`, true);
    showToast(msg, "error", 3200);
    state.expectingArtifacts = false;
    state.pendingRecreate = null;
    state.pendingBlend = null;
    state.pendingSwapDna = null;
    state.pendingBridge = null;
    state.pendingRecast = null;
    state.pendingDiagnose = null;
    state.pendingArgue = null;
    state.pendingRecreate = null;
    resetActionQueue();
    clearPendingReplace();
    restoreEngineImageModelIfNeeded();
    updatePortraitIdle();
    setImageFxActive(false);
    renderQuickActions();
    renderHudReadout();
    chooseSpawnNodes();
    requestRender();
    processActionQueue().catch(() => {});
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
      describeQueued.delete(path);
      if (describeInFlightPath === path) {
        describeInFlightPath = null;
        clearTimeout(describeInFlightTimer);
        describeInFlightTimer = null;
        processDescribeQueue();
      }
      if (getActiveImage()?.path === path) renderHudReadout();
    }
  } else if (event.type === "image_diagnosis") {
    const text = event.text;
    if (typeof text === "string" && text.trim()) {
      const diagPath = typeof event.image_path === "string" ? event.image_path : "";
      const pendingCanvas = state.pendingCanvasDiagnose;
      const isCanvasDiagnose = Boolean(pendingCanvas && pendingCanvas.imagePath === diagPath);
      if (isCanvasDiagnose) {
        state.pendingCanvasDiagnose = null;
        state.autoCanvasDiagnoseSig = pendingCanvas.signature;
        state.autoCanvasDiagnoseCompletedAt = Date.now();
        state.autoCanvasDiagnosePath = null;
      } else {
        state.pendingDiagnose = null;
      }

      setDirectorText(text.trim(), {
        kind: "diagnose",
        source: event.source || null,
        model: event.model || null,
        at: Date.now(),
        paths: diagPath ? [diagPath] : [],
        canvas: isCanvasDiagnose ? true : null,
      });
      setStatus(isCanvasDiagnose ? "Director: canvas diagnose ready" : "Director: diagnose ready");
      if (!isCanvasDiagnose) {
        showToast("Diagnose ready.", "tip", 2400);
      }
      updatePortraitIdle();
      renderQuickActions();
      processActionQueue().catch(() => {});
    }
  } else if (event.type === "image_diagnosis_failed") {
    const diagPath = typeof event.image_path === "string" ? event.image_path : "";
    const pendingCanvas = state.pendingCanvasDiagnose;
    const isCanvasDiagnose = Boolean(pendingCanvas && pendingCanvas.imagePath === diagPath);
    if (isCanvasDiagnose) {
      state.pendingCanvasDiagnose = null;
      state.autoCanvasDiagnosePath = null;
    } else {
      state.pendingDiagnose = null;
    }
    const msg = event.error ? `Diagnose failed: ${event.error}` : "Diagnose failed.";
    setStatus(`Director: ${msg}`, true);
    if (!isCanvasDiagnose) {
      showToast(msg, "error", 3200);
    }
    updatePortraitIdle();
    renderQuickActions();
    processActionQueue().catch(() => {});
  } else if (event.type === "image_argument") {
    const text = event.text;
    if (typeof text === "string" && text.trim()) {
      state.pendingArgue = null;
      setDirectorText(text.trim(), {
        kind: "argue",
        source: event.source || null,
        model: event.model || null,
        at: Date.now(),
        paths: Array.isArray(event.image_paths) ? event.image_paths : [],
      });
      setStatus("Director: argue ready");
      showToast("Argue ready.", "tip", 2400);
      updatePortraitIdle();
      renderQuickActions();
      processActionQueue().catch(() => {});
    }
  } else if (event.type === "image_argument_failed") {
    state.pendingArgue = null;
    const msg = event.error ? `Argue failed: ${event.error}` : "Argue failed.";
    setStatus(`Director: ${msg}`, true);
    showToast(msg, "error", 3200);
    updatePortraitIdle();
    renderQuickActions();
    processActionQueue().catch(() => {});
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
  } else if (event.type === "recreate_done") {
    state.pendingRecreate = null;
    setStatus("Engine: variations ready");
    setTip("Variations complete.");
    updatePortraitIdle();
    renderQuickActions();
    renderHudReadout();
    processActionQueue().catch(() => {});
  }
}

function renderMultiCanvas(wctx, octx, canvasW, canvasH) {
  const items = state.images || [];
  for (const item of items) {
    ensureCanvasImageLoaded(item);
  }

  state.multiRects = computeMultiRects(items, canvasW, canvasH);
  const ms = state.multiView?.scale || 1;
  const mox = state.multiView?.offsetX || 0;
  const moy = state.multiView?.offsetY || 0;

  const dpr = getDpr();
  wctx.save();
  wctx.imageSmoothingEnabled = true;
  wctx.imageSmoothingQuality = "high";

  for (const item of items) {
    const rect = item?.id ? state.multiRects.get(item.id) : null;
    if (!rect) continue;
    const x = rect.x * ms + mox;
    const y = rect.y * ms + moy;
    const w = rect.w * ms;
    const h = rect.h * ms;
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
    octx.strokeRect(
      activeRect.x * ms + mox - 2,
      activeRect.y * ms + moy - 2,
      activeRect.w * ms + 4,
      activeRect.h * ms + 4
    );
    octx.restore();
  }
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

  const item = getActiveImage();

  if (state.canvasMode === "multi") {
    renderMultiCanvas(wctx, octx, work.width, work.height);
  } else {
    const img = item?.img;
    if (img) {
      wctx.save();
      wctx.setTransform(state.view.scale, 0, 0, state.view.scale, state.view.offsetX, state.view.offsetY);
      wctx.imageSmoothingEnabled = true;
      wctx.imageSmoothingQuality = "high";
      wctx.drawImage(img, 0, 0);
      wctx.restore();
    }
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

  const annotateBox = state.annotateDraft || state.annotateBox;
  if (annotateBox && item?.id && annotateBox.imageId === item.id) {
    const dpr = getDpr();
    const a = imageToCanvas({ x: Number(annotateBox.x0) || 0, y: Number(annotateBox.y0) || 0 });
    const b = imageToCanvas({ x: Number(annotateBox.x1) || 0, y: Number(annotateBox.y1) || 0 });
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.max(1, Math.abs(a.x - b.x));
    const h = Math.max(1, Math.abs(a.y - b.y));
    octx.save();
    octx.lineWidth = Math.max(1, Math.round(2 * dpr));
    octx.strokeStyle = "rgba(82, 255, 148, 0.92)";
    octx.fillStyle = "rgba(82, 255, 148, 0.10)";
    if (state.annotateDraft) {
      octx.setLineDash([Math.round(8 * dpr), Math.round(6 * dpr)]);
    }
    octx.fillRect(x, y, w, h);
    octx.strokeRect(x, y, w, h);
    octx.setLineDash([]);
    octx.restore();
  }

  if (item?.id) {
    const dpr = getDpr();
    const circles = _getCircles(item.id);
    const draft = state.circleDraft && state.circleDraft.imageId === item.id ? state.circleDraft : null;
    const activeCircleId = state.activeCircle?.imageId === item.id ? state.activeCircle.id : null;

    const drawCircle = (circle, { isDraft = false } = {}) => {
      if (!circle) return;
      const geom = circleImageToCanvasGeom(circle);
      if (!geom.r || geom.r < 1) return;
      const color = circle.color || "rgba(255, 95, 95, 0.92)";
      const fill = "rgba(255, 95, 95, 0.08)";
      const isActive = !isDraft && activeCircleId && circle.id === activeCircleId;

      octx.save();
      octx.lineWidth = Math.max(1, Math.round((isActive ? 2.8 : 2) * dpr));
      octx.strokeStyle = color;
      octx.fillStyle = fill;
      if (isActive) {
        octx.shadowColor = "rgba(255, 95, 95, 0.22)";
        octx.shadowBlur = Math.round(16 * dpr);
      }
      if (isDraft) {
        octx.setLineDash([Math.round(10 * dpr), Math.round(8 * dpr)]);
      }
      octx.beginPath();
      octx.arc(geom.cx, geom.cy, geom.r, 0, Math.PI * 2);
      octx.stroke();
      if (!isDraft) octx.fill();
      octx.setLineDash([]);

      const label = String(circle.label || "").trim();
	      if (label) {
	        octx.shadowBlur = 0;
	        octx.font = `${Math.max(10, Math.round(11 * dpr))}px IBM Plex Mono`;
	        octx.textBaseline = "middle";
	        octx.fillStyle = color;
	        const x = geom.cx + geom.r + Math.round(10 * dpr);
	        const y = geom.cy;
	        // Tiny dark underlay for legibility against bright pixels.
	        octx.globalAlpha = 0.85;
        octx.fillStyle = "rgba(0, 0, 0, 0.62)";
        octx.fillText(label, x + Math.round(1 * dpr), y + Math.round(1 * dpr));
	        octx.globalAlpha = 1;
	        octx.fillStyle = color;
	        octx.fillText(label, x, y);
	      }
      octx.restore();
    };

    for (const circle of circles.slice(-24)) {
      drawCircle(circle, { isDraft: false });
    }
    if (draft) {
      drawCircle(draft, { isDraft: true });
    }
  }

  if (item?.id) {
    const dpr = getDpr();
    const marks = _getDesignations(item.id);
    const pending = state.pendingDesignation?.imageId === item.id ? state.pendingDesignation : null;
    if ((marks && marks.length) || pending) {
      octx.save();
      octx.lineWidth = Math.max(1, Math.round(1.6 * dpr));
      octx.font = `${Math.max(10, Math.round(11 * dpr))}px IBM Plex Mono`;
      octx.textBaseline = "middle";

      const drawMark = (pt, color, label) => {
        if (!pt) return;
        const c = imageToCanvas(pt);
        const r = Math.max(4, Math.round(5.5 * dpr));
        octx.strokeStyle = color;
        octx.fillStyle = color;
        octx.beginPath();
        octx.arc(c.x, c.y, r, 0, Math.PI * 2);
        octx.stroke();
        if (label) {
          octx.globalAlpha = 0.95;
          octx.fillText(label, c.x + r + Math.round(6 * dpr), c.y);
          octx.globalAlpha = 1;
        }
      };

      for (const mark of marks.slice(-16)) {
        const kind = String(mark?.kind || "");
        const label = kind ? kind.slice(0, 1).toUpperCase() : "";
        drawMark({ x: Number(mark?.x) || 0, y: Number(mark?.y) || 0 }, "rgba(100, 210, 255, 0.82)", label);
      }
      if (pending) {
        drawMark({ x: Number(pending.x) || 0, y: Number(pending.y) || 0 }, "rgba(255, 212, 0, 0.92)", "?");
      }
      octx.restore();
    }
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

  els.overlayCanvas.addEventListener("contextmenu", (event) => {
    bumpInteraction();
    if (!getActiveImage()) return;
    event.preventDefault();
    hideDesignateMenu();

    let hit = null;
    if (state.canvasMode === "multi") {
      const p = canvasPointFromEvent(event);
      hit = hitTestMulti(p);
    } else {
      hit = state.activeId;
    }
    if (!hit) return;
    showImageMenuAt(canvasCssPointFromEvent(event), hit);
    // Prevent global "click outside" handlers from immediately closing the menu.
    event.stopPropagation();
  });

  els.overlayCanvas.addEventListener("pointerdown", (event) => {
    bumpInteraction();
	    hideDesignateMenu();
	    if (state.canvasMode === "multi") {
	      const canvas = els.workCanvas;
	      if (canvas && state.multiRects.size === 0) {
	        state.multiRects = computeMultiRects(state.images, canvas.width, canvas.height);
	      }

	      const p = canvasPointFromEvent(event);
	      let hit = hitTestMulti(p);
	      if (!hit && canvas) {
	        state.multiRects = computeMultiRects(state.images, canvas.width, canvas.height);
	        hit = hitTestMulti(p);
	      }

	      if (hit && hit !== state.activeId) setActiveImage(hit).catch(() => {});

	      if (state.tool === "pan") {
	        els.overlayCanvas.setPointerCapture(event.pointerId);
	        state.pointer.active = true;
	        state.pointer.startX = p.x;
	        state.pointer.startY = p.y;
        state.pointer.lastX = p.x;
        state.pointer.lastY = p.y;
        state.pointer.startOffsetX = state.multiView.offsetX;
        state.pointer.startOffsetY = state.multiView.offsetY;
	        requestRender();
	        return;
	      }

	      if (!hit) return;

	      const img = state.imagesById.get(hit) || getActiveImage();
	      if (!img) return;
	      if (!img.img && (!img.width || !img.height)) {
	        ensureCanvasImageLoaded(img);
	        showToast("Loading image…", "info", 1400);
	        return;
	      }

		      if (state.tool === "designate") {
		        const imgPt = canvasToImage(p);
		        state.pendingDesignation = { imageId: img.id, x: imgPt.x, y: imgPt.y, at: Date.now() };
		        showDesignateMenuAt(canvasCssPointFromEvent(event));
            // Prevent the global "click outside" handler from immediately closing the menu.
            event.stopPropagation();
		        requestRender();
		        return;
		      }

		      if (state.tool === "annotate") {
		        const imgPt = canvasToImage(p);
		        if (event.shiftKey) {
		          hideAnnotatePanel();
		          hideMarkPanel();
		          state.annotateBox = null;
		          state.annotateDraft = null;
		          els.overlayCanvas.setPointerCapture(event.pointerId);
		          state.pointer.active = true;
		          state.pointer.startX = p.x;
		          state.pointer.startY = p.y;
		          state.pointer.lastX = p.x;
		          state.pointer.lastY = p.y;
		          state.circleDraft = {
		            imageId: img.id,
		            cx: imgPt.x,
		            cy: imgPt.y,
		            r: 0,
		            color: "rgba(255, 95, 95, 0.92)",
		            at: Date.now(),
		          };
		          requestRender();
		          return;
		        }

		        const circles = _getCircles(img.id);
		        const hitCircle = hitTestCircleMarks(p, circles);
		        if (hitCircle) {
		          hideAnnotatePanel();
		          showMarkPanelForCircle(hitCircle);
		          requestRender();
		          return;
		        }

		        hideMarkPanel();
		        els.overlayCanvas.setPointerCapture(event.pointerId);
		        state.pointer.active = true;
		        state.pointer.startX = p.x;
		        state.pointer.startY = p.y;
		        state.pointer.lastX = p.x;
		        state.pointer.lastY = p.y;
		        state.annotateBox = null;
		        hideAnnotatePanel();
		        state.annotateDraft = {
		          imageId: img.id,
		          x0: imgPt.x,
		          y0: imgPt.y,
		          x1: imgPt.x,
		          y1: imgPt.y,
		          at: Date.now(),
		        };
		        requestRender();
		        return;
		      }

	      if (state.tool === "lasso") {
	        els.overlayCanvas.setPointerCapture(event.pointerId);
	        state.pointer.active = true;
	        state.pointer.startX = p.x;
        state.pointer.startY = p.y;
        state.pointer.lastX = p.x;
        state.pointer.lastY = p.y;
        state.pointer.startOffsetX = state.multiView.offsetX;
        state.pointer.startOffsetY = state.multiView.offsetY;
        state.selection = null;
        state.lassoDraft = [canvasToImage(p)];
	        requestRender();
	        return;
	      }
	      return;
		    }
		    const img = getActiveImage();
		    if (!img) return;
        const p = canvasPointFromEvent(event);
		    if (state.tool === "designate") {
		      const imgPt = canvasToImage(p);
		      state.pendingDesignation = { imageId: img.id, x: imgPt.x, y: imgPt.y, at: Date.now() };
		      showDesignateMenuAt(canvasCssPointFromEvent(event));
          // Prevent the global "click outside" handler from immediately closing the menu.
          event.stopPropagation();
		      requestRender();
		      return;
		    }

        if (state.tool === "annotate" && !event.shiftKey) {
          const circles = _getCircles(img.id);
          const hitCircle = hitTestCircleMarks(p, circles);
          if (hitCircle) {
            hideAnnotatePanel();
            showMarkPanelForCircle(hitCircle);
            requestRender();
            return;
          }
        }

		    els.overlayCanvas.setPointerCapture(event.pointerId);
		    state.pointer.active = true;
	    state.pointer.startX = p.x;
	    state.pointer.startY = p.y;
	    state.pointer.lastX = p.x;
	    state.pointer.lastY = p.y;
    state.pointer.startOffsetX = state.view.offsetX;
		    state.pointer.startOffsetY = state.view.offsetY;

		    if (state.tool === "annotate") {
		      const imgPt = canvasToImage(p);
          if (event.shiftKey) {
            hideAnnotatePanel();
            hideMarkPanel();
            state.annotateBox = null;
            state.annotateDraft = null;
            state.circleDraft = {
              imageId: img.id,
              cx: imgPt.x,
              cy: imgPt.y,
              r: 0,
              color: "rgba(255, 95, 95, 0.92)",
              at: Date.now(),
            };
            requestRender();
            return;
          }

          hideMarkPanel();
          state.circleDraft = null;
		      state.annotateBox = null;
		      hideAnnotatePanel();
		      state.annotateDraft = {
		        imageId: img.id,
		        x0: imgPt.x,
	        y0: imgPt.y,
	        x1: imgPt.x,
	        y1: imgPt.y,
	        at: Date.now(),
	      };
		      requestRender();
		      return;
		    }

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
		    if (state.tool === "annotate") {
		      const img = getActiveImage();
		      if (!img) return;
          if (state.circleDraft && state.circleDraft.imageId === img.id) {
            const imgPt = canvasToImage(p);
            const dxImg = (Number(imgPt.x) || 0) - (Number(state.circleDraft.cx) || 0);
            const dyImg = (Number(imgPt.y) || 0) - (Number(state.circleDraft.cy) || 0);
            state.circleDraft.r = Math.max(0, Math.hypot(dxImg, dyImg));
            requestRender();
            return;
          }
		      if (!state.annotateDraft || state.annotateDraft.imageId !== img.id) return;
		      const imgPt = canvasToImage(p);
		      state.annotateDraft.x1 = imgPt.x;
		      state.annotateDraft.y1 = imgPt.y;
		      requestRender();
		      return;
		    }
	    if (state.tool === "pan") {
	      if (state.canvasMode === "multi") {
	        state.multiView.offsetX = state.pointer.startOffsetX + dx;
	        state.multiView.offsetY = state.pointer.startOffsetY + dy;
	      } else {
	        state.view.offsetX = state.pointer.startOffsetX + dx;
	        state.view.offsetY = state.pointer.startOffsetY + dy;
	      }
        scheduleVisualPromptWrite();
	      requestRender();
	      return;
	    }
	    if (state.tool === "lasso") {
	      const imgPt = canvasToImage(p);
	      const last = state.lassoDraft[state.lassoDraft.length - 1];
	      const dist2 = (imgPt.x - last.x) ** 2 + (imgPt.y - last.y) ** 2;
	      let scale = state.view.scale;
	      if (state.canvasMode === "multi") {
	        const ms = state.multiView?.scale || 1;
	        const img = getActiveImage();
	        const rect = img?.id ? state.multiRects.get(img.id) : null;
	        if (img && rect) {
	          const iw = img?.img?.naturalWidth || img?.width || rect.w || 1;
	          const ih = img?.img?.naturalHeight || img?.height || rect.h || 1;
	          const sx = rect.w / Math.max(1, iw);
	          const sy = rect.h / Math.max(1, ih);
	          scale = Math.min(sx, sy) * ms;
	        } else {
	          scale = ms;
	        }
	      }
      const minDist = 4 / Math.max(scale, 0.02);
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
		    if (state.tool === "annotate") {
		      const img = getActiveImage();
          if (img && state.circleDraft && state.circleDraft.imageId === img.id) {
            const draft = state.circleDraft;
            state.circleDraft = null;
            const r = Math.max(0, Number(draft?.r) || 0);
            if (r >= 6) {
              const entry = {
                id: `c-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                imageId: img.id,
                cx: Number(draft?.cx) || 0,
                cy: Number(draft?.cy) || 0,
                r,
                color: draft?.color ? String(draft.color) : "rgba(255, 95, 95, 0.92)",
                label: "",
                at: Date.now(),
              };
              const list = _getCircles(img.id).slice();
              list.push(entry);
              state.circlesByImageId.set(img.id, list);
              showMarkPanelForCircle(entry);
              scheduleVisualPromptWrite();
	            } else {
	              hideMarkPanel();
	            }
	            requestRender();
	          }
		      const draft = state.annotateDraft;
		      state.annotateDraft = null;
		      if (img && draft && draft.imageId === img.id) {
		        const normalized = _normalizeAnnotateBox(draft, img);
	        const w = Math.abs((normalized?.x1 || 0) - (normalized?.x0 || 0));
	        const h = Math.abs((normalized?.y1 || 0) - (normalized?.y0 || 0));
	        if (normalized && w >= 8 && h >= 8) {
		          state.annotateBox = normalized;
		          showAnnotatePanelForBox();
              scheduleVisualPromptWrite();
		        } else {
		          state.annotateBox = null;
		          hideAnnotatePanel();
              scheduleVisualPromptWrite();
		        }
		      }
		      requestRender();
		    }
	    if (state.tool === "lasso") {
	      if (state.lassoDraft.length >= 3) {
	        state.selection = { points: state.lassoDraft.slice(), closed: true, at: Date.now() };
	      } else {
	        state.selection = null;
	      }
	      state.lassoDraft = [];
	      renderSelectionMeta();
	      chooseSpawnNodes();
        scheduleVisualPromptWrite();
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
      event.preventDefault();
      const p = canvasPointFromEvent(event);
      const factor = Math.exp(-event.deltaY * 0.0012);
      if (state.canvasMode === "multi") {
        const before = {
          x: (p.x - (state.multiView?.offsetX || 0)) / Math.max(state.multiView?.scale || 1, 0.0001),
          y: (p.y - (state.multiView?.offsetY || 0)) / Math.max(state.multiView?.scale || 1, 0.0001),
        };
        const next = clamp((state.multiView?.scale || 1) * factor, 0.05, 40);
        state.multiView.scale = next;
        state.multiView.offsetX = p.x - before.x * state.multiView.scale;
        state.multiView.offsetY = p.y - before.y * state.multiView.scale;
      } else {
        const before = canvasToImage(p);
        const next = clamp(state.view.scale * factor, 0.05, 40);
        state.view.scale = next;
        state.view.offsetX = p.x - before.x * state.view.scale;
        state.view.offsetY = p.y - before.y * state.view.scale;
      }
      renderHudReadout();
      scheduleVisualPromptWrite();
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
    if (state.images.length > 1) {
      setCanvasMode("multi");
      setTip("Multiple photos loaded. Click a photo to focus it.");
      scheduleAutoCanvasDiagnose();
    }
  });
}

function installUi() {
  if (els.newRun) els.newRun.addEventListener("click", () => createRun().catch((e) => console.error(e)));
  if (els.openRun) els.openRun.addEventListener("click", () => openExistingRun().catch((e) => console.error(e)));
  if (els.import) els.import.addEventListener("click", () => importPhotos().catch((e) => console.error(e)));
  if (els.export) els.export.addEventListener("click", () => exportRun().catch((e) => console.error(e)));

  if (els.dropHint) {
    const openPicker = (event) => {
      if (els.dropHint.classList.contains("hidden")) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      importPhotos().catch((e) => console.error(e));
    };
    els.dropHint.addEventListener("click", openPicker);
    els.dropHint.addEventListener("keydown", (event) => {
      const key = String(event?.key || "");
      if (key === "Enter" || key === " ") {
        openPicker(event);
      }
    });
  }

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
      updatePortraitIdle({ fromSettings: true });
      if (state.ptySpawned) {
        invoke("write_pty", { data: `/image_model ${settings.imageModel}\n` }).catch(() => {});
      }
    });
  }

  for (const btn of els.toolButtons) {
    btn.addEventListener("click", () => {
      bumpInteraction();
      const tool = btn.dataset.tool;
      if (tool === "annotate" || tool === "pan" || tool === "lasso" || tool === "designate") {
        setTool(tool);
        return;
      }
      if (tool === "bg") {
        applyBackground("white").catch((e) => console.error(e));
        return;
      }
      if (tool === "remove_people") {
        aiRemovePeople().catch((e) => console.error(e));
        return;
      }
      if (tool === "variations") {
        runVariations().catch((e) => console.error(e));
        return;
      }
      if (tool === "surprise") {
        aiSurpriseMe().catch((e) => console.error(e));
        return;
      }
      if (tool === "respawn") {
        respawnActions();
        return;
      }
    });
  }

  if (els.annotateClose) {
    els.annotateClose.addEventListener("click", () => {
      bumpInteraction();
      state.annotateDraft = null;
      state.annotateBox = null;
      hideAnnotatePanel();
      scheduleVisualPromptWrite();
      requestRender();
    });
  }
  if (els.annotateCancel) {
    els.annotateCancel.addEventListener("click", () => {
      bumpInteraction();
      state.annotateDraft = null;
      state.annotateBox = null;
      hideAnnotatePanel();
      scheduleVisualPromptWrite();
      requestRender();
    });
  }
  if (els.annotateSend) {
    els.annotateSend.addEventListener("click", () => {
      aiAnnotateEdit().catch((e) => console.error(e));
    });
  }
  if (els.annotateText) {
    els.annotateText.addEventListener("keydown", (event) => {
      const key = String(event?.key || "");
      const mod = Boolean(event?.metaKey || event?.ctrlKey);
      if (mod && key === "Enter") {
        event.preventDefault();
        aiAnnotateEdit().catch((e) => console.error(e));
      }
    });
  }

  if (els.markClose) {
    els.markClose.addEventListener("click", () => {
      bumpInteraction();
      hideMarkPanel();
      requestRender();
    });
  }
  if (els.markSave) {
    els.markSave.addEventListener("click", () => {
      bumpInteraction();
      updateActiveCircleLabel(String(els.markText?.value || ""));
      hideMarkPanel();
      requestRender();
      showToast("Circle label saved.", "tip", 1400);
    });
  }
  if (els.markDelete) {
    els.markDelete.addEventListener("click", () => {
      bumpInteraction();
      const ok = deleteActiveCircle();
      if (ok) showToast("Circle deleted.", "tip", 1400);
    });
  }
  if (els.markText) {
    els.markText.addEventListener("keydown", (event) => {
      const key = String(event?.key || "");
      const mod = Boolean(event?.metaKey || event?.ctrlKey);
      if (mod && key === "Enter") {
        event.preventDefault();
        updateActiveCircleLabel(String(els.markText?.value || ""));
        hideMarkPanel();
        requestRender();
        showToast("Circle label saved.", "tip", 1400);
      }
    });
  }

  if (els.designateMenu) {
    els.designateMenu.addEventListener("click", (event) => {
      const btn = event?.target?.closest ? event.target.closest("button[data-kind]") : null;
      if (!btn || !els.designateMenu.contains(btn)) return;
      bumpInteraction();
      const kind = btn.dataset?.kind;
      if (!kind) return;
      if (kind === "clear") {
        _clearDesignations();
        btn.classList.add("confirm");
        setTimeout(() => hideDesignateMenuAnimated({ animate: true }), 360);
        setTip("Designate: cleared.");
        requestRender();
        return;
      }

      const committed = _commitDesignation(kind);
      btn.classList.add("confirm");
      setTimeout(() => hideDesignateMenuAnimated({ animate: true }), 360);
      if (!committed) {
        showToast(`Designate: ${kind}. Click the image to place a point.`, "tip", 2200);
      } else {
        showToast(`Designated: ${kind}`, "tip", 1400);
      }
      renderHudReadout();
    });
  }

  if (els.imageMenu) {
    els.imageMenu.addEventListener("click", (event) => {
      const btn = event?.target?.closest ? event.target.closest("button[data-action]") : null;
      if (!btn || !els.imageMenu.contains(btn)) return;
      bumpInteraction();
      const action = btn.dataset?.action;
      if (!action) return;
      if (action === "cancel") {
        hideImageMenu();
        return;
      }
      if (action === "remove") {
        const targetId = state.imageMenuTargetId;
        hideImageMenu();
        if (targetId) {
          removeImageFromCanvas(targetId).catch((err) => console.error(err));
        }
      }
    });
  }

  document.addEventListener("pointerdown", (event) => {
    if (!els.designateMenu || els.designateMenu.classList.contains("hidden")) return;
    const hit = event?.target?.closest ? event.target.closest("#designate-menu") : null;
    if (hit) return;
    hideDesignateMenu();
  });

  document.addEventListener("pointerdown", (event) => {
    if (!els.imageMenu || els.imageMenu.classList.contains("hidden")) return;
    const hit = event?.target?.closest ? event.target.closest("#image-menu") : null;
    if (hit) return;
    hideImageMenu();
  });

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
    const rawKey = String(event?.key || "");
    const key = rawKey.toLowerCase();
    const target = event?.target;
    const tag = target?.tagName ? String(target.tagName).toLowerCase() : "";
    const isEditable = Boolean(
      target &&
        (target.isContentEditable ||
          tag === "input" ||
          tag === "textarea" ||
          tag === "select")
    );
    const hasModifier = Boolean(event?.metaKey || event?.ctrlKey || event?.altKey);

		    if (key === "escape") {
		      if (els.settingsDrawer && !els.settingsDrawer.classList.contains("hidden")) {
		        els.settingsDrawer.classList.add("hidden");
		        return;
		      }
	        if (els.markPanel && !els.markPanel.classList.contains("hidden")) {
	          hideMarkPanel();
	          requestRender();
	          return;
	        }
	        if (els.imageMenu && !els.imageMenu.classList.contains("hidden")) {
	          hideImageMenu();
	          return;
	        }
		      if (els.annotatePanel && !els.annotatePanel.classList.contains("hidden")) {
		        state.annotateDraft = null;
		        state.annotateBox = null;
		        hideAnnotatePanel();
	          scheduleVisualPromptWrite();
		        requestRender();
		        return;
		      }
	      if (state.pendingDesignation || (els.designateMenu && !els.designateMenu.classList.contains("hidden"))) {
	        state.pendingDesignation = null;
	        hideDesignateMenuAnimated({ animate: false });
	        requestRender();
	        return;
      }
      clearSelection();
      return;
    }

	    if (isEditable || hasModifier) return;

      if (key === "backspace" || key === "delete") {
        if (state.activeCircle) {
          const ok = deleteActiveCircle();
          if (ok) showToast("Circle deleted.", "tip", 1400);
          return;
        }
      }

	    // HUD action grid 1-9.
	    if (/^[1-9]$/.test(rawKey)) {
	      const digit = rawKey;
	      const btn = document.querySelector(`.hud-keybar .tool[data-hotkey="${digit}"][data-tool]`);
	      if (btn) {
        btn.click();
        return;
      }
    }

    if (key === "l") {
      setTool("lasso");
      return;
    }
    if (key === "v") {
      setTool("pan");
      return;
    }
    if (key === "d") {
      setTool("designate");
      return;
    }
    if (key === "b") {
      applyBackground("white").catch((e) => console.error(e));
      return;
    }
    if (key === "r") {
      runVariations().catch((e) => console.error(e));
      return;
    }
    if (key === "f") {
      resetViewToFit();
      return;
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
  // Keep decorative canvas bumpers matched to the HUD height.
  const hudShell = els.hud ? els.hud.querySelector(".hud-shell") : null;
  if (typeof ResizeObserver === "function" && (hudShell || els.hud)) {
    try {
      if (hudResizeObserver) hudResizeObserver.disconnect();
      hudResizeObserver = new ResizeObserver(() => {
        syncHudHeightVar();
      });
      hudResizeObserver.observe(hudShell || els.hud);
      requestAnimationFrame(() => syncHudHeightVar());
    } catch {
      // ignore
    }
  }
  installDprWatcher();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopLarvaAnimator();
    } else {
      ensureLarvaAnimator();
    }
  });

  new ResizeObserver(() => {
    ensureCanvasSize();
    scheduleVisualPromptWrite();
    requestRender();
  }).observe(els.canvasWrap);

  installCanvasHandlers();
  installDnD();
  installUi();
  startSpawnTimer();

  await listen("pty-exit", () => {
    setStatus("Engine: exited", true);
    state.ptySpawned = false;
    resetDescribeQueue({ clearPending: true });
    state.expectingArtifacts = false;
    state.pendingBlend = null;
    state.pendingSwapDna = null;
    state.pendingBridge = null;
    state.pendingRecast = null;
    state.pendingDiagnose = null;
    state.pendingArgue = null;
    clearPendingReplace();
    state.engineImageModelRestore = null;
    setImageFxActive(false);
    updatePortraitIdle();
    setDirectorText(null, null);
    renderQuickActions();
  });

  // Consume PTY stdout as a fallback for vision describe completion/errors.
  // Desktop normally uses `events.jsonl`, but if event polling is disrupted, this
  // keeps the HUD "DESC" from getting stuck at SCANNING.
  await listen("pty-data", (event) => {
    const chunk = event?.payload;
    if (typeof chunk !== "string" || !chunk) return;
    ptyLineBuffer += chunk;
    const lines = ptyLineBuffer.split("\n");
    ptyLineBuffer = lines.pop() || "";
    for (const line of lines) {
      _handlePtyLine(line);
    }
  });

  // Auto-create a run for speed; users can always "Open Run" later.
  await createRun();
  requestRender();
}

boot().catch((err) => {
  console.error(err);
  setStatus(`Engine: boot failed (${err?.message || err})`, true);
});
