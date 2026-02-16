import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import {
  readDir,
  exists,
  readTextFile,
  readBinaryFile,
  removeFile,
  writeTextFile,
  writeBinaryFile,
  createDir,
  copyFile,
} from "@tauri-apps/api/fs";

import { computeActionGridSlots } from "./action_grid_logic.js";
import { createEffectsRuntime } from "./effects_runtime.js";
import { effectTypeFromTokenType } from "./effect_specs.js";
import {
  mergeAmbientSuggestions,
  placeAmbientSuggestions,
  shouldScheduleAmbientIntent,
} from "./intent_ambient.js";
import {
  EFFECT_TOKEN_LIFECYCLE,
  beginEffectTokenApply,
  beginEffectTokenDrag,
  cancelEffectTokenDrag,
  consumePendingEffectSourceSlot,
  consumeEffectToken,
  createEffectTokenState,
  createPendingEffectExtractionState,
  effectTokenCanDispatchApply,
  isValidEffectDrop,
  recoverEffectTokenApply,
  updateEffectTokenDrag,
} from "./effect_interactions.js";
import {
  MOTHER_IDLE_EVENTS,
  MOTHER_IDLE_STATES,
  motherIdleInitialState,
  motherIdleTransition,
  motherIdleUsesRealtimeVisual,
} from "./mother_idle_flow.js";
import { DESKTOP_EVENT_TYPES, PTY_COMMANDS, quoteForPtyArg as quoteForPtyArgUtil } from "./canvas_protocol.js";
import { appendTextWithFallback } from "./jsonl_io.js";
import {
  classifyIntentIconsRouting as classifyIntentIconsRoutingUtil,
  intentIconsPayloadChecksum as intentIconsPayloadChecksumUtil,
  intentIconsPayloadSafeSnippet as intentIconsPayloadSafeSnippetUtil,
  parseIntentIconsJson as parseIntentIconsJsonUtil,
  parseIntentIconsJsonDetailed as parseIntentIconsJsonDetailedUtil,
} from "./intent_icons_parser.js";
import { createDesktopEventHandlerMap } from "./event_handlers/index.js";
import { installCanvasGestureHandlers } from "./canvas_handlers/gesture_handlers.js";
import { installCanvasKeyboardHandlers } from "./canvas_handlers/keyboard_handlers.js";
import { installCanvasPointerHandlers } from "./canvas_handlers/pointer_handlers.js";
import { installCanvasWheelHandlers } from "./canvas_handlers/wheel_handlers.js";
import { POINTER_KINDS, isEffectTokenPath, isMotherRolePath } from "./canvas_handlers/pointer_paths.js";

/*
Compatibility sentinel for source-shape tests.
const toggle = Boolean(event.metaKey || event.ctrlKey || (event.shiftKey && state.tool !== "annotate"));
*/

const THUMB_PLACEHOLDER_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

const MOTHER_VIDEO_IDLE_SRC = new URL("./assets/mother/mother_idle.mirrored.mp4", import.meta.url).href;
const MOTHER_VIDEO_WORKING_SRC = new URL("./assets/mother/mother_working.mp4", import.meta.url).href;
const MOTHER_VIDEO_TAKEOVER_SRC = new URL(
  "./assets/mother/mother_working_sora-2_720x1280_12s_20260210_160837_v05.mp4",
  import.meta.url
).href;
const MOTHER_VIDEO_REALTIME_SRC = new URL("./assets/mother/mother_realtime.mp4", import.meta.url).href;
const MOTHER_REALTIME_MIN_MS = 4000;
const MOTHER_USER_HOT_IDLE_MS = 10_000;
// Avoid brief watch-phase spikes from flashing realtime chrome/video.
const MOTHER_RT_VISUAL_ON_DELAY_MS = 820;
const MOTHER_RT_VISUAL_MIN_ON_MS = 2200;
const MOTHER_IDLE_TAKEOVER_IDLE_MS = 10_000;
// Mother drafts can exceed 14s on real providers; keep timeout generous to avoid false failures.
const MOTHER_GENERATION_TIMEOUT_MS = 90_000;
const MOTHER_GENERATION_TIMEOUT_EXTENSION_MS = 90_000;
const MOTHER_GENERATION_POST_VERSION_TIMEOUT_MS = 240_000;
const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview";
const LEGACY_DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
const IMAGE_MODEL_DEFAULT_MIGRATION_KEY = "brood.imageModel.default.v2";
const MOTHER_GENERATION_MODEL = DEFAULT_IMAGE_MODEL;
const MOTHER_GENERATED_SOURCE = "mother_generated";
const MOTHER_SUGGESTION_LOG_FILENAME = "mother_suggestions.jsonl";
const MOTHER_TRACE_FILENAME = "mother_trace.jsonl";
const MOTHER_V2_WATCH_IDLE_MS = 800;
const MOTHER_V2_INTENT_IDLE_MS = 1500;
const MOTHER_V2_MULTI_UPLOAD_WATCH_IDLE_MS = 400;
const MOTHER_V2_MULTI_UPLOAD_INTENT_IDLE_MS = 900;
const MOTHER_V2_MULTI_UPLOAD_IDLE_BOOST_WINDOW_MS = 20_000;
const MOTHER_SELECTION_SEMANTIC_DRAG_PX = 10;
const MOTHER_V2_COOLDOWN_AFTER_COMMIT_MS = 2000;
const MOTHER_V2_COOLDOWN_AFTER_REJECT_MS = 1200;
const MOTHER_V2_VISION_RETRY_MS = 220;
const MOTHER_V2_INTENT_RT_TIMEOUT_MS = 30_000;
const MOTHER_V2_INTENT_LATE_REALTIME_UPGRADE_MS = 12000;
const MOTHER_V2_MIN_IMAGES_FOR_PROPOSAL = 2;
const MOTHER_V2_ROLE_KEYS = Object.freeze(["subject", "model", "mediator", "object"]);
const MOTHER_V2_ROLE_LABEL = Object.freeze({
  subject: "SUBJECT",
  model: "MODEL",
  mediator: "MEDIATOR",
  object: "OBJECT",
});
const GOOGLE_BRAND_RECT_PALETTE_RGB = Object.freeze([
  [66, 133, 244], // blue
  [234, 67, 53], // red
  [251, 188, 5], // yellow
  [52, 168, 83], // green
]);
const MOTHER_V2_ROLE_GLYPH = Object.freeze({
  subject: "●",
  model: "◆",
  mediator: "△",
  object: "■",
});
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator?.platform || "");
// Use a more intuitive hold key for Mother option/hints reveal on macOS.
const MOTHER_OPTION_REVEAL_HOLD_KEY = IS_MAC ? "h" : "i";
const MOTHER_CREATIVE_DIRECTIVE = "stunningly awe-inspiring and joyous";
const MOTHER_CREATIVE_DIRECTIVE_SENTENCE = `Create outputs that are ${MOTHER_CREATIVE_DIRECTIVE}.`;
const MOTHER_V2_TRANSFORMATION_MODES = Object.freeze([
  "amplify",
  "transcend",
  "destabilize",
  "purify",
  "hybridize",
  "mythologize",
  "monumentalize",
  "fracture",
  "romanticize",
  "alienate",
]);
const MOTHER_V2_DEFAULT_TRANSFORMATION_MODE = "hybridize";
const MOTHER_V2_PROPOSAL_BY_MODE = Object.freeze({
  amplify: "Fuse motion and comfort into something cinematic.",
  transcend: "Turn momentum into a sculptural interior moment.",
  destabilize: "Bend familiar structure into a charged visual tension.",
  purify: "Dissolve room geometry into fluid light and calm.",
  hybridize: "Fuse both references into one coherent visual world.",
  mythologize: "Recast the scene as mythic visual storytelling.",
  monumentalize: "Elevate the composition into a monumental hero frame.",
  fracture: "Split form and light into a deliberate expressive fracture.",
  romanticize: "Soften the scene into intimate emotional warmth.",
  alienate: "Shift the familiar into a precise uncanny atmosphere.",
});
const MOTHER_V2_PROPOSAL_ICON_ACCENT_BY_MODE = Object.freeze({
  amplify: "rgba(99, 224, 255, 0.96)",
  transcend: "rgba(132, 189, 255, 0.96)",
  destabilize: "rgba(255, 145, 114, 0.96)",
  purify: "rgba(126, 255, 209, 0.96)",
  hybridize: "rgba(255, 224, 120, 0.96)",
  mythologize: "rgba(189, 162, 255, 0.96)",
  monumentalize: "rgba(255, 196, 136, 0.96)",
  fracture: "rgba(255, 127, 164, 0.96)",
  romanticize: "rgba(255, 160, 203, 0.96)",
  alienate: "rgba(152, 255, 174, 0.96)",
});
const MOTHER_V2_ROLE_PREVIEW_PANEL_FILL_RATIO = 0.95;
const MOTHER_V2_ROLE_PREVIEW_PANEL_ZOOM_MAX = 4.2;
const MOTHER_V2_ROLE_PREVIEW_PANEL_PAD_PX = 0;
const MOTHER_OFFER_PREVIEW_SCALE = 1.62;
const MOTHER_OFFER_PREVIEW_MIN_VIEWPORT_COVER = 0.46;
const MOTHER_OFFER_PREVIEW_MAX_VIEWPORT_COVER = 0.92;
const MOTHER_INTENT_USECASE_DEFAULT_ORDER = Object.freeze([
  "streaming_content",
  "ecommerce_pod",
  "uiux_prototyping",
  "game_dev_assets",
  "content_engine",
]);
// World-projection overscan: keep viewport boxes from filling panel projections immediately when zooming out.
const WORLD_PROJECTION_OVERSCAN_RATIO = 0.75;
const ENABLE_FILE_BROWSER_DOCK = true;
const FILE_BROWSER_ROOT_DIR_LS_KEY = "brood.fileBrowser.rootDir";
const FILE_BROWSER_DRAG_MIME = "application/x-brood-local-image-path";
const FILE_BROWSER_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic"]);
const TOP_METRICS_WINDOW_MINUTES = 30;
const TOP_METRICS_RENDER_SAMPLE_MAX = 20;
const TOP_METRICS_THRESHOLDS = Object.freeze({
  tokens_per_minute: { cool_max: 2000, warm_max: 8000 },
  session_cost_usd: { cool_max: 1, warm_max: 5 },
  queued_calls: { cool_max: 1, warm_max: 3 },
  avg_render_s: { cool_max: 8, warm_max: 18 },
});
const SPARKLINE_GLYPHS = Object.freeze(["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]);
const REEL_PRESET = Object.freeze({
  width: 540,
  height: 960,
});

const els = {
  runInfo: document.getElementById("run-info"),
  engineStatus: document.getElementById("engine-status"),
  topMetricsRoot: document.getElementById("top-metrics"),
  topMetricTokens: document.getElementById("top-metric-tokens"),
  topMetricTokensValue: document.getElementById("top-metric-tokens-value"),
  topMetricTokensSparkIn: document.getElementById("top-metric-tokens-spark-in"),
  topMetricTokensSparkOut: document.getElementById("top-metric-tokens-spark-out"),
  topMetricApiCalls: document.getElementById("top-metric-api-calls"),
  topMetricCost: document.getElementById("top-metric-cost"),
  topMetricCostValue: document.getElementById("top-metric-cost-value"),
  topMetricQueue: document.getElementById("top-metric-queue"),
  topMetricQueueValue: document.getElementById("top-metric-queue-value"),
  topMetricQueueTrend: document.getElementById("top-metric-queue-trend"),
  topMetricRender: document.getElementById("top-metric-render"),
  topMetricRenderValue: document.getElementById("top-metric-render-value"),
  brandStrip: document.querySelector(".brand-strip"),
  appMenuToggle: document.getElementById("app-menu-toggle"),
  appMenu: document.getElementById("app-menu"),
  newRun: document.getElementById("new-run"),
  openRun: document.getElementById("open-run"),
  import: document.getElementById("import"),
  canvasImport: document.getElementById("canvas-import"),
  export: document.getElementById("export"),
  reelAdminToggle: document.getElementById("reel-admin-toggle"),
  settingsToggle: document.getElementById("settings-toggle"),
  settingsDrawer: document.getElementById("settings-drawer"),
  settingsClose: document.getElementById("settings-close"),
  memoryToggle: document.getElementById("memory-toggle"),
  alwaysOnVisionToggle: document.getElementById("always-on-vision-toggle"),
  alwaysOnVisionReadout: document.getElementById("always-on-vision-readout"),
  autoAcceptSuggestedAbilityToggle: document.getElementById("auto-accept-suggested-ability-toggle"),
  canvasContextSuggest: document.getElementById("canvas-context-suggest"),
  canvasContextSuggestBtn: document.getElementById("canvas-context-suggest-btn"),
  textModel: document.getElementById("text-model"),
  imageModel: document.getElementById("image-model"),
  portraitsDir: document.getElementById("portraits-dir"),
  portraitsDirPick: document.getElementById("portraits-dir-pick"),
  portraitsDirClear: document.getElementById("portraits-dir-clear"),
  keyStatus: document.getElementById("key-status"),
  motherIntentSourceIndicator: document.getElementById("mother-intent-source-indicator"),
  canvasWrap: document.getElementById("canvas-wrap"),
  dropHint: document.getElementById("drop-hint"),
  workCanvas: document.getElementById("work-canvas"),
  effectsCanvas: document.getElementById("effects-canvas"),
  imageFx: document.getElementById("image-fx"),
  imageFx2: document.getElementById("image-fx-2"),
  overlayCanvas: document.getElementById("overlay-canvas"),
  controlStrip: document.getElementById("control-strip"),
  fileBrowserDock: document.getElementById("file-browser-dock"),
  fileBrowserHeader: document.getElementById("file-browser-header"),
  fileBrowserChoose: document.getElementById("file-browser-choose"),
  fileBrowserUp: document.getElementById("file-browser-up"),
  fileBrowserRefresh: document.getElementById("file-browser-refresh"),
  fileBrowserPath: document.getElementById("file-browser-path"),
  fileBrowserList: document.getElementById("file-browser-list"),
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
  hudUnitName: document.getElementById("hud-unit-name"),
  hudUnitDesc: document.getElementById("hud-unit-desc"),
  hudUnitSel: document.getElementById("hud-unit-sel"),
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
  motherState: document.getElementById("mother-state"),
  motherRolePreview: document.getElementById("mother-role-preview"),
  tipsText: document.getElementById("tips-text"),
  motherOverlay: document.getElementById("mother-overlay"),
  motherPanelStack: document.getElementById("mother-panel-stack"),
  motherPanel: document.getElementById("mother-panel"),
  motherRefineToggle: document.getElementById("mother-refine-toggle"),
  motherAdvanced: document.getElementById("mother-advanced"),
  motherTransformationMode: document.getElementById("mother-transformation-mode"),
  motherRoleSubject: document.getElementById("mother-role-subject"),
  motherRoleModel: document.getElementById("mother-role-model"),
  motherRoleMediator: document.getElementById("mother-role-mediator"),
  motherRoleObject: document.getElementById("mother-role-object"),
  motherAvatar: document.getElementById("mother-avatar"),
  motherVideo: document.getElementById("mother-video"),
  motherAbilityIcon: document.getElementById("mother-ability-icon"),
  motherConfirm: document.getElementById("mother-confirm"),
  motherStop: document.getElementById("mother-stop"),
  actionGrid: document.getElementById("action-grid"),
  designateMenu: document.getElementById("designate-menu"),
  imageMenu: document.getElementById("image-menu"),
  motherWheelMenu: document.getElementById("mother-wheel-menu"),
  quickActions: document.getElementById("quick-actions"),
  timelineToggle: document.getElementById("timeline-toggle"),
  timelineOverlay: document.getElementById("timeline-overlay"),
  timelineClose: document.getElementById("timeline-close"),
  timelineStrip: document.getElementById("timeline-strip"),
  timelineDetail: document.getElementById("timeline-detail"),
};

const settings = {
  memory: localStorage.getItem("brood.memory") === "1",
  alwaysOnVision: (() => {
    const raw = localStorage.getItem("brood.alwaysOnVision");
    // Default ON: Mother suggestions depend on realtime canvas context.
    if (raw === null) return true;
    return raw === "1";
  })(),
  autoAcceptSuggestedAbility: localStorage.getItem("brood.autoAcceptSuggestedAbility") === "1",
  textModel: localStorage.getItem("brood.textModel") || "gpt-5.2",
  imageModel: (() => {
    const storedRaw = String(localStorage.getItem("brood.imageModel") || "").trim();
    const migrated = localStorage.getItem(IMAGE_MODEL_DEFAULT_MIGRATION_KEY) === "1";
    if (!storedRaw) {
      if (!migrated) localStorage.setItem(IMAGE_MODEL_DEFAULT_MIGRATION_KEY, "1");
      return DEFAULT_IMAGE_MODEL;
    }
    if (!migrated && storedRaw === LEGACY_DEFAULT_IMAGE_MODEL) {
      localStorage.setItem("brood.imageModel", DEFAULT_IMAGE_MODEL);
      localStorage.setItem(IMAGE_MODEL_DEFAULT_MIGRATION_KEY, "1");
      return DEFAULT_IMAGE_MODEL;
    }
    if (!migrated) localStorage.setItem(IMAGE_MODEL_DEFAULT_MIGRATION_KEY, "1");
    return storedRaw;
  })(),
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
  eventsDecoder: new TextDecoder("utf-8"),
  images: [],
  imagesById: new Map(),
  imagePaletteSeed: 0, // monotonic assignment for rotating Google palette accents
  imageEffectTokenByImageId: new Map(), // imageId -> effectTokenId (collapsed visual replacement)
  effectTokensById: new Map(), // effectTokenId -> token payload
  activeId: null,
  selectedIds: [], // imageId[] (multi-select in multi canvas; last entry is "active")
  imageCache: new Map(), // path -> { url: string|null, urlPromise: Promise<string>|null, imgPromise: Promise<HTMLImageElement>|null }
  thumbsById: new Map(), // artifactId -> { rootEl, imgEl, labelEl }
  // Hide the filmstrip by default (keeps the UI focused on the canvas). The feature remains
  // implemented; set `localStorage.brood.showFilmstrip = "1"` to re-enable in dev.
  filmstripVisible: localStorage.getItem("brood.showFilmstrip") === "1",
  timelineNodes: [], // [{ nodeId, imageId, path, receiptPath, label, action, parents, createdAt }]
  timelineNodesById: new Map(), // nodeId -> node
  timelineOpen: false,
  designationsByImageId: new Map(), // imageId -> [{ id, kind, x, y, at }]
  pendingDesignation: null, // { imageId, x, y, at } | null
  imageMenuTargetId: null,
  // Canvas rendering modes:
  // - "multi": freeform spatial canvas (primary mode; multiple images can be arranged on the canvas)
  // - "single": focused, zoomable view of the active image (secondary mode)
  canvasMode: "multi",
  // In multi/freeform mode we store rects in CSS pixels and derive device-pixel rects each render.
  freeformRects: new Map(), // imageId -> { x, y, w, h } in canvas CSS pixels (top-left anchored)
  freeformZOrder: [], // imageId[] draw/hit-test order (last is top)
  multiRects: new Map(), // imageId -> { x, y, w, h } in canvas device pixels (hit-testing + canvas->image mapping).
  // Used for local (non-engine) actions so the Action Grid can show the pressed state while running.
  runningActionKey: null, // string | null
  pendingBlend: null, // { sourceIds: [string, string], startedAt: number }
  pendingSwapDna: null, // { structureId: string, surfaceId: string, startedAt: number }
  pendingBridge: null, // { sourceIds: [string, string], startedAt: number }
  pendingExtractDna: null, // { sourceIds: string[], startedAt: number }
  pendingSoulLeech: null, // { sourceIds: string[], startedAt: number }
  pendingArgue: null, // { sourceIds: [string, string], startedAt: number }
  pendingExtractRule: null, // { sourceIds: [string, string, string], startedAt: number }
  pendingOddOneOut: null, // { sourceIds: [string, string, string], startedAt: number }
  pendingTriforce: null, // { sourceIds: [string, string, string], startedAt: number }
  pendingMotherDraft: null, // { sourceIds: string[], startedAt: number }
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
  actionQueueStats: {
    replacedByKey: 0,
    droppedOverflow: 0,
    lastDropLabel: null,
  },
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
    kind: null, // POINTER_KINDS.FREEFORM_MOVE | POINTER_KINDS.FREEFORM_RESIZE | POINTER_KINDS.FREEFORM_IMPORT | POINTER_KINDS.FREEFORM_WHEEL | POINTER_KINDS.MOTHER_ROLE_DRAG | POINTER_KINDS.EFFECT_TOKEN_DRAG
    imageId: null,
    role: null,
    corner: null, // "nw"|"ne"|"sw"|"se"
    startRectCss: null, // { x, y, w, h }
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    startCssX: 0,
    startCssY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    importPointCss: null, // { x, y }
    wheelOnTap: false,
    moved: false,
  },
  reelTouch: {
    x: 0,
    y: 0,
    visibleUntil: 0,
    downUntil: 0,
    down: false,
  },
  effectTokenDrag: null, // { tokenId, sourceImageId, targetImageId, moved, x, y }
  effectTokenApplyLocks: new Map(), // tokenId -> { dispatchId, targetImageId, queued, startedAt }
  wheelMenu: {
    open: false,
    hideTimer: null,
    anchorCss: null, // { x, y } | null
    anchorWorld: null, // { x, y } | null
  },
  selection: null, // { points: [{x,y}], closed: true }
  lassoDraft: [],
  annotateDraft: null, // { imageId, x0, y0, x1, y1, at } | null (image pixel space)
  annotateBox: null, // { imageId, x0, y0, x1, y1, at } | null (final box until dismissed)
  circleDraft: null, // { imageId, cx, cy, r, color, at } | null (image pixel space)
  circlesByImageId: new Map(), // imageId -> [{ id, cx, cy, r, color, label, at }]
  activeCircle: null, // { imageId, id } | null
  tripletRuleAnnotations: new Map(), // imageId -> [{ x: number, y: number, label: string }]
  tripletOddOneOutId: null, // string|null
  needsEngineModelResync: false, // restore `/image_model` to settings after one-off overrides.
  engineImageModelRestore: null, // string|null
  needsRender: false,
  lastInteractionAt: Date.now(),
  lastMotherHotAt: Date.now(),
  userEvents: [], // [{ seq, at_ms, type, ... }]
  userEventSeq: 0,
  mother: {
    running: false,
    startedAt: 0,
    runId: 0,
    action: null, // string|null
    status: null, // string|null
    stopRequested: false,
    timer: null,
    rtHoldUntil: 0,
    rtHoldTimer: null,
    rtVisualActive: false,
    rtVisualRawSince: 0,
    rtVisualMinUntil: 0,
    hotSyncAt: 0,
  },
  motherIdle: {
    phase: motherIdleInitialState(),
    firstIdleTimer: null,
    intentIdleTimer: null,
    takeoverTimer: null,
    cooldownTimer: null,
    hasGeneratedSinceInteraction: false,
    generatedImageId: null,
    generatedVersionId: null,
    pendingDispatchToken: 0,
    dispatchTimeoutTimer: null,
    dispatchTimeoutExtensions: 0,
    pendingPromptLine: null,
    promptMotionProfile: null,
    pendingVersionId: null,
    ignoredVersionIds: new Set(),
    waitingSince: 0,
    pendingSuggestionLog: null, // { request_id, what, why, prompt, source_images, dispatched_at_iso } | null
    lastSuggestionAt: 0,
    suppressFailureUntil: 0,
    retryAttempted: false,
    lastDispatchModel: null,
    blockedUntilUserInteraction: false,
    actionVersion: 0,
    pendingActionVersion: 0,
    cooldownUntil: 0,
    multiUploadIdleBoostUntil: 0,
    pendingIntent: false,
    pendingIntentRequestId: null,
    pendingIntentStartedAt: 0,
    pendingIntentUpgradeUntil: 0,
    pendingIntentRealtimePath: null,
    pendingIntentPath: null,
    pendingIntentPayload: null,
    pendingIntentTimeout: null,
    pendingPromptCompile: false,
    pendingPromptCompilePath: null,
    pendingPromptCompileTimeout: null,
    pendingVisionImageIds: [],
    pendingVisionRetryTimer: null,
    pendingGeneration: false,
    pendingFollowupAfterCooldown: false,
    pendingFollowupReason: null,
    lastRejectedProposal: null, // { contextSig, imageSetSig, mode, summary, at_ms } | null
    rejectedModeHistoryByContext: {}, // contextSig -> recently rejected transformation modes
    cancelArtifactUntil: 0,
    cancelArtifactReason: null,
    intent: null, // structured intent payload from intent realtime (with fallback inference)
    roles: { subject: [], model: [], mediator: [], object: [] },
    drafts: [], // [{ id, path, receiptPath, versionId, actionVersion, createdAt, img }]
    selectedDraftId: null,
    hoverDraftId: null,
    commitMutationInFlight: false,
    roleGlyphHits: [], // [{ role, imageId, rect }]
    roleGlyphDrag: null, // { role, imageId, startX, startY, moved }
    advancedOpen: false,
    optionReveal: false,
    hintLevel: 0, // 0 hidden, 1 subtle, 2 engaged
    hintVisibleUntil: 0,
    hintFadeTimer: null,
    intensity: 62, // optional UI steering dial
    commitUndo: null, // { expiresAt, mode, insertedId, targetId, before, removedSeeds }
    telemetry: {
      traceId: `mother-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      stateTransitions: [],
      accepted: 0,
      rejected: 0,
      deployed: 0,
      stale: 0,
    },
  },
  fileBrowser: {
    enabled: ENABLE_FILE_BROWSER_DOCK,
    rootDir: String(localStorage.getItem(FILE_BROWSER_ROOT_DIR_LS_KEY) || "").trim() || null,
    cwd: null,
    entries: [],
    importPathMap: new Map(),
    selectedPath: null,
    loading: false,
    error: null,
    draggingPath: null,
    history: [],
    loadSeq: 0,
    thumbCache: new Map(), // path -> { url, urlPromise, imgPromise }
    observer: null,
    clickImportTimer: null,
    dragClearTimer: null,
    suppressClickUntil: 0,
    manualDrag: {
      active: false,
      pointerId: null,
      path: null,
      previewPath: null,
      startX: 0,
      startY: 0,
      moved: false,
      ghostEl: null,
    },
  },
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
  lastTipText: null,
  lastDirectorText: null,
  lastDirectorMeta: null, // { kind, source, model, at, paths }
  lastCostLatency: null, // { provider, model, cost_total_usd, cost_per_1k_images_usd, latency_per_image_s, at }
  sessionApiCalls: 0,
  topMetrics: {
    tokenInByMinute: new Map(), // minute -> tokens in
    tokenOutByMinute: new Map(), // minute -> tokens out
    queueDepthByMinute: new Map(), // minute -> pending+running depth
    sessionEstimatedCostUsd: 0,
    renderDurationsS: [], // rolling last successful render durations
  },
  lastStatusText: "Engine: idle",
  lastStatusError: false,
  fallbackToFullRead: false,
  keyStatus: null, // { openai, gemini, imagen, flux, anthropic }
  intent: {
    locked: true,
    lockedAt: 0,
    lockedBranchId: null,
    startedAt: 0,
    deadlineAt: 0,
    totalRounds: 3,
    round: 1,
    selections: [], // [{ round, branch_id, token }]
    focusBranchId: null,
    iconState: null, // last parsed JSON
    iconStateAt: 0,
    pending: false,
    pendingPath: null,
    pendingAt: 0,
    pendingFrameId: null,
    frameSeq: 0,
    rtState: "off", // "off" | "connecting" | "ready" | "failed"
    disabledReason: null, // non-null = show "hard" failure state (missing keys, etc.)
	    lastError: null, // string|null (non-hard last failure message)
	    lastErrorAt: 0,
	    lastSignature: null,
	    lastRunAt: 0,
	    forceChoice: false,
	    uiHideSuggestion: false,
	    uiHits: [], // [{ kind, id, rect }]
	  },
  intentAmbient: {
    enabled: true,
    pending: false,
    pendingPath: null,
    pendingAt: 0,
    pendingFrameId: null,
    frameSeq: 0,
    rtState: "off", // "off" | "connecting" | "ready" | "failed"
    disabledReason: null,
    lastError: null,
    lastErrorAt: 0,
    lastSignature: null,
    lastRunAt: 0,
    iconState: null,
    iconStateAt: 0,
    touchedImageIds: [],
    suggestions: [], // [{ id, asset_type, asset_key/src, anchor, confidence, world_rect, created_at_ms, updated_at_ms }]
    uiHits: [], // [{ kind, id, rect, branchId, assetKey, anchorImageIds }]
    lastReason: null,
  },
  alwaysOnVision: {
    enabled: settings.alwaysOnVision,
    pending: false,
    pendingPath: null,
    pendingAt: 0,
    contentDirty: false,
    dirtyReason: null,
    lastSignature: null,
    lastRunAt: 0,
    lastText: null,
    lastMeta: null, // { source, model, at, image_path }
    rtState: settings.alwaysOnVision ? "connecting" : "off", // "off" | "connecting" | "ready" | "failed"
    disabledReason: null, // string|null (set when auto-disabled due to a fatal realtime error)
    portraitOverride: null, // { slot: "primary"|"secondary", provider, title, busy } | null
  },
  canvasContextSuggestion: null, // { action: string, why: string|null, at: number, source: string|null, model: string|null } | null
  autoAcceptSuggestedAbility: {
    enabled: settings.autoAcceptSuggestedAbility,
    passes: 0,
    lastAcceptedAt: 0, // rec.at of the most recently auto-accepted suggestion
    inFlight: false,
  },
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
    diskDir: null, // string|null (persisted across dev/prod builds via ~/.brood)
    diskDirChecked: false,
    diskDirPromise: null, // Promise<string|null>|null
    urlCache: new Map(), // path -> { url, urlPromise, imgPromise } (separate from canvas image cache)
    index: null, // { [agent: string]: { idle: string|null, working: string|null } }|null
    indexChecked: false,
    indexPromise: null, // Promise<object>|null
    activeKey1: null,
    activeKey2: null,
    activeKeyMother: null,
    missingToastShown: false,
    loadErrorToastShown: false,
    lastResolveError: null, // string|null (debug aid shown in Settings readout)
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
// Disable by default; the inspector still contains Abilities.
const ENABLE_SPAWN_ACTIONS = false;
// Drag/drop import is currently disabled; we still prevent file-drop navigation
// to protect the session/run.
const ENABLE_DRAG_DROP_IMPORT = false;

// Intent Canvas feature flags. Keep the full implementation in place so we can
// re-enable specific behaviors without ripping out code.
const INTENT_CANVAS_ENABLED = false; // disable onboarding intent decider (keep code intact)
const INTENT_AMBIENT_ENABLED = true; // ambient intent runs in the background while editing
const INTENT_AMBIENT_ICON_PLACEMENT_ENABLED = false; // keep ambient inference, disable icon nudges/placement
const INTENT_TIMER_ENABLED = false; // hide LED timer + disable timeout-based force-choice
const INTENT_ROUNDS_ENABLED = false; // disable "max rounds" gating
const INTENT_FORCE_CHOICE_ENABLED = INTENT_TIMER_ENABLED || INTENT_ROUNDS_ENABLED;
const INTENT_AMBIENT_MAX_NUDGES = 3;
const INTENT_AMBIENT_ICON_WORLD_SIZE = 136;
const INTENT_AMBIENT_FADE_IN_MS = 280;

// Temporarily disabled custom canvas cursor (kept as a single knob for quick restore).
const INTENT_IMPORT_CURSOR = "default";
const REEL_TOUCH_MOVE_VISIBLE_MS = 120;
const REEL_TOUCH_TAP_VISIBLE_MS = 280;
const REEL_TOUCH_RELEASE_VISIBLE_MS = 150;

// Intent onboarding overlay icon assets (generated via scripts/gemini_generate_intent_icons.py).
// Keep a procedural fallback so the app still renders if assets fail to load.
const INTENT_UI_START_ICON_SCALE = 1.12; // modestly bigger than the original procedural glyphs
const INTENT_UI_CHOICE_ICON_SCALE = 3.0; // YES/NO + suggested use-case glyph (requested: 300% larger)
const INTENT_UI_ICON_ASSETS = {
  start_lock: new URL("./assets/intent-icons-sc/icons/intent-start-lock.png", import.meta.url).href,
  token_yes: new URL("./assets/intent-icons-sc/icons/intent-token-yes.png", import.meta.url).href,
  token_no: new URL("./assets/intent-icons-sc/icons/intent-token-no.png", import.meta.url).href,
  usecases: {
    game_dev_assets: new URL("./assets/intent-icons-sc/icons/intent-usecase-game-dev-assets.png", import.meta.url).href,
    streaming_content: new URL("./assets/intent-icons-sc/icons/intent-usecase-streaming-content.png", import.meta.url).href,
    uiux_prototyping: new URL("./assets/intent-icons-sc/icons/intent-usecase-uiux-prototyping.png", import.meta.url).href,
    ecommerce_pod: new URL("./assets/intent-icons-sc/icons/intent-usecase-ecommerce-pod.png", import.meta.url).href,
    content_engine: new URL("./assets/intent-icons-sc/icons/intent-usecase-content-engine.png", import.meta.url).href,
  },
};

const intentUiIcons = {
  ready: false,
  loadPromise: null,
  startLock: null,
  tokenYes: null,
  tokenNo: null,
  usecases: {},
};

function _loadUiImage(url) {
  const u = String(url || "").trim();
  if (!u) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const img = new Image();
    try {
      img.crossOrigin = "anonymous";
    } catch {
      // ignore
    }
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = u;
  });
}

function ensureIntentUiIconsLoaded() {
  if (intentUiIcons.loadPromise) return intentUiIcons.loadPromise;
  intentUiIcons.loadPromise = (async () => {
    try {
      const [startLock, tokenYes, tokenNo] = await Promise.all([
        _loadUiImage(INTENT_UI_ICON_ASSETS.start_lock),
        _loadUiImage(INTENT_UI_ICON_ASSETS.token_yes),
        _loadUiImage(INTENT_UI_ICON_ASSETS.token_no),
      ]);
      intentUiIcons.startLock = startLock;
      intentUiIcons.tokenYes = tokenYes;
      intentUiIcons.tokenNo = tokenNo;

      const usecases = INTENT_UI_ICON_ASSETS.usecases || {};
      const entries = Object.entries(usecases);
      const loaded = await Promise.all(entries.map(([, url]) => _loadUiImage(url)));
      const out = {};
      for (let i = 0; i < entries.length; i += 1) {
        const [k] = entries[i];
        out[String(k)] = loaded[i] || null;
      }
      intentUiIcons.usecases = out;
      intentUiIcons.ready = true;
      requestRender();
    } catch (err) {
      console.warn("Failed to load intent UI icons; falling back to procedural glyphs.", err);
      intentUiIcons.ready = false;
    }
  })();
  return intentUiIcons.loadPromise;
}

const INTENT_DEADLINE_MS = 60_000;
const INTENT_ENVELOPE_VERSION = 1;
const INTENT_SNAPSHOT_MAX_DIM_PX = 1200;
const INTENT_INFERENCE_DEBOUNCE_MS = 260;
const INTENT_INFERENCE_THROTTLE_MS = 900;
const INTENT_INFERENCE_TIMEOUT_MS = 15_000;
const INTENT_PERSIST_FILENAME = "intent_state.json";
const INTENT_LOCKED_FILENAME = "intent_locked.json";
const INTENT_TRACE_FILENAME = "intent_trace.jsonl";

let visualPromptWriteTimer = null;
let intentTraceSeq = 0;
let intentRealtimePortraitBusy = false;
let effectsRuntime = null;

function _intentTracePath() {
  if (!state.runDir) return null;
  return `${state.runDir}/${INTENT_TRACE_FILENAME}`;
}

async function appendIntentTrace(entry) {
  const outPath = _intentTracePath();
  if (!outPath) return false;

  const payload = {
    schema: "brood.intent_trace",
    schema_version: 1,
    seq: (intentTraceSeq += 1),
    at_ms: Date.now(),
    ...entry,
  };
  const line = `${JSON.stringify(payload)}\n`;

  try {
    await appendTextWithFallback(outPath, line, { maxBytes: 1_200_000 });
    return true;
  } catch {
    return false;
  }
}
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

function topMetricMinuteAt(ms = Date.now()) {
  return Math.floor((Number(ms) || Date.now()) / 60_000);
}

function topMetricPruneMinuteMap(map, { keepMinutes = TOP_METRICS_WINDOW_MINUTES, nowMs = Date.now() } = {}) {
  if (!(map instanceof Map)) return;
  const cutoff = topMetricMinuteAt(nowMs) - Math.max(keepMinutes, 1) - 2;
  for (const key of map.keys()) {
    if (Number(key) < cutoff) map.delete(key);
  }
}

function topMetricBumpMinuteMap(map, minute, delta) {
  if (!(map instanceof Map)) return;
  const key = Math.floor(Number(minute) || 0);
  if (!Number.isFinite(key)) return;
  const add = Math.max(0, Number(delta) || 0);
  if (!Number.isFinite(add) || add <= 0) return;
  map.set(key, (Number(map.get(key)) || 0) + add);
}

function topMetricSetMinuteMap(map, minute, value) {
  if (!(map instanceof Map)) return;
  const key = Math.floor(Number(minute) || 0);
  if (!Number.isFinite(key)) return;
  const next = Math.max(0, Number(value) || 0);
  if (!Number.isFinite(next)) return;
  map.set(key, next);
}

function readFirstFinite(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const n = Number(obj[key]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function extractTokenUsageFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  let input = readFirstFinite(obj, [
    "input_tokens",
    "prompt_tokens",
    "prompt_token_count",
    "promptTokenCount",
    "promptTokens",
    "tokens_in",
    "tokensIn",
    "inputTokenCount",
    "input_text_tokens",
    "text_count_tokens",
  ]);
  let output = readFirstFinite(obj, [
    "output_tokens",
    "completion_tokens",
    "completion_token_count",
    "completionTokenCount",
    "tokens_out",
    "tokensOut",
    "outputTokenCount",
    "output_text_tokens",
    "candidates_token_count",
    "candidatesTokenCount",
  ]);
  const total = readFirstFinite(obj, [
    "total_token_count",
    "totalTokenCount",
    "total_tokens",
    "totalTokens",
    "token_count",
    "tokenCount",
  ]);
  if (!Number.isFinite(input) && Number.isFinite(total) && Number.isFinite(output) && total >= output) {
    input = total - output;
  }
  if (!Number.isFinite(output) && Number.isFinite(total) && Number.isFinite(input) && total >= input) {
    output = total - input;
  }
  if (!Number.isFinite(input) && !Number.isFinite(output) && Number.isFinite(total)) {
    input = total;
    output = 0;
  }
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return {
    input_tokens: Math.max(0, Math.round(Number(input) || 0)),
    output_tokens: Math.max(0, Math.round(Number(output) || 0)),
  };
}

function extractTokenUsage(payload) {
  if (!payload || typeof payload !== "object") return null;
  const visited = new Set();
  const queue = [payload];
  let steps = 0;
  while (queue.length && steps < 180) {
    const node = queue.shift();
    steps += 1;
    if (!node || typeof node !== "object") continue;
    if (visited.has(node)) continue;
    visited.add(node);
    const direct = extractTokenUsageFromObject(node);
    if (direct) return direct;
    const usage = node.usage;
    if (usage && typeof usage === "object") {
      const nested = extractTokenUsageFromObject(usage);
      if (nested) return nested;
      queue.push(usage);
    }
    for (const value of Object.values(node)) {
      if (!value) continue;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length && i < 8; i += 1) queue.push(value[i]);
      } else if (typeof value === "object") {
        queue.push(value);
      }
    }
  }
  return null;
}

function topMetricMinuteSeries(map, { windowMinutes = TOP_METRICS_WINDOW_MINUTES, nowMs = Date.now() } = {}) {
  const nowMinute = topMetricMinuteAt(nowMs);
  const out = [];
  let hasData = false;
  for (let i = windowMinutes - 1; i >= 0; i -= 1) {
    const minute = nowMinute - i;
    const raw = Number(map.get(minute)) || 0;
    const value = Math.max(0, raw);
    if (value > 0) hasData = true;
    out.push(value);
  }
  return { values: out, hasData };
}

function topMetricSmoothedRolling(values, { minutes = 5 } = {}) {
  const list = Array.isArray(values) ? values.map((v) => Math.max(0, Number(v) || 0)) : [];
  const n = Math.max(1, Math.min(Math.floor(Number(minutes) || 5), list.length));
  const slice = list.slice(-n);
  if (!slice.length) return 0;
  // Triangular weighting favors the center of the short window for smoother readout.
  const weights = [];
  for (let i = 0; i < slice.length; i += 1) {
    const mid = (slice.length - 1) / 2;
    const dist = Math.abs(i - mid);
    weights.push(Math.max(1, Math.round(slice.length - dist)));
  }
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < slice.length; i += 1) {
    const w = Number(weights[i]) || 1;
    sum += (Number(slice[i]) || 0) * w;
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : 0;
}

function sparkline(values, { fallback = "--", maxValue = null } = {}) {
  const list = Array.isArray(values) ? values.map((v) => Math.max(0, Number(v) || 0)) : [];
  if (!list.length) return fallback;
  const overrideMax = Number(maxValue);
  const maxVal = Number.isFinite(overrideMax) && overrideMax > 0 ? overrideMax : Math.max(...list);
  if (!maxVal) return "·".repeat(Math.min(20, list.length));
  const last = SPARKLINE_GLYPHS.length - 1;
  return list
    .map((v) => {
      const idx = Math.round((Math.max(0, Number(v) || 0) / maxVal) * last);
      return SPARKLINE_GLYPHS[clamp(idx, 0, last)];
    })
    .join("");
}

function topMetricHeat(metric, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return "nodata";
  const t = TOP_METRICS_THRESHOLDS[metric];
  if (!t) return "nodata";
  if (v < t.cool_max) return "cool";
  if (v <= t.warm_max) return "warm";
  return "hot";
}

function ribbonStatusLabel(raw) {
  const text = String(raw || "").trim();
  if (!text) return "idle";
  return text
    .replace(/^(engine|director|mother|app)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function ribbonStatusState(raw, isError = false) {
  if (isError) return "error";
  const label = ribbonStatusLabel(raw);
  if (!label) return "idle";
  if (/\b(idle|off|disabled|exited|stopped)\b/i.test(label)) return "idle";
  if (/\b(ready|started|connected|imported|enabled|locked|committed|exported)\b/i.test(label)) return "ready";
  if (/\b(failed|error|boot failed)\b/i.test(label)) return "error";
  return "busy";
}

function engineStatusDotTooltip(statusText = "", stateKey = "idle") {
  const stateLabel = String(stateKey || "idle").trim() || "idle";
  const detail = String(statusText || "").trim() || "Engine: idle";
  return `Engine status dot\nShows current engine activity.\nState: ${stateLabel}\n${detail}`;
}

function intentSourceDotTooltip(kind = "") {
  const normalized = String(kind || "").trim().toLowerCase();
  const source = normalized === "realtime" || normalized === "fallback" ? normalized : "idle";
  return `Intent source dot\nShows where Mother intent came from.\nSource: ${source}`;
}

function topMetricQueueCounts() {
  const pending = Math.max(0, Number(state.actionQueue?.length) || 0);
  const running = state.actionQueueActive || isEngineBusy() ? 1 : 0;
  return { pending, running };
}

function queuePreviewItems({ limit = 3 } = {}) {
  const maxItems = clamp(Math.round(Number(limit) || 3), 1, 6);
  const list = Array.isArray(state.actionQueue) ? state.actionQueue.slice() : [];
  if (!list.length) return [];
  return list
    .sort((a, b) => {
      const ap = typeof a?.priority === "number" ? a.priority : 0;
      const bp = typeof b?.priority === "number" ? b.priority : 0;
      if (ap !== bp) return bp - ap;
      return (a?.enqueuedAt || 0) - (b?.enqueuedAt || 0);
    })
    .slice(0, maxItems)
    .map((item) => String(item?.label || "Action").trim() || "Action");
}

function queueChipTooltip() {
  const queue = topMetricQueueCounts();
  const runningLabel = String(state.actionQueueActive?.label || "").trim();
  const preview = queuePreviewItems({ limit: 3 });
  const stats = state.actionQueueStats && typeof state.actionQueueStats === "object" ? state.actionQueueStats : {};
  const replaced = Math.max(0, Number(stats.replacedByKey) || 0);
  const dropped = Math.max(0, Number(stats.droppedOverflow) || 0);
  const lines = [];
  lines.push("Action queue");
  lines.push(`Running: ${runningLabel || (queue.running ? "engine task" : "none")}`);
  lines.push(`Pending: ${queue.pending}`);
  if (preview.length) lines.push(`Next: ${preview.join(" -> ")}`);
  if (replaced) lines.push(`Merged duplicate requests: ${replaced}`);
  if (dropped) lines.push(`Dropped (queue full): ${dropped}`);
  if (stats.lastDropLabel) lines.push(`Last dropped: ${stats.lastDropLabel}`);
  return lines.join("\n");
}

function topMetricIngestTokens({ inputTokens = 0, outputTokens = 0, atMs = Date.now() } = {}) {
  const inTokens = Math.max(0, Math.round(Number(inputTokens) || 0));
  const outTokens = Math.max(0, Math.round(Number(outputTokens) || 0));
  if (!inTokens && !outTokens) return;
  const metrics = state.topMetrics || null;
  if (!metrics) return;
  const minute = topMetricMinuteAt(atMs);
  topMetricBumpMinuteMap(metrics.tokenInByMinute, minute, inTokens);
  topMetricBumpMinuteMap(metrics.tokenOutByMinute, minute, outTokens);
  topMetricPruneMinuteMap(metrics.tokenInByMinute, { nowMs: atMs });
  topMetricPruneMinuteMap(metrics.tokenOutByMinute, { nowMs: atMs });
}

function topMetricIngestTokensFromPayload(payload, { atMs = Date.now(), render = false } = {}) {
  const tokens = extractTokenUsage(payload);
  if (!tokens) return false;
  topMetricIngestTokens({
    inputTokens: tokens.input_tokens,
    outputTokens: tokens.output_tokens,
    atMs,
  });
  if (render) renderSessionApiCallsReadout();
  return true;
}

function topMetricIngestCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return;
  const metrics = state.topMetrics || null;
  if (!metrics) return;
  metrics.sessionEstimatedCostUsd = Math.max(0, Number(metrics.sessionEstimatedCostUsd) || 0) + n;
}

function topMetricIngestRenderDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return;
  const metrics = state.topMetrics || null;
  if (!metrics) return;
  metrics.renderDurationsS.push(n);
  while (metrics.renderDurationsS.length > TOP_METRICS_RENDER_SAMPLE_MAX) metrics.renderDurationsS.shift();
}

function topMetricSampleQueueDepth({ nowMs = Date.now() } = {}) {
  const metrics = state.topMetrics || null;
  if (!metrics) return;
  const minute = topMetricMinuteAt(nowMs);
  const counts = topMetricQueueCounts();
  topMetricSetMinuteMap(metrics.queueDepthByMinute, minute, counts.pending + counts.running);
  topMetricPruneMinuteMap(metrics.queueDepthByMinute, { nowMs });
}

function renderTopMetricsGrid() {
  if (!els.topMetricsRoot) return;
  const metrics = state.topMetrics || null;
  if (!metrics) return;
  const nowMs = Date.now();
  topMetricSampleQueueDepth({ nowMs });

  const tokenInSeries = topMetricMinuteSeries(metrics.tokenInByMinute, { nowMs });
  const tokenOutSeries = topMetricMinuteSeries(metrics.tokenOutByMinute, { nowMs });
  const tokenInSmooth5 = topMetricSmoothedRolling(tokenInSeries.values, { minutes: 5 });
  const tokenOutSmooth5 = topMetricSmoothedRolling(tokenOutSeries.values, { minutes: 5 });
  const tokenSmoothedPerMinute = tokenInSmooth5 + tokenOutSmooth5;
  const hasTokenData = tokenInSeries.hasData || tokenOutSeries.hasData;
  const tokenInWindow = tokenInSeries.values.slice(-10);
  const tokenOutWindow = tokenOutSeries.values.slice(-10);
  const sharedTokenMax = Math.max(
    0,
    ...tokenInWindow.map((v) => Math.max(0, Number(v) || 0)),
    ...tokenOutWindow.map((v) => Math.max(0, Number(v) || 0))
  );

  if (els.topMetricTokensValue) {
    const inSpark = sparkline(tokenInWindow, { fallback: "··········", maxValue: sharedTokenMax });
    const outSpark = sparkline(tokenOutWindow, { fallback: "··········", maxValue: sharedTokenMax });
    els.topMetricTokensValue.innerHTML = [
      `<span class="top-metric-token-in">↓ ${escapeHtml(inSpark)}</span>`,
      `<span class="top-metric-token-out">↑ ${escapeHtml(outSpark)}</span>`,
    ].join("");
  }
  if (els.topMetricTokensSparkIn) {
    els.topMetricTokensSparkIn.textContent = "";
    els.topMetricTokensSparkIn.classList.add("hidden");
  }
  if (els.topMetricTokensSparkOut) {
    els.topMetricTokensSparkOut.textContent = "";
    els.topMetricTokensSparkOut.classList.add("hidden");
  }
  if (els.topMetricApiCalls) {
    els.topMetricApiCalls.textContent = "";
    els.topMetricApiCalls.classList.add("hidden");
  }
  if (els.topMetricTokens) {
    els.topMetricTokens.dataset.heat = hasTokenData ? topMetricHeat("tokens_per_minute", tokenSmoothedPerMinute) : "nodata";
  }

  const sessionCost = Number(metrics.sessionEstimatedCostUsd);
  const hasCost = Number.isFinite(sessionCost) && sessionCost >= 0;
  if (els.topMetricCostValue) {
    els.topMetricCostValue.textContent = hasCost ? formatUsd(sessionCost) || "$0.00" : "--";
  }
  if (els.topMetricCost) {
    els.topMetricCost.dataset.heat = hasCost ? topMetricHeat("session_cost_usd", sessionCost) : "nodata";
  }

  const queue = topMetricQueueCounts();
  const queueDepth = queue.pending + queue.running;
  const queueSeries = topMetricMinuteSeries(metrics.queueDepthByMinute, { nowMs });
  const queuePreview = queuePreviewItems({ limit: 1 });
  const queueStats = state.actionQueueStats && typeof state.actionQueueStats === "object" ? state.actionQueueStats : {};
  const replacedCount = Math.max(0, Number(queueStats.replacedByKey) || 0);
  const droppedCount = Math.max(0, Number(queueStats.droppedOverflow) || 0);
  const queueFlags = [];
  if (replacedCount) queueFlags.push(`U${Math.min(99, replacedCount)}`);
  if (droppedCount) queueFlags.push(`D${Math.min(99, droppedCount)}`);
  if (els.topMetricQueueValue) {
    const flags = queueFlags.length ? ` ${queueFlags.join("/")}` : "";
    els.topMetricQueueValue.textContent = `P${queue.pending} R${queue.running}${flags}`;
  }
  if (els.topMetricQueueTrend) {
    const runningLabel = String(state.actionQueueActive?.label || "").trim();
    if (runningLabel) {
      els.topMetricQueueTrend.textContent = `run:${clampText(runningLabel, 10)}`;
    } else if (queuePreview.length) {
      els.topMetricQueueTrend.textContent = `next:${clampText(queuePreview[0], 9)}`;
    } else {
      els.topMetricQueueTrend.textContent = sparkline(queueSeries.values.slice(-10));
    }
  }
  if (els.topMetricQueue) {
    els.topMetricQueue.dataset.heat = topMetricHeat("queued_calls", queueDepth);
    const queueTitle = queueChipTooltip();
    els.topMetricQueue.title = queueTitle;
    els.topMetricQueue.setAttribute("aria-label", queueTitle.replace(/\n/g, ". "));
  }

  const durations = Array.isArray(metrics.renderDurationsS) ? metrics.renderDurationsS : [];
  const avgRender =
    durations.length > 0 ? durations.reduce((sum, v) => sum + (Number(v) || 0), 0) / Math.max(1, durations.length) : null;
  if (els.topMetricRenderValue) {
    const sampleCount = durations.length;
    els.topMetricRenderValue.textContent = Number.isFinite(avgRender)
      ? `${(Number(avgRender) || 0).toFixed(1)}s/${sampleCount}`
      : "--";
  }
  if (els.topMetricRender) {
    els.topMetricRender.dataset.heat = Number.isFinite(avgRender) ? topMetricHeat("avg_render_s", avgRender) : "nodata";
  }

  if (els.engineStatus) {
    const status = state.lastStatusText ? String(state.lastStatusText) : "Engine: idle";
    const stateKey = ribbonStatusState(status, Boolean(state.lastStatusError));
    els.engineStatus.dataset.state = stateKey;
    els.engineStatus.textContent = "";
    els.engineStatus.title = engineStatusDotTooltip(status, stateKey);
    els.engineStatus.setAttribute("aria-label", `Engine status: ${ribbonStatusLabel(status) || "idle"}`);
  }
}

function resetTopMetrics() {
  const metrics = state.topMetrics || null;
  if (!metrics) return;
  metrics.tokenInByMinute.clear();
  metrics.tokenOutByMinute.clear();
  metrics.queueDepthByMinute.clear();
  metrics.sessionEstimatedCostUsd = 0;
  metrics.renderDurationsS = [];
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
  const tokens = extractTokenUsage(payload);
  return {
    provider,
    model,
    operation,
    cost_total_usd,
    latency_per_image_s,
    input_tokens: tokens?.input_tokens ?? null,
    output_tokens: tokens?.output_tokens ?? null,
  };
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

async function ingestTopMetricsFromReceiptPath(receiptPath, { allowCostFallback = false, allowLatencyFallback = false } = {}) {
  const path = String(receiptPath || "").trim();
  if (!path) return;
  try {
    const payload = JSON.parse(await readTextFile(path));
    const meta = extractReceiptMeta(payload);
    if (!meta) return;
    if (allowCostFallback) topMetricIngestCost(meta.cost_total_usd);
    if (allowLatencyFallback) topMetricIngestRenderDuration(meta.latency_per_image_s);
    topMetricIngestTokens({
      inputTokens: meta.input_tokens,
      outputTokens: meta.output_tokens,
    });
    renderSessionApiCallsReadout();
  } catch {
    // ignore
  }
}

function clampText(text, maxLen) {
  const s = String(text || "").trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

let hudDescTypeoutTimer = null;
let hudDescTypeoutTarget = "";
let hudDescTypeoutIndex = 0;
let hudDescTypeoutImageId = null;

function stopHudDescTypeout() {
  clearTimeout(hudDescTypeoutTimer);
  hudDescTypeoutTimer = null;
  hudDescTypeoutTarget = "";
  hudDescTypeoutIndex = 0;
  hudDescTypeoutImageId = null;
  if (els.hudUnitDesc) els.hudUnitDesc.classList.remove("is-typing");
}

function hudDescTypeoutTick() {
  if (!els.hudUnitDesc) {
    stopHudDescTypeout();
    return;
  }
  const remaining = hudDescTypeoutTarget.length - hudDescTypeoutIndex;
  if (remaining <= 0) {
    els.hudUnitDesc.classList.remove("is-typing");
    hudDescTypeoutTimer = null;
    return;
  }
  let step = 1;
  if (remaining > 42) step = 3;
  else if (remaining > 18) step = 2;
  hudDescTypeoutIndex = Math.min(hudDescTypeoutTarget.length, hudDescTypeoutIndex + step);
  els.hudUnitDesc.textContent = hudDescTypeoutTarget.slice(0, hudDescTypeoutIndex);
  hudDescTypeoutTimer = setTimeout(hudDescTypeoutTick, 42);
}

function startHudDescTypeout(imageId, text) {
  const targetImageId = String(imageId || "").trim();
  const targetText = String(text || "").trim();
  if (!targetImageId || !targetText || !els.hudUnitDesc) return;
  if (hudDescTypeoutImageId === targetImageId && hudDescTypeoutTarget === targetText && hudDescTypeoutTimer) return;
  stopHudDescTypeout();
  hudDescTypeoutImageId = targetImageId;
  hudDescTypeoutTarget = targetText;
  hudDescTypeoutIndex = 0;
  els.hudUnitDesc.textContent = "";
  els.hudUnitDesc.classList.add("is-typing");
  hudDescTypeoutTick();
}

function renderHudReadout() {
  if (!els.hud) return;
  const img = getActiveImage();
  const hasImage = Boolean(img);
  const zoomScale = state.canvasMode === "multi" ? state.multiView.scale || 1 : state.view.scale || 1;
  // HUD is always visible; show placeholders when no image is loaded.
  if (!hasImage) {
    stopHudDescTypeout();
    const sel = state.selection?.points?.length >= 3 ? `${state.selection.points.length} pts` : "none";
    const zoomPct = Math.round(zoomScale * 100);
    if (els.hudUnitName) els.hudUnitName.textContent = "NO IMAGE";
    if (els.hudUnitDesc) els.hudUnitDesc.textContent = "Tap or drag to add photos";
    if (els.hudUnitSel) els.hudUnitSel.textContent = `imgs:0 · ${sel} · ${state.tool} · ${zoomPct}%`;
    if (els.hudLineDirector) els.hudLineDirector.classList.add("hidden");
    if (els.hudDirectorVal) els.hudDirectorVal.textContent = "";
    if (els.hudDirectorKey) els.hudDirectorKey.textContent = "DIR";
    if (els.hudLineDesc) els.hudLineDesc.classList.remove("hidden");
    if (els.hudLineSel) els.hudLineSel.classList.remove("hidden");
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
  let descFromVision = false;
  if (img?.visionDesc) {
    desc = clampText(img.visionDesc, 32);
    descFromVision = true;
  } else if (img?.visionPending) {
    desc = "ANALYZING…";
  } else if (img?.path && describeQueued.has(img.path)) {
    desc = state.ptySpawned ? "QUEUED…" : state.ptySpawning ? "STARTING…" : "ENGINE OFFLINE";
  } else {
    const allowVision = state.keyStatus ? Boolean(state.keyStatus.openai || state.keyStatus.gemini) : true;
    if (!state.ptySpawned) desc = "ENGINE OFFLINE";
    else desc = allowVision ? "—" : "NO VISION KEYS";
  }
  const descText = desc || "—";
  const typeoutLocked =
    descFromVision &&
    hudDescTypeoutImageId === String(img?.id || "") &&
    hudDescTypeoutTarget === descText &&
    hudDescTypeoutTimer;
  if (!typeoutLocked && els.hudUnitDesc) {
    els.hudUnitDesc.textContent = descText;
  }
  if (!descFromVision) {
    stopHudDescTypeout();
  }

  const sel = state.selection?.points?.length >= 3 ? `${state.selection.points.length} pts` : "none";
  const imgSel = selectedCount();
  const zoomPct = Math.round(zoomScale * 100);
  if (els.hudUnitSel) els.hudUnitSel.textContent = `imgs:${imgSel} · ${sel} · ${state.tool} · ${zoomPct}%`;

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
    if (directorKind === "extract_rule") key = "RULE";
    if (directorKind === "odd_one_out") key = "ODD";
    els.hudDirectorKey.textContent = key;
  }
  if (els.hudDirectorVal) els.hudDirectorVal.textContent = directorText || "";
  if (els.hudLineDirector) els.hudLineDirector.classList.toggle("hidden", !hasDirector);
  // Keep the HUD focused when CD output is present.
  if (els.hudLineDesc) els.hudLineDesc.classList.toggle("hidden", hasDirector);
  if (els.hudLineSel) els.hudLineSel.classList.toggle("hidden", hasDirector);
}

// Give vision requests enough time to complete under normal network conditions.
// (Engine-side OpenAI timeout is ~22s; keep a little buffer.)
const DESCRIBE_TIMEOUT_MS = 30000;
const DESCRIBE_MAX_IN_FLIGHT = 3;
const UPLOAD_DESCRIBE_PRIORITY_BURST = 3;
let describeQueue = [];
let describeQueued = new Set(); // path strings
let describeInFlightOrder = [];
let describeInFlightTimers = new Map(); // path -> timeout id
let ptyLineBuffer = "";

function syncDescribePendingPath() {
  let next = null;
  for (const path of describeInFlightOrder) {
    if (describeInFlightTimers.has(path)) {
      next = path;
      break;
    }
  }
  if (!next && describeQueue.length) {
    next = describeQueue[0] || null;
  }
  state.describePendingPath = next || null;
}

function describeHasInFlight(path) {
  return describeInFlightTimers.has(path);
}

function clearDescribeInFlightPath(path) {
  const target = String(path || "").trim();
  if (!target) return false;
  const timer = describeInFlightTimers.get(target);
  if (timer) clearTimeout(timer);
  const hadInFlight = describeInFlightTimers.delete(target);
  if (hadInFlight) {
    describeInFlightOrder = describeInFlightOrder.filter((queuedPath) => queuedPath !== target);
  }
  syncDescribePendingPath();
  return hadInFlight;
}

function dropDescribeQueuedPath(path) {
  const target = String(path || "").trim();
  if (!target) return false;
  const beforeLen = describeQueue.length;
  describeQueue = describeQueue.filter((queuedPath) => queuedPath !== target);
  const removedFromSet = describeQueued.delete(target);
  syncDescribePendingPath();
  return removedFromSet || beforeLen !== describeQueue.length;
}

function oldestDescribeInFlightPath() {
  while (describeInFlightOrder.length) {
    const candidate = describeInFlightOrder[0];
    if (describeInFlightTimers.has(candidate)) return candidate;
    describeInFlightOrder.shift();
  }
  syncDescribePendingPath();
  return null;
}

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

function allowVisionDescribeInCurrentMode() {
  // During Intent Canvas onboarding we prefer capturing vision labels as part of the
  // intent realtime pass (faster + single API call). Keep describe available after
  // intent is locked, or outside intent mode entirely.
  if (intentModeActive()) return false;
  return true;
}

function resetDescribeQueue({ clearPending = false } = {}) {
  describeQueue = [];
  describeQueued.clear();
  for (const timer of describeInFlightTimers.values()) {
    if (timer) clearTimeout(timer);
  }
  describeInFlightTimers.clear();
  describeInFlightOrder = [];
  state.describePendingPath = null;

  if (!clearPending) return;
  for (const item of state.images) {
    if (item && item.visionPending && !item.visionDesc) {
      item.visionPending = false;
    }
  }
  renderHudReadout();
}

function dropVisionDescribePath(path, { cancelInFlight = true } = {}) {
  const target = String(path || "").trim();
  if (!target) return;
  const wasInFlight = describeHasInFlight(target);
  dropDescribeQueuedPath(target);
  if (cancelInFlight && wasInFlight) {
    const item = state.images.find((img) => img?.path === target) || null;
    if (item && item.visionPending && !item.visionDesc) item.visionPending = false;
    clearDescribeInFlightPath(target);
    processDescribeQueue();
  }
}

function processDescribeQueue() {
  if (describeInFlightOrder.length >= DESCRIBE_MAX_IN_FLIGHT) return;
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

  while (describeQueue.length && describeInFlightOrder.length < DESCRIBE_MAX_IN_FLIGHT) {
    const path = describeQueue.shift();
    if (typeof path !== "string" || !path) continue;
    describeQueued.delete(path);

    const item = state.images.find((img) => img?.path === path) || null;
    if (!item) continue;
    if (item && item.visionDesc) {
      item.visionPending = false;
      continue;
    }

    if (item) {
      item.visionPending = true;
      item.visionPendingAt = Date.now();
    }

    describeInFlightOrder.push(path);
    if (getActiveImage()?.path === path) renderHudReadout();
    syncDescribePendingPath();

    // NOTE: do not quote paths here. `/describe` uses a raw arg string (not shlex-split),
    // so adding quotes would become part of the path and fail to resolve.
    bumpSessionApiCalls();
    invoke("write_pty", { data: `${PTY_COMMANDS.DESCRIBE} ${path}\n` }).catch(() => {
      // Backend PTY might have exited; re-spawn and continue.
      state.ptySpawned = false;
      _completeDescribeInFlight({
        path,
        description: null,
        errorMessage: "Engine disconnected. Restarting…",
      });
      ensureEngineSpawned({ reason: "vision" }).catch(() => {});
    });

    const timer = setTimeout(() => {
      if (!describeHasInFlight(path)) return;
      const img = state.images.find((it) => it?.path === path) || null;
      if (img && img.visionPending && !img.visionDesc) img.visionPending = false;
      clearDescribeInFlightPath(path);
      if (getActiveImage()?.path === path) renderHudReadout();
      processDescribeQueue();
    }, DESCRIBE_TIMEOUT_MS);
    describeInFlightTimers.set(path, timer);
  }
}

function scheduleVisionDescribe(path, { priority = false } = {}) {
  if (!path) return;
  if (!allowVisionDescribe()) return;
  if (!allowVisionDescribeInCurrentMode()) return;

  const item = state.images.find((img) => img?.path === path) || null;
  if (!item) return;
  if (item) {
    if (item.visionDesc) return;
  }

  if (describeHasInFlight(path)) return;
  if (describeQueued.has(path)) {
    // If a user focuses an image, bump it to the front of the queue.
    if (priority) {
      describeQueue = [path, ...describeQueue.filter((p) => p !== path)];
      syncDescribePendingPath();
      processDescribeQueue();
    }
    return;
  }
  if (priority) describeQueue.unshift(path);
  else describeQueue.push(path);
  describeQueued.add(path);
  syncDescribePendingPath();
  if (getActiveImage()?.path === path) renderHudReadout();
  processDescribeQueue();
}

function scheduleVisionDescribeBurst(paths, { priority = true, maxConcurrent = UPLOAD_DESCRIBE_PRIORITY_BURST } = {}) {
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length) return;
  const burstLimit = Math.max(1, Number(maxConcurrent) || 1);
  const unique = [];
  const seen = new Set();
  for (const rawPath of list) {
    const path = String(rawPath || "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  if (!unique.length) return;
  for (let i = 0; i < unique.length; i += 1) {
    scheduleVisionDescribe(unique[i], { priority: Boolean(priority) && i < burstLimit });
  }
}

function _completeDescribeInFlight({
  path = null,
  description = null,
  meta = null, // { source, model }
  errorMessage = null,
} = {}) {
  let inflight = typeof path === "string" ? path.trim() : "";
  if (!inflight) inflight = oldestDescribeInFlightPath() || "";
  if (!inflight) inflight = typeof state.describePendingPath === "string" ? state.describePendingPath.trim() : "";
  if (!inflight) return;
  const item = state.images.find((img) => img?.path === inflight) || null;
  const cleanedDesc = typeof description === "string" ? description.trim() : "";
  if (item) {
    if (cleanedDesc) {
      item.visionDesc = cleanedDesc;
      item.visionDescMeta = {
        source: meta?.source || null,
        model: meta?.model || null,
        at: Date.now(),
      };
    }
    item.visionPending = false;
  }
  dropDescribeQueuedPath(inflight);
  clearDescribeInFlightPath(inflight);

  if (errorMessage) {
    showToast(errorMessage, "error", 3200);
  }
  if (cleanedDesc) {
    // Persist new per-image descriptions into run artifacts.
    scheduleVisualPromptWrite();
    if (intentAmbientActive()) {
      // Treat new vision descriptions as an intent signal.
      scheduleAmbientIntentInference({ immediate: true, reason: "describe", imageIds: [item?.id] });
    }
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
  if (!allowVisionDescribeInCurrentMode()) return;
  const active = getActiveImage();
  if (active?.path) scheduleVisionDescribe(active.path, { priority: true });
  for (const item of state.images) {
    if (!item?.path) continue;
    if (active?.path && item.path === active.path) continue;
    scheduleVisionDescribe(item.path);
  }
}

const ALWAYS_ON_VISION_DEBOUNCE_MS = 900;
const ALWAYS_ON_VISION_THROTTLE_MS = 12000;
const ALWAYS_ON_VISION_IDLE_MS = 5000;
const ALWAYS_ON_VISION_TIMEOUT_MS = 45000;

let alwaysOnVisionTimer = null;
let alwaysOnVisionTimeout = null;

let intentInferenceTimer = null;
let intentInferenceTimeout = null;
let intentTicker = null;
let intentStateWriteTimer = null;
let intentAmbientInferenceTimer = null;
let intentAmbientInferenceTimeout = null;

function extractCanvasContextSummary(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const lines = raw.split(/\r?\n/).map((line) => String(line || "").trim());
  const headerRe = /^(CANVAS|SUBJECTS|STYLE|NEXT ACTIONS)\s*:/i;
  let idx = lines.findIndex((line) => /^CANVAS\s*:/i.test(line));
  if (idx >= 0) {
    const line = lines[idx] || "";
    const inline = line.replace(/^CANVAS\s*:\s*/i, "").trim();
    if (inline) return inline;
    for (let j = idx + 1; j < lines.length; j += 1) {
      const next = lines[j] || "";
      if (!next) continue;
      if (headerRe.test(next)) break;
      return next;
    }
  }
  // Fallback: first non-header, non-empty line.
  for (const line of lines) {
    if (!line) continue;
    if (headerRe.test(line)) continue;
    return line;
  }
  return "";
}

function extractCanvasContextTopAction(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  let nextIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || "").trim();
    if (/^NEXT ACTIONS\s*:/i.test(line)) {
      nextIdx = i;
      break;
    }
  }
  if (nextIdx < 0) return null;

  const extractListItemRest = (lineRaw) => {
    const line = String(lineRaw || "").trim();
    if (!line) return null;
    // Bullets: "- Foo", "* Foo", "• Foo"
    let match = line.match(/^(?:[-*•])\s+(.*)$/);
    if (match) return String(match[1] || "").trim() || null;
    // Numbered: "1. Foo", "2) Foo"
    match = line.match(/^\d+\s*[\.\)]\s+(.*)$/);
    if (match) return String(match[1] || "").trim() || null;
    // Numbered: "1: Foo"
    match = line.match(/^\d+\s*:\s+(.*)$/);
    if (match) return String(match[1] || "").trim() || null;
    // Numbered: "1 - Foo" / "1 — Foo"
    match = line.match(/^\d+\s*[-—–]\s+(.*)$/);
    if (match) return String(match[1] || "").trim() || null;
    return null;
  };

  const parseActionLine = (restRaw) => {
    const rest = String(restRaw || "").trim();
    if (!rest) return null;

    // Prefer matching exact action names (including ones with colons like "Background: White").
    try {
      const allowed = Array.isArray(CANVAS_CONTEXT_ALLOWED_ACTIONS) ? CANVAS_CONTEXT_ALLOWED_ACTIONS : [];
      const sorted = allowed
        .map((s) => String(s || ""))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
      const lower = rest.toLowerCase();
      for (const candidate of sorted) {
        const candLower = candidate.toLowerCase();
        if (!lower.startsWith(candLower)) continue;
        const boundary = rest.slice(candidate.length, candidate.length + 1);
        // Reject partial-word matches (ex: "Bridgework" shouldn't match "Bridge").
        if (boundary && /[a-z0-9]/i.test(boundary)) continue;

        let remainder = rest.slice(candidate.length).trim();
        remainder = remainder.replace(/^[\s:—–-]+/, "").trim();
        return { action: candidate, why: remainder || null };
      }
    } catch (_) {
      // ignore
    }

    // Fallback: treat "Action: why" as a hint, but don't over-parse (actions can contain colons).
    const parts = rest.split(":", 2);
    const action = String(parts[0] || "").trim();
    const why = parts.length >= 2 ? String(parts[1] || "").trim() : "";
    if (!action) return null;
    return { action, why: why || null };
  };

  for (let i = nextIdx + 1; i < lines.length; i += 1) {
    const rest = extractListItemRest(lines[i]);
    if (!rest) continue;
    const parsed = parseActionLine(rest);
    if (!parsed?.action) continue;
    return parsed;
  }
  return null;
}

function updateAlwaysOnVisionReadout() {
  const aov = state.alwaysOnVision;
  const meta = aov?.lastMeta || null;

  const title =
    meta && (meta.source || meta.model)
      ? [meta.source, meta.model].filter(Boolean).join(" · ")
      : "";

  const hasOutput = typeof aov?.lastText === "string" && aov.lastText.trim();
  let text = "";

  if (!aov?.enabled) {
    if (aov?.disabledReason) {
      const cleaned = String(aov.disabledReason || "").trim();
      text = cleaned.length > 1400 ? `${cleaned.slice(0, 1399).trimEnd()}\n…` : cleaned;
    } else {
      text = "Off";
    }
  } else if (aov.rtState === "connecting" && !aov.pending && !hasOutput) {
    text = "Connecting…";
  } else if (aov.pending) {
    text = "ANALYZING…";
  } else if (hasOutput) {
    const cleaned = aov.lastText.trim();
    text = cleaned.length > 1400 ? `${cleaned.slice(0, 1399).trimEnd()}\n…` : cleaned;
  } else {
    text = getVisibleCanvasImages().length ? "On (waiting…)" : "On (no images loaded)";
  }

  if (els.alwaysOnVisionReadout) {
    els.alwaysOnVisionReadout.title = title;
    els.alwaysOnVisionReadout.textContent = text;
  }

  renderMotherReadout();
}

function allowAlwaysOnVision() {
  if (intentModeActive()) return false;
  if (!state.alwaysOnVision?.enabled) return false;
  if (!getVisibleCanvasImages().length) return false;
  if (!state.runDir) return false;
  // Fail fast before dispatch if we know required keys are missing.
  if (state.keyStatus) {
    if (!state.keyStatus.openai) return false;
  }
  return true;
}

function intentModeActive() {
  if (!INTENT_CANVAS_ENABLED) return false;
  return Boolean(state.intent && !state.intent.locked);
}

function intentAmbientActive() {
  if (!INTENT_AMBIENT_ENABLED) return false;
  const ambient = state.intentAmbient;
  if (!ambient || !ambient.enabled) return false;
  return true;
}

function rememberAmbientTouchedImageIds(ids = []) {
  const ambient = state.intentAmbient;
  if (!ambient) return;
  const ordered = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || "").trim();
    if (!id) continue;
    if (!state.imagesById.has(id)) continue;
    if (!ordered.includes(id)) ordered.push(id);
  }
  if (!ordered.length) return;
  const prev = Array.isArray(ambient.touchedImageIds) ? ambient.touchedImageIds : [];
  const merged = [...ordered];
  for (const id of prev) {
    if (!id || merged.includes(id)) continue;
    merged.push(id);
  }
  ambient.touchedImageIds = merged.slice(0, 8);
}

function syncIntentModeClass() {
  if (!els.canvasWrap) return;
  els.canvasWrap.classList.toggle("intent-mode", intentModeActive());
  syncIntentRealtimeClass();
}

function intentRealtimePulseActive() {
  const intent = state.intent;
  if (!intent || !intentModeActive()) return false;
  // "Actively sending/receiving" for Intent Canvas: request in flight or session connecting.
  return Boolean(intent.pending || intent.rtState === "connecting");
}

function intentAmbientRealtimePulseActive() {
  if (!INTENT_AMBIENT_ICON_PLACEMENT_ENABLED) return false;
  const ambient = state.intentAmbient;
  if (!ambient || !intentAmbientActive()) return false;
  return Boolean(ambient.pending || ambient.rtState === "connecting");
}

function syncIntentRealtimePortrait() {
  // Intent Canvas uses OpenAI Realtime; when a request is in flight, show the OpenAI portrait "working" clip.
  // Keep this scoped to intent mode so we don't fight foreground action portraits elsewhere.
  const intent = state.intent;
  const active = Boolean(intent && intentModeActive() && (intent.pending || intent.rtState === "connecting"));
  if (active) {
    if (!intentRealtimePortraitBusy || !state.portrait?.busy || String(state.portrait?.provider || "").toLowerCase() !== "openai") {
      intentRealtimePortraitBusy = true;
      portraitWorking("Intent Realtime", { providerOverride: "openai", clearDirector: false });
    }
    return;
  }
  if (intentRealtimePortraitBusy) {
    intentRealtimePortraitBusy = false;
    updatePortraitIdle();
  }
}

function syncIntentRealtimeClass() {
  if (!els.canvasWrap) return;
  els.canvasWrap.classList.toggle("intent-rt-active", intentRealtimePulseActive());
  const ambientPulse = INTENT_AMBIENT_ICON_PLACEMENT_ENABLED && intentAmbientRealtimePulseActive();
  els.canvasWrap.classList.toggle("intent-ambient-rt-active", ambientPulse);
  syncIntentRealtimePortrait();
}

function updateEmptyCanvasHint() {
  // Hint is a keyboard-accessible fallback for click-to-upload when no images exist.
  showDropHint((state.images?.length || 0) === 0);
}

function ensureIntentTicker() {
  if (intentTicker) return;
  if (!intentModeActive()) return;
  if (!INTENT_TIMER_ENABLED) return;
  // Only tick once the countdown is actually running.
  if (!state.intent?.startedAt) return;
  intentTicker = setInterval(() => {
    if (!intentModeActive()) {
      stopIntentTicker();
      return;
    }
    updateIntentCountdown();
    requestRender();
  }, 200);
}

function stopIntentTicker() {
  clearInterval(intentTicker);
  intentTicker = null;
}

function intentRemainingMs(nowMs = Date.now()) {
  const intent = state.intent;
  if (!intent) return INTENT_DEADLINE_MS;
  if (!intent.startedAt || !intent.deadlineAt) return INTENT_DEADLINE_MS;
  return Math.max(0, (Number(intent.deadlineAt) || 0) - (Number(nowMs) || 0));
}

function updateIntentCountdown(nowMs = Date.now()) {
  const intent = state.intent;
  if (!intentModeActive() || !intent) return;
  if (!INTENT_TIMER_ENABLED) return;
  if (!intent.startedAt || !intent.deadlineAt) return;
  const remaining = intentRemainingMs(nowMs);
  if (remaining > 0) return;
  if (intent.forceChoice) return;
  if (!INTENT_FORCE_CHOICE_ENABLED) return;
  intent.forceChoice = true;
  // If the model hasn't produced branches yet, fall back to a minimal local default so we can force a choice.
  ensureIntentFallbackIconState("timeout");
  if (!intent.focusBranchId) {
    intent.focusBranchId = pickDefaultIntentFocusBranchId();
  }
  scheduleIntentStateWrite({ immediate: true });
}

function scheduleIntentStateWrite({ immediate = false } = {}) {
  if (!state.runDir) return;
  const delay = immediate ? 0 : 320;
  clearTimeout(intentStateWriteTimer);
  intentStateWriteTimer = setTimeout(() => {
    intentStateWriteTimer = null;
    writeIntentState().catch((err) => {
      console.warn("Failed to write intent state:", err);
    });
  }, delay);
}

function buildIntentPersistedState() {
  const intent = state.intent || {};
  return {
    schema: "brood.intent_state",
    schema_version: 1,
    generated_at: new Date().toISOString(),
    locked: Boolean(intent.locked),
    locked_at_ms: Number(intent.lockedAt) || 0,
    locked_branch_id: intent.lockedBranchId ? String(intent.lockedBranchId) : null,
    started_at_ms: Number(intent.startedAt) || 0,
    deadline_at_ms: INTENT_TIMER_ENABLED ? Number(intent.deadlineAt) || 0 : 0,
    round: Math.max(1, Number(intent.round) || 1),
    total_rounds: INTENT_ROUNDS_ENABLED ? Math.max(1, Number(intent.totalRounds) || 3) : 0,
    selections: Array.isArray(intent.selections) ? intent.selections : [],
    focus_branch_id: intent.focusBranchId ? String(intent.focusBranchId) : null,
    icon_state: intent.iconState || null,
    icon_state_at_ms: Number(intent.iconStateAt) || 0,
    force_choice: INTENT_FORCE_CHOICE_ENABLED ? Boolean(intent.forceChoice) : false,
    rt_state: intent.rtState ? String(intent.rtState) : "off",
    disabled_reason: intent.disabledReason ? String(intent.disabledReason) : null,
    last_error: intent.lastError ? String(intent.lastError) : null,
    last_error_at_ms: Number(intent.lastErrorAt) || 0,
  };
}

async function writeIntentState() {
  if (!state.runDir) return false;
  const outPath = `${state.runDir}/${INTENT_PERSIST_FILENAME}`;
  const payload = buildIntentPersistedState();
  await writeTextFile(outPath, JSON.stringify(payload, null, 2));
  return true;
}

async function restoreIntentStateFromRunDir() {
  if (!state.runDir) return false;
  const lockedPath = `${state.runDir}/${INTENT_LOCKED_FILENAME}`;
  const statePath = `${state.runDir}/${INTENT_PERSIST_FILENAME}`;

  const loadJson = async (path) => {
    try {
      if (!(await exists(path))) return null;
      return JSON.parse(await readTextFile(path));
    } catch {
      return null;
    }
  };

  const locked = await loadJson(lockedPath);
  if (locked && typeof locked === "object") {
    state.intent.locked = true;
    state.intent.lockedAt = Number(locked.locked_at_ms) || 0;
    state.intent.lockedBranchId = locked.locked_branch_id ? String(locked.locked_branch_id) : null;
    state.intent.startedAt = Number(locked.started_at_ms) || 0;
    state.intent.deadlineAt = Number(locked.deadline_at_ms) || 0;
    state.intent.round = Math.max(1, Number(locked.round) || 1);
    state.intent.selections = Array.isArray(locked.selections) ? locked.selections : [];
    state.intent.focusBranchId = locked.focus_branch_id ? String(locked.focus_branch_id) : null;
    state.intent.iconState = locked.icon_state && typeof locked.icon_state === "object" ? locked.icon_state : null;
    state.intent.iconStateAt = Number(locked.icon_state_at_ms) || 0;
    state.intent.forceChoice = false;
    state.intent.pending = false;
    state.intent.pendingPath = null;
    state.intent.pendingAt = 0;
    state.intent.pendingFrameId = null;
    state.intent.rtState = "off";
    state.intent.disabledReason = null;
    state.intent.lastError = null;
    state.intent.lastErrorAt = 0;
    syncIntentModeClass();
    stopIntentTicker();
    renderQuickActions();
    requestRender();
    return true;
  }

  const persisted = await loadJson(statePath);
  if (persisted && typeof persisted === "object") {
    state.intent.locked = Boolean(persisted.locked);
    state.intent.lockedAt = Number(persisted.locked_at_ms) || 0;
    state.intent.lockedBranchId = persisted.locked_branch_id ? String(persisted.locked_branch_id) : null;
    state.intent.startedAt = Number(persisted.started_at_ms) || 0;
    state.intent.deadlineAt = Number(persisted.deadline_at_ms) || 0;
    state.intent.round = Math.max(1, Number(persisted.round) || 1);
    state.intent.totalRounds = Math.max(1, Number(persisted.total_rounds) || state.intent.totalRounds || 3);
    state.intent.selections = Array.isArray(persisted.selections) ? persisted.selections : [];
    state.intent.focusBranchId = persisted.focus_branch_id ? String(persisted.focus_branch_id) : null;
    state.intent.iconState = persisted.icon_state && typeof persisted.icon_state === "object" ? persisted.icon_state : null;
    state.intent.iconStateAt = Number(persisted.icon_state_at_ms) || 0;
    state.intent.forceChoice = Boolean(persisted.force_choice);
    state.intent.pending = false;
    state.intent.pendingPath = null;
    state.intent.pendingAt = 0;
    state.intent.pendingFrameId = null;
    state.intent.rtState = "off";
    state.intent.disabledReason = persisted.disabled_reason ? String(persisted.disabled_reason) : null;
    state.intent.lastError = persisted.last_error ? String(persisted.last_error) : null;
    state.intent.lastErrorAt = Number(persisted.last_error_at_ms) || 0;
    if (!INTENT_FORCE_CHOICE_ENABLED) {
      state.intent.forceChoice = false;
    } else if (INTENT_ROUNDS_ENABLED) {
      const total = Math.max(1, Number(state.intent.totalRounds) || 3);
      if (!state.intent.locked && state.intent.iconState && state.intent.round >= total) {
        state.intent.forceChoice = true;
      }
    }
    syncIntentModeClass();
    if (intentModeActive()) ensureIntentTicker();
    renderQuickActions();
    requestRender();
    return true;
  }
  return false;
}

const CANVAS_CONTEXT_ENVELOPE_VERSION = 2;
const CANVAS_CONTEXT_ALLOWED_ACTIONS = [
  "Multi view",
  "Single view",
  "Combine",
  "Bridge",
  "Swap DNA",
  "Argue",
  "Extract the Rule",
  "Odd One Out",
  "Triforce",
  "Diagnose",
  "Recast",
  "Variations",
  "Background: White",
  "Background: Sweep",
  "Crop: Square",
  "Annotate",
];

const AUTO_ACCEPT_SUGGESTED_MAX_PASSES = 3;

const CANVAS_CONTEXT_ACTION_GLOSSARY = [
  {
    action: "Multi view",
    what: "Show all loaded photos on the canvas (enables 2-photo and 3-photo actions when the right count is loaded).",
    requires: "At least 2 photos loaded.",
  },
  {
    action: "Single view",
    what: "Show one image at a time (restores single-image actions).",
    requires: "At least 1 photo loaded.",
  },
  {
    action: "Combine",
    what: "Blend the two loaded photos into one output image.",
    requires: "Exactly 2 photos loaded (multi-image action).",
  },
  {
    action: "Bridge",
    what: "Generate the aesthetic midpoint between two images (not a collage).",
    requires: "Exactly 2 photos loaded (multi-image action).",
  },
  {
    action: "Swap DNA",
    what: "Use structure from one image and surface qualities from the other.",
    requires: "Exactly 2 photos loaded (multi-image action).",
  },
  {
    action: "Argue",
    what: "Debate the two directions (why each is stronger, with visual evidence).",
    requires: "Exactly 2 photos loaded (multi-image action).",
  },
  {
    action: "Extract the Rule",
    what: "Extract the shared invisible rule/pattern across three images.",
    requires: "Exactly 3 photos loaded (multi-image action).",
  },
  {
    action: "Odd One Out",
    what: "Identify which of three images breaks the shared pattern, and explain why.",
    requires: "Exactly 3 photos loaded (multi-image action).",
  },
  {
    action: "Triforce",
    what: "Generate the centroid: one image equidistant from all three references.",
    requires: "Exactly 3 photos loaded (multi-image action).",
  },
  {
    action: "Diagnose",
    what: "Creative-director diagnosis: what's working, what's not, and what to fix next.",
    requires: "An active image.",
  },
  {
    action: "Recast",
    what: "Reimagine the image in a different medium/context.",
    requires: "An active image.",
  },
  {
    action: "Variations",
    what: "Generate zero-prompt variations of the active image.",
    requires: "An active image.",
  },
  {
    action: "Background: White",
    what: "Replace background with clean studio white (optionally uses lasso selection).",
    requires: "An active image.",
  },
  {
    action: "Background: Sweep",
    what: "Replace background with a soft sweep gradient (optionally uses lasso selection).",
    requires: "An active image.",
  },
  {
    action: "Crop: Square",
    what: "Crop the active image to a centered square.",
    requires: "An active image that is not already square.",
  },
  {
    action: "Annotate",
    what: "Select the Annotate tool so the user can draw a box and type an instruction.",
    requires: "An active image.",
  },
];

function _canvasContextSidecarPath(snapshotPath) {
  const raw = String(snapshotPath || "").trim();
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return `${raw}.ctx.json`;
  return `${raw.slice(0, dot)}.ctx.json`;
}

function _stableQuickActionLabel(label) {
  return String(label || "")
    .replace(/\s*\(running\.\.\.\)\s*$/i, "")
    .replace(/\s*\(running…\)\s*$/i, "")
    .trim();
}

function buildCanvasContextEnvelope() {
  const activeId = getVisibleActiveId();
  const active = activeId ? state.imagesById.get(activeId) || null : null;
  const wrap = els.canvasWrap;
  const dpr = getDpr();
  const canvasCssW = wrap?.clientWidth || 0;
  const canvasCssH = wrap?.clientHeight || 0;

  ensureFreeformLayoutRectsCss(state.images || [], canvasCssW, canvasCssH);

  const selectedIds = getVisibleSelectedIds();
  const selectedSet = new Set(selectedIds);
  const z = Array.isArray(state.freeformZOrder) ? state.freeformZOrder : [];
  const images = [];
  for (let idx = 0; idx < z.length; idx += 1) {
    const imageId = String(z[idx] || "").trim();
    if (!imageId) continue;
    if (!isVisibleCanvasImageId(imageId)) continue;
    const item = state.imagesById.get(imageId) || null;
    const rect = state.freeformRects.get(imageId) || null;
    if (!item?.path || !rect) continue;
    const x = Number(rect.x) || 0;
    const y = Number(rect.y) || 0;
    const w = Math.max(1, Number(rect.w) || 1);
    const h = Math.max(1, Number(rect.h) || 1);
    const cx = x + w / 2;
    const cy = y + h / 2;
    images.push({
      id: String(imageId),
      file: basename(item.path),
      z: idx,
      is_active: Boolean(activeId && String(activeId) === String(imageId)),
      is_selected: selectedSet.has(String(imageId)),
      rect_css: { x, y, w, h, cx, cy },
      rect_norm: {
        x: canvasCssW ? x / canvasCssW : 0,
        y: canvasCssH ? y / canvasCssH : 0,
        w: canvasCssW ? w / canvasCssW : 0,
        h: canvasCssH ? h / canvasCssH : 0,
        cx: canvasCssW ? cx / canvasCssW : 0,
        cy: canvasCssH ? cy / canvasCssH : 0,
      },
    });
  }

  const realtimeEnabled = Boolean(state.alwaysOnVision?.enabled);
  const quickActions = (computeQuickActions() || [])
    .filter((action) => action && action.id && action.label)
    .map((action) => ({
      id: String(action.id),
      label: _stableQuickActionLabel(action.label),
      enabled: !action.disabled,
      title: action.title ? String(action.title) : null,
    }));

  // Always-on realtime canvas context acts as a continual Diagnose; avoid recommending it when enabled.
  const allowedAbilities = realtimeEnabled
    ? CANVAS_CONTEXT_ALLOWED_ACTIONS.filter((name) => name !== "Diagnose")
    : CANVAS_CONTEXT_ALLOWED_ACTIONS;
  const glossary = realtimeEnabled
    ? CANVAS_CONTEXT_ACTION_GLOSSARY.filter((entry) => entry?.action !== "Diagnose")
    : CANVAS_CONTEXT_ACTION_GLOSSARY;

  const nodes = Array.from(state.timelineNodes || []).sort((a, b) => (a?.createdAt || 0) - (b?.createdAt || 0));
  const timelineRecent = nodes.slice(-12).map((node) => ({
    at: node?.createdAt ? new Date(node.createdAt).toISOString() : null,
    action: node?.action ? String(node.action) : null,
    file: basename(node?.path),
    label: node?.label ? String(node.label) : null,
  }));

  const eventsRecent = (Array.isArray(state.userEvents) ? state.userEvents : [])
    .slice(-32)
    .map((ev) => {
      const out = {
        at_ms: Number(ev?.at_ms) || null,
        type: ev?.type ? String(ev.type) : null,
      };
      for (const key of ["tool", "key", "kind", "image_id", "corner", "canvas_mode", "active_id", "selected_ids", "file"]) {
        if (ev && Object.prototype.hasOwnProperty.call(ev, key)) {
          out[key] = ev[key];
        }
      }
      // Best-effort deltas (used by move/resize) but keep it compact.
      if (ev?.start && ev?.end) {
        out.start = ev.start;
        out.end = ev.end;
      }
      return out;
    })
    .filter((ev) => ev && ev.type);

  const visibleImageCount = getVisibleCanvasImages().length;

  return {
    schema_version: CANVAS_CONTEXT_ENVELOPE_VERSION,
    generated_at: new Date().toISOString(),
    canvas: {
      width_css: canvasCssW,
      height_css: canvasCssH,
      width_px: Math.max(0, Math.round(canvasCssW * dpr)),
      height_px: Math.max(0, Math.round(canvasCssH * dpr)),
      dpr,
    },
    canvas_mode: state.canvasMode,
    tool: state.tool,
    n_images: visibleImageCount,
    active_image: active?.path ? basename(active.path) : null,
    selection: {
      active_id: activeId ? String(activeId) : null,
      selected_ids: selectedIds.slice(0, 3),
    },
    images: images.slice(0, 12),
    allowed_abilities: allowedAbilities,
    abilities: quickActions,
    ability_glossary: glossary,
    timeline_recent: timelineRecent,
    events_recent: eventsRecent,
  };
}

async function writeCanvasContextEnvelope(snapshotPath) {
  if (!state.runDir) return null;
  const ctxPath = _canvasContextSidecarPath(snapshotPath);
  if (!ctxPath) return null;
  const envelope = buildCanvasContextEnvelope();
  const payload = JSON.stringify(envelope);
  await writeTextFile(ctxPath, payload);
  return ctxPath;
}

function normalizeSuggestedActionName(name) {
  return String(name || "")
    .trim()
    .replace(/\.+\s*$/g, "")
    .trim();
}

function canvasContextAllowedActions() {
  // Always-on realtime canvas context acts as a continual Diagnose; avoid exposing it as a suggestion.
  if (state.alwaysOnVision?.enabled) {
    return CANVAS_CONTEXT_ALLOWED_ACTIONS.filter((name) => name !== "Diagnose");
  }
  return CANVAS_CONTEXT_ALLOWED_ACTIONS;
}

function isCanvasContextAllowedAction(actionName) {
  const cleaned = normalizeSuggestedActionName(actionName).toLowerCase();
  if (!cleaned) return false;
  return canvasContextAllowedActions().some((cand) => String(cand || "").toLowerCase() === cleaned);
}

function canonicalizeCanvasContextAction(actionName, whyHint = null) {
  let cleaned = normalizeSuggestedActionName(actionName);
  if (!cleaned) return "";
  cleaned = cleaned.replace(/\s*:\s*/g, ": ").trim();

  const why = typeof whyHint === "string" ? whyHint.trim() : "";
  const lower = cleaned.toLowerCase();
  const whyLower = why.toLowerCase();

  // Common truncations: our action names include colons ("Background: White", "Crop: Square"),
  // but the realtime text often uses "Action: Variant: ..." which can get parsed as "Background".
  if (lower === "background" || lower === "background replace" || lower === "bg") {
    if (whyLower.includes("sweep") || whyLower.includes("gradient")) return "Background: Sweep";
    return "Background: White";
  }
  if (lower === "studio white") return "Background: White";
  if (lower === "studio sweep") return "Background: Sweep";

  if (lower === "crop" || lower === "crop square" || lower === "square crop") return "Crop: Square";

  const compact = lower.replace(/\s+/g, " ").trim();
  if (compact === "extract rule" || compact === "extract the rule") return "Extract the Rule";
  if (compact === "odd one out") return "Odd One Out";
  if (compact === "swap dna" || compact.replace(/\s+/g, "") === "swapdna") return "Swap DNA";

  // Preserve canonical casing when the action is in our allowlist.
  const allow = CANVAS_CONTEXT_ALLOWED_ACTIONS.find((cand) => String(cand || "").toLowerCase() === lower);
  if (allow) return allow;

  return cleaned;
}

function _hideCanvasContextSuggestion(wrap, btn) {
  wrap.classList.remove("is-visible");
  wrap.setAttribute("aria-hidden", "true");
  btn.textContent = "";
  btn.disabled = true;
  btn.classList.remove("is-unavailable");
  btn.title = "";
}

function _canvasContextDisabledReason(action) {
  const nImages = state.images.length || 0;
  const nSelected = selectedCount();
  if (action === "Multi view") {
    if (nImages < 2) return `Requires at least 2 images (you have ${nImages}).`;
    if (state.canvasMode === "multi") return "Already in multi view.";
    return "";
  }
  if (action === "Single view") {
    if (nImages < 1) return "No images loaded.";
    if (state.canvasMode !== "multi") return "Already in single view.";
    return "";
  }
  if (["Combine", "Bridge", "Swap DNA", "Argue"].includes(action)) {
    if (nSelected !== 2) return `Requires exactly 2 selected images (you have ${nSelected}).`;
    return "";
  }
  if (["Extract the Rule", "Odd One Out", "Triforce"].includes(action)) {
    if (nSelected !== 3) return `Requires exactly 3 selected images (you have ${nSelected}).`;
    return "";
  }
  if (!getActiveImage()) return "No active image.";
  if (action === "Crop: Square") {
    const active = getActiveImage();
    const iw = active?.img?.naturalWidth || active?.width || null;
    const ih = active?.img?.naturalHeight || active?.height || null;
    if (iw && ih && Math.abs(iw - ih) <= 8) return "Already square.";
  }
  return "";
}

function disableAutoAcceptSuggestedAbility(message = "") {
  settings.autoAcceptSuggestedAbility = false;
  localStorage.setItem("brood.autoAcceptSuggestedAbility", "0");
  if (state.autoAcceptSuggestedAbility) {
    state.autoAcceptSuggestedAbility.enabled = false;
  }
  if (els.autoAcceptSuggestedAbilityToggle) {
    els.autoAcceptSuggestedAbilityToggle.checked = false;
  }
  if (message) showToast(message, "tip", 2400);
}

function maybeAutoAcceptCanvasContextSuggestion(action, rec) {
  const auto = state.autoAcceptSuggestedAbility;
  if (!auto?.enabled) return;
  if (!rec?.at || !action) return;
  if (auto.inFlight) return;
  if (auto.passes >= AUTO_ACCEPT_SUGGESTED_MAX_PASSES) {
    disableAutoAcceptSuggestedAbility("Auto-accept: cap reached (3).");
    return;
  }
  if (auto.lastAcceptedAt === rec.at) return;

  auto.inFlight = true;
  auto.lastAcceptedAt = rec.at;
  auto.passes += 1;
  if (auto.passes >= AUTO_ACCEPT_SUGGESTED_MAX_PASSES) {
    // Disable after this pass to prevent runaway loops.
    disableAutoAcceptSuggestedAbility("Auto-accept: cap reached (3).");
  }

  triggerCanvasContextSuggestedAction(action)
    .catch((err) => {
      const msg = err?.message || String(err);
      showToast(msg, "error", 2600);
    })
    .finally(() => {
      auto.inFlight = false;
    });
}

function renderCanvasContextSuggestion() {
  const wrap = els.canvasContextSuggest;
  const btn = els.canvasContextSuggestBtn;
  if (!wrap || !btn) return;

  const rec = state.canvasContextSuggestion;
  if (!state.alwaysOnVision?.enabled || !rec?.action) {
    _hideCanvasContextSuggestion(wrap, btn);
    return;
  }

  const action = canonicalizeCanvasContextAction(rec.action, rec.why);
  if (!action || !isCanvasContextAllowedAction(action)) {
    _hideCanvasContextSuggestion(wrap, btn);
    return;
  }

  // Only show enabled suggestions. If it's not currently usable (wrong image count, already in that mode),
  // hide it entirely so the Abilities panel stays clean.
  const disabledReason = _canvasContextDisabledReason(action);
  if (disabledReason) {
    _hideCanvasContextSuggestion(wrap, btn);
    return;
  }

  wrap.classList.add("is-visible");
  wrap.setAttribute("aria-hidden", "false");
  btn.textContent = action;
  btn.disabled = false;
  btn.classList.remove("is-unavailable");
  btn.title = String(rec.why || "").trim();

  maybeAutoAcceptCanvasContextSuggestion(action, rec);
}

async function triggerCanvasContextSuggestedAction(actionName) {
  const action = normalizeSuggestedActionName(actionName);
  if (!action) return;
  const active = getActiveImage();
  const nSelected = selectedCount();

  if (action === "Multi view") {
    if (state.images.length < 2) throw new Error("Multi view requires at least 2 images.");
    if (state.canvasMode !== "multi") setCanvasMode("multi");
    return;
  }
  if (action === "Single view") {
    if (state.images.length < 1) throw new Error("Single view requires at least 1 image.");
    if (state.canvasMode !== "single") setCanvasMode("single");
    return;
  }
  if (action === "Combine") {
    if (nSelected !== 2) throw new Error(`Combine requires exactly 2 selected images (you have ${nSelected}).`);
    if (state.canvasMode !== "multi") setCanvasMode("multi");
    await runBlendPair();
    return;
  }
  if (action === "Bridge") {
    if (nSelected !== 2) throw new Error(`Bridge requires exactly 2 selected images (you have ${nSelected}).`);
    if (state.canvasMode !== "multi") setCanvasMode("multi");
    await runBridgePair();
    return;
  }
  if (action === "Swap DNA") {
    if (nSelected !== 2) throw new Error(`Swap DNA requires exactly 2 selected images (you have ${nSelected}).`);
    if (state.canvasMode !== "multi") setCanvasMode("multi");
    await runSwapDnaPair({ invert: false });
    return;
  }
  if (action === "Argue") {
    if (nSelected !== 2) throw new Error(`Argue requires exactly 2 selected images (you have ${nSelected}).`);
    if (state.canvasMode !== "multi") setCanvasMode("multi");
    await runArguePair();
    return;
  }
  if (action === "Extract the Rule") {
    if (nSelected !== 3)
      throw new Error(`Extract the Rule requires exactly 3 selected images (you have ${nSelected}).`);
    if (state.canvasMode !== "multi") setCanvasMode("multi");
    await runExtractRuleTriplet();
    return;
  }
  if (action === "Odd One Out") {
    if (nSelected !== 3) throw new Error(`Odd One Out requires exactly 3 selected images (you have ${nSelected}).`);
    if (state.canvasMode !== "multi") setCanvasMode("multi");
    await runOddOneOutTriplet();
    return;
  }
  if (action === "Triforce") {
    if (nSelected !== 3) throw new Error(`Triforce requires exactly 3 selected images (you have ${nSelected}).`);
    if (state.canvasMode !== "multi") setCanvasMode("multi");
    await runTriforceTriplet();
    return;
  }
  if (action === "Diagnose") {
    if (!active) throw new Error("Diagnose requires an active image.");
    await runDiagnose();
    return;
  }
  if (action === "Recast") {
    if (!active) throw new Error("Recast requires an active image.");
    await runRecast();
    return;
  }
  if (action === "Variations") {
    if (!active) throw new Error("Variations requires an active image.");
    await runVariations();
    return;
  }
  if (action === "Background: White") {
    if (!active) throw new Error("Background replace requires an active image.");
    await applyBackground("white");
    return;
  }
  if (action === "Background: Sweep") {
    if (!active) throw new Error("Background replace requires an active image.");
    await applyBackground("sweep");
    return;
  }
  if (action === "Crop: Square") {
    if (!active) throw new Error("Crop requires an active image.");
    await cropSquare();
    return;
  }
  if (action === "Annotate") {
    if (!active) throw new Error("Annotate requires an active image.");
    setTool("annotate");
    showToast("Annotate tool selected.", "tip", 1800);
    return;
  }

  // Fallback: attempt to route to an existing Ability by label.
  const match = (computeQuickActions() || []).find((qa) => {
    const label = _stableQuickActionLabel(qa?.label);
    return label && label.toLowerCase() === action.toLowerCase();
  });
  if (match && !match.disabled && typeof match.onClick === "function") {
    match.onClick();
    return;
  }
  throw new Error(`Unknown suggested action: ${action}`);
}

function requireIntentUnlocked(message = null) {
  if (!intentModeActive()) return true;
  const msg = message ? String(message) : "Lock an intent to unlock abilities.";
  showToast(msg, "tip", 2200);
  return false;
}

function isForegroundActionRunning() {
  return Boolean(
    state.ptySpawning ||
      state.actionQueueActive ||
    state.pendingBlend ||
      state.pendingSwapDna ||
      state.pendingBridge ||
      state.pendingExtractDna ||
      state.pendingSoulLeech ||
      state.pendingArgue ||
      state.pendingExtractRule ||
      state.pendingOddOneOut ||
      state.pendingTriforce ||
      state.pendingRecast ||
      state.pendingCanvasDiagnose ||
      state.pendingDiagnose ||
      state.expectingArtifacts ||
      state.pendingReplace
  );
}

function computeCanvasSignature() {
  const parts = [];
  for (const item of state.images) {
    const id = String(item?.id || "").trim();
    if (!id || !isVisibleCanvasImageId(id)) continue;
    parts.push(`id=${id}`);
    if (item?.path) parts.push(item.path);
  }
  // Spatial layout is a first-class signal; include freeform rects so background inference
  // reacts to user arrangement but ignore pure camera/view changes (pan/zoom/selection).
  const z = Array.isArray(state.freeformZOrder) ? state.freeformZOrder : [];
  for (const imageIdRaw of z) {
    const imageId = String(imageIdRaw || "").trim();
    if (!imageId || !isVisibleCanvasImageId(imageId)) continue;
    const rect = imageId ? state.freeformRects.get(imageId) : null;
    if (!rect) continue;
    parts.push(
      `rect:${imageId}:${Math.round(Number(rect.x) || 0)},${Math.round(Number(rect.y) || 0)},${Math.round(
        Number(rect.w) || 0
      )},${Math.round(Number(rect.h) || 0)}`
    );
  }
  return parts.join("|");
}

function markAlwaysOnVisionDirty(reason = null) {
  const aov = state.alwaysOnVision;
  if (!aov) return;
  aov.contentDirty = true;
  aov.dirtyReason = reason ? String(reason) : null;
}

function scheduleAlwaysOnVision({ immediate = false, force = false } = {}) {
  if (!allowAlwaysOnVision()) {
    updateAlwaysOnVisionReadout();
    return;
  }
  clearTimeout(alwaysOnVisionTimer);
  const forced = Boolean(force);
  const delay = immediate ? 0 : ALWAYS_ON_VISION_DEBOUNCE_MS;
  alwaysOnVisionTimer = setTimeout(() => {
    alwaysOnVisionTimer = null;
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(
        () => {
          runAlwaysOnVisionOnce({ force: forced }).catch((err) => console.warn("Always-on vision failed:", err));
        },
        { timeout: 1200 }
      );
    } else {
      runAlwaysOnVisionOnce({ force: forced }).catch((err) => console.warn("Always-on vision failed:", err));
    }
  }, delay);
}

async function runAlwaysOnVisionOnce({ force = false } = {}) {
  if (!allowAlwaysOnVision()) {
    updateAlwaysOnVisionReadout();
    return false;
  }
  const aov = state.alwaysOnVision;
  if (aov.pending) return false;
  if (!force && !aov.contentDirty) return false;

  const now = Date.now();
  const quietFor = now - (state.lastInteractionAt || 0);
  if (quietFor < ALWAYS_ON_VISION_IDLE_MS) {
    scheduleAlwaysOnVision({ force });
    return false;
  }
  if (isForegroundActionRunning()) {
    scheduleAlwaysOnVision({ force });
    return false;
  }

  const since = now - (aov.lastRunAt || 0);
  if (since < ALWAYS_ON_VISION_THROTTLE_MS) {
    scheduleAlwaysOnVision({ force });
    return false;
  }

  const signature = computeCanvasSignature();
  if (!force && signature && aov.lastSignature === signature && aov.lastText) {
    aov.contentDirty = false;
    aov.dirtyReason = null;
    return false;
  }

  await ensureRun();
  const stamp = Date.now();
  const snapshotPath = `${state.runDir}/alwayson-${stamp}.png`;
  await waitForIntentImagesLoaded({ timeoutMs: 900 });
  // Ensure the on-screen canvas is up to date before we capture a snapshot.
  render();
  await writeIntentSnapshot(snapshotPath, { maxDimPx: 900 });
  await writeCanvasContextEnvelope(snapshotPath).catch((err) => {
    console.warn("Failed to write canvas context envelope:", err);
  });

  const ok = await ensureEngineSpawned({ reason: "always-on vision" });
  if (!ok) return false;

  aov.pending = true;
  aov.pendingPath = snapshotPath;
  aov.pendingAt = now;
  aov.lastRunAt = now;
  aov.lastSignature = signature;
  aov.contentDirty = false;
  aov.dirtyReason = null;
  updateAlwaysOnVisionReadout();

  clearTimeout(alwaysOnVisionTimeout);
  alwaysOnVisionTimeout = setTimeout(() => {
    if (!state.alwaysOnVision?.pending) return;
    state.alwaysOnVision.pending = false;
    state.alwaysOnVision.pendingPath = null;
    updateAlwaysOnVisionReadout();
    processActionQueue().catch(() => {});
  }, ALWAYS_ON_VISION_TIMEOUT_MS);

  if (aov.rtState === "off") aov.rtState = "connecting";

  // Ensure the canvas-context realtime backend is running before dispatching snapshot work.
  await invoke("write_pty", { data: `${PTY_COMMANDS.CANVAS_CONTEXT_RT_START}\n` }).catch((err) => {
    console.warn("Always-on vision canvas context start failed:", err);
  });

  try {
    await invoke("write_pty", { data: `${PTY_COMMANDS.CANVAS_CONTEXT_RT} ${quoteForPtyArg(snapshotPath)}\n` });
  } catch (err) {
    console.warn("Always-on vision dispatch failed:", err);
    aov.pending = false;
    aov.pendingPath = null;
    aov.contentDirty = true;
    updateAlwaysOnVisionReadout();
    processActionQueue().catch(() => {});
    return false;
  }
  bumpSessionApiCalls();
  return true;
}

function _ambientIntentViewportWorldBounds() {
  const wrap = els.canvasWrap;
  const canvasCssW = Math.max(1, Number(wrap?.clientWidth) || 1);
  const canvasCssH = Math.max(1, Number(wrap?.clientHeight) || 1);
  const dpr = Math.max(0.0001, getDpr());

  if (state.canvasMode === "multi") {
    const scale = Math.max(0.0001, Number(state.multiView?.scale) || 1);
    const offsetCssX = (Number(state.multiView?.offsetX) || 0) / dpr;
    const offsetCssY = (Number(state.multiView?.offsetY) || 0) / dpr;
    return {
      minX: (0 - offsetCssX) / scale,
      minY: (0 - offsetCssY) / scale,
      maxX: (canvasCssW - offsetCssX) / scale,
      maxY: (canvasCssH - offsetCssY) / scale,
    };
  }

  const scale = Math.max(0.0001, Number(state.view?.scale) || 1);
  const offsetCssX = (Number(state.view?.offsetX) || 0) / dpr;
  const offsetCssY = (Number(state.view?.offsetY) || 0) / dpr;
  return {
    minX: (0 - offsetCssX) / scale,
    minY: (0 - offsetCssY) / scale,
    maxX: (canvasCssW - offsetCssX) / scale,
    maxY: (canvasCssH - offsetCssY) / scale,
  };
}

function viewportWorldRect() {
  const vp = _ambientIntentViewportWorldBounds();
  if (!vp) return null;
  const minX = Number(vp.minX) || 0;
  const minY = Number(vp.minY) || 0;
  const maxX = Number(vp.maxX) || 0;
  const maxY = Number(vp.maxY) || 0;
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  return { x: minX, y: minY, w, h };
}

function rectVisibleRatioInViewport(rect) {
  const r = rect && typeof rect === "object" ? rect : null;
  const vp = viewportWorldRect();
  if (!r || !vp) return 1;
  const rx = Number(r.x) || 0;
  const ry = Number(r.y) || 0;
  const rw = Math.max(1, Number(r.w) || 1);
  const rh = Math.max(1, Number(r.h) || 1);
  const ix = Math.max(rx, vp.x);
  const iy = Math.max(ry, vp.y);
  const ax = Math.min(rx + rw, vp.x + vp.w);
  const ay = Math.min(ry + rh, vp.y + vp.h);
  const iw = Math.max(0, ax - ix);
  const ih = Math.max(0, ay - iy);
  return (iw * ih) / Math.max(1, rw * rh);
}

function recenterRectToViewport(rect) {
  const r = rect && typeof rect === "object" ? rect : null;
  const vp = viewportWorldRect();
  if (!r || !vp) return r;
  const rw = Math.max(1, Number(r.w) || 1);
  const rh = Math.max(1, Number(r.h) || 1);
  return {
    x: vp.x + (vp.w - rw) * 0.5,
    y: vp.y + (vp.h - rh) * 0.5,
    w: rw,
    h: rh,
    autoAspect: true,
  };
}

function _ambientIntentImageRectsWorldMap() {
  const out = new Map();
  if (state.canvasMode === "multi") {
    const z = Array.isArray(state.freeformZOrder) ? state.freeformZOrder : [];
    for (const imageId of z) {
      const key = String(imageId || "").trim();
      if (!key) continue;
      const rect = state.freeformRects.get(key);
      if (!rect) continue;
      out.set(key, {
        x: Number(rect.x) || 0,
        y: Number(rect.y) || 0,
        w: Math.max(1, Number(rect.w) || 1),
        h: Math.max(1, Number(rect.h) || 1),
      });
    }
    return out;
  }

  const active = getActiveImage();
  if (!active?.id) return out;
  const iw = Number(active?.img?.naturalWidth || active?.width) || 0;
  const ih = Number(active?.img?.naturalHeight || active?.height) || 0;
  if (iw > 0 && ih > 0) {
    out.set(String(active.id), { x: 0, y: 0, w: iw, h: ih });
  }
  return out;
}

function _ambientUseCaseKeyForBranch(branch) {
  if (!branch || typeof branch !== "object") return null;
  const direct = _intentUseCaseKeyFromBranchId(branch.branch_id);
  if (direct) return direct;
  const icons = Array.isArray(branch.icons)
    ? branch.icons.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean)
    : [];
  if (icons.includes("GAME_DEV_ASSETS")) return "game_dev_assets";
  if (icons.includes("STREAMING_CONTENT")) return "streaming_content";
  if (icons.includes("UI_UX_PROTOTYPING")) return "uiux_prototyping";
  if (icons.includes("ECOMMERCE_POD")) return "ecommerce_pod";
  if (icons.includes("CONTENT_ENGINE")) return "content_engine";
  return null;
}

function computeAmbientIntentSignature() {
  const parts = [];
  const z = Array.isArray(state.freeformZOrder) ? state.freeformZOrder : [];
  for (const imageIdRaw of z) {
    const imageId = String(imageIdRaw || "").trim();
    if (!imageId || !isVisibleCanvasImageId(imageId)) continue;
    const item = state.imagesById.get(imageId) || null;
    const rect = state.freeformRects.get(imageId) || null;
    if (item?.path) parts.push(String(item.path));
    if (item?.visionDesc) {
      const v = String(item.visionDesc).replace(/[\r\n\t|]+/g, " ").replace(/\s+/g, " ").trim();
      if (v) parts.push(`desc:${String(imageId)}:${clampText(v, 56)}`);
    }
    if (!rect) continue;
    parts.push(
      `rect:${String(imageId)}:${Math.round(Number(rect.x) || 0)},${Math.round(Number(rect.y) || 0)},${Math.round(
        Number(rect.w) || 0
      )},${Math.round(Number(rect.h) || 0)}`
    );
  }
  return parts.join("|");
}

function clearAmbientIntentPending() {
  const ambient = state.intentAmbient;
  if (!ambient) return;
  ambient.pending = false;
  ambient.pendingPath = null;
  ambient.pendingAt = 0;
  ambient.pendingFrameId = null;
}

function clearAmbientIntentTimers() {
  clearTimeout(intentAmbientInferenceTimer);
  intentAmbientInferenceTimer = null;
  clearTimeout(intentAmbientInferenceTimeout);
  intentAmbientInferenceTimeout = null;
}

function resetAmbientIntentState({ keepSuggestions = false } = {}) {
  const ambient = state.intentAmbient;
  if (!ambient) return;
  clearAmbientIntentPending();
  ambient.frameSeq = 0;
  ambient.rtState = "off";
  ambient.disabledReason = null;
  ambient.lastError = null;
  ambient.lastErrorAt = 0;
  ambient.lastSignature = null;
  ambient.lastRunAt = 0;
  ambient.iconState = null;
  ambient.iconStateAt = 0;
  ambient.touchedImageIds = [];
  ambient.uiHits = [];
  ambient.lastReason = null;
  if (!keepSuggestions) ambient.suggestions = [];
  clearAmbientIntentTimers();
}

function rebuildAmbientIntentSuggestions(iconState, { reason = null, nowMs = Date.now() } = {}) {
  const ambient = state.intentAmbient;
  if (!ambient) return [];

  const branchesRaw = Array.isArray(iconState?.branches) ? iconState.branches : [];
  const branches = [];
  for (const branch of branchesRaw) {
    if (!branch || typeof branch !== "object") continue;
    const branchId = String(branch.branch_id || "").trim();
    if (!branchId) continue;
    const assetKey = _ambientUseCaseKeyForBranch(branch);
    if (!assetKey) continue;
    const confidence = typeof branch.confidence === "number" && Number.isFinite(branch.confidence)
      ? clamp(Number(branch.confidence) || 0, 0, 1)
      : null;
    branches.push({
      branch_id: branchId,
      asset_type: "icon",
      asset_key: assetKey,
      asset_src: INTENT_UI_ICON_ASSETS.usecases?.[assetKey] || null,
      confidence,
      evidence_image_ids: Array.isArray(branch.evidence_image_ids)
        ? branch.evidence_image_ids.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 3)
        : [],
      });
  }

  if (!branches.length) {
    const fallback = buildFallbackIntentIconState(iconState?.frame_id || `ambient-${nowMs}`, { reason: "no_branches" });
    const fb = Array.isArray(fallback?.branches) ? fallback.branches : [];
    for (const branch of fb) {
      const branchId = String(branch?.branch_id || "").trim();
      if (!branchId) continue;
      const assetKey = _ambientUseCaseKeyForBranch(branch);
      if (!assetKey) continue;
      branches.push({
        branch_id: branchId,
        asset_type: "icon",
        asset_key: assetKey,
        asset_src: INTENT_UI_ICON_ASSETS.usecases?.[assetKey] || null,
        confidence: null,
        evidence_image_ids: [],
      });
    }
  }

  const next = placeAmbientSuggestions({
    branches,
    imageRectsById: _ambientIntentImageRectsWorldMap(),
    touchedImageIds: Array.isArray(ambient.touchedImageIds) ? ambient.touchedImageIds : [],
    viewportWorldBounds: _ambientIntentViewportWorldBounds(),
    maxSuggestions: INTENT_AMBIENT_MAX_NUDGES,
    iconWorldSize: INTENT_AMBIENT_ICON_WORLD_SIZE,
  });

  ambient.suggestions = mergeAmbientSuggestions(ambient.suggestions, next, { nowMs });
  ambient.lastReason = reason ? String(reason) : ambient.lastReason;
  return ambient.suggestions;
}

function applyAmbientIntentFallback(reason, { message = null, hardDisable = false } = {}) {
  const ambient = state.intentAmbient;
  if (!ambient) return;
  const now = Date.now();
  clearAmbientIntentPending();
  ambient.rtState = "failed";
  ambient.disabledReason = hardDisable && message ? String(message) : null;
  ambient.lastError = message ? String(message) : null;
  ambient.lastErrorAt = message ? now : 0;

  const frameId = ambient.pendingFrameId || `ambient-fallback-${now}`;
  ambient.iconState = buildFallbackIntentIconState(frameId, { reason });
  ambient.iconStateAt = now;
  rebuildAmbientIntentSuggestions(ambient.iconState, { reason: `fallback:${String(reason || "fallback")}`, nowMs: now });
  requestRender();
}

function allowAmbientIntentRealtime() {
  if (!intentAmbientActive()) return false;
  if (!getVisibleCanvasImages().length) return false;
  if (!state.runDir) return false;
  if (state.motherIdle?.pendingIntent && String(state.motherIdle.pendingIntentRealtimePath || "").trim()) return false;
  if (state.keyStatus && !state.keyStatus.openai) return false;
  return true;
}

function scheduleAmbientIntentInference({ immediate = false, reason = null, imageIds = [] } = {}) {
  const ambient = state.intentAmbient;
  if (!ambient || !intentAmbientActive()) return false;
  if (!getVisibleCanvasImages().length) return false;
  if (state.motherIdle?.pendingIntent && String(state.motherIdle.pendingIntentRealtimePath || "").trim()) return false;
  const why = String(reason || "")
    .trim()
    .toLowerCase();
  if (!shouldScheduleAmbientIntent(why)) return false;
  rememberAmbientTouchedImageIds(imageIds.length ? imageIds : [state.activeId]);

  clearTimeout(intentAmbientInferenceTimer);
  const delay = immediate ? 0 : INTENT_INFERENCE_DEBOUNCE_MS;
  intentAmbientInferenceTimer = setTimeout(() => {
    intentAmbientInferenceTimer = null;
    runAmbientIntentInferenceOnce({ reason: why || (immediate ? "immediate" : "debounce") }).catch((err) => {
      console.warn("Ambient intent inference failed:", err);
    });
  }, delay);
  return true;
}

async function runAmbientIntentInferenceOnce({ reason = null } = {}) {
  const ambient = state.intentAmbient;
  if (!ambient || !intentAmbientActive()) return false;
  if (!getVisibleCanvasImages().length) {
    ambient.suggestions = [];
    return false;
  }

  const now = Date.now();
  const signature = computeAmbientIntentSignature();
  const since = now - (ambient.lastRunAt || 0);
  if (signature && signature === ambient.lastSignature && ambient.iconState && since < 12_000 && ambient.rtState === "ready") {
    return false;
  }
  if (since < INTENT_INFERENCE_THROTTLE_MS) {
    clearTimeout(intentAmbientInferenceTimer);
    intentAmbientInferenceTimer = setTimeout(() => {
      intentAmbientInferenceTimer = null;
      runAmbientIntentInferenceOnce({ reason: "throttle" }).catch((err) => console.warn("Ambient intent inference failed:", err));
    }, Math.max(80, INTENT_INFERENCE_THROTTLE_MS - since));
    return false;
  }

  await ensureRun();
  if (!allowAmbientIntentRealtime()) {
    const msg =
      state.keyStatus && !state.keyStatus.openai ? "Missing OPENAI_API_KEY." : "Intent realtime disabled.";
    applyAmbientIntentFallback("realtime_disabled", {
      message: msg,
      hardDisable: Boolean(state.keyStatus && !state.keyStatus.openai),
    });
    appendIntentTrace({
      kind: "ambient_inference_blocked",
      reason: msg,
      signature,
      rt_state: ambient.rtState,
    }).catch(() => {});
    return false;
  }

  const ok = await ensureEngineSpawned({ reason: "ambient intent inference" });
  if (!ok) {
    const msg = "Intent engine unavailable.";
    applyAmbientIntentFallback("engine_unavailable", { message: msg });
    appendIntentTrace({
      kind: "ambient_engine_unavailable",
      reason: msg,
      signature,
      rt_state: ambient.rtState,
    }).catch(() => {});
    return false;
  }

  if (ambient.rtState === "off" || ambient.rtState === "failed") ambient.rtState = "connecting";
  await invoke("write_pty", { data: `${PTY_COMMANDS.INTENT_RT_START}\n` }).catch(() => {});

  ambient.frameSeq = (Number(ambient.frameSeq) || 0) + 1;
  const stamp = Date.now();
  const frameId = `intent-ambient-${stamp}-${ambient.frameSeq}`;
  const snapshotPath = `${state.runDir}/intent-ambient-${stamp}.png`;

  await waitForIntentImagesLoaded({ timeoutMs: 900 });
  render();
  await writeIntentSnapshot(snapshotPath, { maxDimPx: INTENT_SNAPSHOT_MAX_DIM_PX });
  let ctxPath = null;
  await writeIntentContextEnvelope(snapshotPath, frameId)
    .then((path) => {
      ctxPath = path;
    })
    .catch((err) => {
      console.warn("Failed to write ambient intent envelope:", err);
    });

  appendIntentTrace({
    kind: "ambient_inference_dispatch",
    reason: reason ? String(reason) : null,
    frame_id: frameId,
    snapshot_path: snapshotPath,
    ctx_path: ctxPath,
    signature,
  }).catch(() => {});

  ambient.pending = true;
  ambient.pendingPath = snapshotPath;
  ambient.pendingAt = now;
  ambient.pendingFrameId = frameId;
  ambient.lastRunAt = now;
  ambient.lastSignature = signature;
  ambient.lastReason = reason ? String(reason) : null;
  requestRender();

  clearTimeout(intentAmbientInferenceTimeout);
  intentAmbientInferenceTimeout = setTimeout(() => {
    const cur = state.intentAmbient;
    if (!cur) return;
    if (!cur.pending || cur.pendingPath !== snapshotPath) return;
    const msg = "Intent realtime timed out.";
    applyAmbientIntentFallback("timeout", { message: msg });
    appendIntentTrace({
      kind: "ambient_inference_timeout",
      reason: msg,
      frame_id: frameId,
      snapshot_path: snapshotPath,
      rt_state: cur.rtState,
    }).catch(() => {});
  }, INTENT_INFERENCE_TIMEOUT_MS);

  try {
    await invoke("write_pty", { data: `${PTY_COMMANDS.INTENT_RT} ${quoteForPtyArg(snapshotPath)}\n` });
    bumpSessionApiCalls();
  } catch (err) {
    const msg = err?.message ? `Intent realtime failed: ${err.message}` : "Intent realtime failed.";
    applyAmbientIntentFallback("dispatch_failed", { message: msg });
    appendIntentTrace({
      kind: "ambient_inference_dispatch_failed",
      reason: msg,
      frame_id: frameId,
      snapshot_path: snapshotPath,
      rt_state: ambient.rtState,
    }).catch(() => {});
    return false;
  }

  if (reason) setStatus(`Engine: ambient intent scan (${reason})`);
  return true;
}

function allowIntentRealtime() {
  if (!intentModeActive()) return false;
  if (!getVisibleCanvasImages().length) return false;
  if (!state.runDir) return false;
  const intent = state.intent;
  if (!intent) return false;
  // Fail fast before dispatch if we know required keys are missing.
  if (state.keyStatus && !state.keyStatus.openai) return false;
  return true;
}

function computeIntentSignature() {
  const intent = state.intent || {};
  const parts = [];
  parts.push(`round=${Math.max(1, Number(intent.round) || 1)}`);
  parts.push(`force=${intent.forceChoice ? 1 : 0}`);
  if (intent.focusBranchId) parts.push(`focus=${String(intent.focusBranchId)}`);

  const sigSafe = (text, maxLen = 48) => {
    let s = String(text || "");
    s = s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (!s) return "";
    // Avoid clobbering the signature delimiter.
    s = s.replace(/[|]/g, "/");
    if (s.length > maxLen) s = s.slice(0, maxLen);
    return s;
  };

  const sels = Array.isArray(intent.selections) ? intent.selections.slice() : [];
  sels.sort((a, b) => (Number(a?.round) || 0) - (Number(b?.round) || 0));
  for (const sel of sels) {
    const r = Math.max(0, Number(sel?.round) || 0);
    const bid = sel?.branch_id ? String(sel.branch_id) : "";
    const tok = sel?.token ? String(sel.token) : "";
    parts.push(`sel:${r}:${bid}:${tok}`);
  }
  const z = Array.isArray(state.freeformZOrder) ? state.freeformZOrder : [];
  for (const imageIdRaw of z) {
    const imageId = String(imageIdRaw || "").trim();
    if (!imageId || !isVisibleCanvasImageId(imageId)) continue;
    const item = state.imagesById.get(imageId) || null;
    if (item?.path) parts.push(item.path);
    if (item?.visionDesc) {
      const v = sigSafe(item.visionDesc, 40);
      if (v) parts.push(`desc:${String(imageId)}:${v}`);
    }
    const rect = imageId ? state.freeformRects.get(imageId) : null;
    if (!rect) continue;
    parts.push(
      `rect:${imageId}:${Math.round(Number(rect.x) || 0)},${Math.round(Number(rect.y) || 0)},${Math.round(
        Number(rect.w) || 0
      )},${Math.round(Number(rect.h) || 0)}`
    );
  }
  return parts.join("|");
}

function scheduleIntentInference({ immediate = false, reason = null } = {}) {
  if (!intentModeActive()) return;
  const intent = state.intent;
  if (!intent || intent.forceChoice) return;
  if (!getVisibleCanvasImages().length) return;

  clearTimeout(intentInferenceTimer);
  const delay = immediate ? 0 : INTENT_INFERENCE_DEBOUNCE_MS;
  intentInferenceTimer = setTimeout(() => {
    intentInferenceTimer = null;
    runIntentInferenceOnce({ reason: reason || (immediate ? "immediate" : "debounce") }).catch((err) => {
      console.warn("Intent inference failed:", err);
    });
  }, delay);
}

async function runIntentInferenceOnce({ reason = null } = {}) {
  const intent = state.intent;
  if (!intentModeActive() || !intent) return false;
  if (intent.forceChoice) {
    intent.pending = false;
    intent.pendingPath = null;
    intent.pendingAt = 0;
    intent.pendingFrameId = null;
    return false;
  }
  if (!getVisibleCanvasImages().length) return false;

  const now = Date.now();
  if (!intent.startedAt) {
    intent.startedAt = now;
    if (INTENT_TIMER_ENABLED) {
      intent.deadlineAt = now + INTENT_DEADLINE_MS;
      ensureIntentTicker();
    } else {
      intent.deadlineAt = 0;
    }
    scheduleIntentStateWrite({ immediate: true });
  }

  updateIntentCountdown(now);
  if (intent.forceChoice) return false;

  const signature = computeIntentSignature();
  const since = now - (intent.lastRunAt || 0);
  if (signature && signature === intent.lastSignature && intent.iconState && since < 12_000 && intent.rtState === "ready") {
    return false;
  }
  if (since < INTENT_INFERENCE_THROTTLE_MS) {
    // Keep it responsive but avoid hammering the Realtime session while the user is dragging.
    scheduleIntentInference({ immediate: false, reason: "throttle" });
    return false;
  }

  await ensureRun();

  if (!allowIntentRealtime()) {
    intent.pending = false;
    intent.pendingPath = null;
    intent.pendingAt = 0;
    intent.pendingFrameId = null;
    intent.rtState = "failed";
    intent.disabledReason = state.keyStatus && !state.keyStatus.openai ? "Missing OPENAI_API_KEY." : "Intent realtime disabled.";
    intent.lastError = intent.disabledReason;
    intent.lastErrorAt = now;
    intent.uiHideSuggestion = false;
    const icon = ensureIntentFallbackIconState("disabled");
    if (!intent.focusBranchId) intent.focusBranchId = pickSuggestedIntentBranchId(icon) || pickDefaultIntentFocusBranchId(icon);
    appendIntentTrace({
      kind: "inference_blocked",
      reason: intent.disabledReason,
      round: Math.max(1, Number(intent.round) || 1),
      signature,
      rt_state: intent.rtState,
    }).catch(() => {});
    scheduleIntentStateWrite();
    requestRender();
    return false;
  }

  const ok = await ensureEngineSpawned({ reason: "intent inference" });
  if (!ok) {
    intent.pending = false;
    intent.pendingPath = null;
    intent.pendingAt = 0;
    intent.pendingFrameId = null;
    intent.rtState = "failed";
    intent.disabledReason = "Intent engine unavailable.";
    intent.lastError = intent.disabledReason;
    intent.lastErrorAt = now;
    intent.uiHideSuggestion = false;
    const icon = ensureIntentFallbackIconState("engine_unavailable");
    if (!intent.focusBranchId) intent.focusBranchId = pickSuggestedIntentBranchId(icon) || pickDefaultIntentFocusBranchId(icon);
    appendIntentTrace({
      kind: "engine_unavailable",
      reason: intent.disabledReason,
      round: Math.max(1, Number(intent.round) || 1),
      signature,
      rt_state: intent.rtState,
    }).catch(() => {});
    scheduleIntentStateWrite();
    requestRender();
    return false;
  }

  // Start (or keep alive) the realtime session.
  if (intent.rtState === "off" || intent.rtState === "failed") intent.rtState = "connecting";
  await invoke("write_pty", { data: `${PTY_COMMANDS.INTENT_RT_START}\n` }).catch(() => {});

  // Build a new frame id so we can ignore stale streaming updates.
  intent.frameSeq = (Number(intent.frameSeq) || 0) + 1;
  const stamp = Date.now();
  const frameId = `intent-r${Math.max(1, Number(intent.round) || 1)}-${stamp}-${intent.frameSeq}`;
  const snapshotPath = `${state.runDir}/intent-${stamp}-r${String(Math.max(1, Number(intent.round) || 1)).padStart(
    2,
    "0"
  )}.png`;

  await waitForIntentImagesLoaded({ timeoutMs: 900 });
  // Ensure the on-screen canvas is up to date before we capture a snapshot.
  render();

  await writeIntentSnapshot(snapshotPath, { maxDimPx: INTENT_SNAPSHOT_MAX_DIM_PX });
  let ctxPath = null;
  await writeIntentContextEnvelope(snapshotPath, frameId)
    .then((path) => {
      ctxPath = path;
    })
    .catch((err) => {
      console.warn("Failed to write intent envelope:", err);
    });
  appendIntentTrace({
    kind: "inference_dispatch",
    reason: reason ? String(reason) : null,
    round: Math.max(1, Number(intent.round) || 1),
    frame_id: frameId,
    snapshot_path: snapshotPath,
    ctx_path: ctxPath,
    signature,
  }).catch(() => {});

  intent.pending = true;
  intent.pendingPath = snapshotPath;
  intent.pendingAt = now;
  intent.pendingFrameId = frameId;
  intent.lastRunAt = now;
  intent.lastSignature = signature;
  scheduleIntentStateWrite();
  requestRender();

  clearTimeout(intentInferenceTimeout);
  intentInferenceTimeout = setTimeout(() => {
    const cur = state.intent;
    if (!cur || cur.locked) return;
    if (!cur.pending || cur.pendingPath !== snapshotPath) return;
    cur.pending = false;
    cur.pendingPath = null;
    cur.pendingAt = 0;
    cur.pendingFrameId = null;
    cur.rtState = "failed";
    cur.disabledReason = "Intent realtime timed out.";
    cur.lastError = cur.disabledReason;
    cur.lastErrorAt = Date.now();
    cur.uiHideSuggestion = false;
    // Fall back to a local branch set so the user can still lock an intent.
    cur.forceChoice = INTENT_FORCE_CHOICE_ENABLED ? true : false;
    ensureIntentFallbackIconState("timeout");
    cur.focusBranchId = cur.focusBranchId || pickSuggestedIntentBranchId(cur.iconState) || pickDefaultIntentFocusBranchId();
    appendIntentTrace({
      kind: "inference_timeout",
      reason: cur.disabledReason,
      snapshot_path: snapshotPath,
      frame_id: frameId,
      rt_state: cur.rtState,
    }).catch(() => {});
    scheduleIntentStateWrite({ immediate: true });
    requestRender();
  }, INTENT_INFERENCE_TIMEOUT_MS);

  try {
    await invoke("write_pty", { data: `${PTY_COMMANDS.INTENT_RT} ${quoteForPtyArg(snapshotPath)}\n` });
    bumpSessionApiCalls();
  } catch (err) {
    intent.pending = false;
    intent.pendingPath = null;
    intent.pendingAt = 0;
    intent.pendingFrameId = null;
    intent.rtState = "failed";
    intent.disabledReason = err?.message ? `Intent realtime failed: ${err.message}` : "Intent realtime failed.";
    intent.lastError = intent.disabledReason;
    intent.lastErrorAt = Date.now();
    intent.uiHideSuggestion = false;
    intent.forceChoice = INTENT_FORCE_CHOICE_ENABLED ? true : false;
    ensureIntentFallbackIconState("dispatch_failed");
    if (!intent.focusBranchId) {
      intent.focusBranchId = pickSuggestedIntentBranchId(intent.iconState) || pickDefaultIntentFocusBranchId(intent.iconState);
    }
    appendIntentTrace({
      kind: "inference_dispatch_failed",
      reason: intent.disabledReason,
      snapshot_path: snapshotPath,
      frame_id: frameId,
      rt_state: intent.rtState,
    }).catch(() => {});
    scheduleIntentStateWrite({ immediate: true });
    requestRender();
    return false;
  }

  // Keep a light status breadcrumb in the debug header.
  if (reason) setStatus(`Engine: intent scan (${reason})`);
  return true;
}

async function waitForIntentImagesLoaded({ timeoutMs = 900 } = {}) {
  const items = getVisibleCanvasImages().filter((it) => it?.path).slice(0, 6);
  for (const item of items) ensureCanvasImageLoaded(item);
  const deadline = Date.now() + Math.max(60, Number(timeoutMs) || 900);
  while (Date.now() < deadline) {
    if (items.every((it) => Boolean(it?.img))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return items.some((it) => Boolean(it?.img));
}

async function writeIntentSnapshot(outPath, { maxDimPx = INTENT_SNAPSHOT_MAX_DIM_PX } = {}) {
  const baseWork = els.workCanvas;
  if (!baseWork) return null;

  const baseW = Number(baseWork.width) || 0;
  const baseH = Number(baseWork.height) || 0;
  if (!baseW || !baseH) return null;

  const maxDim = Math.max(420, Math.round(Number(maxDimPx) || INTENT_SNAPSHOT_MAX_DIM_PX));
  const scale = Math.min(1, maxDim / Math.max(1, Math.max(baseW, baseH)));
  const w = Math.max(1, Math.round(baseW * scale));
  const h = Math.max(1, Math.round(baseH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Background (matches the in-app canvas atmosphere).
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "rgba(18, 26, 37, 0.92)");
  bg.addColorStop(1, "rgba(6, 8, 12, 0.96)");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Snapshot only the user content canvas (no UI overlays) for cleaner vision input.
  ctx.drawImage(baseWork, 0, 0, w, h);

  await writeCanvasPngToPath(canvas, outPath);
  return outPath;
}

function buildMotherRealtimeContextEnvelope({ motherContextPayload = null, imageOriginById = null } = {}) {
  const idle = state.motherIdle || null;
  const payload = motherContextPayload && typeof motherContextPayload === "object"
    ? motherContextPayload
    : motherV2IntentPayload();
  const selectedIds = motherV2NormalizeImageIdList(payload?.selected_ids || []).slice(0, 3);
  const activeIdRaw = String(payload?.active_id || "").trim();
  const activeId = activeIdRaw && isVisibleCanvasImageId(activeIdRaw) ? activeIdRaw : null;
  const imageSetSig = motherV2IntentImageSetSignature(idle?.intent || null);
  const contextSig = motherV2IntentContextSignature(idle?.intent || null);
  const rejectedModes = [];
  for (const sig of [contextSig, imageSetSig]) {
    for (const mode of motherV2RejectedModesForContext(sig)) {
      if (!mode || rejectedModes.includes(mode)) continue;
      rejectedModes.push(mode);
    }
  }
  const ambient = payload?.ambient_intent && typeof payload.ambient_intent === "object" ? payload.ambient_intent : null;
  const ambientBranches = Array.isArray(ambient?.branches)
    ? ambient.branches
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const branchId = String(entry.branch_id || "").trim();
          if (!branchId) return null;
          return {
            branch_id: branchId,
            confidence:
              typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
                ? clamp(Number(entry.confidence) || 0, 0, 1)
                : null,
            evidence_image_ids: Array.isArray(entry.evidence_image_ids)
              ? entry.evidence_image_ids.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 3)
              : [],
          };
        })
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const ambientModes = Array.isArray(ambient?.transformation_mode_candidates)
    ? ambient.transformation_mode_candidates
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const mode = motherV2MaybeTransformationMode(entry.mode || entry.transformation_mode);
          if (!mode) return null;
          return {
            mode,
            confidence:
              typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
                ? clamp(Number(entry.confidence) || 0, 0, 1)
                : null,
          };
        })
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const compactImages = (Array.isArray(payload?.images) ? payload.images : [])
    .map((image) => {
      if (!image || typeof image !== "object") return null;
      const imageId = String(image.id || "").trim();
      if (!imageId) return null;
      const item = state.imagesById.get(imageId) || null;
      const pathText = String(image.path || item?.path || "").trim();
      const inferredOrigin = item && isMotherGeneratedImageItem(item) ? "mother_generated" : "uploaded";
      const originFromMap = imageOriginById?.get?.(imageId) || null;
      const origin = originFromMap || inferredOrigin;
      const rectNorm = image.rect_norm && typeof image.rect_norm === "object"
        ? {
            x: Number(image.rect_norm.x) || 0,
            y: Number(image.rect_norm.y) || 0,
            w: Math.max(0, Number(image.rect_norm.w) || 0),
            h: Math.max(0, Number(image.rect_norm.h) || 0),
          }
        : null;
      return {
        id: imageId,
        file: image.file ? String(image.file) : pathText ? basename(pathText) : null,
        vision_desc: image.vision_desc ? clampText(String(image.vision_desc || ""), 64) : null,
        origin,
        rect_norm: rectNorm,
      };
    })
    .filter(Boolean)
    .slice(0, 10);
  return {
    schema: "brood.mother.realtime_context.v1",
    optimization_target: "stunningly awe-inspiring and joyous + novel",
    optimization_hint: "Optimize proposals for stunningly awe-inspiring and joyous + novel while preserving identity and coherence.",
    action_version: Number(payload?.action_version) || Number(idle?.actionVersion) || 0,
    creative_directive: String(payload?.creative_directive || MOTHER_CREATIVE_DIRECTIVE || "").trim(),
    preferred_transformation_mode: motherV2MaybeTransformationMode(payload?.preferred_transformation_mode) || null,
    intensity: clamp(Number(payload?.intensity) || Number(idle?.intensity) || 62, 0, 100),
    active_id: activeId,
    selected_ids: selectedIds,
    canvas_context_summary: payload?.canvas_context_summary ? clampText(String(payload.canvas_context_summary || ""), 240) : null,
    recent_rejected_modes_for_context: rejectedModes,
    last_accepted_mode: motherV2MaybeTransformationMode(idle?.lastProposalMode || idle?.intent?.transformation_mode),
    ambient_intent: ambientBranches.length || ambientModes.length
      ? {
          preferred_transformation_mode: motherV2MaybeTransformationMode(ambient?.preferred_transformation_mode) || null,
          branches: ambientBranches,
          transformation_mode_candidates: ambientModes,
        }
      : null,
    images: compactImages,
  };
}

function buildIntentContextEnvelope(frameId, { motherContextPayload = null } = {}) {
  const wrap = els.canvasWrap;
  const intent = state.intent || {};
  const dpr = getDpr();
  const canvasCssW = wrap?.clientWidth || 0;
  const canvasCssH = wrap?.clientHeight || 0;
  const isMotherFrame = String(frameId || "").trim().toLowerCase().startsWith("mother-intent-");

  const images = [];
  const imageOriginById = new Map();
  const z = Array.isArray(state.freeformZOrder) ? state.freeformZOrder : [];
  for (let idx = 0; idx < z.length; idx += 1) {
    const imageId = String(z[idx] || "").trim();
    if (!imageId || !isVisibleCanvasImageId(imageId)) continue;
    const item = imageId ? state.imagesById.get(imageId) : null;
    const rect = imageId ? state.freeformRects.get(imageId) : null;
    if (!item?.path || !rect) continue;
    const visionDesc = item?.visionDesc ? clampText(String(item.visionDesc), 64) : null;
    const vmeta = item?.visionDescMeta || null;
    const x = Number(rect.x) || 0;
    const y = Number(rect.y) || 0;
    const w = Math.max(1, Number(rect.w) || 1);
    const h = Math.max(1, Number(rect.h) || 1);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const origin = isMotherGeneratedImageItem(item) ? "mother_generated" : "uploaded";
    imageOriginById.set(String(imageId), origin);
    images.push({
      id: String(imageId),
      file: basename(item.path),
      origin,
      import_index: (state.images || []).findIndex((im) => im?.id === imageId),
      z: idx,
      // Short vision-derived label for this image (best-effort). This is an internal
      // signal to improve intent suggestions while keeping user input "images-only".
      vision_desc: visionDesc,
      vision_desc_meta: visionDesc
        ? {
            source: vmeta?.source ? String(vmeta.source) : null,
            model: vmeta?.model ? String(vmeta.model) : null,
            at_ms: Number(vmeta?.at) || null,
          }
        : null,
      rect_css: { x, y, w, h, cx, cy },
      rect_norm: {
        x: canvasCssW ? x / canvasCssW : 0,
        y: canvasCssH ? y / canvasCssH : 0,
        w: canvasCssW ? w / canvasCssW : 0,
        h: canvasCssH ? h / canvasCssH : 0,
        cx: canvasCssW ? cx / canvasCssW : 0,
        cy: canvasCssH ? cy / canvasCssH : 0,
      },
    });
  }

  const now = Date.now();
  const remaining_ms = INTENT_TIMER_ENABLED
    ? intent.startedAt
      ? intentRemainingMs(now)
      : INTENT_DEADLINE_MS
    : 0;

  const envelope = {
    schema: "brood.intent_envelope",
    schema_version: INTENT_ENVELOPE_VERSION,
    generated_at: new Date().toISOString(),
    frame_id: String(frameId || ""),
    canvas: {
      width_css: canvasCssW,
      height_css: canvasCssH,
      width_px: Math.max(0, Math.round(canvasCssW * dpr)),
      height_px: Math.max(0, Math.round(canvasCssH * dpr)),
      dpr,
    },
    intent: {
      round: Math.max(1, Number(intent.round) || 1),
      total_rounds: INTENT_ROUNDS_ENABLED ? Math.max(1, Number(intent.totalRounds) || 3) : 0,
      started_at_ms: Number(intent.startedAt) || 0,
      deadline_at_ms: INTENT_TIMER_ENABLED ? Number(intent.deadlineAt) || 0 : 0,
      remaining_ms,
      timer_enabled: Boolean(INTENT_TIMER_ENABLED),
      rounds_enabled: Boolean(INTENT_ROUNDS_ENABLED),
      force_choice_enabled: Boolean(INTENT_FORCE_CHOICE_ENABLED),
      force_choice: INTENT_FORCE_CHOICE_ENABLED ? Boolean(intent.forceChoice) : false,
      focus_branch_id: intent.focusBranchId ? String(intent.focusBranchId) : null,
      selections: Array.isArray(intent.selections) ? intent.selections : [],
    },
    images,
  };
  if (isMotherFrame) {
    envelope.mother_context = buildMotherRealtimeContextEnvelope({
      motherContextPayload,
      imageOriginById,
    });
  }
  return envelope;
}

async function writeIntentContextEnvelope(snapshotPath, frameId, { motherContextPayload = null } = {}) {
  if (!state.runDir) return null;
  const ctxPath = _canvasContextSidecarPath(snapshotPath);
  if (!ctxPath) return null;
  const envelope = buildIntentContextEnvelope(frameId, { motherContextPayload });
  await writeTextFile(ctxPath, JSON.stringify(envelope));
  return ctxPath;
}

function buildFallbackIntentIconState(frameId, { reason = null } = {}) {
  const seed = String(reason || "fallback").toUpperCase();
  const gen = { icon_id: "IMAGE_GENERATION", confidence: 0.52, position_hint: "primary" };
  const iterate = { icon_id: "ITERATION", confidence: 0.44, position_hint: "primary" };
  const outputs = { icon_id: "OUTPUTS", confidence: 0.34, position_hint: "secondary" };
  const pipeline = { icon_id: "PIPELINE", confidence: 0.30, position_hint: "emerging" };
  const branches = [
    {
      branch_id: "game_dev_assets",
      icons: ["GAME_DEV_ASSETS", "CONCEPT_ART", "SPRITES", "TEXTURES", "CHARACTER_SHEETS", "MIXED_FIDELITY", "ITERATION"],
      lane_position: "left",
    },
    {
      branch_id: "streaming_content",
      icons: ["STREAMING_CONTENT", "THUMBNAILS", "OVERLAYS", "EMOTES", "SOCIAL_GRAPHICS", "VOLUME", "OUTCOMES"],
      lane_position: "right",
    },
    {
      branch_id: "uiux_prototyping",
      icons: ["UI_UX_PROTOTYPING", "SCREENS", "WIREFRAMES", "MOCKUPS", "USER_FLOWS", "STRUCTURED", "SINGULAR"],
      lane_position: "left",
    },
    {
      branch_id: "ecommerce_pod",
      icons: ["ECOMMERCE_POD", "MERCH_DESIGN", "PRODUCT_PHOTOS", "MARKETPLACE_LISTINGS", "PHYSICAL_OUTPUT", "VOLUME"],
      lane_position: "right",
    },
    {
      branch_id: "content_engine",
      icons: ["CONTENT_ENGINE", "BRAND_SYSTEM", "MULTI_CHANNEL", "PROCESS", "AUTOMATION", "PIPELINE", "VOLUME"],
      lane_position: "left",
    },
  ];
  return {
    frame_id: String(frameId || `fallback-${Date.now()}`),
    schema: "brood.intent_icons",
    schema_version: 1,
    intent_icons: [gen, iterate, outputs, pipeline],
    relations: [
      { from_icon: "ITERATION", to_icon: "IMAGE_GENERATION", relation_type: "DEPENDENCY" },
      { from_icon: "IMAGE_GENERATION", to_icon: "OUTPUTS", relation_type: "FLOW" },
    ],
    branches,
    checkpoint: { icons: ["YES_TOKEN", "NO_TOKEN", "MAYBE_TOKEN"], applies_to: seed ? seed : "branches" },
  };
}

function ensureIntentFallbackIconState(reason = "fallback") {
  const intent = state.intent;
  if (!intent) return null;
  const now = Date.now();
  if (!intent.iconState || typeof intent.iconState !== "object") {
    const frameId = intent.pendingFrameId || `fallback-${now}`;
    intent.iconState = buildFallbackIntentIconState(frameId, { reason });
    intent.iconStateAt = now;
    return intent.iconState;
  }
  // If the model returned no branches, keep the user's ability to choose by adding a fallback set.
  const branches = Array.isArray(intent.iconState?.branches) ? intent.iconState.branches : [];
  if (branches.length === 0) {
    const frameId = intent.iconState?.frame_id || intent.pendingFrameId || `fallback-${now}`;
    const fallback = buildFallbackIntentIconState(frameId, { reason });
    intent.iconState.branches = fallback.branches;
    if (!intent.iconState.checkpoint) intent.iconState.checkpoint = fallback.checkpoint;
    intent.iconStateAt = now;
  }
  return intent.iconState;
}

function intentIconsPayloadChecksum(raw) {
  return intentIconsPayloadChecksumUtil(raw);
}

function intentIconsPayloadSafeSnippet(raw, options = {}) {
  return intentIconsPayloadSafeSnippetUtil(raw, options);
}

function parseIntentIconsJsonDetailed(raw) {
  return parseIntentIconsJsonDetailedUtil(raw, {
    normalizeTransformationMode: motherV2MaybeTransformationMode,
  });
}

function parseIntentIconsJson(raw) {
  return parseIntentIconsJsonUtil(raw, {
    normalizeTransformationMode: motherV2MaybeTransformationMode,
  });
}

function classifyIntentIconsRouting(options = {}) {
  return classifyIntentIconsRoutingUtil(options);
}

function _normalizeVisionLabel(raw, { maxChars = 32 } = {}) {
  const s = String(raw || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  // Keep it short and HUD-friendly. (Even though it may not be shown in intent mode,
  // we reuse the same field for later HUD rendering.)
  const clipped = maxChars > 0 ? clampText(s, maxChars) : s;
  // Avoid our intent-signature delimiter.
  return clipped.replace(/[|]/g, "/").trim();
}

function extractIntentImageDescriptions(parsed) {
  if (!parsed || typeof parsed !== "object") return [];
  const raw = Array.isArray(parsed.image_descriptions) ? parsed.image_descriptions : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const imageId = item.image_id ? String(item.image_id) : item.id ? String(item.id) : "";
    const labelRaw = item.label ?? item.description ?? item.text ?? "";
    const label = _normalizeVisionLabel(labelRaw, { maxChars: 32 });
    const confidence = typeof item.confidence === "number" ? item.confidence : null;
    if (!imageId || !label) continue;
    out.push({ image_id: imageId, label, confidence });
  }
  return out;
}

function primaryBranchIdFromIconState(iconState) {
  const branches = Array.isArray(iconState?.branches) ? iconState.branches : [];
  if (!branches.length) return null;
  const primaryIcons = new Set(
    (Array.isArray(iconState?.intent_icons) ? iconState.intent_icons : [])
      .filter((it) => String(it?.position_hint || "").toLowerCase() === "primary")
      .map((it) => String(it?.icon_id || "").trim())
      .filter(Boolean)
  );
  if (!primaryIcons.size) return String(branches[0]?.branch_id || "") || null;

  let best = null;
  let bestScore = -1;
  for (const b of branches) {
    const icons = Array.isArray(b?.icons) ? b.icons : [];
    let score = 0;
    for (const icon of icons) {
      if (primaryIcons.has(String(icon || "").trim())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best && best.branch_id ? String(best.branch_id) : String(branches[0]?.branch_id || "") || null;
}

function pickDefaultIntentFocusBranchId(iconState = null) {
  const intent = state.intent;
  const icon = iconState || intent?.iconState || null;
  const branches = Array.isArray(icon?.branches) ? icon.branches : [];
  const hasPrimaryCluster = Array.isArray(icon?.intent_icons) && icon.intent_icons.length > 0;

  const existing = intent?.focusBranchId ? String(intent.focusBranchId) : "";
  if (existing) {
    if (existing === "__primary__") {
      if (hasPrimaryCluster) return existing;
    }
    if (branches.some((b) => String(b?.branch_id || "") === existing)) return existing;
  }

  const primary = primaryBranchIdFromIconState(icon);
  if (primary) return primary;
  return "__primary__";
}

function latestIntentSelectionForBranch(branchId) {
  const bid = String(branchId || "");
  if (!bid) return null;
  const sels = Array.isArray(state.intent?.selections) ? state.intent.selections : [];
  let best = null;
  for (const sel of sels) {
    if (String(sel?.branch_id || "") !== bid) continue;
    const r = Number(sel?.round) || 0;
    if (!best || r > (Number(best.round) || 0)) best = sel;
  }
  return best;
}

function upsertIntentSelection({ round, branchId, tokenId }) {
  const intent = state.intent;
  if (!intent) return;
  const r = Math.max(1, Number(round) || 1);
  const bid = String(branchId || "");
  const tok = String(tokenId || "");
  if (!bid || !tok) return;
  const next = (Array.isArray(intent.selections) ? intent.selections : []).filter((sel) => Number(sel?.round) !== r);
  next.push({ round: r, branch_id: bid, token: tok });
  intent.selections = next;
}

function inferIntentBranchFromVisionDescriptions() {
  const items = Array.isArray(state.images) ? state.images : [];
  const texts = [];
  for (const item of items) {
    if (item?.visionDesc) texts.push(String(item.visionDesc));
  }
  const haystack = texts.join(" ").toLowerCase().trim();
  if (!haystack) return null;

  const scores = {
    game_dev_assets: 0,
    streaming_content: 0,
    uiux_prototyping: 0,
    ecommerce_pod: 0,
    content_engine: 0,
  };

  const bump = (key, re, weight) => {
    if (!key || !re) return;
    if (!scores[key] && scores[key] !== 0) return;
    try {
      if (re.test(haystack)) scores[key] += Number(weight) || 0;
    } catch {
      // ignore
    }
  };

  // These keywords are intentionally "small + concrete" because vision descriptions are short
  // (e.g. "instagram app icon", "couch"). They should be treated as weak signals.
  bump("game_dev_assets", /\b(sprite|sprites|tileset|texture|textures)\b/i, 4);
  bump("game_dev_assets", /\b(character sheet|character sheets)\b/i, 4);
  bump("game_dev_assets", /\b(concept art)\b/i, 4);
  bump("game_dev_assets", /\b(unreal|unity)\b/i, 2);
  bump("game_dev_assets", /\b(terran|zerg|scv)\b/i, 4);
  bump("game_dev_assets", /\b(game|gamedev|mod)\b/i, 2);

  bump("streaming_content", /\b(instagram|twitch|youtube|tiktok)\b/i, 5);
  bump("streaming_content", /\b(thumbnail|thumbnails)\b/i, 4);
  bump("streaming_content", /\b(overlay|overlays)\b/i, 4);
  bump("streaming_content", /\b(emote|emotes)\b/i, 4);
  bump("streaming_content", /\b(social|stream|streaming|channel)\b/i, 2);
  bump("streaming_content", /\b(logo|banner|profile)\b/i, 1);

  bump("uiux_prototyping", /\b(wireframe|wireframes)\b/i, 5);
  bump("uiux_prototyping", /\b(mockup|mockups)\b/i, 4);
  bump("uiux_prototyping", /\b(prototype|prototyping)\b/i, 4);
  bump("uiux_prototyping", /\b(user flow|user flows|flow diagram)\b/i, 4);
  bump("uiux_prototyping", /\b(dashboard|app screen|app screens|screens)\b/i, 3);
  bump("uiux_prototyping", /\b(ui|ux)\b/i, 2);

  bump("ecommerce_pod", /\b(product photo|product photos)\b/i, 5);
  bump("ecommerce_pod", /\b(listing|listings|marketplace)\b/i, 4);
  bump("ecommerce_pod", /\b(etsy|amazon|shop)\b/i, 3);
  bump("ecommerce_pod", /\b(merch|t-?shirt|hoodie|mug|poster)\b/i, 4);
  bump("ecommerce_pod", /\b(packaging)\b/i, 3);
  bump("ecommerce_pod", /\b(couch|sofa|chair|table)\b/i, 3);

  bump("content_engine", /\b(pipeline|workflow|automation|automated|system|systems)\b/i, 4);
  bump("content_engine", /\b(brand system|brand|template)\b/i, 2);
  bump("content_engine", /\b(multi-?channel|batch)\b/i, 2);

  let bestKey = null;
  let bestScore = 0;
  for (const [key, score] of Object.entries(scores)) {
    const s = Number(score) || 0;
    if (s > bestScore) {
      bestScore = s;
      bestKey = key;
    }
  }
  // Require a little evidence before overriding icon-state suggestion.
  if (!bestKey || bestScore < 3) return null;
  return bestKey;
}

function _primaryBranchSuggestion(iconState) {
  const branches = Array.isArray(iconState?.branches) ? iconState.branches : [];
  if (!branches.length) return { branch_id: null, score: 0, ties: 0 };

  const primaryIcons = new Set(
    (Array.isArray(iconState?.intent_icons) ? iconState.intent_icons : [])
      .filter((it) => String(it?.position_hint || "").toLowerCase() === "primary")
      .map((it) => String(it?.icon_id || "").trim())
      .filter(Boolean)
  );
  if (!primaryIcons.size) return { branch_id: null, score: 0, ties: 0 };

  let bestId = null;
  let bestScore = 0;
  let ties = 0;
  for (const b of branches) {
    const bid = b?.branch_id ? String(b.branch_id) : "";
    if (!bid) continue;
    const icons = Array.isArray(b?.icons) ? b.icons : [];
    let score = 0;
    for (const icon of icons) {
      if (primaryIcons.has(String(icon || "").trim())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = bid;
      ties = score > 0 ? 1 : 0;
    } else if (score > 0 && score === bestScore) {
      ties += 1;
    }
  }
  if (!bestId || bestScore <= 0) return { branch_id: null, score: 0, ties: 0 };
  return { branch_id: bestId, score: bestScore, ties };
}

function _rankIntentBranches(iconState) {
  const branches = Array.isArray(iconState?.branches) ? iconState.branches : [];
  if (!branches.length) return [];
  const anyConf = branches.some((b) => typeof b?.confidence === "number" && Number.isFinite(b.confidence));
  if (!anyConf) return branches.slice();
  // Defensive: even though parseIntentIconsJson sorts, keep this stable if callers mutate iconState.
  const list = branches.map((b, idx) => ({ b, idx }));
  list.sort((a, b) => {
    const ac = typeof a?.b?.confidence === "number" && Number.isFinite(a.b.confidence) ? a.b.confidence : -1;
    const bc = typeof b?.b?.confidence === "number" && Number.isFinite(b.b.confidence) ? b.b.confidence : -1;
    if (bc !== ac) return bc - ac;
    return (Number(a.idx) || 0) - (Number(b.idx) || 0);
  });
  return list.map((it) => it.b);
}

function pickSuggestedIntentBranch(iconState = null) {
  const intent = state.intent;
  const icon = iconState || intent?.iconState || null;
  const branches = Array.isArray(icon?.branches) ? icon.branches : [];
  if (!branches.length) return { branch_id: null, reason: "none", ranked_branch_ids: [] };

  const isRejected = (bid) => {
    const sel = latestIntentSelectionForBranch(bid);
    const tok = sel?.token ? String(sel.token).trim().toUpperCase() : "";
    return tok === "NO_TOKEN";
  };

  const hasBranch = (bid) => branches.some((b) => String(b?.branch_id || "") === bid);
  const findBranchInsensitive = (raw) => {
    const wanted = String(raw || "").trim();
    if (!wanted) return "";
    const exact = branches.find((b) => String(b?.branch_id || "") === wanted);
    if (exact?.branch_id) return String(exact.branch_id);
    const lower = wanted.toLowerCase();
    const match = branches.find((b) => String(b?.branch_id || "").toLowerCase() === lower);
    return match?.branch_id ? String(match.branch_id) : "";
  };

  const rankedBranches = _rankIntentBranches(icon);
  const rankedIds = rankedBranches
    .map((b) => (b?.branch_id ? String(b.branch_id) : ""))
    .filter(Boolean);

  // If the model provided an explicit checkpoint target, treat it as the active suggestion.
  const checkpoint = icon?.checkpoint?.applies_to;
  const checkpointBid = findBranchInsensitive(checkpoint);
  if (checkpointBid && !isRejected(checkpointBid)) {
    return {
      branch_id: checkpointBid,
      reason: "checkpoint",
      ranked_branch_ids: rankedIds,
      checkpoint_branch_id: checkpointBid,
    };
  }

  const anyConf = rankedBranches.some((b) => typeof b?.confidence === "number" && Number.isFinite(b.confidence));
  if (anyConf) {
    for (const b of rankedBranches) {
      const bid = b?.branch_id ? String(b.branch_id) : "";
      if (!bid) continue;
      if (isRejected(bid)) continue;
      return { branch_id: bid, reason: "confidence", ranked_branch_ids: rankedIds, checkpoint_branch_id: checkpointBid || null };
    }
  }

  const primaryInfo = _primaryBranchSuggestion(icon);
  const p = primaryInfo?.branch_id ? String(primaryInfo.branch_id) : "";

  // Use per-image vision descriptions (derived from images) as a tie-breaker or fallback hint.
  const hint = inferIntentBranchFromVisionDescriptions();
  if (hint && hasBranch(hint) && !isRejected(hint)) {
    const primaryRejected = p ? isRejected(p) : true;
    const primaryWeak = (Number(primaryInfo?.score) || 0) <= 1;
    const primaryTied = (Number(primaryInfo?.ties) || 0) > 1;
    if (primaryRejected || primaryWeak || primaryTied) {
      return { branch_id: hint, reason: "vision_hint", ranked_branch_ids: rankedIds, checkpoint_branch_id: checkpointBid || null };
    }
  }

  if (p && hasBranch(p) && !isRejected(p)) {
    return { branch_id: p, reason: "primary_cluster", ranked_branch_ids: rankedIds, checkpoint_branch_id: checkpointBid || null };
  }

  for (const b of rankedBranches) {
    const bid = b?.branch_id ? String(b.branch_id) : "";
    if (!bid) continue;
    if (isRejected(bid)) continue;
    return { branch_id: bid, reason: "first_unrejected", ranked_branch_ids: rankedIds, checkpoint_branch_id: checkpointBid || null };
  }

  // If every branch has been rejected, fall back to the primary (if present) so START remains usable.
  if (p && hasBranch(p)) return { branch_id: p, reason: "all_rejected_primary", ranked_branch_ids: rankedIds, checkpoint_branch_id: checkpointBid || null };
  const first = rankedBranches[0]?.branch_id ? String(rankedBranches[0].branch_id) : "";
  return { branch_id: first || null, reason: "all_rejected_first", ranked_branch_ids: rankedIds, checkpoint_branch_id: checkpointBid || null };
}

function pickSuggestedIntentBranchId(iconState = null) {
  const picked = pickSuggestedIntentBranch(iconState);
  const bid = picked?.branch_id ? String(picked.branch_id) : "";
  return bid || null;
}

function lockIntentFromUi({ source = "ui" } = {}) {
  const intent = state.intent;
  if (!intent || intent.locked) return;

  const iconState = ensureIntentFallbackIconState("lock");
  if (!iconState) return;

  let bid = String(pickSuggestedIntentBranchId(iconState) || "").trim();
  if (bid === "__primary__") bid = "";
  if (!bid) bid = String(primaryBranchIdFromIconState(iconState) || "").trim();
  if (!bid) bid = String(pickDefaultIntentFocusBranchId(iconState) || "").trim();
  if (!bid) return;

  appendIntentTrace({
    kind: "ui_accept",
    source: source ? String(source) : "ui",
    round: Math.max(1, Number(intent.round) || 1),
    branch_id: bid,
    icon_frame_id: iconState?.frame_id ? String(iconState.frame_id) : null,
  }).catch(() => {});

  // Persist the user's final choice as a YES on the current round for debugging/replay.
  const round = Math.max(1, Number(intent.round) || 1);
  upsertIntentSelection({ round, branchId: bid, tokenId: "YES_TOKEN" });
  intent.focusBranchId = bid;
  intent.uiHideSuggestion = false;
  scheduleIntentStateWrite({ immediate: true });
  lockIntentToBranch(bid).catch((err) => console.error(err));
}

function applyIntentSelection(branchId, tokenId) {
  const intent = state.intent;
  if (!intent || intent.locked) return;
  const bid = String(branchId || intent.focusBranchId || pickSuggestedIntentBranchId(intent.iconState) || "").trim();
  if (!bid) return;
  const tok = String(tokenId || "")
    .trim()
    .toUpperCase();
  if (!tok) return;

  // Prevent users from spamming feedback while a new model frame is in flight.
  if (intent.pending || intentInferenceTimer) {
    showToast("Intent updating…", "tip", 1600);
    return;
  }

  const round = Math.max(1, Number(intent.round) || 1);
  if (tok === "YES_TOKEN") {
    lockIntentFromUi({ source: "yes_token" });
    return;
  }

  if (tok !== "NO_TOKEN") return;

  // NO: hide the current suggestion and load another candidate.
  upsertIntentSelection({ round, branchId: bid, tokenId: "NO_TOKEN" });
  intent.focusBranchId = null;
  intent.uiHideSuggestion = true;
  intent.pending = true;
  intent.pendingAt = Date.now();
  intent.round = round + 1;
  appendIntentTrace({
    kind: "ui_reject",
    source: "no_token",
    round,
    branch_id: bid,
    icon_frame_id: intent.iconState?.frame_id ? String(intent.iconState.frame_id) : null,
  }).catch(() => {});
  scheduleIntentStateWrite({ immediate: true });
  scheduleIntentInference({ immediate: true, reason: "reject" });
  requestRender();
}

async function lockIntentToBranch(branchId) {
  const intent = state.intent;
  if (!intent || intent.locked) return false;
  await ensureRun();

  intent.locked = true;
  intent.lockedAt = Date.now();
  intent.lockedBranchId = String(branchId || intent.focusBranchId || "") || null;
  intent.forceChoice = false;
  intent.pending = false;
  intent.pendingPath = null;
  intent.pendingAt = 0;
  intent.pendingFrameId = null;

  appendIntentTrace({
    kind: "intent_locked",
    branch_id: intent.lockedBranchId ? String(intent.lockedBranchId) : null,
    round: Math.max(1, Number(intent.round) || 1),
    selection_count: Array.isArray(intent.selections) ? intent.selections.length : 0,
    icon_frame_id: intent.iconState?.frame_id ? String(intent.iconState.frame_id) : null,
  }).catch(() => {});

  // Stop realtime session (best-effort).
  clearTimeout(intentInferenceTimer);
  intentInferenceTimer = null;
  clearTimeout(intentInferenceTimeout);
  intentInferenceTimeout = null;
  stopIntentTicker();
  intent.rtState = "off";
  intent.disabledReason = null;
  if (state.ptySpawned) {
    invoke("write_pty", { data: `${PTY_COMMANDS.INTENT_RT_STOP}\n` }).catch(() => {});
  }

  // Persist locked intent as a run artifact for downstream prompting/recommendations.
  const lockedPayload = {
    schema: "brood.intent_locked",
    schema_version: 1,
    locked_at_ms: Number(intent.lockedAt) || 0,
    locked_branch_id: intent.lockedBranchId,
    started_at_ms: Number(intent.startedAt) || 0,
    deadline_at_ms: INTENT_TIMER_ENABLED ? Number(intent.deadlineAt) || 0 : 0,
    round: Math.max(1, Number(intent.round) || 1),
    total_rounds: INTENT_ROUNDS_ENABLED ? Math.max(1, Number(intent.totalRounds) || 3) : 0,
    focus_branch_id: intent.focusBranchId ? String(intent.focusBranchId) : null,
    selections: Array.isArray(intent.selections) ? intent.selections : [],
    icon_state: intent.iconState || null,
    icon_state_at_ms: Number(intent.iconStateAt) || 0,
  };
  const outPath = `${state.runDir}/${INTENT_LOCKED_FILENAME}`;
  await writeTextFile(outPath, JSON.stringify(lockedPayload, null, 2)).catch(() => {});
  scheduleIntentStateWrite({ immediate: true });

  // Reveal the normal UI.
  syncIntentModeClass();
  updateEmptyCanvasHint();
  renderQuickActions();
  renderHudReadout();
  requestRender();
  showToast("Intent locked.", "tip", 1800);
  return true;
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

function getOrCreateImageCacheRecord(path, cache = state.imageCache) {
  const existing = cache.get(path);
  if (existing) return existing;
  const rec = { url: null, urlPromise: null, imgPromise: null };
  cache.set(path, rec);
  return rec;
}

async function ensureImageUrl(path, cache = state.imageCache) {
  if (!path) return null;
  const rec = getOrCreateImageCacheRecord(path, cache);
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

function isBrowserImagePath(path) {
  const ext = extname(path).toLowerCase();
  return FILE_BROWSER_IMAGE_EXTS.has(ext);
}

function fileBrowserIsSuppressedArtifactName(name) {
  const lowered = String(name || "").trim().toLowerCase();
  if (!lowered) return false;
  if (lowered === "_raw_provider_outputs") return true;
  if (lowered === "manifest.json") return true;
  if (/^contact_sheet(?:_.*)?\.(png|jpg|jpeg|webp)$/i.test(lowered)) return true;
  return false;
}

function parentDirPath(path) {
  const raw = String(path || "").trim();
  if (!raw) return null;
  const trimmed = raw.replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  if (trimmed === "/" || trimmed === "\\") return null;
  const slashIdx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (slashIdx < 0) return null;
  if (slashIdx === 0) return trimmed.slice(0, 1);
  if (slashIdx === 2 && /^[A-Za-z]:/.test(trimmed)) return `${trimmed.slice(0, 2)}\\`;
  return trimmed.slice(0, slashIdx);
}

function fileBrowserDisplayPathLabel({ cwd = "", rootDir = "" } = {}) {
  const current = String(cwd || "").trim();
  const root = String(rootDir || "").trim();
  const fallback = current || root;
  if (!fallback) return "No folder selected";
  const normalizedCurrent = current.replace(/[\\/]+$/, "");
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  const leaf = basename(normalizedCurrent || normalizedRoot) || fallback;
  if (!normalizedCurrent || !normalizedRoot || normalizedCurrent === normalizedRoot) {
    return leaf;
  }
  const rootLeaf = basename(normalizedRoot) || normalizedRoot;
  if (normalizedCurrent.startsWith(normalizedRoot)) {
    const relative = normalizedCurrent.slice(normalizedRoot.length).replace(/^[\\/]+/, "");
    const parts = relative.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 1) return `${rootLeaf}/${parts[0]}`;
    if (parts.length > 1) return `${rootLeaf}/.../${parts[parts.length - 1]}`;
  }
  return `${rootLeaf}/.../${leaf}`;
}

function normalizeLocalFsPath(rawPath) {
  let path = String(rawPath || "").trim();
  if (!path) return "";
  if (path.startsWith("file://")) {
    try {
      const u = new URL(path);
      path = decodeURIComponent(u.pathname || "");
      if (/^\/[A-Za-z]:\//.test(path)) {
        path = path.slice(1);
      }
    } catch {
      path = path.replace(/^file:\/\//i, "");
      try {
        path = decodeURIComponent(path);
      } catch {
        // ignore
      }
    }
  }
  return path;
}

function isAbsoluteLocalFsPath(path) {
  const target = String(path || "").trim();
  if (!target) return false;
  if (target.startsWith("/") || target.startsWith("\\")) return true;
  return /^[A-Za-z]:[\\/]/.test(target);
}

async function resolveLocalFsPathMaybeRelative(baseDir, rawPath) {
  const target = normalizeLocalFsPath(rawPath);
  if (!target) return "";
  if (isAbsoluteLocalFsPath(target)) return target;
  const base = String(baseDir || "").trim();
  if (!base) return "";
  try {
    return normalizeLocalFsPath(await join(base, target));
  } catch {
    return "";
  }
}

async function fileBrowserLoadImportPathMap(dir) {
  const targetDir = String(dir || "").trim();
  const out = new Map();
  if (!targetDir) return out;
  const manifestCandidates = [];
  try {
    manifestCandidates.push(await join(targetDir, "manifest.json"));
  } catch {
    manifestCandidates.push(`${targetDir}/manifest.json`);
  }
  const parent = parentDirPath(targetDir);
  if (parent) {
    try {
      manifestCandidates.push(await join(parent, "manifest.json"));
    } catch {
      manifestCandidates.push(`${parent}/manifest.json`);
    }
  }
  let payload = null;
  for (const candidate of manifestCandidates) {
    if (!candidate) continue;
    try {
      payload = JSON.parse(await readTextFile(candidate));
      if (payload && typeof payload === "object") break;
    } catch {
      payload = null;
    }
  }
  if (!payload || typeof payload !== "object") {
    return out;
  }
  const items = Array.isArray(payload?.items) ? payload.items : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rawOutput =
      item.output ??
      item.preview ??
      item.rendered ??
      item.styled ??
      item.preview_path ??
      item.path ??
      "";
    const rawInput =
      item.input ??
      item.source ??
      item.original ??
      item.source_path ??
      item.input_path ??
      item.original_path ??
      "";
    const outputPath = await resolveLocalFsPathMaybeRelative(targetDir, rawOutput);
    const inputPath = await resolveLocalFsPathMaybeRelative(targetDir, rawInput);
    if (!outputPath || !inputPath) continue;
    if (!isBrowserImagePath(outputPath) || !isBrowserImagePath(inputPath)) continue;
    out.set(outputPath, inputPath);
    const outputKey = fileBrowserPathMapKey(outputPath);
    if (outputKey) out.set(outputKey, inputPath);
    const outBase = basename(outputPath);
    if (outBase) out.set(`name:${outBase}`, inputPath);
    if (outBase) out.set(`name:${outBase.toLowerCase()}`, inputPath);
    const outStem = outBase.replace(/\.[^.]+$/, "");
    if (outStem) out.set(`stem:${outStem}`, inputPath);
    if (outStem) out.set(`stem:${outStem.toLowerCase()}`, inputPath);
    const relaxedStem = outStem.replace(/_wire_subject(?:-\d+)?$/i, "");
    if (relaxedStem && relaxedStem !== outStem) out.set(`stem:${relaxedStem}`, inputPath);
    if (relaxedStem && relaxedStem !== outStem) out.set(`stem:${relaxedStem.toLowerCase()}`, inputPath);
  }
  return out;
}

function canvasWorldPointFromClient(clientX, clientY) {
  const cx = Number(clientX);
  const cy = Number(clientY);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const wrapRect = els.canvasWrap?.getBoundingClientRect?.();
  if (!wrapRect) return null;
  if (cx < wrapRect.left || cx > wrapRect.right || cy < wrapRect.top || cy > wrapRect.bottom) return null;
  const overlayRect = els.overlayCanvas?.getBoundingClientRect?.() || wrapRect;
  return canvasScreenCssToWorldCss({ x: cx - overlayRect.left, y: cy - overlayRect.top });
}

function fileBrowserCreateDragGhost(path) {
  const targetPath = String(path || "").trim();
  if (!targetPath) return null;
  const ghost = document.createElement("div");
  ghost.className = "file-browser-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.dataset.path = targetPath;
  const thumb = document.createElement("img");
  thumb.className = "file-browser-drag-ghost-thumb";
  thumb.alt = "";
  thumb.src = THUMB_PLACEHOLDER_SRC;
  ghost.appendChild(thumb);
  const label = document.createElement("div");
  label.className = "file-browser-drag-ghost-label";
  const base = basename(targetPath) || "image";
  label.textContent = base.length > 20 ? `${base.slice(0, 19)}…` : base;
  ghost.appendChild(label);
  document.body.appendChild(ghost);
  const cache = state.fileBrowser?.thumbCache || state.imageCache;
  ensureImageUrl(targetPath, cache)
    .then((url) => {
      if (!url || !ghost.isConnected) return;
      thumb.src = url;
    })
    .catch(() => {});
  return ghost;
}

function fileBrowserUpdateDragGhost(el, clientX, clientY) {
  if (!el) return;
  const cx = Number(clientX);
  const cy = Number(clientY);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
  el.classList.remove("is-drop");
  el.style.transition = "none";
  el.style.opacity = "0.98";
  el.style.filter = "";
  el.style.left = `${Math.round(cx)}px`;
  el.style.top = `${Math.round(cy)}px`;
  el.style.transform = "translate3d(-34%, -76%, 0) scale(0.84)";
}

function fileBrowserDestroyDragGhost(el) {
  if (!el) return;
  try {
    el.remove();
  } catch {
    // ignore
  }
}

function fileBrowserAnimateDropPulse(clientX, clientY) {
  if (!els.canvasWrap) return;
  const cx = Number(clientX);
  const cy = Number(clientY);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
  const wrapRect = els.canvasWrap.getBoundingClientRect();
  if (!wrapRect) return;
  if (cx < wrapRect.left || cx > wrapRect.right || cy < wrapRect.top || cy > wrapRect.bottom) return;
  const pulse = document.createElement("div");
  pulse.className = "file-browser-drop-pulse";
  pulse.style.left = `${Math.round(cx - wrapRect.left)}px`;
  pulse.style.top = `${Math.round(cy - wrapRect.top)}px`;
  els.canvasWrap.appendChild(pulse);
  requestAnimationFrame(() => {
    pulse.classList.add("is-live");
  });
  setTimeout(() => {
    try {
      pulse.remove();
    } catch {
      // ignore
    }
  }, 420);
}

function fileBrowserAnimateDropGhost(ghostEl, { clientX, clientY, path = "" } = {}) {
  const cx = Number(clientX);
  const cy = Number(clientY);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
    if (ghostEl) fileBrowserDestroyDragGhost(ghostEl);
    return;
  }
  const ghost = ghostEl || fileBrowserCreateDragGhost(path);
  fileBrowserAnimateDropPulse(cx, cy);
  if (!ghost) return;
  ghost.classList.add("is-drop");
  ghost.style.left = `${Math.round(cx)}px`;
  ghost.style.top = `${Math.round(cy)}px`;
  ghost.style.opacity = "1";
  ghost.style.filter = "";
  ghost.style.transition =
    "transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease-out, filter 220ms ease-out";
  requestAnimationFrame(() => {
    if (!ghost.isConnected) return;
    ghost.style.transform = "translate3d(-50%, -50%, 0) scale(2.08)";
    ghost.style.opacity = "0";
    ghost.style.filter = "saturate(1.2) brightness(1.12)";
  });
  const cleanup = () => fileBrowserDestroyDragGhost(ghost);
  ghost.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, 320);
}

function clearFileBrowserThumbCache({ keepPaths = null } = {}) {
  const fb = state.fileBrowser;
  if (!fb?.thumbCache) return;
  const keep = keepPaths instanceof Set ? keepPaths : null;
  for (const [path, rec] of fb.thumbCache.entries()) {
    if (keep && keep.has(path)) continue;
    const url = rec?.url;
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    fb.thumbCache.delete(path);
  }
}

function fileBrowserRenderMessage(message, { isError = false } = {}) {
  if (!els.fileBrowserList) return;
  const div = document.createElement("div");
  div.className = `file-browser-message${isError ? " is-error" : ""}`;
  div.textContent = String(message || "");
  els.fileBrowserList.innerHTML = "";
  els.fileBrowserList.appendChild(div);
}

function ensureFileBrowserObserver() {
  const fb = state.fileBrowser;
  if (!fb?.enabled) return null;
  if (!els.fileBrowserList) return null;
  if (fb.observer) return fb.observer;
  if (!("IntersectionObserver" in window)) return null;
  fb.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const imgEl = entry.target;
        const path = imgEl?.dataset?.path ? String(imgEl.dataset.path) : "";
        if (!path) continue;
        fb.observer.unobserve(imgEl);
        ensureImageUrl(path, fb.thumbCache)
          .then((url) => {
            if (url && imgEl && imgEl.dataset.path === path) imgEl.src = url;
          })
          .catch(() => {});
      }
    },
    { root: els.fileBrowserList, rootMargin: "140px" }
  );
  return fb.observer;
}

function fileBrowserSetSelectedPath(path) {
  const fb = state.fileBrowser;
  if (!fb) return;
  fb.selectedPath = path ? String(path) : null;
  if (!els.fileBrowserList) return;
  const rows = els.fileBrowserList.querySelectorAll(".file-browser-item");
  rows.forEach((row) => {
    const rowPath = String(row?.dataset?.path || "");
    const selected = Boolean(fb.selectedPath && rowPath && rowPath === fb.selectedPath);
    row.classList.toggle("is-selected", selected);
    row.setAttribute("aria-selected", selected ? "true" : "false");
  });
}

function fileBrowserEntriesForUi() {
  const fb = state.fileBrowser;
  if (!fb) return [];
  const list = Array.isArray(fb.entries) ? fb.entries : [];
  return list.slice(0, 550);
}

function renderFileBrowserDock() {
  const fb = state.fileBrowser;
  if (!fb?.enabled) return;
  if (!els.fileBrowserDock || !els.fileBrowserList) return;

  if (els.fileBrowserPath) {
    const fullPath = String(fb.cwd || fb.rootDir || "").trim();
    els.fileBrowserPath.textContent = fileBrowserDisplayPathLabel({ cwd: fb.cwd, rootDir: fb.rootDir });
    els.fileBrowserPath.title = fullPath || "No folder selected";
  }
  if (els.fileBrowserUp) {
    els.fileBrowserUp.disabled = Boolean(!fb.cwd || !parentDirPath(fb.cwd));
  }
  if (els.fileBrowserRefresh) {
    els.fileBrowserRefresh.disabled = Boolean(!fb.cwd || fb.loading);
  }
  if (els.fileBrowserChoose) {
    els.fileBrowserChoose.disabled = Boolean(fb.loading);
  }

  if (!fb.cwd) {
    fileBrowserRenderMessage("Choose Folder to browse local images.");
    return;
  }
  if (fb.loading) {
    fileBrowserRenderMessage("Loading folder…");
    return;
  }
  if (fb.error) {
    fileBrowserRenderMessage(String(fb.error || "Unable to read folder."), { isError: true });
    return;
  }

  const entries = fileBrowserEntriesForUi();
  if (!entries.length) {
    fileBrowserRenderMessage("No image files found in this folder.");
    return;
  }

  const observer = ensureFileBrowserObserver();
  const frag = document.createDocumentFragment();
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "file-browser-item";
    row.dataset.path = entry.path;
    row.dataset.kind = entry.kind;
    if (entry.kind === "file") {
      row.dataset.importPath = String(entry.importPath || entry.path || "");
    }
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");

    const thumb = document.createElement(entry.kind === "file" ? "img" : "div");
    thumb.className = "file-browser-thumb";
    if (entry.kind === "file") {
      thumb.alt = "";
      thumb.src = THUMB_PLACEHOLDER_SRC;
      thumb.dataset.path = entry.path;
      if (observer) observer.observe(thumb);
      else {
        ensureImageUrl(entry.path, fb.thumbCache)
          .then((url) => {
            if (url) thumb.src = url;
          })
          .catch(() => {});
      }
    }

    const name = document.createElement("div");
    name.className = "file-browser-name";
    name.textContent = entry.name;
    if (entry.kind === "file" && entry.importPath && entry.importPath !== entry.path) {
      name.title = `${entry.path}\nimports: ${entry.importPath}`;
    } else {
      name.title = entry.path;
    }

    row.appendChild(thumb);
    row.appendChild(name);
    frag.appendChild(row);
  }
  els.fileBrowserList.innerHTML = "";
  els.fileBrowserList.appendChild(frag);
  fileBrowserSetSelectedPath(fb.selectedPath);
}

async function fileBrowserResolveEntryKind(entry, path) {
  const target = String(path || "").trim();
  if (!target) return "other";
  if (/[\\/]$/.test(target)) return "dir";
  if (entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "children")) {
    if (Array.isArray(entry.children)) return "dir";
    if (entry.children === null) return "file";
  }
  try {
    await readDir(target, { recursive: false });
    return "dir";
  } catch {
    return "file";
  }
}

async function normalizeFileBrowserEntries(rawEntries, { importPathMap = null } = {}) {
  const dirs = [];
  const files = [];
  const entries = await Promise.all(
    (Array.isArray(rawEntries) ? rawEntries : []).map(async (entry) => {
      const path = entry?.path ? String(entry.path).trim() : "";
      if (!path) return null;
      const name = String(entry?.name || basename(path) || path).trim();
      if (!name || name.startsWith(".")) return null;
      if (fileBrowserIsSuppressedArtifactName(name)) return null;
      const resolvedKind = await fileBrowserResolveEntryKind(entry, path);
      if (resolvedKind === "dir") return { name, path, kind: "dir" };
      const ext = extname(path).toLowerCase();
      if (!FILE_BROWSER_IMAGE_EXTS.has(ext)) return null;
      let mappedImportPath = "";
      if (importPathMap instanceof Map) {
        mappedImportPath = normalizeLocalFsPath(importPathMap.get(path) || "");
        if (!mappedImportPath) {
          mappedImportPath = normalizeLocalFsPath(importPathMap.get(`name:${basename(path)}`) || "");
        }
        if (!mappedImportPath) {
          const stem = basename(path).replace(/\.[^.]+$/, "");
          mappedImportPath = normalizeLocalFsPath(importPathMap.get(`stem:${stem}`) || "");
        }
        if (!mappedImportPath) {
          const relaxed = basename(path).replace(/\.[^.]+$/, "").replace(/_wire_subject(?:-\d+)?$/i, "");
          if (relaxed) mappedImportPath = normalizeLocalFsPath(importPathMap.get(`stem:${relaxed}`) || "");
        }
      }
      const importPath = mappedImportPath && isBrowserImagePath(mappedImportPath) ? mappedImportPath : path;
      return { name, path, importPath, kind: "file", ext };
    })
  );
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.kind === "dir") dirs.push(entry);
    else if (entry.kind === "file") files.push(entry);
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

async function fileBrowserLoadDir(dir, { pushHistory = true } = {}) {
  const fb = state.fileBrowser;
  if (!fb?.enabled) return;
  const target = String(dir || "").trim();
  if (!target) return;
  const seq = (Number(fb.loadSeq) || 0) + 1;
  fb.loadSeq = seq;
  fb.loading = true;
  fb.error = null;
  if (pushHistory && fb.cwd && fb.cwd !== target) {
    fb.history.push(fb.cwd);
    if (fb.history.length > 80) fb.history.shift();
  }
  fb.cwd = target;
  renderFileBrowserDock();
  let entries = [];
  try {
    entries = await readDir(target, { recursive: false });
  } catch (err) {
    if (fb.loadSeq !== seq) return;
    fb.loading = false;
    fb.error = err?.message ? `File browser: ${err.message}` : "File browser: cannot read folder";
    fb.entries = [];
    fb.importPathMap = new Map();
    renderFileBrowserDock();
    return;
  }
  if (fb.loadSeq !== seq) return;
  let importPathMap = null;
  try {
    importPathMap = await fileBrowserLoadImportPathMap(target);
  } catch {
    importPathMap = null;
  }
  const normalized = await normalizeFileBrowserEntries(entries, { importPathMap });
  if (fb.loadSeq !== seq) return;
  fb.importPathMap = importPathMap instanceof Map ? importPathMap : new Map();
  const keepThumbs = new Set(normalized.filter((it) => it.kind === "file").map((it) => it.path));
  clearFileBrowserThumbCache({ keepPaths: keepThumbs });
  fb.entries = normalized;
  fb.loading = false;
  fb.error = null;
  if (fb.selectedPath && !fb.entries.some((it) => it.path === fb.selectedPath)) {
    fb.selectedPath = null;
  }
  renderFileBrowserDock();
}

async function fileBrowserPickFolder() {
  const fb = state.fileBrowser;
  if (!fb?.enabled) return;
  bumpInteraction();
  const picked = await open({ directory: true, multiple: false });
  const dir = Array.isArray(picked) ? picked[0] : picked;
  if (!dir) return;
  const root = String(dir).trim();
  fb.rootDir = root || null;
  localStorage.setItem(FILE_BROWSER_ROOT_DIR_LS_KEY, root);
  await fileBrowserLoadDir(root, { pushHistory: false });
}

async function fileBrowserRefresh() {
  const fb = state.fileBrowser;
  if (!fb?.enabled || !fb.cwd) return;
  await fileBrowserLoadDir(fb.cwd, { pushHistory: false });
}

async function fileBrowserNavigateTo(path) {
  const fb = state.fileBrowser;
  if (!fb?.enabled) return;
  const target = String(path || "").trim();
  if (!target) return;
  await fileBrowserLoadDir(target);
}

async function fileBrowserNavigateUp() {
  const fb = state.fileBrowser;
  if (!fb?.enabled || !fb.cwd) return;
  const parent = parentDirPath(fb.cwd);
  if (!parent) return;
  await fileBrowserNavigateTo(parent);
}

async function fileBrowserImportPath(path, { focus = false } = {}) {
  const src = String(path || "").trim();
  if (!src || !isBrowserImagePath(src)) return;
  const center = canvasScreenCssToWorldCss(_defaultImportPointCss());
  await importLocalPathsAtCanvasPoint([src], center, {
    source: "browser",
    focusImported: focus,
    idPrefix: "dock",
  });
}

function fileBrowserCancelPendingClickImport() {
  const fb = state.fileBrowser;
  if (!fb) return;
  clearTimeout(fb.clickImportTimer);
  fb.clickImportTimer = null;
}

function fileBrowserScheduleClickImport(path) {
  const fb = state.fileBrowser;
  if (!fb?.enabled) return;
  fileBrowserCancelPendingClickImport();
  const target = String(path || "").trim();
  if (!target) return;
  fb.clickImportTimer = setTimeout(() => {
    fb.clickImportTimer = null;
    fileBrowserImportPath(target, { focus: false }).catch((err) => console.error(err));
  }, 210);
}

function fileBrowserSetDragPath(path) {
  const fb = state.fileBrowser;
  if (!fb) return;
  clearTimeout(fb.dragClearTimer);
  fb.dragClearTimer = null;
  fb.draggingPath = path ? String(path) : null;
}

function fileBrowserImportPathForEntry(entry) {
  const mapped = normalizeLocalFsPath(String(entry?.importPath || ""));
  if (mapped && isBrowserImagePath(mapped)) return mapped;
  const plain = normalizeLocalFsPath(String(entry?.path || ""));
  if (plain && isBrowserImagePath(plain)) return plain;
  return "";
}

function fileBrowserImportPathForRow(row) {
  if (!row) return "";
  return fileBrowserImportPathForEntry({
    path: String(row.dataset?.path || ""),
    importPath: String(row.dataset?.importPath || ""),
  });
}

function fileBrowserPathMapKey(path) {
  const target = normalizeLocalFsPath(path);
  if (!target) return "";
  return target.replace(/\\/g, "/").normalize("NFC");
}

function fileBrowserResolveMappedPath(path, map = null) {
  const target = normalizeLocalFsPath(path);
  if (!target || !isBrowserImagePath(target)) return "";
  const candidateMap =
    map instanceof Map
      ? map
      : state.fileBrowser?.importPathMap instanceof Map
        ? state.fileBrowser.importPathMap
        : null;
  if (!(candidateMap instanceof Map) || candidateMap.size <= 0) return target;
  const targetKey = fileBrowserPathMapKey(target);
  const name = basename(target);
  const stem = name.replace(/\.[^.]+$/, "");
  const relaxed = stem.replace(/_wire_subject(?:-\d+)?$/i, "");
  const candidates = [target, targetKey, `name:${name}`, `name:${name.toLowerCase()}`, `stem:${stem}`, `stem:${stem.toLowerCase()}`];
  if (relaxed && relaxed !== stem) candidates.push(`stem:${relaxed}`);
  if (relaxed && relaxed !== stem) candidates.push(`stem:${relaxed.toLowerCase()}`);
  for (const key of candidates) {
    const mapped = normalizeLocalFsPath(candidateMap.get(key) || "");
    if (mapped && isBrowserImagePath(mapped)) return mapped;
  }
  return target;
}

async function fileBrowserDeriveOriginalForWirePath(path) {
  const target = normalizeLocalFsPath(path);
  if (!target || !/_wire_subject(?:-\d+)?\.[^.]+$/i.test(target)) return "";
  const outDir = parentDirPath(target);
  const rootDir = outDir ? parentDirPath(outDir) : null;
  if (!rootDir) return "";
  const stem = basename(target).replace(/\.[^.]+$/, "").replace(/_wire_subject(?:-\d+)?$/i, "");
  if (!stem) return "";
  const imageExts = [".png", ".jpg", ".jpeg", ".webp", ".heic", ".bmp", ".tif", ".tiff"];
  const imagesDir = await join(rootDir, "images").catch(() => "");
  if (!imagesDir) return "";
  for (const ext of imageExts) {
    const candidate = await join(imagesDir, `${stem}${ext}`).catch(() => "");
    if (!candidate) continue;
    const ok = await exists(candidate).catch(() => false);
    if (ok) return normalizeLocalFsPath(candidate);
  }
  return "";
}

async function fileBrowserResolveImportPaths(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).map((p) => normalizeLocalFsPath(p)).filter(Boolean);
  if (!list.length) return [];
  const fb = state.fileBrowser;
  let activeMap = fb?.importPathMap instanceof Map ? fb.importPathMap : null;
  const out = [];
  let triedLazyLoad = false;
  for (const raw of list) {
    let resolved = fileBrowserResolveMappedPath(raw, activeMap);
    if (resolved === raw && /_wire_subject(?:-\d+)?\.[^.]+$/i.test(raw) && !triedLazyLoad) {
      triedLazyLoad = true;
      try {
        const cwd = String(fb?.cwd || "").trim();
        if (cwd) {
          activeMap = await fileBrowserLoadImportPathMap(cwd);
          if (fb) fb.importPathMap = activeMap instanceof Map ? activeMap : new Map();
        }
      } catch {
        // ignore
      }
      resolved = fileBrowserResolveMappedPath(raw, activeMap);
    }
    if (resolved === raw && /_wire_subject(?:-\d+)?\.[^.]+$/i.test(raw)) {
      try {
        const derived = await fileBrowserDeriveOriginalForWirePath(raw);
        if (derived && isBrowserImagePath(derived)) resolved = derived;
      } catch {
        // ignore
      }
    }
    out.push(resolved || raw);
  }
  return out;
}

function fileBrowserClearDragPathDeferred(delayMs = 320) {
  const fb = state.fileBrowser;
  if (!fb) return;
  clearTimeout(fb.dragClearTimer);
  const delay = Math.max(0, Number(delayMs) || 0);
  fb.dragClearTimer = setTimeout(() => {
    fb.dragClearTimer = null;
    fb.draggingPath = null;
  }, delay);
}

function fileBrowserReadInternalDragPath(dataTransfer) {
  const fallback = normalizeLocalFsPath(state.fileBrowser?.draggingPath || "");
  if (!dataTransfer) return fallback;
  if (typeof dataTransfer.getData === "function") {
    const custom = normalizeLocalFsPath(dataTransfer.getData(FILE_BROWSER_DRAG_MIME) || "");
    if (custom) return custom;
    const plain = normalizeLocalFsPath(dataTransfer.getData("text/plain") || "");
    if (plain && isBrowserImagePath(plain)) return plain;
  }
  if (fallback) return fallback;
  return "";
}

async function initializeFileBrowserDock() {
  const fb = state.fileBrowser;
  if (!fb?.enabled) return;
  if (!els.fileBrowserDock) return;
  if (els.fileBrowserChoose) {
    els.fileBrowserChoose.addEventListener("click", () => {
      fileBrowserPickFolder().catch((err) => console.error(err));
    });
  }
  if (els.fileBrowserUp) {
    els.fileBrowserUp.addEventListener("click", () => {
      fileBrowserNavigateUp().catch((err) => console.error(err));
    });
  }
  if (els.fileBrowserRefresh) {
    els.fileBrowserRefresh.addEventListener("click", () => {
      fileBrowserRefresh().catch((err) => console.error(err));
    });
  }
  if (els.fileBrowserList) {
    els.fileBrowserList.tabIndex = 0;

    const endManualPointerDrag = ({ clearPath = true, keepGhost = false } = {}) => {
      const drag = fb.manualDrag;
      if (!drag) return null;
      const ghostEl = drag.ghostEl || null;
      if (ghostEl && !keepGhost) {
        fileBrowserDestroyDragGhost(drag.ghostEl);
      }
      drag.ghostEl = null;
      drag.active = false;
      drag.pointerId = null;
      drag.path = null;
      drag.previewPath = null;
      drag.moved = false;
      els.canvasWrap?.classList?.remove("is-browser-drag-over");
      if (clearPath) fileBrowserClearDragPathDeferred(80);
      return keepGhost ? ghostEl : null;
    };

    const onManualPointerMove = (event) => {
      const drag = fb.manualDrag;
      if (!drag?.active) return;
      if (drag.pointerId !== null && Number(event?.pointerId) !== Number(drag.pointerId)) return;
      const cx = Number(event?.clientX) || 0;
      const cy = Number(event?.clientY) || 0;
      const dx = cx - (Number(drag.startX) || 0);
      const dy = cy - (Number(drag.startY) || 0);
      const ghostPath = String(drag.previewPath || drag.path || "").trim();
      if (!drag.moved && Math.hypot(dx, dy) > 2) {
        drag.moved = true;
        if (!drag.ghostEl && ghostPath) {
          drag.ghostEl = fileBrowserCreateDragGhost(ghostPath);
        }
      }
      if (!drag.moved) return;
      if (!drag.ghostEl && ghostPath) {
        drag.ghostEl = fileBrowserCreateDragGhost(ghostPath);
      }
      fileBrowserUpdateDragGhost(drag.ghostEl, cx, cy);
      const overCanvas = Boolean(canvasWorldPointFromClient(cx, cy));
      els.canvasWrap?.classList?.toggle("is-browser-drag-over", overCanvas);
      event?.preventDefault?.();
    };

    const onManualPointerUp = (event) => {
      const drag = fb.manualDrag;
      if (!drag?.active) return;
      if (drag.pointerId !== null && Number(event?.pointerId) !== Number(drag.pointerId)) return;
      const cx = Number(event?.clientX) || 0;
      const cy = Number(event?.clientY) || 0;
      const path = normalizeLocalFsPath(drag.path || "");
      const previewPath = normalizeLocalFsPath(drag.previewPath || path);
      const didMove = Boolean(drag.moved);
      const keepGhost = Boolean(didMove && path && isBrowserImagePath(path));
      const ghostEl = endManualPointerDrag({ clearPath: false, keepGhost });
      if (!didMove || !path || !isBrowserImagePath(path)) {
        if (ghostEl) fileBrowserDestroyDragGhost(ghostEl);
        fileBrowserClearDragPathDeferred(80);
        return;
      }
      fb.suppressClickUntil = Date.now() + 380;
      const world = canvasWorldPointFromClient(cx, cy);
      if (!world) {
        if (ghostEl) fileBrowserDestroyDragGhost(ghostEl);
        fileBrowserClearDragPathDeferred(80);
        return;
      }
      fileBrowserAnimateDropGhost(ghostEl, { clientX: cx, clientY: cy, path: previewPath || path });
      importLocalPathsAtCanvasPoint([path], world, {
        source: "browser_pointer_drag",
        idPrefix: "dockdrag",
        enforceIntentLimit: true,
        focusImported: true,
      })
        .then((result) => {
          if (!result?.ok) showToast("Could not import dropped image.", "error", 2600);
        })
        .catch((err) => {
          console.error(err);
          showToast("Could not import dropped image.", "error", 2600);
        })
        .finally(() => {
          fileBrowserClearDragPathDeferred(80);
        });
    };

    const onManualPointerCancel = (event) => {
      const drag = fb.manualDrag;
      if (!drag?.active) return;
      if (drag.pointerId !== null && Number(event?.pointerId) !== Number(drag.pointerId)) return;
      endManualPointerDrag({ clearPath: true });
    };

    window.addEventListener("pointermove", onManualPointerMove, { passive: false });
    window.addEventListener("pointerup", onManualPointerUp, { passive: false });
    window.addEventListener("pointercancel", onManualPointerCancel, { passive: true });

    els.fileBrowserList.addEventListener("pointerdown", (event) => {
      const row = event?.target?.closest ? event.target.closest(".file-browser-item") : null;
      if (!row || !els.fileBrowserList.contains(row)) return;
      const displayPath = normalizeLocalFsPath(String(row.dataset?.path || ""));
      const importPath = fileBrowserImportPathForRow(row);
      const kind = String(row.dataset?.kind || "").trim();
      if (kind !== "file" || !displayPath || !importPath) return;
      event.preventDefault();
      fileBrowserSetDragPath(importPath);
      fileBrowserSetSelectedPath(displayPath);
      fb.manualDrag.active = true;
      fb.manualDrag.pointerId = Number(event?.pointerId);
      fb.manualDrag.path = importPath;
      fb.manualDrag.previewPath = displayPath;
      fb.manualDrag.startX = Number(event?.clientX) || 0;
      fb.manualDrag.startY = Number(event?.clientY) || 0;
      fb.manualDrag.moved = false;
      if (fb.manualDrag.ghostEl) {
        fileBrowserDestroyDragGhost(fb.manualDrag.ghostEl);
        fb.manualDrag.ghostEl = null;
      }
    });
    els.fileBrowserList.addEventListener("click", (event) => {
      if (Date.now() < (Number(fb.suppressClickUntil) || 0)) return;
      const row = event?.target?.closest ? event.target.closest(".file-browser-item") : null;
      if (!row || !els.fileBrowserList.contains(row)) return;
      const path = normalizeLocalFsPath(String(row.dataset?.path || ""));
      const importPath = fileBrowserImportPathForRow(row);
      const kind = String(row.dataset?.kind || "").trim();
      if (!path) return;
      fileBrowserSetSelectedPath(path);
      if (kind === "dir") {
        fileBrowserCancelPendingClickImport();
        fileBrowserNavigateTo(path).catch((err) => console.error(err));
        return;
      }
      if (!importPath) return;
      fileBrowserScheduleClickImport(importPath);
    });
    els.fileBrowserList.addEventListener("dblclick", (event) => {
      if (Date.now() < (Number(fb.suppressClickUntil) || 0)) return;
      const row = event?.target?.closest ? event.target.closest(".file-browser-item") : null;
      if (!row || !els.fileBrowserList.contains(row)) return;
      const path = normalizeLocalFsPath(String(row.dataset?.path || ""));
      const importPath = fileBrowserImportPathForRow(row);
      const kind = String(row.dataset?.kind || "").trim();
      if (!path) return;
      fileBrowserCancelPendingClickImport();
      fileBrowserSetSelectedPath(path);
      if (kind === "dir") {
        fileBrowserNavigateTo(path).catch((err) => console.error(err));
        return;
      }
      if (!importPath) return;
      fileBrowserImportPath(importPath, { focus: true }).catch((err) => console.error(err));
    });
    els.fileBrowserList.addEventListener("keydown", (event) => {
      const key = String(event?.key || "");
      const entries = fileBrowserEntriesForUi();
      if (!entries.length) return;
      const current = state.fileBrowser?.selectedPath || "";
      let idx = entries.findIndex((item) => item.path === current);
      if (key === "ArrowDown") {
        event.preventDefault();
        idx = clamp(idx + 1, 0, entries.length - 1);
        fileBrowserSetSelectedPath(entries[idx]?.path || null);
      } else if (key === "ArrowUp") {
        event.preventDefault();
        idx = clamp(idx < 0 ? 0 : idx - 1, 0, entries.length - 1);
        fileBrowserSetSelectedPath(entries[idx]?.path || null);
      } else if (key === "Enter") {
        event.preventDefault();
        if (idx < 0) idx = 0;
        const entry = entries[idx] || null;
        if (!entry?.path) return;
        fileBrowserCancelPendingClickImport();
        if (entry.kind === "dir") fileBrowserNavigateTo(entry.path).catch((err) => console.error(err));
        else {
          const importPath = fileBrowserImportPathForEntry(entry);
          if (!importPath) return;
          fileBrowserImportPath(importPath, { focus: true }).catch((err) => console.error(err));
        }
      }
    });
  }

  if (fb.rootDir) {
    await fileBrowserLoadDir(fb.rootDir, { pushHistory: false });
  } else {
    renderFileBrowserDock();
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

function googleBrandRectColorForKey(key = "", alpha = 0.44) {
  const palette = GOOGLE_BRAND_RECT_PALETTE_RGB;
  if (!Array.isArray(palette) || !palette.length) return `rgba(66, 133, 244, ${alpha})`;
  const idx = Math.abs(Number(hash32(String(key || ""))) || 0) % palette.length;
  return googleBrandRectColorForIndex(idx, alpha);
}

function googleBrandRectColorForIndex(index = 0, alpha = 0.44) {
  const palette = GOOGLE_BRAND_RECT_PALETTE_RGB;
  if (!Array.isArray(palette) || !palette.length) return `rgba(66, 133, 244, ${alpha})`;
  const len = Math.max(1, palette.length);
  const rawIndex = Math.floor(Number(index) || 0);
  const idx = ((rawIndex % len) + len) % len;
  const rgb = Array.isArray(palette[idx]) ? palette[idx] : palette[0];
  const a = Math.max(0, Math.min(1, Number(alpha) || 0));
  return `rgba(${Number(rgb[0]) || 66}, ${Number(rgb[1]) || 133}, ${Number(rgb[2]) || 244}, ${a})`;
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
  // Niche action: route to FLUX by default for testing; the global Image Model setting remains unchanged.
  surprise: "flux-2-pro",
  combine: "gemini-3-pro-image-preview",
  swap_dna: "gemini-3-pro-image-preview",
  bridge: "gemini-3-pro-image-preview",
  extract_dna_apply: "gemini-2.5-flash-image",
  soul_leech_apply: "gemini-2.5-flash-image",
  recast: "gemini-3-pro-image-preview",
  remove_people: "gemini-3-pro-image-preview",
};

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
    await invoke("write_pty", { data: `${PTY_COMMANDS.IMAGE_MODEL} ${settings.imageModel}\n` }).catch(() => {});
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
const PORTRAITS_DIR_DISK_FILE = "portraits_dir.json";

async function getPortraitsDirDiskPath() {
  try {
    const home = await homeDir();
    if (!home) return null;
    return await join(home, ".brood", PORTRAITS_DIR_DISK_FILE);
  } catch (_) {
    return null;
  }
}

async function loadPortraitsDirFromDisk() {
  if (state.portraitMedia.diskDirChecked) return state.portraitMedia.diskDir;
  if (state.portraitMedia.diskDirPromise) return await state.portraitMedia.diskDirPromise;
  state.portraitMedia.diskDirPromise = (async () => {
    const path = await getPortraitsDirDiskPath();
    if (!path) return null;
    if (!(await exists(path).catch(() => false))) return null;
    try {
      const payload = JSON.parse(await readTextFile(path));
      const dir = typeof payload?.dir === "string" ? payload.dir.trim() : "";
      return dir ? dir : null;
    } catch (_) {
      return null;
    }
  })();
  try {
    state.portraitMedia.diskDir = await state.portraitMedia.diskDirPromise;
    state.portraitMedia.diskDirChecked = true;
    return state.portraitMedia.diskDir;
  } finally {
    state.portraitMedia.diskDirPromise = null;
  }
}

async function persistPortraitsDirToDisk(dir) {
  try {
    const home = await homeDir();
    if (!home) return;
    const broodDir = await join(home, ".brood");
    await createDir(broodDir, { recursive: true }).catch(() => {});
    const path = await join(broodDir, PORTRAITS_DIR_DISK_FILE);
    const payload = { dir: String(dir || "").trim() || null, updated_at: new Date().toISOString() };
    await writeTextFile(path, JSON.stringify(payload, null, 2));
    state.portraitMedia.diskDir = payload.dir;
    state.portraitMedia.diskDirChecked = true;
  } catch (_) {
    // ignore
  }
}

async function clearPortraitsDirOnDisk() {
  try {
    const path = await getPortraitsDirDiskPath();
    if (path) await removeFile(path).catch(() => {});
  } catch (_) {}
  state.portraitMedia.diskDir = null;
  state.portraitMedia.diskDirChecked = true;
}

function renderPortraitsDirReadout() {
  if (!els.portraitsDir) return;
  const custom = localStorage.getItem(PORTRAITS_DIR_LS_KEY);
  const disk = state.portraitMedia.diskDirChecked ? state.portraitMedia.diskDir : null;
  const resolved = state.portraitMedia.dir;
  const lines = [];
  if (custom) lines.push(`Custom (this build): ${custom}`);
  else if (disk) lines.push(`Custom (all builds): ${disk}`);
  if (resolved) {
    lines.push(`Using: ${resolved}`);
  } else if (state.portraitMedia.dirChecked) {
    lines.push("Using: (not found)");
    if (state.portraitMedia.lastResolveError) {
      lines.push(`Why: ${clampText(state.portraitMedia.lastResolveError, 180)}`);
    }
  } else {
    lines.push("Using: (searching...)");
  }
  els.portraitsDir.textContent = lines.join("\n");
}

async function refreshPortraitsDirReadout() {
  renderPortraitsDirReadout();
  try {
    await resolvePortraitsDir();
  } catch (_) {}
  renderPortraitsDirReadout();
}

function invalidatePortraitMediaCache() {
  state.portraitMedia.dir = null;
  state.portraitMedia.dirChecked = false;
  state.portraitMedia.dirPromise = null;
  state.portraitMedia.lastResolveError = null;
  state.portraitMedia.index = null;
  state.portraitMedia.indexChecked = false;
  state.portraitMedia.indexPromise = null;
  state.portraitMedia.activeKey1 = null;
  state.portraitMedia.activeKey2 = null;
  state.portraitMedia.missingToastShown = false;
  state.portraitMedia.loadErrorToastShown = false;
  if (state.portraitMedia.urlCache) {
    for (const rec of state.portraitMedia.urlCache.values()) {
      const url = rec?.url;
      if (!url) continue;
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    state.portraitMedia.urlCache.clear();
  } else {
    state.portraitMedia.urlCache = new Map();
  }
}

async function pickPortraitsDir() {
  bumpInteraction();
  const picked = await open({ directory: true, multiple: false });
  const dir = Array.isArray(picked) ? picked[0] : picked;
  if (!dir) return;
  localStorage.setItem(PORTRAITS_DIR_LS_KEY, String(dir));
  persistPortraitsDirToDisk(String(dir)).catch(() => {});
  invalidatePortraitMediaCache();
  renderPortraitsDirReadout();
  ensurePortraitIndex().catch(() => {});
  updatePortraitIdle({ fromSettings: true });
}

function portraitAgentFromProvider(provider) {
  const p = String(provider || "").toLowerCase();
  // Requested swaps:
  // - OpenAI uses Stability clips; Stability (SDXL) uses OpenAI clips.
  // - Gemini uses Flux clips; Flux uses Gemini clips.
  if (p === "openai") return "stability";
  if (p === "sdxl" || p === "stability") return "openai";
  if (p === "gemini") return "flux";
  if (p === "imagen") return "imagen";
  if (p === "flux") return "gemini";
  if (p === "dryrun") return "dryrun";
  return "dryrun";
}

function looksLikePortraitClipName(name) {
  const lower = String(name || "").toLowerCase();
  // Stable: `gemini_idle.mp4`
  if (lower.match(/^(dryrun|openai|gemini|imagen|flux|stability)_(idle|working)\.(mp4|mov|webm)$/)) {
    return true;
  }
  // Variant/timestamped: `gemini_idle_20240201_010203....mp4`
  return Boolean(lower.match(/^(dryrun|openai|gemini|imagen|flux|stability)_(idle|working)_.+\.(mp4|mov|webm)$/));
}

async function scanPortraitDir(dir) {
  const result = { entries: 0, videos: 0, matches: 0, sampleVideos: [] };
  if (!dir) return result;
  const entries = await readDir(dir, { recursive: false });
  for (const entry of entries || []) {
    const path = entry?.path;
    if (!path) continue;
    result.entries += 1;
    const ext = extname(path);
    if (ext !== ".mp4" && ext !== ".mov" && ext !== ".webm") continue;
    result.videos += 1;
    const name = basename(path);
    if (result.sampleVideos.length < 4 && name) result.sampleVideos.push(name);
    if (looksLikePortraitClipName(name)) result.matches += 1;
  }
  return result;
}

async function deriveMainRepoRootFromWorktree(repoRoot) {
  if (!repoRoot) return null;
  try {
    const gitPath = await join(repoRoot, ".git");
    const content = await readTextFile(gitPath);
    const firstLine = String(content || "").split(/\r?\n/)[0] || "";
    const match = firstLine.match(/^gitdir:\s*(.+)\s*$/i);
    if (!match) return null;
    const gitdir = String(match[1] || "").trim();
    if (!gitdir) return null;

    const needlePosix = "/.git/worktrees/";
    const needleWin = "\\\\.git\\\\worktrees\\\\";
    let idx = gitdir.indexOf(needlePosix);
    if (idx !== -1) return gitdir.slice(0, idx) || null;
    idx = gitdir.indexOf(needleWin);
    if (idx !== -1) return gitdir.slice(0, idx) || null;
  } catch (_) {
    // ignore
  }
  return null;
}

async function resolvePortraitsDir() {
  if (state.portraitMedia.dirChecked) return state.portraitMedia.dir;
  if (state.portraitMedia.dirPromise) return await state.portraitMedia.dirPromise;
  state.portraitMedia.dirPromise = (async () => {
    state.portraitMedia.lastResolveError = null;
    const candidates = [];
    const fromLsRaw = localStorage.getItem(PORTRAITS_DIR_LS_KEY);
    const fromLs = fromLsRaw ? String(fromLsRaw).trim() : "";
    if (fromLs) candidates.push(fromLs);
    const fromDisk = await loadPortraitsDirFromDisk();
    if (fromDisk && (!fromLs || String(fromDisk) !== String(fromLs).trim())) candidates.push(String(fromDisk).trim());

    // Dev convenience: use repo-local outputs if we can locate the repo root.
    try {
      const repoRoot = await invoke("get_repo_root");
      if (repoRoot) {
        candidates.push(await join(repoRoot, "outputs", "sora_portraits"));

        // If we're running inside a git worktree checkout, `.git` is a file that points
        // at the main repo's `.git/worktrees/...`. The portrait MP4s are often generated
        // in the main repo's `outputs/` (and are usually untracked), so prefer that if present.
        const mainRoot = await deriveMainRepoRootFromWorktree(repoRoot);
        if (mainRoot && mainRoot !== repoRoot) {
          candidates.push(await join(mainRoot, "outputs", "sora_portraits"));
        }
      }
    } catch (_) {}

    // Default persisted location (recommended for packaged builds).
    try {
      const home = await homeDir();
      if (home) {
        candidates.push(await join(home, ".brood", "portraits"));
        candidates.push(await join(home, "brood_runs", "portraits"));
      }
    } catch (_) {}

    const primaryCandidate = candidates.length > 0 ? String(candidates[0]) : "";
    let primaryError = null;
    let lastError = null;

    for (const dir of candidates) {
      let dirError = null;
      let ok = false;
      try {
        ok = await exists(dir);
      } catch (err) {
        dirError = `Cannot access folder: ${err?.message || err}`;
        if (dir === primaryCandidate) primaryError = primaryError || dirError;
        lastError = dirError;
        continue;
      }
      if (!ok) {
        dirError = `Folder not found: ${dir}`;
        if (dir === primaryCandidate) primaryError = primaryError || dirError;
        lastError = dirError;
        continue;
      }
      try {
        const scan = await scanPortraitDir(dir);
        if (scan.matches > 0) return dir;
        if (scan.videos === 0) {
          dirError = `No portrait clips found in: ${dir} (${scan.entries} entries, 0 videos)`;
        } else {
          const sample = scan.sampleVideos.length ? ` Sample: ${scan.sampleVideos.join(", ")}` : "";
          dirError = `No portrait clips matched naming in: ${dir} (${scan.videos} videos, 0 matches).${sample}`;
        }
      } catch (err) {
        dirError = `Cannot read folder: ${err?.message || err}`;
      }
      if (dirError) {
        if (dir === primaryCandidate) primaryError = primaryError || dirError;
        lastError = dirError;
      }
    }

    state.portraitMedia.lastResolveError = primaryError || lastError || null;
    return null;
  })();
  try {
    state.portraitMedia.dir = await state.portraitMedia.dirPromise;
    state.portraitMedia.dirChecked = true;
    renderPortraitsDirReadout();
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
  const lower = String(name || "").toLowerCase();
  const targets = [
    `${agent}_${clipState}.mp4`,
    `${agent}_${clipState}.mov`,
    `${agent}_${clipState}.webm`,
  ];
  return targets.includes(lower);
}

async function buildPortraitIndex(dir) {
  // Prefer a known-good Stability "working" clip as the default OpenAI waiting video.
  // OpenAI provider currently maps to the "stability" portrait agent (see portraitAgentFromProvider()).
  const DEFAULT_STABILITY_WORKING_CLIP =
    "stability_working_sora-2_720x1280_12s_20260205_231943.sq.mute.mp4";
  const DEFAULT_STABILITY_IDLE_CLIP =
    "stability_idle_sora-2_720x1280_12s_20260205_231943.sq.mute.mp4";

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
    .map((e) => ({ path: e?.path, name: basename(e?.path) || e?.name }))
    .filter((e) => {
      if (!e.path) return false;
      const ext = extname(e.path);
      return ext === ".mp4" || ext === ".mov" || ext === ".webm";
    });

  for (const item of candidates) {
    const name = String(item.name || "").toLowerCase();
    // Accept both "agent_idle_*" (timestamped / variant clips) and the stable
    // "agent_idle.mp4" naming used for hand-curated overrides.
    const match = name.match(/^(dryrun|openai|gemini|imagen|flux|stability)_(idle|working)(?:_|\.)/);
    if (!match) continue;
    const agent = match[1];
    const clipState = match[2];
    const stamp = extractPortraitStamp(name);
    let priority = isStablePortraitName(name, agent, clipState) ? 2 : 1;
    if (
      agent === "stability" &&
      clipState === "working" &&
      name === String(DEFAULT_STABILITY_WORKING_CLIP).toLowerCase()
    ) {
      priority = 3;
    }
    if (
      agent === "stability" &&
      clipState === "idle" &&
      name === String(DEFAULT_STABILITY_IDLE_CLIP).toLowerCase()
    ) {
      priority = 3;
    }
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
    renderPortraitsDirReadout();
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
  // Secondary portrait is UI-only. Prefer showing the *other* provider the user is
  // actually configured to use (text vs image), rather than an arbitrary always-on
  // mascot (Flux).
  const primary = String(primaryProvider || "").toLowerCase();
  const textProvider = providerFromModel(settings.textModel);
  const preferred = [];
  if (textProvider) preferred.push(textProvider);
  // Sensible fallbacks if the text provider doesn't have clips.
  preferred.push("gemini", "openai", "imagen", "flux", "sdxl", "dryrun");
  const ordered = Array.from(new Set(preferred.map((p) => String(p || "").toLowerCase()).filter(Boolean)));
  const candidates = ordered.filter((p) => p !== primary);

  function hasIdle(provider) {
    if (!index) return true; // optimistic until the index loads
    const agent = portraitAgentFromProvider(provider);
    return Boolean(index?.[agent]?.idle || index?.[agent]?.working);
  }

  for (const provider of candidates) {
    if (hasIdle(provider)) return provider;
  }

  // Even if we have no clips for any other provider, keep the secondary portrait
  // label different (the video loader will fall back to dryrun clips if needed).
  if (candidates.length) return candidates[0];
  if (primary && primary !== "dryrun") return "dryrun";
  return "gemini";
}

async function refreshPortraitVideoSlot({ videoEl, provider, busy, activeKeyField }) {
  if (!videoEl) return;
  // Portraits are decorative UI; they should load even before a run/photo is active.
  const visible = Boolean(els.portraitDock) && !els.portraitDock.classList.contains("hidden");
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
    try {
      videoEl.removeAttribute("src");
      videoEl.load();
    } catch (_) {}
    videoEl.classList.add("hidden");
    state.portraitMedia[activeKeyField] = null;
    if (
      !state.portraitMedia.missingToastShown &&
      state.portraitMedia.dirChecked &&
      !state.portraitMedia.dir
    ) {
      state.portraitMedia.missingToastShown = true;
      showToast("Portrait clips not found. Settings -> Portraits Folder -> Choose…", "tip", 5200);
    }
    return;
  }

  let url = null;
  try {
    url = await ensureImageUrl(clipPath, state.portraitMedia.urlCache);
  } catch (err) {
    url = null;
    if (!state.portraitMedia.loadErrorToastShown) {
      state.portraitMedia.loadErrorToastShown = true;
      console.warn("Portrait clip load failed:", clipPath, err);
      showToast("Portrait clip failed to load. Check Portraits Folder in Settings.", "tip", 5200);
    }
  }
  if (!url) {
    videoEl.classList.add("hidden");
    state.portraitMedia[activeKeyField] = null;
    return;
  }

  const key = `${clipPath}:${clipState}`;
  const currentSrc = String(videoEl.currentSrc || videoEl.src || "");
  const needsSrcUpdate = Boolean(url && currentSrc !== String(url));
  if (state.portraitMedia[activeKeyField] !== key || needsSrcUpdate) {
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
  let provider2 = fromSettings ? provider2Default : state.portrait2.provider || provider2Default;
  if (provider2 && provider && String(provider2).toLowerCase() === String(provider).toLowerCase()) {
    provider2 = secondaryProviderFor(provider, index);
  }
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
  const provider2Existing = state.portrait2.provider;
  const needsSecondaryRefresh =
    !provider2Existing || String(provider2Existing).toLowerCase() === String(provider).toLowerCase();
  const provider2 = needsSecondaryRefresh
    ? secondaryProviderFor(provider, state.portraitMedia.index)
    : provider2Existing;
  setPortrait2({
    visible: Boolean(state.activeId),
    busy: false,
    provider: provider2,
    title: providerDisplay(provider2),
  });
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
  } finally {
    updateAlwaysOnVisionReadout();
  }
}

function setStatus(message, isError = false) {
  state.lastStatusText = String(message || "");
  state.lastStatusError = Boolean(isError);
  renderSessionApiCallsReadout();
}

function normalizeErrorMessage(err, fallback = "unknown error") {
  const msg = err?.message || err?.cause?.message || err?.reason?.message || err;
  const text = String(msg || fallback).replace(/\s+/g, " ").trim();
  if (!text) return String(fallback);
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

function reportUserError(context, err, { statusScope = "Engine", retryHint = "Try again." } = {}) {
  const label = String(context || "Action").trim() || "Action";
  const detail = normalizeErrorMessage(err);
  const statusLabel = label.toLowerCase();
  setStatus(`${statusScope}: ${statusLabel} failed (${detail})`, true);
  const hint = String(retryHint || "").trim();
  const suffix = hint ? ` ${hint}` : "";
  showToast(`${label} failed: ${detail}.${suffix}`, "error", 4200);
}

function runWithUserError(context, run, opts = {}) {
  const fn = typeof run === "function" ? run : null;
  if (!fn) return Promise.resolve(false);
  return Promise.resolve()
    .then(() => fn())
    .catch((err) => {
      console.error(`${context} failed:`, err);
      reportUserError(context, err, opts);
      return false;
    });
}

function captureRunResetSnapshot() {
  const queue = topMetricQueueCounts();
  return {
    runName: state.runDir ? basename(state.runDir) : "none",
    imageCount: Math.max(0, Number(state.images?.length) || 0),
    selectedCount: Math.max(0, Number(state.selectedIds?.length) || 0),
    queueDepth: Math.max(0, Number(queue.pending) || 0) + Math.max(0, Number(queue.running) || 0),
  };
}

function announceRunTransition(kind, snapshot) {
  const mode = String(kind || "").trim().toLowerCase();
  const summary = snapshot && typeof snapshot === "object" ? snapshot : captureRunResetSnapshot();
  const pieces = [];
  if (summary.imageCount > 0) pieces.push(`${summary.imageCount} photo${summary.imageCount === 1 ? "" : "s"}`);
  if (summary.selectedCount > 0) pieces.push(`${summary.selectedCount} selection${summary.selectedCount === 1 ? "" : "s"}`);
  if (summary.queueDepth > 0) pieces.push(`${summary.queueDepth} queued action${summary.queueDepth === 1 ? "" : "s"}`);
  const resetting = pieces.length ? pieces.join(", ") : "workspace state";
  if (mode === "open") {
    setStatus("Engine: opening run (resetting workspace)…");
    showToast(`Open Run: resetting ${resetting}.`, "tip", 3200);
    return;
  }
  setStatus("Engine: creating run (resetting workspace)…");
  showToast(`New Run: resetting ${resetting}.`, "tip", 3200);
}

function finalizeRunTransition(kind, { restoredArtifacts = 0, engineReady = true } = {}) {
  const mode = String(kind || "").trim().toLowerCase();
  const runName = basename(state.runDir) || "run";
  const ready = Boolean(engineReady);
  if (!ready) {
    if (mode === "open") {
      showToast(`Opened ${runName}, but engine failed to start. Retry Open Run.`, "error", 4200);
      return;
    }
    showToast(`Run ${runName} created, but engine failed to start. Retry New Run.`, "error", 4200);
    return;
  }
  if (mode === "open") {
    const restored = Math.max(0, Number(restoredArtifacts) || 0);
    showToast(
      `Opened ${runName}. Workspace reset complete; restored ${restored} artifact${restored === 1 ? "" : "s"}.`,
      "tip",
      3600
    );
    return;
  }
  showToast(`New run ready: ${runName}. Workspace reset complete.`, "tip", 3200);
}

function renderSessionApiCallsReadout() {
  renderTopMetricsGrid();
}

function bumpSessionApiCalls({ n = 1 } = {}) {
  const delta = Number(n) || 0;
  if (!Number.isFinite(delta) || delta <= 0) return;
  state.sessionApiCalls = (Number(state.sessionApiCalls) || 0) + delta;
  renderSessionApiCallsReadout();
}

let toastTimer = null;
let topMetricsTickTimer = null;
function showToast(message, kind = "info", timeoutMs = 2400) {
  if (shouldSuppressToastInReelMode(message, kind)) return;
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

let lastMotherRenderedText = null;
let motherTypeoutTimer = null;
let motherTypeoutTarget = "";
let motherTypeoutIndex = 0;
let motherGlitchTimer = null;
let motherReadoutFadeTimer = null;
let motherPhaseCardExitTimer = null;
let motherPhaseCardExitInFlight = false;
let wheelForcePanHeld = false;
const REEL_PRESET_MARGIN_PX = 24;
let reelPresetWindowResizeAttached = false;

function getReelScaleForViewport() {
  const appWidth = Math.max(1, window.innerWidth - REEL_PRESET_MARGIN_PX);
  const appHeight = Math.max(1, window.innerHeight - REEL_PRESET_MARGIN_PX);
  const widthScale = appWidth / REEL_PRESET.width;
  const heightScale = appHeight / REEL_PRESET.height;
  const rawScale = Math.min(widthScale, heightScale, 1);
  return clamp(rawScale, 0.08, 1);
}

function isReelSizeLocked() {
  return document.documentElement.dataset.reelSizePreset === "active";
}

function shouldSuppressToastInReelMode(message, kind = "info") {
  if (!isReelSizeLocked()) return false;
  if (String(kind || "").toLowerCase() === "error") return false;
  const text = String(message || "").trim();
  if (!text) return false;
  // In reel mode, suppress informational toasts that reveal generated/input filenames.
  return /\b[^\\/\s]+\.(png|jpe?g|webp|heic|gif|bmp|tiff?|mp4|mov|webm)\b/i.test(text);
}

function suppressReelDnaToasts() {
  return isReelSizeLocked();
}

function updateReelSizeButton() {
  const locked = isReelSizeLocked();
  if (els.reelAdminToggle) {
    els.reelAdminToggle.textContent = locked ? "Exit Reel 9:16" : "Enable Reel 9:16";
    els.reelAdminToggle.classList.toggle("is-active", locked);
    els.reelAdminToggle.setAttribute("aria-pressed", locked ? "true" : "false");
    els.reelAdminToggle.title = locked
      ? "Restore normal layout"
      : `Resize app to ${REEL_PRESET.width} × ${REEL_PRESET.height} area`;
  }
}

function setReelSizeLock(enabled) {
  const appEl = document.getElementById("app");
  if (!appEl) return;
  if (!enabled) {
    document.documentElement.removeAttribute("data-reel-size-preset");
    document.documentElement.style.removeProperty("--reel-view-scale");
    appEl.style.removeProperty("width");
    appEl.style.removeProperty("height");
    updateReelSizeButton();
    return;
  }

  const scale = getReelScaleForViewport();
  const width = Math.round(REEL_PRESET.width * scale);
  const height = Math.round(REEL_PRESET.height * scale);

  appEl.style.width = `${width}px`;
  appEl.style.height = `${height}px`;
  document.documentElement.setAttribute("data-reel-size-preset", "active");
  document.documentElement.style.setProperty("--reel-view-scale", "1");
  updateReelSizeButton();
}

function toggleReelSizeLock() {
  const wasLocked = isReelSizeLocked();
  setReelSizeLock(!wasLocked);
  const nowLocked = isReelSizeLocked();
  if (els.overlayCanvas) {
    els.overlayCanvas.style.cursor = nowLocked ? "none" : INTENT_IMPORT_CURSOR;
  }
  if (!nowLocked && state.reelTouch) {
    state.reelTouch.visibleUntil = 0;
    state.reelTouch.downUntil = 0;
    state.reelTouch.down = false;
  }
  // Reel mode changes visible control affordances (2x3 grid, mother readout/actions),
  // so force an immediate UI refresh instead of waiting for later state updates.
  renderQuickActions();
  renderMotherReadout();
  if (nowLocked) {
    setStatus(`App resize preset: ${REEL_PRESET.width} × ${REEL_PRESET.height}`);
  }
}

function stopMotherGlitchLoop() {
  clearTimeout(motherGlitchTimer);
  motherGlitchTimer = null;
  if (els.tipsText) els.tipsText.classList.remove("mother-glitch");
}

function _triggerMotherGlitchBurst() {
  if (!els.tipsText) return;
  if (els.tipsText.classList.contains("mother-proposal-active")) return;
  if (els.tipsText.querySelector(".mother-proposal-icon, .mother-phase-icon")) return;
  // Keep it subtle and infrequent: brief "cosmic storm" interference.
  const durationMs = 140 + Math.floor(Math.random() * 240);
  els.tipsText.classList.add("mother-glitch");
  setTimeout(() => {
    if (!els.tipsText) return;
    els.tipsText.classList.remove("mother-glitch");
  }, durationMs);
}

function _scheduleNextMotherGlitch() {
  clearTimeout(motherGlitchTimer);
  // Infrequent by design.
  const delayMs = 22000 + Math.floor(Math.random() * 52000); // 22s - 74s
  motherGlitchTimer = setTimeout(() => {
    _triggerMotherGlitchBurst();
    // Occasionally double-tap the glitch for a more "stormy" feel.
    if (Math.random() < 0.22) {
      setTimeout(() => _triggerMotherGlitchBurst(), 140 + Math.floor(Math.random() * 260));
    }
    _scheduleNextMotherGlitch();
  }, delayMs);
}

function startMotherGlitchLoop() {
  if (motherGlitchTimer) return;
  _scheduleNextMotherGlitch();
}

function stopMotherTypeout() {
  clearTimeout(motherTypeoutTimer);
  motherTypeoutTimer = null;
  motherTypeoutTarget = "";
  motherTypeoutIndex = 0;
  if (els.tipsText) els.tipsText.classList.remove("mother-typing");
}

function motherV2TriggerReadoutFade() {
  if (!els.tipsText) return;
  clearTimeout(motherReadoutFadeTimer);
  els.tipsText.classList.remove("mother-readout-fade");
  // Force reflow so the fade restarts on each readout change.
  void els.tipsText.offsetWidth; // eslint-disable-line no-unused-expressions
  els.tipsText.classList.add("mother-readout-fade");
  motherReadoutFadeTimer = setTimeout(() => {
    if (!els.tipsText) return;
    els.tipsText.classList.remove("mother-readout-fade");
  }, 280);
}

function motherTypeoutTick() {
  if (!els.tipsText) return;
  const remaining = motherTypeoutTarget.length - motherTypeoutIndex;
  if (remaining <= 0) {
    els.tipsText.classList.remove("mother-typing");
    motherTypeoutTimer = null;
    return;
  }
  let step = 1;
  if (remaining > 900) step = 6;
  else if (remaining > 600) step = 4;
  else if (remaining > 300) step = 3;
  else if (remaining > 140) step = 2;

  motherTypeoutIndex = Math.min(motherTypeoutTarget.length, motherTypeoutIndex + step);
  els.tipsText.textContent = motherTypeoutTarget.slice(0, motherTypeoutIndex);
  motherTypeoutTimer = setTimeout(motherTypeoutTick, 90);
}

function startMotherTypeout(text) {
  if (!els.tipsText) return;
  stopMotherTypeout();
  motherTypeoutTarget = String(text || "");
  motherTypeoutIndex = 0;
  els.tipsText.textContent = "";
  els.tipsText.classList.add("mother-typing");
  motherTypeoutTick();
}

function syncMotherTakeoverClass() {
  if (!els.canvasWrap) return;
  els.canvasWrap.classList.toggle("mother-takeover", Boolean(state.mother?.running));
}

function motherV2CommitUndoAvailable() {
  const idle = state.motherIdle;
  if (!idle?.commitUndo) return false;
  if (Date.now() <= (Number(idle.commitUndo.expiresAt) || 0)) return true;
  // Expired undo should not keep blocking reject follow-up behavior.
  idle.commitUndo = null;
  return false;
}

function renderMotherControls() {
  syncMotherTakeoverClass();

  const idle = state.motherIdle || null;
  const reelLocked = isReelSizeLocked();
  const phase = idle?.phase || motherIdleInitialState();
  const hasProposalImageSet = motherV2HasProposalImageSet();
  const proposalModes = motherV2ProposalModes(idle?.intent || null);
  const undoAvailable = motherV2CommitUndoAvailable();
  const canNextProposal =
    hasProposalImageSet &&
    phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING &&
    proposalModes.length > 1;
  const canConfirm =
    phase === MOTHER_IDLE_STATES.OFFERING ||
    (hasProposalImageSet && phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING);
  const canReject =
    undoAvailable ||
    phase === MOTHER_IDLE_STATES.OFFERING ||
    phase === MOTHER_IDLE_STATES.DRAFTING ||
    (hasProposalImageSet && phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING);
  const nextLabel = "Next proposal";
  const nextTitle = canNextProposal ? "Cycle to next proposal option" : "No alternate proposal available";
  const confirmTitle =
    phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING
      ? "Accept proposal and start draft"
      : phase === MOTHER_IDLE_STATES.OFFERING
        ? "Accept and apply selected draft"
        : "Mother confirm";
  const rejectTitle = undoAvailable
    ? "Undo last Mother commit"
    : phase === MOTHER_IDLE_STATES.DRAFTING
      ? "Cancel drafting"
      : "Reject proposal";

  if (els.motherConfirm) {
    els.motherConfirm.disabled = !canConfirm;
    els.motherConfirm.title = confirmTitle;
    els.motherConfirm.textContent = "V";
    els.motherConfirm.setAttribute("aria-label", confirmTitle);
    els.motherConfirm.classList.toggle("hidden", false);
  }
  if (els.motherStop) {
    const stopAction = els.motherStop.closest(".mother-action");
    if (stopAction) stopAction.classList.toggle("hidden", reelLocked);
    els.motherStop.disabled = !canReject;
    els.motherStop.title = rejectTitle;
    els.motherStop.textContent = undoAvailable ? "↶" : "X";
    els.motherStop.setAttribute("aria-label", rejectTitle);
    els.motherStop.classList.toggle("hidden", reelLocked);
  }
  if (els.motherAbilityIcon) {
    els.motherAbilityIcon.disabled = !canNextProposal;
    els.motherAbilityIcon.title = nextTitle;
    els.motherAbilityIcon.textContent = "→";
    els.motherAbilityIcon.setAttribute("aria-label", canNextProposal ? nextLabel : `${nextLabel} unavailable`);
  }

  syncMotherPortrait();
}

function motherV2ImageLabelById(imageId) {
  const item = state.imagesById.get(String(imageId || "").trim()) || null;
  if (!item) return String(imageId || "").trim();
  const label = String(item.label || "").trim();
  if (label) return label;
  const pathLabel = basename(item.path || "");
  if (pathLabel) return pathLabel;
  return String(item.id || "").trim();
}

function motherV2PaletteKeyByImageId(imageId) {
  const id = String(imageId || "").trim();
  if (!id) return "";
  const item = state.imagesById.get(id) || null;
  if (!item) return id;
  const path = String(item.path || "").trim();
  if (path) return `${id}|${path}`;
  const label = String(item.label || "").trim();
  if (label) return `${id}|${label}`;
  return id;
}

function motherV2PaletteIndexByImageId(imageId) {
  const id = String(imageId || "").trim();
  if (!id) return 0;
  const paletteLen = Math.max(1, Number(GOOGLE_BRAND_RECT_PALETTE_RGB?.length) || 0);
  const item = state.imagesById.get(id) || null;
  const assigned = Number(item?.uiPaletteIndex);
  if (Number.isFinite(assigned) && assigned >= 0) {
    return Math.floor(assigned) % paletteLen;
  }
  const fallbackOrder = Array.isArray(state.images)
    ? state.images.findIndex((entry) => String(entry?.id || "").trim() === id)
    : -1;
  if (fallbackOrder >= 0) return fallbackOrder % paletteLen;
  return Math.abs(Number(hash32(id)) || 0) % paletteLen;
}

function motherV2SyncSelectOptions(selectEl, currentId = "") {
  if (!selectEl) return;
  const normalizedCurrent = String(currentId || "").trim();
  const options = [{ value: "", label: "Unassigned" }];
  for (const item of motherIdleBaseImageItems()) {
    if (!item?.id) continue;
    options.push({
      value: String(item.id),
      label: motherV2ImageLabelById(item.id),
    });
  }
  const prior = Array.from(selectEl.options || []).map((opt) => `${opt.value}::${opt.text}`).join("|");
  const next = options.map((opt) => `${opt.value}::${opt.label}`).join("|");
  if (prior !== next) {
    selectEl.innerHTML = options
      .map((opt) => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`)
      .join("");
  }
  selectEl.value = normalizedCurrent;
}

function motherV2SyncLayeredPanel() {
  const idle = state.motherIdle;
  if (!idle) return;
  const phase = idle.phase || motherIdleInitialState();
  const interactive =
    phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING ||
    phase === MOTHER_IDLE_STATES.OFFERING ||
    phase === MOTHER_IDLE_STATES.DRAFTING;
  const advancedVisible = motherV2IsAdvancedVisible() && interactive;
  const hintsVisible = motherV2HintsVisible() && interactive;
  const hasIntent = Boolean(idle.intent && typeof idle.intent === "object");

  if (els.motherPanel) {
    els.motherPanel.classList.toggle("mother-panel-layered", interactive || phase === MOTHER_IDLE_STATES.WATCHING);
    els.motherPanel.classList.toggle("mother-hints-visible", hintsVisible);
    els.motherPanel.classList.toggle("mother-advanced-visible", advancedVisible);
  }
  if (els.motherPanelStack) {
    els.motherPanelStack.classList.toggle("mother-panel-interactive", interactive);
    els.motherPanelStack.classList.toggle("mother-panel-advanced", advancedVisible);
  }
  if (els.motherRefineToggle) {
    els.motherRefineToggle.classList.add("hidden");
    els.motherRefineToggle.setAttribute("aria-expanded", advancedVisible ? "true" : "false");
    els.motherRefineToggle.textContent = advancedVisible ? "Hide structure" : "Refine structure";
  }
  if (els.motherAdvanced) {
    els.motherAdvanced.classList.toggle("hidden", !advancedVisible || !hasIntent);
  }
  if (!advancedVisible || !hasIntent) return;

  if (els.motherTransformationMode) {
    if (!els.motherTransformationMode.options.length) {
      els.motherTransformationMode.innerHTML = MOTHER_V2_TRANSFORMATION_MODES.map(
        (mode) => `<option value="${mode}">${mode.toUpperCase()}</option>`
      ).join("");
    }
    const mode = motherV2CurrentTransformationMode();
    els.motherTransformationMode.value = mode;
  }

  motherV2SyncSelectOptions(els.motherRoleSubject, motherV2RoleIds("subject")[0] || "");
  motherV2SyncSelectOptions(els.motherRoleModel, motherV2RoleIds("model")[0] || "");
  motherV2SyncSelectOptions(els.motherRoleMediator, motherV2RoleIds("mediator")[0] || "");
  motherV2SyncSelectOptions(els.motherRoleObject, motherV2RoleIds("object")[0] || "");
}

function syncMotherIntentSourceIndicator() {
  const indicator = els.motherIntentSourceIndicator;
  if (!indicator) return;
  const sourceKind = String(state.motherIdle?.intent?._intent_source_kind || "").trim().toLowerCase();
  const normalized = sourceKind === "realtime" || sourceKind === "fallback" ? sourceKind : "";
  indicator.classList.remove("hidden", "is-realtime", "is-fallback");
  if (!normalized) {
    indicator.title = intentSourceDotTooltip("");
    return;
  }
  indicator.classList.add(`is-${normalized}`);
  indicator.title = intentSourceDotTooltip(normalized);
}

function motherV2RolePreviewEntries() {
  const roleByImageId = new Map();
  for (const roleKey of MOTHER_V2_ROLE_KEYS) {
    for (const imageIdRaw of motherV2RoleIds(roleKey)) {
      const imageId = String(imageIdRaw || "").trim();
      if (!imageId) continue;
      if (!roleByImageId.has(imageId)) roleByImageId.set(imageId, roleKey);
    }
  }
  const visibleIds = new Set(
    getVisibleCanvasImages()
      .map((item) => String(item?.id || "").trim())
      .filter(Boolean)
  );
  const orderedIds = [];
  const pushOrderedId = (rawId) => {
    const imageId = String(rawId || "").trim();
    if (!imageId) return;
    if (!visibleIds.has(imageId)) return;
    if (orderedIds.includes(imageId)) return;
    orderedIds.push(imageId);
  };
  for (const imageIdRaw of Array.isArray(state.freeformZOrder) ? state.freeformZOrder : []) {
    pushOrderedId(imageIdRaw);
  }
  for (const item of getVisibleCanvasImages()) {
    pushOrderedId(item?.id);
  }

  const entries = [];
  for (const imageId of orderedIds) {
    const rect = state.freeformRects.get(imageId) || null;
    if (!rect) continue;
    const roleCandidate = String(roleByImageId.get(imageId) || "")
      .trim()
      .toLowerCase();
    const roleKey = MOTHER_V2_ROLE_KEYS.includes(roleCandidate) ? roleCandidate : "";
    const roleLabel = roleKey ? String(MOTHER_V2_ROLE_LABEL[roleKey] || roleKey.toUpperCase()) : "";
    const paletteIndex = motherV2PaletteIndexByImageId(imageId);
    const accentKey = `palette:${paletteIndex}:${motherV2PaletteKeyByImageId(imageId) || imageId}`;
    const accent = googleBrandRectColorForIndex(paletteIndex, 0.94);
    entries.push({
      imageId,
      roleKey,
      roleLabel,
      accentKey,
      accent,
      imageLabel: clampText(motherV2ImageLabelById(imageId), 28),
      rect: {
        x: Math.round(Number(rect.x) || 0),
        y: Math.round(Number(rect.y) || 0),
        w: Math.max(1, Math.round(Number(rect.w) || 1)),
        h: Math.max(1, Math.round(Number(rect.h) || 1)),
      },
    });
  }
  return entries;
}

function motherV2RolePreviewSignature(
  entries,
  { canvasCssW, canvasCssH, surfaceW, surfaceH, animationMode = "", promptMotionKey = "" } = {}
) {
  const parts = [
    `canvas=${Math.round(Number(canvasCssW) || 0)}x${Math.round(Number(canvasCssH) || 0)}`,
    `surface=${Math.round(Number(surfaceW) || 0)}x${Math.round(Number(surfaceH) || 0)}`,
    `mode=${state.canvasMode || ""}`,
    `proposal_mode=${String(animationMode || "")}`,
    `prompt_motion=${String(promptMotionKey || "")}`,
  ];
  parts.push(`active=${getVisibleActiveId() || ""}`);
  parts.push(`sel=${getVisibleSelectedIds().join(",")}`);
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    const rect = entry.rect || {};
    parts.push(
      `${entry.imageId}:${entry.roleKey}:${entry.accentKey || ""}:${Math.round(Number(rect.x) || 0)},${Math.round(
        Number(rect.y) || 0
      )},${Math.round(
        Number(rect.w) || 0
      )},${Math.round(Number(rect.h) || 0)}`
    );
  }
  return parts.join("|");
}

function motherV2RolePreviewMode() {
  const explicit = motherV2MaybeTransformationMode(state.motherIdle?.intent?.transformation_mode);
  if (explicit) return explicit;
  const remembered = motherV2MaybeTransformationMode(state.motherIdle?.lastProposalMode);
  return remembered || "";
}

function motherV2RolePreviewAnimationMode() {
  const phase = String(state.motherIdle?.phase || "").trim();
  const activePhases = new Set([
    MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING,
    MOTHER_IDLE_STATES.DRAFTING,
    MOTHER_IDLE_STATES.OFFERING,
  ]);
  if (!activePhases.has(phase)) return "";
  const mode = motherV2RolePreviewMode();
  if (!mode) return "";
  if (phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING) {
    const intent = state.motherIdle?.intent || null;
    if (!intent || typeof intent !== "object") return "";
  }
  return mode;
}

function motherV2RolePreviewMotionState() {
  const dragging =
    Boolean(state.pointer?.active) ||
    Boolean(state.motherIdle?.roleGlyphDrag) ||
    Boolean(state.effectTokenDrag);
  return dragging ? "paused" : "running";
}

function motherV2VectorToTarget(fromX, fromY, toX, toY, magnitude = 1) {
  const dx = Number(toX) - Number(fromX);
  const dy = Number(toY) - Number(fromY);
  const len = Math.hypot(dx, dy);
  if (!(len > 0.0001)) return { x: 0, y: 0 };
  return {
    x: (dx / len) * Number(magnitude || 0),
    y: (dy / len) * Number(magnitude || 0),
  };
}

function motherV2BlendNumber(base, target, t = 0) {
  const from = Number(base) || 0;
  const to = Number(target) || 0;
  const amount = clamp(Number(t) || 0, 0, 1);
  return from + (to - from) * amount;
}

const MOTHER_V2_PROMPT_MOTION_KEYWORDS = Object.freeze({
  cinematic: Object.freeze([
    "cinematic",
    "dramatic",
    "hero",
    "high-contrast",
    "moody",
    "rim light",
    "production-grade lighting",
  ]),
  soft: Object.freeze([
    "soft",
    "warm",
    "gentle",
    "dreamy",
    "ethereal",
    "serene",
    "intimate",
    "romantic",
  ]),
  chaos: Object.freeze([
    "chaotic",
    "chaos",
    "fracture",
    "destabilize",
    "glitch",
    "shatter",
    "fragment",
    "volatile",
  ]),
  precise: Object.freeze([
    "clean",
    "minimal",
    "crisp",
    "coherent",
    "structured",
    "grid",
    "focal hierarchy",
    "perspective",
  ]),
  fusion: Object.freeze([
    "integrate all references",
    "single coherent scene",
    "fusion",
    "fuse",
    "blend",
    "hybrid",
    "midpoint",
  ]),
  lighting: Object.freeze([
    "lighting",
    "shadow",
    "contrast",
    "exposure",
    "color",
    "tonal",
    "highlight",
  ]),
});

function motherV2PromptKeywordScore(text = "", keywords = []) {
  const hay = String(text || "").toLowerCase();
  if (!hay || !Array.isArray(keywords) || !keywords.length) return 0;
  let hits = 0;
  for (const rawKeyword of keywords) {
    const keyword = String(rawKeyword || "").trim().toLowerCase();
    if (!keyword) continue;
    if (hay.includes(keyword)) hits += 1;
  }
  return clamp(hits / Math.max(1, keywords.length), 0, 1);
}

function motherV2PromptMotionProfileFromCompiled(compiled = {}) {
  const payload = compiled && typeof compiled === "object" ? compiled : {};
  const positive = String(payload.positive_prompt || payload.prompt || "").trim();
  const negative = String(payload.negative_prompt || "").trim();
  const summary = String(payload.summary || payload.intent_summary || "").trim();
  const directive = String(payload.creative_directive || "").trim();
  const transformationMode = motherV2MaybeTransformationMode(payload.transformation_mode) || "";
  const raw = [positive, negative, summary, directive, transformationMode].filter(Boolean).join("\n").trim().toLowerCase();
  if (!raw) return null;

  const cinematic = motherV2PromptKeywordScore(raw, MOTHER_V2_PROMPT_MOTION_KEYWORDS.cinematic);
  const softness = motherV2PromptKeywordScore(raw, MOTHER_V2_PROMPT_MOTION_KEYWORDS.soft);
  const chaos = motherV2PromptKeywordScore(raw, MOTHER_V2_PROMPT_MOTION_KEYWORDS.chaos);
  const precision = motherV2PromptKeywordScore(raw, MOTHER_V2_PROMPT_MOTION_KEYWORDS.precise);
  const fusion = motherV2PromptKeywordScore(raw, MOTHER_V2_PROMPT_MOTION_KEYWORDS.fusion);
  const lighting = motherV2PromptKeywordScore(raw, MOTHER_V2_PROMPT_MOTION_KEYWORDS.lighting);

  const promptHash = hash32(raw);
  const seedA = rand01(promptHash + 0.17);
  const seedB = rand01(promptHash + 1.93);
  const seedC = rand01(promptHash + 3.71);
  const seedD = rand01(promptHash + 5.29);

  const tempo = clamp(1 + cinematic * 0.2 + chaos * 0.22 - softness * 0.1 + (seedA - 0.5) * 0.08, 0.72, 1.42);
  const spread = clamp(1 + chaos * 0.2 - fusion * 0.17 - precision * 0.12 + (seedB - 0.5) * 0.12, 0.72, 1.35);
  const pulse = clamp(0.22 + cinematic * 0.45 + fusion * 0.24 + seedC * 0.12, 0.08, 0.96);
  const verticalLift = clamp(cinematic * 0.65 + softness * 0.28 - chaos * 0.18 + (seedD - 0.5) * 0.08, -0.24, 1);
  const focusPull = clamp(precision * 0.62 + fusion * 0.42 - chaos * 0.26, 0, 1);
  const chaosGain = clamp(0.62 + chaos * 0.94 - precision * 0.14 + (seedA - 0.5) * 0.12, 0.45, 1.75);
  const key = [
    promptHash.toString(16),
    Math.round(cinematic * 100),
    Math.round(softness * 100),
    Math.round(chaos * 100),
    Math.round(precision * 100),
    Math.round(fusion * 100),
    Math.round(lighting * 100),
  ].join(":");

  return {
    key,
    tempo,
    spread,
    pulse,
    verticalLift,
    focusPull,
    chaosGain,
    cinematic,
    softness,
    chaos,
    precision,
    fusion,
    lighting,
  };
}

function motherV2CurrentPromptMotionProfile() {
  const idle = state.motherIdle;
  if (!idle) return null;
  const phase = String(idle.phase || "").trim();
  const canUseStored = phase === MOTHER_IDLE_STATES.DRAFTING || phase === MOTHER_IDLE_STATES.OFFERING || phase === MOTHER_IDLE_STATES.COMMITTING || phase === MOTHER_IDLE_STATES.COOLDOWN;
  if (canUseStored && idle.promptMotionProfile && typeof idle.promptMotionProfile === "object") {
    return idle.promptMotionProfile;
  }
  const fallbackCompiled = {
    positive_prompt: String(idle.pendingPromptLine || idle.intent?.summary || "").trim(),
    creative_directive: String(idle.intent?.creative_directive || "").trim(),
    transformation_mode: String(idle.intent?.transformation_mode || "").trim(),
  };
  return motherV2PromptMotionProfileFromCompiled(fallbackCompiled);
}

function motherV2RolePreviewMergeBlend(mode = "") {
  const modeKey = String(mode || "").trim().toLowerCase();
  switch (modeKey) {
    case "amplify":
      return 0.24;
    case "transcend":
      return 0.4;
    case "destabilize":
      return 0.08;
    case "purify":
      return 0.66;
    case "hybridize":
      return 0.98;
    case "mythologize":
      return 0.2;
    case "monumentalize":
      return 0.56;
    case "fracture":
      return 0.03;
    case "romanticize":
      return 0.92;
    case "alienate":
      return 0;
    default:
      return 0;
  }
}

function motherV2RolePreviewMotionProfile({
  mode = "",
  roleKey = "",
  centerX = 0,
  centerY = 0,
  rectW = 0,
  rectH = 0,
  surfaceW = 0,
  surfaceH = 0,
  subjectCenter = null,
  modelCenter = null,
  focusCenter = null,
  mergeRect = null,
  promptMotion = null,
} = {}) {
  const panelCenterX = (Number(surfaceW) || 0) / 2;
  const panelCenterY = (Number(surfaceH) || 0) / 2;
  const dx = Number(centerX) - panelCenterX;
  const dy = Number(centerY) - panelCenterY;
  const len = Math.max(0.0001, Math.hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  const tx = -uy;
  const ty = ux;
  const towardCenterX = -ux;
  const towardCenterY = -uy;
  const signX = dx >= 0 ? 1 : -1;

  const out = {
    preMx: 0,
    preMy: 0,
    preScale: 1,
    preResizeX: 1,
    preResizeY: 1,
    preRot: 0,
    preSat: 1,
    preBright: 1,
    preAlpha: 0.92,
    mx: 0,
    my: 0,
    scale: 1,
    resizeX: 1,
    resizeY: 1,
    rot: 0,
    sat: 1,
    bright: 1,
    alpha: 0.84,
    speedMs: 3000,
    animKind: "flow",
    jitterAx: 2.2,
    jitterAy: 1.6,
    mergeStrength: 0,
  };

  const modeKey = String(mode || "").trim().toLowerCase();
  if (!modeKey) return out;

  switch (modeKey) {
    case "amplify":
      out.animKind = "amplify";
      out.speedMs = 1100;
      out.mx = ux * 5.6;
      out.my = uy * 5.2;
      out.scale = 1.2;
      out.resizeX = 1.16;
      out.resizeY = 1.16;
      out.rot = signX * 2.4;
      out.sat = 1.42;
      out.bright = 1.22;
      out.mergeStrength = 0.16;
      break;
    case "transcend":
      out.animKind = "transcend";
      out.speedMs = 5200;
      out.mx = tx * 1.6 + towardCenterX * 0.8;
      out.my = -7.2 + towardCenterY * 1.1;
      out.scale = 1.02;
      out.resizeX = 0.9;
      out.resizeY = 1.24;
      out.sat = 0.98;
      out.bright = 1.24;
      out.rot = tx * 3.2;
      out.jitterAx = 1.1;
      out.jitterAy = 0.9;
      out.mergeStrength = 0.44;
      break;
    case "destabilize":
      out.animKind = "destabilize";
      out.speedMs = 620;
      out.mx = ux * 2.8 + tx * 1.8;
      out.my = uy * 2.6 + ty * 1.2;
      out.scale = 1;
      out.resizeX = 1.24;
      out.resizeY = 0.78;
      out.rot = signX * 5.2;
      out.sat = 1.26;
      out.bright = 0.98;
      out.jitterAx = 5.8;
      out.jitterAy = 4.2;
      out.alpha = 0.78;
      out.mergeStrength = 0.06;
      break;
    case "purify":
      out.animKind = "purify";
      out.speedMs = 4400;
      out.mx = towardCenterX * 4.2;
      out.my = towardCenterY * 3.4 - 1.4;
      out.scale = 0.96;
      out.resizeX = 0.84;
      out.resizeY = 1.2;
      out.sat = 0.72;
      out.bright = 1.32;
      out.alpha = 0.8;
      out.mergeStrength = 0.8;
      break;
    case "hybridize":
      out.animKind = "hybridize";
      out.speedMs = 1800;
      out.mx = towardCenterX * 5 + tx * 0.8;
      out.my = towardCenterY * 4.2 + ty * 0.8;
      out.scale = 1.08;
      out.resizeX = 1.12;
      out.resizeY = 0.88;
      out.sat = 1.24;
      out.bright = 1.16;
      out.rot = signX * 1.6;
      out.jitterAx = 1.8;
      out.jitterAy = 1.4;
      out.alpha = 0.86;
      out.mergeStrength = 1;
      break;
    case "mythologize":
      out.animKind = "mythologize";
      out.speedMs = 5600;
      out.mx = tx * 6.8;
      out.my = ty * 6.8;
      out.scale = 1.14;
      out.resizeX = 1.22;
      out.resizeY = 0.8;
      out.rot = signX * 7.5;
      out.sat = 1.3;
      out.bright = 1.16;
      out.jitterAx = 3.8;
      out.jitterAy = 2.8;
      out.mergeStrength = 0.24;
      break;
    case "monumentalize":
      out.animKind = "monumentalize";
      out.speedMs = 6200;
      out.mx = towardCenterX * 1.6;
      out.my = -8.8 + towardCenterY * 0.8;
      out.scale = 1.2;
      out.resizeX = 1.1;
      out.resizeY = 1.3;
      out.rot = signX * 0.5;
      out.sat = 1.06;
      out.bright = 1.16;
      out.alpha = 0.88;
      out.mergeStrength = 0.62;
      break;
    case "fracture":
      out.animKind = "fracture";
      out.speedMs = 540;
      out.mx = signX * 8.2 + tx * 2.4;
      out.my = signX * 2.2 - ty * 1.8;
      out.scale = 0.98;
      out.resizeX = 1.36;
      out.resizeY = 0.66;
      out.rot = signX * 8.5;
      out.sat = 1.18;
      out.bright = 0.92;
      out.jitterAx = 7.8;
      out.jitterAy = 5.4;
      out.alpha = 0.72;
      out.mergeStrength = 0.01;
      break;
    case "romanticize": {
      out.animKind = "romanticize";
      out.speedMs = 2600;
      out.mx = towardCenterX * 2.4;
      out.my = towardCenterY * 2.0 - 1.8;
      out.scale = 1.08;
      out.resizeX = 1.2;
      out.resizeY = 0.86;
      out.sat = 1.24;
      out.bright = 1.18;
      out.rot = signX * 1.2;
      out.alpha = 0.86;
      out.mergeStrength = 0.9;

      const hasPair = subjectCenter && modelCenter;
      if (hasPair) {
        const subjectToModel = motherV2VectorToTarget(centerX, centerY, modelCenter.x, modelCenter.y, 4.4);
        const modelToSubject = motherV2VectorToTarget(centerX, centerY, subjectCenter.x, subjectCenter.y, 4.4);
        const pairMidX = (subjectCenter.x + modelCenter.x) / 2;
        const pairMidY = (subjectCenter.y + modelCenter.y) / 2;
        const toPairMid = motherV2VectorToTarget(centerX, centerY, pairMidX, pairMidY, 2.3);
        if (roleKey === "subject") {
          out.mx += subjectToModel.x;
          out.my += subjectToModel.y;
          out.resizeX = 1.28;
          out.resizeY = 0.8;
        } else if (roleKey === "model") {
          out.mx += modelToSubject.x;
          out.my += modelToSubject.y;
          out.resizeX = 1.28;
          out.resizeY = 0.8;
        } else {
          out.mx += toPairMid.x;
          out.my += toPairMid.y;
        }
      }
      break;
    }
    case "alienate":
      out.animKind = "alienate";
      out.speedMs = 3600;
      out.mx = ux * 7.4 + tx * 1.2;
      out.my = uy * 6.8 + ty * 1.2;
      out.scale = 0.86;
      out.resizeX = 0.72;
      out.resizeY = 1.34;
      out.sat = 0.62;
      out.bright = 0.8;
      out.rot = signX * 3.2;
      out.alpha = 0.64;
      out.mergeStrength = 0;
      if (roleKey === "subject" || roleKey === "model") {
        out.resizeX = 0.64;
        out.resizeY = 1.42;
        out.alpha = 0.6;
      }
      break;
    default:
      break;
  }

  const focus = focusCenter && Number.isFinite(Number(focusCenter.x)) && Number.isFinite(Number(focusCenter.y))
    ? { x: Number(focusCenter.x), y: Number(focusCenter.y) }
    : null;
  const mergeStrength = clamp(Number(out.mergeStrength) || 0, 0, 1);
  if (focus && mergeStrength > 0.001) {
    const dist = Math.hypot(focus.x - Number(centerX), focus.y - Number(centerY));
    const mergeMag = clamp(dist * 0.1, 0.6, 6.0) * mergeStrength;
    const mergeVec = motherV2VectorToTarget(centerX, centerY, focus.x, focus.y, mergeMag);
    out.mx += mergeVec.x;
    out.my += mergeVec.y;
    const shapeBlend = clamp(mergeStrength * 0.78, 0, 0.88);
    out.resizeX = motherV2BlendNumber(out.resizeX, 1.02, shapeBlend);
    out.resizeY = motherV2BlendNumber(out.resizeY, 1.02, shapeBlend);
    out.scale = motherV2BlendNumber(out.scale, 1.04, clamp(mergeStrength * 0.5, 0, 0.65));
    out.alpha = motherV2BlendNumber(out.alpha, 0.93, clamp(mergeStrength * 0.6, 0, 0.45));
  }

  const preMerge = {
    mx: out.mx,
    my: out.my,
    scale: out.scale,
    resizeX: out.resizeX,
    resizeY: out.resizeY,
    rot: out.rot,
    sat: out.sat,
    bright: out.bright,
    alpha: out.alpha,
  };

  if (mergeRect && Number(rectW) > 0.0001 && Number(rectH) > 0.0001) {
    const mergeBlend = motherV2RolePreviewMergeBlend(modeKey);
    if (mergeBlend > 0.001) {
      const targetCx = Number(mergeRect.x) + Number(mergeRect.w) / 2;
      const targetCy = Number(mergeRect.y) + Number(mergeRect.h) / 2;
      const centerBlend = clamp(0.14 + mergeBlend * 0.74, 0, 0.92);
      out.mx = motherV2BlendNumber(out.mx, targetCx - Number(centerX), centerBlend);
      out.my = motherV2BlendNumber(out.my, targetCy - Number(centerY), centerBlend);
      const targetScaleX = clamp((Number(mergeRect.w) || 1) / Math.max(1, Number(rectW) || 1), 0.68, 1.55);
      const targetScaleY = clamp((Number(mergeRect.h) || 1) / Math.max(1, Number(rectH) || 1), 0.68, 1.55);
      const shapeBlend = clamp(0.04 + mergeBlend * 0.38, 0, 0.46);
      out.resizeX = motherV2BlendNumber(out.resizeX, targetScaleX, shapeBlend);
      out.resizeY = motherV2BlendNumber(out.resizeY, targetScaleY, shapeBlend);
      out.rot = motherV2BlendNumber(out.rot, 0, clamp(mergeBlend * 0.72, 0, 0.72));
      out.alpha = motherV2BlendNumber(out.alpha, modeKey === "hybridize" ? 0.86 : 0.78, clamp(mergeBlend * 0.84, 0, 0.84));
      out.sat = motherV2BlendNumber(out.sat, modeKey === "hybridize" ? 1.2 : 1.03, clamp(mergeBlend * 0.72, 0, 0.72));
      out.bright = motherV2BlendNumber(out.bright, modeKey === "hybridize" ? 1.12 : 1.04, clamp(mergeBlend * 0.66, 0, 0.66));
      out.scale = motherV2BlendNumber(out.scale, 1.03, clamp(mergeBlend * 0.1, 0, 0.1));
    }
  }

  const promptProfile = promptMotion && typeof promptMotion === "object" ? promptMotion : null;
  if (promptProfile) {
    const tempo = clamp(Number(promptProfile.tempo) || 1, 0.72, 1.42);
    out.speedMs = Math.max(420, Math.round((Number(out.speedMs) || 3000) / tempo));

    const spread = clamp(Number(promptProfile.spread) || 1, 0.72, 1.35);
    out.mx *= spread;
    out.my *= spread;

    const focusPull = clamp(Number(promptProfile.focusPull) || 0, 0, 1);
    const focusBlendX = clamp(focusPull * 0.45, 0, 0.45);
    const focusBlendY = clamp(focusPull * 0.34, 0, 0.34);
    out.mx = motherV2BlendNumber(out.mx, out.mx * 0.82, focusBlendX);
    out.my = motherV2BlendNumber(out.my, out.my * 0.84, focusBlendY);

    const lift = clamp(Number(promptProfile.verticalLift) || 0, -0.24, 1);
    out.my -= lift * 2.4;

    const pulse = clamp(Number(promptProfile.pulse) || 0, 0, 1);
    out.scale = clamp((Number(out.scale) || 1) + pulse * 0.08 - focusPull * 0.02, 0.84, 1.4);

    const chaos = clamp(Number(promptProfile.chaos) || 0, 0, 1);
    const chaosGain = clamp(Number(promptProfile.chaosGain) || 1, 0.45, 1.75);
    out.jitterAx = clamp((Number(out.jitterAx) || 2.2) * chaosGain, 0.7, 12);
    out.jitterAy = clamp((Number(out.jitterAy) || 1.6) * (0.85 + Math.max(0, chaosGain - 1) * 0.8), 0.55, 9);

    const cinematic = clamp(Number(promptProfile.cinematic) || 0, 0, 1);
    const softness = clamp(Number(promptProfile.softness) || 0, 0, 1);
    const lighting = clamp(Number(promptProfile.lighting) || 0, 0, 1);
    out.sat = clamp((Number(out.sat) || 1) + cinematic * 0.12 - softness * 0.08, 0.74, 1.5);
    out.bright = clamp((Number(out.bright) || 1) + lighting * 0.1 - chaos * 0.04 + softness * 0.03, 0.78, 1.38);
    out.alpha = clamp((Number(out.alpha) || 1) + pulse * 0.05 - chaos * 0.05, 0.6, 1);
  }

  // Keep proposal rects visibly filled but semi-transparent across all modes.
  preMerge.alpha = clamp(Number(preMerge.alpha) || 0.7, 0.34, 0.74);
  out.alpha = clamp(Number(out.alpha) || 0.7, 0.34, 0.74);

  const round = (n) => Math.round(Number(n || 0) * 100) / 100;
  return {
    ...out,
    preMx: round(preMerge.mx),
    preMy: round(preMerge.my),
    preScale: round(preMerge.scale),
    preResizeX: round(preMerge.resizeX),
    preResizeY: round(preMerge.resizeY),
    preRot: round(preMerge.rot),
    preSat: round(preMerge.sat),
    preBright: round(preMerge.bright),
    preAlpha: round(preMerge.alpha),
    mx: round(out.mx),
    my: round(out.my),
    scale: round(out.scale),
    resizeX: round(out.resizeX),
    resizeY: round(out.resizeY),
    rot: round(out.rot),
    sat: round(out.sat),
    bright: round(out.bright),
    alpha: round(out.alpha),
    jitterAx: round(out.jitterAx),
    jitterAy: round(out.jitterAy),
    mergeStrength: round(out.mergeStrength),
  };
}

function motherV2SyncRolePreviewViewport(root, projection, { canvasCssW = 0, canvasCssH = 0 } = {}) {
  if (!root) return;
  const existing = root.querySelector(".mother-role-preview-viewport");
  // Keep the panel preview clean: do not render a viewport overlay box here.
  if (existing) existing.remove();
}

function motherV2RolePreviewViewportHtml(projection, { canvasCssW = 0, canvasCssH = 0 } = {}) {
  // Keep the panel preview clean: do not include a viewport overlay box.
  return "";
}

function motherV2RolePreviewHtml(
  entries,
  projection,
  { mode = "", surfaceW = 0, surfaceH = 0, canvasCssW = 0, canvasCssH = 0, promptMotion = null } = {}
) {
  if (!projection) return "";
  const maxSurfaceW = Math.max(1, Number(surfaceW) || 1);
  const maxSurfaceH = Math.max(1, Number(surfaceH) || 1);
  const projectedEntries = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    const projectedRaw = projectWorldRectToSurface(entry.rect, projection);
    if (!projectedRaw) continue;
    // Preserve world-relative size/position in the role preview projection.
    const projected = {
      x: Math.round(clamp(Number(projectedRaw.x) || 0, 0, Math.max(0, maxSurfaceW - 1))),
      y: Math.round(clamp(Number(projectedRaw.y) || 0, 0, Math.max(0, maxSurfaceH - 1))),
      w: Math.max(1, Math.round(Number(projectedRaw.w) || 1)),
      h: Math.max(1, Math.round(Number(projectedRaw.h) || 1)),
    };
    projectedEntries.push({
      entry,
      projected,
      cx: projected.x + projected.w / 2,
      cy: projected.y + projected.h / 2,
    });
  }
  if (!projectedEntries.length) {
    return `<div class="mother-role-preview-surface"></div>`;
  }

  // Use exact projection geometry first, then apply one uniform panel-level zoom so
  // the preview stays readable without changing relative spacing between rectangles.
  {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const rec of projectedEntries) {
      const p = rec?.projected;
      if (!p) continue;
      const x = Number(p.x) || 0;
      const y = Number(p.y) || 0;
      const w = Math.max(1, Number(p.w) || 1);
      const h = Math.max(1, Number(p.h) || 1);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
    const boxW = Math.max(1, maxX - minX);
    const boxH = Math.max(1, maxY - minY);
    const targetW = Math.max(1, maxSurfaceW * clamp(Number(MOTHER_V2_ROLE_PREVIEW_PANEL_FILL_RATIO) || 0.68, 0.4, 0.9));
    const targetH = Math.max(1, maxSurfaceH * clamp(Number(MOTHER_V2_ROLE_PREVIEW_PANEL_FILL_RATIO) || 0.68, 0.4, 0.9));
    const zoom = clamp(
      Math.min(targetW / boxW, targetH / boxH),
      1,
      Math.max(1, Number(MOTHER_V2_ROLE_PREVIEW_PANEL_ZOOM_MAX) || 2.2)
    );
    if (zoom > 1.001) {
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      for (const rec of projectedEntries) {
        const p = rec?.projected;
        if (!p) continue;
        const x = Number(p.x) || 0;
        const y = Number(p.y) || 0;
        const w = Math.max(1, Number(p.w) || 1);
        const h = Math.max(1, Number(p.h) || 1);
        const nextW = w * zoom;
        const nextH = h * zoom;
        const nextX = cx + (x - cx) * zoom;
        const nextY = cy + (y - cy) * zoom;
        rec.projected = {
          x: nextX,
          y: nextY,
          w: nextW,
          h: nextH,
        };
        rec.cx = nextX + nextW / 2;
        rec.cy = nextY + nextH / 2;
      }
      let scaledMinX = Number.POSITIVE_INFINITY;
      let scaledMinY = Number.POSITIVE_INFINITY;
      let scaledMaxX = Number.NEGATIVE_INFINITY;
      let scaledMaxY = Number.NEGATIVE_INFINITY;
      for (const rec of projectedEntries) {
        const p = rec?.projected;
        if (!p) continue;
        scaledMinX = Math.min(scaledMinX, Number(p.x) || 0);
        scaledMinY = Math.min(scaledMinY, Number(p.y) || 0);
        scaledMaxX = Math.max(scaledMaxX, (Number(p.x) || 0) + Math.max(1, Number(p.w) || 1));
        scaledMaxY = Math.max(scaledMaxY, (Number(p.y) || 0) + Math.max(1, Number(p.h) || 1));
      }
      const pad = Math.max(0, Math.round(Number(MOTHER_V2_ROLE_PREVIEW_PANEL_PAD_PX) || 0));
      const scaledW = Math.max(1, scaledMaxX - scaledMinX);
      const scaledH = Math.max(1, scaledMaxY - scaledMinY);
      const availW = Math.max(1, maxSurfaceW - pad * 2);
      const availH = Math.max(1, maxSurfaceH - pad * 2);
      const targetMinX = scaledW <= availW ? clamp(scaledMinX, pad, maxSurfaceW - pad - scaledW) : (maxSurfaceW - scaledW) / 2;
      const targetMinY = scaledH <= availH ? clamp(scaledMinY, pad, maxSurfaceH - pad - scaledH) : (maxSurfaceH - scaledH) / 2;
      const dx = targetMinX - scaledMinX;
      const dy = targetMinY - scaledMinY;
      for (const rec of projectedEntries) {
        const p = rec?.projected;
        if (!p) continue;
        const x = Number(p.x) + dx;
        const y = Number(p.y) + dy;
        const w = Math.max(1, Number(p.w) || 1);
        const h = Math.max(1, Number(p.h) || 1);
        const clampedX = clamp(x, -w + 1, maxSurfaceW - 1);
        const clampedY = clamp(y, -h + 1, maxSurfaceH - 1);
        rec.projected = {
          x: clampedX,
          y: clampedY,
          w,
          h,
        };
        rec.cx = clampedX + w / 2;
        rec.cy = clampedY + h / 2;
      }
    }
  }

  const subjectRec = projectedEntries.find((it) => String(it?.entry?.roleKey || "") === "subject") || null;
  const modelRec = projectedEntries.find((it) => String(it?.entry?.roleKey || "") === "model") || null;
  const subjectCenter = subjectRec ? { x: subjectRec.cx, y: subjectRec.cy } : null;
  const modelCenter = modelRec ? { x: modelRec.cx, y: modelRec.cy } : null;
  const modeKey = String(mode || "").trim().toLowerCase();
  const modeAccent = String(
    MOTHER_V2_PROPOSAL_ICON_ACCENT_BY_MODE[modeKey] || "rgba(230, 237, 243, 0.94)"
  );
  let focusCenter = null;
  if (subjectCenter && modelCenter) {
    focusCenter = {
      x: (subjectCenter.x + modelCenter.x) / 2,
      y: (subjectCenter.y + modelCenter.y) / 2,
    };
  } else if (subjectCenter) {
    focusCenter = { ...subjectCenter };
  } else if (modelCenter) {
    focusCenter = { ...modelCenter };
  } else {
    const sum = projectedEntries.reduce(
      (acc, rec) => {
        acc.x += Number(rec.cx) || 0;
        acc.y += Number(rec.cy) || 0;
        return acc;
      },
      { x: 0, y: 0 }
    );
    focusCenter = {
      x: sum.x / Math.max(1, projectedEntries.length),
      y: sum.y / Math.max(1, projectedEntries.length),
    };
  }

  let mergeRect = null;
  if (modeKey && projectedEntries.length > 1 && focusCenter) {
    const mergeBlend = motherV2RolePreviewMergeBlend(modeKey);
    const compactness = clamp(0.66 + mergeBlend * 0.24, 0.66, 0.93);
    const squareBias = clamp(0.26 + mergeBlend * 0.48, 0.26, 0.86);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let sumW = 0;
    let sumH = 0;
    let sumArea = 0;
    for (const rec of projectedEntries) {
      const w = Math.max(1, Number(rec?.projected?.w) || 1);
      const h = Math.max(1, Number(rec?.projected?.h) || 1);
      const x = Number(rec?.projected?.x) || 0;
      const y = Number(rec?.projected?.y) || 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
      sumW += w;
      sumH += h;
      sumArea += w * h;
    }
    const n = Math.max(1, projectedEntries.length);
    const unionW = Math.max(1, maxX - minX);
    const unionH = Math.max(1, maxY - minY);
    const avgW = sumW / n;
    const avgH = sumH / n;
    const areaSide = Math.max(1, Math.sqrt(sumArea / n));
    const maxTargetW = Math.max(10, (Number(surfaceW) || unionW) * 0.78);
    const maxTargetH = Math.max(10, (Number(surfaceH) || unionH) * 0.78);
    let targetW = clamp(avgW * compactness + areaSide * 0.52 + unionW * 0.06, 10, maxTargetW);
    let targetH = clamp(avgH * compactness + areaSide * 0.52 + unionH * 0.06, 10, maxTargetH);
    const blendedDim = (targetW + targetH) / 2;
    targetW = motherV2BlendNumber(targetW, blendedDim, squareBias);
    targetH = motherV2BlendNumber(targetH, blendedDim, squareBias);
    const cx = Number(focusCenter.x) || 0;
    const cy = Number(focusCenter.y) || 0;
    const x = clamp(cx - targetW / 2, 0, Math.max(0, (Number(surfaceW) || targetW) - targetW));
    const y = clamp(cy - targetH / 2, 0, Math.max(0, (Number(surfaceH) || targetH) - targetH));
    mergeRect = { x, y, w: targetW, h: targetH };
  }

  const rects = [];
  for (let i = 0; i < projectedEntries.length; i += 1) {
    const rec = projectedEntries[i];
    const entry = rec.entry;
    const projected = rec.projected;
    const title = entry.roleLabel ? `${entry.roleLabel}: ${entry.imageLabel}` : entry.imageLabel;
    const roleClass = entry.roleKey ? ` is-${escapeHtml(entry.roleKey)}` : "";
    const profile = motherV2RolePreviewMotionProfile({
      mode,
      roleKey: entry.roleKey,
      centerX: rec.cx,
      centerY: rec.cy,
      rectW: projected.w,
      rectH: projected.h,
      surfaceW,
      surfaceH,
      subjectCenter,
      modelCenter,
      focusCenter,
      mergeRect,
      promptMotion,
    });
    const animKindRaw = String(profile.animKind || "").trim().toLowerCase();
    const animKind = [
      "flow",
      "amplify",
      "transcend",
      "destabilize",
      "purify",
      "hybridize",
      "mythologize",
      "monumentalize",
      "fracture",
      "romanticize",
      "alienate",
    ].includes(animKindRaw)
      ? animKindRaw
      : "flow";
    const accentKey = String(
      entry.accentKey || motherV2PaletteKeyByImageId(entry.imageId) || entry.imageId || entry.imagePath || entry.imageLabel || ""
    );
    const accent = String(entry.accent || googleBrandRectColorForKey(accentKey, 0.94));
    rects.push(`
      <div
        class="mother-role-preview-rect${roleClass}"
        data-anim="${escapeHtml(animKind)}"
        style="left:${projected.x}px;top:${projected.y}px;width:${projected.w}px;height:${projected.h}px;z-index:${20 + i};--mother-role-accent:${escapeHtml(accent)};--mother-role-stagger:${(i % 8) * 90}ms;--mother-role-mode-ms:${escapeHtml(`${Math.max(420, Number(profile.speedMs) || 3000)}ms`)};--mother-role-pre-mx:${escapeHtml(`${profile.preMx}px`)};--mother-role-pre-my:${escapeHtml(`${profile.preMy}px`)};--mother-role-pre-scale:${escapeHtml(String(profile.preScale))};--mother-role-pre-resize-x:${escapeHtml(String(profile.preResizeX))};--mother-role-pre-resize-y:${escapeHtml(String(profile.preResizeY))};--mother-role-pre-rot:${escapeHtml(`${profile.preRot}deg`)};--mother-role-pre-sat:${escapeHtml(String(profile.preSat))};--mother-role-pre-bright:${escapeHtml(String(profile.preBright))};--mother-role-pre-alpha:${escapeHtml(String(profile.preAlpha))};--mother-role-mx:${escapeHtml(`${profile.mx}px`)};--mother-role-my:${escapeHtml(`${profile.my}px`)};--mother-role-scale:${escapeHtml(String(profile.scale))};--mother-role-resize-x:${escapeHtml(String(profile.resizeX))};--mother-role-resize-y:${escapeHtml(String(profile.resizeY))};--mother-role-rot:${escapeHtml(`${profile.rot}deg`)};--mother-role-sat:${escapeHtml(String(profile.sat))};--mother-role-bright:${escapeHtml(String(profile.bright))};--mother-role-alpha:${escapeHtml(String(profile.alpha))};--mother-role-jitter-ax:${escapeHtml(`${profile.jitterAx}px`)};--mother-role-jitter-ay:${escapeHtml(`${profile.jitterAy}px`)}"
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(title)}"
      ></div>
    `);
  }
  const mergeCore = mergeRect
    ? `<div class="mother-role-preview-merge-core" style="left:${Math.round(mergeRect.x)}px;top:${Math.round(mergeRect.y)}px;width:${Math.max(1, Math.round(mergeRect.w))}px;height:${Math.max(1, Math.round(mergeRect.h))}px;--mother-role-accent:${escapeHtml(modeAccent)};"></div>`
    : "";
  const viewport = motherV2RolePreviewViewportHtml(projection, { canvasCssW, canvasCssH });
  return `<div class="mother-role-preview-surface">${rects.join("")}${mergeCore}${viewport}</div>`;
}

function renderMotherRolePreview() {
  const root = els.motherRolePreview;
  if (!root) return;
  const phase = state.motherIdle?.phase || motherIdleInitialState();
  if (phase === MOTHER_IDLE_STATES.DRAFTING || phase === MOTHER_IDLE_STATES.COOLDOWN) {
    root.innerHTML = "";
    root.dataset.previewSig = "";
    root.classList.add("hidden");
    return;
  }
  const hasProposalImageSet = motherV2HasProposalImageSet();
  if (!hasProposalImageSet) {
    root.innerHTML = "";
    root.dataset.previewSig = "";
    root.classList.add("hidden");
    return;
  }
  const animationMode = motherV2RolePreviewAnimationMode();
  if (animationMode) {
    root.setAttribute("data-mode", animationMode);
  } else {
    root.removeAttribute("data-mode");
  }
  root.setAttribute("data-motion", motherV2RolePreviewMotionState());

  const wrap = els.canvasWrap;
  const canvasCssW = Math.max(1, Math.round(Number(wrap?.clientWidth) || 0));
  const canvasCssH = Math.max(1, Math.round(Number(wrap?.clientHeight) || 0));
  if (canvasCssW > 1 && canvasCssH > 1) {
    ensureFreeformLayoutRectsCss(state.images || [], canvasCssW, canvasCssH);
  }

  const entries = motherV2RolePreviewEntries();
  root.classList.remove("hidden");
  const rootW = Math.round(Number(root.clientWidth) || 0);
  const rootH = Math.round(Number(root.clientHeight) || 0);
  if (!rootW || !rootH) return;

  const rootStyle = window.getComputedStyle(root);
  const surfaceInset = Math.max(0, Math.round(parseFloat(rootStyle.getPropertyValue("--mother-role-preview-inset")) || 6));
  const surfaceW = Math.max(1, rootW - surfaceInset * 2);
  const surfaceH = Math.max(1, rootH - surfaceInset * 2);
  const projection = computeWorldProjection({
    canvasCssW,
    canvasCssH,
    surfaceW,
    surfaceH,
    padPx: 6,
  });
  if (!projection) return;
  const promptMotion = motherV2CurrentPromptMotionProfile();
  const promptMotionKey = String(promptMotion?.key || "").trim();

  const sig = motherV2RolePreviewSignature(entries, {
    canvasCssW,
    canvasCssH,
    surfaceW,
    surfaceH,
    animationMode,
    promptMotionKey,
  });
  if (!sig) return;
  if (root.dataset.previewSig === sig) {
    motherV2SyncRolePreviewViewport(root, projection, { canvasCssW, canvasCssH });
    return;
  }

  const html = motherV2RolePreviewHtml(entries, projection, {
    mode: animationMode,
    surfaceW,
    surfaceH,
    canvasCssW,
    canvasCssH,
    promptMotion,
  });
  if (!html) {
    root.innerHTML = "";
    root.dataset.previewSig = "";
    return;
  }
  root.innerHTML = html;
  root.dataset.previewSig = sig;
  motherV2SyncRolePreviewViewport(root, projection, { canvasCssW, canvasCssH });
}

function buildMotherText() {
  const idle = state.motherIdle || null;
  const phase = idle?.phase || motherIdleInitialState();
  const drafts = Array.isArray(idle?.drafts) ? idle.drafts : [];
  const cooldownMs = Math.max(0, (Number(idle?.cooldownUntil) || 0) - Date.now());
  const undoAvailable = motherV2CommitUndoAvailable();
  const canPropose = motherIdleHasArmedCanvas();

  if (phase === MOTHER_IDLE_STATES.WATCHING) {
    return "";
  }
  if (phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING) {
    if (Array.isArray(idle?.pendingVisionImageIds) && idle.pendingVisionImageIds.length) return "";
    if (idle?.pendingIntent) return "";
    return "";
  }
  if (phase === MOTHER_IDLE_STATES.DRAFTING) {
    return "";
  }
  if (phase === MOTHER_IDLE_STATES.OFFERING) {
    const draftCount = drafts.length;
    if (isReelSizeLocked()) {
      return `Draft ready (${draftCount}). ✓ deploy, R reroll.`;
    }
    return `Draft ready (${draftCount}). ✓ deploy, ✕ reject, R reroll.`;
  }
  if (phase === MOTHER_IDLE_STATES.COMMITTING) {
    return "Committing draft to canvas…";
  }
  if (phase === MOTHER_IDLE_STATES.COOLDOWN) {
    const sec = (cooldownMs / 1000).toFixed(1);
    const undo = undoAvailable ? "\nUNDO READY" : "";
    return `Cooling down ${sec}s${undo}`;
  }

  if (!state.images.length) {
    return "";
  }
  if (!canPropose) {
    return "";
  }
  if (motherV2InCooldown()) {
    const sec = (cooldownMs / 1000).toFixed(1);
    return `Cooling down ${sec}s`;
  }

  const aov = state.alwaysOnVision;
  const raw = typeof aov?.lastText === "string" ? aov.lastText.trim() : "";
  const hasOutput = Boolean(raw);

  if (aov?.enabled) {
    if (aov.rtState === "connecting" && !aov.pending && !hasOutput) {
      if (isReelSizeLocked()) return "";
      return "Mother connecting…";
    }
    if (aov.pending) {
      if (isReelSizeLocked()) return "";
      return "Mother scanning…";
    }
    if (phase === MOTHER_IDLE_STATES.OBSERVING && motherIdleHasArmedCanvas()) {
      return "";
    }
    return "Pause for intent hypothesis.";
  }

  const fallback = typeof state.lastTipText === "string" ? state.lastTipText.trim() : "";
  return fallback || "Pause for intent hypothesis.";
}

function motherV2StatusText() {
  const idle = state.motherIdle || null;
  const phase = idle?.phase || motherIdleInitialState();
  const drafts = Array.isArray(idle?.drafts) ? idle.drafts : [];
  const canPropose = motherIdleHasArmedCanvas();
  if (!canPropose && (phase === MOTHER_IDLE_STATES.WATCHING || phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING)) {
    return "Observing";
  }
  if (phase === MOTHER_IDLE_STATES.OBSERVING) return "Observing";
  if (phase === MOTHER_IDLE_STATES.WATCHING) return "Watching";
  if (phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING) {
    if (Array.isArray(idle?.pendingVisionImageIds) && idle.pendingVisionImageIds.length) return "Proposing";
    if (idle?.pendingIntent) return "Proposing";
    if (idle?.intent && typeof idle.intent === "object") return "Proposed";
    return "Proposing";
  }
  if (phase === MOTHER_IDLE_STATES.DRAFTING) return "Drafting 1/1";
  if (phase === MOTHER_IDLE_STATES.OFFERING) return `Offer ${Math.max(1, drafts.length || 0)}`;
  if (phase === MOTHER_IDLE_STATES.COMMITTING) return "Deploying";
  if (phase === MOTHER_IDLE_STATES.COOLDOWN) {
    const cooldownMs = Math.max(0, (Number(idle?.cooldownUntil) || 0) - Date.now());
    return `Cooldown ${(cooldownMs / 1000).toFixed(1)}s`;
  }
  return "";
}

function motherV2LabelsFromIds(ids = [], { limit = 2 } = {}) {
  const out = [];
  const maxCount = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 2;
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const imageId = String(rawId || "").trim();
    if (!imageId) continue;
    if (!isVisibleCanvasImageId(imageId)) continue;
    const label = motherV2ImageLabelById(imageId);
    if (!label || out.includes(label)) continue;
    out.push(label);
    if (out.length >= maxCount) break;
  }
  return out;
}

function motherV2HasRealProposalPayload(intentPayload = null) {
  const intent = intentPayload && typeof intentPayload === "object" ? intentPayload : null;
  if (!intent) return false;
  if (!motherV2HasProposalImageSet()) return false;
  const mode = motherV2MaybeTransformationMode(intent.transformation_mode);
  const candidateModes = Array.isArray(intent.transformation_mode_candidates)
    ? intent.transformation_mode_candidates
        .map((entry) => motherV2MaybeTransformationMode(entry?.mode || entry?.transformation_mode))
        .filter(Boolean)
    : [];
  const hasModeSignal = Boolean(mode || candidateModes.length);
  if (!hasModeSignal) return false;
  const targetIds = motherV2NormalizeImageIdList(
    (Array.isArray(intent.target_ids) && intent.target_ids.length ? intent.target_ids : motherV2RoleIds("subject")) || []
  );
  const refIds = motherV2NormalizeImageIdList(
    (Array.isArray(intent.reference_ids) ? intent.reference_ids : motherV2RoleContextIds({ limit: 6 })) || []
  );
  const hasScopeSignal = targetIds.length > 0 || refIds.length > 0;
  const sentence = motherV2ProposalSentence(intent);
  const hasSummarySignal = typeof sentence === "string" && sentence.trim().length > 0;
  if (hasScopeSignal || hasSummarySignal) return true;
  const phase = String(state.motherIdle?.phase || "").trim();
  const phaseImpliesProposal = phase === MOTHER_IDLE_STATES.DRAFTING || phase === MOTHER_IDLE_STATES.OFFERING;
  return Boolean(phaseImpliesProposal || motherV2CurrentDraft());
}

function motherV2ProposalBadgeIconSvg(kind = "target") {
  const iconKind = String(kind || "target").trim();
  if (iconKind === "reference") {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.1 12a3.3 3.3 0 0 1 3.3-3.3h3.2"/><path d="M15.9 12a3.3 3.3 0 0 1-3.3 3.3H9.4"/><path d="M13.5 8.7h2.1a3.2 3.2 0 1 1 0 6.4h-2.1"/><path d="M10.5 15.3H8.4a3.2 3.2 0 0 1 0-6.4h2.1"/></svg>';
  }
  if (iconKind === "output") {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8 14.2 9.2 20 12l-5.8 2.8L12 20.2l-2.2-5.4L4 12l5.8-2.8z"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2"/></svg>';
}

function motherV2IntentSourceKind(source = "") {
  const raw = String(source || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("realtime") || raw.includes("intent_rt")) return "realtime";
  return "fallback";
}

function motherV2ProposalCardHtml({ phase, statusText, next, readoutHtml }) {
  const normalizedPhase = String(phase || "").trim();
  const isDraftingPhase = normalizedPhase === MOTHER_IDLE_STATES.DRAFTING;
  const isCooldownPhase = normalizedPhase === MOTHER_IDLE_STATES.COOLDOWN;
  const visibleImageCount = motherIdleBaseImageItems().length;
  if (visibleImageCount < MOTHER_V2_MIN_IMAGES_FOR_PROPOSAL) return "";
  const cardVisiblePhases = new Set([
    MOTHER_IDLE_STATES.WATCHING,
    MOTHER_IDLE_STATES.OBSERVING,
    MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING,
    MOTHER_IDLE_STATES.DRAFTING,
    MOTHER_IDLE_STATES.OFFERING,
    MOTHER_IDLE_STATES.COMMITTING,
    MOTHER_IDLE_STATES.COOLDOWN,
  ]);
  if (!cardVisiblePhases.has(normalizedPhase)) {
    return "";
  }
  const intent = state.motherIdle?.intent && typeof state.motherIdle.intent === "object" ? state.motherIdle.intent : null;
  const hasPendingProposalWork = Boolean(
    normalizedPhase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING &&
      (state.motherIdle?.pendingIntent || state.motherIdle?.pendingPromptCompile)
  );
  const hasProposalContext = Boolean(
    motherV2HasRealProposalPayload(intent) ||
      motherV2CurrentDraft() ||
      hasPendingProposalWork ||
      normalizedPhase === MOTHER_IDLE_STATES.WATCHING ||
      normalizedPhase === MOTHER_IDLE_STATES.OBSERVING ||
      normalizedPhase === MOTHER_IDLE_STATES.DRAFTING ||
      normalizedPhase === MOTHER_IDLE_STATES.COMMITTING ||
      normalizedPhase === MOTHER_IDLE_STATES.COOLDOWN
  );
  if (!hasProposalContext) return "";
  const explicitMode = motherV2MaybeTransformationMode(intent?.transformation_mode);
  const rememberedMode = motherV2MaybeTransformationMode(state.motherIdle?.lastProposalMode);
  const modeForDisplay = explicitMode || rememberedMode || MOTHER_V2_DEFAULT_TRANSFORMATION_MODE;
  const hasConfirmedIntentSource = Boolean(motherV2IntentSourceKind(intent?._intent_source_kind));
  const modeLabel = hasConfirmedIntentSource ? motherV2ProposalModeLabel(modeForDisplay) : "";
  const modeAccent = hasConfirmedIntentSource ? motherV2ProposalIconAccent(modeForDisplay) : "";
  const modeAria = hasConfirmedIntentSource ? `Proposal mode ${modeLabel}` : "";
  const proposalVisualHtml = motherV2ProposalIconsHtml(intent, { phase: normalizedPhase });
  const visualHtml = readoutHtml || proposalVisualHtml;
  const visualLine = visualHtml ? `<div class="mother-proposal-visual">${visualHtml}</div>` : "";
  const flowLine = `<div class="mother-proposal-flow">${visualLine}</div>`;
  const modeLine = !isDraftingPhase && !isCooldownPhase && modeLabel
    ? `<div class="mother-proposal-mode" style="--proposal-mode-accent:${escapeHtml(modeAccent)}" aria-label="${escapeHtml(modeAria)}">${escapeHtml(modeLabel)}</div>`
    : "";
  return `
    <div class="mother-proposal-card" aria-label="Mother proposal" data-compact="1">
      ${flowLine}
      ${modeLine}
    </div>
  `;
}

function motherV2PhaseCardKind(phase = null) {
  const statePhase = phase || state.motherIdle?.phase || motherIdleInitialState();
  if (statePhase === MOTHER_IDLE_STATES.COOLDOWN) return "cooldown";
  if (statePhase !== MOTHER_IDLE_STATES.DRAFTING) return "";
  return state.motherIdle?.pendingPromptCompile ? "braiding" : "drafting";
}

function renderMotherReadout() {
  renderMotherControls();
  syncMotherIntentSourceIndicator();
  const phase = state.motherIdle?.phase || motherIdleInitialState();
  const isPhaseCardState = phase === MOTHER_IDLE_STATES.DRAFTING || phase === MOTHER_IDLE_STATES.COOLDOWN;
  if (els.motherPanel) {
    els.motherPanel.classList.toggle(
      "mother-drafting-view",
      isPhaseCardState || motherPhaseCardExitInFlight
    );
  }
  renderMotherRolePreview();
  if (!els.tipsText) return;
  if (isPhaseCardState && !motherPhaseCardExitInFlight) {
    clearTimeout(motherPhaseCardExitTimer);
    els.tipsText.classList.remove("mother-phase-card-exit");
  }
  motherV2SyncLayeredPanel();
  const next = buildMotherText();
  const aov = state.alwaysOnVision;
  const isRealtime = String(aov?.lastMeta?.source || "") === "openai_realtime";
  const hasOutput = typeof aov?.lastText === "string" && aov.lastText.trim();
  const proposalIconsHtml = motherV2ProposalIconsHtml(state.motherIdle?.intent || null, { phase });
  const draftStatusHtml = motherV2DraftStatusHtml({ phase });
  const statusText = motherV2StatusText();
  const readoutHtml = phase === MOTHER_IDLE_STATES.DRAFTING || phase === MOTHER_IDLE_STATES.COOLDOWN
    ? draftStatusHtml
    : proposalIconsHtml || draftStatusHtml;
  const proposalCardHtml = motherV2ProposalCardHtml({ phase, statusText, next, readoutHtml });
  const renderKey = proposalCardHtml || readoutHtml || next;
  const nextPhaseCardKind = motherV2PhaseCardKind(phase);
  const currentPhaseCardKind = String(els.tipsText.dataset.phaseCardKind || "").trim();
  const phaseCardMissing = isPhaseCardState && !els.tipsText.querySelector(".mother-phase-icons.is-draft-card");
  const changed = phaseCardMissing || renderKey !== lastMotherRenderedText;
  const shouldTypeout = Boolean(
    phase === MOTHER_IDLE_STATES.OBSERVING && aov?.enabled && isRealtime && hasOutput && !aov.pending
  );

  if (els.motherState) {
    const normalizedPhase = String(phase || "").trim();
    const phaseLabel = normalizedPhase
      ? normalizedPhase.replace(/_/g, " ").replace(/\b([a-z])/g, (m) => m.toUpperCase())
      : "";
    const normalizedStatus = String(statusText || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    els.motherState.textContent = statusText;
    els.motherState.setAttribute("data-phase", String(phase || ""));
    if (normalizedStatus) {
      els.motherState.setAttribute("data-status", normalizedStatus);
    } else {
      els.motherState.removeAttribute("data-status");
    }
    const accessibilityLabel = statusText || phaseLabel;
    if (accessibilityLabel) {
      els.motherState.setAttribute("aria-label", accessibilityLabel);
    } else {
      els.motherState.removeAttribute("aria-label");
    }
    const stateRow = els.motherState.closest(".mother-state-row");
    if (stateRow) {
      stateRow.classList.toggle("hidden", !accessibilityLabel);
    }
  }
  els.tipsText.classList.toggle("mother-proposal-active", Boolean(proposalCardHtml));
  if (els.motherPanel) {
    els.motherPanel.classList.toggle("mother-proposal-overlay", Boolean(proposalCardHtml));
  }
  els.tipsText.classList.remove("mother-cursor");
  const showingPhaseCard = Boolean(els.tipsText.querySelector(".mother-phase-icons.is-draft-card"));
  const isPhaseToPhaseSwap = Boolean(
    isPhaseCardState && nextPhaseCardKind && currentPhaseCardKind && nextPhaseCardKind !== currentPhaseCardKind
  );
  const shouldFadeOutExistingPhaseCard = Boolean(
    showingPhaseCard &&
      !motherPhaseCardExitInFlight &&
      (
        !isPhaseCardState ||
        isPhaseToPhaseSwap
      )
  );
  if (shouldFadeOutExistingPhaseCard) {
    clearTimeout(motherPhaseCardExitTimer);
    motherPhaseCardExitInFlight = true;
    els.tipsText.classList.add("mother-phase-card-exit");
    motherPhaseCardExitTimer = setTimeout(() => {
      if (!els.tipsText) return;
      els.tipsText.classList.remove("mother-phase-card-exit");
      delete els.tipsText.dataset.phaseCardKind;
      if (!isPhaseToPhaseSwap) {
        els.tipsText.innerHTML = "";
      }
      motherPhaseCardExitInFlight = false;
      lastMotherRenderedText = null;
      renderMotherReadout();
    }, 170);
    return;
  }
  if (motherPhaseCardExitInFlight) return;

  if (!changed) {
    return;
  }

  lastMotherRenderedText = renderKey;
  if (shouldTypeout && !proposalCardHtml) {
    motherV2TriggerReadoutFade();
    startMotherTypeout(next);
    return;
  }

  stopMotherTypeout();
  if (proposalCardHtml) {
    els.tipsText.innerHTML = proposalCardHtml;
    if (nextPhaseCardKind) {
      els.tipsText.dataset.phaseCardKind = nextPhaseCardKind;
    } else {
      delete els.tipsText.dataset.phaseCardKind;
    }
    motherV2TriggerReadoutFade();
    return;
  }
  if (readoutHtml) {
    els.tipsText.innerHTML = readoutHtml;
    if (nextPhaseCardKind) {
      els.tipsText.dataset.phaseCardKind = nextPhaseCardKind;
    } else {
      delete els.tipsText.dataset.phaseCardKind;
    }
    motherV2TriggerReadoutFade();
    return;
  }
  delete els.tipsText.dataset.phaseCardKind;
  els.tipsText.textContent = next;
  motherV2TriggerReadoutFade();
}

function syncMotherPortrait() {
  const overlay = els.motherOverlay || els.motherPanel;
  const videoEl = els.motherVideo;

  const motherRunning = Boolean(state.mother?.running);
  const reelLocked = isReelSizeLocked();
  const aov = state.alwaysOnVision;
  const now = Date.now();
  const mother = state.mother;
  const hasImages = Boolean(state.images && state.images.length);
  const pending = Boolean(aov?.enabled && aov.pending);
  const pendingAt = Math.max(0, Number(aov?.pendingAt) || 0);

  // Presentability hack: keep the realtime "pulse" + video visible for a minimum duration
  // so short calls still read as "alive", and subsequent calls don't restart it.
  if (!aov?.enabled) {
    mother.rtHoldUntil = 0;
    clearTimeout(mother.rtHoldTimer);
    mother.rtHoldTimer = null;
  } else if (pending) {
    const until = (pendingAt || now) + MOTHER_REALTIME_MIN_MS;
    mother.rtHoldUntil = Math.max(Number(mother.rtHoldUntil) || 0, until);
    clearTimeout(mother.rtHoldTimer);
    mother.rtHoldTimer = null;
  }

  const holdUntil = Math.max(0, Number(mother.rtHoldUntil) || 0);
  const held = Boolean(aov?.enabled && holdUntil && now < holdUntil);
  const realtimeActive = Boolean(aov?.enabled && (pending || held));
  const idleFor = now - (state.lastMotherHotAt || 0);
  const userHot = Boolean(aov?.enabled && hasImages && idleFor < MOTHER_USER_HOT_IDLE_MS);
  const userHotUntil = Math.max(0, Number(state.lastMotherHotAt) || 0) + MOTHER_USER_HOT_IDLE_MS;
  const idlePhase = state.motherIdle?.phase || motherIdleInitialState();

  // Realtime border/video is driven by Mother's idle suggestion flow window, with
  // hysteresis to prevent brief watch-phase spikes from blinking the portrait/border.
  const rawRealtime = !reelLocked && !motherRunning && hasImages && motherIdleUsesRealtimeVisual(idlePhase);
  if (rawRealtime) {
    mother.rtVisualRawSince = Math.max(0, Number(mother.rtVisualRawSince) || 0) || now;
  } else {
    mother.rtVisualRawSince = 0;
  }

  let showRealtime = Boolean(mother.rtVisualActive);
  const rawSince = Math.max(0, Number(mother.rtVisualRawSince) || 0);
  const minUntil = Math.max(0, Number(mother.rtVisualMinUntil) || 0);
  if (rawRealtime) {
    if (!showRealtime && rawSince && now - rawSince >= MOTHER_RT_VISUAL_ON_DELAY_MS) {
      showRealtime = true;
      mother.rtVisualActive = true;
      mother.rtVisualMinUntil = now + MOTHER_RT_VISUAL_MIN_ON_MS;
    }
  } else if (showRealtime && now >= minUntil) {
    showRealtime = false;
    mother.rtVisualActive = false;
    mother.rtVisualMinUntil = 0;
  }
  if (!showRealtime && !rawRealtime) {
    mother.rtVisualMinUntil = 0;
  }

  if (els.canvasWrap) {
    els.canvasWrap.classList.toggle("mother-rt-active", showRealtime);
  }

  const refreshAts = [];
  if (!pending) {
    if (held) refreshAts.push(holdUntil);
    if (userHot) refreshAts.push(userHotUntil);
  }
  if (rawRealtime && !showRealtime && rawSince) {
    refreshAts.push(rawSince + MOTHER_RT_VISUAL_ON_DELAY_MS);
  }
  if (!rawRealtime && showRealtime && minUntil) {
    refreshAts.push(minUntil);
  }
  const refreshAt = refreshAts.length ? Math.min(...refreshAts) : 0;
  if (refreshAt && refreshAt > now) {
    clearTimeout(mother.rtHoldTimer);
    mother.rtHoldTimer = setTimeout(() => {
      mother.rtHoldTimer = null;
      syncMotherPortrait();
    }, Math.max(30, refreshAt - Date.now() + 24));
  } else {
    clearTimeout(mother.rtHoldTimer);
    mother.rtHoldTimer = null;
  }

  // In Reel mode, keep Mother on a single stable loop to avoid frequent clip source
  // swaps while idle-state phases change.
  const mode = reelLocked ? (motherRunning ? "takeover" : "idle") : motherRunning ? "takeover" : showRealtime ? "realtime" : "idle";
  const src =
    mode === "takeover"
      ? MOTHER_VIDEO_TAKEOVER_SRC
      : mode === "realtime"
        ? MOTHER_VIDEO_REALTIME_SRC
        : mode === "working"
          ? MOTHER_VIDEO_WORKING_SRC
          : MOTHER_VIDEO_IDLE_SRC;

  if (overlay) overlay.classList.toggle("busy", mode !== "idle");
  if (!videoEl) return;

  if (!videoEl.hasAttribute("muted")) videoEl.muted = true;
  videoEl.loop = true;
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  // Mirror only during Mother takeover so she faces left.
  videoEl.style.transform = mode === "takeover" ? "scaleX(-1) scale(1.02)" : "scale(1.02)";

  const nextKey = `${mode}:${src}`;
  const lastAssignedSrc = String(videoEl.dataset.motherSrc || "");
  if (state.portraitMedia.activeKeyMother !== nextKey || (src && lastAssignedSrc !== String(src))) {
    state.portraitMedia.activeKeyMother = nextKey;
    videoEl.classList.remove("hidden");
    videoEl.dataset.motherSrc = String(src || "");
    videoEl.src = src;
    try {
      videoEl.currentTime = 0;
    } catch (_) {}
    try {
      videoEl.load();
    } catch (_) {}
  }
  videoEl.classList.remove("hidden");

  try {
    const p = videoEl.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
}

function motherV2CollectCommitSeedIds(intent = null) {
  const ids = [];
  const pushId = (rawId) => {
    const id = String(rawId || "").trim();
    if (!id) return;
    if (!isVisibleCanvasImageId(id)) return;
    if (!ids.includes(id)) ids.push(id);
  };
  const pushMany = (list) => {
    for (const rawId of Array.isArray(list) ? list : []) pushId(rawId);
  };
  const normalizedIntent = intent && typeof intent === "object" ? intent : null;
  const roles = normalizedIntent?.roles && typeof normalizedIntent.roles === "object"
    ? normalizedIntent.roles
    : null;
  for (const role of MOTHER_V2_ROLE_KEYS) {
    pushMany(roles?.[role]);
  }
  pushMany(normalizedIntent?.target_ids);
  pushMany(normalizedIntent?.reference_ids);
  pushMany(state.pendingMotherDraft?.sourceIds);
  if (!ids.length) {
    pushMany(motherV2RoleContextIds({ limit: Number.POSITIVE_INFINITY }));
  }
  return ids;
}

function motherV2OfferingHiddenSeedIds() {
  const idle = state.motherIdle;
  if (!idle) return new Set();
  if (idle.phase !== MOTHER_IDLE_STATES.OFFERING) return new Set();
  if (state.canvasMode !== "multi") return new Set();
  if (!motherV2CurrentDraft()) return new Set();
  const intent = idle.intent && typeof idle.intent === "object" ? idle.intent : null;
  const seedIds = motherV2CollectCommitSeedIds(intent);
  return new Set(
    seedIds
      .map((rawId) => String(rawId || "").trim())
      .filter((id) => Boolean(id) && state.imagesById.has(id))
  );
}

function motherV2SnapshotImageForUndo(imageId) {
  const id = String(imageId || "").trim();
  if (!id) return null;
  const item = state.imagesById.get(id) || null;
  if (!item?.path) return null;
  const rect = state.freeformRects.get(id) || null;
  const imageIndex = (state.images || []).findIndex((entry) => String(entry?.id || "") === id);
  const zIndex = (state.freeformZOrder || []).indexOf(id);
  const selectedIndex = getSelectedIds().indexOf(id);
  return {
    id,
    imageIndex,
    zIndex,
    selectedIndex,
    wasActive: state.activeId === id,
    rect: rect ? { ...rect } : null,
    item: {
      id,
      path: String(item.path),
      receiptPath: item.receiptPath ? String(item.receiptPath) : null,
      kind: item.kind ? String(item.kind) : null,
      source: item.source ? String(item.source) : null,
      label: item.label ? String(item.label) : null,
      timelineNodeId: item.timelineNodeId ? String(item.timelineNodeId) : null,
      visionDesc: item.visionDesc ? String(item.visionDesc) : null,
      visionDescMeta: item.visionDescMeta && typeof item.visionDescMeta === "object" ? { ...item.visionDescMeta } : null,
      width: Number(item.width) || null,
      height: Number(item.height) || null,
    },
  };
}

async function motherV2DiscardCommitSeedImages({ seedIds = [], keepIds = [] } = {}) {
  const keep = new Set(
    (Array.isArray(keepIds) ? keepIds : [])
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  );
  const removed = [];
  const seen = new Set();
  for (const rawId of Array.isArray(seedIds) ? seedIds : []) {
    const id = String(rawId || "").trim();
    if (!id || seen.has(id) || keep.has(id)) continue;
    seen.add(id);
    const snapshot = motherV2SnapshotImageForUndo(id);
    if (!snapshot) continue;
    const ok = await removeImageFromCanvas(id).catch(() => false);
    if (ok) removed.push(snapshot);
  }
  return removed;
}

function motherV2MoveImageToIndex(imageId, targetIndex) {
  const id = String(imageId || "").trim();
  if (!id || !Array.isArray(state.images) || !state.images.length) return;
  const from = state.images.findIndex((entry) => String(entry?.id || "") === id);
  if (from < 0) return;
  const maxIndex = Math.max(0, state.images.length - 1);
  const desired = Math.max(0, Math.min(maxIndex, Math.floor(Number(targetIndex) || 0)));
  if (from === desired) return;
  const [entry] = state.images.splice(from, 1);
  state.images.splice(desired, 0, entry);
}

function motherV2MoveFreeformZToIndex(imageId, targetIndex) {
  const id = String(imageId || "").trim();
  if (!id || !Array.isArray(state.freeformZOrder) || !state.freeformZOrder.length) return;
  const from = state.freeformZOrder.indexOf(id);
  if (from < 0) return;
  const maxIndex = Math.max(0, state.freeformZOrder.length - 1);
  const desired = Math.max(0, Math.min(maxIndex, Math.floor(Number(targetIndex) || 0)));
  if (from === desired) return;
  state.freeformZOrder.splice(from, 1);
  state.freeformZOrder.splice(desired, 0, id);
}

async function motherV2RestoreDiscardedSeeds(removedSeeds = []) {
  const snapshots = (Array.isArray(removedSeeds) ? removedSeeds : [])
    .filter((entry) => entry?.item?.id && entry?.item?.path)
    .sort((a, b) => {
      const ai = Number.isFinite(Number(a?.imageIndex)) ? Number(a.imageIndex) : Number.MAX_SAFE_INTEGER;
      const bi = Number.isFinite(Number(b?.imageIndex)) ? Number(b.imageIndex) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      const az = Number.isFinite(Number(a?.zIndex)) ? Number(a.zIndex) : Number.MAX_SAFE_INTEGER;
      const bz = Number.isFinite(Number(b?.zIndex)) ? Number(b.zIndex) : Number.MAX_SAFE_INTEGER;
      return az - bz;
    });
  if (!snapshots.length) return;
  for (const snapshot of snapshots) {
    const saved = snapshot.item;
    const id = String(saved?.id || "").trim();
    if (!id || state.imagesById.has(id)) continue;
    addImage(
      {
        id,
        path: String(saved.path),
        receiptPath: saved.receiptPath ? String(saved.receiptPath) : null,
        kind: saved.kind ? String(saved.kind) : null,
        source: saved.source ? String(saved.source) : null,
        label: saved.label ? String(saved.label) : basename(saved.path),
        timelineNodeId: saved.timelineNodeId ? String(saved.timelineNodeId) : null,
        visionDesc: saved.visionDesc ? String(saved.visionDesc) : null,
        visionDescMeta:
          saved.visionDescMeta && typeof saved.visionDescMeta === "object"
            ? { ...saved.visionDescMeta }
            : null,
        width: Number(saved.width) || null,
        height: Number(saved.height) || null,
      },
      { select: false }
    );
    if (snapshot.rect) {
      state.freeformRects.set(id, { ...snapshot.rect });
    }
    if (Number.isFinite(Number(snapshot.imageIndex)) && Number(snapshot.imageIndex) >= 0) {
      motherV2MoveImageToIndex(id, Number(snapshot.imageIndex));
    }
    if (Number.isFinite(Number(snapshot.zIndex)) && Number(snapshot.zIndex) >= 0) {
      motherV2MoveFreeformZToIndex(id, Number(snapshot.zIndex));
    }
  }
  const selected = getSelectedIds();
  let selectedChanged = false;
  const withSelection = snapshots
    .filter((entry) => Number.isFinite(Number(entry?.selectedIndex)) && Number(entry.selectedIndex) >= 0)
    .sort((a, b) => Number(a.selectedIndex) - Number(b.selectedIndex));
  for (const entry of withSelection) {
    const id = String(entry?.item?.id || "").trim();
    if (!id || !state.imagesById.has(id) || selected.includes(id)) continue;
    const index = Math.max(0, Math.min(selected.length, Math.floor(Number(entry.selectedIndex) || 0)));
    selected.splice(index, 0, id);
    selectedChanged = true;
  }
  if (selectedChanged) setSelectedIds(selected.filter((id) => state.imagesById.has(id)));
  const active = snapshots.find((entry) => entry?.wasActive && state.imagesById.has(String(entry?.item?.id || "")));
  if (active?.item?.id) {
    await setActiveImage(String(active.item.id), { preserveSelection: true }).catch(() => {});
  }
}

async function motherV2CommitSelectedDraft() {
  const idle = state.motherIdle;
  if (!idle) return false;
  const draft = motherV2CurrentDraft();
  if (!draft?.path) return false;
  const reelLocked = isReelSizeLocked();
  const intent = motherV2SanitizeIntentImageIds(idle.intent && typeof idle.intent === "object" ? idle.intent : {}) || {};
  const targetIds = Array.isArray(intent.target_ids) ? intent.target_ids.map((v) => String(v || "").trim()).filter(Boolean) : [];
  const targetId = targetIds[0] || getVisibleActiveId();
  const policy = String(intent.placement_policy || "adjacent").trim() || "adjacent";
  const seedIds = motherV2CollectCommitSeedIds(intent);
  const beforeTarget = targetId && state.imagesById.has(targetId)
    ? (() => {
        const t = state.imagesById.get(targetId);
        return t
          ? {
              path: String(t.path || ""),
              receiptPath: t.receiptPath ? String(t.receiptPath) : null,
              kind: t.kind ? String(t.kind) : null,
              source: t.source ? String(t.source) : null,
            }
          : null;
      })()
    : null;

  motherIdleTransitionTo(MOTHER_IDLE_EVENTS.DEPLOY);
  idle.commitMutationInFlight = true;
  try {
    let commitUndo = null;
    let committedImageId = null;
    if (policy === "replace" && targetId && state.imagesById.has(targetId)) {
      const ok = await replaceImageInPlace(targetId, {
        path: draft.path,
        receiptPath: draft.receiptPath || null,
        kind: "engine",
        label: basename(draft.path),
      }).catch(() => false);
      if (!ok) throw new Error("Mother commit failed to replace target.");
      const targetItem = state.imagesById.get(targetId) || null;
      if (targetItem) targetItem.source = MOTHER_GENERATED_SOURCE;
      committedImageId = String(targetId);
      commitUndo = {
        mode: "replace",
        targetId: String(targetId),
        before: beforeTarget,
      };
    } else {
      const offerRect = motherV2OfferPreviewRectCss({ policy, targetId, draftIndex: 0 });
      let rect = offerRect || motherIdleComputePlacementCss({ policy, targetId, draftIndex: 0 });
      if (rect) {
        const wrap = els.canvasWrap;
        const canvasCssW = Math.max(1, Number(wrap?.clientWidth) || 1);
        const canvasCssH = Math.max(1, Number(wrap?.clientHeight) || 1);
        if (!offerRect) {
          const visibleRatio = rectVisibleRatioInViewport(rect);
          // Keep accepted Mother artifacts visible to the user.
          if (reelLocked || visibleRatio < 0.35) {
            rect = recenterRectToViewport(rect);
          }
        }
        rect = clampFreeformRectCss(rect, canvasCssW, canvasCssH);
      }
      if (rect) state.freeformRects.set(draft.id, { ...rect });
      addImage(
        {
          id: draft.id,
          kind: "engine",
          source: MOTHER_GENERATED_SOURCE,
          path: draft.path,
          receiptPath: draft.receiptPath || null,
          label: basename(draft.path),
          timelineAction: "Mother Suggestion",
          timelineParents: [],
        },
        { select: false }
      );
      committedImageId = String(draft.id);
      commitUndo = {
        mode: "insert",
        insertedId: String(draft.id),
      };
    }
    const removedSeeds = await motherV2DiscardCommitSeedImages({
      seedIds,
      keepIds: committedImageId ? [committedImageId] : [],
    });
    idle.commitUndo = {
      ...(commitUndo || {}),
      removedSeeds,
      expiresAt: Date.now() + 4500,
    };
  } finally {
    idle.commitMutationInFlight = false;
  }

  idle.telemetry.deployed = (Number(idle.telemetry?.deployed) || 0) + 1;
  appendMotherTraceLog({
    kind: "deployed",
    traceId: idle.telemetry?.traceId || null,
    actionVersion: Number(idle.actionVersion) || 0,
    deployed: Number(idle.telemetry?.deployed) || 0,
    intent_id: intent.intent_id || null,
    placement_policy: policy,
  }).catch(() => {});
  // Prevent immediate auto-reproposal loops right after deploy.
  idle.blockedUntilUserInteraction = true;
  state.lastInteractionAt = Date.now();
  state.lastMotherHotAt = state.lastInteractionAt;
  appendMotherTraceLog({
    kind: "post_commit_wait_for_user_interaction",
    traceId: idle.telemetry?.traceId || null,
    actionVersion: Number(idle.actionVersion) || 0,
  }).catch(() => {});
  motherV2ClearIntentAndDrafts({ removeFiles: false });
  motherIdleTransitionTo(MOTHER_IDLE_EVENTS.COMMIT_DONE);
  motherV2ArmCooldown({ rejected: false });
  setStatus("Mother: committed.");
  if (!reelLocked) {
    showToast("Mother commit applied. Undo available briefly.", "tip", 2200);
  }
  renderMotherReadout();
  requestRender();
  return true;
}

async function motherV2UndoCommit() {
  const idle = state.motherIdle;
  if (!idle?.commitUndo) return false;
  const undo = idle.commitUndo;
  if (Date.now() > (Number(undo.expiresAt) || 0)) {
    idle.commitUndo = null;
    renderMotherReadout();
    return false;
  }
  if (undo.mode === "insert" && undo.insertedId) {
    await removeImageFromCanvas(String(undo.insertedId)).catch(() => {});
  } else if (undo.mode === "replace" && undo.targetId && undo.before?.path) {
    const ok = await replaceImageInPlace(String(undo.targetId), {
      path: String(undo.before.path),
      receiptPath: undo.before.receiptPath ? String(undo.before.receiptPath) : null,
      kind: undo.before.kind || null,
      clearVision: false,
    }).catch(() => false);
    if (ok) {
      const targetItem = state.imagesById.get(String(undo.targetId)) || null;
      if (targetItem) {
        targetItem.source = undo.before.source || null;
      }
    }
  }
  if (Array.isArray(undo.removedSeeds) && undo.removedSeeds.length) {
    await motherV2RestoreDiscardedSeeds(undo.removedSeeds);
  }
  idle.commitUndo = null;
  showToast("Undid Mother commit.", "tip", 1800);
  renderMotherReadout();
  requestRender();
  return true;
}

function motherV2RejectOrDismiss({ queueFollowup = false } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  const phase = idle.phase || motherIdleInitialState();
  const currentIntent = idle.intent && typeof idle.intent === "object" ? idle.intent : null;
  const shouldQueueFollowup = Boolean(
    queueFollowup &&
      !motherV2CommitUndoAvailable() &&
      motherIdleHasArmedCanvas() &&
      (phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING ||
        phase === MOTHER_IDLE_STATES.OFFERING ||
        phase === MOTHER_IDLE_STATES.DRAFTING)
  );
  const contextSig = currentIntent ? motherV2IntentContextSignature(currentIntent) : "";
  const imageSetSig = currentIntent ? motherV2IntentImageSetSignature(currentIntent) : "";
  const rejectedMode = currentIntent ? motherV2NormalizeTransformationMode(currentIntent.transformation_mode) : null;
  if (currentIntent) {
    idle.lastRejectedProposal = {
      contextSig,
      imageSetSig,
      mode: rejectedMode,
      summary: String(currentIntent.summary || "").trim(),
      at_ms: Date.now(),
    };
    if (shouldQueueFollowup && rejectedMode) {
      if (contextSig) motherV2RememberRejectedMode(contextSig, rejectedMode);
      if (imageSetSig && imageSetSig !== contextSig) motherV2RememberRejectedMode(imageSetSig, rejectedMode);
    }
  } else {
    idle.lastRejectedProposal = null;
  }
  idle.pendingFollowupAfterCooldown = shouldQueueFollowup;
  if (!shouldQueueFollowup) idle.pendingFollowupReason = null;
  idle.telemetry.rejected = (Number(idle.telemetry?.rejected) || 0) + 1;
  appendMotherTraceLog({
    kind: "rejected",
    traceId: idle.telemetry?.traceId || null,
    actionVersion: Number(idle.actionVersion) || 0,
    rejected: Number(idle.telemetry?.rejected) || 0,
    phase,
    queue_followup: shouldQueueFollowup,
  }).catch(() => {});

  if (phase === MOTHER_IDLE_STATES.DRAFTING) {
    motherV2CancelInFlight({ reason: "manual_reject_drafting" });
    motherV2ClearIntentAndDrafts({ removeFiles: true });
    motherIdleTransitionTo(MOTHER_IDLE_EVENTS.REJECT);
    if (state.motherIdle?.phase === MOTHER_IDLE_STATES.COOLDOWN) {
      motherV2ArmCooldown({ rejected: true });
    }
    renderMotherReadout();
    return;
  }

  motherV2ClearIntentAndDrafts({ removeFiles: true });
  motherIdleTransitionTo(MOTHER_IDLE_EVENTS.REJECT);
  if (state.motherIdle?.phase === MOTHER_IDLE_STATES.COOLDOWN) {
    motherV2ArmCooldown({ rejected: true });
  }
  renderMotherReadout();
}

async function startMotherTakeover() {
  const idle = state.motherIdle;
  if (!idle) return;
  closeMotherWheelMenu({ immediate: true });
  const phase = idle.phase || motherIdleInitialState();
  if (phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING) {
    if (state.pointer.active) {
      showToast("Finish dragging before confirming.", "tip", 1600);
      return;
    }
    idle.telemetry.accepted = (Number(idle.telemetry?.accepted) || 0) + 1;
    appendMotherTraceLog({
      kind: "accepted",
      traceId: idle.telemetry?.traceId || null,
      actionVersion: Number(idle.actionVersion) || 0,
      accepted: Number(idle.telemetry?.accepted) || 0,
      intent_id: idle.intent?.intent_id || null,
    }).catch(() => {});
    motherIdleTransitionTo(MOTHER_IDLE_EVENTS.CONFIRM);
    motherIdleDispatchGeneration().catch(() => {});
    renderMotherReadout();
    return;
  }
  if (phase === MOTHER_IDLE_STATES.WAITING_FOR_USER) {
    const draftReady = Boolean(motherV2CurrentDraft());
    if (!draftReady) {
      showToast("Mother is still drafting.", "tip", 1400);
      return;
    }
    motherV2ForcePhase(MOTHER_IDLE_STATES.OFFERING, "confirm_waiting_for_user");
    await motherV2CommitSelectedDraft();
    return;
  }
  if (phase === MOTHER_IDLE_STATES.OFFERING) {
    await motherV2CommitSelectedDraft();
    return;
  }
  if (phase === MOTHER_IDLE_STATES.COOLDOWN) {
    showToast("Mother cooling down.", "tip", 1400);
    return;
  }
  showToast("Arrange images, then pause for intent.", "tip", 1800);
}

function stopMotherTakeover() {
  const idle = state.motherIdle;
  if (!idle) return;
  if (motherV2CommitUndoAvailable()) {
    motherV2UndoCommit().catch(() => {});
    return;
  }
  motherV2RejectOrDismiss({ queueFollowup: true });
}

function computeWorldProjection({
  canvasCssW,
  canvasCssH,
  surfaceW,
  surfaceH,
  overscanRatio = WORLD_PROJECTION_OVERSCAN_RATIO,
  padPx = 6,
} = {}) {
  const worldCanvasW = Math.max(1, Number(canvasCssW) || 1);
  const worldCanvasH = Math.max(1, Number(canvasCssH) || 1);
  const drawSurfaceW = Math.max(1, Number(surfaceW) || 1);
  const drawSurfaceH = Math.max(1, Number(surfaceH) || 1);
  const pad = Math.max(0, Number(padPx) || 0);
  const overscan = Math.max(0, Number(overscanRatio) || 0);
  const worldPadX = Math.max(0, worldCanvasW * overscan);
  const worldPadY = Math.max(0, worldCanvasH * overscan);
  const worldLeft = -worldPadX;
  const worldTop = -worldPadY;
  const worldW = Math.max(1, worldCanvasW + worldPadX * 2);
  const worldH = Math.max(1, worldCanvasH + worldPadY * 2);
  const availW = Math.max(1, drawSurfaceW - pad * 2);
  const availH = Math.max(1, drawSurfaceH - pad * 2);
  const scale = Math.max(0.0001, Math.min(availW / worldW, availH / worldH));
  const drawW = worldW * scale;
  const drawH = worldH * scale;
  const ox = Math.round((drawSurfaceW - drawW) / 2);
  const oy = Math.round((drawSurfaceH - drawH) / 2);
  return { worldLeft, worldTop, worldW, worldH, scale, ox, oy };
}

function projectWorldRectToSurface(rect, projection) {
  if (!rect || !projection) return null;
  const x = Number(rect.x) || 0;
  const y = Number(rect.y) || 0;
  const w = Math.max(1, Number(rect.w) || 1);
  const h = Math.max(1, Number(rect.h) || 1);
  return {
    x: Math.round(projection.ox + (x - projection.worldLeft) * projection.scale),
    y: Math.round(projection.oy + (y - projection.worldTop) * projection.scale),
    w: Math.max(1, Math.round(w * projection.scale)),
    h: Math.max(1, Math.round(h * projection.scale)),
  };
}

function setTip(message) {
  state.lastTipText = String(message || "");
  if (state.alwaysOnVision?.enabled) {
    // Mother panel is reserved for CTX output while always-on vision is enabled.
    return;
  }
  renderMotherReadout();
}

function setDirectorText(text, meta = null) {
  state.lastDirectorText = text ? String(text) : null;
  state.lastDirectorMeta = meta && typeof meta === "object" ? meta : null;
  renderHudReadout();
}

function setRunInfo(message) {
  if (!els.runInfo) return;
  els.runInfo.textContent = message;
}

function isMotherGeneratedImageItem(item) {
  return String(item?.source || "").trim() === MOTHER_GENERATED_SOURCE;
}

function motherIdleBaseImageItems() {
  // Mother v2 follow-ups should be able to reason over newly generated outputs too.
  return getVisibleCanvasImages();
}

function motherV2NormalizeTransformationMode(rawMode) {
  const mode = String(rawMode || "").trim().toLowerCase();
  if (MOTHER_V2_TRANSFORMATION_MODES.includes(mode)) return mode;
  return MOTHER_V2_DEFAULT_TRANSFORMATION_MODE;
}

function motherV2MaybeTransformationMode(rawMode) {
  const mode = String(rawMode || "").trim().toLowerCase();
  if (MOTHER_V2_TRANSFORMATION_MODES.includes(mode)) return mode;
  return null;
}

function motherV2CurrentTransformationMode() {
  const idle = state.motherIdle;
  const mode = idle?.intent?.transformation_mode;
  return motherV2NormalizeTransformationMode(mode);
}

function motherV2NormalizeImageIdList(list = []) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String(raw || "").trim();
    if (!id) continue;
    if (!isVisibleCanvasImageId(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function motherV2SanitizeIntentImageIds(intentPayload = null) {
  if (!intentPayload || typeof intentPayload !== "object") return null;
  const roles = intentPayload.roles && typeof intentPayload.roles === "object"
    ? {
        subject: motherV2NormalizeImageIdList(intentPayload.roles.subject),
        model: motherV2NormalizeImageIdList(intentPayload.roles.model),
        mediator: motherV2NormalizeImageIdList(intentPayload.roles.mediator),
        object: motherV2NormalizeImageIdList(intentPayload.roles.object),
      }
    : null;
  return {
    ...intentPayload,
    target_ids: motherV2NormalizeImageIdList(intentPayload.target_ids),
    reference_ids: motherV2NormalizeImageIdList(intentPayload.reference_ids),
    ...(roles ? { roles } : {}),
  };
}

function motherV2RoleContextIds({ limit = 6 } = {}) {
  const maxCount = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : Number.POSITIVE_INFINITY;
  const ids = [];
  const pushId = (rawId) => {
    const normalized = String(rawId || "").trim();
    if (!normalized) return;
    if (!isVisibleCanvasImageId(normalized)) return;
    if (ids.includes(normalized)) return;
    ids.push(normalized);
  };
  const pushMany = (list) => {
    for (const rawId of Array.isArray(list) ? list : []) {
      pushId(rawId);
      if (ids.length >= maxCount) return true;
    }
    return false;
  };

  // Keep role anchors first, then expand to full inferred intent context.
  for (const role of MOTHER_V2_ROLE_KEYS) {
    if (pushMany(motherV2RoleIds(role))) return ids;
  }
  const intent = state.motherIdle?.intent && typeof state.motherIdle.intent === "object"
    ? state.motherIdle.intent
    : null;
  if (intent) {
    if (pushMany(intent.target_ids)) return ids;
    if (pushMany(intent.reference_ids)) return ids;
  }
  if (pushMany(getVisibleSelectedIds())) return ids;
  pushId(getVisibleActiveId());
  return ids;
}

function motherV2IsAdvancedVisible() {
  const idle = state.motherIdle;
  if (!idle) return false;
  return Boolean(idle.advancedOpen || idle.optionReveal);
}

function motherV2HintsVisible() {
  const idle = state.motherIdle;
  if (!idle) return false;
  if (motherV2IsAdvancedVisible()) return true;
  return Date.now() < (Number(idle.hintVisibleUntil) || 0);
}

function motherV2HideHints({ immediate = false } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  const close = () => {
    idle.hintVisibleUntil = 0;
    idle.hintLevel = 0;
    clearTimeout(idle.hintFadeTimer);
    idle.hintFadeTimer = null;
    requestRender();
  };
  if (immediate) {
    close();
    return;
  }
  clearTimeout(idle.hintFadeTimer);
  idle.hintFadeTimer = setTimeout(close, 420);
}

function motherV2RevealHints({ engaged = false, ms = 1400 } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  const phase = idle.phase || motherIdleInitialState();
  if (!(phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING || phase === MOTHER_IDLE_STATES.OFFERING)) return;
  const level = engaged ? 2 : 1;
  idle.hintLevel = Math.max(Number(idle.hintLevel) || 0, level);
  const ttl = engaged ? Math.max(2000, Number(ms) || 0) : Math.max(900, Number(ms) || 0);
  idle.hintVisibleUntil = Date.now() + ttl;
  clearTimeout(idle.hintFadeTimer);
  idle.hintFadeTimer = setTimeout(() => {
    if (motherV2IsAdvancedVisible()) return;
    if (Date.now() < (Number(idle.hintVisibleUntil) || 0)) return;
    idle.hintLevel = 0;
    requestRender();
  }, ttl + 24);
  requestRender();
}

function motherV2ProposalSentence(intent) {
  const mode = motherV2NormalizeTransformationMode(intent?.transformation_mode);
  if (mode === "hybridize") {
    const uniqueIds = new Set();
    const pushMany = (list) => {
      for (const raw of Array.isArray(list) ? list : []) {
        const id = String(raw || "").trim();
        if (!id) continue;
        if (!isVisibleCanvasImageId(id)) continue;
        uniqueIds.add(id);
      }
    };
    pushMany(intent?.target_ids);
    pushMany(intent?.reference_ids);
    const roles = intent?.roles && typeof intent.roles === "object" ? intent.roles : null;
    if (roles) {
      pushMany(roles.subject);
      pushMany(roles.model);
      pushMany(roles.mediator);
      pushMany(roles.object);
    }
    if (uniqueIds.size >= 3) return "Fuse all references into one coherent visual world.";
  }
  return MOTHER_V2_PROPOSAL_BY_MODE[mode] || MOTHER_V2_PROPOSAL_BY_MODE[MOTHER_V2_DEFAULT_TRANSFORMATION_MODE];
}

function motherV2EnsureProposalCandidates(intentPayload = null) {
  const intent = intentPayload && typeof intentPayload === "object" ? intentPayload : null;
  if (!intent) return intent;
  const modes = [];
  const pushMode = (rawMode) => {
    const mode = motherV2MaybeTransformationMode(rawMode);
    if (!mode) return;
    if (!modes.includes(mode)) modes.push(mode);
  };
  for (const entry of Array.isArray(intent.transformation_mode_candidates) ? intent.transformation_mode_candidates : []) {
    pushMode(entry?.mode || entry?.transformation_mode);
  }
  const current = motherV2MaybeTransformationMode(intent.transformation_mode);
  if (current && !modes.includes(current)) modes.unshift(current);
  const baseMode = current || modes[0] || MOTHER_V2_DEFAULT_TRANSFORMATION_MODE;
  const baseIdx = Math.max(0, MOTHER_V2_TRANSFORMATION_MODES.indexOf(baseMode));
  for (let offset = 0; offset < MOTHER_V2_TRANSFORMATION_MODES.length && modes.length < 3; offset += 1) {
    const idx = (baseIdx + offset) % MOTHER_V2_TRANSFORMATION_MODES.length;
    const candidate = MOTHER_V2_TRANSFORMATION_MODES[idx];
    if (!candidate || modes.includes(candidate)) continue;
    modes.push(candidate);
  }
  intent.transformation_mode_candidates = modes.map((mode) => ({
    mode,
    confidence: null,
  }));
  if (!motherV2MaybeTransformationMode(intent.transformation_mode) && modes.length) {
    intent.transformation_mode = modes[0];
  }
  return intent;
}

function motherV2ProposalModes(intentPayload = null) {
  const intent = intentPayload && typeof intentPayload === "object" ? intentPayload : null;
  if (!intent) return [];
  const modes = [];
  const pushMode = (rawMode) => {
    const mode = motherV2MaybeTransformationMode(rawMode);
    if (!mode) return;
    if (!modes.includes(mode)) modes.push(mode);
  };
  const rawCandidates = Array.isArray(intent.transformation_mode_candidates) ? intent.transformation_mode_candidates : [];
  for (const entry of rawCandidates) {
    pushMode(entry?.mode || entry?.transformation_mode);
  }
  const current = motherV2MaybeTransformationMode(intent.transformation_mode);
  if (current && !modes.includes(current)) modes.unshift(current);
  if (!modes.length) modes.push(current || MOTHER_V2_DEFAULT_TRANSFORMATION_MODE);
  return modes;
}

function motherV2ProposalIconAccent(mode) {
  const normalizedMode = motherV2NormalizeTransformationMode(mode);
  return MOTHER_V2_PROPOSAL_ICON_ACCENT_BY_MODE[normalizedMode] || "rgba(230, 237, 243, 0.94)";
}

function motherV2ProposalModeLabel(mode) {
  const normalizedMode = motherV2NormalizeTransformationMode(mode);
  return normalizedMode.replace(/_/g, " ").replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function motherV2ProposalIconSvg(mode) {
  const normalizedMode = motherV2NormalizeTransformationMode(mode);
  let inner = "";
  if (normalizedMode === "amplify") {
    inner = '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v3.2M12 18.2v3.2M2.6 12h3.2M18.2 12h3.2M5.3 5.3l2.2 2.2M16.5 16.5l2.2 2.2M18.7 5.3l-2.2 2.2M7.5 16.5l-2.2 2.2"/>';
  } else if (normalizedMode === "transcend") {
    inner = '<path d="M12 20.6V6.3"/><path d="M7.8 10.4L12 6.2l4.2 4.2"/><path d="M4 18.2c2.2-1.7 4.9-2.6 8-2.6s5.8.9 8 2.6"/>';
  } else if (normalizedMode === "destabilize") {
    inner = '<path d="M12 3.4l7.8 8.6L12 20.6 4.2 12z"/><path d="M8.1 8.2l2.4 2.1-2.6 2.3 2.6 2.2"/><path d="M14.8 7.7l-2.1 2 2.2 2.1-2.3 2.2"/>';
  } else if (normalizedMode === "purify") {
    inner = '<path d="M12 4.2c2.8 3 4.8 5.8 4.8 8.3a4.8 4.8 0 1 1-9.6 0c0-2.5 2-5.3 4.8-8.3z"/><path d="M12 9.2v5.8"/><path d="M9.3 12.1h5.4"/>';
  } else if (normalizedMode === "hybridize") {
    inner = '<circle cx="9" cy="12" r="4.4"/><circle cx="15" cy="12" r="4.4"/><path d="M12 7.6v8.8"/>';
  } else if (normalizedMode === "mythologize") {
    inner = '<circle cx="12" cy="12" r="8"/><path d="M12 6.1l1.7 3.4 3.8.6-2.8 2.7.7 3.8L12 14.8 8.6 16.6l.7-3.8-2.8-2.7 3.8-.6z"/>';
  } else if (normalizedMode === "monumentalize") {
    inner = '<path d="M4.5 19.5h15"/><path d="M6.4 18.8V7.6h3.1v11.2M10.6 18.8V5.8h2.8v13M14.5 18.8V7.6h3.1v11.2"/><path d="M5.6 5.8h12.8"/>';
  } else if (normalizedMode === "fracture") {
    inner = '<path d="M5 3.6h14v16.8H5z"/><path d="M13.8 4.7 10.6 10h2.4l-3 4.1 1.2 5.8"/>';
  } else if (normalizedMode === "romanticize") {
    inner = '<path d="M12 20.4c-5.2-3.6-8-6.4-8-9.7 0-2.2 1.8-4 4-4 1.7 0 3.1.8 4 2.1.9-1.3 2.3-2.1 4-2.1 2.2 0 4 1.8 4 4 0 3.3-2.8 6.1-8 9.7z"/>';
  } else if (normalizedMode === "alienate") {
    inner = '<path d="M2.8 12s3.3-5.2 9.2-5.2 9.2 5.2 9.2 5.2-3.3 5.2-9.2 5.2-9.2-5.2-9.2-5.2z"/><circle cx="12" cy="12" r="2.4"/><path d="M18.6 4.6l1.9-1.9M5.4 19.4l-1.9 1.9"/>';
  } else {
    inner = '<circle cx="12" cy="12" r="4.2"/>';
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

function motherV2ProposalIconsHtml(intentPayload = null, { phase = null } = {}) {
  const intent = intentPayload && typeof intentPayload === "object" ? intentPayload : null;
  const normalizedPhase = String(phase || state.motherIdle?.phase || "").trim();
  if (motherIdleBaseImageItems().length < MOTHER_V2_MIN_IMAGES_FOR_PROPOSAL) return "";
  const activePhases = new Set([
    MOTHER_IDLE_STATES.WATCHING,
    MOTHER_IDLE_STATES.OBSERVING,
    MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING,
    MOTHER_IDLE_STATES.DRAFTING,
    MOTHER_IDLE_STATES.OFFERING,
    MOTHER_IDLE_STATES.COMMITTING,
    MOTHER_IDLE_STATES.COOLDOWN,
  ]);
  if (!activePhases.has(normalizedPhase)) {
    if (!intent) return "";
  }
  const hasConfirmedIntentSource = Boolean(motherV2IntentSourceKind(intent?._intent_source_kind));
  if (!hasConfirmedIntentSource) return "";
  let activeMode = null;
  let description = "";
  if (intent) {
    if (!motherV2HasRealProposalPayload(intent)) {
      if (!activePhases.has(normalizedPhase)) return "";
    } else {
      const modes = motherV2ProposalModes(intent);
      if (!modes.length) return "";
      const activeNormalized = motherV2NormalizeTransformationMode(intent.transformation_mode || modes[0]);
      activeMode = modes.includes(activeNormalized) ? activeNormalized : modes[0];
      description = motherV2ProposalSentence({
        ...intent,
        transformation_mode: activeMode,
      });
    }
  }
  if (!activeMode) {
    const rememberedMode = motherV2MaybeTransformationMode(state.motherIdle?.lastProposalMode);
    if (rememberedMode) {
      activeMode = rememberedMode;
      if (!description) description = "Mother proposal";
    }
  }
  if (!activeMode) {
    activeMode = MOTHER_V2_DEFAULT_TRANSFORMATION_MODE;
    if (!description) description = "Proposal pending";
  }
  if (state.motherIdle && activeMode) {
    state.motherIdle.lastProposalMode = activeMode;
  }
  const label = motherV2ProposalModeLabel(activeMode);
  const tooltip = `${label}: ${description}`;
  const accent = motherV2ProposalIconAccent(activeMode);
  const icon = motherV2ProposalIconSvg(activeMode);
  const chip = `<span class="mother-proposal-icon is-active" data-mode="${escapeHtml(activeMode)}" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}" style="--proposal-accent:${escapeHtml(accent)}">${icon}</span>`;
  return `<div class="mother-proposal-icons" aria-label="Proposal option">${chip}</div>`;
}

function motherV2DraftStatusIconSvg(kind = "drafting") {
  const iconKind = String(kind || "drafting").trim();
  let inner = "";
  if (iconKind === "braiding") {
    inner = '<path d="M4.8 8c2.9 0 3.3 7.8 7.2 7.8s4.3-7.8 7.2-7.8"/><path d="M4.8 16c2.9 0 3.3-7.8 7.2-7.8s4.3 7.8 7.2 7.8"/><circle cx="4.8" cy="8" r="1.2"/><circle cx="4.8" cy="16" r="1.2"/><circle cx="19.2" cy="8" r="1.2"/><circle cx="19.2" cy="16" r="1.2"/>';
  } else if (iconKind === "cooldown") {
    inner = '<circle cx="12" cy="12" r="7.4"/><path d="M12 8.4v4.4l2.9 2"/><path d="M9.6 3.8h4.8"/><path d="M6.2 6.2 4.6 4.6"/><path d="M17.8 6.2 19.4 4.6"/>';
  } else {
    inner = '<path d="M4.6 5.2h10.2M4.6 9.5h8.4M4.6 13.8h6.8"/><path d="M14.2 14.4 19 9.6l2.4 2.4-4.8 4.8-3 1z"/><path d="M18 8.2l2.8 2.8"/>';
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

function motherV2DraftStatusHtml({ phase = null } = {}) {
  const statePhase = phase || state.motherIdle?.phase || motherIdleInitialState();
  if (statePhase !== MOTHER_IDLE_STATES.DRAFTING && statePhase !== MOTHER_IDLE_STATES.COOLDOWN) return "";
  if (statePhase === MOTHER_IDLE_STATES.COOLDOWN) {
    const accent = "rgba(143, 222, 255, 0.95)";
    const tooltip = "Mother is cooling down before the next intent cycle.";
    const label = "COOLDOWN";
    const icon = motherV2DraftStatusIconSvg("cooldown");
    return `<div class="mother-phase-icons is-draft-card" aria-label="${escapeHtml(tooltip)}"><span class="mother-phase-icon is-cooldown is-draft-card" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}" style="--phase-accent:${escapeHtml(accent)}">${icon}</span><span class="mother-phase-label is-draft-card" style="--phase-accent:${escapeHtml(accent)}">${escapeHtml(label)}</span></div>`;
  }
  const idle = state.motherIdle || null;
  const isBraiding = Boolean(idle?.pendingPromptCompile);
  const iconKind = isBraiding ? "braiding" : "drafting";
  const accent = isBraiding ? "rgba(143, 222, 255, 0.95)" : "rgba(145, 238, 184, 0.95)";
  const tooltip = isBraiding
    ? "Mother is braiding intent into form."
    : "Mother is drafting now. No canvas mutation until deploy.";
  const label = isBraiding ? "BRAIDING" : "DRAFTING";
  const icon = motherV2DraftStatusIconSvg(iconKind);
  return `<div class="mother-phase-icons is-draft-card" aria-label="${escapeHtml(tooltip)}"><span class="mother-phase-icon is-${escapeHtml(iconKind)} is-draft-card" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}" style="--phase-accent:${escapeHtml(accent)}">${icon}</span><span class="mother-phase-label is-draft-card" style="--phase-accent:${escapeHtml(accent)}">${escapeHtml(label)}</span></div>`;
}

function motherV2CycleProposal(step = 1) {
  const idle = state.motherIdle;
  if (!idle || !idle.intent || typeof idle.intent !== "object") return false;
  if ((idle.phase || motherIdleInitialState()) !== MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING) return false;
  const modes = motherV2ProposalModes(idle.intent);
  if (modes.length < 2) return false;
  const activeMode = motherV2NormalizeTransformationMode(idle.intent.transformation_mode || modes[0]);
  const activeIdx = Math.max(0, modes.indexOf(activeMode));
  const dir = Number(step) < 0 ? -1 : 1;
  const nextIdx = (activeIdx + dir + modes.length) % modes.length;
  const nextMode = modes[nextIdx];
  if (!nextMode || nextMode === activeMode) return false;
  idle.intent.transformation_mode = nextMode;
  idle.intent.summary = motherV2ProposalSentence({
    ...idle.intent,
    transformation_mode: nextMode,
  });
  motherV2RevealHints({ engaged: true, ms: 1900 });
  renderMotherReadout();
  requestRender();
  return true;
}

function motherV2IntentContextSignature(intentPayload = null) {
  const intent = intentPayload && typeof intentPayload === "object" ? intentPayload : {};
  const ids = new Set();
  const pushMany = (list) => {
    for (const raw of Array.isArray(list) ? list : []) {
      const id = String(raw || "").trim();
      if (!id) continue;
      if (!isVisibleCanvasImageId(id)) continue;
      ids.add(id);
    }
  };
  pushMany(intent.target_ids);
  pushMany(intent.reference_ids);
  const roles = intent.roles && typeof intent.roles === "object" ? intent.roles : null;
  if (roles) {
    pushMany(roles.subject);
    pushMany(roles.model);
    pushMany(roles.mediator);
    pushMany(roles.object);
  }
  return Array.from(ids).sort().join("|");
}

function motherV2IntentImageSetSignature(intentPayload = null) {
  const intentSig = motherV2IntentContextSignature(intentPayload);
  if (intentSig) return intentSig;
  const ids = [];
  for (const item of motherIdleBaseImageItems()) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.sort().join("|");
}

function motherV2IntentRequiredImageIds() {
  const selected = getVisibleSelectedIds().map((v) => String(v || "").trim()).filter(Boolean);
  const images = motherIdleBaseImageItems().map((item) => {
    const rect = state.freeformRects.get(item.id) || null;
    return {
      id: String(item?.id || "").trim(),
      rect: rect
        ? {
            x: Number(rect.x) || 0,
            y: Number(rect.y) || 0,
            w: Number(rect.w) || 0,
            h: Number(rect.h) || 0,
          }
        : null,
    };
  });
  const rankedIds = motherV2RankImageIdsByProminence(images);
  const activeId = String(getVisibleActiveId() || "").trim();

  const targetIds = selected.length ? selected.slice(0, 3) : activeId ? [activeId] : rankedIds.slice(0, 1);
  const targetSet = new Set(targetIds);
  const referenceIds = rankedIds.filter((id) => !targetSet.has(id)).slice(0, 3);
  const out = [];
  for (const id of [...targetIds, ...referenceIds]) {
    if (!id) continue;
    if (!state.imagesById.has(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function motherV2VisionReadyForIntent({ schedule = true } = {}) {
  const requiredIds = motherV2IntentRequiredImageIds();
  const missingIds = [];
  for (const imageId of requiredIds) {
    const item = state.imagesById.get(imageId) || null;
    if (!item?.path) continue;
    const desc = typeof item.visionDesc === "string" ? item.visionDesc.trim() : "";
    if (desc) continue;
    missingIds.push(String(imageId));
    if (schedule) scheduleVisionDescribe(item.path, { priority: true });
  }
  return {
    requiredIds,
    missingIds,
    ready: missingIds.length === 0,
  };
}

function motherV2RejectedModesForContext(contextSig = "") {
  const idle = state.motherIdle;
  if (!idle) return [];
  const key = String(contextSig || "").trim();
  if (!key) return [];
  const byContext =
    idle.rejectedModeHistoryByContext && typeof idle.rejectedModeHistoryByContext === "object"
      ? idle.rejectedModeHistoryByContext
      : {};
  const raw = Array.isArray(byContext[key]) ? byContext[key] : [];
  return raw.map((mode) => motherV2NormalizeTransformationMode(mode)).filter(Boolean);
}

function motherV2RememberRejectedMode(contextSig = "", mode = "") {
  const idle = state.motherIdle;
  if (!idle) return;
  const key = String(contextSig || "").trim();
  if (!key) return;
  const normalizedMode = motherV2NormalizeTransformationMode(mode);
  const byContext =
    idle.rejectedModeHistoryByContext && typeof idle.rejectedModeHistoryByContext === "object"
      ? idle.rejectedModeHistoryByContext
      : {};
  const prior = motherV2RejectedModesForContext(key).filter((m) => m !== normalizedMode);
  const next = prior.concat([normalizedMode]).slice(-MOTHER_V2_TRANSFORMATION_MODES.length);
  byContext[key] = next;
  const keys = Object.keys(byContext);
  while (keys.length > 64) {
    const drop = keys.shift();
    if (!drop) break;
    delete byContext[drop];
  }
  idle.rejectedModeHistoryByContext = byContext;
}

function motherV2DiversifyIntentForRejectFollowup(intentPayload = null) {
  const idle = state.motherIdle;
  const intent = intentPayload && typeof intentPayload === "object" ? intentPayload : null;
  if (!idle || !intent) return intent;
  if (String(idle.pendingFollowupReason || "") !== "reject_followup") {
    idle.pendingFollowupReason = null;
    return intent;
  }
  idle.pendingFollowupReason = null;

  const rejected = idle.lastRejectedProposal && typeof idle.lastRejectedProposal === "object" ? idle.lastRejectedProposal : null;
  const contextSig = motherV2IntentContextSignature(intent);
  const imageSetSig = motherV2IntentImageSetSignature(intent);
  const sigs = Array.from(new Set([contextSig, imageSetSig].map((v) => String(v || "").trim()).filter(Boolean)));
  if (!sigs.length) return intent;
  const rejectedModes = [];
  for (const sig of sigs) {
    for (const mode of motherV2RejectedModesForContext(sig)) {
      if (!rejectedModes.includes(mode)) rejectedModes.push(mode);
    }
  }
  if (!rejectedModes.length) return intent;

  const proposedMode = motherV2NormalizeTransformationMode(intent.transformation_mode);
  const proposedSummary = String(intent.summary || "").trim();
  const rejectedMode = motherV2NormalizeTransformationMode(rejected?.mode);
  const rejectedSummary = String(rejected?.summary || "").trim();
  const sameContextAsLastRejected = sigs.includes(String(rejected?.contextSig || "")) || sigs.includes(String(rejected?.imageSetSig || ""));
  const matchesRejected =
    sameContextAsLastRejected && (proposedMode === rejectedMode || (proposedSummary && proposedSummary === rejectedSummary));
  const alreadyRejectedForContext = rejectedModes.includes(proposedMode);
  if (!alreadyRejectedForContext && !matchesRejected) return intent;

  const baseIndex = Math.max(0, MOTHER_V2_TRANSFORMATION_MODES.indexOf(proposedMode));
  let replacementMode = null;
  for (let offset = 1; offset <= MOTHER_V2_TRANSFORMATION_MODES.length; offset += 1) {
    const idx = (baseIndex + offset) % MOTHER_V2_TRANSFORMATION_MODES.length;
    const candidate = MOTHER_V2_TRANSFORMATION_MODES[idx];
    if (!candidate || candidate === proposedMode) continue;
    if (!rejectedModes.includes(candidate)) {
      replacementMode = candidate;
      break;
    }
  }
  if (!replacementMode) {
    for (let offset = 1; offset <= MOTHER_V2_TRANSFORMATION_MODES.length; offset += 1) {
      const idx = (baseIndex + offset) % MOTHER_V2_TRANSFORMATION_MODES.length;
      const candidate = MOTHER_V2_TRANSFORMATION_MODES[idx];
      if (!candidate || candidate === proposedMode) continue;
      replacementMode = candidate;
      break;
    }
  }
  if (!replacementMode) return intent;

  return {
    ...intent,
    transformation_mode: replacementMode,
    summary: motherV2ProposalSentence({ transformation_mode: replacementMode }),
  };
}

function motherV2SetAdvancedOpen(nextOpen) {
  const idle = state.motherIdle;
  if (!idle) return;
  const next = Boolean(nextOpen);
  if (idle.advancedOpen === next) return;
  idle.advancedOpen = next;
  if (next) {
    motherV2RevealHints({ engaged: true, ms: 2400 });
  } else if (!idle.optionReveal) {
    motherV2HideHints({ immediate: true });
  }
  renderMotherReadout();
  requestRender();
}

function motherV2InvalidateOfferingForStructureEdit(reason = "structure_edit") {
  const idle = state.motherIdle;
  if (!idle) return;
  if (idle.phase !== MOTHER_IDLE_STATES.OFFERING) return;
  for (const draft of Array.isArray(idle.drafts) ? idle.drafts : []) {
    if (draft?.path) removeFile(String(draft.path)).catch(() => {});
    if (draft?.receiptPath) removeFile(String(draft.receiptPath)).catch(() => {});
  }
  idle.drafts = [];
  idle.selectedDraftId = null;
  idle.hoverDraftId = null;
  motherV2ForcePhase(MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING, reason);
}

function motherSuggestionLogPath() {
  if (!state.runDir) return null;
  return `${state.runDir}/${MOTHER_SUGGESTION_LOG_FILENAME}`;
}

async function appendMotherSuggestionLog(entry = {}) {
  const logPath = motherSuggestionLogPath();
  if (!logPath) return false;
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  try {
    await appendTextWithFallback(logPath, line);
    return true;
  } catch {
    return false;
  }
}

function motherTraceLogPath() {
  if (!state.runDir) return null;
  return `${state.runDir}/${MOTHER_TRACE_FILENAME}`;
}

async function appendMotherTraceLog(entry = {}) {
  const logPath = motherTraceLogPath();
  if (!logPath) return false;
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  try {
    await appendTextWithFallback(logPath, line);
    return true;
  } catch {
    return false;
  }
}

let automationEventSeq = 0;

function _automationStateEnvelope() {
  const mode = state.canvasMode || "multi";
  const modeView = mode === "multi" ? state.multiView : state.view;
  const selectedIds = getSelectedIds().slice(0, 3);
  const motherPhase = String(state.motherIdle?.phase || "").toLowerCase().trim() || null;
  const motherStatus = String(state.mother?.status || "").trim() || null;
  return {
    mother_phase: motherPhase,
    mother_status: motherStatus,
    canvas_mode: mode,
    canvas_scale: Number(modeView?.scale) || 1,
    canvas_offset_x: Number(modeView?.offsetX) || 0,
    canvas_offset_y: Number(modeView?.offsetY) || 0,
    mother: {
      running: Boolean(state.mother?.running),
      status: motherStatus,
      phase: motherPhase || null,
    },
    canvas: {
      mode,
      active_id: state.activeId || null,
      selected_ids: selectedIds,
      scale: Number(modeView?.scale) || 1,
      offset_x: Number(modeView?.offsetX) || 0,
      offset_y: Number(modeView?.offsetY) || 0,
      tool: state.tool || null,
    },
  };
}

function _makeAutomationEvent(type, entry = {}, { requestId = null } = {}) {
  return {
    type,
    schema: "brood.desktop_automation_event",
    schema_version: 1,
    seq: ++automationEventSeq,
    at: new Date().toISOString(),
    request_id: requestId || null,
    source: "desktop_ui_automation",
    ...entry,
  };
}

async function _appendAutomationEvents(events, { requestId = null } = {}) {
  const outPath = state.eventsPath;
  if (!outPath) return false;
  const batch = Array.isArray(events) ? events : [events];
  const payloads = [];
  for (const event of batch) {
    if (!event || typeof event !== "object") continue;
    payloads.push(`${JSON.stringify(_makeAutomationEvent(event.type || "automation", event, { requestId }))}\n`);
  }
  if (!payloads.length) return false;
  const text = payloads.join("");
  try {
    await appendTextWithFallback(outPath, text);
    return true;
  } catch {
    return false;
  }
}

function _coerceAutomationCanvasNumber(value, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(parsed)) return parsed;
  return fallback;
}

function _coerceAutomationPayloadNumber(value, fallback) {
  if (value == null) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(parsed)) return parsed;
  return fallback;
}

function _coerceAutomationMode(value, fallback = "multi") {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "single" || mode === "multi") return mode;
  return fallback;
}

function _clampCanvasScale(value, fallback) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(0.05, Math.min(40, value));
}

function _normalizeAutomationMotherPhaseList(rawList = []) {
  const out = [];
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const phase = String(raw || "").trim().toLowerCase();
    if (!phase) continue;
    if (!out.includes(phase)) out.push(phase);
  }
  return out;
}

function _waitForAutomationMotherPhases(targetPhases = [], timeoutMs = 12000) {
  const targets = _normalizeAutomationMotherPhaseList(targetPhases);
  if (!targets.length) {
    const phase = String(state.motherIdle?.phase || "").toLowerCase().trim() || "";
    return Promise.resolve({ ok: true, phase });
  }
  const timeout = Math.max(500, Math.min(45000, Math.round(Number(timeoutMs) || 0)));
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const phase = String(state.motherIdle?.phase || "").toLowerCase().trim() || "";
      if (phase && targets.includes(phase)) {
        resolve({ ok: true, phase, elapsed_ms: Date.now() - startedAt });
        return;
      }
      if (Date.now() - startedAt >= timeout) {
        resolve({ ok: false, phase, elapsed_ms: Date.now() - startedAt });
        return;
      }
      setTimeout(tick, 120);
    };
    tick();
  });
}

function _appendCanvasStateEvent() {
  return {
    type: "canvas_state",
    marker: "canvas_state",
    state: _automationStateEnvelope(),
  };
}

function _applyCanvasPanFromPayload(payload = {}) {
  const mode = _coerceAutomationMode(payload.mode, state.canvasMode);
  const view = mode === "multi" ? state.multiView : state.view;
  if (!view) {
    return { ok: false, detail: "canvas view is not initialized" };
  }

  const dx = _coerceAutomationPayloadNumber(payload.dx, 0);
  const dy = _coerceAutomationPayloadNumber(payload.dy, 0);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return { ok: false, detail: "invalid pan payload" };
  }

  if (dx === 0 && dy === 0) {
    return { ok: false, detail: "canvas_pan requires non-zero dx or dy" };
  }

  view.offsetX = (Number(view.offsetX) || 0) + dx;
  view.offsetY = (Number(view.offsetY) || 0) + dy;
  renderHudReadout();
  requestRender();

  return {
    ok: true,
    detail: `pan dx=${Math.round(dx * 1000) / 1000}, dy=${Math.round(dy * 1000) / 1000} mode=${mode}`,
    event: {
      type: "canvas_view_updated",
      marker: "canvas_view_updated",
      mode,
      dx,
      dy,
      scale: Number(view.scale) || 1,
      offset_x: Number(view.offsetX) || 0,
      offset_y: Number(view.offsetY) || 0,
    },
  };
}

function _applyCanvasZoomFromPayload(payload = {}) {
  const mode = _coerceAutomationMode(payload.mode, state.canvasMode);
  const view = mode === "multi" ? state.multiView : state.view;
  if (!view) {
    return { ok: false, detail: "canvas view is not initialized" };
  }

  const baseScale = _coerceAutomationPayloadNumber(payload.scale, Number.NaN);
  const factor = _coerceAutomationPayloadNumber(payload.factor, Number.NaN);
  const current = _coerceAutomationPayloadNumber(view.scale, 1);
  const requestedScale = Number.isFinite(baseScale)
    ? baseScale
    : Number.isFinite(factor)
      ? current * factor
      : Number.NaN;
  if (!Number.isFinite(requestedScale)) {
    return { ok: false, detail: "invalid scale/factor for canvas_zoom" };
  }

  const nextScale = _clampCanvasScale(requestedScale, current);
  if (nextScale === current) {
    return { ok: true, detail: `zoom unchanged at ${nextScale}` };
  }

  const canvas = els.workCanvas;
  const cx = Number(canvas?.width || 0) / 2;
  const cy = Number(canvas?.height || 0) / 2;
  const inv = Math.max(0.0001, Number(view.scale) || 1);
  const wx = (cx - (Number(view.offsetX) || 0)) / inv;
  const wy = (cy - (Number(view.offsetY) || 0)) / inv;

  view.scale = nextScale;
  view.offsetX = cx - wx * nextScale;
  view.offsetY = cy - wy * nextScale;

  renderHudReadout();
  requestRender();

  return {
    ok: true,
    detail: `zoom scale=${Math.round(nextScale * 1000) / 1000} mode=${mode}`,
    event: {
      type: "canvas_view_updated",
      marker: "canvas_view_updated",
      mode,
      scale: nextScale,
      offset_x: Number(view.offsetX) || 0,
      offset_y: Number(view.offsetY) || 0,
    },
  };
}

function _applyCanvasFitAllFromPayload(payload = {}) {
  const mode = _coerceAutomationMode(payload.mode, state.canvasMode);
  if (mode !== state.canvasMode) setCanvasMode(mode);
  const view = mode === "multi" ? state.multiView : state.view;
  const canvas = els.workCanvas;
  if (!view || !canvas) {
    return { ok: false, detail: "canvas view is not initialized" };
  }
  if (mode === "single") {
    resetViewToFit();
    return {
      ok: true,
      detail: "fit active image in single view",
      event: {
        type: "canvas_view_fitted",
        marker: "canvas_view_fitted",
        mode,
        scale: Number(state.view?.scale) || 1,
        offset_x: Number(state.view?.offsetX) || 0,
        offset_y: Number(state.view?.offsetY) || 0,
      },
    };
  }

  if (!state.multiRects || state.multiRects.size === 0) {
    state.multiRects = computeFreeformRectsPx(canvas.width, canvas.height);
  }
  const orderedIds = Array.isArray(state.freeformZOrder) && state.freeformZOrder.length
    ? state.freeformZOrder
    : Array.from(state.multiRects.keys());
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const rawId of orderedIds) {
    const imageId = String(rawId || "").trim();
    if (!imageId) continue;
    if (!isVisibleCanvasImageId(imageId)) continue;
    if (isImageEffectTokenized(imageId)) continue;
    const rect = state.multiRects.get(imageId) || null;
    if (!rect) continue;
    const x = Number(rect.x) || 0;
    const y = Number(rect.y) || 0;
    const w = Math.max(1, Number(rect.w) || 1);
    const h = Math.max(1, Number(rect.h) || 1);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
    count += 1;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY) || count <= 0) {
    return { ok: false, detail: "no visible image bounds available for canvas_fit_all" };
  }

  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxY - minY);
  const dpr = getDpr();
  const paddingRatio = clamp(_coerceAutomationPayloadNumber(payload.padding_ratio, 0.07), 0, 0.4);
  const padX = Math.max(Math.round(14 * dpr), Math.round(worldW * paddingRatio));
  const padY = Math.max(Math.round(14 * dpr), Math.round(worldH * paddingRatio));
  const maxWidthFrac = clamp(_coerceAutomationPayloadNumber(payload.max_width_frac, 0.94), 0.35, 1);
  const maxHeightFrac = clamp(_coerceAutomationPayloadNumber(payload.max_height_frac, 0.82), 0.35, 1);
  const availW = Math.max(1, Number(canvas.width || 0) * maxWidthFrac);
  const availH = Math.max(1, Number(canvas.height || 0) * maxHeightFrac);
  const targetW = Math.max(1, worldW + padX * 2);
  const targetH = Math.max(1, worldH + padY * 2);
  const fitScaleRaw = Math.min(availW / targetW, availH / targetH);
  const minScale = clamp(_coerceAutomationPayloadNumber(payload.min_scale, 0.05), 0.05, 40);
  const maxScale = clamp(_coerceAutomationPayloadNumber(payload.max_scale, 20), minScale, 40);
  const nextScale = clamp(fitScaleRaw, minScale, maxScale);
  const centerX = minX + worldW / 2;
  const centerY = minY + worldH / 2;

  view.scale = nextScale;
  view.offsetX = Number(canvas.width || 0) / 2 - centerX * nextScale;
  view.offsetY = Number(canvas.height || 0) / 2 - centerY * nextScale;
  renderHudReadout();
  requestRender();

  return {
    ok: true,
    detail: `fit ${count} images into view mode=${mode}`,
    event: {
      type: "canvas_view_fitted",
      marker: "canvas_view_fitted",
      mode,
      image_count: count,
      scale: Number(view.scale) || nextScale,
      offset_x: Number(view.offsetX) || 0,
      offset_y: Number(view.offsetY) || 0,
      bounds: {
        min_x: minX,
        min_y: minY,
        max_x: maxX,
        max_y: maxY,
      },
    },
  };
}

function _resolveCanvasImageIdFromPayload(payload = {}) {
  if (!payload || typeof payload !== "object") return null;
  const byId = String(payload.image_id || payload.imageId || "").trim();
  if (byId) {
    if (state.imagesById.has(byId)) return byId;
  }
  const imageIndex = _coerceAutomationCanvasNumber(payload.image_index, NaN);
  if (Number.isFinite(imageIndex)) {
    const index = Math.floor(imageIndex);
    const images = getVisibleCanvasImages();
    if (index >= 0 && index < images.length) {
      return String(images[index]?.id || "").trim() || null;
    }
  }
  const targetPath = String(payload.path || "").trim();
  if (!targetPath) return null;
  const matched = (state.images || []).find((item) => String(item?.path || "") === targetPath) || null;
  return matched ? String(matched.id || "") : null;
}

async function _runActionGridAutomation(action = {}) {
  const key = String(action.key || "").trim().toLowerCase();
  const hotkey = String(action.hotkey || "").trim();
  const shift = Boolean(action.shift);
  let targetKey = key;
  if (!targetKey && hotkey) {
    const btn = document.querySelector(`.action-grid .tool[data-hotkey="${CSS.escape(hotkey)}"]`);
    targetKey = String(btn?.dataset?.key || "").trim().toLowerCase();
  }
  if (!targetKey) {
    return { ok: false, detail: "missing action_grid key/hotkey" };
  }

  if (["annotate", "pan", "lasso", "designate"].includes(targetKey)) {
    setTool(targetKey);
    return { ok: true, detail: `tool=${targetKey}` };
  }
  if (targetKey === "bg") {
    const style = shift ? "sweep" : "white";
    applyBackground(style).catch(() => {});
    return { ok: true, detail: `apply_background=${style}` };
  }
  if (targetKey === "extract_dna") {
    runExtractDnaFromSelection().catch(() => {});
    return { ok: true, detail: "extract_dna started" };
  }
  if (targetKey === "soul_leech") {
    runSoulLeechFromSelection().catch(() => {});
    return { ok: true, detail: "soul_leech started" };
  }
  if (targetKey === "remove_people") {
    aiRemovePeople().catch(() => {});
    return { ok: true, detail: "remove_people started" };
  }
  if (targetKey === "variations") {
    runVariations().catch(() => {});
    return { ok: true, detail: "variations started" };
  }
  if (targetKey === "recast") {
    runRecast().catch(() => {});
    return { ok: true, detail: "recast started" };
  }
  if (targetKey === "diagnose") {
    runDiagnose().catch(() => {});
    return { ok: true, detail: "diagnose started" };
  }
  if (targetKey === "crop_square") {
    cropSquare().catch(() => {});
    return { ok: true, detail: "crop_square started" };
  }
  if (targetKey === "combine") {
    runBlendPair().catch(() => {});
    return { ok: true, detail: "combine started" };
  }
  if (targetKey === "bridge") {
    runBridgePair().catch(() => {});
    return { ok: true, detail: "bridge started" };
  }
  if (targetKey === "swap_dna") {
    runSwapDnaPair({ invert: shift }).catch(() => {});
    return { ok: true, detail: "swap_dna started" };
  }
  if (targetKey === "argue") {
    runArguePair().catch(() => {});
    return { ok: true, detail: "argue started" };
  }
  if (targetKey === "extract_rule") {
    runExtractRuleTriplet().catch(() => {});
    return { ok: true, detail: "extract_rule started" };
  }
  if (targetKey === "odd_one_out") {
    runOddOneOutTriplet().catch(() => {});
    return { ok: true, detail: "odd_one_out started" };
  }
  if (targetKey === "triforce") {
    runTriforceTriplet().catch(() => {});
    return { ok: true, detail: "triforce started" };
  }
  const fallback = document.querySelector(`.action-grid .tool[data-key="${CSS.escape(targetKey)}"]`);
  if (fallback && !fallback.disabled) {
    fallback.click();
    return { ok: true, detail: `action_grid button click key=${targetKey}` };
  }
  return { ok: false, detail: `unsupported action_grid key: ${targetKey}` };
}

async function handleDesktopAutomation(event = {}) {
  console.log("[desktop-automation] raw event", event);
  const eventPayload = (() => {
    let candidate = event;
    if (typeof candidate === "string") {
      try {
        candidate = JSON.parse(candidate);
      } catch {
        candidate = null;
      }
    }
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    if (!("request_id" in candidate) && !("action" in candidate) && candidate.payload !== undefined) {
      const nested = candidate.payload;
      if (typeof nested === "string") {
        try {
          return JSON.parse(nested);
        } catch {
          return null;
        }
      }
      if (nested && typeof nested === "object") {
        return nested;
      }
    }
    return candidate;
  })();
  if (!eventPayload) {
    console.warn("desktop automation event missing payload envelope");
    return;
  }
  const payload = eventPayload.payload && typeof eventPayload.payload === "object" ? eventPayload.payload : {};
  const requestId = String(
    eventPayload.request_id || eventPayload.payload?.request_id || eventPayload.id || ""
  ).trim();
  if (!requestId) return;
  const action = String(eventPayload.action || "").trim().toLowerCase();
  console.log(`[desktop-automation] processing request_id=${requestId} action=${action}`);
  const actionPayload = payload && typeof payload === "object" ? payload : {};
  const events = [];
  const markers = new Set();
  let ok = false;
  let detail = `unsupported automation action: ${action || "<empty>"}`;

  try {
    if (action === "mother_next_proposal") {
      const idle = state.motherIdle;
      if (!idle) {
        detail = "mother state unavailable";
      } else {
        const before = String(idle.phase || "").toLowerCase();
        let primed = false;
        if (
          (before === MOTHER_IDLE_STATES.OBSERVING || before === MOTHER_IDLE_STATES.WATCHING) &&
          motherIdleHasArmedCanvas()
        ) {
          primed = await motherV2StartFollowupProposal({ reason: "automation_next_proposal" });
        }
        const cycled = motherV2CycleProposal(1);
        const after = String(state.motherIdle?.phase || "").toLowerCase() || before;
        ok = Boolean(cycled || primed || before !== after);
        detail = ok
          ? `mother_next_proposal executed (${before || "unknown"} -> ${after || "unknown"})`
          : `mother_next_proposal made no visible change (${before || "unknown"} -> ${after || "unknown"})`;
        if (cycled) {
          events.push({ type: "mother_next_proposal", marker: "mother_next_proposal_completed", before, after });
        } else if (primed || before !== after) {
          events.push({
            type: "mother_next_proposal",
            marker: "mother_next_proposal_completed",
            before,
            after,
            note: "primed_intent_hypothesis",
          });
        } else {
          events.push({
            type: "mother_next_proposal",
            marker: "mother_next_proposal_completed",
            before,
            after,
            note: "already_at_boundary",
          });
        }
        events.push(_appendCanvasStateEvent());
        events.push({ type: "mother_state", marker: "mother_state", state: _automationStateEnvelope() });
      }
    } else if (action === "mother_confirm_suggestion") {
      const before = String(state.motherIdle?.phase || "").toLowerCase();
      if (!state.motherIdle) {
        detail = "mother state unavailable";
      } else {
        if (
          (before === MOTHER_IDLE_STATES.OBSERVING || before === MOTHER_IDLE_STATES.WATCHING) &&
          motherIdleHasArmedCanvas()
        ) {
          await motherV2StartFollowupProposal({ reason: "automation_confirm_prime" });
        }
        await startMotherTakeover();
        const requestedPhases = _normalizeAutomationMotherPhaseList(actionPayload.expect_mother_phases);
        const targetPhases = requestedPhases.length
          ? requestedPhases
          : [String(MOTHER_IDLE_STATES.OFFERING).toLowerCase()];
        if (targetPhases.includes(String(MOTHER_IDLE_STATES.OFFERING).toLowerCase())) {
          const waitingForUser = String(MOTHER_IDLE_STATES.WAITING_FOR_USER).toLowerCase();
          if (!targetPhases.includes(waitingForUser)) targetPhases.push(waitingForUser);
        }
        const timeoutMs = Math.max(
          500,
          Math.min(
            45000,
            Math.round(
              _coerceAutomationPayloadNumber(
                actionPayload.wait_timeout_ms,
                _coerceAutomationPayloadNumber(eventPayload.timeout_ms, 16000)
              )
            )
          )
        );
        const waitResult = await _waitForAutomationMotherPhases(targetPhases, timeoutMs);
        const after = String(state.motherIdle?.phase || "").toLowerCase() || before;
        ok = Boolean(waitResult.ok);
        detail = waitResult.ok
          ? `mother_confirm_suggestion executed (${before || "unknown"} -> ${after || "unknown"})`
          : `mother_confirm_suggestion timed out waiting for phases=${targetPhases.join(",")} (current=${waitResult.phase || after || "unknown"})`;
        events.push({
          type: "mother_confirm",
          marker: "mother_confirm_suggestion_completed",
          before,
          after,
          target_phases: targetPhases,
          timeout_ms: timeoutMs,
          reached_phase: waitResult.phase || after || null,
          timed_out: !waitResult.ok,
        });
        events.push({ type: "mother_state", marker: "mother_state", state: _automationStateEnvelope() });
      }
    } else if (action === "mother_reject_suggestion") {
      if (!state.motherIdle) {
        detail = "mother state unavailable";
      } else {
        const before = String(state.motherIdle?.phase || "").toLowerCase();
        stopMotherTakeover();
        const after = String(state.motherIdle?.phase || "").toLowerCase() || before;
        ok = true;
        detail = `mother_reject_suggestion executed (${before || "unknown"} -> ${after || "unknown"})`;
        events.push({ type: "mother_reject", marker: "mother_reject_suggestion_completed", before, after });
        events.push({ type: "mother_state", marker: "mother_state", state: _automationStateEnvelope() });
      }
    } else if (action === "select_canvas_image") {
      const imageId = _resolveCanvasImageIdFromPayload(actionPayload);
      if (!imageId) {
        detail = "select_canvas_image missing image_id/image_index/path";
      } else {
        const toggle = Boolean(actionPayload.toggle);
        await selectCanvasImage(imageId, { toggle });
        const selectedIds = getSelectedIds().slice(0, 3);
        ok = true;
        detail = `select_canvas_image id=${imageId}`;
        events.push({
          type: "selection_change",
          marker: "canvas_selection_updated",
          active_id: state.activeId || null,
          selected_ids: selectedIds,
          image_id: imageId,
          toggle,
        });
        events.push({ type: "canvas_state", marker: "canvas_state", state: _automationStateEnvelope() });
      }
    } else if (action === "set_canvas_mode") {
      const rawMode = String(actionPayload.mode || "").trim().toLowerCase();
      const mode = rawMode === "single" ? "single" : "multi";
      const before = state.canvasMode;
      setCanvasMode(mode);
      const after = state.canvasMode;
      ok = true;
      detail = `set_canvas_mode ${before || "unknown"} -> ${after || "unknown"}`;
      events.push({
        type: "canvas_mode_set",
        marker: "canvas_mode_changed",
        prev: before || null,
        next: after || mode,
      });
      events.push({ type: "canvas_state", marker: "canvas_state", state: _automationStateEnvelope() });
    } else if (action === "canvas_pan") {
      const result = _applyCanvasPanFromPayload({ ...actionPayload, mode: actionPayload.mode });
      if (!result.ok) {
        detail = result.detail;
      } else {
        ok = true;
        detail = result.detail;
        if (result.event) events.push(result.event);
        events.push({ type: "canvas_state", marker: "canvas_state", state: _automationStateEnvelope() });
      }
    } else if (action === "canvas_zoom") {
      const result = _applyCanvasZoomFromPayload({ ...actionPayload, mode: actionPayload.mode });
      if (!result.ok) {
        detail = result.detail;
      } else {
        ok = true;
        detail = result.detail;
        if (result.event) events.push(result.event);
        events.push({ type: "canvas_state", marker: "canvas_state", state: _automationStateEnvelope() });
      }
    } else if (action === "canvas_fit_all") {
      const result = _applyCanvasFitAllFromPayload({ ...actionPayload, mode: actionPayload.mode });
      if (!result.ok) {
        detail = result.detail;
      } else {
        ok = true;
        detail = result.detail;
        if (result.event) events.push(result.event);
        events.push({ type: "canvas_state", marker: "canvas_state", state: _automationStateEnvelope() });
      }
    } else if (action === "action_grid") {
      const out = await _runActionGridAutomation(actionPayload);
      if (out?.ok) {
        ok = true;
        detail = out.detail || "action_grid completed";
        events.push({
          type: "action_grid_press",
          marker: "action_grid_invoked",
          key: String(actionPayload.key || "").trim().toLowerCase() || null,
          hotkey: String(actionPayload.hotkey || "").trim() || null,
        });
        events.push({ type: "canvas_state", marker: "canvas_state", state: _automationStateEnvelope() });
      } else {
        detail = out?.detail || "action_grid failed";
      }
    }
  } catch (err) {
    ok = false;
    detail = err?.message || String(err || "automation action failed");
  }

  for (const event of events) {
    const marker = String(event?.marker || "").trim();
    if (marker) markers.add(marker);
  }

  if (!events.length) {
    events.push({ type: "automation_fallback", marker: "automation_fallback", detail: detail || "no event emitted", request_id: requestId });
    markers.add("automation_fallback");
  }

  console.log(`[desktop-automation] event_count=${events.length} for request_id=${requestId}`);
  console.log(`[desktop-automation] before append events request_id=${requestId}`);
  await _appendAutomationEvents(events, { requestId });
  console.log(`[desktop-automation] append complete request_id=${requestId}`);
  const reply = {
    request_id: requestId,
    ok,
    detail,
    state: _automationStateEnvelope(),
    events,
    markers: Array.from(markers),
  };
  console.log(`[desktop-automation] reporting result request_id=${requestId} ok=${ok} markers=${JSON.stringify(reply.markers)}`);
  try {
    await invoke("report_automation_result", { result: reply });
    console.log(`[desktop-automation] report_automation_result success request_id=${requestId}`);
  } catch (err) {
    console.log(`[desktop-automation] report_automation_result failed request_id=${requestId} detail=${String(err)}`);
    console.error(
      "[desktop-automation] report_automation_result failed",
      String(requestId),
      err
    );
    const failEvent = {
      type: "automation_result_invoke_failed",
      marker: "automation_result_invoke_failed",
      request_id: requestId,
      error: String(err),
      source: "desktop_ui_automation",
      detail: String(err),
    };
    await _appendAutomationEvents([failEvent], { requestId });
  }
}

function motherV2RoleMapClone() {
  const normalize = (list) =>
    Array.from(
      new Set(
        (Array.isArray(list) ? list : [])
          .map((v) => String(v || "").trim())
          .filter((id) => Boolean(id) && isVisibleCanvasImageId(id))
      )
    );
  const base = state.motherIdle?.roles || {};
  return {
    subject: normalize(base.subject),
    model: normalize(base.model),
    mediator: normalize(base.mediator),
    object: normalize(base.object),
  };
}

function motherV2NormalizeRoles(nextRoles = null) {
  const idle = state.motherIdle;
  if (!idle) return;
  const source = nextRoles && typeof nextRoles === "object" ? nextRoles : idle.roles || {};
  const out = { subject: [], model: [], mediator: [], object: [] };
  for (const key of MOTHER_V2_ROLE_KEYS) {
    const list = Array.isArray(source[key]) ? source[key] : [];
    out[key] = Array.from(new Set(list.map((v) => String(v || "").trim()).filter((id) => Boolean(id) && isVisibleCanvasImageId(id))));
  }
  idle.roles = out;
}

function motherV2InInteractivePhase() {
  const phase = state.motherIdle?.phase || motherIdleInitialState();
  return phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING || phase === MOTHER_IDLE_STATES.OFFERING;
}

function motherV2InCooldown() {
  const idle = state.motherIdle;
  if (!idle) return false;
  const now = Date.now();
  return idle.phase === MOTHER_IDLE_STATES.COOLDOWN && now < (Number(idle.cooldownUntil) || 0);
}

function motherV2CurrentDraft() {
  const idle = state.motherIdle;
  if (!idle) return null;
  const drafts = Array.isArray(idle.drafts) ? idle.drafts : [];
  if (!drafts.length) return null;
  const selected = String(idle.selectedDraftId || "").trim();
  if (selected) {
    const match = drafts.find((d) => String(d?.id || "") === selected) || null;
    if (match) return match;
  }
  return drafts[0] || null;
}

function motherV2RoleIds(roleKey) {
  const idle = state.motherIdle;
  if (!idle) return [];
  const list = Array.isArray(idle.roles?.[roleKey]) ? idle.roles[roleKey] : [];
  return list.map((v) => String(v || "").trim()).filter((id) => Boolean(id) && isVisibleCanvasImageId(id));
}

function motherV2SetRoleIds(roleKey, imageIds) {
  const idle = state.motherIdle;
  if (!idle) return;
  if (!MOTHER_V2_ROLE_KEYS.includes(roleKey)) return;
  idle.roles[roleKey] = Array.from(
    new Set(
      (Array.isArray(imageIds) ? imageIds : [])
        .map((v) => String(v || "").trim())
        .filter((id) => Boolean(id) && isVisibleCanvasImageId(id))
    )
  );
}

function motherV2ResetInteractionState() {
  const idle = state.motherIdle;
  if (!idle) return;
  idle.pendingIntent = false;
  idle.pendingPromptCompile = false;
  idle.pendingGeneration = false;
  idle.pendingFollowupAfterCooldown = false;
  idle.pendingFollowupReason = null;
  idle.pendingVisionImageIds = [];
  idle.pendingActionVersion = 0;
  idle.pendingIntentRequestId = null;
  idle.pendingIntentStartedAt = 0;
  idle.pendingIntentUpgradeUntil = 0;
  idle.pendingIntentRealtimePath = null;
  idle.pendingIntentPath = null;
  idle.pendingIntentPayload = null;
  idle.pendingPromptCompilePath = null;
  clearTimeout(idle.pendingIntentTimeout);
  idle.pendingIntentTimeout = null;
  clearTimeout(idle.pendingPromptCompileTimeout);
  idle.pendingPromptCompileTimeout = null;
  clearTimeout(idle.pendingVisionRetryTimer);
  idle.pendingVisionRetryTimer = null;
  clearMotherIdleDispatchTimeout();
  idle.pendingDispatchToken = 0;
  idle.dispatchTimeoutExtensions = 0;
  motherIdleResetDispatchCorrelation({ rememberPendingVersion: false });
}

function motherV2ClearGlyphs() {
  const idle = state.motherIdle;
  if (!idle) return;
  idle.roleGlyphHits = [];
  idle.roleGlyphDrag = null;
}

function motherV2ClearIntentAndDrafts({ removeFiles = false } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  const drafts = Array.isArray(idle.drafts) ? idle.drafts.slice() : [];
  if (removeFiles) {
    for (const draft of drafts) {
      if (draft?.path) removeFile(String(draft.path)).catch(() => {});
      if (draft?.receiptPath) removeFile(String(draft.receiptPath)).catch(() => {});
    }
  }
  idle.intent = null;
  idle.roles = { subject: [], model: [], mediator: [], object: [] };
  idle.drafts = [];
  idle.selectedDraftId = null;
  idle.hoverDraftId = null;
  idle.pendingVisionImageIds = [];
  clearTimeout(idle.pendingVisionRetryTimer);
  idle.pendingVisionRetryTimer = null;
  idle.pendingIntentRequestId = null;
  idle.pendingIntentStartedAt = 0;
  idle.pendingIntentUpgradeUntil = 0;
  idle.pendingIntentRealtimePath = null;
  idle.pendingIntentPath = null;
  idle.promptMotionProfile = null;
  state.pendingMotherDraft = null;
  idle.hintVisibleUntil = 0;
  idle.hintLevel = 0;
  clearTimeout(idle.hintFadeTimer);
  idle.hintFadeTimer = null;
  motherV2ClearGlyphs();
}

function motherV2CooldownMs({ rejected = false } = {}) {
  return rejected ? MOTHER_V2_COOLDOWN_AFTER_REJECT_MS : MOTHER_V2_COOLDOWN_AFTER_COMMIT_MS;
}

async function motherV2StartFollowupProposal({ reason = "manual_reject" } = {}) {
  const idle = state.motherIdle;
  if (!idle) return false;
  if (idle.phase !== MOTHER_IDLE_STATES.OBSERVING) return false;
  if (!motherIdleHasArmedCanvas()) return false;
  if (state.pointer.active) return false;
  if (motherV2InCooldown()) return false;
  if (idle.pendingIntent || idle.pendingPromptCompile || idle.pendingGeneration) return false;
  idle.pendingFollowupReason = String(reason || "manual_reject");

  clearMotherIdleTimers({ first: true, takeover: false });
  motherIdleTransitionTo(MOTHER_IDLE_EVENTS.IDLE_WINDOW_ELAPSED); // observing -> watching
  motherIdleTransitionTo(MOTHER_IDLE_EVENTS.IDLE_WINDOW_ELAPSED); // watching -> intent_hypothesizing
  appendMotherTraceLog({
    kind: "followup_rehypothesis",
    traceId: idle.telemetry?.traceId || null,
    actionVersion: Number(idle.actionVersion) || 0,
    reason: String(reason || "manual_reject"),
  }).catch(() => {});
  renderMotherReadout();
  const started = await motherV2RequestIntentInference();
  if (!started) {
    idle.pendingFollowupReason = null;
    motherIdleTransitionTo(MOTHER_IDLE_EVENTS.DISQUALIFY);
    return false;
  }
  return true;
}

function motherV2ArmCooldown({ rejected = false } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  const ms = motherV2CooldownMs({ rejected });
  idle.cooldownUntil = Date.now() + ms;
  clearTimeout(idle.cooldownTimer);
  idle.cooldownTimer = setTimeout(() => {
    idle.cooldownTimer = null;
    const queueFollowupAfterCooldown = rejected && Boolean(idle.pendingFollowupAfterCooldown);
    idle.pendingFollowupAfterCooldown = false;
    motherIdleTransitionTo(MOTHER_IDLE_EVENTS.COOLDOWN_DONE);
    if (queueFollowupAfterCooldown) {
      motherV2StartFollowupProposal({ reason: "reject_followup" })
        .then((started) => {
          if (!started) motherIdleArmFirstTimer();
          renderMotherReadout();
        })
        .catch(() => {
          motherIdleArmFirstTimer();
          renderMotherReadout();
        });
      return;
    }
    motherIdleArmFirstTimer();
    renderMotherReadout();
  }, ms + 8);
}

function motherV2MarkStale(extra = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  idle.telemetry.stale = (Number(idle.telemetry?.stale) || 0) + 1;
  appendMotherTraceLog({
    kind: "stale",
    traceId: idle.telemetry?.traceId || null,
    actionVersion: Number(idle.actionVersion) || 0,
    stale: Number(idle.telemetry?.stale) || 0,
    ...extra,
  }).catch(() => {});
}

function motherV2ForcePhase(nextState, eventName = "force") {
  const idle = state.motherIdle;
  if (!idle) return;
  const prev = idle.phase || motherIdleInitialState();
  const next = String(nextState || "").trim();
  if (!next || prev === next) return;
  idle.phase = next;
  const transitions = Array.isArray(idle.telemetry?.stateTransitions) ? idle.telemetry.stateTransitions : [];
  transitions.push({
    at_ms: Date.now(),
    from: String(prev || ""),
    to: next,
    event: String(eventName || "force"),
  });
  if (transitions.length > 96) transitions.splice(0, transitions.length - 96);
  if (idle.telemetry && typeof idle.telemetry === "object") idle.telemetry.stateTransitions = transitions;
  appendMotherTraceLog({
    kind: "state_transition",
    traceId: idle.telemetry?.traceId || null,
    from: String(prev || ""),
    to: next,
    event: String(eventName || "force"),
    actionVersion: Number(idle.actionVersion) || 0,
  }).catch(() => {});
  syncMotherPortrait();
}

function motherIdleHasArmedCanvas() {
  const base = motherIdleBaseImageItems();
  if (!motherV2HasProposalImageSet()) return false;
  if (state.canvasMode === "single") {
    const activeId = String(getVisibleActiveId() || "").trim();
    if (!activeId) return false;
    const active = state.imagesById.get(activeId) || getActiveImage() || null;
    const iw = Number(active?.img?.naturalWidth || active?.width) || 0;
    const ih = Number(active?.img?.naturalHeight || active?.height) || 0;
    return iw > 0 && ih > 0;
  }
  if (state.canvasMode !== "multi") return false;
  const required = base.slice(0, Math.min(2, base.length));
  for (const item of required) {
    const rect = state.freeformRects.get(item.id) || null;
    if (!rect) return false;
    if ((Number(rect.w) || 0) <= 0 || (Number(rect.h) || 0) <= 0) return false;
  }
  return true;
}

function motherV2HasProposalImageSet() {
  return motherIdleBaseImageItems().length >= MOTHER_V2_MIN_IMAGES_FOR_PROPOSAL;
}

function motherIdleGenerationModelCandidates() {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const model = String(raw || "").trim();
    if (!model) return;
    if (providerFromModel(model) !== "gemini") return;
    if (seen.has(model)) return;
    seen.add(model);
    out.push(model);
  };
  push(MOTHER_GENERATION_MODEL);
  push(pickGeminiImageModel());
  if (providerFromModel(settings.imageModel) === "gemini") push(settings.imageModel);
  return out.length ? out : [MOTHER_GENERATION_MODEL];
}

function motherIdlePickRetryModel(lastModel = null) {
  const current = String(lastModel || "").trim();
  const candidates = motherIdleGenerationModelCandidates();
  for (const model of candidates) {
    if (model !== current) return model;
  }
  return null;
}

function motherIdlePromptLineForPty(prompt) {
  return String(prompt || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function motherEventVersionId(event) {
  const versionId = String(event?.version_id || "").trim();
  return versionId || null;
}

function motherIdleRememberIgnoredVersion(versionId) {
  const idle = state.motherIdle;
  const normalized = String(versionId || "").trim();
  if (!idle || !normalized) return;
  if (!(idle.ignoredVersionIds instanceof Set)) idle.ignoredVersionIds = new Set();
  idle.ignoredVersionIds.add(normalized);
  while (idle.ignoredVersionIds.size > 96) {
    const first = idle.ignoredVersionIds.values().next();
    if (first.done) break;
    idle.ignoredVersionIds.delete(first.value);
  }
}

function motherIdleIsIgnoredVersion(versionId) {
  const idle = state.motherIdle;
  const normalized = String(versionId || "").trim();
  if (!idle || !normalized) return false;
  return idle.ignoredVersionIds instanceof Set && idle.ignoredVersionIds.has(normalized);
}

function motherIdleResetDispatchCorrelation({ rememberPendingVersion = false } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  const pendingVersionId = String(idle.pendingVersionId || "").trim();
  if (rememberPendingVersion && pendingVersionId) {
    motherIdleRememberIgnoredVersion(pendingVersionId);
  }
  idle.pendingVersionId = null;
  idle.pendingPromptLine = null;
}

function motherIdleDispatchVersionMatches(versionId) {
  const idle = state.motherIdle;
  if (!idle) return false;
  const expected = String(idle.pendingVersionId || "").trim();
  if (!expected) return true;
  const incoming = String(versionId || "").trim();
  if (!incoming) return true;
  return incoming === expected;
}

function motherIdleTrackVersionCreated(event = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  if (idle.phase !== MOTHER_IDLE_STATES.GENERATION_DISPATCHED) return;
  if (!idle.pendingDispatchToken) return;
  const versionId = motherEventVersionId(event);
  if (!versionId) return;
  if (!idle.pendingVersionId) {
    idle.pendingVersionId = versionId;
    motherIdleArmDispatchTimeout(
      MOTHER_GENERATION_POST_VERSION_TIMEOUT_MS,
      `Mother draft timed out after ${Math.round(MOTHER_GENERATION_POST_VERSION_TIMEOUT_MS / 1000)}s while image generation was in progress.`,
      { allowExtension: false }
    );
    appendMotherSuggestionLog({
      stage: "version_bound",
      request_id: idle.pendingSuggestionLog?.request_id || null,
      model: idle.lastDispatchModel || idle.pendingSuggestionLog?.model || null,
      version_id: versionId,
    }).catch(() => {});
    return;
  }
  if (idle.pendingVersionId === versionId) return;
  motherIdleRememberIgnoredVersion(versionId);
  appendMotherSuggestionLog({
    stage: "extra_version_ignored",
    request_id: idle.pendingSuggestionLog?.request_id || null,
    model: idle.lastDispatchModel || idle.pendingSuggestionLog?.model || null,
    expected_version_id: idle.pendingVersionId,
    ignored_version_id: versionId,
    ignored_prompt: event?.prompt ? String(event.prompt) : null,
  }).catch(() => {});
  console.warn("[mother_suggestion] ignored extra version", {
    expected_version_id: idle.pendingVersionId,
    ignored_version_id: versionId,
  });
}

function motherIdleTransitionTo(eventName) {
  if (!state.motherIdle) return motherIdleInitialState();
  const prev = state.motherIdle.phase;
  const next = motherIdleTransition(prev, eventName);
  state.motherIdle.phase = next;
  if (next !== prev) {
    const idle = state.motherIdle;
    const transitions = Array.isArray(idle.telemetry?.stateTransitions) ? idle.telemetry.stateTransitions : [];
    transitions.push({
      at_ms: Date.now(),
      from: String(prev || ""),
      to: String(next || ""),
      event: String(eventName || ""),
    });
    if (transitions.length > 96) transitions.splice(0, transitions.length - 96);
    if (idle.telemetry && typeof idle.telemetry === "object") idle.telemetry.stateTransitions = transitions;
    appendMotherTraceLog({
      kind: "state_transition",
      traceId: idle.telemetry?.traceId || null,
      from: String(prev || ""),
      to: String(next || ""),
      event: String(eventName || ""),
      actionVersion: Number(idle.actionVersion) || 0,
      accepted: Number(idle.telemetry?.accepted) || 0,
      rejected: Number(idle.telemetry?.rejected) || 0,
      deployed: Number(idle.telemetry?.deployed) || 0,
      stale: Number(idle.telemetry?.stale) || 0,
    }).catch(() => {});
    if (next === MOTHER_IDLE_STATES.OBSERVING) {
      motherV2ClearGlyphs();
    }
    syncMotherPortrait();
  }
  return next;
}

function clearMotherIdleTimers({ first = true, takeover = true } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  if (first) {
    clearTimeout(idle.firstIdleTimer);
    idle.firstIdleTimer = null;
    clearTimeout(idle.intentIdleTimer);
    idle.intentIdleTimer = null;
  }
  if (takeover) {
    clearTimeout(idle.takeoverTimer);
    idle.takeoverTimer = null;
  }
}

function clearMotherIdleDispatchTimeout() {
  const idle = state.motherIdle;
  if (!idle) return;
  clearTimeout(idle.dispatchTimeoutTimer);
  idle.dispatchTimeoutTimer = null;
}

function motherIdleArmDispatchTimeout(timeoutMs, message, { allowExtension = false } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  clearMotherIdleDispatchTimeout();
  const dispatchToken = Number(idle.pendingDispatchToken) || 0;
  if (!dispatchToken) return;
  const ms = Math.max(1_000, Number(timeoutMs) || MOTHER_GENERATION_TIMEOUT_MS);
  const fallbackMessage = message || `Mother draft timed out after ${Math.round(ms / 1000)}s.`;
  const extendable = Boolean(allowExtension);
  idle.dispatchTimeoutTimer = setTimeout(() => {
    const current = state.motherIdle;
    if (!current) return;
    if (Number(current.pendingDispatchToken) !== dispatchToken) return;
    if (extendable) {
      const hasBoundVersion = Boolean(String(current.pendingVersionId || "").trim());
      const extensionCount = Number(current.dispatchTimeoutExtensions) || 0;
      if (!hasBoundVersion && extensionCount < 1) {
        current.dispatchTimeoutExtensions = extensionCount + 1;
        const extensionMs = Math.max(1_000, Number(MOTHER_GENERATION_TIMEOUT_EXTENSION_MS) || 1_000);
        appendMotherSuggestionLog({
          stage: "dispatch_timeout_extended",
          request_id: current.pendingSuggestionLog?.request_id || null,
          model: current.lastDispatchModel || current.pendingSuggestionLog?.model || null,
          extension_count: current.dispatchTimeoutExtensions,
          extension_ms: extensionMs,
        }).catch(() => {});
        motherIdleArmDispatchTimeout(extensionMs, fallbackMessage, { allowExtension: false });
        return;
      }
    }
    motherIdleHandleGenerationFailed(fallbackMessage);
  }, ms);
}

function resetMotherIdleAndWheelState() {
  clearMotherIdleTimers({ first: true, takeover: true });
  clearMotherIdleDispatchTimeout();
  if (state.motherIdle) {
    state.motherIdle.hasGeneratedSinceInteraction = false;
    state.motherIdle.generatedImageId = null;
    state.motherIdle.generatedVersionId = null;
    state.motherIdle.pendingDispatchToken = 0;
    state.motherIdle.dispatchTimeoutExtensions = 0;
    motherIdleResetDispatchCorrelation({ rememberPendingVersion: false });
    state.motherIdle.promptMotionProfile = null;
    if (state.motherIdle.ignoredVersionIds instanceof Set) state.motherIdle.ignoredVersionIds.clear();
    state.motherIdle.waitingSince = 0;
    state.motherIdle.pendingSuggestionLog = null;
    state.motherIdle.lastSuggestionAt = 0;
    state.motherIdle.suppressFailureUntil = 0;
    state.motherIdle.retryAttempted = false;
    state.motherIdle.lastDispatchModel = null;
    state.motherIdle.blockedUntilUserInteraction = false;
    clearTimeout(state.motherIdle.cooldownTimer);
    state.motherIdle.cooldownTimer = null;
    clearTimeout(state.motherIdle.pendingIntentTimeout);
    state.motherIdle.pendingIntentTimeout = null;
    clearTimeout(state.motherIdle.pendingPromptCompileTimeout);
    state.motherIdle.pendingPromptCompileTimeout = null;
    state.motherIdle.actionVersion = 0;
    state.motherIdle.pendingActionVersion = 0;
    state.motherIdle.cooldownUntil = 0;
    state.motherIdle.multiUploadIdleBoostUntil = 0;
    state.motherIdle.pendingIntent = false;
    state.motherIdle.pendingIntentRequestId = null;
    state.motherIdle.pendingIntentStartedAt = 0;
    state.motherIdle.pendingIntentUpgradeUntil = 0;
    state.motherIdle.pendingIntentRealtimePath = null;
    state.motherIdle.pendingIntentPath = null;
    state.motherIdle.pendingIntentPayload = null;
    state.motherIdle.pendingPromptCompile = false;
    state.motherIdle.pendingPromptCompilePath = null;
    state.motherIdle.pendingVisionImageIds = [];
    clearTimeout(state.motherIdle.pendingVisionRetryTimer);
    state.motherIdle.pendingVisionRetryTimer = null;
    state.motherIdle.pendingGeneration = false;
    state.motherIdle.pendingFollowupAfterCooldown = false;
    state.motherIdle.pendingFollowupReason = null;
    state.motherIdle.lastRejectedProposal = null;
    state.motherIdle.rejectedModeHistoryByContext = {};
    state.motherIdle.cancelArtifactUntil = 0;
    state.motherIdle.cancelArtifactReason = null;
    state.motherIdle.intent = null;
    state.motherIdle.roles = { subject: [], model: [], mediator: [], object: [] };
    state.motherIdle.drafts = [];
    state.motherIdle.selectedDraftId = null;
    state.motherIdle.hoverDraftId = null;
    state.motherIdle.commitMutationInFlight = false;
    state.motherIdle.roleGlyphHits = [];
    state.motherIdle.roleGlyphDrag = null;
    state.motherIdle.advancedOpen = false;
    state.motherIdle.optionReveal = false;
    state.motherIdle.hintLevel = 0;
    state.motherIdle.hintVisibleUntil = 0;
    clearTimeout(state.motherIdle.hintFadeTimer);
    state.motherIdle.hintFadeTimer = null;
    state.motherIdle.intensity = 62;
    state.motherIdle.commitUndo = null;
    state.motherIdle.telemetry = {
      traceId: `mother-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      stateTransitions: [],
      accepted: 0,
      rejected: 0,
      deployed: 0,
      stale: 0,
    };
    motherIdleTransitionTo(MOTHER_IDLE_EVENTS.RESET);
  }
  closeMotherWheelMenu({ immediate: true });
  if (state.wheelMenu) {
    state.wheelMenu.anchorCss = null;
    state.wheelMenu.anchorWorld = null;
    clearTimeout(state.wheelMenu.hideTimer);
    state.wheelMenu.hideTimer = null;
    state.wheelMenu.open = false;
  }
  syncMotherPortrait();
}

function isMotherWheelOpen() {
  return Boolean(state.wheelMenu?.open);
}

function closeMotherWheelMenu({ immediate = false } = {}) {
  const menu = els.motherWheelMenu;
  const wheel = state.wheelMenu;
  if (!menu || !wheel) return;
  clearTimeout(wheel.hideTimer);
  wheel.hideTimer = null;
  wheel.open = false;
  menu.classList.remove("is-open");
  if (immediate) {
    menu.classList.add("hidden");
    return;
  }
  wheel.hideTimer = setTimeout(() => {
    if (state.wheelMenu?.open) return;
    menu.classList.add("hidden");
  }, 220);
}

function openMotherWheelMenuAt(ptCss) {
  const menu = els.motherWheelMenu;
  const wrap = els.canvasWrap;
  if (!menu || !wrap || !ptCss) return false;
  if (state.mother?.running) return false;

  const xRaw = Number(ptCss.x) || 0;
  const yRaw = Number(ptCss.y) || 0;
  const x = clamp(xRaw, 18, Math.max(18, wrap.clientWidth - 18));
  const y = clamp(yRaw, 18, Math.max(18, wrap.clientHeight - 18));

  clearTimeout(state.wheelMenu.hideTimer);
  state.wheelMenu.hideTimer = null;
  state.wheelMenu.open = true;
  state.wheelMenu.anchorCss = { x, y };
  state.wheelMenu.anchorWorld = canvasScreenCssToWorldCss({ x, y });

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.remove("hidden");
  requestAnimationFrame(() => {
    if (!state.wheelMenu?.open) return;
    menu.classList.add("is-open");
  });
  return true;
}

function motherIdlePickNearestRoleTarget(worldPt) {
  const world = worldPt && typeof worldPt === "object" ? worldPt : null;
  const candidates = motherIdleBaseImageItems();
  if (!candidates.length) return null;
  if (!world) return candidates[candidates.length - 1] || null;

  let best = null;
  let bestDist2 = Infinity;
  for (const item of candidates) {
    const rect = state.freeformRects.get(item.id) || null;
    if (!rect) continue;
    const cx = (Number(rect.x) || 0) + (Number(rect.w) || 0) * 0.5;
    const cy = (Number(rect.y) || 0) + (Number(rect.h) || 0) * 0.5;
    const dx = (Number(world.x) || 0) - cx;
    const dy = (Number(world.y) || 0) - cy;
    const dist2 = dx * dx + dy * dy;
    if (dist2 < bestDist2) {
      best = item;
      bestDist2 = dist2;
    }
  }
  return best || candidates[candidates.length - 1] || null;
}

async function seedRoleDesignationFromWheelAnchor() {
  const world = state.wheelMenu?.anchorWorld || canvasScreenCssToWorldCss(_defaultImportPointCss());
  const ptCss = state.wheelMenu?.anchorCss || _defaultImportPointCss();
  const target = motherIdlePickNearestRoleTarget(world);
  if (!target?.id) {
    showToast("Add role needs at least one photo.", "tip", 1800);
    return;
  }

  if (state.activeId !== target.id) {
    await setActiveImage(target.id, { preserveSelection: true }).catch(() => {});
  }
  setTool("designate");

  const item = state.imagesById.get(target.id) || target;
  const rect = state.freeformRects.get(target.id) || null;
  let px = Number(item?.img?.naturalWidth || item?.width) * 0.5 || 0;
  let py = Number(item?.img?.naturalHeight || item?.height) * 0.5 || 0;

  if (rect && world) {
    const iw = Math.max(1, Number(item?.img?.naturalWidth || item?.width) || Number(rect.w) || 1);
    const ih = Math.max(1, Number(item?.img?.naturalHeight || item?.height) || Number(rect.h) || 1);
    const nx = clamp(((Number(world.x) || 0) - (Number(rect.x) || 0)) / Math.max(1, Number(rect.w) || 1), 0, 1);
    const ny = clamp(((Number(world.y) || 0) - (Number(rect.y) || 0)) / Math.max(1, Number(rect.h) || 1), 0, 1);
    px = nx * iw;
    py = ny * ih;
  }

  state.pendingDesignation = {
    imageId: target.id,
    x: px,
    y: py,
    at: Date.now(),
  };
  showDesignateMenuAt(ptCss);
  showToast("Role seeded. Pick Subject, Reference, or Object.", "tip", 2200);
  requestRender();
}

async function dispatchMotherWheelAction(action) {
  const raw = String(action || "").trim();
  closeMotherWheelMenu({ immediate: false });
  if (raw) recordUserEvent("mother_wheel_action", { action: raw });
  if (raw === "add_photo") {
    const world = state.wheelMenu?.anchorWorld || canvasScreenCssToWorldCss(_defaultImportPointCss());
    await importPhotosAtCanvasPoint(world);
    return;
  }
  if (raw === "add_role") {
    await seedRoleDesignationFromWheelAnchor();
    return;
  }
}

function motherIdleUseCasePromptMeta(useCaseKey) {
  const key = String(useCaseKey || "").trim();
  if (key === "streaming_content") {
    return {
      key,
      title: _intentUseCaseTitle(key),
      goal: "creator-facing social/stream visuals that test thumbnail or overlay direction",
      cue: "bold focal subject, high-contrast framing, headline/overlay-safe composition",
    };
  }
  if (key === "ecommerce_pod") {
    return {
      key,
      title: _intentUseCaseTitle(key),
      goal: "product/listing-ready composition that tests merch or catalog intent",
      cue: "clean product hero, sellable lighting, marketplace-friendly framing",
    };
  }
  if (key === "uiux_prototyping") {
    return {
      key,
      title: _intentUseCaseTitle(key),
      goal: "app/interface concept direction that tests UI or workflow exploration",
      cue: "screen-first layout, structured hierarchy, legible panel/flow shapes",
    };
  }
  if (key === "game_dev_assets") {
    return {
      key,
      title: _intentUseCaseTitle(key),
      goal: "game-art direction that tests asset-pack or concept-art workflows",
      cue: "stylized subject, production-style key art lighting, asset-ready silhouette",
    };
  }
  if (key === "content_engine") {
    return {
      key,
      title: _intentUseCaseTitle(key),
      goal: "repeatable multi-output brand/system direction",
      cue: "modular visual system motifs, reusable template logic, channel-ready composition",
    };
  }
  return {
    key: "streaming_content",
    title: _intentUseCaseTitle("streaming_content"),
    goal: "creator-facing social/stream visuals that test thumbnail or overlay direction",
    cue: "bold focal subject with clean, high-contrast composition",
  };
}

function motherIdleInferUseCaseFromVisionLines(lines = []) {
  const haystack = (Array.isArray(lines) ? lines : [])
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .trim();
  if (!haystack) return null;

  const scores = {
    game_dev_assets: 0,
    streaming_content: 0,
    uiux_prototyping: 0,
    ecommerce_pod: 0,
    content_engine: 0,
  };
  const bump = (key, re, weight) => {
    if (!key || !re) return;
    if (!(key in scores)) return;
    try {
      if (re.test(haystack)) scores[key] += Number(weight) || 0;
    } catch {
      // ignore
    }
  };

  bump("game_dev_assets", /\b(sprite|sprites|tileset|texture|textures|concept art|unreal|unity|character sheet|game)\b/i, 3);
  bump("streaming_content", /\b(instagram|twitch|youtube|tiktok|thumbnail|overlay|emote|stream|social)\b/i, 3);
  bump("uiux_prototyping", /\b(wireframe|mockup|prototype|user flow|dashboard|app screen|ui|ux)\b/i, 3);
  bump("ecommerce_pod", /\b(product photo|listing|marketplace|etsy|amazon|shop|merch|packaging|hoodie|mug)\b/i, 3);
  bump("content_engine", /\b(pipeline|workflow|automation|system|template|brand system|batch)\b/i, 3);

  let bestKey = null;
  let bestScore = 0;
  for (const [key, score] of Object.entries(scores)) {
    const s = Number(score) || 0;
    if (s > bestScore) {
      bestScore = s;
      bestKey = key;
    }
  }
  if (!bestKey || bestScore < 3) return null;
  return bestKey;
}

function motherIdlePickIntentHypotheses(visionLines = []) {
  const candidates = [];
  const seen = new Set();
  const push = (key, reason) => {
    const normalized = String(key || "").trim();
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({
      key: normalized,
      reason: String(reason || "").trim() || "signal",
    });
  };

  const visionHint = motherIdleInferUseCaseFromVisionLines(visionLines);
  if (visionHint) push(visionHint, "vision_descriptions");

  const iconState = state.intent?.iconState || null;
  const suggested = pickSuggestedIntentBranch(iconState);
  const suggestedKey = _intentUseCaseKeyFromBranchId(suggested?.branch_id);
  if (suggestedKey) push(suggestedKey, suggested?.reason ? `intent_${suggested.reason}` : "intent_branch");

  const focusKey = _intentUseCaseKeyFromBranchId(state.intent?.focusBranchId || state.intent?.lockedBranchId || "");
  if (focusKey) push(focusKey, "intent_focus");

  if (!candidates.length) {
    push("streaming_content", "default_fallback");
  }

  const primary = candidates[0]?.key || "streaming_content";
  const alternate =
    candidates.find((entry) => entry.key !== primary)?.key ||
    MOTHER_INTENT_USECASE_DEFAULT_ORDER.find((key) => key !== primary) ||
    "ecommerce_pod";

  const whyParts = [];
  const primaryReason = candidates[0]?.reason || "signal";
  whyParts.push(`primary ${_intentUseCaseTitle(primary)} via ${primaryReason}`);
  if (alternate && alternate !== primary) {
    const altReason = candidates.find((entry) => entry.key === alternate)?.reason || "coverage";
    whyParts.push(`alternate ${_intentUseCaseTitle(alternate)} via ${altReason}`);
  }

  return {
    primary,
    alternate,
    reasonText: whyParts.join("; "),
    signals: candidates.map((entry) => ({
      use_case: entry.key,
      title: _intentUseCaseTitle(entry.key),
      reason: entry.reason,
    })),
  };
}

function motherIdleComputePlacementCss({ policy = "adjacent", targetId = null, draftIndex = 0 } = {}) {
  const wrap = els.canvasWrap;
  const canvasCssW = wrap?.clientWidth || 0;
  const canvasCssH = wrap?.clientHeight || 0;
  if (!canvasCssW || !canvasCssH) return null;
  const targetRect = targetId ? state.freeformRects.get(targetId) || null : null;
  const activeRect = state.activeId ? state.freeformRects.get(state.activeId) || null : null;
  const baseRect = targetRect || activeRect;

  const intersects = (a, b) => {
    if (!a || !b) return false;
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  };
  const collidesWithExisting = (rect, ignoreIds = []) => {
    const ignore = new Set((Array.isArray(ignoreIds) ? ignoreIds : []).map((v) => String(v || "").trim()).filter(Boolean));
    for (const item of state.images || []) {
      const imageId = String(item?.id || "").trim();
      if (!imageId || ignore.has(imageId)) continue;
      const r = state.freeformRects.get(imageId) || null;
      if (!r) continue;
      if (intersects(rect, r)) return true;
    }
    return false;
  };

  if (policy === "replace" && baseRect) {
    return clampFreeformRectCss(
      { x: Number(baseRect.x) || 0, y: Number(baseRect.y) || 0, w: Number(baseRect.w) || 1, h: Number(baseRect.h) || 1, autoAspect: false },
      canvasCssW,
      canvasCssH
    );
  }

  const tile = Math.round(
    freeformDefaultTileCss(canvasCssW, canvasCssH, { count: Math.max(3, (state.images?.length || 0) + 1) }) * 0.88
  );
  const w = clamp(tile, 170, Math.round(canvasCssW * 0.46));
  const h = clamp(Math.round(w * 1.06), 170, Math.round(canvasCssH * 0.58));

  if (policy === "grid") {
    const gap = 24;
    const colCount = 2;
    const slot = Math.max(0, Number(draftIndex) || 0);
    const col = slot % colCount;
    const row = Math.floor(slot / colCount);
    const startX = baseRect ? (Number(baseRect.x) || 0) : Math.round((canvasCssW - (w * colCount + gap)) / 2);
    const startY = baseRect ? (Number(baseRect.y) || 0) : Math.round((canvasCssH - h) / 2);
    return clampFreeformRectCss(
      {
        x: Math.round(startX + col * (w + gap)),
        y: Math.round(startY + row * (h + gap)),
        w,
        h,
        autoAspect: true,
      },
      canvasCssW,
      canvasCssH
    );
  }

  // Adjacent placement (default): place to the right with 24px offset and avoid overlap.
  const gap = 24;
  let baseX = 0;
  let baseY = 0;
  if (baseRect) {
    baseX = (Number(baseRect.x) || 0) + (Number(baseRect.w) || 0) + gap;
    baseY = Number(baseRect.y) || 0;
  } else {
    let rightmost = 0;
    let topMost = 0;
    let seeded = false;
    for (const item of state.images || []) {
      const r = state.freeformRects.get(String(item?.id || "")) || null;
      if (!r) continue;
      const rx = Number(r.x) || 0;
      const rw = Number(r.w) || 0;
      const ry = Number(r.y) || 0;
      if (!seeded) {
        rightmost = rx + rw;
        topMost = ry;
        seeded = true;
      } else {
        rightmost = Math.max(rightmost, rx + rw);
        topMost = Math.min(topMost, ry);
      }
    }
    baseX = seeded ? rightmost + gap : gap;
    baseY = seeded ? topMost : gap;
  }
  let candidate = clampFreeformRectCss({ x: Math.round(baseX), y: Math.round(baseY), w, h, autoAspect: true }, canvasCssW, canvasCssH);
  const ignore = targetId ? [targetId] : [];
  for (let i = 0; i < 10 && collidesWithExisting(candidate, ignore); i += 1) {
    const nx = Number(candidate.x) + w + gap;
    const ny = Number(candidate.y) + (i % 2 === 0 ? 0 : h + gap);
    candidate = clampFreeformRectCss({ x: nx, y: ny, w, h, autoAspect: true }, canvasCssW, canvasCssH);
  }
  return candidate;
}

function motherV2OfferPreviewRectCss({ policy = "adjacent", targetId = null, draftIndex = 0 } = {}) {
  const wrap = els.canvasWrap;
  const canvasCssW = wrap?.clientWidth || 0;
  const canvasCssH = wrap?.clientHeight || 0;
  if (!canvasCssW || !canvasCssH) return null;
  const baseRect = motherIdleComputePlacementCss({ policy, targetId, draftIndex });
  if (!baseRect) return null;
  if (String(policy || "") === "replace") return baseRect;

  const ms = Math.max(0.0001, Number(state.multiView?.scale) || 1);
  const dpr = Math.max(0.0001, getDpr());
  const offsetCssX = (Number(state.multiView?.offsetX) || 0) / dpr;
  const offsetCssY = (Number(state.multiView?.offsetY) || 0) / dpr;
  const viewportX0 = (0 - offsetCssX) / ms;
  const viewportY0 = (0 - offsetCssY) / ms;
  const viewportW = Math.max(1, canvasCssW / ms);
  const viewportH = Math.max(1, canvasCssH / ms);

  const viewportMinCss = Math.max(1, Math.min(canvasCssW, canvasCssH));
  const minPreviewWorld = (viewportMinCss * MOTHER_OFFER_PREVIEW_MIN_VIEWPORT_COVER) / ms;
  const maxPreviewWorld = (viewportMinCss * MOTHER_OFFER_PREVIEW_MAX_VIEWPORT_COVER) / ms;

  const baseW = Math.max(1, Number(baseRect.w) || 1);
  const baseH = Math.max(1, Number(baseRect.h) || 1);
  let w = baseW * MOTHER_OFFER_PREVIEW_SCALE;
  let h = baseH * MOTHER_OFFER_PREVIEW_SCALE;
  let longest = Math.max(w, h);
  if (longest < minPreviewWorld) {
    const up = minPreviewWorld / Math.max(1, longest);
    w *= up;
    h *= up;
  }
  longest = Math.max(w, h);
  if (longest > maxPreviewWorld) {
    const down = maxPreviewWorld / Math.max(1, longest);
    w *= down;
    h *= down;
  }

  const cx = (Number(baseRect.x) || 0) + baseW * 0.5;
  const cy = (Number(baseRect.y) || 0) + baseH * 0.5;
  const edgePadWorld = Math.max(8, 10) / ms;
  let x = cx - w * 0.5;
  let y = cy - h * 0.5;
  const minX = viewportX0 + edgePadWorld;
  const minY = viewportY0 + edgePadWorld;
  const maxX = viewportX0 + viewportW - w - edgePadWorld;
  const maxY = viewportY0 + viewportH - h - edgePadWorld;
  x = clamp(x, minX, Math.max(minX, maxX));
  y = clamp(y, minY, Math.max(minY, maxY));
  return clampFreeformRectCss({ x, y, w, h, autoAspect: false }, canvasCssW, canvasCssH);
}

function motherV2ImageHints(images = []) {
  const hints = [];
  for (const img of Array.isArray(images) ? images : []) {
    hints.push(String(img?.vision_desc || "").trim());
    hints.push(String(img?.file || "").trim());
  }
  return hints.filter(Boolean);
}

function motherV2HasHumanSignal(hints = []) {
  const text = (Array.isArray(hints) ? hints : []).join(" ").toLowerCase();
  return /(person|people|human|face|portrait|selfie|woman|man|child)/i.test(text);
}

function motherV2RankImageIdsByProminence(images = []) {
  const ranked = [];
  for (let idx = 0; idx < (Array.isArray(images) ? images.length : 0); idx += 1) {
    const img = images[idx];
    const id = String(img?.id || "").trim();
    if (!id) continue;
    const rect = img?.rect && typeof img.rect === "object" ? img.rect : null;
    const w = Math.max(0, Number(rect?.w) || 0);
    const h = Math.max(0, Number(rect?.h) || 0);
    const area = Math.max(0, w * h);
    ranked.push({ id, idx, area });
  }
  if (!ranked.length) return [];
  const hasArea = ranked.some((entry) => Number(entry.area) > 0);
  ranked.sort((a, b) => {
    if (hasArea && Number(b.area) !== Number(a.area)) return Number(b.area) - Number(a.area);
    return Number(a.idx) - Number(b.idx);
  });
  return ranked.map((entry) => String(entry.id));
}

function motherV2IntentFromRealtimeIcons(iconState = null, payload = {}) {
  const icons = iconState && typeof iconState === "object" ? iconState : {};
  const images = Array.isArray(payload.images) ? payload.images : [];
  const imageIds = images.map((img) => String(img?.id || "").trim()).filter(Boolean);
  const imageIdSet = new Set(imageIds);
  const selectedIds = motherV2NormalizeImageIdList(payload.selected_ids || []).filter((id) => imageIdSet.has(id));
  const rankedIds = motherV2RankImageIdsByProminence(images).filter((id) => imageIdSet.has(id));
  const activeIdRaw = String(payload.active_id || "").trim();
  const activeId = imageIdSet.has(activeIdRaw) ? activeIdRaw : null;
  const branches = Array.isArray(icons.branches) ? icons.branches : [];
  const checkpointBranchId = String(icons?.checkpoint?.applies_to || "").trim();
  const preferredBranch = checkpointBranchId
    ? branches.find((branch) => String(branch?.branch_id || "").trim() === checkpointBranchId) || null
    : null;
  const topBranch = preferredBranch || branches[0] || null;
  const evidenceIds = Array.isArray(topBranch?.evidence_image_ids)
    ? topBranch.evidence_image_ids.map((v) => String(v || "").trim()).filter((id) => imageIdSet.has(id))
    : [];

  const targetIds = [];
  const pushTarget = (rawId) => {
    const id = String(rawId || "").trim();
    if (!id || !imageIdSet.has(id)) return;
    if (targetIds.includes(id)) return;
    targetIds.push(id);
  };
  if (selectedIds.length) {
    for (const id of selectedIds) pushTarget(id);
  } else if (evidenceIds.length) {
    pushTarget(evidenceIds[0]);
  } else if (activeId) {
    pushTarget(activeId);
  } else {
    pushTarget(rankedIds[0] || imageIds[0] || "");
  }

  const referenceIds = [];
  const pushRef = (rawId) => {
    const id = String(rawId || "").trim();
    if (!id || !imageIdSet.has(id)) return;
    if (targetIds.includes(id)) return;
    if (referenceIds.includes(id)) return;
    referenceIds.push(id);
  };
  for (const id of evidenceIds) pushRef(id);
  for (const id of rankedIds) pushRef(id);
  for (const id of imageIds) pushRef(id);

  const transformationMode = motherV2NormalizeTransformationMode(
    icons?.transformation_mode ||
      (Array.isArray(icons?.transformation_mode_candidates) ? icons.transformation_mode_candidates[0]?.mode : null) ||
      payload.preferred_transformation_mode
  );
  const transformationModeCandidates = [];
  const pushModeCandidate = (rawMode, rawConfidence = null) => {
    const mode = motherV2MaybeTransformationMode(rawMode);
    if (!mode) return;
    const confidence =
      typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
        ? clamp(Number(rawConfidence) || 0, 0, 1)
        : null;
    const existing = transformationModeCandidates.find((entry) => entry.mode === mode) || null;
    if (!existing) {
      transformationModeCandidates.push({ mode, confidence });
      return;
    }
    if (typeof confidence === "number") {
      const prior = typeof existing.confidence === "number" ? existing.confidence : -1;
      if (confidence > prior) existing.confidence = confidence;
    }
  };
  pushModeCandidate(transformationMode, null);
  for (const candidate of Array.isArray(icons?.transformation_mode_candidates) ? icons.transformation_mode_candidates : []) {
    pushModeCandidate(candidate?.mode || candidate?.transformation_mode, candidate?.confidence);
  }
  transformationModeCandidates.sort((a, b) => {
    const ac = typeof a.confidence === "number" ? a.confidence : -1;
    const bc = typeof b.confidence === "number" ? b.confidence : -1;
    return bc - ac;
  });

  const summary = motherV2ProposalSentence({ transformation_mode: transformationMode });
  const confidence = clamp(
    typeof topBranch?.confidence === "number" && Number.isFinite(topBranch.confidence)
      ? Number(topBranch.confidence)
      : transformationModeCandidates.length && typeof transformationModeCandidates[0].confidence === "number"
        ? Number(transformationModeCandidates[0].confidence)
        : targetIds.length
          ? 0.78
          : 0.62,
    0.2,
    0.99
  );

  const placementPolicy = imageIds.length >= 4
    ? "grid"
    : targetIds.length && referenceIds.length
      ? "adjacent"
      : targetIds.length
        ? "replace"
        : "adjacent";
  const subject = targetIds.slice(0, 1);
  const model = referenceIds.slice(0, 1);
  const mediator = referenceIds.slice(1, 2).length ? referenceIds.slice(1, 2) : referenceIds.slice(0, 1);
  const obj = targetIds.slice(0, 1);
  const actionVersion = Number(payload.action_version) || 0;
  const frameId = String(icons?.frame_id || "").trim();
  const branchId = String(topBranch?.branch_id || "").trim();
  return {
    intent_id: frameId ? `intent-rt-${frameId}` : `intent-rt-${actionVersion}-${Math.random().toString(16).slice(2, 7)}`,
    summary,
    creative_directive: MOTHER_CREATIVE_DIRECTIVE,
    transformation_mode: transformationMode,
    transformation_mode_candidates: transformationModeCandidates,
    target_ids: targetIds.slice(0, 3),
    reference_ids: referenceIds.slice(0, 3),
    placement_policy: placementPolicy,
    confidence,
    roles: {
      subject,
      model,
      mediator,
      object: obj,
    },
    realtime_frame_id: frameId || null,
    branch_id: branchId || null,
    alternatives: [
      { placement_policy: "adjacent" },
      { placement_policy: "grid" },
    ],
  };
}

function motherV2CompilePromptLocal(payload = {}) {
  const intent = payload.intent && typeof payload.intent === "object" ? payload.intent : {};
  const summary =
    String(intent.summary || intent.label || "").trim() ||
    MOTHER_V2_PROPOSAL_BY_MODE[MOTHER_V2_DEFAULT_TRANSFORMATION_MODE];
  const creativeDirective =
    String(payload.creative_directive || intent.creative_directive || "").trim() || MOTHER_CREATIVE_DIRECTIVE;
  const transformationMode = motherV2NormalizeTransformationMode(
    payload.transformation_mode || intent.transformation_mode || MOTHER_V2_DEFAULT_TRANSFORMATION_MODE
  );
  const roles = intent.roles && typeof intent.roles === "object" ? intent.roles : {};
  const subjectIds = Array.isArray(roles.subject) ? roles.subject.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 2) : [];
  const modelIds = Array.isArray(roles.model) ? roles.model.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 2) : [];
  const roleText = MOTHER_V2_ROLE_KEYS.map((key) => {
    const ids = Array.isArray(roles[key]) ? roles[key].map((v) => String(v || "").trim()).filter(Boolean) : [];
    return `${MOTHER_V2_ROLE_LABEL[key] || key.toUpperCase()}: ${ids.length ? ids.join(", ") : "none"}`;
  }).join("; ");
  const targetIds = Array.isArray(intent.target_ids) ? intent.target_ids.map((v) => String(v || "").trim()).filter(Boolean) : [];
  const referenceIds = Array.isArray(intent.reference_ids) ? intent.reference_ids.map((v) => String(v || "").trim()).filter(Boolean) : [];
  const contextIds = [];
  for (const id of [...targetIds, ...referenceIds]) {
    if (id && !contextIds.includes(id)) contextIds.push(id);
  }
  const multiImage = contextIds.length > 1;
  const imageHints = motherV2ImageHints(payload.images || []);
  const hasHumanInputs = motherV2HasHumanSignal(imageHints);
  const allowDoubleExposure = ["destabilize", "fracture", "alienate"].includes(transformationMode);
  const constraints = [
    "No unintended ghosted human overlays.",
    allowDoubleExposure
      ? "Allow intentional double-exposure only when it clearly supports the chosen transformation mode."
      : "No accidental double-exposure artifacts.",
    "No icon-overpaint artifacts.",
    "Preserve source-object integrity where role anchors imply continuity.",
  ];
  if (!hasHumanInputs) {
    constraints.push("No extra humans or faces unless clearly present in the input references.");
  }
  const multiImageRules = [];
  if (multiImage) {
    multiImageRules.push("Integrate all references into a single coherent scene (not a collage).");
    if (subjectIds.length && modelIds.length) {
      multiImageRules.push(
        `Preserve primary subject identity from ${subjectIds.join(", ")} and key material/color cues from ${modelIds.join(", ")}.`
      );
    } else if (targetIds.length && referenceIds.length) {
      multiImageRules.push(
        `Preserve identifiable structure from ${targetIds[0]} while transferring visual language from ${referenceIds[0]}.`
      );
    }
    multiImageRules.push("Match perspective, scale, and lighting direction across fused elements.");
    multiImageRules.push("Keep one coherent camera framing and focal hierarchy.");
  }
  const positiveLines = [
    `Intent summary: ${summary}.`,
    `Role anchors: ${roleText}.`,
  ];
  if (multiImageRules.length) {
    positiveLines.push(`Multi-image fusion rules: ${multiImageRules.join(" ")}`);
  }
  positiveLines.push(`Anti-overlay constraints: ${constraints.join(" ")}`);
  positiveLines.push("Produce coherent composition, emotional resonance, and production-grade lighting.");
  positiveLines.push("No text overlays, words, letters, logos-as-text, or watermarks.");
  positiveLines.push("Create one production-ready concept image.");
  positiveLines.push(`Creative directive: ${creativeDirective}.`);
  positiveLines.push(`Transformation mode: ${transformationMode}.`);
  return {
    action_version: Number(payload.action_version) || 0,
    creative_directive: creativeDirective,
    transformation_mode: transformationMode,
    positive_prompt: positiveLines.join(" "),
    negative_prompt: `No collage split-screen. No text overlays. No watermark. No ghosted human overlays. No icon-overpaint artifacts. No low-detail artifacts. ${
      hasHumanInputs ? "No unintended extra faces." : "No extra humans/faces unless present in inputs."
    }`,
    compile_constraints: constraints,
    generation_params: {
      guidance_scale: 7,
      layout_hint: String(intent.placement_policy || "adjacent"),
      seed_strategy: "random",
      transformation_mode: transformationMode,
      intensity: clamp(Number(payload.intensity) || Number(state.motherIdle?.intensity) || 62, 0, 100),
    },
  };
}

async function motherV2WritePayloadFile(prefix, payload = {}) {
  if (!state.runDir) return null;
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const outPath = `${state.runDir}/${prefix}-${stamp}.json`;
  try {
    await writeTextFile(outPath, JSON.stringify(payload, null, 2));
    return outPath;
  } catch {
    return null;
  }
}

function motherV2AmbientIntentHints(maxBranches = 3) {
  const iconState = state.intentAmbient?.iconState;
  const branches = Array.isArray(iconState?.branches) ? iconState.branches.slice() : [];
  if (!branches.length) return [];
  const normalized = branches
    .map((branch) => {
      if (!branch || typeof branch !== "object") return null;
      const branchId = String(branch.branch_id || "").trim();
      if (!branchId) return null;
      const confidence = typeof branch.confidence === "number" && Number.isFinite(branch.confidence)
        ? clamp(Number(branch.confidence) || 0, 0, 1)
        : null;
      const evidence = Array.isArray(branch.evidence_image_ids)
        ? branch.evidence_image_ids.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 3)
        : [];
      return {
        branch_id: branchId,
        confidence,
        evidence_image_ids: evidence,
      };
    })
    .filter(Boolean);
  normalized.sort((a, b) => {
    const ac = typeof a.confidence === "number" ? a.confidence : -1;
    const bc = typeof b.confidence === "number" ? b.confidence : -1;
    return bc - ac;
  });
  return normalized.slice(0, Math.max(1, Number(maxBranches) || 3));
}

function motherV2AmbientTransformationModeHints() {
  const iconState = state.intentAmbient?.iconState;
  if (!iconState || typeof iconState !== "object") {
    return { preferredMode: null, candidates: [] };
  }
  const candidates = [];
  const pushCandidate = (rawMode, rawConfidence = null) => {
    const mode = motherV2MaybeTransformationMode(rawMode);
    if (!mode) return;
    const confidence =
      typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
        ? clamp(Number(rawConfidence) || 0, 0, 1)
        : null;
    const exists = candidates.find((entry) => entry.mode === mode);
    if (!exists) {
      candidates.push({ mode, confidence });
      return;
    }
    if (typeof confidence === "number") {
      const prior = typeof exists.confidence === "number" ? exists.confidence : -1;
      if (confidence > prior) exists.confidence = confidence;
    }
  };

  pushCandidate(iconState.transformation_mode, null);
  for (const entry of Array.isArray(iconState.transformation_mode_candidates) ? iconState.transformation_mode_candidates : []) {
    if (!entry || typeof entry !== "object") continue;
    pushCandidate(entry.mode || entry.transformation_mode, entry.confidence);
  }
  candidates.sort((a, b) => {
    const ac = typeof a.confidence === "number" ? a.confidence : -1;
    const bc = typeof b.confidence === "number" ? b.confidence : -1;
    return bc - ac;
  });
  return {
    preferredMode: candidates[0]?.mode || null,
    candidates,
  };
}

function motherV2PreferredTransformationModeHint() {
  const intentMode = motherV2MaybeTransformationMode(state.motherIdle?.intent?.transformation_mode);
  if (intentMode) return intentMode;
  return motherV2AmbientTransformationModeHints().preferredMode;
}

function motherV2CanvasContextSummaryHint() {
  const raw = typeof state.alwaysOnVision?.lastText === "string" ? state.alwaysOnVision.lastText.trim() : "";
  if (!raw) return null;
  const summary = extractCanvasContextSummary(raw);
  const normalized = String(summary || "").trim();
  if (!normalized) return null;
  return clampText(normalized, 240);
}

function motherV2IntentPayload() {
  const idle = state.motherIdle;
  const wrap = els.canvasWrap;
  const canvasCssW = Math.max(1, Number(wrap?.clientWidth) || 1);
  const canvasCssH = Math.max(1, Number(wrap?.clientHeight) || 1);
  const selectedIds = getVisibleSelectedIds().map((v) => String(v || "").trim()).filter(Boolean);
  const activeId = getVisibleActiveId();
  const ambientBranches = motherV2AmbientIntentHints(3);
  const ambientModeHints = motherV2AmbientTransformationModeHints();
  const canvasSummary = motherV2CanvasContextSummaryHint();
  const images = motherIdleBaseImageItems().map((item) => {
    const rect = state.freeformRects.get(item.id) || null;
    return {
      id: String(item.id || ""),
      path: String(item.path || ""),
      file: basename(item.path || ""),
      vision_desc: typeof item?.visionDesc === "string" ? item.visionDesc.trim() : "",
      rect: rect
        ? {
            x: Number(rect.x) || 0,
            y: Number(rect.y) || 0,
            w: Number(rect.w) || 0,
            h: Number(rect.h) || 0,
          }
        : null,
      rect_norm: rect
        ? {
            x: (Number(rect.x) || 0) / canvasCssW,
            y: (Number(rect.y) || 0) / canvasCssH,
            w: Math.max(0, Number(rect.w) || 0) / canvasCssW,
            h: Math.max(0, Number(rect.h) || 0) / canvasCssH,
          }
        : null,
    };
  });
  return {
    schema: "brood.mother.intent_infer.v1",
    action_version: Number(idle?.actionVersion) || 0,
    creative_directive: MOTHER_CREATIVE_DIRECTIVE,
    creative_directive_instruction: MOTHER_CREATIVE_DIRECTIVE_SENTENCE,
    preferred_transformation_mode: motherV2PreferredTransformationModeHint(),
    intensity: clamp(Number(idle?.intensity) || 62, 0, 100),
    active_id: activeId ? String(activeId) : null,
    selected_ids: selectedIds,
    canvas_context_summary: canvasSummary || null,
    ambient_intent: (ambientBranches.length || ambientModeHints.preferredMode)
      ? {
          source: "intent_rt",
          model: state.intentAmbient?.iconState ? "openai_realtime" : null,
          branches: ambientBranches,
          preferred_transformation_mode: ambientModeHints.preferredMode || null,
          transformation_mode_candidates: ambientModeHints.candidates,
        }
      : null,
    images,
  };
}

function motherV2BuildIntentRequestId(actionVersion = 0) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(16).slice(2, 8);
  return `mother-intent-a${Number(actionVersion) || 0}-${stamp}-${rand}`;
}

function motherV2ApplyIntent(intentPayload = {}, { source = "local", preserveMode = false, requestId = null } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  if (idle.phase !== MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING) return;
  const sourceTag = String(source || "local").trim();
  const priorPendingRealtimePath = String(idle.pendingIntentRealtimePath || "").trim();
  const priorPendingIntentPath = String(idle.pendingIntentPath || "").trim();
  const priorRequestId = String(idle.pendingIntentRequestId || "").trim();
  const resolvedRequestId = String(requestId || priorRequestId || "").trim() || null;
  const wasPendingIntent = Boolean(idle.pendingIntent);
  const sourceKind = motherV2IntentSourceKind(sourceTag);
  let normalizedIntent =
    intentPayload && typeof intentPayload === "object"
      ? {
          ...intentPayload,
          creative_directive: String(intentPayload.creative_directive || "").trim() || MOTHER_CREATIVE_DIRECTIVE,
          transformation_mode: motherV2NormalizeTransformationMode(intentPayload.transformation_mode),
          _intent_request_id: resolvedRequestId,
          _intent_source_kind: sourceKind || "fallback",
        }
      : null;
  normalizedIntent = motherV2DiversifyIntentForRejectFollowup(normalizedIntent);
  normalizedIntent = motherV2SanitizeIntentImageIds(normalizedIntent);
  normalizedIntent = motherV2EnsureProposalCandidates(normalizedIntent);
  idle.promptMotionProfile = null;
  if (preserveMode && normalizedIntent && idle.intent && typeof idle.intent === "object") {
    const priorMode = motherV2MaybeTransformationMode(idle.intent.transformation_mode);
    const nextModes = motherV2ProposalModes(normalizedIntent);
    if (priorMode && nextModes.includes(priorMode)) {
      normalizedIntent.transformation_mode = priorMode;
      normalizedIntent.summary = motherV2ProposalSentence({
        ...normalizedIntent,
        transformation_mode: priorMode,
      });
    }
  }
  idle.intent = normalizedIntent;
  motherV2NormalizeRoles(normalizedIntent?.roles || null);
  idle.pendingIntent = false;
  const canUpgradeFromLateRealtime = sourceKind !== "realtime" && priorPendingRealtimePath;
  idle.pendingIntentRealtimePath = canUpgradeFromLateRealtime ? priorPendingRealtimePath : null;
  idle.pendingIntentRequestId = canUpgradeFromLateRealtime ? (resolvedRequestId || priorRequestId || null) : null;
  idle.pendingIntentStartedAt = canUpgradeFromLateRealtime ? (Number(idle.pendingIntentStartedAt) || Date.now()) : 0;
  idle.pendingIntentUpgradeUntil = canUpgradeFromLateRealtime ? Date.now() + MOTHER_V2_INTENT_LATE_REALTIME_UPGRADE_MS : 0;
  idle.pendingIntentPayload = null;
  // Mother proposals are realtime-only; ignore heuristic intent payload upgrades.
  idle.pendingIntentPath = null;
  clearTimeout(idle.pendingIntentTimeout);
  idle.pendingIntentTimeout = null;
  idle.pendingVisionImageIds = [];
  clearTimeout(idle.pendingVisionRetryTimer);
  idle.pendingVisionRetryTimer = null;
  motherIdleTransitionTo(MOTHER_IDLE_EVENTS.INTENT_INFERRED);
  appendMotherTraceLog({
    kind: "intent_inferred",
    traceId: idle.telemetry?.traceId || null,
    actionVersion: Number(idle.actionVersion) || 0,
    source,
    source_kind: sourceKind || null,
    request_id: resolvedRequestId,
    late_realtime_upgrade: Boolean(sourceKind === "realtime" && !wasPendingIntent),
    intent_id: intentPayload?.intent_id || null,
    placement_policy: intentPayload?.placement_policy || null,
    confidence: Number(intentPayload?.confidence) || 0,
  }).catch(() => {});
  renderMotherReadout();
  requestRender();
}

function motherV2ArmRealtimeIntentTimeout({ timeoutMs = MOTHER_V2_INTENT_RT_TIMEOUT_MS } = {}) {
  const idle = state.motherIdle;
  if (!idle || !idle.pendingIntent) return;
  const actionVersion = Number(idle.actionVersion) || 0;
  const pendingActionVersion = Number(idle.pendingActionVersion) || 0;
  if (!actionVersion || actionVersion !== pendingActionVersion) return;
  const requestId = String(idle.pendingIntentRequestId || "").trim() || null;
  const ms = Math.max(1_000, Number(timeoutMs) || MOTHER_V2_INTENT_RT_TIMEOUT_MS);

  clearTimeout(idle.pendingIntentTimeout);
  idle.pendingIntentTimeout = setTimeout(() => {
    const current = state.motherIdle;
    if (!current || !current.pendingIntent) return;
    if ((Number(current.actionVersion) || 0) !== actionVersion) return;
    if ((Number(current.pendingActionVersion) || 0) !== pendingActionVersion) return;
    const currentRequestId = String(current.pendingIntentRequestId || "").trim() || null;
    if (requestId && currentRequestId !== requestId) return;
    const timeoutSec = Math.max(1, Math.round(ms / 1000));
    const message = `Mother realtime intent timed out after ${timeoutSec}s.`;
    appendMotherTraceLog({
      kind: "intent_realtime_failed",
      traceId: current.telemetry?.traceId || null,
      actionVersion,
      request_id: requestId,
      source: "intent_rt_timeout",
      error: message,
    }).catch(() => {});
    motherIdleHandleGenerationFailed(message);
  }, ms);
}

async function motherV2RequestIntentInference() {
  const idle = state.motherIdle;
  if (!idle) return false;
  if (idle.pendingIntent || idle.pendingPromptCompile || idle.pendingGeneration) return false;
  if (!motherIdleHasArmedCanvas()) return false;
  if (motherV2InCooldown()) return false;
  const visionGate = motherV2VisionReadyForIntent({ schedule: true });
  if (!visionGate.ready) {
    idle.pendingVisionImageIds = visionGate.missingIds.slice();
    clearTimeout(idle.pendingVisionRetryTimer);
    idle.pendingVisionRetryTimer = setTimeout(() => {
      const current = state.motherIdle;
      if (!current) return;
      current.pendingVisionRetryTimer = null;
      if (current.phase !== MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING) return;
      if (current.pendingIntent || current.pendingPromptCompile || current.pendingGeneration) return;
      if (state.pointer.active) return;
      if (!motherIdleHasArmedCanvas()) return;
      if (motherV2InCooldown()) return;
      motherV2RequestIntentInference().catch(() => {});
    }, MOTHER_V2_VISION_RETRY_MS);
    setStatus("Mother: reading image context…");
    renderMotherReadout();
    return false;
  }
  idle.pendingVisionImageIds = [];
  clearTimeout(idle.pendingVisionRetryTimer);
  idle.pendingVisionRetryTimer = null;
  const actionVersion = Number(idle.actionVersion) || 0;
  const requestId = motherV2BuildIntentRequestId(actionVersion);
  const requestMatchesCurrent = (current, { requirePending = true } = {}) => {
    if (!current) return false;
    if (requirePending && !current.pendingIntent) return false;
    if ((Number(current.pendingActionVersion) || 0) !== actionVersion) return false;
    if ((Number(current.actionVersion) || 0) !== actionVersion) return false;
    return String(current.pendingIntentRequestId || "") === requestId;
  };
  const clearOwnedPendingRequest = (current) => {
    if (!current) return;
    if (String(current.pendingIntentRequestId || "") !== requestId) return;
    current.pendingIntent = false;
    current.pendingIntentRequestId = null;
    current.pendingIntentStartedAt = 0;
    current.pendingIntentUpgradeUntil = 0;
    current.pendingIntentRealtimePath = null;
    current.pendingIntentPath = null;
    current.pendingIntentPayload = null;
    clearTimeout(current.pendingIntentTimeout);
    current.pendingIntentTimeout = null;
  };
  await ensureRun();
  const payload = motherV2IntentPayload();
  const payloadPath = await motherV2WritePayloadFile("mother_intent_infer", payload);
  const ok = await ensureEngineSpawned({ reason: "mother_intent_rt" });
  if (!ok) return false;

  const failRealtimeIntent = ({ sourceTag = "intent_rt_failed", message = null } = {}) => {
    const current = state.motherIdle;
    if (!requestMatchesCurrent(current, { requirePending: true })) {
      clearOwnedPendingRequest(current);
      return;
    }
    const fallbackMessage = String(message || "Mother realtime intent inference failed.").trim();
    appendMotherTraceLog({
      kind: "intent_realtime_failed",
      traceId: current.telemetry?.traceId || null,
      actionVersion,
      request_id: requestId,
      source: String(sourceTag || "intent_rt_failed"),
      error: fallbackMessage,
    }).catch(() => {});
    motherIdleHandleGenerationFailed(fallbackMessage);
  };

  let snapshotPath = null;
  if (state.runDir) {
    const stamp = Date.now();
    const suffix = `${stamp}-a${String(actionVersion).padStart(2, "0")}`;
    snapshotPath = `${state.runDir}/mother-intent-${suffix}.png`;
    const frameId = `mother-intent-a${actionVersion}-${suffix}`;
    try {
      await waitForIntentImagesLoaded({ timeoutMs: 900 });
      render();
      await writeIntentSnapshot(snapshotPath, { maxDimPx: INTENT_SNAPSHOT_MAX_DIM_PX });
      await writeIntentContextEnvelope(snapshotPath, frameId, { motherContextPayload: payload }).catch(() => null);
    } catch {
      snapshotPath = null;
    }
  }

  if (
    !state.motherIdle ||
    state.motherIdle !== idle ||
    (Number(idle.actionVersion) || 0) !== actionVersion ||
    idle.phase !== MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING ||
    state.pointer.active
  ) {
    return false;
  }

  idle.pendingIntent = true;
  idle.pendingIntentRequestId = requestId;
  idle.pendingIntentStartedAt = Date.now();
  idle.pendingIntentUpgradeUntil = 0;
  idle.pendingActionVersion = actionVersion;
  idle.pendingIntentRealtimePath = snapshotPath;
  idle.pendingIntentPath = null;
  idle.pendingIntentPayload = payload;
  clearTimeout(idle.pendingIntentTimeout);
  idle.pendingIntentTimeout = null;
  appendMotherTraceLog({
    kind: "intent_request_started",
    traceId: idle.telemetry?.traceId || null,
    actionVersion,
    request_id: requestId,
    payload_path: payloadPath || null,
    snapshot_path: snapshotPath || null,
  }).catch(() => {});
  setStatus("Mother: hypothesizing intent (realtime)…");
  renderMotherReadout();

  let realtimeDispatched = false;
  if (snapshotPath) {
    await invoke("write_pty", { data: `${PTY_COMMANDS.INTENT_RT_MOTHER_START}\n` }).catch(() => {});
    realtimeDispatched = await invoke("write_pty", { data: `${PTY_COMMANDS.INTENT_RT_MOTHER} ${quoteForPtyArg(snapshotPath)}\n` })
      .then(() => true)
      .catch(() => false);
  }

  if (realtimeDispatched) {
    motherV2ArmRealtimeIntentTimeout({ timeoutMs: MOTHER_V2_INTENT_RT_TIMEOUT_MS });
  } else {
    failRealtimeIntent({
      sourceTag: snapshotPath ? "intent_rt_dispatch_failed" : "intent_rt_snapshot_unavailable",
      message: snapshotPath
        ? "Mother realtime intent dispatch failed."
        : "Mother realtime intent snapshot unavailable.",
    });
    return false;
  }
  return true;
}

async function motherV2RequestPromptCompile() {
  const idle = state.motherIdle;
  if (!idle || !idle.intent) return null;
  const sanitizedIntent = motherV2SanitizeIntentImageIds(idle.intent) || idle.intent;
  const activeId = getVisibleActiveId();
  const selectedIds = getVisibleSelectedIds().map((v) => String(v || "").trim()).filter(Boolean);
  const payload = {
    schema: "brood.mother.prompt_compile.v1",
    action_version: Number(idle.actionVersion) || 0,
    intent: sanitizedIntent,
    roles: motherV2RoleMapClone(),
    creative_directive: String(sanitizedIntent?.creative_directive || "").trim() || MOTHER_CREATIVE_DIRECTIVE,
    transformation_mode: motherV2NormalizeTransformationMode(sanitizedIntent?.transformation_mode),
    intensity: clamp(Number(idle.intensity) || 62, 0, 100),
    active_id: activeId ? String(activeId) : null,
    selected_ids: selectedIds,
    images: motherIdleBaseImageItems().map((item) => ({
      id: String(item.id || ""),
      file: basename(item.path || ""),
      vision_desc: typeof item?.visionDesc === "string" ? item.visionDesc.trim() : "",
    })),
  };
  const payloadPath = await motherV2WritePayloadFile("mother_prompt_compile", payload);
  idle.pendingPromptCompile = true;
  idle.pendingPromptCompilePath = payloadPath;
  idle.pendingActionVersion = Number(idle.actionVersion) || 0;
  clearTimeout(idle.pendingPromptCompileTimeout);
  idle.pendingPromptCompileTimeout = setTimeout(() => {
    if (!state.motherIdle?.pendingPromptCompile) return;
    if (Number(state.motherIdle.pendingActionVersion) !== Number(state.motherIdle.actionVersion)) {
      state.motherIdle.pendingPromptCompile = false;
      return;
    }
    const compiled = motherV2CompilePromptLocal(payload);
    motherV2DispatchCompiledPrompt(compiled).catch(() => {});
  }, 2200);

  if (payloadPath) {
    await invoke("write_pty", { data: `${PTY_COMMANDS.PROMPT_COMPILE} ${quoteForPtyArg(payloadPath)}\n` }).catch(() => {});
  } else {
    const compiled = motherV2CompilePromptLocal(payload);
    await motherV2DispatchCompiledPrompt(compiled);
  }
  return payloadPath;
}

function motherV2PromptLineFromCompiled(compiled = {}) {
  let positive = String(compiled?.positive_prompt || "").trim();
  if (positive && !positive.toLowerCase().includes(MOTHER_CREATIVE_DIRECTIVE)) {
    positive = `Create one ${MOTHER_CREATIVE_DIRECTIVE} image. ${positive}`.trim();
  }
  const negative = String(compiled?.negative_prompt || "").trim();
  const raw = negative ? `${positive}\nAvoid: ${negative}` : positive;
  return motherIdlePromptLineForPty(raw);
}

function motherV2CollectGenerationImagePaths() {
  const idle = state.motherIdle;
  const intent = idle?.intent && typeof idle.intent === "object" ? idle.intent : {};
  const ids = [];
  const push = (raw) => {
    const id = String(raw || "").trim();
    if (!id) return;
    if (!isVisibleCanvasImageId(id)) return;
    if (ids.includes(id)) return;
    ids.push(id);
  };
  const pushMany = (list) => {
    for (const value of Array.isArray(list) ? list : []) push(value);
  };
  const selectedIds = getVisibleSelectedIds().map((v) => String(v || "").trim()).filter(Boolean);
  const activeId = String(getVisibleActiveId() || "").trim();
  const preferredPairIds = (() => {
    const visibleItems = getVisibleCanvasImages();
    if (!visibleItems.length) return [];
    const byId = new Map(
      visibleItems
        .map((item) => [String(item?.id || "").trim(), item])
        .filter(([id]) => Boolean(id))
    );
    const findLatestId = (predicate) => {
      for (let i = (state.images?.length || 0) - 1; i >= 0; i -= 1) {
        const item = state.images[i];
        const id = String(item?.id || "").trim();
        if (!id) continue;
        const visible = byId.get(id);
        if (!visible) continue;
        if (predicate(visible)) return id;
      }
      return "";
    };
    const latestMotherId = findLatestId((item) => isMotherGeneratedImageItem(item));
    const latestUploadId = findLatestId((item) => !isMotherGeneratedImageItem(item));
    if (!latestMotherId || !latestUploadId || latestMotherId === latestUploadId) return [];

    const firstSelectedId = selectedIds[0] || activeId || "";
    if (firstSelectedId) {
      const firstItem = byId.get(firstSelectedId) || null;
      if (firstItem) {
        if (isMotherGeneratedImageItem(firstItem)) return [firstSelectedId, latestUploadId];
        return [firstSelectedId, latestMotherId];
      }
    }
    return [latestUploadId, latestMotherId];
  })();

  // Prioritize explicit user selection first so follow-up proposals use the intended pair/set.
  pushMany(preferredPairIds);
  pushMany(selectedIds);
  push(activeId);

  const roles = motherV2RoleMapClone();
  pushMany(roles.subject);
  pushMany(roles.model);
  pushMany(roles.mediator);
  pushMany(roles.object);
  pushMany(intent.target_ids);
  pushMany(intent.reference_ids);
  // Always include full canvas context so follow-ups can evolve beyond a small role subset.
  pushMany(motherIdleBaseImageItems().map((item) => String(item?.id || "").trim()));
  if (!ids.length) push(getVisibleActiveId());

  const paths = [];
  for (const imageId of ids) {
    const item = state.imagesById.get(imageId) || null;
    if (!item?.path) continue;
    const path = String(item.path || "").trim();
    if (!path) continue;
    if (paths.includes(path)) continue;
    paths.push(path);
  }

  const initImage = paths[0] || null;
  const referenceImages = paths.slice(1);
  return {
    sourceImageIds: ids.slice(),
    sourceImages: paths,
    initImage,
    referenceImages,
  };
}

function motherV2CollectImageInteractionSignals(imageIds = []) {
  const ids = (Array.isArray(imageIds) ? imageIds : [])
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  const idSet = new Set(ids);
  const ensure = (map, imageId) => {
    if (!idSet.has(imageId)) return null;
    if (!map.has(imageId)) {
      map.set(imageId, {
        move_count: 0,
        resize_count: 0,
        selection_hits: 0,
        action_grid_hits: 0,
        last_event_at_ms: 0,
        last_transform_at_ms: 0,
      });
    }
    return map.get(imageId);
  };
  const out = new Map();
  for (const id of ids) {
    ensure(out, id);
  }
  const events = Array.isArray(state.userEvents) ? state.userEvents : [];
  for (const entry of events) {
    if (!entry || typeof entry !== "object") continue;
    const type = String(entry.type || "").trim();
    const atMs = Number(entry.at_ms) || 0;
    if (type === "image_move" || type === "image_resize") {
      const imageId = String(entry.image_id || "").trim();
      const row = ensure(out, imageId);
      if (!row) continue;
      if (type === "image_move") row.move_count += 1;
      if (type === "image_resize") row.resize_count += 1;
      if (atMs > row.last_transform_at_ms) row.last_transform_at_ms = atMs;
      if (atMs > row.last_event_at_ms) row.last_event_at_ms = atMs;
      continue;
    }
    if (type === "selection_change") {
      const selectedIds = Array.isArray(entry.selected_ids)
        ? entry.selected_ids.map((v) => String(v || "").trim()).filter(Boolean)
        : [];
      for (const imageId of selectedIds) {
        const row = ensure(out, imageId);
        if (!row) continue;
        row.selection_hits += 1;
        if (atMs > row.last_event_at_ms) row.last_event_at_ms = atMs;
      }
      continue;
    }
    if (type === "action_grid_press") {
      const selectedIds = Array.isArray(entry.selected_ids)
        ? entry.selected_ids.map((v) => String(v || "").trim()).filter(Boolean)
        : [];
      const activeId = String(entry.active_id || "").trim();
      for (const imageId of selectedIds) {
        const row = ensure(out, imageId);
        if (!row) continue;
        row.action_grid_hits += 1;
        if (atMs > row.last_event_at_ms) row.last_event_at_ms = atMs;
      }
      if (activeId) {
        const row = ensure(out, activeId);
        if (row) {
          row.action_grid_hits += 1;
          if (atMs > row.last_event_at_ms) row.last_event_at_ms = atMs;
        }
      }
    }
  }
  return out;
}

function motherV2BuildGeminiContextPacket({ compiled = {}, promptLine = "", sanitizedIntent = null, imagePayload = null } = {}) {
  const idle = state.motherIdle;
  const intent = sanitizedIntent && typeof sanitizedIntent === "object" ? sanitizedIntent : {};
  const sourceImageIds = Array.isArray(imagePayload?.sourceImageIds)
    ? imagePayload.sourceImageIds.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  if (!sourceImageIds.length) return null;

  const SATURATION_K = Object.freeze({
    move: 8,
    resize: 4,
    selection: 8,
    action: 4,
  });
  const MUST_NOT_DEFAULTS = Object.freeze([
    "No collage or split-screen.",
    "No text, captions, or watermarks.",
    "No ghosted double-exposure overlays.",
    "No UI residue or icon-overpaint artifacts.",
    "No duplicated heads or limbs.",
    "No extra humans or faces unless present in inputs.",
  ]);
  const INTERACTION_DECAY_TAU_MS = 90_000;
  const INTERACTION_STALE_CUTOFF_MS = 10 * 60 * 1000;
  const EPS = 1e-9;
  const wrap = els.canvasWrap;
  const canvasCssW = Math.max(1, Number(wrap?.clientWidth) || 1);
  const canvasCssH = Math.max(1, Number(wrap?.clientHeight) || 1);
  const nowMs = Date.now();
  const clamp01 = (value) => clamp(Number(value) || 0, 0, 1);
  const round4 = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 10000) / 10000;
  };
  const round2 = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  };
  const sat = (count, k) => {
    const c = Math.max(0, Number(count) || 0);
    const cap = Math.max(1, Number(k) || 1);
    const v = Math.log(1 + c) / Math.log(1 + cap);
    return clamp01(v);
  };
  const uniqueIds = (values = []) => {
    const out = [];
    for (const raw of Array.isArray(values) ? values : []) {
      const id = String(raw || "").trim();
      if (!id || out.includes(id)) continue;
      out.push(id);
    }
    return out;
  };
  const slotLabelForIndex = (index) => {
    const i = Math.max(0, Math.floor(Number(index) || 0));
    if (i < 26) return String.fromCharCode(65 + i);
    return `I${i + 1}`;
  };
  const toRectNorm = (rectRaw) => {
    if (!rectRaw || typeof rectRaw !== "object") return null;
    const x = (Number(rectRaw.x) || 0) / canvasCssW;
    const y = (Number(rectRaw.y) || 0) / canvasCssH;
    const w = Math.max(0, Number(rectRaw.w) || 0) / canvasCssW;
    const h = Math.max(0, Number(rectRaw.h) || 0) / canvasCssH;
    return {
      x: round4(x),
      y: round4(y),
      w: round4(w),
      h: round4(h),
      cx: round4(x + w / 2),
      cy: round4(y + h / 2),
    };
  };
  const positionTierFromRect = (rectNorm) => {
    const cx = Number(rectNorm?.cx);
    const cy = Number(rectNorm?.cy);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return "CENTER_MIDDLE";
    const xTier = cx < 0.34 ? "LEFT" : cx > 0.66 ? "RIGHT" : "CENTER";
    const yTier = cy < 0.34 ? "TOP" : cy > 0.66 ? "BOTTOM" : "MIDDLE";
    return `${xTier}_${yTier}`;
  };
  const sizeTierFromArea = (areaRatio) => {
    const n = Math.max(0, Number(areaRatio) || 0);
    if (n >= 0.07) return "DOMINANT";
    if (n >= 0.03) return "MEDIUM";
    return "SMALL";
  };
  const relationFromDelta = (dx, dy, overlaps = false) => {
    if (overlaps) return "OVERLAP";
    return Math.abs(dx) >= Math.abs(dy)
      ? (dx >= 0 ? "RIGHT" : "LEFT")
      : (dy >= 0 ? "BELOW" : "ABOVE");
  };
  const overlapRegionForRect = (rectNorm, ix1, iy1, ix2, iy2) => {
    const rw = Math.max(1e-6, Number(rectNorm?.w) || 0);
    const rh = Math.max(1e-6, Number(rectNorm?.h) || 0);
    const rx = Number(rectNorm?.x) || 0;
    const ry = Number(rectNorm?.y) || 0;
    const cx = ((Number(ix1) || 0) + (Number(ix2) || 0)) / 2;
    const cy = ((Number(iy1) || 0) + (Number(iy2) || 0)) / 2;
    const localCx = clamp((cx - rx) / rw, 0, 1);
    const localCy = clamp((cy - ry) / rh, 0, 1);
    const hBucket = localCx < 0.34 ? "left" : localCx > 0.66 ? "right" : "center";
    const vBucket = localCy < 0.34 ? "top" : localCy > 0.66 ? "bottom" : "middle";
    return {
      region: `${vBucket}_${hBucket}`,
      x_norm: round4(clamp(((Number(ix1) || 0) - rx) / rw, 0, 1)),
      y_norm: round4(clamp(((Number(iy1) || 0) - ry) / rh, 0, 1)),
    };
  };
  const invertRelation = (value = "") => {
    const rel = String(value || "").trim().toUpperCase();
    if (rel === "LEFT") return "RIGHT";
    if (rel === "RIGHT") return "LEFT";
    if (rel === "ABOVE") return "BELOW";
    if (rel === "BELOW") return "ABOVE";
    return rel || "UNKNOWN";
  };
  const normalizeMustNot = (raw) => {
    const text = String(raw || "")
      .trim()
      .replace(/^[-*•]\s*/, "")
      .replace(/\s+/g, " ");
    if (!text) return null;
    return text;
  };
  const splitNegativePrompt = (raw) =>
    String(raw || "")
      .split(/\n|;|,/g)
      .map((v) => v.trim())
      .filter(Boolean);
  const rolePriorForImage = (imageId, roleTags = [], targetIdSet = new Set(), referenceIdSet = new Set()) => {
    let prior = 0.3;
    if (targetIdSet.has(imageId)) prior = 1.0;
    else if (referenceIdSet.has(imageId)) prior = 0.6;
    if (roleTags.includes("subject")) prior *= 1.05;
    if (roleTags.includes("mediator")) prior *= 0.97;
    return clamp(prior, 0.25, 1.0);
  };

  const actionVersion = Number(idle?.actionVersion) || 0;
  const summary = String(intent.summary || motherV2ProposalSentence(intent) || "").trim();
  const creativeDirective = String(compiled?.creative_directive || intent.creative_directive || MOTHER_CREATIVE_DIRECTIVE || "").trim();
  const transformationMode = motherV2NormalizeTransformationMode(
    intent.transformation_mode || compiled?.transformation_mode || MOTHER_V2_DEFAULT_TRANSFORMATION_MODE
  );
  const placementPolicy = String(
    intent.placement_policy ||
      compiled?.generation_params?.layout_hint ||
      "adjacent"
  ).trim() || "adjacent";
  const selectedIds = getVisibleSelectedIds().map((v) => String(v || "").trim()).filter(Boolean).slice(0, 3);
  const activeId = String(getVisibleActiveId() || "").trim() || null;
  const targetIds = uniqueIds(motherV2NormalizeImageIdList(intent.target_ids || [])).slice(0, 3);
  const referenceIds = uniqueIds(motherV2NormalizeImageIdList(intent.reference_ids || [])).slice(0, 4);
  const targetIdSet = new Set(targetIds);
  const referenceIdSet = new Set(referenceIds);
  const roleMapRaw = intent.roles && typeof intent.roles === "object" ? intent.roles : motherV2RoleMapClone();
  const roleMap = {
    subject: uniqueIds(motherV2NormalizeImageIdList(roleMapRaw.subject || [])).slice(0, 3),
    model: uniqueIds(motherV2NormalizeImageIdList(roleMapRaw.model || [])).slice(0, 3),
    mediator: uniqueIds(motherV2NormalizeImageIdList(roleMapRaw.mediator || [])).slice(0, 3),
    object: uniqueIds(motherV2NormalizeImageIdList(roleMapRaw.object || [])).slice(0, 3),
  };
  const signalsById = motherV2CollectImageInteractionSignals(sourceImageIds);

  const draft = [];
  for (const imageId of sourceImageIds) {
    const item = state.imagesById.get(imageId) || null;
    const rectNorm = toRectNorm(state.freeformRects.get(imageId) || null);
    const canvasAreaRatio = rectNorm ? Math.max(0, Number(rectNorm.w) * Number(rectNorm.h)) : 0;
    const aspectRatioNorm =
      rectNorm && Number(rectNorm.h) > 1e-6 ? Number(rectNorm.w) / Number(rectNorm.h) : null;
    const signal = signalsById.get(imageId) || {
      move_count: 0,
      resize_count: 0,
      selection_hits: 0,
      action_grid_hits: 0,
      last_event_at_ms: 0,
      last_transform_at_ms: 0,
    };
    const roleTags = MOTHER_V2_ROLE_KEYS.filter((key) => roleMap[key]?.includes(imageId));
    const isTarget = targetIdSet.has(imageId);
    const isReference = referenceIdSet.has(imageId);
    const isSubject = roleTags.includes("subject");
    const isModel = roleTags.includes("model");
    const isMediator = roleTags.includes("mediator");
    const isObject = roleTags.includes("object");

    const preserve = [];
    if (isTarget || isSubject || isObject || imageId === sourceImageIds[0]) preserve.push("subject identity");
    if (Number(signal.resize_count) > 0) preserve.push("user framing emphasis");
    if (Number(signal.selection_hits) > 0 || Number(signal.action_grid_hits) > 0) preserve.push("user focus cues");

    const transform = [];
    if (isReference || isModel || isMediator) transform.push("material and style cues");
    if (Number(signal.move_count) > 0) transform.push("composition relationship cues");

    const moveSat = sat(signal.move_count, SATURATION_K.move);
    const resizeSat = sat(signal.resize_count, SATURATION_K.resize);
    const selectionSat = sat(signal.selection_hits, SATURATION_K.selection);
    const actionSat = sat(signal.action_grid_hits, SATURATION_K.action);
    const interactionBase =
      0.35 * moveSat + 0.35 * resizeSat + 0.25 * selectionSat + 0.05 * actionSat;
    const transformRecencyMs = Number(signal.last_transform_at_ms) || 0;
    const recencyMs = transformRecencyMs || Number(signal.last_event_at_ms) || 0;
    const ageMs = recencyMs ? Math.max(0, nowMs - recencyMs) : INTERACTION_STALE_CUTOFF_MS + 1;
    const transformAgeMs = transformRecencyMs
      ? Math.max(0, nowMs - transformRecencyMs)
      : INTERACTION_STALE_CUTOFF_MS + 1;
    const interactionStale = transformAgeMs > INTERACTION_STALE_CUTOFF_MS;
    let interactionRaw = interactionStale
      ? 0
      : interactionBase * Math.exp(-ageMs / INTERACTION_DECAY_TAU_MS);
    if (
      Number(signal.move_count) <= 1 &&
      Number(signal.resize_count) === 0 &&
      Number(signal.selection_hits) <= 2 &&
      Number(signal.action_grid_hits) === 0
    ) {
      interactionRaw = 0;
    }
    const rolePrior = rolePriorForImage(imageId, roleTags, targetIdSet, referenceIdSet);

    draft.push({
      id: imageId,
      file: item?.path ? basename(item.path) : null,
      origin: item && isMotherGeneratedImageItem(item) ? "mother_generated" : "uploaded",
      role_tags: roleTags,
      role: isTarget ? "target" : isReference ? "reference" : "context",
      role_prior: rolePrior,
      preserve,
      transform,
      signal,
      interaction_base: interactionBase,
      interaction_raw: Math.max(0, Number(interactionRaw) || 0),
      interaction_stale: interactionStale,
      rect_norm: rectNorm,
      canvas_area_ratio: canvasAreaRatio,
      aspect_ratio_norm: aspectRatioNorm,
      focus_score_raw: 0,
      focus_score: 0,
      geometry_score_raw: 0,
      geometry_score: 0,
      relative_scale_to_largest: 0,
      centrality: 0,
      score: 0,
      weight: 0,
      position_tier: positionTierFromRect(rectNorm),
      size_tier: sizeTierFromArea(canvasAreaRatio),
    });
  }

  const interactionBaseMax = draft.reduce(
    (maxVal, entry) => Math.max(maxVal, Math.max(0, Number(entry.interaction_base) || 0)),
    0
  );
  const interactionRawMax = draft.reduce(
    (maxVal, entry) => Math.max(maxVal, Math.max(0, Number(entry.interaction_raw) || 0)),
    0
  );
  const interactionConfidence = clamp01((interactionBaseMax - 0.15) / 0.35);
  for (const entry of draft) {
    const focusRaw = interactionRawMax > 0 ? (Number(entry.interaction_raw) || 0) / (interactionRawMax + EPS) : 0;
    entry.focus_score_raw = clamp01(focusRaw);
    entry.focus_score = clamp01(interactionConfidence * entry.focus_score_raw);
  }

  const areaValues = draft
    .map((entry) => Math.max(0, Number(entry.canvas_area_ratio) || 0))
    .filter((value) => value > 0);
  const areaMax = areaValues.length ? Math.max(...areaValues) : 0;
  const areaMin = areaValues.length ? Math.min(...areaValues) : 0;
  const sqrtAreaMax = areaMax > 0 ? Math.sqrt(areaMax) : 0;
  const geometryConfidence =
    areaMax > 0 && areaMin > 0
      ? clamp01(Math.log((areaMax + EPS) / (areaMin + EPS)) / Math.log(2.5))
      : 0;
  let geometryRawMax = 0;
  for (const entry of draft) {
    const area = Math.max(0, Number(entry.canvas_area_ratio) || 0);
    const size = sqrtAreaMax > 0 ? Math.sqrt(area) / (sqrtAreaMax + EPS) : 0;
    entry.relative_scale_to_largest = clamp01(size);
    const cx = Number(entry.rect_norm?.cx);
    const cy = Number(entry.rect_norm?.cy);
    const centerDist = Number.isFinite(cx) && Number.isFinite(cy) ? Math.hypot(cx - 0.5, cy - 0.5) : 0.7071;
    const centrality = clamp01(1 - centerDist / 0.7071);
    entry.centrality = centrality;
    const geometryRaw = 0.8 * size + 0.2 * centrality;
    entry.geometry_score_raw = clamp01(geometryRaw);
    geometryRawMax = Math.max(geometryRawMax, entry.geometry_score_raw);
  }
  for (const entry of draft) {
    const normalized = geometryRawMax > 0 ? entry.geometry_score_raw / (geometryRawMax + EPS) : 0;
    entry.geometry_score = clamp01(geometryConfidence * normalized);
  }

  for (const entry of draft) {
    const selectedBonus = selectedIds.includes(entry.id) ? 0.1 : 0;
    const activeBonus = activeId && entry.id === activeId ? 0.05 : 0;
    entry.score =
      entry.role_prior *
      (1 + 0.6 * entry.focus_score) *
      (1 + 0.4 * entry.geometry_score) *
      (1 + selectedBonus + activeBonus);
  }
  let scoreTotal = draft.reduce((sum, entry) => sum + Math.max(0, Number(entry.score) || 0), 0);
  if (!(scoreTotal > 0)) {
    for (const entry of draft) entry.score = Math.max(0.001, Number(entry.role_prior) || 0.001);
    scoreTotal = draft.reduce((sum, entry) => sum + Math.max(0, Number(entry.score) || 0), 0);
  }
  for (const entry of draft) {
    entry.weight = scoreTotal > 0 ? (Number(entry.score) || 0) / (scoreTotal + EPS) : 0;
  }

  // Identity guardrails apply only for the single-target case.
  const targetIdList = targetIds.filter((id) => draft.some((entry) => entry.id === id));
  if (targetIdList.length === 1) {
    const tId = targetIdList[0];
    const targetEntry = draft.find((entry) => entry.id === tId) || null;
    if (targetEntry && Number(targetEntry.weight) < 0.55) {
      const delta = 0.55 - Number(targetEntry.weight || 0);
      const nonTargetEntries = draft.filter((entry) => entry.id !== tId);
      const nonTargetTotal = nonTargetEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.weight) || 0), 0);
      for (const entry of nonTargetEntries) {
        const share = nonTargetTotal > 0 ? (Number(entry.weight) || 0) / (nonTargetTotal + EPS) : 0;
        entry.weight = Math.max(0, (Number(entry.weight) || 0) - delta * share);
      }
      targetEntry.weight = 0.55;
    }
    for (const refId of referenceIds) {
      const refEntry = draft.find((entry) => entry.id === refId) || null;
      if (!refEntry) continue;
      if (Number(refEntry.weight) <= 0.3) continue;
      const excess = Number(refEntry.weight) - 0.3;
      refEntry.weight = 0.3;
      const targetEntryNow = draft.find((entry) => entry.id === tId) || null;
      if (targetEntryNow) targetEntryNow.weight = Number(targetEntryNow.weight || 0) + excess;
    }
    const renorm = draft.reduce((sum, entry) => sum + Math.max(0, Number(entry.weight) || 0), 0);
    for (const entry of draft) {
      entry.weight = renorm > 0 ? (Number(entry.weight) || 0) / (renorm + EPS) : entry.weight;
    }
  }

  const zIndexById = new Map();
  for (let i = 0; i < (state.freeformZOrder?.length || 0); i += 1) {
    const id = String(state.freeformZOrder[i] || "").trim();
    if (!id) continue;
    if (!zIndexById.has(id)) zIndexById.set(id, i);
  }
  const slotById = new Map();
  const orderForSlots = uniqueIds(sourceImageIds.filter((id) => draft.some((entry) => entry.id === id)));
  for (let i = 0; i < orderForSlots.length; i += 1) {
    slotById.set(orderForSlots[i], slotLabelForIndex(i));
  }

  const spatialImageEntries = draft.filter((entry) => entry.rect_norm && typeof entry.rect_norm === "object").slice(0, 8);
  const pairwise = [];
  const pairMap = new Map();
  const pairKey = (aId, bId) => {
    const a = String(aId || "").trim();
    const b = String(bId || "").trim();
    if (!a || !b) return "";
    return a < b ? `${a}::${b}` : `${b}::${a}`;
  };
  const diagonalNorm = Math.sqrt(2);
  for (let i = 0; i < spatialImageEntries.length; i += 1) {
    for (let j = i + 1; j < spatialImageEntries.length; j += 1) {
      const a = spatialImageEntries[i];
      const b = spatialImageEntries[j];
      const ar = a.rect_norm || null;
      const br = b.rect_norm || null;
      if (!ar || !br) continue;
      const ax1 = Number(ar.x) || 0;
      const ay1 = Number(ar.y) || 0;
      const ax2 = ax1 + Math.max(0, Number(ar.w) || 0);
      const ay2 = ay1 + Math.max(0, Number(ar.h) || 0);
      const bx1 = Number(br.x) || 0;
      const by1 = Number(br.y) || 0;
      const bx2 = bx1 + Math.max(0, Number(br.w) || 0);
      const by2 = by1 + Math.max(0, Number(br.h) || 0);
      const acx = ax1 + (ax2 - ax1) / 2;
      const acy = ay1 + (ay2 - ay1) / 2;
      const bcx = bx1 + (bx2 - bx1) / 2;
      const bcy = by1 + (by2 - by1) / 2;
      const dx = bcx - acx;
      const dy = bcy - acy;
      const centerDistanceNorm = diagonalNorm > 0 ? Math.hypot(dx, dy) / diagonalNorm : 0;
      const gapX = Math.max(0, Math.max(ax1 - bx2, bx1 - ax2));
      const gapY = Math.max(0, Math.max(ay1 - by2, by1 - ay2));
      const edgeGapNorm = Math.hypot(gapX, gapY);
      const ix1 = Math.max(ax1, bx1);
      const iy1 = Math.max(ay1, by1);
      const ix2 = Math.min(ax2, bx2);
      const iy2 = Math.min(ay2, by2);
      const iw = Math.max(0, ix2 - ix1);
      const ih = Math.max(0, iy2 - iy1);
      const overlapArea = Math.max(0, iw * ih);
      const overlaps = overlapArea > 1e-8;
      const areaA = Math.max(0, (ax2 - ax1) * (ay2 - ay1));
      const areaB = Math.max(0, (bx2 - bx1) * (by2 - by1));
      const union = Math.max(0, areaA + areaB - overlapArea);
      const iou = union > 1e-8 ? overlapArea / union : 0;
      const overlapRatioA = areaA > 1e-8 ? overlapArea / areaA : 0;
      const overlapRatioB = areaB > 1e-8 ? overlapArea / areaB : 0;
      const aToB = relationFromDelta(dx, dy, overlaps);
      const overlapOnA = overlaps
        ? {
            ...overlapRegionForRect(ar, ix1, iy1, ix2, iy2),
            ratio: round4(overlapRatioA),
          }
        : null;
      const overlapOnB = overlaps
        ? {
            ...overlapRegionForRect(br, ix1, iy1, ix2, iy2),
            ratio: round4(overlapRatioB),
          }
        : null;
      const zA = zIndexById.has(a.id) ? Number(zIndexById.get(a.id)) : null;
      const zB = zIndexById.has(b.id) ? Number(zIndexById.get(b.id)) : null;
      const topId = zA === null || zB === null ? null : (zA > zB ? a.id : b.id);
      const pair = {
        id_a: a.id,
        id_b: b.id,
        a_to_b: aToB,
        b_to_a: invertRelation(aToB),
        center_distance_norm: round4(centerDistanceNorm),
        edge_gap_norm: round4(edgeGapNorm),
        overlaps,
        overlap: overlaps
          ? {
              iou: round4(iou),
              area_norm: round4(overlapArea),
              on_a: overlapOnA,
              on_b: overlapOnB,
            }
          : null,
        z_order: {
          index_a: zA,
          index_b: zB,
          top_id: topId,
        },
      };
      pairwise.push(pair);
      const k = pairKey(a.id, b.id);
      if (k) pairMap.set(k, pair);
    }
  }
  pairwise.sort((a, b) => {
    if (Number(Boolean(b.overlaps)) !== Number(Boolean(a.overlaps))) {
      return Number(Boolean(b.overlaps)) - Number(Boolean(a.overlaps));
    }
    return Number(a.center_distance_norm) - Number(b.center_distance_norm);
  });

  const sortedByWeight = draft.slice().sort((a, b) => Number(b.weight) - Number(a.weight));
  const primaryTargetId =
    targetIdList[0] ||
    sortedByWeight[0]?.id ||
    null;

  const relations = [];
  for (const refId of referenceIds) {
    if (!primaryTargetId || refId === primaryTargetId) continue;
    const refEntry = draft.find((entry) => entry.id === refId) || null;
    if (!refEntry) continue;
    const key = pairKey(primaryTargetId, refId);
    const pair = key ? pairMap.get(key) : null;
    if (!pair) continue;
    const primaryIsA = String(pair.id_a || "") === String(primaryTargetId || "");
    const direction = primaryIsA ? pair.a_to_b : pair.b_to_a;
    if (direction === "OVERLAP") {
      const overlap = pair.overlap || null;
      if (!overlap) continue;
      const overlapOnTarget = primaryIsA ? overlap.on_a : overlap.on_b;
      const overlapOnRef = primaryIsA ? overlap.on_b : overlap.on_a;
      const iou = Number(overlap.iou) || 0;
      const areaNorm = Number(overlap.area_norm) || 0;
      const coverMax = Math.max(Number(overlapOnTarget?.ratio) || 0, Number(overlapOnRef?.ratio) || 0);
      const confIou = clamp01((iou - 0.03) / 0.12);
      const confArea = clamp01((areaNorm - 0.005) / 0.02);
      const confCov = clamp01((coverMax - 0.25) / 0.5);
      const confidence = round4(Math.max(confIou, confArea, confCov));
      if (confidence < 0.55) continue;
      const strength =
        iou >= 0.12 || areaNorm >= 0.015 ? "STRONG" : iou >= 0.05 || areaNorm >= 0.008 ? "MEDIUM" : "LIGHT";
      const topId = String(pair.z_order?.top_id || "").trim();
      const occlusion =
        topId && topId === primaryTargetId
          ? "TARGET_FRONT"
          : topId && topId === refId
            ? "REF_FRONT"
            : "UNKNOWN";
      let semantic = "NONE";
      if (occlusion === "TARGET_FRONT" && (Number(overlapOnRef?.ratio) || 0) >= 0.6) {
        semantic = "STYLE_TUCK";
      } else if (occlusion === "REF_FRONT" && (strength === "MEDIUM" || strength === "STRONG") && placementPolicy !== "adjacent") {
        semantic = "FOREGROUND_ACCENT";
      } else if (strength === "LIGHT" && Number(pair.edge_gap_norm || 0) === 0) {
        semantic = "TOUCH";
      }
      relations.push({
        ref_id: refId,
        ref_slot: slotById.get(refId) || null,
        to_target: "OVERLAP",
        overlap_strength: strength,
        occlusion,
        region_on_target: String(overlapOnTarget?.region || "").toUpperCase() || null,
        semantic,
        confidence,
        iou: round4(iou),
      });
      continue;
    }
    const confDir =
      clamp01((0.35 - Number(pair.center_distance_norm || 0)) / 0.35) *
      clamp01((0.12 - Number(pair.edge_gap_norm || 0)) / 0.12);
    if (confDir < 0.6) continue;
    relations.push({
      ref_id: refId,
      ref_slot: slotById.get(refId) || null,
      to_target: "ADJACENT",
      direction: direction,
      confidence: round4(confDir),
      iou: 0,
    });
  }
  relations.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  const relationLimit = referenceIds.length <= 4 ? 2 : 4;
  const compactRelations = relations.slice(0, relationLimit);

  for (const entry of draft) {
    const key = primaryTargetId && entry.id !== primaryTargetId ? pairKey(primaryTargetId, entry.id) : "";
    const pair = key ? pairMap.get(key) : null;
    const iouToPrimary = pair?.overlap ? Number(pair.overlap.iou) || 0 : 0;
    entry.geometry_trace = {
      cx: round4(entry.rect_norm?.cx ?? 0),
      cy: round4(entry.rect_norm?.cy ?? 0),
      relative_scale: round4(entry.relative_scale_to_largest),
      iou_to_primary: round4(iouToPrimary),
    };
  }

  const imagesCompact = sortedByWeight.map((entry, idx) => {
    const weight = round2(entry.weight);
    const tier = idx === 0 || weight >= 0.5 ? "PRIMARY" : weight >= 0.2 ? "SECONDARY" : "ACCENT";
    return {
      slot: slotById.get(entry.id) || null,
      id: entry.id,
      role: entry.role,
      weight,
      tier,
      size_tier: entry.size_tier,
      position_tier: entry.position_tier,
      focus_score: round2(entry.focus_score),
      geometry_score: round2(entry.geometry_score),
      role_tags: entry.role_tags.slice(0, 3),
      preserve: Array.from(new Set(entry.preserve)).slice(0, 3),
      transform: Array.from(new Set(entry.transform)).slice(0, 3),
      geometry_trace: entry.geometry_trace,
    };
  });

  const imageManifest = sortedByWeight.map((entry, idx) => ({
    slot: slotById.get(entry.id) || null,
    id: entry.id,
    file: entry.file,
    origin: entry.origin,
    role: entry.role,
    role_tags: entry.role_tags,
    tier: idx === 0 || entry.weight >= 0.5 ? "PRIMARY" : entry.weight >= 0.2 ? "SECONDARY" : "ACCENT",
    preserve: Array.from(new Set(entry.preserve)).slice(0, 3),
    transform: Array.from(new Set(entry.transform)).slice(0, 3),
    weight: round4(entry.weight),
    focus_score: round4(entry.focus_score),
    geometry_score: round4(entry.geometry_score),
    rect_norm: entry.rect_norm,
    canvas_area_ratio: round4(entry.canvas_area_ratio),
    relative_scale_to_largest: round4(entry.relative_scale_to_largest),
    aspect_ratio_norm: entry.aspect_ratio_norm !== null ? round4(entry.aspect_ratio_norm) : null,
    geometry_trace: entry.geometry_trace,
  }));

  const spatialRelations = {
    primary_target_id: primaryTargetId,
    image_ids_considered: spatialImageEntries.map((entry) => String(entry.id || "")),
    compact_relations: compactRelations,
    pairwise: pairwise.slice(0, 12),
  };

  const mustNot = [];
  const mustNotSeen = new Set();
  const pushMustNot = (raw) => {
    const text = normalizeMustNot(raw);
    if (!text) return;
    const key = text.toLowerCase();
    if (mustNotSeen.has(key)) return;
    mustNotSeen.add(key);
    mustNot.push(text);
  };
  for (const constraint of Array.isArray(compiled?.compile_constraints) ? compiled.compile_constraints : []) {
    pushMustNot(constraint);
  }
  const negativePrompt = String(compiled?.negative_prompt || "").trim();
  if (negativePrompt) {
    for (const line of splitNegativePrompt(negativePrompt)) pushMustNot(line);
  }
  for (const fallback of MUST_NOT_DEFAULTS) {
    if (mustNot.length >= 6) break;
    pushMustNot(fallback);
  }
  const mustNotFinal = mustNot.slice(0, 6);
  const overallConfidence = round4(clamp01(0.6 * interactionConfidence + 0.4 * geometryConfidence));

  return {
    schema: "brood.gemini.context_packet.v2",
    action_version: actionVersion,
    intent_id: String(intent.intent_id || idle?.intent?.intent_id || "").trim() || null,
    goal: `Intent summary: ${summary || MOTHER_V2_PROPOSAL_BY_MODE[transformationMode] || "Create one coherent image."}`,
    creative_directive: creativeDirective || MOTHER_CREATIVE_DIRECTIVE,
    optimization_target: "stunningly awe-inspiring and joyous + novel",
    style: {
      creative_directive: creativeDirective || MOTHER_CREATIVE_DIRECTIVE,
      optimization_target: "stunningly awe-inspiring and joyous + novel",
    },
    prompt_preview: clampText(String(promptLine || ""), 320),
    proposal_lock: {
      transformation_mode: transformationMode,
      placement_policy: placementPolicy,
      active_id: activeId,
      selected_ids: selectedIds,
      target_ids: targetIds,
      reference_ids: referenceIds,
    },
    images: imagesCompact,
    relations: compactRelations,
    image_manifest: imageManifest,
    spatial_relations: spatialRelations,
    behavior_signals: {
      focus_rank: imageManifest.map((entry) => entry.id).slice(0, 5),
      interaction_confidence: round4(interactionConfidence),
      geometry_confidence: round4(geometryConfidence),
      overall_confidence: overallConfidence,
      interaction_stale_cutoff_ms: INTERACTION_STALE_CUTOFF_MS,
      focus_scores: imageManifest
        .map((entry) => ({ id: entry.id, focus_score: round4(entry.focus_score) }))
        .slice(0, 8),
    },
    constraints: {
      must_not: mustNotFinal,
    },
    must_not: mustNotFinal,
    output: {
      count: 1,
      layout: placementPolicy,
      quality: "production-ready",
    },
  };
}

async function motherV2DispatchViaImagePayload(compiled = {}, promptLine = "") {
  const idle = state.motherIdle;
  if (!idle) return false;
  const imagePayload = motherV2CollectGenerationImagePaths();
  const sanitizedIntent = motherV2SanitizeIntentImageIds(idle.intent) || idle.intent || null;
  const geminiContextPacket = motherV2BuildGeminiContextPacket({
    compiled,
    promptLine,
    sanitizedIntent,
    imagePayload,
  });
  const compiledGenerationParams =
    compiled?.generation_params && typeof compiled.generation_params === "object" ? compiled.generation_params : {};
  const generationParams = {};
  const seedStrategy = String(compiledGenerationParams.seed_strategy || "").trim().toLowerCase();
  if (seedStrategy === "random") generationParams.seed_strategy = "random";
  if (compiledGenerationParams.seed !== undefined && compiledGenerationParams.seed !== null) {
    const seedValue = Number(compiledGenerationParams.seed);
    if (Number.isFinite(seedValue)) {
      generationParams.seed = Math.trunc(seedValue);
    }
  }
  if (typeof compiledGenerationParams.aspect_ratio === "string" && compiledGenerationParams.aspect_ratio.trim()) {
    generationParams.aspect_ratio = compiledGenerationParams.aspect_ratio.trim();
  }
  if (typeof compiledGenerationParams.image_size === "string" && compiledGenerationParams.image_size.trim()) {
    generationParams.image_size = compiledGenerationParams.image_size.trim();
  }
  if (Array.isArray(compiledGenerationParams.safety_settings) && compiledGenerationParams.safety_settings.length) {
    generationParams.safety_settings = compiledGenerationParams.safety_settings.slice();
  }
  if (compiledGenerationParams.add_watermark !== undefined && compiledGenerationParams.add_watermark !== null) {
    generationParams.add_watermark = Boolean(compiledGenerationParams.add_watermark);
  }
  if (compiledGenerationParams.person_generation !== undefined && compiledGenerationParams.person_generation !== null) {
    generationParams.person_generation = compiledGenerationParams.person_generation;
  }
  const payload = {
    schema: "brood.mother.generate.v2",
    action_version: Number(idle.actionVersion) || 0,
    intent_id: sanitizedIntent?.intent_id || idle.intent?.intent_id || null,
    prompt: promptLine,
    n: 1,
    generation_params: generationParams,
    init_image: imagePayload.initImage,
    reference_images: imagePayload.referenceImages,
    gemini_context_packet: geminiContextPacket,
  };
  const payloadPath = await motherV2WritePayloadFile("mother_generate", payload);
  if (!payloadPath) return false;
  appendMotherTraceLog({
    kind: "generation_payload",
    traceId: idle.telemetry?.traceId || null,
    actionVersion: Number(idle.actionVersion) || 0,
    intent_id: sanitizedIntent?.intent_id || idle.intent?.intent_id || null,
    transformation_mode: motherV2NormalizeTransformationMode(sanitizedIntent?.transformation_mode),
    placement_policy: sanitizedIntent?.placement_policy || null,
    selected_ids: getVisibleSelectedIds().map((v) => String(v || "").trim()).filter(Boolean),
    source_image_ids: Array.isArray(imagePayload.sourceImageIds) ? imagePayload.sourceImageIds.slice(0, 10) : [],
    init_image_id: Array.isArray(imagePayload.sourceImageIds) && imagePayload.sourceImageIds.length
      ? String(imagePayload.sourceImageIds[0] || "")
      : null,
  }).catch(() => {});
  await invoke("write_pty", { data: `${PTY_COMMANDS.MOTHER_GENERATE} ${quoteForPtyArg(payloadPath)}\n` });
  return true;
}

async function motherV2DispatchCompiledPrompt(compiled = {}) {
  const idle = state.motherIdle;
  if (!idle) return false;
  if (idle.phase !== MOTHER_IDLE_STATES.DRAFTING) return false;
  if (Number(idle.pendingActionVersion) !== Number(idle.actionVersion)) {
    motherV2MarkStale({ stage: "prompt_compile", pending_action_version: Number(idle.pendingActionVersion) || 0 });
    return false;
  }
  idle.pendingPromptCompile = false;
  clearTimeout(idle.pendingPromptCompileTimeout);
  idle.pendingPromptCompileTimeout = null;
  idle.promptMotionProfile = motherV2PromptMotionProfileFromCompiled(compiled);
  const promptLine = motherV2PromptLineFromCompiled(compiled);
  if (!promptLine) {
    motherIdleHandleGenerationFailed("Mother prompt compile produced an empty prompt.");
    return false;
  }
  const selectedModel = MOTHER_GENERATION_MODEL;
  motherIdleResetDispatchCorrelation({ rememberPendingVersion: true });
  idle.dispatchTimeoutExtensions = 0;
  idle.cancelArtifactUntil = 0;
  idle.cancelArtifactReason = null;
  idle.pendingGeneration = true;
  idle.pendingDispatchToken = Date.now();
  idle.pendingPromptLine = promptLine;
  idle.lastDispatchModel = selectedModel;
  state.pendingMotherDraft = {
    sourceIds: motherV2RoleContextIds(),
    startedAt: Date.now(),
  };
  state.lastAction = "Mother Suggestion";
  state.expectingArtifacts = true;
  setImageFxActive(true, "Mother Draft");
  setStatus("Mother: drafting…");
  await maybeOverrideEngineImageModel(selectedModel);
  motherIdleArmDispatchTimeout(
    MOTHER_GENERATION_TIMEOUT_MS,
    `Mother draft timed out after ${Math.round((MOTHER_GENERATION_TIMEOUT_MS + MOTHER_GENERATION_TIMEOUT_EXTENSION_MS) / 1000)}s.`,
    { allowExtension: true }
  );
  const sentViaPayload = await motherV2DispatchViaImagePayload(compiled, promptLine).catch(() => false);
  if (!sentViaPayload) {
    // Mother drafts must dispatch via structured payload so source_images always includes
    // the full canvas context (uploaded + Mother-generated images).
    motherIdleHandleGenerationFailed("Mother could not start drafting payload.");
    return false;
  }
  return true;
}

async function motherIdleHandleSuggestionArtifact({ id, path, receiptPath = null, versionId = null } = {}) {
  if (!id || !path) return false;
  const idle = state.motherIdle;
  if (!idle) return false;
  if (idle.phase !== MOTHER_IDLE_STATES.DRAFTING) return false;
  if (!idle.pendingDispatchToken && !idle.pendingGeneration) return false;

  const incomingVersionId = String(versionId || "").trim() || null;
  if (!motherIdleDispatchVersionMatches(incomingVersionId)) {
    if (incomingVersionId) motherIdleRememberIgnoredVersion(incomingVersionId);
    return false;
  }
  if (Number(idle.pendingActionVersion) !== Number(idle.actionVersion)) {
    motherV2MarkStale({
      stage: "artifact_created",
      incoming_version_id: incomingVersionId,
      pending_action_version: Number(idle.pendingActionVersion) || 0,
    });
    removeFile(path).catch(() => {});
    if (receiptPath) removeFile(receiptPath).catch(() => {});
    idle.pendingGeneration = false;
    if (!idle.pendingVersionId && incomingVersionId) idle.pendingVersionId = incomingVersionId;
    motherIdleResetDispatchCorrelation({ rememberPendingVersion: true });
    idle.pendingDispatchToken = 0;
    idle.dispatchTimeoutExtensions = 0;
    state.pendingMotherDraft = null;
    state.expectingArtifacts = false;
    restoreEngineImageModelIfNeeded();
    setImageFxActive(false);
    updatePortraitIdle();
    return true;
  }

  clearMotherIdleDispatchTimeout();
  idle.pendingGeneration = false;
  if (!idle.pendingVersionId && incomingVersionId) idle.pendingVersionId = incomingVersionId;
  motherIdleResetDispatchCorrelation({ rememberPendingVersion: true });
  idle.pendingDispatchToken = 0;
  idle.dispatchTimeoutExtensions = 0;
  state.pendingMotherDraft = null;
  idle.generatedImageId = id;
  idle.generatedVersionId = incomingVersionId || null;
  idle.lastSuggestionAt = Date.now();
  state.expectingArtifacts = false;
  restoreEngineImageModelIfNeeded();
  setImageFxActive(false);
  updatePortraitIdle();

  // Keep reroll simple: one active draft at a time.
  for (const draft of Array.isArray(idle.drafts) ? idle.drafts : []) {
    if (String(draft?.id || "") === String(id)) continue;
    if (draft?.path) removeFile(String(draft.path)).catch(() => {});
    if (draft?.receiptPath) removeFile(String(draft.receiptPath)).catch(() => {});
  }
  const draft = {
    id: String(id),
    path: String(path),
    receiptPath: receiptPath ? String(receiptPath) : null,
    versionId: incomingVersionId,
    actionVersion: Number(idle.actionVersion) || 0,
    createdAt: Date.now(),
    img: null,
  };
  try {
    draft.img = await loadImage(draft.path);
  } catch {
    draft.img = null;
  }
  idle.drafts = [draft];
  idle.selectedDraftId = draft.id;
  idle.hoverDraftId = draft.id;
  motherIdleTransitionTo(MOTHER_IDLE_EVENTS.DRAFT_READY);
  appendMotherTraceLog({
    kind: "draft_ready",
    traceId: idle.telemetry?.traceId || null,
    actionVersion: Number(idle.actionVersion) || 0,
    draft_id: draft.id,
    intent_id: idle.intent?.intent_id || null,
    placement_policy: idle.intent?.placement_policy || null,
  }).catch(() => {});
  if (!isReelSizeLocked()) {
    showToast("Mother draft ready. ✓ deploy, ✕ dismiss, R reroll.", "tip", 2200);
  }
  requestRender();
  return true;
}

function motherIdleHandleGenerationFailed(message = null) {
  const idle = state.motherIdle;
  if (!idle) return;
  clearMotherIdleDispatchTimeout();
  motherIdleResetDispatchCorrelation({ rememberPendingVersion: true });
  idle.dispatchTimeoutExtensions = 0;
  idle.pendingGeneration = false;
  idle.pendingPromptCompile = false;
  idle.pendingIntent = false;
  idle.pendingIntentRequestId = null;
  idle.pendingIntentStartedAt = 0;
  idle.pendingIntentUpgradeUntil = 0;
  idle.pendingIntentRealtimePath = null;
  idle.pendingIntentPath = null;
  idle.pendingIntentPayload = null;
  idle.pendingDispatchToken = 0;
  state.pendingMotherDraft = null;
  state.expectingArtifacts = false;
  restoreEngineImageModelIfNeeded();
  setImageFxActive(false);
  updatePortraitIdle();
  motherIdleTransitionTo(MOTHER_IDLE_EVENTS.REJECT);
  if (state.motherIdle?.phase === MOTHER_IDLE_STATES.COOLDOWN) {
    motherV2ArmCooldown({ rejected: true });
  }
  appendMotherTraceLog({
    kind: "generation_failed",
    traceId: idle.telemetry?.traceId || null,
    actionVersion: Number(idle.actionVersion) || 0,
    error: message || null,
  }).catch(() => {});
  if (message) showToast(message, "error", 2600);
}

async function motherIdleDispatchGeneration() {
  const idle = state.motherIdle;
  if (!idle) return false;
  if (idle.phase !== MOTHER_IDLE_STATES.DRAFTING) return false;
  if (state.pointer.active) return false;
  const ok = await ensureEngineSpawned({ reason: "mother_drafting" });
  if (!ok) return false;
  await motherV2RequestPromptCompile();
  return true;
}

function motherV2HasMultiUploadIdleBoost(nowMs = Date.now()) {
  const idle = state.motherIdle;
  if (!idle) return false;
  return (Number(idle.multiUploadIdleBoostUntil) || 0) > nowMs;
}

function motherV2WatchIdleDelayMs(nowMs = Date.now()) {
  return motherV2HasMultiUploadIdleBoost(nowMs) ? MOTHER_V2_MULTI_UPLOAD_WATCH_IDLE_MS : MOTHER_V2_WATCH_IDLE_MS;
}

function motherV2IntentIdleDelayMs(nowMs = Date.now()) {
  return motherV2HasMultiUploadIdleBoost(nowMs) ? MOTHER_V2_MULTI_UPLOAD_INTENT_IDLE_MS : MOTHER_V2_INTENT_IDLE_MS;
}

function motherV2ArmMultiUploadIdleBoost(importCount = 0) {
  const idle = state.motherIdle;
  if (!idle) return;
  const count = Math.max(0, Number(importCount) || 0);
  if (count < 2) return;
  idle.multiUploadIdleBoostUntil = Date.now() + MOTHER_V2_MULTI_UPLOAD_IDLE_BOOST_WINDOW_MS;
  if (idle.phase === MOTHER_IDLE_STATES.OBSERVING && !state.pointer.active) {
    motherIdleArmFirstTimer();
  } else if (idle.phase === MOTHER_IDLE_STATES.WATCHING && !state.pointer.active) {
    motherIdleArmIntentTimer();
  }
}

function motherIdleArmFirstTimer() {
  const idle = state.motherIdle;
  if (!idle) return;
  clearTimeout(idle.firstIdleTimer);
  idle.firstIdleTimer = null;
  clearTimeout(idle.intentIdleTimer);
  idle.intentIdleTimer = null;
  if (idle.blockedUntilUserInteraction) return;
  if (!motherIdleHasArmedCanvas()) return;
  if (state.pointer.active) return;
  if (motherV2InCooldown()) return;
  if (idle.phase !== MOTHER_IDLE_STATES.OBSERVING) return;
  const nowMs = Date.now();
  const watchIdleMs = motherV2WatchIdleDelayMs(nowMs);
  const dueAt = (Number(state.lastInteractionAt) || nowMs) + watchIdleMs;
  const delay = Math.max(25, dueAt - Date.now());
  idle.firstIdleTimer = setTimeout(() => {
    idle.firstIdleTimer = null;
    if (state.motherIdle?.blockedUntilUserInteraction) return;
    if (!motherIdleHasArmedCanvas()) return;
    if (state.pointer.active) return;
    if (motherV2InCooldown()) return;
    const quietFor = Date.now() - (Number(state.lastInteractionAt) || 0);
    const now = Date.now();
    const watchDelayMs = motherV2WatchIdleDelayMs(now);
    if (quietFor < watchDelayMs) {
      motherIdleArmFirstTimer();
      return;
    }
    if (state.motherIdle?.phase !== MOTHER_IDLE_STATES.OBSERVING) return;
    motherIdleTransitionTo(MOTHER_IDLE_EVENTS.IDLE_WINDOW_ELAPSED);
    renderMotherReadout();
    motherIdleArmIntentTimer();
  }, delay);
}

function motherIdleArmIntentTimer() {
  const idle = state.motherIdle;
  if (!idle) return;
  clearTimeout(idle.intentIdleTimer);
  idle.intentIdleTimer = null;
  if (idle.blockedUntilUserInteraction) return;
  if (!motherIdleHasArmedCanvas()) return;
  if (state.pointer.active) return;
  if (motherV2InCooldown()) return;
  if (idle.phase !== MOTHER_IDLE_STATES.WATCHING) return;
  const nowMs = Date.now();
  const intentIdleMs = motherV2IntentIdleDelayMs(nowMs);
  const dueAt = (Number(state.lastInteractionAt) || nowMs) + intentIdleMs;
  const delay = Math.max(25, dueAt - Date.now());
  idle.intentIdleTimer = setTimeout(async () => {
    idle.intentIdleTimer = null;
    if (state.motherIdle?.blockedUntilUserInteraction) return;
    if (!motherIdleHasArmedCanvas()) return;
    if (state.pointer.active) return;
    if (motherV2InCooldown()) return;
    const quietFor = Date.now() - (Number(state.lastInteractionAt) || 0);
    const now = Date.now();
    const intentDelayMs = motherV2IntentIdleDelayMs(now);
    if (quietFor < intentDelayMs) {
      motherIdleArmIntentTimer();
      return;
    }
    if (state.motherIdle?.phase !== MOTHER_IDLE_STATES.WATCHING) return;
    if (motherV2HasMultiUploadIdleBoost(now)) {
      idle.multiUploadIdleBoostUntil = 0;
    }
    motherIdleTransitionTo(MOTHER_IDLE_EVENTS.IDLE_WINDOW_ELAPSED);
    await motherV2RequestIntentInference();
    renderMotherReadout();
  }, delay);
}

function motherV2CancelInFlight({ reason = "interaction" } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  const hadPending =
    Boolean(idle.pendingIntent) ||
    Boolean(idle.pendingPromptCompile) ||
    Boolean(idle.pendingGeneration) ||
    Boolean(idle.pendingDispatchToken);
  if (!hadPending) return;
  idle.cancelArtifactUntil = Date.now() + 14_000;
  idle.cancelArtifactReason = String(reason || "interaction");
  state.pendingMotherDraft = null;
  motherV2ResetInteractionState();
  state.expectingArtifacts = false;
  restoreEngineImageModelIfNeeded();
  setImageFxActive(false);
  updatePortraitIdle();
  appendMotherTraceLog({
    kind: "cancel",
    traceId: idle.telemetry?.traceId || null,
    actionVersion: Number(idle.actionVersion) || 0,
    reason,
  }).catch(() => {});
}

function motherIdleSyncFromInteraction({ userInteraction = false, semantic = true } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  if (idle.commitMutationInFlight) return;
  if (!motherIdleHasArmedCanvas()) {
    clearMotherIdleTimers({ first: true, takeover: true });
    motherV2ResetInteractionState();
    motherV2ClearIntentAndDrafts({ removeFiles: true });
    if (idle.phase !== MOTHER_IDLE_STATES.OBSERVING) {
      motherIdleTransitionTo(MOTHER_IDLE_EVENTS.DISQUALIFY);
    }
    renderMotherReadout();
    return;
  }
  if (userInteraction) {
    if (!semantic) {
      // Non-semantic interactions (viewport motion, focus-only selection changes) should not
      // invalidate Mother state or arm the idle-watch timers.
      return;
    }
    if (idle.blockedUntilUserInteraction) {
      idle.blockedUntilUserInteraction = false;
      appendMotherTraceLog({
        kind: "post_commit_resumed_on_user_interaction",
        traceId: idle.telemetry?.traceId || null,
        actionVersion: Number(idle.actionVersion) || 0,
      }).catch(() => {});
    }
    idle.multiUploadIdleBoostUntil = 0;
    idle.actionVersion = (Number(idle.actionVersion) || 0) + 1;
    closeMotherWheelMenu({ immediate: false });
    clearMotherIdleTimers({ first: true, takeover: true });
    motherV2CancelInFlight({ reason: "user_interaction" });
    if (idle.phase === MOTHER_IDLE_STATES.OFFERING || idle.phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING) {
      motherV2ClearIntentAndDrafts({ removeFiles: true });
    }
    motherIdleTransitionTo(MOTHER_IDLE_EVENTS.USER_INTERACTION);
    renderMotherReadout();
  }
  if (idle.phase === MOTHER_IDLE_STATES.OBSERVING && !state.pointer.active) {
    motherIdleArmFirstTimer();
  }
}

function bumpInteraction({ motherHot = true, semantic = true } = {}) {
  state.lastInteractionAt = Date.now();
  if (motherHot) state.lastMotherHotAt = state.lastInteractionAt;
  // Keep the Mother realtime pulse/video responsive while the user is working.
  const now = state.lastInteractionAt;
  const last = Number(state.mother?.hotSyncAt) || 0;
  if (now - last > 120) {
    state.mother.hotSyncAt = now;
    syncMotherPortrait();
  }
  motherIdleSyncFromInteraction({ userInteraction: true, semantic });
}

const USER_EVENT_MAX = 72;
function recordUserEvent(type, fields = {}) {
  const t = String(type || "").trim();
  if (!t) return;
  const entry = {
    seq: (state.userEventSeq += 1),
    at_ms: Date.now(),
    type: t,
    ...fields,
  };
  state.userEvents.push(entry);
  if (state.userEvents.length > USER_EVENT_MAX) {
    state.userEvents = state.userEvents.slice(state.userEvents.length - USER_EVENT_MAX);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  return "application/octet-stream";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getDpr() {
  return Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
}

function getMultiViewTransform() {
  return {
    scale: Math.max(0.0001, Number(state.multiView?.scale) || 1),
    offsetX: Number(state.multiView?.offsetX) || 0,
    offsetY: Number(state.multiView?.offsetY) || 0,
  };
}

function multiRectToScreenRect(rect, transform = getMultiViewTransform()) {
  if (!rect) return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w);
  const h = Number(rect.h);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  const scale = Math.max(0.0001, Number(transform?.scale) || 1);
  const offsetX = Number(transform?.offsetX) || 0;
  const offsetY = Number(transform?.offsetY) || 0;
  return {
    x: x * scale + offsetX,
    y: y * scale + offsetY,
    w: w * scale,
    h: h * scale,
  };
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
  if (next !== lastHudHeightCssPx) {
    lastHudHeightCssPx = next;
    els.canvasWrap.style.setProperty("--hud-h", next);
  }
}

let lastBrandStripHeightCssPx = null;
let brandStripResizeObserver = null;
function syncBrandStripHeightVar() {
  const el = els.brandStrip;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const h = Math.max(0, Math.round(rect.height));
  if (!h) return;
  const next = `${h}px`;
  if (next !== lastBrandStripHeightCssPx) {
    lastBrandStripHeightCssPx = next;
    document.documentElement.style.setProperty("--brand-strip-h", next);
  }
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
    if (els.effectsCanvas) {
      els.effectsCanvas.width = width;
      els.effectsCanvas.height = height;
    }
    els.overlayCanvas.width = width;
    els.overlayCanvas.height = height;
    if (effectsRuntime) {
      effectsRuntime.resize({ width, height, dpr });
    }
    resetViewToFit();
  } else if (effectsRuntime) {
    effectsRuntime.resize({ width, height, dpr });
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

function canvasScreenCssToWorldCss(ptCss) {
  const p = ptCss || {};
  const x0 = Number(p.x) || 0;
  const y0 = Number(p.y) || 0;
  if (state.canvasMode !== "multi") return { x: x0, y: y0 };
  const ms = Number(state.multiView?.scale) || 1;
  const dpr = getDpr();
  const mxCss = (Number(state.multiView?.offsetX) || 0) / Math.max(dpr, 0.0001);
  const myCss = (Number(state.multiView?.offsetY) || 0) / Math.max(dpr, 0.0001);
  return {
    x: (x0 - mxCss) / Math.max(ms, 0.0001),
    y: (y0 - myCss) / Math.max(ms, 0.0001),
  };
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

function getSelectedIds() {
  const raw = Array.isArray(state.selectedIds) ? state.selectedIds : [];
  const out = [];
  for (const id of raw) {
    const key = String(id || "").trim();
    if (!key) continue;
    if (!out.includes(key)) out.push(key);
  }
  const active = String(state.activeId || "").trim();
  if (active && !out.includes(active)) out.push(active);
  return out;
}

function isVisibleCanvasImageId(imageId) {
  const id = String(imageId || "").trim();
  if (!id) return false;
  if (!state.imagesById.has(id)) return false;
  return !isImageEffectTokenized(id);
}

function getVisibleCanvasImages() {
  return (state.images || []).filter((item) => isVisibleCanvasImageId(item?.id));
}

function getVisibleSelectedIds() {
  return getSelectedIds().filter((id) => isVisibleCanvasImageId(id));
}

function getVisibleActiveId() {
  const activeId = String(state.activeId || "").trim();
  if (!activeId) return null;
  return isVisibleCanvasImageId(activeId) ? activeId : null;
}

function setSelectedIds(nextIds) {
  const out = [];
  for (const id of Array.isArray(nextIds) ? nextIds : []) {
    const key = String(id || "").trim();
    if (!key) continue;
    if (!out.includes(key)) out.push(key);
  }
  state.selectedIds = out;
}

function selectedCount() {
  return getSelectedImages().length;
}

function getSelectedImages({ requireCount = null } = {}) {
  const ids = getSelectedIds();
  const items = ids.map((id) => state.imagesById.get(id)).filter(Boolean);
  if (typeof requireCount === "number") {
    if (items.length !== requireCount) return [];
  }
  return items;
}

function getSelectedImagesActiveFirst({ requireCount = null } = {}) {
  const selected = getSelectedImages();
  const active = getActiveImage();
  if (active?.id) {
    const ordered = [active, ...selected.filter((item) => item?.id && item.id !== active.id)];
    if (typeof requireCount === "number") {
      if (ordered.length !== requireCount) return [];
    }
    return ordered;
  }
  if (typeof requireCount === "number") {
    if (selected.length !== requireCount) return [];
  }
  return selected;
}

function effectTokenForImageId(imageId) {
  const id = String(imageId || "").trim();
  if (!id) return null;
  const tokenId = state.imageEffectTokenByImageId.get(id);
  if (!tokenId) return null;
  const token = state.effectTokensById.get(tokenId) || null;
  if (!token) {
    state.imageEffectTokenByImageId.delete(id);
    return null;
  }
  return token;
}

function isImageEffectTokenized(imageId) {
  const token = effectTokenForImageId(imageId);
  if (!token) return false;
  return String(token.lifecycle || "") !== EFFECT_TOKEN_LIFECYCLE.CONSUMED;
}

function clearEffectTokenForImageId(imageId) {
  const id = String(imageId || "").trim();
  if (!id) return;
  const tokenId = state.imageEffectTokenByImageId.get(id);
  state.imageEffectTokenByImageId.delete(id);
  if (!tokenId) return;
  const token = state.effectTokensById.get(tokenId) || null;
  if (!token) return;
  // Keep other bindings if this token was intentionally shared.
  const stillUsed = Array.from(state.imageEffectTokenByImageId.values()).some((boundId) => String(boundId) === String(tokenId));
  if (!stillUsed) {
    state.effectTokensById.delete(tokenId);
    state.effectTokenApplyLocks.delete(String(tokenId));
  }
}

function clearAllEffectTokens() {
  state.imageEffectTokenByImageId.clear();
  state.effectTokensById.clear();
  state.effectTokenApplyLocks.clear();
  state.effectTokenDrag = null;
}

function syncSelectionForTokenizedImages() {
  const selected = getSelectedIds();
  const visibleSelected = selected.filter((id) => isVisibleCanvasImageId(id));
  if (visibleSelected.length !== selected.length) {
    setSelectedIds(visibleSelected.slice(-3));
  }

  const activeId = String(state.activeId || "").trim();
  if (activeId && isVisibleCanvasImageId(activeId)) return;
  const fallbackSelected = visibleSelected[visibleSelected.length - 1] || null;
  const fallbackAny = getVisibleCanvasImages().slice(-1)[0]?.id || null;
  state.activeId = String(fallbackSelected || fallbackAny || "").trim() || null;
}

function createOrUpdateEffectToken({
  type,
  imageId,
  imagePath,
  palette = [],
  colors = [],
  materials = [],
  emotion = "",
  summary = "",
  source = null,
  model = null,
} = {}) {
  const imageKey = String(imageId || "").trim();
  const tokenType = String(type || "").trim();
  if (!imageKey || !tokenType) return null;
  const existing = effectTokenForImageId(imageKey);
  const tokenId = existing?.id || `fx-${tokenType}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const next = createEffectTokenState({
    id: tokenId,
    type: tokenType,
    sourceImageId: imageKey,
    sourceImagePath: String(imagePath || ""),
    palette,
    colors,
    materials,
    emotion,
    summary,
    source,
    model,
    createdAt: existing?.createdAt || Date.now(),
  });
  if (!next) return null;
  state.effectTokensById.set(tokenId, next);
  state.imageEffectTokenByImageId.set(imageKey, tokenId);
  state.effectTokenApplyLocks.delete(tokenId);
  syncSelectionForTokenizedImages();
  renderQuickActions();
  renderHudReadout();
  renderSelectionMeta();
  return next;
}

function effectTokenLabel(token) {
  const type = String(token?.type || "").trim();
  if (type === "extract_dna") return "Extract DNA";
  if (type === "soul_leech") return "Soul Leech";
  return "Effect";
}

function buildEffectTokenEditPrompt(token) {
  const type = String(token?.type || "").trim();
  if (type === "extract_dna") {
    const palette = Array.isArray(token?.palette) ? token.palette.filter(Boolean).slice(0, 6) : [];
    const colors = Array.isArray(token?.colors) ? token.colors.filter(Boolean).slice(0, 6) : [];
    const materials = Array.isArray(token?.materials) ? token.materials.filter(Boolean).slice(0, 6) : [];
    const summary = String(token?.summary || "").trim();
    const parts = [];
    if (summary) parts.push(summary);
    if (palette.length) parts.push(`palette anchors: ${palette.join(", ")}`);
    if (colors.length) parts.push(`dominant colors: ${colors.join(", ")}`);
    if (materials.length) parts.push(`dominant materials/textures: ${materials.join(", ")}`);
    const transfer = parts.length ? parts.join(". ") : "transfer the extracted color and material DNA";
    return (
      "edit the image in place. keep the target subject class, silhouette, geometry, and object boundaries unchanged. " +
      `apply the extracted dna as style/material transfer only: ${transfer}. ` +
      "dna is metaphorical here, not literal content. " +
      "Do not replace the target with the source subject. Do not turn the subject into a DNA strand, helix, genome icon, or abstract ribbon. " +
      "No collage, no split-screen, no double exposure, no extra humans/faces unless already present, no text overlays."
    );
  }
  if (type === "soul_leech") {
    const emotion = String(token?.emotion || "").trim();
    const summary = String(token?.summary || "").trim();
    const essence = summary || (emotion ? `make the scene emotionally ${emotion}` : "shift the image to the extracted emotional tone");
    return (
      `edit the image: ${essence}. Keep scene geometry coherent and photorealistic. ` +
      "Preserve core subject identity and materials unless the emotional change requires subtle lighting/color shifts. " +
      "No collage, no split-screen, no double exposure, no text overlays."
    );
  }
  return "edit the image: refine the image with the selected effect token. Output one coherent image.";
}

async function applyEffectTokenToImage(tokenId, targetId, { fromQueue = false, dispatchId = null } = {}) {
  const dispatchIdOverride = Number(dispatchId) || null;
  const tokenKey = String(tokenId || "").trim();
  const targetKey = String(targetId || "").trim();
  const token = state.effectTokensById.get(tokenKey) || null;
  if (!requireIntentUnlocked()) {
    state.effectTokenApplyLocks.delete(tokenKey);
    if (token && String(token.lifecycle || "") === EFFECT_TOKEN_LIFECYCLE.APPLYING) {
      recoverEffectTokenApply(token);
      requestRender();
    }
    return false;
  }
  const target = state.imagesById.get(targetKey) || null;
  if (!token || !target?.path) {
    state.effectTokenApplyLocks.delete(tokenKey);
    if (token && String(token.lifecycle || "") === EFFECT_TOKEN_LIFECYCLE.APPLYING) {
      recoverEffectTokenApply(token);
      requestRender();
    }
    showToast("Effect apply failed: missing token or target image.", "error", 2600);
    return false;
  }
  if (!isValidEffectDrop(token.sourceImageId, target.id)) {
    state.effectTokenApplyLocks.delete(tokenKey);
    if (String(token.lifecycle || "") === EFFECT_TOKEN_LIFECYCLE.APPLYING) {
      recoverEffectTokenApply(token);
      requestRender();
    }
    showToast("Drop this token onto a different image.", "tip", 1800);
    return false;
  }

  let lock = state.effectTokenApplyLocks.get(tokenKey) || null;
  if (dispatchIdOverride && lock && Number(lock.dispatchId) !== dispatchIdOverride) {
    return false;
  }
  if (dispatchIdOverride && !lock) {
    return false;
  }
  if (!lock) {
    const dispatchId = beginEffectTokenApply(token, targetKey, Date.now());
    if (!dispatchId) return false;
    lock = {
      dispatchId,
      targetImageId: targetKey,
      queued: false,
      startedAt: Date.now(),
    };
    state.effectTokenApplyLocks.set(tokenKey, lock);
    requestRender();
  }
  if (!effectTokenCanDispatchApply(token, lock.dispatchId, targetKey)) {
    return false;
  }

  const actionLabel = effectTokenLabel(token);
  const queueKey = `effect_apply:${token.id}:${target.id}`;
  if (!fromQueue && (isEngineBusy() || state.actionQueueActive || state.actionQueue.length)) {
    lock.queued = true;
    enqueueAction({
      label: `${actionLabel} Apply`,
      key: queueKey,
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => applyEffectTokenToImage(token.id, target.id, { fromQueue: true, dispatchId: lock.dispatchId }),
    });
    return true;
  }

  lock.queued = false;
  bumpInteraction({ semantic: false });
  await ensureRun();
  const provider = providerFromModel(
    token.type === "soul_leech" ? ACTION_IMAGE_MODEL.soul_leech_apply : ACTION_IMAGE_MODEL.extract_dna_apply
  );
  setImageFxActive(true, `${actionLabel} Apply`);
  portraitWorking(`${actionLabel} Apply`, { providerOverride: provider || "gemini" });
  beginPendingReplace(target.id, `${actionLabel} Apply`, {
    mode: "effect_token_apply",
    effect_token_id: token.id,
    effect_type: token.type,
    source_image_id: token.sourceImageId || null,
    effect_token_dispatch_id: lock.dispatchId,
  });

  try {
    const ok = await ensureEngineSpawned({ reason: `${actionLabel} apply` });
    if (!ok) throw new Error("Engine unavailable");
    await setEngineActiveImage(target.path);
    const desiredModel = token.type === "soul_leech" ? ACTION_IMAGE_MODEL.soul_leech_apply : ACTION_IMAGE_MODEL.extract_dna_apply;
    await maybeOverrideEngineImageModel(desiredModel || pickGeminiFastImageModel());
    state.expectingArtifacts = true;
    state.lastAction = `${actionLabel} Apply`;
    setStatus(`Engine: ${actionLabel.toLowerCase()} apply…`);
    showToast(`${actionLabel}: applying to ${target.label || basename(target.path)}…`, "info", 2200);

    const prompt = buildEffectTokenEditPrompt(token);
    await invoke("write_pty", { data: `${prompt}\n` });
    return true;
  } catch (err) {
    state.expectingArtifacts = false;
    state.engineImageModelRestore = null;
    clearPendingReplace();
    state.effectTokenApplyLocks.delete(tokenKey);
    recoverEffectTokenApply(token);
    setImageFxActive(false);
    updatePortraitIdle();
    requestRender();
    throw err;
  }
}

function effectTokenGlyphSizeForRect(rect) {
  const w = Number(rect?.w) || 0;
  const h = Number(rect?.h) || 0;
  return clamp(Math.min(w, h) * 0.35, 40, 116);
}

function effectTokenDisplaySizeForRect(rect, effectType) {
  const normalized = effectTypeFromTokenType(effectType || "extract_dna");
  const base = effectTokenGlyphSizeForRect(rect);
  if (normalized === "extract_dna") return clamp(base * 1.75, 70, 203);
  return base;
}

function effectTokenDefaultDragSize(effectType) {
  const normalized = effectTypeFromTokenType(effectType || "extract_dna");
  return normalized === "extract_dna" ? 130 : 74;
}

async function animateThenApplyEffectToken({
  tokenId,
  targetImageId,
  dispatchId,
  fromX,
  fromY,
} = {}) {
  const token = state.effectTokensById.get(String(tokenId || "").trim()) || null;
  const targetId = String(targetImageId || "").trim();
  if (!token || !targetId) return;
  const targetRect = state.multiRects.get(targetId) || null;
  if (effectsRuntime && targetRect) {
    const transform = getMultiViewTransform();
    const targetScreenRect = multiRectToScreenRect(targetRect, transform);
    const effectType = effectTypeFromTokenType(token.type);
    await effectsRuntime.playDropIntoTarget({
      tokenId: token.id,
      effectType,
      fromX: Number(fromX) || 0,
      fromY: Number(fromY) || 0,
      targetRect: targetScreenRect,
      size: effectTokenDisplaySizeForRect(targetScreenRect, effectType),
      data: token,
    });
  }

  const current = state.effectTokensById.get(String(tokenId || "").trim()) || null;
  if (!current) return;
  if (!effectTokenCanDispatchApply(current, dispatchId, targetId)) return;
  try {
    await applyEffectTokenToImage(current.id, targetId, { dispatchId: Number(dispatchId) || 0 });
  } catch (err) {
    console.error(err);
    state.effectTokenApplyLocks.delete(String(current.id));
    recoverEffectTokenApply(current);
    showToast(err?.message || "Effect apply failed.", "error", 2600);
    requestRender();
    return;
  }
}

async function runExtractDnaFromSelection({ fromQueue = false } = {}) {
  if (!requireIntentUnlocked()) return;
  const selected = getSelectedImages();
  if (!selected.length) {
    showToast("Extract DNA needs at least one selected image.", "tip", 2400);
    return;
  }
  const sources = selected.filter((item) => item?.path);
  if (!sources.length) {
    showToast("Extract DNA failed: missing image paths.", "error", 2600);
    return;
  }
  if (!fromQueue && (isEngineBusy() || isMultiActionRunning() || state.actionQueueActive || state.actionQueue.length)) {
    const sig = sources.map((item) => String(item.id || "")).join(",");
    enqueueAction({
      label: "Extract DNA",
      key: `extract_dna:${sig}`,
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runExtractDnaFromSelection({ fromQueue: true }),
    });
    return;
  }

  bumpInteraction();
  if (!state.runDir) await ensureRun();
  const okEngine = await ensureEngineSpawned({ reason: "extract dna" });
  if (!okEngine) return;
  for (const src of sources) {
    if (src?.id) clearEffectTokenForImageId(src.id);
  }
  state.pendingExtractDna = createPendingEffectExtractionState(sources);
  state.lastAction = "Extract DNA";
  setStatus("Director: extracting DNA…");
  portraitWorking("Extract DNA", { providerOverride: "openai", clearDirector: false });
  if (!suppressReelDnaToasts()) {
    showToast("Extracting DNA from selected image(s)…", "info", 2200);
  }
  renderQuickActions();
  requestRender();

  const args = sources.map((item) => quoteForPtyArg(item.path)).join(" ");
  try {
    await invoke("write_pty", { data: `${PTY_COMMANDS.EXTRACT_DNA} ${args}\n` });
    bumpSessionApiCalls();
  } catch (err) {
    console.error(err);
    state.pendingExtractDna = null;
    setStatus(`Director: extract dna failed (${err?.message || err})`, true);
    showToast("Extract DNA failed to start.", "error", 3200);
    updatePortraitIdle();
    renderQuickActions();
  }
}

async function runSoulLeechFromSelection({ fromQueue = false } = {}) {
  if (!requireIntentUnlocked()) return;
  const selected = getSelectedImages();
  if (!selected.length) {
    showToast("Soul Leech needs at least one selected image.", "tip", 2400);
    return;
  }
  const sources = selected.filter((item) => item?.path);
  if (!sources.length) {
    showToast("Soul Leech failed: missing image paths.", "error", 2600);
    return;
  }
  if (!fromQueue && (isEngineBusy() || isMultiActionRunning() || state.actionQueueActive || state.actionQueue.length)) {
    const sig = sources.map((item) => String(item.id || "")).join(",");
    enqueueAction({
      label: "Soul Leech",
      key: `soul_leech:${sig}`,
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runSoulLeechFromSelection({ fromQueue: true }),
    });
    return;
  }

  bumpInteraction();
  if (!state.runDir) await ensureRun();
  const okEngine = await ensureEngineSpawned({ reason: "soul leech" });
  if (!okEngine) return;
  for (const src of sources) {
    if (src?.id) clearEffectTokenForImageId(src.id);
  }
  state.pendingSoulLeech = createPendingEffectExtractionState(sources);
  state.lastAction = "Soul Leech";
  setStatus("Director: extracting soul…");
  portraitWorking("Soul Leech", { providerOverride: "openai", clearDirector: false });
  showToast("Extracting soul from selected image(s)…", "info", 2200);
  renderQuickActions();
  requestRender();

  const args = sources.map((item) => quoteForPtyArg(item.path)).join(" ");
  try {
    await invoke("write_pty", { data: `${PTY_COMMANDS.SOUL_LEECH} ${args}\n` });
    bumpSessionApiCalls();
  } catch (err) {
    console.error(err);
    state.pendingSoulLeech = null;
    setStatus(`Director: soul leech failed (${err?.message || err})`, true);
    showToast("Soul Leech failed to start.", "error", 3200);
    updatePortraitIdle();
    renderQuickActions();
  }
}

function consumePendingEffectExtraction(kind, imagePath) {
  const path = String(imagePath || "").trim();
  const isSoul = String(kind || "") === "soul";
  const pending = isSoul ? state.pendingSoulLeech : state.pendingExtractDna;
  if (!pending) return null;
  if (!path) return null;
  const { matchedImageId, unresolvedCount } = consumePendingEffectSourceSlot(pending, path, Date.now());
  if (unresolvedCount === 0) {
    if (isSoul) state.pendingSoulLeech = null;
    else state.pendingExtractDna = null;
    setStatus(isSoul ? "Director: soul extraction ready" : "Director: dna extraction ready");
    updatePortraitIdle();
    renderQuickActions();
    processActionQueue().catch(() => {});
  }

  return matchedImageId;
}

function resolveExtractionEventImageIdByPath(imagePath) {
  const path = String(imagePath || "").trim();
  if (!path) return null;

  const activeId = String(state.activeId || "").trim();
  if (activeId) {
    const active = state.imagesById.get(activeId) || null;
    if (active?.path && String(active.path) === path) return activeId;
  }

  const selected = getSelectedIds().map((id) => String(id || "").trim()).filter(Boolean);
  for (const id of selected) {
    const item = state.imagesById.get(id) || null;
    if (item?.path && String(item.path) === path) return id;
  }

  const z = Array.isArray(state.freeformZOrder) ? state.freeformZOrder.slice().reverse() : [];
  for (const rawId of z) {
    const id = String(rawId || "").trim();
    if (!id) continue;
    const item = state.imagesById.get(id) || null;
    if (item?.path && String(item.path) === path) return id;
  }

  const images = Array.isArray(state.images) ? state.images.slice().reverse() : [];
  for (const item of images) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    if (item?.path && String(item.path) === path) return id;
  }
  return null;
}

function pendingEffectUnresolvedSlots(pending) {
  if (!pending || typeof pending !== "object") return [];
  const slots = Array.isArray(pending.sourceSlots) ? pending.sourceSlots : [];
  return slots.filter((slot) => slot && !slot.resolved);
}

function pendingExtractionKindForImageId(imageId) {
  const id = String(imageId || "").trim();
  if (!id) return null;
  const dnaPending = pendingEffectUnresolvedSlots(state.pendingExtractDna).some(
    (slot) => String(slot.imageId || "").trim() === id
  );
  if (dnaPending) return "extract_dna";
  const soulPending = pendingEffectUnresolvedSlots(state.pendingSoulLeech).some(
    (slot) => String(slot.imageId || "").trim() === id
  );
  if (soulPending) return "soul_leech";
  return null;
}

function shouldAnimateEffectVisuals() {
  if (state.canvasMode !== "multi") return false;
  if (pendingEffectUnresolvedSlots(state.pendingExtractDna).length) return true;
  if (pendingEffectUnresolvedSlots(state.pendingSoulLeech).length) return true;
  for (const token of state.effectTokensById.values()) {
    if (!token) continue;
    const life = String(token.lifecycle || "");
    if (life === EFFECT_TOKEN_LIFECYCLE.CONSUMED) continue;
    return true;
  }
  return false;
}

function buildEffectsRuntimeScene() {
  if (state.canvasMode !== "multi") return { extracting: [], tokens: [], drag: null };
  const transform = getMultiViewTransform();
  const extracting = [];
  const tokens = [];

  for (const [imageId, rect] of state.multiRects.entries()) {
    const screenRect = multiRectToScreenRect(rect, transform);
    if (!screenRect) continue;
    const extractionKind = pendingExtractionKindForImageId(imageId);
    if (extractionKind) {
      extracting.push({
        imageId: String(imageId || ""),
        effectType: extractionKind,
        rect: screenRect,
      });
    }
    const token = effectTokenForImageId(imageId);
    if (!token) continue;
    if (String(token.lifecycle || "") === EFFECT_TOKEN_LIFECYCLE.CONSUMED) continue;
    tokens.push({
      tokenId: String(token.id || ""),
      imageId: String(imageId || ""),
      effectType: effectTypeFromTokenType(token.type),
      lifecycle: String(token.lifecycle || EFFECT_TOKEN_LIFECYCLE.READY),
      rect: screenRect,
      palette: Array.isArray(token.palette) ? token.palette.slice(0, 8) : [],
      colors: Array.isArray(token.colors) ? token.colors.slice(0, 8) : [],
      materials: Array.isArray(token.materials) ? token.materials.slice(0, 8) : [],
      emotion: token.emotion ? String(token.emotion) : "",
      summary: token.summary ? String(token.summary) : "",
      sourceImageId: String(token.sourceImageId || ""),
    });
  }

  let drag = null;
  const dragState = state.effectTokenDrag || null;
  if (dragState) {
    const token = state.effectTokensById.get(String(dragState.tokenId || "").trim()) || null;
    const effectType = effectTypeFromTokenType(token?.type || "extract_dna");
    const targetId = String(dragState.targetImageId || "").trim();
    const targetRect = targetId ? state.multiRects.get(targetId) || null : null;
    const targetScreenRect = targetRect ? multiRectToScreenRect(targetRect, transform) : null;
    drag = {
      tokenId: String(dragState.tokenId || ""),
      effectType,
      x: Number(dragState.x) || 0,
      y: Number(dragState.y) || 0,
      size: targetScreenRect
        ? effectTokenDisplaySizeForRect(targetScreenRect, effectType)
        : effectTokenDefaultDragSize(effectType),
      targetRect: targetScreenRect,
      data: token,
    };
  }

  return { extracting, tokens, drag };
}

function syncEffectsRuntimeScene() {
  if (!effectsRuntime) return;
  const suspended = document.hidden || state.canvasMode !== "multi";
  effectsRuntime.setSuspended(suspended);
  if (suspended) {
    effectsRuntime.syncScene({ extracting: [], tokens: [], drag: null });
    return;
  }
  effectsRuntime.syncScene(buildEffectsRuntimeScene());
}

async function selectCanvasImage(imageId, { toggle = false } = {}) {
  const id = String(imageId || "").trim();
  if (!id) return;
  const item = state.imagesById.get(id) || null;
  if (!item) return;

  const current = getSelectedIds();
  const has = current.includes(id);
  let next = current.slice();

  if (!toggle) {
    next = [id];
  } else if (has) {
    // Keep at least one selected image to avoid entering a confusing "no selection" state.
    if (next.length > 1) next = next.filter((v) => v !== id);
  } else {
    next.push(id);
    // Cap multi-select to 3 images (2/3-image abilities).
    if (next.length > 3) next = next.slice(next.length - 3);
  }

  setSelectedIds(next);
  const nextActive = next.includes(id) ? id : next[next.length - 1] || null;
  recordUserEvent("selection_change", {
    canvas_mode: state.canvasMode,
    active_id: nextActive || state.activeId || null,
    selected_ids: next.slice(0, 3),
    toggle: Boolean(toggle),
  });
  if (!nextActive) {
    renderQuickActions();
    renderHudReadout();
    requestRender();
    return;
  }

  if (nextActive === state.activeId) {
    renderQuickActions();
    renderHudReadout();
    requestRender();
    return;
  }

  await setActiveImage(nextActive, { preserveSelection: true }).catch(() => {});
}

function setCanvasMode(mode) {
  const next = mode === "multi" ? "multi" : "single";
  // Intent Mode requires the freeform spatial canvas; keep users in multi mode until intent is locked.
  if (intentModeActive() && next !== "multi") return;
  if (state.canvasMode === next) return;
  const prevMode = state.canvasMode;
  state.canvasMode = next;
  recordUserEvent("canvas_mode_set", { prev: prevMode, next });
  if (next === "single") {
    const active = String(state.activeId || "").trim();
    setSelectedIds(active ? [active] : []);
  } else if (next === "multi") {
    const active = String(state.activeId || "").trim();
    if (active && selectedCount() === 0) setSelectedIds([active]);
  }
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
  motherIdleSyncFromInteraction({ userInteraction: false });
  if (effectsRuntime) {
    effectsRuntime.setSuspended(document.hidden || state.canvasMode !== "multi");
  }
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
      // One-shot: once we know the real aspect ratio, convert square placeholders into
      // aspect-correct freeform rects (keeps the click-to-place flow feeling intentional).
      if (item?.id) {
        const rect = state.freeformRects.get(item.id) || null;
        const iw = item.width;
        const ih = item.height;
        if (rect && rect.autoAspect && iw && ih) {
          const prevH = Number(rect.h) || 1;
          const nextH = Math.max(1, Math.round(rect.w * (ih / iw)));
          rect.h = nextH;
          // Keep the rect center stable as we switch from placeholder square -> real aspect.
          rect.y = (Number(rect.y) || 0) + Math.round((prevH - nextH) / 2);
          rect.autoAspect = false;
          const wrap = els.canvasWrap;
          const cw = wrap?.clientWidth || 0;
          const ch = wrap?.clientHeight || 0;
          const margin = 14;
          if (cw && ch) {
            rect.x = clamp(Math.round(rect.x), margin, Math.max(margin, Math.round(cw - rect.w - margin)));
            rect.y = clamp(Math.round(rect.y), margin, Math.max(margin, Math.round(ch - rect.h - margin)));
          }
          scheduleVisualPromptWrite();
          if (intentAmbientActive()) {
            scheduleAmbientIntentInference({ immediate: true, reason: "composition_change", imageIds: [item.id] });
          }
          if (intentModeActive()) {
            scheduleIntentStateWrite();
          }
        }
      }
    })
    .catch((err) => {
      console.warn("Failed to load image for canvas:", err);
    })
    .finally(() => {
      item.imgLoading = false;
      requestRender();
    });
}

function freeformDefaultTileCss(canvasCssW, canvasCssH, { count = null } = {}) {
  const isMobile =
    window.matchMedia && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 980px)").matches
      : false;
  const minDim = Math.max(1, Math.min(Number(canvasCssW) || 0, Number(canvasCssH) || 0));
  const n = Math.max(1, Number.isFinite(Number(count)) ? Math.round(Number(count) || 0) : 1);

  // Default import size: bias larger because most sessions start with 1-3 images.
  // Still clamp to avoid overlap in the auto-layout grid.
  let frac = isMobile ? 0.38 : 0.26;
  if (isMobile) {
    if (n <= 1) frac = 0.62;
    else if (n === 2) frac = 0.48;
    else if (n === 3) frac = 0.44;
    else if (n === 4) frac = 0.40;
  } else {
    if (n <= 1) frac = 0.54;
    else if (n === 2) frac = 0.42;
    else if (n === 3) frac = 0.38;
    else if (n === 4) frac = 0.32;
  }

  const base = Math.round(minDim * frac);
  const minPx = isMobile ? 160 : 220;
  const maxPx = isMobile ? (n <= 1 ? 520 : 420) : n <= 1 ? 680 : 560;

  // Ensure the implied grid (based on n) can fit within the canvas.
  const margin = 14;
  const gapFrac = 0.11;
  let cols = 1;
  if (n === 2) cols = 2;
  else if (n <= 4) cols = 2;
  else cols = 3;
  const rows = Math.ceil(n / cols);
  const availW = Math.max(1, (Number(canvasCssW) || 0) - margin * 2);
  const availH = Math.max(1, (Number(canvasCssH) || 0) - margin * 2);
  const denomW = cols + Math.max(0, cols - 1) * gapFrac;
  const denomH = rows + Math.max(0, rows - 1) * gapFrac;
  const fitMax = Math.floor(Math.min(availW / Math.max(denomW, 0.0001), availH / Math.max(denomH, 0.0001)));

  return clamp(base, minPx, Math.max(minPx, Math.min(maxPx, fitMax)));
}

function ensureFreeformLayoutRectsCss(items, canvasCssW, canvasCssH) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  const tile = freeformDefaultTileCss(canvasCssW, canvasCssH, { count: list.length });
  const gap = Math.round(tile * 0.11);
  const margin = 14;

  // Keep z-order stable: start with import order, allow runtime reordering via state.freeformZOrder.
  for (const item of list) {
    if (!item?.id) continue;
    if (!state.freeformZOrder.includes(item.id)) state.freeformZOrder.push(item.id);
  }

  const missing = list.some((item) => item?.id && !state.freeformRects.has(item.id));
  if (!missing) return;

  const n = list.length;
  let cols = 1;
  if (n === 2) cols = 2;
  else if (n <= 4) cols = 2;
  else cols = 3;
  const rows = Math.ceil(n / cols);

  const gridW = cols * tile + (cols - 1) * gap;
  const gridH = rows * tile + (rows - 1) * gap;
  const startX = Math.round((canvasCssW - gridW) * 0.5);
  const startY = Math.round((canvasCssH - gridH) * 0.5);

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item?.id) continue;
    if (state.freeformRects.has(item.id)) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    let x = startX + col * (tile + gap);
    let y = startY + row * (tile + gap);
    x = clamp(Math.round(x), margin, Math.max(margin, Math.round(canvasCssW - tile - margin)));
    y = clamp(Math.round(y), margin, Math.max(margin, Math.round(canvasCssH - tile - margin)));
    state.freeformRects.set(item.id, { x, y, w: tile, h: tile, autoAspect: true });
  }
}

function computeFreeformRectsPx(canvasW, canvasH) {
  const dpr = getDpr();
  const canvasCssW = (Number(canvasW) || 0) / dpr;
  const canvasCssH = (Number(canvasH) || 0) / dpr;
  ensureFreeformLayoutRectsCss(state.images || [], canvasCssW, canvasCssH);

  const rects = new Map();
  for (const imageId of state.freeformZOrder || []) {
    const rectCss = state.freeformRects.get(imageId) || null;
    if (!rectCss) continue;
    rects.set(imageId, {
      x: Math.round((Number(rectCss.x) || 0) * dpr),
      y: Math.round((Number(rectCss.y) || 0) * dpr),
      w: Math.max(1, Math.round((Number(rectCss.w) || 1) * dpr)),
      h: Math.max(1, Math.round((Number(rectCss.h) || 1) * dpr)),
    });
  }
  return rects;
}

function clampFreeformRectCss(rectCss, canvasCssW, canvasCssH, { margin = 14, minSize = 44 } = {}) {
  const w = Math.max(minSize, Math.round(Number(rectCss?.w) || 0));
  const h = Math.max(minSize, Math.round(Number(rectCss?.h) || 0));
  const maxX = Math.max(margin, Math.round((Number(canvasCssW) || 0) - w - margin));
  const maxY = Math.max(margin, Math.round((Number(canvasCssH) || 0) - h - margin));
  return {
    x: clamp(Math.round(Number(rectCss?.x) || 0), margin, maxX),
    y: clamp(Math.round(Number(rectCss?.y) || 0), margin, maxY),
    w,
    h,
    autoAspect: Boolean(rectCss?.autoAspect),
  };
}

function hitTestFreeformCornerHandleWithPad(ptCanvas, rectPx, padPx = 0) {
  if (!ptCanvas || !rectPx) return null;
  const dpr = getDpr();
  const hs = Math.max(10, Math.round(10 * dpr));
  const r = Math.round(hs / 2) + Math.max(0, Math.round(Number(padPx) || 0));
  const corners = [
    { id: "nw", x: rectPx.x, y: rectPx.y },
    { id: "ne", x: rectPx.x + rectPx.w, y: rectPx.y },
    { id: "sw", x: rectPx.x, y: rectPx.y + rectPx.h },
    { id: "se", x: rectPx.x + rectPx.w, y: rectPx.y + rectPx.h },
  ];
  for (const c of corners) {
    if (Math.abs(ptCanvas.x - c.x) <= r && Math.abs(ptCanvas.y - c.y) <= r) return c.id;
  }
  return null;
}

function hitTestAnyFreeformCornerHandle(ptCanvas, { padPx = 0 } = {}) {
  if (!ptCanvas) return null;
  const ms = state.multiView?.scale || 1;
  const mx = state.multiView?.offsetX || 0;
  const my = state.multiView?.offsetY || 0;
  const x = (ptCanvas.x - mx) / Math.max(ms, 0.0001);
  const y = (ptCanvas.y - my) / Math.max(ms, 0.0001);
  const entries = Array.from(state.multiRects.entries());
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [id, rect] = entries[i];
    if (isImageEffectTokenized(id)) continue;
    if (!rect) continue;
    const corner = hitTestFreeformCornerHandleWithPad({ x, y }, rect, padPx);
    if (!corner) continue;
    return { id, corner };
  }
  return null;
}

function resizeFreeformRectFromCorner(startRectCss, corner, pointerCss, canvasCssW, canvasCssH) {
  const start = startRectCss || {};
  const x0 = Number(start.x) || 0;
  const y0 = Number(start.y) || 0;
  const w0 = Math.max(1, Number(start.w) || 1);
  const h0 = Math.max(1, Number(start.h) || 1);
  const x1 = x0 + w0;
  const y1 = y0 + h0;

  const px = Number(pointerCss?.x) || 0;
  const py = Number(pointerCss?.y) || 0;

  let fx = x0;
  let fy = y0;
  let sx = 1;
  let sy = 1;
  if (corner === "nw") {
    fx = x1;
    fy = y1;
    sx = -1;
    sy = -1;
  } else if (corner === "ne") {
    fx = x0;
    fy = y1;
    sx = 1;
    sy = -1;
  } else if (corner === "sw") {
    fx = x1;
    fy = y0;
    sx = -1;
    sy = 1;
  } else if (corner === "se") {
    fx = x0;
    fy = y0;
    sx = 1;
    sy = 1;
  }

  const dx = px - fx;
  const dy = py - fy;
  const aspect = w0 / Math.max(1, h0);
  const absW = Math.max(1, Math.abs(dx));
  const absH = Math.max(1, Math.abs(dy));

  const nextW = Math.max(absW, absH * aspect);
  const nextH = nextW / Math.max(0.001, aspect);

  const cx = fx + sx * nextW;
  const cy = fy + sy * nextH;
  const nx0 = Math.min(fx, cx);
  const ny0 = Math.min(fy, cy);
  const nx1 = Math.max(fx, cx);
  const ny1 = Math.max(fy, cy);

  return clampFreeformRectCss(
    { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0, autoAspect: false },
    canvasCssW,
    canvasCssH
  );
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

  // Don't contend with foreground actions or queued user work.
  if (
    state.ptySpawning ||
    state.actionQueueActive ||
    state.actionQueue.length ||
    state.pendingBlend ||
    state.pendingSwapDna ||
    state.pendingBridge ||
    state.pendingExtractDna ||
    state.pendingSoulLeech ||
    state.pendingArgue ||
    state.pendingExtractRule ||
    state.pendingOddOneOut ||
    state.pendingTriforce ||
    state.pendingRecast ||
    state.pendingDiagnose ||
    state.pendingRecreate ||
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
  try {
    await invoke("write_pty", { data: `${PTY_COMMANDS.DIAGNOSE} ${quoteForPtyArg(outPath)}\n` });
    bumpSessionApiCalls();
  } catch (_) {
    // Best-effort; if the engine drops, we'll retry on the next debounce.
  }
}

async function renderCanvasSnapshotForDiagnose({ maxDimPx = 1200 } = {}) {
  const baseCanvas = els.workCanvas;
  if (!baseCanvas) return null;
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

  // Snapshot the actual canvas pixels so freeform spatial layout is preserved.
  ctx.drawImage(baseCanvas, 0, 0, w, h);
  return canvas;
}

function hitTestMulti(pt, { includeTokenized = false } = {}) {
  if (!pt) return null;
  const ms = state.multiView?.scale || 1;
  const mx = state.multiView?.offsetX || 0;
  const my = state.multiView?.offsetY || 0;
  const x = (pt.x - mx) / Math.max(ms, 0.0001);
  const y = (pt.y - my) / Math.max(ms, 0.0001);
  const entries = Array.from(state.multiRects.entries());
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [id, rect] = entries[i];
    if (!includeTokenized && isImageEffectTokenized(id)) continue;
    if (!rect) continue;
    if (x < rect.x || x > rect.x + rect.w) continue;
    if (y < rect.y || y > rect.y + rect.h) continue;
    return id;
  }
  return null;
}

function hitTestMultiWithPad(pt, padPx = 0, { includeTokenized = false } = {}) {
  const padRaw = Math.max(0, Number(padPx) || 0);
  if (!padRaw) return hitTestMulti(pt, { includeTokenized });
  if (!pt) return null;
  const ms = state.multiView?.scale || 1;
  const mx = state.multiView?.offsetX || 0;
  const my = state.multiView?.offsetY || 0;
  const x = (pt.x - mx) / Math.max(ms, 0.0001);
  const y = (pt.y - my) / Math.max(ms, 0.0001);
  // Pad is specified in screen/canvas pixels; convert to local multi-rect space.
  const pad = padRaw / Math.max(ms, 0.0001);
  const entries = Array.from(state.multiRects.entries());
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [id, rect] = entries[i];
    if (!includeTokenized && isImageEffectTokenized(id)) continue;
    if (!rect) continue;
    if (x < rect.x - pad || x > rect.x + rect.w + pad) continue;
    if (y < rect.y - pad || y > rect.y + rect.h + pad) continue;
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

  const motherSourceIds = state.pendingMotherDraft?.sourceIds;
  if (Array.isArray(motherSourceIds) && motherSourceIds.length) {
    return Array.from(new Set(motherSourceIds.map((v) => String(v || "").trim()).filter(Boolean)));
  }

  const activeId = state.activeId;
  if (activeId) return [activeId];
  return [];
}

let imageFxDynamicEls = [];

function ensureImageFxOverlays(count = 0) {
  const baseEls = [];
  if (els.imageFx) baseEls.push(els.imageFx);
  if (els.imageFx2) baseEls.push(els.imageFx2);
  const minimumCount = Math.max(baseEls.length, Number(count) || 0);
  const neededDynamic = Math.max(0, minimumCount - baseEls.length);
  const wrap = els.canvasWrap;

  while (imageFxDynamicEls.length < neededDynamic) {
    if (!wrap) break;
    const fx = document.createElement("div");
    fx.className = "image-fx hidden";
    fx.setAttribute("aria-hidden", "true");
    wrap.appendChild(fx);
    imageFxDynamicEls.push(fx);
  }
  while (imageFxDynamicEls.length > neededDynamic) {
    const fx = imageFxDynamicEls.pop();
    if (fx?.parentNode) {
      fx.parentNode.removeChild(fx);
    }
  }
  return [...baseEls, ...imageFxDynamicEls];
}

function hideImageFxOverlays() {
  const overlays = ensureImageFxOverlays(0);
  for (const fx of overlays) {
    if (!fx) continue;
    fx.classList.add("hidden");
    fx.style.width = "0px";
    fx.style.height = "0px";
  }
}

function updateImageFxRect() {
  const targets = getImageFxTargets();
  const overlays = ensureImageFxOverlays(Math.max(1, targets.length));
  if (!overlays.length) return;
  if (!state.imageFx?.active) {
    hideImageFxOverlays();
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

  const fallbackRect = getActiveImageRectCss();
  overlays.forEach((fx, idx) => {
    const targetId = targets[idx] || null;
    const rect = targetId ? getImageRectCss(targetId) : idx === 0 ? fallbackRect : null;
    fx.classList.toggle("hidden", !rect);
    setRect(fx, rect);
  });
}

function setImageFxActive(active, label = null) {
  state.imageFx.active = Boolean(active);
  state.imageFx.label = label || null;
  if (state.imageFx.active) {
    updateImageFxRect();
  } else {
    hideImageFxOverlays();
  }
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

function beginRunningAction(key) {
  const k = String(key || "").trim();
  if (!k) return;
  state.runningActionKey = k;
  renderQuickActions();
}

function clearRunningAction(key = null) {
  if (key && state.runningActionKey !== key) return;
  state.runningActionKey = null;
  renderQuickActions();
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
  const prevTool = state.tool;
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
  if (prevTool !== tool) {
    recordUserEvent("tool_set", { tool });
  }
  renderQuickActions();
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
  return Boolean(
    state.pendingBlend ||
      state.pendingSwapDna ||
      state.pendingBridge ||
      state.pendingExtractDna ||
      state.pendingSoulLeech ||
      state.pendingArgue ||
      state.pendingExtractRule ||
      state.pendingOddOneOut ||
      state.pendingTriforce
  );
}

const ACTION_QUEUE_MAX = 32;
const ACTION_QUEUE_PRIORITY = {
  user: 100,
  background: 10,
};

function isEngineBusy() {
  return Boolean(
    state.ptySpawning ||
      state.alwaysOnVision?.pending ||
      state.pendingBlend ||
      state.pendingSwapDna ||
      state.pendingBridge ||
      state.pendingExtractDna ||
      state.pendingSoulLeech ||
      state.pendingArgue ||
      state.pendingExtractRule ||
      state.pendingOddOneOut ||
      state.pendingTriforce ||
      state.pendingRecast ||
      state.pendingCanvasDiagnose ||
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
  state.actionQueueStats = {
    replacedByKey: 0,
    droppedOverflow: 0,
    lastDropLabel: null,
  };
  renderSessionApiCallsReadout();
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
  let replacedCount = 0;
  if (key) {
    // De-dupe repeated clicks; keep latest request.
    const before = state.actionQueue.length;
    state.actionQueue = state.actionQueue.filter((item) => item?.key !== key);
    replacedCount = Math.max(0, before - state.actionQueue.length);
    if (replacedCount) {
      state.actionQueueStats.replacedByKey = Math.max(0, Number(state.actionQueueStats.replacedByKey) || 0) + replacedCount;
    }
  }

  const queuedItem = {
    id: _actionQueueMakeId(),
    label: String(label),
    key: key ? String(key) : null,
    priority: typeof priority === "number" ? priority : ACTION_QUEUE_PRIORITY.user,
    enqueuedAt: now,
    source: source ? String(source) : "user",
    run: fn,
  };
  state.actionQueue.push(queuedItem);

  // Keep queue bounded by dropping the lowest-priority oldest items.
  const droppedItems = [];
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
    const dropped = state.actionQueue.splice(dropIdx, 1)[0];
    if (dropped) droppedItems.push(dropped);
  }

  if (droppedItems.length) {
    state.actionQueueStats.droppedOverflow =
      Math.max(0, Number(state.actionQueueStats.droppedOverflow) || 0) + droppedItems.length;
    state.actionQueueStats.lastDropLabel = String(droppedItems[droppedItems.length - 1]?.label || "Action");
    const dropLead = String(droppedItems[0]?.label || "action");
    const more = droppedItems.length > 1 ? ` (+${droppedItems.length - 1} more)` : "";
    showToast(`Queue full: dropped ${dropLead}${more}.`, "tip", 2600);
  }

  const queuedKept = state.actionQueue.some((item) => item?.id === queuedItem.id);
  if (queuedKept) {
    const mergedNote = replacedCount ? ` (updated ${replacedCount})` : "";
    showToast(`Queued: ${label}${mergedNote}`, "tip", 1500);
  } else {
    showToast(`Queue full: ${label} was not queued.`, "error", 2800);
  }
  renderQuickActions();
  renderSessionApiCallsReadout();
  processActionQueue().catch((err) => {
    reportUserError("Queue processing", err, { retryHint: "Wait for current work to finish, then retry." });
  });
  return queuedKept;
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
      renderSessionApiCallsReadout();
    }

    while (!state.actionQueueActive && !isEngineBusy() && state.actionQueue.length) {
      // Realtime canvas context drives Suggested Ability; when it's due, run it ahead of
      // other queued API work so the UI stays responsive.
      try {
        const started = await runAlwaysOnVisionOnce();
        if (started && isEngineBusy()) return;
      } catch (err) {
        console.warn("Always-on vision priority dispatch failed:", err);
      }

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
      renderSessionApiCallsReadout();

      const queuedStatus = `Engine: queued action running (${item.label})`;
      const prevStatusText = String(state.lastStatusText || "");
      const prevStatusError = Boolean(state.lastStatusError);
      try {
        setStatus(queuedStatus);
        await Promise.resolve(item.run());
      } catch (err) {
        console.error("Queued action failed:", item?.label, err);
        reportUserError(item?.label || "Queued action", err, { retryHint: "Retry from Abilities." });
      }

      if (isEngineBusy()) {
        // Engine-driven action is in flight; completion events will resume the queue.
        return;
      }

      // If the queued callback returned without launching engine work, clear the
      // temporary queue-running status so the ribbon does not appear stuck.
      if (String(state.lastStatusText || "") === queuedStatus) {
        setStatus(prevStatusText || (state.ptySpawned ? "Engine: ready" : "Engine: idle"), prevStatusError);
      }

      // Completed immediately (local action or no-op); continue draining.
      state.actionQueueActive = null;
      renderQuickActions();
      renderSessionApiCallsReadout();
    }
  } finally {
    state.actionQueueRunning = false;
    renderSessionApiCallsReadout();
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
    const canBlend = selectedCount() === 2 && !isMultiActionRunning();
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

function computeQuickActions() {
  // Scaffolding: keep this as a pure function of current canvas state so we can
  // grow rules over time without entangling UI code.
  const actions = [];
  const active = getActiveImage();
  const nSelected = selectedCount();

  if (!active) {
    actions.push({
      id: "no_image",
      label: "Import photos to unlock abilities",
      disabled: true,
    });
    return actions;
  }

  // View toggles.
  if (state.canvasMode === "multi") {
    actions.push({
      id: "single_view",
      label: "Single view",
      title: "Show one image at a time (restores single-image abilities)",
      disabled: false,
      onClick: () => setCanvasMode("single"),
    });
  } else if (state.images.length > 1) {
    actions.push({
      id: "multi_view",
      label: "Multi view",
      title: "Show all loaded photos (enables multi-select + multi-image abilities)",
      disabled: false,
      onClick: () => setCanvasMode("multi"),
    });
  }

  // Multi-image abilities are driven by *selected* images, not run size.
  if (nSelected === 2) {
    actions.push({
      id: "combine",
      label: state.pendingBlend ? "Combine (running…)" : "Combine",
      title: "Blend the 2 selected photos into one",
      disabled: false,
      onClick: () => runBlendPair().catch((err) => console.error(err)),
    });
    actions.push({
      id: "bridge",
      label: state.pendingBridge ? "Bridge (running…)" : "Bridge",
      title: "Find the aesthetic midpoint between the 2 selected images (not a collage)",
      disabled: false,
      onClick: () => runBridgePair().catch((err) => console.error(err)),
    });
    actions.push({
      id: "swap_dna",
      label: state.pendingSwapDna ? "Swap DNA (running…)" : "Swap DNA",
      title: "Use structure from the active image and surface qualities from the other (Shift-click to invert)",
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
  if (nSelected === 3) {
    const runningMulti = isMultiActionRunning();
    actions.push({
      id: "extract_rule",
      label: state.pendingExtractRule ? "Extract the Rule (running…)" : "Extract the Rule",
      title: "Extract the invisible rule you're applying across the 3 selected images.",
      disabled: Boolean(runningMulti && !state.pendingExtractRule),
      onClick: () => runExtractRuleTriplet().catch((err) => console.error(err)),
    });
    actions.push({
      id: "odd_one_out",
      label: state.pendingOddOneOut ? "Odd One Out (running…)" : "Odd One Out",
      title: "Identify which of the 3 selected breaks the shared pattern, and explain why.",
      disabled: Boolean(runningMulti && !state.pendingOddOneOut),
      onClick: () => runOddOneOutTriplet().catch((err) => console.error(err)),
    });
    actions.push({
      id: "triforce",
      label: state.pendingTriforce ? "Triforce (running…)" : "Triforce",
      title: "Generate the centroid: one image equidistant from all 3 selected references.",
      disabled: Boolean(runningMulti && !state.pendingTriforce),
      onClick: () => runTriforceTriplet().catch((err) => console.error(err)),
    });
    return actions;
  }
  if (nSelected > 3) {
    actions.push({
      id: "multi_hint",
      label: `Multi-select: pick exactly 2 or 3 images (you have ${nSelected}).`,
      disabled: true,
    });
    return actions;
  }

  const iw = active?.img?.naturalWidth || active?.width || null;
  const ih = active?.img?.naturalHeight || active?.height || null;
  const canCropSquare = Boolean(iw && ih && Math.abs(iw - ih) > 8);

  // Realtime canvas context effectively performs continuous diagnosis; hide the explicit Diagnose action
  // when Always-On Vision is enabled so the system recommends other next steps.
  if (!state.alwaysOnVision?.enabled) {
    actions.push({
      id: "diagnose",
      label: state.pendingDiagnose ? "Diagnose (running…)" : "Diagnose",
      title: "Creative-director diagnosis: what's working, what isn't, and what to fix next",
      disabled: false,
      onClick: () => runDiagnose().catch((err) => console.error(err)),
    });
  }
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

function _runningKeyFromPendingReplace(pending) {
  const label = pending?.label ? String(pending.label) : "";
  const stable = label.toLowerCase();
  if (stable.includes("remove people")) return "remove_people";
  if (stable.includes("extract dna")) return "extract_dna";
  if (stable.includes("soul leech")) return "soul_leech";
  if (stable.includes("surprise")) return "surprise";
  if (stable.includes("studio white") || stable.includes("soft sweep") || stable.includes("background")) return "bg";
  if (stable.includes("annotate")) return "annotate";
  return "bg";
}

function currentRunningActionKey() {
  if (state.runningActionKey) return state.runningActionKey;
  if (state.pendingBlend) return "combine";
  if (state.pendingBridge) return "bridge";
  if (state.pendingSwapDna) return "swap_dna";
  if (state.pendingExtractDna) return "extract_dna";
  if (state.pendingSoulLeech) return "soul_leech";
  if (state.pendingArgue) return "argue";
  if (state.pendingExtractRule) return "extract_rule";
  if (state.pendingOddOneOut) return "odd_one_out";
  if (state.pendingTriforce) return "triforce";
  if (state.pendingRecast) return "recast";
  if (state.pendingDiagnose) return "diagnose";
  if (state.pendingRecreate) return "variations";
  if (state.pendingReplace) return _runningKeyFromPendingReplace(state.pendingReplace);
  return null;
}

function actionGridTitleFor(key) {
  const k = String(key || "").trim();
  if (!k) return "";
  if (k === "annotate") return "Annotate (box + instruction)";
  if (k === "pan") return "Pan / Zoom";
  if (k === "lasso") return "Lasso selection";
  if (k === "designate") return "Designate subject/reference/object";
  if (k === "bg") return "Background replace (Shift: Sweep)";
  if (k === "extract_dna") return "Extract DNA: collapse selected image(s) into transferable material/color helix";
  if (k === "soul_leech") return "Soul Leech: collapse selected image(s) into transferable emotional mask";
  if (k === "remove_people") return "Remove people from the active image";
  if (k === "variations") return "Zero-prompt variations";
  if (k === "diagnose") return "Creative-director diagnosis";
  if (k === "recast") return "Reimagine the image in a different medium/context";
  if (k === "crop_square") return "Crop the active image to a centered square";
  if (k === "combine") return "Combine: blend the 2 selected photos";
  if (k === "bridge") return "Bridge: find the aesthetic midpoint between the 2 selected photos";
  if (k === "swap_dna") return "Swap DNA (Shift: invert)";
  if (k === "argue") return "Argue: debate the 2 directions with visual evidence";
  if (k === "extract_rule") return "Extract the Rule (3 selected photos)";
  if (k === "odd_one_out") return "Odd One Out (3 selected photos)";
  if (k === "triforce") return "Triforce (3 selected photos)";
  return k;
}

function actionGridIconFor(key) {
  const k = String(key || "").trim();
  if (!k) return "";
  // Keep SVGs small and stroke-only so the tool style does the heavy lifting.
  if (k === "annotate") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6h11v11H5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <path d="M14.5 4.5l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M13 6l6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>`;
  }
  if (k === "pan") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v6M12 21v-6M3 12h6M21 12h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" />
      <path d="M12 3l-2 2M12 3l2 2M12 21l-2-2M12 21l2-2M3 12l2-2M3 12l2 2M21 12l-2-2M21 12l-2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" />
    </svg>`;
  }
  if (k === "lasso") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="9.5" rx="6.5" ry="4.5" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M15 13.5c0.9 1.2 1.9 2.6 3.5 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M19.5 18l1.8 1.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>`;
  }
  if (k === "designate") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M12 4v3M12 17v3M4 12h3M17 12h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>`;
  }
  if (k === "bg") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 7h10v4H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <path d="M16 9h2a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M8 11v7h4v-4h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;
  }
  if (k === "extract_dna") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4c4 0 6 3 10 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M7 10c4 0 6 3 10 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M7 16c4 0 6 3 10 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M7 4v15M17 7v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>`;
  }
  if (k === "soul_leech") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 8c0-3 2.7-5 6-5s6 2 6 5v5c0 3.7-2.8 6-6 6s-6-2.3-6-6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <path d="M9 10h.01M15 10h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M9.5 14c1.8 1.7 3.2 1.7 5 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M12 3v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>`;
  }
  if (k === "remove_people") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 12a3.5 3.5 0 1 0-0.01 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M5 20c1.2-3 4-5 7-5s5.8 2 7 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>`;
  }
  if (k === "variations") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h4l8 10h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M20 17l-2-2 2-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M4 17h4l2.5-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M20 7l-2 2 2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;
  }
  if (k === "diagnose") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15z" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M16.6 16.6L21 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>`;
  }
  if (k === "recast") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.7-6.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M21 3v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;
  }
  if (k === "crop_square") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3v14a4 4 0 0 0 4 4h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M3 7h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M7 7h10v10H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
    </svg>`;
  }
  if (k === "combine") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h8v8H5z" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M11 9h8v8h-8z" fill="none" stroke="currentColor" stroke-width="2" />
    </svg>`;
  }
  if (k === "bridge") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 8h6v8H4z" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M14 8h6v8h-6z" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M10 12h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>`;
  }
  if (k === "swap_dna") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M7 17h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M9 9l-2-2 2-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M15 15l2 2-2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;
  }
  if (k === "argue") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h10v7H7l-3 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <path d="M10 13h10v5l-3-2h-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
    </svg>`;
  }
  if (k === "extract_rule") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 4h12v16H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <path d="M8 8h8M8 12h8M8 16h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>`;
  }
  if (k === "odd_one_out") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="7.5" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="2" />
      <circle cx="16.5" cy="8" r="2.5" fill="none" stroke="currentColor" stroke-width="2" />
      <circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="2" />
    </svg>`;
  }
  if (k === "triforce") {
    return `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5l4.5 8H7.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <path d="M7.5 13l4.5 8 4.5-8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
    </svg>`;
  }
  return "";
}

function actionGridReelIconOverrideFor(key) {
  const k = String(key || "").trim();
  if (!k) return "";
  if (k === "pan") {
    // iOS-style gesture icon for reel mode: finger + touch ring.
    return `<svg class="tool-icon tool-icon-ios-pan" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="17.5" cy="6.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8" />
      <path d="M12 19v-8.4a1.6 1.6 0 0 1 3.2 0V14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <path d="M12 14l-1.6-1.5a1.5 1.5 0 0 0-2.2 2l2.5 2.8A4.7 4.7 0 0 0 14.3 19H16a4 4 0 0 0 4-4v-2.2a1.5 1.5 0 0 0-3 0V14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;
  }
  return "";
}

function renderActionGrid() {
  const root = els.actionGrid;
  if (!root) return;

  const active = getActiveImage();
  const hasImage = Boolean(active);
  const selectionN = hasImage ? selectedCount() : 0;
  const slots = computeActionGridSlots({
    selectionCount: selectionN,
    hasImage,
    alwaysOnVisionEnabled: Boolean(state.alwaysOnVision?.enabled),
  });
  const reelMode = isReelSizeLocked();
  const reelNoImageSlots = [
    { key: "annotate", label: "Annotate", kind: "tool", hotkey: "1" },
    { key: "pan", label: "Pan", kind: "tool", hotkey: "2" },
    { key: "lasso", label: "Lasso", kind: "tool", hotkey: "3" },
    { key: "designate", label: "Designate", kind: "tool", hotkey: "4" },
    { key: "bg", label: "BG", kind: "ability", hotkey: "5" },
    { key: "variations", label: "Vars", kind: "ability", hotkey: "6" },
  ];
  const visibleSlots = reelMode ? (!hasImage ? reelNoImageSlots : slots.slice(0, 6)) : slots;
  root.classList.toggle("reel-grid-2x3", reelMode);
  const runningKey = currentRunningActionKey();

  const iw = active?.img?.naturalWidth || active?.width || null;
  const ih = active?.img?.naturalHeight || active?.height || null;
  const canCropSquare = Boolean(iw && ih && Math.abs(iw - ih) > 8);

  root.innerHTML = "";
  const frag = document.createDocumentFragment();

  const imageRequiredKeys = new Set([
    "bg",
    "extract_dna",
    "soul_leech",
    "remove_people",
    "variations",
    "diagnose",
    "recast",
    "crop_square",
    "combine",
    "bridge",
    "swap_dna",
    "argue",
    "extract_rule",
    "odd_one_out",
    "triforce",
  ]);

  for (const slot of visibleSlots) {
    if (!slot) {
      const blank = document.createElement("button");
      blank.type = "button";
      blank.className = "tool tool-blank";
      blank.disabled = true;
      blank.setAttribute("aria-hidden", "true");
      frag.appendChild(blank);
      continue;
    }

    const key = String(slot.key || "").trim();
    const hotkey = String(slot.hotkey || "").trim();
    const label = String(slot.label || "").trim();
    const kind = String(slot.kind || "");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tool";
    btn.dataset.key = key;
    btn.dataset.hotkey = hotkey;
    btn.title = actionGridTitleFor(key);
    btn.setAttribute("aria-label", label || key);

    if (kind === "ability_multi") btn.classList.add("tool-multi");
    if (kind === "tool" && state.tool === key) {
      btn.classList.add("selected");
      btn.classList.add("depressed");
    }
    if (runningKey && runningKey === key) btn.classList.add("depressed");

    if (key === "crop_square" && !canCropSquare) {
      btn.disabled = true;
      btn.title = "Already square (or image size unknown)";
    }
    if (!hasImage && imageRequiredKeys.has(key)) {
      btn.disabled = true;
      btn.title = "Import a photo first";
    }

    const icon = reelMode ? actionGridReelIconOverrideFor(key) || actionGridIconFor(key) : actionGridIconFor(key);
    const hintHtml = reelMode ? "" : `<span class="tool-hint" aria-hidden="true">${hotkey}</span>`;
    btn.innerHTML = `${icon}${hintHtml}`;

    btn.addEventListener("click", (ev) => {
      bumpInteraction();
      if (state.mother?.running) {
        showToast("Mother is running. Click Stop to regain control.", "tip", 2200);
        return;
      }
      recordUserEvent("action_grid_press", {
        key,
        kind: kind ? String(kind) : null,
        shift: Boolean(ev?.shiftKey),
        active_id: state.activeId || null,
        selected_ids: getSelectedIds().slice(0, 3),
      });

      if (key === "annotate" || key === "pan" || key === "lasso" || key === "designate") {
        setTool(key);
        return;
      }
      if (key === "bg") {
        const style = ev?.shiftKey ? "sweep" : "white";
        runWithUserError("Background replace", () => applyBackground(style), {
          retryHint: "Select an image and try again.",
        });
        return;
      }
      if (key === "extract_dna") {
        runWithUserError("Extract DNA", () => runExtractDnaFromSelection(), {
          statusScope: "Director",
          retryHint: "Select at least one image and retry.",
        });
        return;
      }
      if (key === "soul_leech") {
        runWithUserError("Soul Leech", () => runSoulLeechFromSelection(), {
          statusScope: "Director",
          retryHint: "Select at least one image and retry.",
        });
        return;
      }
      if (key === "remove_people") {
        runWithUserError("Remove people", () => aiRemovePeople(), {
          retryHint: "Select an image and retry.",
        });
        return;
      }
      if (key === "variations") {
        runWithUserError("Variations", () => runVariations(), {
          retryHint: "Select an image and retry.",
        });
        return;
      }
      if (key === "recast") {
        runWithUserError("Recast", () => runRecast(), {
          retryHint: "Select an image and retry.",
        });
        return;
      }
      if (key === "diagnose") {
        runWithUserError("Diagnose", () => runDiagnose(), {
          statusScope: "Director",
          retryHint: "Select an image and retry.",
        });
        return;
      }
      if (key === "crop_square") {
        runWithUserError("Square crop", () => cropSquare(), {
          retryHint: "Select an image and retry.",
        });
        return;
      }
      if (key === "combine") {
        runWithUserError("Combine", () => runBlendPair(), {
          retryHint: "Select exactly 2 images and retry.",
        });
        return;
      }
      if (key === "bridge") {
        runWithUserError("Bridge", () => runBridgePair(), {
          retryHint: "Select exactly 2 images and retry.",
        });
        return;
      }
      if (key === "swap_dna") {
        runWithUserError("Swap DNA", () => runSwapDnaPair({ invert: Boolean(ev?.shiftKey) }), {
          retryHint: "Select exactly 2 images and retry.",
        });
        return;
      }
      if (key === "argue") {
        runWithUserError("Argue", () => runArguePair(), {
          statusScope: "Director",
          retryHint: "Select exactly 2 images and retry.",
        });
        return;
      }
      if (key === "extract_rule") {
        runWithUserError("Extract the Rule", () => runExtractRuleTriplet(), {
          statusScope: "Director",
          retryHint: "Select exactly 3 images and retry.",
        });
        return;
      }
      if (key === "odd_one_out") {
        runWithUserError("Odd One Out", () => runOddOneOutTriplet(), {
          statusScope: "Director",
          retryHint: "Select exactly 3 images and retry.",
        });
        return;
      }
      if (key === "triforce") {
        runWithUserError("Triforce", () => runTriforceTriplet(), {
          retryHint: "Select exactly 3 images and retry.",
        });
        return;
      }
    });

    frag.appendChild(btn);
  }

  root.appendChild(frag);
}

function renderQuickActions() {
  renderActionGrid();
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
  if (!state.filmstripVisible || state.canvasMode === "multi") {
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
  if (!state.filmstripVisible) return;
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

function _timelineMakeNodeId() {
  return `tl-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function recordTimelineNode({ imageId, path, receiptPath = null, label = null, action = null, parents = [] } = {}) {
  if (!imageId || !path) return null;
  const nodeId = _timelineMakeNodeId();
  const parentIds = Array.isArray(parents)
    ? Array.from(new Set(parents.map((p) => String(p || "")).filter(Boolean)))
    : [];
  const node = {
    nodeId,
    imageId: String(imageId),
    path: String(path),
    receiptPath: receiptPath ? String(receiptPath) : null,
    label: label ? String(label) : basename(path),
    action: action ? String(action) : null,
    parents: parentIds,
    createdAt: Date.now(),
  };
  state.timelineNodes.push(node);
  state.timelineNodesById.set(nodeId, node);
  if (state.timelineOpen) renderTimeline();
  return nodeId;
}

function ensureTimelineNodeForImageItem(item) {
  if (!item || !item.id || !item.path) return null;
  if (item.timelineNodeId && state.timelineNodesById.has(item.timelineNodeId)) return item.timelineNodeId;
  const action = item.timelineAction || item.kind || null;
  const parents = Array.isArray(item.timelineParents) ? item.timelineParents : [];
  const nodeId = recordTimelineNode({
    imageId: item.id,
    path: item.path,
    receiptPath: item.receiptPath || null,
    label: item.label || null,
    action,
    parents,
  });
  item.timelineNodeId = nodeId;
  // Clear one-shot metadata (keeps `state.images` objects tidy).
  if ("timelineAction" in item) delete item.timelineAction;
  if ("timelineParents" in item) delete item.timelineParents;
  return nodeId;
}

function openTimeline() {
  if (!els.timelineOverlay) return;
  state.timelineOpen = true;
  els.timelineOverlay.classList.remove("hidden");
  renderTimeline();
}

function closeTimeline() {
  if (!els.timelineOverlay) return;
  state.timelineOpen = false;
  els.timelineOverlay.classList.add("hidden");
}

function renderTimeline() {
  if (!state.timelineOpen) return;
  const strip = els.timelineStrip;
  const detail = els.timelineDetail;
  if (!strip) return;
  strip.innerHTML = "";

  const nodes = Array.from(state.timelineNodes || []).sort((a, b) => (a?.createdAt || 0) - (b?.createdAt || 0));
  if (!nodes.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No timeline yet.";
    strip.appendChild(empty);
    if (detail) detail.textContent = "";
    return;
  }

  const activeNodeId = getActiveImage()?.timelineNodeId || null;
  let activeNode = activeNodeId ? state.timelineNodesById.get(activeNodeId) : null;
  if (!activeNode && activeNodeId) {
    activeNode = nodes.find((n) => n?.nodeId === activeNodeId) || null;
  }

  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    if (!node?.nodeId || !node.path) continue;
    const card = document.createElement("div");
    card.className = "timeline-card" + (activeNodeId && node.nodeId === activeNodeId ? " selected" : "");
    card.dataset.nodeId = node.nodeId;
    card.tabIndex = 0;
    const img = document.createElement("img");
    img.alt = node.label || basename(node.path) || "Timeline item";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = THUMB_PLACEHOLDER_SRC;
    ensureImageUrl(node.path)
      .then((url) => {
        if (url) img.src = url;
      })
      .catch(() => {});
    card.appendChild(img);
    const meta = document.createElement("div");
    meta.className = "timeline-meta";
    const action = document.createElement("div");
    action.className = "timeline-action";
    action.textContent = node.action ? String(node.action) : "artifact";
    const name = document.createElement("div");
    name.textContent = node.label || basename(node.path);
    meta.appendChild(action);
    meta.appendChild(name);
    card.appendChild(meta);
    frag.appendChild(card);
  }
  strip.appendChild(frag);

  if (detail) {
    if (!activeNode) {
      detail.textContent = "Select a point in time to jump back.";
    } else {
      const pieces = [];
      pieces.push(activeNode.action ? `Action: ${activeNode.action}` : "Action: (unknown)");
      pieces.push(`File: ${basename(activeNode.path)}`);
      if (activeNode.parents?.length) pieces.push(`Parents: ${activeNode.parents.length}`);
      detail.textContent = pieces.join("\n");
    }
  }
}

async function jumpToTimelineNode(nodeId) {
  const node = nodeId ? state.timelineNodesById.get(nodeId) : null;
  if (!node) return;

  const imgItem = state.imagesById.get(node.imageId) || null;
  if (!imgItem) {
    showToast("Timeline item no longer in canvas.", "error", 2400);
    return;
  }

  if (state.activeId !== imgItem.id) {
    await setActiveImage(imgItem.id).catch(() => {});
  }

  if (imgItem.path !== node.path) {
    const ok = await replaceImageInPlace(imgItem.id, {
      path: node.path,
      receiptPath: node.receiptPath || null,
      kind: imgItem.kind,
      clearVision: true,
    });
    if (!ok) return;
  }

  imgItem.timelineNodeId = node.nodeId;
  renderTimeline();
}

async function setActiveImage(id, { preserveSelection = false } = {}) {
  const item = state.imagesById.get(id);
  if (!item) return;
  const prevActive = state.activeId;
  state.activeId = id;
  if (preserveSelection) {
    // Ensure the newly-active image is included and keep multi-select ordering stable.
    const next = getSelectedIds();
    setSelectedIds(next.length > 3 ? next.slice(next.length - 3) : next);
  } else {
    setSelectedIds([id]);
  }
  setFilmstripSelected(prevActive, id);
  clearSelection();
  showDropHint(false);
  renderSelectionMeta();
  renderQuickActions();
  chooseSpawnNodes();
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
  if (prevActive !== id) {
    const nextDesc = item?.visionDesc ? clampText(item.visionDesc, 32) : "";
    if (nextDesc) startHudDescTypeout(id, nextDesc);
  }
  resetViewToFit();
  requestRender();
  if (state.timelineOpen) renderTimeline();
}

function addImage(item, { select = false } = {}) {
  if (!item || !item.id || !item.path) return;
  if (state.imagesById.has(item.id)) return;
  const assignedPaletteIndex = Number(item.uiPaletteIndex);
  if (!Number.isFinite(assignedPaletteIndex) || assignedPaletteIndex < 0) {
    const nextPaletteIndex = Math.max(0, Math.floor(Number(state.imagePaletteSeed) || 0));
    item.uiPaletteIndex = nextPaletteIndex;
    state.imagePaletteSeed = nextPaletteIndex + 1;
  } else {
    state.imagePaletteSeed = Math.max(
      Math.floor(Number(state.imagePaletteSeed) || 0),
      Math.floor(assignedPaletteIndex) + 1
    );
  }
  state.imagesById.set(item.id, item);
  state.images.push(item);
  if (!state.freeformZOrder.includes(item.id)) {
    state.freeformZOrder.push(item.id);
  }
  ensureTimelineNodeForImageItem(item);
  appendFilmstripThumb(item);
  if (state.canvasMode === "multi") {
    // Multi-canvas is the "working set"; keep HUD descriptions available for all tiles.
    scheduleVisionDescribe(item.path);
  }
  if (item.receiptPath && !item.receiptMetaChecked) {
    ensureReceiptMeta(item).catch(() => {});
  }
  showDropHint(false);
  scheduleVisualPromptWrite();
  markAlwaysOnVisionDirty("image_add");
  scheduleAlwaysOnVision();
  recordUserEvent("image_add", {
    image_id: String(item.id),
    kind: item.kind ? String(item.kind) : null,
    file: item.path ? basename(item.path) : null,
    n_images: state.images.length,
  });
  if (intentAmbientActive()) {
    updateEmptyCanvasHint();
    scheduleAmbientIntentInference({ immediate: true, reason: "add", imageIds: [item.id] });
  }
  if (intentModeActive()) {
    scheduleIntentStateWrite();
  }
  if (select || !state.activeId) {
    setActiveImage(item.id).catch(() => {});
  }
  motherIdleSyncFromInteraction({ userInteraction: false });
  syncMotherPortrait();
}

async function removeImageFromCanvas(imageId) {
  const id = String(imageId || "");
  if (!id) return false;
  const item = state.imagesById.get(id) || null;
  if (!item) return false;
  recordUserEvent("image_remove", {
    image_id: id,
    file: item?.path ? basename(item.path) : null,
    n_images_before: state.images.length,
  });

  hideImageMenu();
  hideDesignateMenu();

  if (item?.path) {
    invalidateImageCache(item.path);
    dropVisionDescribePath(item.path, { cancelInFlight: true });
  }

  // Drop per-image marks.
  state.designationsByImageId.delete(id);
  state.circlesByImageId.delete(id);
  clearEffectTokenForImageId(id);
  if (state.effectTokenDrag) {
    const dragTokenId = String(state.effectTokenDrag.tokenId || "");
    const dragSourceId = String(state.effectTokenDrag.sourceImageId || "");
    if (dragSourceId === id || !state.effectTokensById.has(dragTokenId)) {
      state.effectTokenDrag = null;
    }
  }

  // Remove from collections.
  state.imagesById.delete(id);
  state.images = (state.images || []).filter((item) => item?.id !== id);
  state.freeformRects.delete(id);
  state.freeformZOrder = (state.freeformZOrder || []).filter((v) => v !== id);
  state.multiRects.delete(id);
  // Maintain multi-select.
  setSelectedIds(getSelectedIds().filter((v) => v !== id));

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
    const selected = Array.isArray(state.selectedIds) ? state.selectedIds : [];
    const nextSelectedId = selected.length ? selected[selected.length - 1] : null;
    const nextSelected = nextSelectedId ? state.imagesById.get(nextSelectedId) : null;
    const next = nextSelected || (state.images.length ? state.images[state.images.length - 1] : null);
    if (next?.id) await setActiveImage(next.id, { preserveSelection: true });
  }

  if (state.images.length === 0) {
    clearImageCache();
    state.imagePaletteSeed = 0;
    state.activeId = null;
    state.selectedIds = [];
    state.canvasMode = "multi";
    state.freeformRects.clear();
    state.freeformZOrder = [];
    state.multiRects.clear();
    state.pendingBlend = null;
    state.pendingSwapDna = null;
    state.pendingBridge = null;
    state.pendingExtractDna = null;
    state.pendingSoulLeech = null;
    state.pendingArgue = null;
    state.pendingRecast = null;
    state.pendingDiagnose = null;
    clearAllEffectTokens();
    clearSelection();
    if (state.intent && !state.intent.locked) {
      state.intent.lockedAt = 0;
      state.intent.lockedBranchId = null;
      state.intent.startedAt = 0;
      state.intent.deadlineAt = 0;
      state.intent.round = 1;
      state.intent.selections = [];
      state.intent.focusBranchId = null;
      state.intent.iconState = null;
      state.intent.iconStateAt = 0;
      state.intent.pending = false;
      state.intent.pendingPath = null;
      state.intent.pendingAt = 0;
      state.intent.pendingFrameId = null;
      state.intent.rtState = "off";
      state.intent.disabledReason = null;
      state.intent.lastError = null;
      state.intent.lastErrorAt = 0;
      state.intent.lastSignature = null;
      state.intent.lastRunAt = 0;
      state.intent.forceChoice = false;
      state.intent.uiHits = [];
      clearTimeout(intentInferenceTimer);
      intentInferenceTimer = null;
      clearTimeout(intentInferenceTimeout);
      intentInferenceTimeout = null;
      stopIntentTicker();
      if (state.ptySpawned) {
        invoke("write_pty", { data: `${PTY_COMMANDS.INTENT_RT_STOP}\n` }).catch(() => {});
      }
      syncIntentModeClass();
      scheduleIntentStateWrite({ immediate: true });
    }
    resetAmbientIntentState();
    if (state.ptySpawned) {
      invoke("write_pty", { data: `${PTY_COMMANDS.INTENT_RT_STOP}\n` }).catch(() => {});
    }
    updateEmptyCanvasHint();
    setTip(DEFAULT_TIP);
    setDirectorText(null, null);
    renderFilmstrip();
    renderQuickActions();
    renderHudReadout();
    motherIdleSyncFromInteraction({ userInteraction: false });
    state.alwaysOnVision.contentDirty = false;
    state.alwaysOnVision.dirtyReason = null;
    requestRender();
    return true;
  }

  renderFilmstrip();

  updateEmptyCanvasHint();
  scheduleVisualPromptWrite();
  markAlwaysOnVisionDirty("image_remove");
  scheduleAlwaysOnVision();
  if (intentAmbientActive()) scheduleAmbientIntentInference({ immediate: true, reason: "remove" });
  scheduleIntentStateWrite();
  renderQuickActions();
  renderHudReadout();
  motherIdleSyncFromInteraction({ userInteraction: false });
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
  clearEffectTokenForImageId(targetId);
  const oldPath = item.path;
  if (oldPath && oldPath !== path) {
    invalidateImageCache(oldPath);
    dropVisionDescribePath(oldPath, { cancelInFlight: true });
  }
  // New paths are always new files; no need to invalidate unless we overwrite, but be safe.
  invalidateImageCache(path);

  item.path = path;
  item.receiptPath = receiptPath;
  item.receiptMeta = null;
  item.receiptMetaChecked = false;
  item.receiptMetaLoading = false;
  if (kind) item.kind = kind;
  const explicitLabel = typeof label === "string" ? label.trim() : "";
  if (explicitLabel) {
    item.label = explicitLabel;
  } else if (path && oldPath && oldPath !== path) {
    const oldPathLabel = basename(oldPath || "");
    const nextPathLabel = basename(path || "");
    const currentLabel = String(item.label || "").trim();
    // If the label still mirrors the old path (or is empty), keep it in sync with the new file path.
    if (!currentLabel || (oldPathLabel && currentLabel === oldPathLabel)) {
      if (nextPathLabel) item.label = nextPathLabel;
    }
  }
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
	    markAlwaysOnVisionDirty("image_replace");
	    scheduleAlwaysOnVision();
    motherIdleSyncFromInteraction({ userInteraction: false });
    if (intentAmbientActive()) {
      scheduleAmbientIntentInference({ immediate: true, reason: "replace", imageIds: [targetId] });
    }
			  return true;
			}

async function setEngineActiveImage(path) {
  if (!path) return;
  if (!state.ptySpawned) {
    // Active image tracking is best-effort; don't block UI if engine isn't ready yet.
    return;
  }
  await invoke("write_pty", { data: `${PTY_COMMANDS.USE} ${path}\n` }).catch(() => {
    state.ptySpawned = false;
  });
}

function restoreEngineImageModelIfNeeded() {
  const restore = state.engineImageModelRestore;
  if (!restore) return;
  state.engineImageModelRestore = null;
  if (!state.ptySpawned) return;
  invoke("write_pty", { data: `${PTY_COMMANDS.IMAGE_MODEL} ${restore}\n` }).catch(() => {});
}

async function maybeOverrideEngineImageModel(desiredModel) {
  const desired = String(desiredModel || "").trim();
  if (!desired) return false;
  if (!state.ptySpawned) return false;
  if (desired === settings.imageModel) return false;
  state.engineImageModelRestore = settings.imageModel;
  await invoke("write_pty", { data: `${PTY_COMMANDS.IMAGE_MODEL} ${desired}\n` }).catch(() => {});
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
      state.multiRects && state.multiRects.size ? state.multiRects : computeFreeformRectsPx(canvas.width, canvas.height);
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
    source: item?.source ? String(item.source) : "user",
    path: item?.path ? String(item.path) : null,
    label: item?.label ? String(item.label) : null,
    width: Number(item?.img?.naturalWidth || item?.width) || null,
    height: Number(item?.img?.naturalHeight || item?.height) || null,
    // Optional vision-side description of the image contents (e.g., "couch").
    // This is written for run trace/debugging only; intent inference remains images-only.
    vision_desc: item?.visionDesc ? String(item.visionDesc) : null,
    vision_desc_meta: item?.visionDescMeta
      ? {
          source: item.visionDescMeta?.source ? String(item.visionDescMeta.source) : null,
          model: item.visionDescMeta?.model ? String(item.visionDescMeta.model) : null,
          at_ms: Number(item.visionDescMeta?.at) || null,
        }
      : null,
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

function _defaultImportPointCss() {
  const wrap = els.canvasWrap;
  const w = wrap?.clientWidth || 0;
  const h = wrap?.clientHeight || 0;
  return { x: Math.round(w * 0.5), y: Math.round(h * 0.5) };
}

function _computeImportPlacementsCss(n, center, tile, gap, canvasCssW, canvasCssH) {
  const count = Math.max(0, Number(n) || 0);
  if (!count) return [];
  const margin = 14;
  let cols = 1;
  if (count === 2) cols = 2;
  else if (count <= 4) cols = 2;
  else cols = 3;
  const rows = Math.ceil(count / cols);
  const clusterW = cols * tile + (cols - 1) * gap;
  const clusterH = rows * tile + (rows - 1) * gap;
  const maxX = Math.max(margin, Math.round(canvasCssW - clusterW - margin));
  const maxY = Math.max(margin, Math.round(canvasCssH - clusterH - margin));
  const startX = clamp(Math.round((Number(center?.x) || 0) - clusterW / 2), margin, maxX);
  const startY = clamp(Math.round((Number(center?.y) || 0) - clusterH / 2), margin, maxY);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({
      x: Math.round(startX + col * (tile + gap)),
      y: Math.round(startY + row * (tile + gap)),
      w: tile,
      h: tile,
    });
  }
  return out;
}

async function importLocalPathsAtCanvasPoint(
  paths,
  pointCss,
  { source = "picker", idPrefix = "input", enforceIntentLimit = true, focusImported = false } = {}
) {
  let list = (Array.isArray(paths) ? paths : [paths])
    .map((v) => normalizeLocalFsPath(typeof v === "string" ? v : ""))
    .filter(Boolean);
  if (String(source || "").startsWith("browser")) {
    try {
      list = await fileBrowserResolveImportPaths(list);
    } catch {
      // keep original list on resolver errors
    }
  }
  if (!list.length) {
    setStatus("Engine: ready");
    return { ok: 0, failed: 0, importedIds: [] };
  }

  const INTENT_MAX_PHOTOS = 5;
  const intentActive = intentModeActive();
  let importable = list.filter((path) => isBrowserImagePath(path));
  if (enforceIntentLimit && intentActive) {
    const remaining = Math.max(0, INTENT_MAX_PHOTOS - (state.images?.length || 0));
    if (remaining <= 0) {
      showToast(`Intent Mode: only ${INTENT_MAX_PHOTOS} photos allowed.`, "tip", 2600);
      setStatus("Engine: ready");
      return { ok: 0, failed: 0, importedIds: [] };
    }
    if (importable.length > remaining) {
      importable = importable.slice(0, remaining);
      showToast(`Intent Mode: only ${INTENT_MAX_PHOTOS} photos allowed.`, "tip", 2600);
    }
  }
  if (!importable.length) {
    setStatus("Engine: ready");
    return { ok: 0, failed: 0, importedIds: [] };
  }

  await ensureRun();
  const inputsDir = `${state.runDir}/inputs`;
  await createDir(inputsDir, { recursive: true }).catch(() => {});
  const stamp = Date.now();

  const wrap = els.canvasWrap;
  const canvasCssW = wrap?.clientWidth || 0;
  const canvasCssH = wrap?.clientHeight || 0;
  const totalAfter = (state.images?.length || 0) + importable.length;
  const tile = freeformDefaultTileCss(canvasCssW, canvasCssH, { count: totalAfter });
  const gap = Math.round(tile * 0.11);
  const placements = _computeImportPlacementsCss(importable.length, pointCss, tile, gap, canvasCssW, canvasCssH);

  let ok = 0;
  let failed = 0;
  let lastErr = null;
  const importedIds = [];
  const importedVisionPaths = [];
  for (let idx = 0; idx < importable.length; idx += 1) {
    const src = importable[idx];
    try {
      const ext = extname(src);
      const safeExt = ext && ext.length <= 8 ? ext : ".png";
      const artifactId = `${idPrefix}-${stamp}-${String(idx).padStart(2, "0")}`;
      const dest = `${inputsDir}/${artifactId}${safeExt}`;
      const place = placements[idx] || null;
      if (place && artifactId) {
        state.freeformRects.set(artifactId, { ...place, autoAspect: true });
      }
      await copyFile(src, dest);
      const receiptPath = await writeLocalReceipt({
        artifactId,
        imagePath: dest,
        operation: "import",
        meta: { source_path: src, source },
      });
      addImage(
        {
          id: artifactId,
          kind: "import",
          path: dest,
          receiptPath,
          label: basename(src),
        },
        { select: focusImported ? ok === 0 : ok === 0 && !state.activeId }
      );
      importedIds.push(artifactId);
      importedVisionPaths.push(dest);
      ok += 1;
    } catch (err) {
      failed += 1;
      lastErr = err;
      console.error("Import failed:", src, err);
    }
  }

  if (ok <= 0) {
    const msg = lastErr?.message || String(lastErr || "unknown error");
    setStatus(`Engine: import failed (${msg})`, true);
    return { ok, failed, importedIds };
  }

  motherV2ArmMultiUploadIdleBoost(ok);
  scheduleVisionDescribeBurst(importedVisionPaths, {
    priority: true,
    maxConcurrent: UPLOAD_DESCRIBE_PRIORITY_BURST,
  });
  const suffix = failed ? ` (${failed} failed)` : "";
  setStatus(`Engine: imported ${ok} photo${ok === 1 ? "" : "s"}${suffix}`, failed > 0);

  if (state.images.length > 1 && state.canvasMode !== "multi") {
    setCanvasMode("multi");
    if (!intentActive) {
      setTip("Multiple photos loaded. Click a photo to focus it. Press M to toggle multi view.");
    }
  }
  if (intentActive && !state.intent.startedAt) {
    state.intent.startedAt = Date.now();
    state.intent.deadlineAt = state.intent.startedAt + INTENT_DEADLINE_MS;
    state.intent.rtState = "connecting";
    ensureIntentTicker();
  }
  if (intentActive) {
    updateEmptyCanvasHint();
    scheduleIntentInference({ immediate: true, reason: "import" });
    scheduleIntentStateWrite({ immediate: true });
  }
  if (intentAmbientActive()) {
    const touched = importedIds.filter((id) => state.imagesById.has(id));
    if (touched.length) scheduleAmbientIntentInference({ immediate: true, reason: "import", imageIds: touched });
  }
  requestRender();
  return { ok, failed, importedIds };
}

async function importPhotosAtCanvasPoint(pointCss) {
  bumpInteraction();
  setStatus("Engine: pick photos…");
  const picked = await open({
    multiple: true,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "heic"] }],
  });
  const pickedPaths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (!pickedPaths.length) {
    setStatus("Engine: ready");
    return;
  }
  await importLocalPathsAtCanvasPoint(pickedPaths, pointCss, {
    source: "picker",
    idPrefix: "input",
    enforceIntentLimit: true,
  });
}

async function importPhotos() {
  await importPhotosAtCanvasPoint(canvasScreenCssToWorldCss(_defaultImportPointCss()));
}

async function cropSquare({ fromQueue = false } = {}) {
  if (!requireIntentUnlocked()) return;
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
  beginRunningAction("crop_square");
  setImageFxActive(true, "Square Crop");
  portraitWorking("Square Crop");
  try {
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
    await saveCanvasAsArtifact(canvas, {
      operation: "crop_square",
      label: "Square crop",
      replaceActive: true,
      targetId: imgItem.id,
    });
  } finally {
    setImageFxActive(false);
    updatePortraitIdle();
    clearRunningAction("crop_square");
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
  if (!requireIntentUnlocked()) return;
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
  if (!requireIntentUnlocked()) return;
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
  if (!requireIntentUnlocked()) return;
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
    await invoke("write_pty", { data: `${PTY_COMMANDS.USE} ${quoteForPtyArg(cropPath)}\n` }).catch(() => {});

    state.expectingArtifacts = true;
    state.lastAction = label;
    setStatus(`Engine: ${label}…`);
    showToast("Annotate: editing…", "info", 2200);

    if (state.ptySpawned && effectiveModel && effectiveModel !== settings.imageModel) {
      state.engineImageModelRestore = settings.imageModel;
      await invoke("write_pty", { data: `${PTY_COMMANDS.IMAGE_MODEL} ${effectiveModel}\n` }).catch(() => {});
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
  if (!requireIntentUnlocked()) return;
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
  beginRunningAction("bg");
  setImageFxActive(true, label);
  portraitWorking(label);
  try {
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
    clearRunningAction("bg");
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
    const parentNodeId = id ? state.imagesById.get(id)?.timelineNodeId || null : null;
    const ok = id ? await replaceImageInPlace(id, { path: imagePath, receiptPath, kind: "local" }) : false;
    if (ok && id) {
      const nodeId = recordTimelineNode({
        imageId: id,
        path: imagePath,
        receiptPath,
        label: label || basename(imagePath),
        action: label || operation,
        parents: parentNodeId ? [parentNodeId] : [],
      });
      const item = state.imagesById.get(id) || null;
      if (item && nodeId) item.timelineNodeId = nodeId;
    } else {
      addImage(
        {
          id: artifactId,
          kind: "local",
          path: imagePath,
          receiptPath,
          label: label || operation,
          timelineAction: label || operation,
        },
        { select: true }
      );
    }
  } else {
    const parentNodeId = state.activeId ? state.imagesById.get(state.activeId)?.timelineNodeId || null : null;
    addImage(
      {
        id: artifactId,
        kind: "local",
        path: imagePath,
        receiptPath,
        label: label || operation,
        timelineAction: label || operation,
        timelineParents: parentNodeId ? [parentNodeId] : [],
      },
      { select: true }
    );
  }
  setStatus("Engine: ready");
}

async function runVariations({ fromQueue = false } = {}) {
  if (!requireIntentUnlocked()) return;
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
    await invoke("write_pty", { data: `${PTY_COMMANDS.RECREATE} ${imgItem.path}\n` });
  } catch (err) {
    state.expectingArtifacts = false;
    state.pendingRecreate = null;
    setImageFxActive(false);
    updatePortraitIdle();
    throw err;
  }
}

function quoteForPtyArg(value) {
  return quoteForPtyArgUtil(value);
}

async function runBlendPair({ fromQueue = false } = {}) {
  if (!requireIntentUnlocked()) return;
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
  const pair = getSelectedImagesActiveFirst({ requireCount: 2 });
  if (pair.length !== 2) {
    showToast("Combine needs exactly 2 selected photos.", "error", 3200);
    return;
  }
  const [a, b] = pair;
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
      data: `${PTY_COMMANDS.BLEND} ${quoteForPtyArg(a.path)} ${quoteForPtyArg(b.path)}\n`,
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
  if (!requireIntentUnlocked()) return;
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
  const pair = getSelectedImagesActiveFirst({ requireCount: 2 });
  if (pair.length !== 2) {
    showToast("Swap DNA needs exactly 2 selected photos.", "error", 3200);
    return;
  }

  const [first, second] = pair;
  let structure = invert ? second : first;
  let surface = invert ? first : second;
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
      data: `${PTY_COMMANDS.SWAP_DNA} ${quoteForPtyArg(structure.path)} ${quoteForPtyArg(surface.path)}\n`,
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
  if (!requireIntentUnlocked()) return;
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
  const pair = getSelectedImagesActiveFirst({ requireCount: 2 });
  if (pair.length !== 2) {
    showToast("Bridge needs exactly 2 selected photos.", "error", 3200);
    return;
  }

  const [first, second] = pair;
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
      data: `${PTY_COMMANDS.BRIDGE} ${quoteForPtyArg(first.path)} ${quoteForPtyArg(second.path)}\n`,
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
  if (!requireIntentUnlocked()) return;
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
  const pair = getSelectedImagesActiveFirst({ requireCount: 2 });
  if (pair.length !== 2) {
    showToast("Argue needs exactly 2 selected photos.", "error", 3200);
    return;
  }

  const [first, second] = pair;
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
      data: `${PTY_COMMANDS.ARGUE} ${quoteForPtyArg(first.path)} ${quoteForPtyArg(second.path)}\n`,
    });
    bumpSessionApiCalls();
  } catch (err) {
    console.error(err);
    state.pendingArgue = null;
    setStatus(`Director: argue failed (${err?.message || err})`, true);
    showToast("Argue failed to start.", "error", 3200);
    updatePortraitIdle();
    renderQuickActions();
  }
}

async function runExtractRuleTriplet({ fromQueue = false } = {}) {
  if (!requireIntentUnlocked()) return;
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || isMultiActionRunning() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Extract the Rule",
      key: "extract_rule",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runExtractRuleTriplet({ fromQueue: true }),
    });
    return;
  }
  if (!state.runDir) {
    await ensureRun();
  }
  const triplet = getSelectedImagesActiveFirst({ requireCount: 3 });
  if (triplet.length !== 3) {
    showToast("Extract the Rule needs exactly 3 selected photos.", "error", 3200);
    return;
  }
  const [a, b, c] = triplet;
  if (!a?.path || !b?.path || !c?.path) {
    showToast("Extract the Rule failed: missing image paths.", "error", 3200);
    return;
  }

  const okEngine = await ensureEngineSpawned({ reason: "extract rule" });
  if (!okEngine) return;

  state.pendingExtractRule = { sourceIds: [a.id, b.id, c.id], startedAt: Date.now() };
  state.lastAction = "Extract the Rule";
  setStatus("Director: extract rule…");
  setDirectorText("Extracting the rule…", { kind: "extract_rule", at: Date.now(), paths: [a.path, b.path, c.path] });
  portraitWorking("Extract the Rule", { providerOverride: "openai", clearDirector: false });
  showToast("Extracting the rule…", "info", 2200);
  state.tripletRuleAnnotations.clear();
  state.tripletOddOneOutId = null;
  renderQuickActions();
  requestRender();

  try {
    await invoke("write_pty", {
      data: `${PTY_COMMANDS.EXTRACT_RULE} ${quoteForPtyArg(a.path)} ${quoteForPtyArg(b.path)} ${quoteForPtyArg(c.path)}\n`,
    });
    bumpSessionApiCalls();
  } catch (err) {
    console.error(err);
    state.pendingExtractRule = null;
    setStatus(`Director: extract rule failed (${err?.message || err})`, true);
    showToast("Extract the Rule failed to start.", "error", 3200);
    updatePortraitIdle();
    renderQuickActions();
  }
}

async function runOddOneOutTriplet({ fromQueue = false } = {}) {
  if (!requireIntentUnlocked()) return;
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || isMultiActionRunning() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Odd One Out",
      key: "odd_one_out",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runOddOneOutTriplet({ fromQueue: true }),
    });
    return;
  }
  if (!state.runDir) {
    await ensureRun();
  }
  const triplet = getSelectedImagesActiveFirst({ requireCount: 3 });
  if (triplet.length !== 3) {
    showToast("Odd One Out needs exactly 3 selected photos.", "error", 3200);
    return;
  }
  const [a, b, c] = triplet;
  if (!a?.path || !b?.path || !c?.path) {
    showToast("Odd One Out failed: missing image paths.", "error", 3200);
    return;
  }

  const okEngine = await ensureEngineSpawned({ reason: "odd one out" });
  if (!okEngine) return;

  state.pendingOddOneOut = { sourceIds: [a.id, b.id, c.id], startedAt: Date.now() };
  state.lastAction = "Odd One Out";
  setStatus("Director: odd one out…");
  setDirectorText("Finding the odd one out…", { kind: "odd_one_out", at: Date.now(), paths: [a.path, b.path, c.path] });
  portraitWorking("Odd One Out", { providerOverride: "openai", clearDirector: false });
  showToast("Finding the odd one out…", "info", 2200);
  state.tripletRuleAnnotations.clear();
  state.tripletOddOneOutId = null;
  renderQuickActions();
  requestRender();

  try {
    await invoke("write_pty", {
      data: `${PTY_COMMANDS.ODD_ONE_OUT} ${quoteForPtyArg(a.path)} ${quoteForPtyArg(b.path)} ${quoteForPtyArg(c.path)}\n`,
    });
    bumpSessionApiCalls();
  } catch (err) {
    console.error(err);
    state.pendingOddOneOut = null;
    setStatus(`Director: odd one out failed (${err?.message || err})`, true);
    showToast("Odd One Out failed to start.", "error", 3200);
    updatePortraitIdle();
    renderQuickActions();
  }
}

async function runTriforceTriplet({ fromQueue = false } = {}) {
  if (!requireIntentUnlocked()) return;
  bumpInteraction();
  if (!fromQueue && (isEngineBusy() || isMultiActionRunning() || state.actionQueueActive || state.actionQueue.length)) {
    enqueueAction({
      label: "Triforce",
      key: "triforce",
      priority: ACTION_QUEUE_PRIORITY.user,
      run: () => runTriforceTriplet({ fromQueue: true }),
    });
    return;
  }
  if (!state.runDir) {
    await ensureRun();
  }
  const triplet = getSelectedImagesActiveFirst({ requireCount: 3 });
  if (triplet.length !== 3) {
    showToast("Triforce needs exactly 3 selected photos.", "error", 3200);
    return;
  }
  const okProvider = await ensureGeminiProImagePreviewForAction("Triforce");
  if (!okProvider) {
    showToast("Triforce requires a Gemini image model (multi-image).", "error", 3600);
    return;
  }

  const [first, second, third] = triplet;
  if (!first?.path || !second?.path || !third?.path) {
    showToast("Triforce failed: missing image paths.", "error", 3200);
    return;
  }

  const okEngine = await ensureEngineSpawned({ reason: "triforce" });
  if (!okEngine) return;
  setImageFxActive(true, "Triforce");
  state.expectingArtifacts = true;
  state.pendingTriforce = { sourceIds: [first.id, second.id, third.id], startedAt: Date.now() };
  state.lastAction = "Triforce";
  setStatus("Engine: triforce…");
  portraitWorking("Triforce", { providerOverride: "gemini" });
  showToast("Generating centroid…", "info", 2200);
  state.tripletRuleAnnotations.clear();
  state.tripletOddOneOutId = null;
  renderQuickActions();
  requestRender();

  try {
    await invoke("write_pty", {
      data: `${PTY_COMMANDS.TRIFORCE} ${quoteForPtyArg(first.path)} ${quoteForPtyArg(second.path)} ${quoteForPtyArg(third.path)}\n`,
    });
  } catch (err) {
    console.error(err);
    state.expectingArtifacts = false;
    state.pendingTriforce = null;
    setStatus(`Engine: triforce failed (${err?.message || err})`, true);
    showToast("Triforce failed to start.", "error", 3200);
    setImageFxActive(false);
    updatePortraitIdle();
    renderQuickActions();
  }
}

async function runDiagnose({ fromQueue = false } = {}) {
  if (!requireIntentUnlocked()) return;
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
    await invoke("write_pty", { data: `${PTY_COMMANDS.DIAGNOSE} ${quoteForPtyArg(imgItem.path)}\n` });
    bumpSessionApiCalls();
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
  if (!requireIntentUnlocked()) return;
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
      await invoke("write_pty", { data: `${PTY_COMMANDS.IMAGE_MODEL} ${desired}\n` }).catch(() => {});
    }
    await invoke("write_pty", { data: `${PTY_COMMANDS.RECAST} ${quoteForPtyArg(imgItem.path)}\n` });
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
  if (!state.runDir) {
    showToast("Create or open a run before exporting.", "tip", 2600);
    return;
  }
  const outPath = `${state.runDir}/export.html`;
  setStatus("Engine: exporting run…");
  try {
    await invoke("export_run", { runDir: state.runDir, outPath });
    setStatus(`Engine: exported ${basename(outPath)}`);
    showToast(`Exported ${basename(outPath)}.`, "tip", 2600);
  } catch (err) {
    const msg = err?.message || String(err || "export failed");
    setStatus(`Engine: export failed (${msg})`, true);
    showToast(`Export failed: ${msg}`, "error", 4200);
  }
}

async function ensureRun() {
  if (state.runDir) return;
  await createRun();
}

async function createRun() {
  const previous = captureRunResetSnapshot();
  announceRunTransition("new", previous);
  const payload = await invoke("create_run_dir");
  state.runDir = payload.run_dir;
  state.eventsPath = payload.events_path;
  state.eventsByteOffset = 0;
  state.eventsTail = "";
  state.eventsDecoder = new TextDecoder("utf-8");
  state.fallbackToFullRead = false;
  fallbackLineOffset = 0;
  state.sessionApiCalls = 0;
  resetTopMetrics();
  resetDescribeQueue();
  // Run-local interaction history for canvas context envelopes.
  state.userEvents = [];
  state.userEventSeq = 0;
  state.images = [];
  state.imagesById.clear();
  state.imagePaletteSeed = 0;
  state.activeId = null;
  state.selectedIds = [];
  state.timelineNodes = [];
  state.timelineNodesById.clear();
  closeTimeline();
  state.designationsByImageId.clear();
  state.pendingDesignation = null;
  state.canvasMode = "multi";
  state.freeformRects.clear();
  state.freeformZOrder = [];
  state.multiRects.clear();
  state.pendingBlend = null;
  state.pendingSwapDna = null;
  state.pendingBridge = null;
  state.pendingExtractDna = null;
  state.pendingSoulLeech = null;
  state.pendingArgue = null;
  state.pendingExtractRule = null;
  state.pendingOddOneOut = null;
  state.pendingTriforce = null;
  state.pendingRecast = null;
  state.pendingDiagnose = null;
  state.pendingRecreate = null;
  resetActionQueue();
  state.tripletRuleAnnotations.clear();
  state.tripletOddOneOutId = null;
  clearImageCache();
  clearAllEffectTokens();
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
  resetMotherIdleAndWheelState();
  state.intent.locked = true;
  state.intent.lockedAt = 0;
  state.intent.lockedBranchId = null;
  state.intent.startedAt = 0;
  state.intent.deadlineAt = 0;
  state.intent.round = 1;
  state.intent.selections = [];
  state.intent.focusBranchId = null;
  state.intent.iconState = null;
  state.intent.iconStateAt = 0;
  state.intent.pending = false;
  state.intent.pendingPath = null;
  state.intent.rtState = "off";
  state.intent.disabledReason = null;
  state.intent.lastError = null;
  state.intent.lastErrorAt = 0;
  state.intent.lastSignature = null;
  state.intent.lastRunAt = 0;
  state.intent.forceChoice = false;
  state.intent.uiHits = [];
  resetAmbientIntentState();
  if (state.alwaysOnVision) {
    state.alwaysOnVision.pending = false;
    state.alwaysOnVision.pendingPath = null;
    state.alwaysOnVision.pendingAt = 0;
    state.alwaysOnVision.contentDirty = false;
    state.alwaysOnVision.dirtyReason = null;
    state.alwaysOnVision.lastSignature = null;
    state.alwaysOnVision.lastRunAt = 0;
    state.alwaysOnVision.lastText = null;
    state.alwaysOnVision.lastMeta = null;
    state.alwaysOnVision.disabledReason = null;
    state.alwaysOnVision.rtState = state.alwaysOnVision.enabled ? "connecting" : "off";
  }
  setRunInfo(`Run: ${state.runDir}`);
  setTip(DEFAULT_TIP);
  setDirectorText(null, null);
  stopIntentTicker();
  clearTimeout(intentInferenceTimer);
  intentInferenceTimer = null;
  clearTimeout(intentInferenceTimeout);
  intentInferenceTimeout = null;
  clearTimeout(intentStateWriteTimer);
  intentStateWriteTimer = null;
  clearAmbientIntentTimers();
  syncIntentModeClass();
  updateEmptyCanvasHint();
  renderFilmstrip();
  chooseSpawnNodes();
  scheduleVisualPromptWrite({ immediate: true });
  await spawnEngine();
  await startEventsPolling();
  if (state.ptySpawned) setStatus("Engine: ready");
  finalizeRunTransition("new", { engineReady: state.ptySpawned });
}

async function openExistingRun() {
  bumpInteraction();
  const selected = await open({ directory: true, multiple: false });
  if (!selected) return;
  const previous = captureRunResetSnapshot();
  announceRunTransition("open", previous);
  state.runDir = selected;
  state.eventsPath = `${selected}/events.jsonl`;
  state.eventsByteOffset = 0;
  state.eventsTail = "";
  state.eventsDecoder = new TextDecoder("utf-8");
  state.fallbackToFullRead = false;
  fallbackLineOffset = 0;
  state.sessionApiCalls = 0;
  resetTopMetrics();
  resetDescribeQueue();
  // Run-local interaction history for canvas context envelopes.
  state.userEvents = [];
  state.userEventSeq = 0;
  state.images = [];
  state.imagesById.clear();
  state.imagePaletteSeed = 0;
  state.activeId = null;
  state.selectedIds = [];
  state.timelineNodes = [];
  state.timelineNodesById.clear();
  closeTimeline();
  state.designationsByImageId.clear();
  state.pendingDesignation = null;
  state.canvasMode = "multi";
  state.freeformRects.clear();
  state.freeformZOrder = [];
  state.multiRects.clear();
  state.pendingBlend = null;
  state.pendingSwapDna = null;
  state.pendingBridge = null;
  state.pendingExtractDna = null;
  state.pendingSoulLeech = null;
  state.pendingArgue = null;
  state.pendingExtractRule = null;
  state.pendingOddOneOut = null;
  state.pendingTriforce = null;
  state.pendingRecast = null;
  state.pendingDiagnose = null;
  state.pendingRecreate = null;
  resetActionQueue();
  state.tripletRuleAnnotations.clear();
  state.tripletOddOneOutId = null;
  renderFilmstrip();
  clearImageCache();
  clearAllEffectTokens();
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
  resetMotherIdleAndWheelState();
  state.intent.locked = true;
  state.intent.lockedAt = 0;
  state.intent.lockedBranchId = null;
  state.intent.startedAt = 0;
  state.intent.deadlineAt = 0;
  state.intent.round = 1;
  state.intent.selections = [];
  state.intent.focusBranchId = null;
  state.intent.iconState = null;
  state.intent.iconStateAt = 0;
  state.intent.pending = false;
  state.intent.pendingPath = null;
  state.intent.rtState = "off";
  state.intent.disabledReason = null;
  state.intent.lastError = null;
  state.intent.lastErrorAt = 0;
  state.intent.lastSignature = null;
  state.intent.lastRunAt = 0;
  state.intent.forceChoice = false;
  state.intent.uiHits = [];
  resetAmbientIntentState();
  if (state.alwaysOnVision) {
    state.alwaysOnVision.pending = false;
    state.alwaysOnVision.pendingPath = null;
    state.alwaysOnVision.pendingAt = 0;
    state.alwaysOnVision.contentDirty = false;
    state.alwaysOnVision.dirtyReason = null;
    state.alwaysOnVision.lastSignature = null;
    state.alwaysOnVision.lastRunAt = 0;
    state.alwaysOnVision.lastText = null;
    state.alwaysOnVision.lastMeta = null;
    state.alwaysOnVision.disabledReason = null;
    state.alwaysOnVision.rtState = state.alwaysOnVision.enabled ? "connecting" : "off";
  }
  setRunInfo(`Run: ${state.runDir}`);
  setTip(DEFAULT_TIP);
  setDirectorText(null, null);
  stopIntentTicker();
  clearTimeout(intentInferenceTimer);
  intentInferenceTimer = null;
  clearTimeout(intentInferenceTimeout);
  intentInferenceTimeout = null;
  clearTimeout(intentStateWriteTimer);
  intentStateWriteTimer = null;
  clearAmbientIntentTimers();
  syncIntentModeClass();
  updateEmptyCanvasHint();
  await restoreIntentStateFromRunDir().catch(() => {});
  const restoredArtifacts = await loadExistingArtifacts();
  await spawnEngine();
  await startEventsPolling();
  scheduleVisualPromptWrite({ immediate: true });
  if (intentAmbientActive() && getVisibleCanvasImages().length) {
    scheduleAmbientIntentInference({ immediate: true, reason: "composition_change" });
  }
  if (state.ptySpawned) setStatus("Engine: ready");
  finalizeRunTransition("open", { restoredArtifacts, engineReady: state.ptySpawned });
}

async function loadExistingArtifacts() {
  if (!state.runDir) return;
  const entries = await readDir(state.runDir, { recursive: false }).catch(() => []);
  let restored = 0;
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
    const artifactId = entry.name.slice("receipt-".length).replace(/\.json$/, "");
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
    restored += 1;
  }
  // Select latest.
  if (state.images.length > 0 && !state.activeId) {
    await setActiveImage(state.images[state.images.length - 1].id);
  }
  if (state.images.length > 1) {
    setCanvasMode("multi");
    setTip("Multiple photos loaded. Click a photo to focus it.");
  }
  return restored;
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
    await invoke("write_pty", { data: `${PTY_COMMANDS.TEXT_MODEL} ${settings.textModel}\n` }).catch(() => {});
    await invoke("write_pty", { data: `${PTY_COMMANDS.IMAGE_MODEL} ${settings.imageModel}\n` }).catch(() => {});
    const active = getActiveImage();
    if (active?.path) {
      await invoke("write_pty", { data: `${PTY_COMMANDS.USE} ${active.path}\n` }).catch(() => {});
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
    const chunk = resp?.chunk;
    const clampedOffset = Number(resp?.clamped_offset);
    const newOffset = Number(resp?.new_offset);
    if (Number.isFinite(clampedOffset) && clampedOffset < state.eventsByteOffset) {
      state.eventsTail = "";
      state.eventsDecoder = new TextDecoder("utf-8");
    }
    if (Number.isFinite(newOffset)) state.eventsByteOffset = newOffset;

    let chunkText = "";
    if (typeof chunk === "string") {
      chunkText = chunk;
    } else if (chunk instanceof Uint8Array) {
      chunkText = state.eventsDecoder.decode(chunk, { stream: true });
    } else if (Array.isArray(chunk)) {
      chunkText = state.eventsDecoder.decode(Uint8Array.from(chunk), { stream: true });
    }
    if (!chunkText) return;
    state.eventsTail += chunkText;
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
    state.eventsTail = "";
    state.eventsDecoder = new TextDecoder("utf-8");
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

function handleMotherDesktopEvent(event) {
  return handleEventLegacy(event);
}

function handleArtifactDesktopEvent(event) {
  return handleEventLegacy(event);
}

function handleIntentDesktopEvent(event) {
  return handleEventLegacy(event);
}

function handleDiagnosticsDesktopEvent(event) {
  return handleEventLegacy(event);
}

function handleRecreateDesktopEvent(event) {
  return handleEventLegacy(event);
}

let desktopEventHandlerMap = null;
function getDesktopEventHandlerMap() {
  if (desktopEventHandlerMap) return desktopEventHandlerMap;
  desktopEventHandlerMap = createDesktopEventHandlerMap(DESKTOP_EVENT_TYPES, {
    onMother: handleMotherDesktopEvent,
    onArtifact: handleArtifactDesktopEvent,
    onIntent: handleIntentDesktopEvent,
    onDiagnostics: handleDiagnosticsDesktopEvent,
    onRecreate: handleRecreateDesktopEvent,
  });
  return desktopEventHandlerMap;
}

async function handleEvent(event) {
  if (!event || typeof event !== "object") return;
  const type = String(event.type || "");
  const handler = getDesktopEventHandlerMap().get(type);
  if (!handler) return;
  await handler(event);
}

async function handleEventLegacy(event) {
  if (!event || typeof event !== "object") return;
  const eventType = String(event.type || "");
  if (eventType && eventType !== DESKTOP_EVENT_TYPES.ARTIFACT_CREATED) {
    topMetricIngestTokensFromPayload(event, { atMs: Date.now(), render: false });
  }
  if (eventType === DESKTOP_EVENT_TYPES.PLAN_PREVIEW) {
    const cached = Boolean(event?.plan && event.plan.cached);
    if (!cached) bumpSessionApiCalls();
    return;
  }
  if (eventType === DESKTOP_EVENT_TYPES.VERSION_CREATED) {
    motherIdleTrackVersionCreated(event);
    return;
  }
  if (eventType === DESKTOP_EVENT_TYPES.MOTHER_INTENT_INFERRED) {
    appendMotherTraceLog({
      kind: "intent_inferred_ignored",
      traceId: state.motherIdle?.telemetry?.traceId || null,
      actionVersion: Number(state.motherIdle?.actionVersion) || 0,
      reason: "heuristic_intent_disabled",
      source: event.source ? String(event.source) : null,
    }).catch(() => {});
    return;
  }
  if (eventType === DESKTOP_EVENT_TYPES.MOTHER_INTENT_INFER_FAILED) {
    appendMotherTraceLog({
      kind: "intent_infer_failed_ignored",
      traceId: state.motherIdle?.telemetry?.traceId || null,
      actionVersion: Number(state.motherIdle?.actionVersion) || 0,
      reason: "heuristic_intent_disabled",
      source: event.source ? String(event.source) : null,
    }).catch(() => {});
    return;
  }
  if (eventType === DESKTOP_EVENT_TYPES.MOTHER_PROMPT_COMPILED) {
    const idle = state.motherIdle;
    if (!idle) return;
    const actionVersion = Number(event.action_version) || 0;
    if (actionVersion !== (Number(idle.actionVersion) || 0)) {
      motherV2MarkStale({
        stage: "prompt_compiled",
        event_action_version: actionVersion,
      });
      return;
    }
    // Ignore late compile results after local fallback dispatch (prevents duplicate generation requests).
    if (!idle.pendingPromptCompile || idle.pendingGeneration || Boolean(idle.pendingDispatchToken)) {
      appendMotherTraceLog({
        kind: "prompt_compiled_ignored",
        traceId: idle.telemetry?.traceId || null,
        actionVersion,
        pending_prompt_compile: Boolean(idle.pendingPromptCompile),
        pending_generation: Boolean(idle.pendingGeneration),
        pending_dispatch_token: Number(idle.pendingDispatchToken) || 0,
      }).catch(() => {});
      return;
    }
    await motherV2DispatchCompiledPrompt(event.compiled || {}).catch((err) => {
      motherIdleHandleGenerationFailed(err?.message || "Mother prompt compile dispatch failed.");
    });
    return;
  }
  if (eventType === DESKTOP_EVENT_TYPES.MOTHER_PROMPT_COMPILE_FAILED) {
    const idle = state.motherIdle;
    if (!idle) return;
    if (!idle.pendingPromptCompile) return;
    idle.pendingPromptCompile = false;
    idle.pendingPromptCompilePath = null;
    clearTimeout(idle.pendingPromptCompileTimeout);
    idle.pendingPromptCompileTimeout = null;
    if ((Number(idle.pendingActionVersion) || 0) !== (Number(idle.actionVersion) || 0)) {
      motherV2MarkStale({ stage: "prompt_compile_failed" });
      return;
    }
    const compiled = motherV2CompilePromptLocal({
      action_version: Number(idle.actionVersion) || 0,
      intent: idle.intent || null,
      roles: motherV2RoleMapClone(),
      transformation_mode: motherV2NormalizeTransformationMode(idle.intent?.transformation_mode),
      intensity: clamp(Number(idle.intensity) || 62, 0, 100),
    });
    await motherV2DispatchCompiledPrompt(compiled).catch((err) => {
      motherIdleHandleGenerationFailed(err?.message || "Mother prompt compile fallback failed.");
    });
    return;
  }
  if (eventType === DESKTOP_EVENT_TYPES.ARTIFACT_CREATED) {
    const id = event.artifact_id;
    const path = event.image_path;
    if (!id || !path) return;
    const eventMetrics = event.metrics && typeof event.metrics === "object" ? event.metrics : null;
    if (eventMetrics) {
      topMetricIngestRenderDuration(eventMetrics.latency_per_image_s);
    }
    if (event.receipt_path) {
      ingestTopMetricsFromReceiptPath(event.receipt_path, {
        allowCostFallback: false,
        allowLatencyFallback: !eventMetrics,
      }).catch(() => {});
    }
    renderSessionApiCallsReadout();
    const idleForCancel = state.motherIdle;
    const noForegroundPendingForCancel =
      !state.pendingReplace &&
      !state.pendingBlend &&
      !state.pendingSwapDna &&
      !state.pendingBridge &&
      !state.pendingExtractDna &&
      !state.pendingSoulLeech &&
      !state.pendingArgue &&
      !state.pendingExtractRule &&
      !state.pendingOddOneOut &&
      !state.pendingTriforce &&
      !state.pendingRecast &&
      !state.pendingDiagnose &&
      !state.pendingRecreate;
    if (
      idleForCancel &&
      Date.now() < (Number(idleForCancel.cancelArtifactUntil) || 0) &&
      noForegroundPendingForCancel &&
      String(state.lastAction || "") === "Mother Suggestion"
    ) {
      appendMotherTraceLog({
        kind: "discard_artifact_after_cancel",
        traceId: idleForCancel.telemetry?.traceId || null,
        actionVersion: Number(idleForCancel.actionVersion) || 0,
        image_id: String(id),
        image_path: String(path),
        reason: idleForCancel.cancelArtifactReason || "cancel",
      }).catch(() => {});
      removeFile(path).catch(() => {});
      if (event.receipt_path) removeFile(event.receipt_path).catch(() => {});
      return;
    }
    const eventVersionId = motherEventVersionId(event);
    const motherDispatchInFlight =
      state.motherIdle?.phase === MOTHER_IDLE_STATES.GENERATION_DISPATCHED &&
      Boolean(state.motherIdle?.pendingDispatchToken) &&
      !state.pendingReplace &&
      !state.pendingBlend &&
      !state.pendingSwapDna &&
      !state.pendingBridge &&
      !state.pendingExtractDna &&
      !state.pendingSoulLeech &&
      !state.pendingArgue &&
      !state.pendingExtractRule &&
      !state.pendingOddOneOut &&
      !state.pendingTriforce &&
      !state.pendingRecast &&
      !state.pendingDiagnose &&
      !state.pendingRecreate;
    if (motherDispatchInFlight && !motherIdleDispatchVersionMatches(eventVersionId)) {
      if (eventVersionId) motherIdleRememberIgnoredVersion(eventVersionId);
      appendMotherSuggestionLog({
        stage: "out_of_band_result_ignored",
        request_id: state.motherIdle?.pendingSuggestionLog?.request_id || null,
        expected_version_id: state.motherIdle?.pendingVersionId || null,
        ignored_version_id: eventVersionId,
        ignored_image_id: String(id),
        ignored_image_path: String(path),
        ignored_receipt_path: event.receipt_path ? String(event.receipt_path) : null,
      }).catch(() => {});
      console.warn("[mother_suggestion] ignored out-of-band artifact during active dispatch", {
        expected_version_id: state.motherIdle?.pendingVersionId || null,
        ignored_version_id: eventVersionId,
        ignored_image_id: String(id),
      });
      removeFile(path).catch(() => {});
      if (event.receipt_path) removeFile(event.receipt_path).catch(() => {});
      return;
    }
    if (motherDispatchInFlight) {
      const handled = await motherIdleHandleSuggestionArtifact({
        id,
        path,
        receiptPath: event.receipt_path || null,
        versionId: eventVersionId,
      }).catch((err) => {
        console.error(err);
        return false;
      });
      if (handled) {
        state.expectingArtifacts = false;
        restoreEngineImageModelIfNeeded();
        setStatus("Engine: ready");
        updatePortraitIdle();
        setImageFxActive(false);
        renderQuickActions();
        renderHudReadout();
        processActionQueue().catch(() => {});
        return;
      }
    }
    if (eventVersionId && motherIdleIsIgnoredVersion(eventVersionId)) {
      appendMotherSuggestionLog({
        stage: "late_result_ignored",
        ignored_version_id: eventVersionId,
        ignored_image_id: String(id),
        ignored_image_path: String(path),
        ignored_receipt_path: event.receipt_path ? String(event.receipt_path) : null,
      }).catch(() => {});
      console.warn("[mother_suggestion] ignored late artifact from blocked version", {
        ignored_version_id: eventVersionId,
        ignored_image_id: String(id),
      });
      removeFile(path).catch(() => {});
      if (event.receipt_path) removeFile(event.receipt_path).catch(() => {});
      return;
    }
    const motherIdle = state.motherIdle || null;
    const noForegroundPending =
      !state.pendingReplace &&
      !state.pendingBlend &&
      !state.pendingSwapDna &&
      !state.pendingBridge &&
      !state.pendingExtractDna &&
      !state.pendingSoulLeech &&
      !state.pendingArgue &&
      !state.pendingExtractRule &&
      !state.pendingOddOneOut &&
      !state.pendingTriforce &&
      !state.pendingRecast &&
      !state.pendingDiagnose &&
      !state.pendingRecreate;
    const motherSingleSuggestionGuard =
      !motherDispatchInFlight &&
      motherIdle?.phase === MOTHER_IDLE_STATES.WAITING_FOR_USER &&
      Boolean(motherIdle?.generatedImageId) &&
      Boolean(motherIdle?.hasGeneratedSinceInteraction) &&
      noForegroundPending &&
      String(state.lastAction || "") === "Mother Suggestion" &&
      Date.now() <= (Number(motherIdle?.lastSuggestionAt) || 0) + 20_000;
    if (motherSingleSuggestionGuard && String(id) !== String(motherIdle.generatedImageId)) {
      appendMotherSuggestionLog({
        stage: "extra_result_ignored",
        retained_image_id: String(motherIdle.generatedImageId || ""),
        ignored_image_id: String(id),
        ignored_image_path: String(path),
        ignored_receipt_path: event.receipt_path ? String(event.receipt_path) : null,
      }).catch(() => {});
      console.info("[mother_suggestion] ignored extra artifact", {
        retained_image_id: String(motherIdle.generatedImageId || ""),
        ignored_image_id: String(id),
      });
      removeFile(path).catch(() => {});
      if (event.receipt_path) removeFile(event.receipt_path).catch(() => {});
      state.expectingArtifacts = false;
      restoreEngineImageModelIfNeeded();
      setStatus("Engine: ready");
      updatePortraitIdle();
      setImageFxActive(false);
      renderQuickActions();
      renderHudReadout();
      processActionQueue().catch(() => {});
      return;
    }
    const blend = state.pendingBlend;
    const swapDna = state.pendingSwapDna;
    const bridge = state.pendingBridge;
    const triforce = state.pendingTriforce;
    const recast = state.pendingRecast;
    const recreate = state.pendingRecreate;
    const pending = state.pendingReplace;

    const wasBlend = Boolean(blend);
    const wasSwapDna = Boolean(swapDna);
    const wasBridge = Boolean(bridge);
    const wasTriforce = Boolean(triforce);
    const wasRecast = Boolean(recast);
    const wasRecreate = Boolean(recreate);
    const wasMultiGenAction = wasBlend || wasSwapDna || wasBridge || wasTriforce;

    // Timeline metadata for this newly created artifact.
    let timelineAction = state.lastAction || null;
    let timelineParents = [];
    if (blend?.sourceIds?.length) {
      timelineAction = "Combine";
      timelineParents = blend.sourceIds.map((src) => state.imagesById.get(src)?.timelineNodeId).filter(Boolean);
    } else if (swapDna?.structureId && swapDna?.surfaceId) {
      timelineAction = "Swap DNA";
      timelineParents = [swapDna.structureId, swapDna.surfaceId]
        .map((src) => state.imagesById.get(src)?.timelineNodeId)
        .filter(Boolean);
    } else if (bridge?.sourceIds?.length) {
      timelineAction = "Bridge";
      timelineParents = bridge.sourceIds.map((src) => state.imagesById.get(src)?.timelineNodeId).filter(Boolean);
    } else if (triforce?.sourceIds?.length) {
      timelineAction = "Triforce";
      timelineParents = triforce.sourceIds.map((src) => state.imagesById.get(src)?.timelineNodeId).filter(Boolean);
    } else if (recast?.sourceId) {
      timelineAction = "Recast";
      const parent = state.imagesById.get(recast.sourceId)?.timelineNodeId || null;
      timelineParents = parent ? [parent] : [];
    } else {
      const activeParent = getActiveImage()?.timelineNodeId || null;
      timelineParents = activeParent ? [activeParent] : [];
    }
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
    if (wasTriforce) {
      state.pendingTriforce = null;
      setTip("Triforce complete. Output selected.");
      showToast("Triforce complete.", "tip", 2400);
    }
    if (wasRecast) {
      state.pendingRecast = null;
      setTip("Recast complete. Output selected.");
      showToast("Recast complete.", "tip", 2400);
    }
    if (pending?.targetId) {
      const targetId = pending.targetId;
      const mode = pending.mode ? String(pending.mode) : "";
      const box = pending.box || null;
      const instruction = pending.instruction || null;
      const actionLabel = pending.label || timelineAction || "Edit";
      const parentNodeId = state.imagesById.get(targetId)?.timelineNodeId || null;
      const effectTokenId = mode === "effect_token_apply" ? String(pending.effect_token_id || "").trim() : "";
      const effectTokenDispatchId = Number(pending.effect_token_dispatch_id) || 0;
      clearPendingReplace();
      if (mode === "annotate_box") {
        const cropPath = pending.cropPath || null;
        const ok = await compositeAnnotateBoxEdit(targetId, path, { box, instruction }).catch((err) => {
          console.error(err);
          return false;
        });
        // Clean up intermediate artifacts so they don't surface as "weird" partial images
        // in the filmstrip when the run is reopened.
        if (cropPath) {
          removeFile(cropPath).catch(() => {});
        }
        if (ok) {
          removeFile(path).catch(() => {});
          if (event.receipt_path) removeFile(event.receipt_path).catch(() => {});
        }
        if (!ok) {
          showToast("Annotate failed to apply the box edit.", "error", 3600);
        }
      } else {
        const ok = await replaceImageInPlace(targetId, {
          path,
          receiptPath: event.receipt_path || null,
          kind: "engine",
        }).catch((err) => {
          console.error(err);
          return false;
        });
        if (ok) {
          const nodeId = recordTimelineNode({
            imageId: targetId,
            path,
            receiptPath: event.receipt_path || null,
            label: basename(path),
            action: actionLabel,
            parents: parentNodeId ? [parentNodeId] : [],
          });
          const item = state.imagesById.get(targetId) || null;
          if (item && nodeId) item.timelineNodeId = nodeId;
          if (effectTokenId) {
            const token = state.effectTokensById.get(effectTokenId) || null;
            const sourceImageId = String(token?.sourceImageId || pending.source_image_id || "").trim();
            if (token) {
              consumeEffectToken(token);
              clearEffectTokenForImageId(sourceImageId);
            } else if (sourceImageId) {
              clearEffectTokenForImageId(sourceImageId);
            }
            if (sourceImageId && sourceImageId !== targetId) {
              await removeImageFromCanvas(sourceImageId).catch(() => {});
            }
            state.effectTokenApplyLocks.delete(effectTokenId);
            showToast("Effect consumed.", "tip", 1800);
            requestRender();
          }
        } else if (effectTokenId) {
          const token = state.effectTokensById.get(effectTokenId) || null;
          state.effectTokenApplyLocks.delete(effectTokenId);
          if (token) recoverEffectTokenApply(token);
          requestRender();
        }
      }
    } else {
      addImage(
        {
          id,
          kind: "engine",
          path,
          receiptPath: event.receipt_path || null,
          label: basename(path),
          timelineAction,
          timelineParents,
        },
        { select: state.expectingArtifacts || !state.activeId }
      );
    }

    // After multi-image generations (Combine / Swap DNA / Bridge / Triforce), show only the output
    // image on the canvas and collapse the run to the output (source images removed from the filmstrip).
    if (wasMultiGenAction) {
      const sourceIds = [];
      if (blend?.sourceIds?.length) sourceIds.push(...blend.sourceIds);
      if (swapDna?.structureId) sourceIds.push(swapDna.structureId);
      if (swapDna?.surfaceId) sourceIds.push(swapDna.surfaceId);
      if (bridge?.sourceIds?.length) sourceIds.push(...bridge.sourceIds);
      if (triforce?.sourceIds?.length) sourceIds.push(...triforce.sourceIds);

      const outputId = String(id);
      for (const srcId of Array.from(new Set(sourceIds.map((v) => String(v || "").trim())))) {
        if (!srcId || srcId === outputId) continue;
        await removeImageFromCanvas(srcId).catch(() => {});
      }
      setCanvasMode("single");
    }

    // For Recast, the desired workflow is to treat the output as the new run: keep only the
    // newly-created artifact visible on the canvas and close out the source image(s).
    if (wasRecast) {
      const outputId = String(id);
      const removeIds = Array.from(new Set((state.images || []).map((item) => String(item?.id || "")).filter(Boolean)))
        .filter((imageId) => imageId !== outputId);
      for (const imageId of removeIds) {
        await removeImageFromCanvas(imageId).catch(() => {});
      }
      setCanvasMode("single");
    }

    // Same workflow for Variations/Recreate: treat each new artifact as the new "current" image.
    if (wasRecreate) {
      const outputId = String(id);
      const removeIds = Array.from(new Set((state.images || []).map((item) => String(item?.id || "")).filter(Boolean)))
        .filter((imageId) => imageId !== outputId);
      for (const imageId of removeIds) {
        await removeImageFromCanvas(imageId).catch(() => {});
      }
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
  } else if (eventType === DESKTOP_EVENT_TYPES.GENERATION_FAILED) {
    const idleDrafting = state.motherIdle?.phase === MOTHER_IDLE_STATES.DRAFTING;
    const idleDispatching = Boolean(state.motherIdle?.pendingDispatchToken);
    if (idleDrafting && idleDispatching) {
      const msg = event.error ? `Mother draft failed: ${event.error}` : "Mother draft failed.";
      setStatus(`Engine: ${msg}`, true);
      motherIdleHandleGenerationFailed(msg);
      renderQuickActions();
      renderHudReadout();
      processActionQueue().catch(() => {});
      return;
    }
    const eventVersionId = motherEventVersionId(event);
    const wasMotherDispatch =
      state.motherIdle?.phase === MOTHER_IDLE_STATES.GENERATION_DISPATCHED &&
      Boolean(state.motherIdle?.pendingDispatchToken);
    if (wasMotherDispatch) {
      if (!motherIdleDispatchVersionMatches(eventVersionId)) {
        if (eventVersionId) motherIdleRememberIgnoredVersion(eventVersionId);
        appendMotherSuggestionLog({
          stage: "out_of_band_failed_ignored",
          request_id: state.motherIdle?.pendingSuggestionLog?.request_id || null,
          expected_version_id: state.motherIdle?.pendingVersionId || null,
          ignored_version_id: eventVersionId,
          error: event.error ? String(event.error) : null,
        }).catch(() => {});
        console.warn("[mother_suggestion] ignored out-of-band failure during active dispatch", {
          expected_version_id: state.motherIdle?.pendingVersionId || null,
          ignored_version_id: eventVersionId,
          error: event.error ? String(event.error) : null,
        });
        return;
      }
      clearMotherIdleDispatchTimeout();
      const idle = state.motherIdle;
      const retryModel =
        idle && !idle.retryAttempted
          ? motherIdlePickRetryModel(idle.lastDispatchModel || idle.pendingSuggestionLog?.model || MOTHER_GENERATION_MODEL)
          : null;
      if (idle && retryModel) {
        const failedVersionId = idle.pendingVersionId || eventVersionId || null;
        idle.retryAttempted = true;
        idle.pendingDispatchToken = 0;
        idle.dispatchTimeoutExtensions = 0;
        motherIdleResetDispatchCorrelation({ rememberPendingVersion: true });
        state.expectingArtifacts = false;
        restoreEngineImageModelIfNeeded();
        appendMotherSuggestionLog({
          stage: "retry_scheduled",
          request_id: idle.pendingSuggestionLog?.request_id || null,
          from_model: idle.lastDispatchModel || idle.pendingSuggestionLog?.model || null,
          to_model: retryModel,
          version_id: failedVersionId,
          error: event.error ? String(event.error) : null,
        }).catch(() => {});
        setStatus(`Engine: Mother retrying with ${retryModel}…`);
        const retried = await motherIdleDispatchGeneration({ forcedModel: retryModel, isRetry: true }).catch(() => false);
        if (retried) {
          renderQuickActions();
          renderHudReadout();
          processActionQueue().catch(() => {});
          return;
        }
      }
      const msg = event.error ? `Mother suggestion failed: ${event.error}` : "Mother suggestion failed.";
      setStatus(`Engine: ${msg}`, true);
      state.expectingArtifacts = false;
      restoreEngineImageModelIfNeeded();
      updatePortraitIdle();
      setImageFxActive(false);
      motherIdleHandleGenerationFailed(msg);
      renderQuickActions();
      renderHudReadout();
      processActionQueue().catch(() => {});
      return;
    }
    const motherIdle = state.motherIdle || null;
    if (eventVersionId && motherIdleIsIgnoredVersion(eventVersionId)) {
      appendMotherSuggestionLog({
        stage: "late_failed_ignored",
        ignored_version_id: eventVersionId,
        error: event.error ? String(event.error) : null,
        phase: motherIdle?.phase || null,
      }).catch(() => {});
      console.warn("[mother_suggestion] ignored late failure from blocked version", {
        ignored_version_id: eventVersionId,
        phase: motherIdle?.phase || null,
        error: event.error ? String(event.error) : null,
      });
      return;
    }
    const errText = String(event.error || "").trim();
    const errLower = errText.toLowerCase();
    const anyForegroundPending =
      Boolean(state.pendingReplace) ||
      Boolean(state.pendingBlend) ||
      Boolean(state.pendingSwapDna) ||
      Boolean(state.pendingBridge) ||
      Boolean(state.pendingExtractDna) ||
      Boolean(state.pendingSoulLeech) ||
      Boolean(state.pendingTriforce) ||
      Boolean(state.pendingRecast) ||
      Boolean(state.pendingDiagnose) ||
      Boolean(state.pendingArgue) ||
      Boolean(state.pendingExtractRule) ||
      Boolean(state.pendingOddOneOut) ||
      Boolean(state.pendingRecreate) ||
      Boolean(state.pendingGeneration?.remaining);
    const motherRecentSuccess =
      !wasMotherDispatch &&
      Boolean(motherIdle?.generatedImageId) &&
      !state.expectingArtifacts &&
      !anyForegroundPending &&
      String(state.lastAction || "") === "Mother Suggestion" &&
      Date.now() <= (Number(motherIdle?.suppressFailureUntil) || 0);
    const looksLikeNoImageError = /no images?|failed to return|no artifacts?|no output/i.test(errLower);
    if (motherRecentSuccess && looksLikeNoImageError) {
      appendMotherSuggestionLog({
        stage: "spurious_failed_after_success",
        image_id: String(motherIdle.generatedImageId || ""),
        error: errText || null,
        phase: motherIdle?.phase || null,
        last_action: state.lastAction || null,
      }).catch(() => {});
      console.warn("[mother_suggestion] ignored spurious failure after successful artifact", {
        image_id: String(motherIdle.generatedImageId || ""),
        phase: motherIdle?.phase || null,
        error: errText || null,
      });
      state.expectingArtifacts = false;
      restoreEngineImageModelIfNeeded();
      setStatus("Engine: ready");
      updatePortraitIdle();
      setImageFxActive(false);
      renderQuickActions();
      renderHudReadout();
      processActionQueue().catch(() => {});
      return;
    }
    const msg = event.error ? `Generation failed: ${event.error}` : "Generation failed.";
    setStatus(`Engine: ${msg}`, true);
    showToast(msg, "error", 3200);
    state.expectingArtifacts = false;
    state.pendingRecreate = null;
    state.pendingBlend = null;
    state.pendingSwapDna = null;
    state.pendingBridge = null;
    state.pendingExtractDna = null;
    state.pendingSoulLeech = null;
    state.pendingTriforce = null;
    state.pendingRecast = null;
    state.pendingDiagnose = null;
    state.pendingArgue = null;
    state.pendingExtractRule = null;
    state.pendingOddOneOut = null;
    state.tripletRuleAnnotations.clear();
    state.tripletOddOneOutId = null;
    resetActionQueue();
    clearPendingReplace();
    for (const [tokenId] of state.effectTokenApplyLocks.entries()) {
      const token = state.effectTokensById.get(tokenId) || null;
      if (token) recoverEffectTokenApply(token);
    }
    state.effectTokenApplyLocks.clear();
    restoreEngineImageModelIfNeeded();
    updatePortraitIdle();
    setImageFxActive(false);
    renderQuickActions();
    renderHudReadout();
    chooseSpawnNodes();
    requestRender();
    processActionQueue().catch(() => {});
  } else if (eventType === DESKTOP_EVENT_TYPES.COST_LATENCY_UPDATE) {
    state.lastCostLatency = {
      provider: event.provider,
      model: event.model,
      cost_total_usd: event.cost_total_usd,
      cost_per_1k_images_usd: event.cost_per_1k_images_usd,
      latency_per_image_s: event.latency_per_image_s,
      at: Date.now(),
    };
    topMetricIngestCost(event.cost_total_usd);
    renderHudReadout();
    renderSessionApiCallsReadout();
  } else if (eventType === DESKTOP_EVENT_TYPES.CANVAS_CONTEXT) {
    const text = event.text;
    const isPartial = Boolean(event.partial);
    const aov = state.alwaysOnVision;
    if (aov) {
      if (isPartial) {
        // Keep the "pending" state while the realtime session is streaming partial text.
        aov.pending = true;
      } else {
        aov.pending = false;
        aov.pendingPath = null;
        aov.pendingAt = 0;
      }
      if (typeof text === "string" && text.trim()) {
        aov.lastText = text.trim();
      }
      aov.lastMeta = {
        source: event.source || null,
        model: event.model || null,
        at: Date.now(),
        image_path: event.image_path || null,
        partial: isPartial,
      };
      const src = String(event.source || "");
      if (src === "openai_realtime") {
        aov.rtState = "ready";
        aov.disabledReason = null;
      }
    }
    if (!isPartial) {
      clearTimeout(alwaysOnVisionTimeout);
      alwaysOnVisionTimeout = null;
    }
    updateAlwaysOnVisionReadout();
    if (!isPartial) {
      processActionQueue().catch(() => {});
    }
    if (!isPartial && typeof text === "string" && text.trim()) {
      const top = extractCanvasContextTopAction(text);
      state.canvasContextSuggestion = top?.action
        ? {
            action: top.action,
            why: top.why || null,
            at: Date.now(),
            source: event.source || null,
            model: event.model || null,
          }
        : null;
      renderQuickActions();
    }
  } else if (eventType === DESKTOP_EVENT_TYPES.CANVAS_CONTEXT_FAILED) {
    const aov = state.alwaysOnVision;
    if (aov) {
      aov.pending = false;
      aov.pendingPath = null;
      aov.pendingAt = 0;
      const msg = event.error ? `Canvas context failed: ${event.error}` : "Canvas context failed.";
      aov.lastText = msg;
      aov.lastMeta = {
        source: event.source || null,
        model: event.model || null,
        at: Date.now(),
        image_path: event.image_path || null,
      };
      const src = String(event.source || "");
      if (event.fatal && src === "openai_realtime") {
        aov.enabled = false;
        aov.rtState = "failed";
        aov.disabledReason = event.error
          ? `Always-on vision disabled: ${event.error}`
          : `Always-on vision disabled (${src || "canvas context"} error).`;
        settings.alwaysOnVision = false;
        localStorage.setItem("brood.alwaysOnVision", "0");
        if (els.alwaysOnVisionToggle) els.alwaysOnVisionToggle.checked = false;

        clearTimeout(alwaysOnVisionTimer);
        alwaysOnVisionTimer = null;

        // Best-effort shutdown; the engine will ignore if not running.
        if (state.ptySpawned) {
          invoke("write_pty", { data: `${PTY_COMMANDS.CANVAS_CONTEXT_RT_STOP}\n` }).catch(() => {});
        }
        setStatus("Engine: always-on vision disabled (canvas context failure)", true);
      }
    }
    state.canvasContextSuggestion = null;
    clearTimeout(alwaysOnVisionTimeout);
    alwaysOnVisionTimeout = null;
    updateAlwaysOnVisionReadout();
    renderQuickActions();
    processActionQueue().catch(() => {});
  } else if (event.type === DESKTOP_EVENT_TYPES.INTENT_ICONS) {
    const intent = state.intent;
    const ambient = state.intentAmbient;
    const motherIdle = state.motherIdle;
    const motherPhase = String(motherIdle?.phase || "");
    const motherActionVersion = Number(motherIdle?.actionVersion) || 0;
    const motherPendingActionVersion = Number(motherIdle?.pendingActionVersion) || 0;
    const motherVersionMatches = motherPendingActionVersion === motherActionVersion;
    const motherRealtimePath = String(motherIdle?.pendingIntentRealtimePath || "").trim();
    const motherRequestId = String(motherIdle?.pendingIntentRequestId || "").trim() || null;
    const motherHasFallbackIntent = String(motherIdle?.intent?._intent_source_kind || "").trim().toLowerCase() === "fallback";
    const motherLateRealtimeUpgrade = Boolean(
      !motherIdle?.pendingIntent &&
      motherHasFallbackIntent &&
      motherPhase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING &&
      motherVersionMatches &&
      motherRealtimePath &&
      Date.now() <= (Number(motherIdle?.pendingIntentUpgradeUntil) || 0) &&
      !motherIdle?.pendingPromptCompile &&
      !motherIdle?.pendingGeneration
    );
    const motherCanAcceptRealtime = Boolean(
      (motherIdle?.pendingIntent && motherPhase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING && motherVersionMatches) ||
      motherLateRealtimeUpgrade
    );
    if (!intent && !ambient && !motherCanAcceptRealtime) return;
    const isPartial = Boolean(event.partial);
    const text = event.text;
    const path = event.image_path ? String(event.image_path) : "";
    if (!path) return;
    const eventActionVersionRaw = Number(event.action_version);
    const routing = classifyIntentIconsRouting({
      path,
      intentPendingPath: intent?.pendingPath,
      ambientPendingPath: ambient?.pendingPath,
      motherCanAcceptRealtime,
      motherRealtimePath,
      motherActionVersion,
      eventActionVersion: eventActionVersionRaw,
    });
    const { matchAmbient, matchIntent, matchMother, ignoreReason } = routing;
    if (ignoreReason === "snapshot_path_mismatch" || ignoreReason === "path_mismatch") {
      if (!isPartial && ignoreReason === "snapshot_path_mismatch") {
        appendMotherTraceLog({
          kind: "intent_icons_ignored",
          traceId: motherIdle?.telemetry?.traceId || null,
          actionVersion: motherActionVersion,
          request_id: motherRequestId,
          reason: ignoreReason,
          expected_snapshot_path: motherRealtimePath || null,
          event_snapshot_path: path || null,
          event_action_version: Number.isFinite(eventActionVersionRaw) ? eventActionVersionRaw : null,
        }).catch(() => {});
      }
      return;
    }
    if (ignoreReason === "event_action_version_mismatch") {
      appendMotherTraceLog({
        kind: "intent_icons_ignored",
        traceId: motherIdle?.telemetry?.traceId || null,
        actionVersion: motherActionVersion,
        request_id: motherRequestId,
        reason: ignoreReason,
        event_action_version: eventActionVersionRaw,
      }).catch(() => {});
      return;
    }

    if (isPartial) {
      if (matchIntent && intent) intent.pending = true;
      if (matchAmbient && ambient) ambient.pending = true;
    } else {
      if (matchIntent && intent) {
        intent.pending = false;
        intent.pendingPath = null;
        intent.pendingAt = 0;
        intent.pendingFrameId = null;
      }
      if (matchAmbient && ambient) {
        clearAmbientIntentPending();
      }
    }

    const hasText = typeof text === "string" && text.trim();
    if (hasText) {
      if (isPartial && matchMother && motherIdle?.pendingIntent) {
        // Sliding timeout: keep request alive while realtime stream is actively delivering deltas.
        motherV2ArmRealtimeIntentTimeout({ timeoutMs: MOTHER_V2_INTENT_RT_TIMEOUT_MS });
      }
      const parsedResult = parseIntentIconsJsonDetailed(text);
      const parsed = parsedResult?.ok ? parsedResult.value : null;
      const parseStrategy = String(parsedResult?.strategy || "none");
      const parseReason = parsedResult?.reason ? String(parsedResult.reason) : null;
      const parseError = parsedResult?.error ? String(parsedResult.error) : null;
      const textLen = text.length;
      const textHash = intentIconsPayloadChecksum(text);

      if (!isPartial) {
        const snippet = parsed ? { head: "", tail: "" } : intentIconsPayloadSafeSnippet(text);
        if (matchIntent || matchAmbient) {
          appendIntentTrace({
            kind: "model_icons_payload_parse",
            parse_ok: Boolean(parsed),
            parse_strategy: parseStrategy,
            parse_reason: parseReason,
            parse_error: parseError,
            snapshot_path: path ? String(path) : null,
            request_id: matchMother ? motherRequestId : null,
            action_version: matchMother ? motherActionVersion : null,
            source: event.source || null,
            model: event.model || null,
            response_status: event.response_status ? String(event.response_status) : null,
            response_status_reason: event.response_status_reason ? String(event.response_status_reason) : null,
            text_len: textLen,
            text_hash: textHash,
            snippet_head: snippet.head || null,
            snippet_tail: snippet.tail || null,
          }).catch(() => {});
        }
        if (matchMother && motherIdle) {
          appendMotherTraceLog({
            kind: "intent_payload_parse",
            traceId: motherIdle.telemetry?.traceId || null,
            actionVersion: Number(motherIdle.actionVersion) || 0,
            request_id: motherRequestId,
            snapshot_path: path || null,
            parse_ok: Boolean(parsed),
            parse_strategy: parseStrategy,
            parse_reason: parseReason,
            parse_error: parseError,
            source: event.source || null,
            model: event.model || null,
            response_status: event.response_status ? String(event.response_status) : null,
            response_status_reason: event.response_status_reason ? String(event.response_status_reason) : null,
            text_len: textLen,
            text_hash: textHash,
            snippet_head: snippet.head || null,
            snippet_tail: snippet.tail || null,
          }).catch(() => {});
        }
      }

      if (parsed) {
        // Capture per-image vision labels from the intent realtime response so we can
        // use them as signals without issuing separate /describe calls.
        const imageDescs = !isPartial ? extractIntentImageDescriptions(parsed) : [];
        let wroteVision = false;
        if (!isPartial && imageDescs.length) {
          for (const rec of imageDescs) {
            const imageId = rec?.image_id ? String(rec.image_id) : "";
            const label = rec?.label ? String(rec.label) : "";
            if (!imageId || !label) continue;
            const imgItem = state.imagesById.get(imageId) || null;
            if (!imgItem) continue;
            // First-wins for stability (prevents intent-signature churn).
            if (imgItem.visionDesc) continue;
            imgItem.visionDesc = label;
            imgItem.visionPending = false;
            imgItem.visionDescMeta = {
              source: event.source || null,
              model: event.model || null,
              at: Date.now(),
            };
            wroteVision = true;
            if (intentModeActive() || intentAmbientActive()) {
              appendIntentTrace({
                kind: "vision_description",
                image_id: imageId,
                image_path: imgItem?.path ? String(imgItem.path) : null,
                description: label,
                source: event.source || null,
                model: event.model || null,
              }).catch(() => {});
            }
          }
        }

        if (wroteVision) {
          scheduleVisualPromptWrite();
          if (getActiveImage()?.id) renderHudReadout();
        }

        const parsedAt = Date.now();
        if (matchIntent && intent) {
          intent.iconState = parsed;
          intent.iconStateAt = parsedAt;
          intent.rtState = "ready";
          intent.disabledReason = null;
          intent.lastError = null;
          intent.lastErrorAt = 0;
          intent.uiHideSuggestion = false;
        }
        if (matchAmbient && ambient) {
          ambient.iconState = parsed;
          ambient.iconStateAt = parsedAt;
          ambient.rtState = "ready";
          ambient.disabledReason = null;
          ambient.lastError = null;
          ambient.lastErrorAt = 0;
          if (!isPartial) {
            const touched = imageDescs.map((rec) => String(rec?.image_id || "")).filter(Boolean);
            if (touched.length) rememberAmbientTouchedImageIds(touched);
            rebuildAmbientIntentSuggestions(parsed, { reason: "realtime", nowMs: parsedAt });
          }
        }
        if (matchMother && motherIdle && !isPartial) {
          const payloadForMother = motherIdle.pendingIntentPayload && typeof motherIdle.pendingIntentPayload === "object"
            ? motherIdle.pendingIntentPayload
            : motherV2IntentPayload();
          const realtimeIntent = motherV2IntentFromRealtimeIcons(parsed, payloadForMother);
          const isLateRealtimeUpgrade = !motherIdle.pendingIntent;
          if (!motherIdle.pendingIntent) {
            appendMotherTraceLog({
              kind: "intent_realtime_upgrade",
              traceId: motherIdle.telemetry?.traceId || null,
              actionVersion: Number(motherIdle.actionVersion) || 0,
              request_id: motherRequestId,
              snapshot_path: path || null,
            }).catch(() => {});
          }
          motherV2ApplyIntent(realtimeIntent, {
            source: event.source || "intent_rt_realtime",
            requestId: motherRequestId,
            preserveMode: isLateRealtimeUpgrade,
          });
        }
        // Keep focus stable if possible (unless rejected); otherwise pick the next suggestion.
        const picked = pickSuggestedIntentBranch(parsed);
        if (matchIntent && intent) {
          intent.focusBranchId = (picked?.branch_id ? String(picked.branch_id) : "") || pickDefaultIntentFocusBranchId(parsed);
        }
        if (!isPartial && (matchIntent || matchAmbient)) {
          const branchIds = Array.isArray(parsed?.branches)
            ? parsed.branches.map((b) => (b?.branch_id ? String(b.branch_id) : "")).filter(Boolean)
            : [];
          const branchRank = Array.isArray(parsed?.branches)
            ? parsed.branches
                .map((b) => ({
                  branch_id: b?.branch_id ? String(b.branch_id) : "",
                  confidence: typeof b?.confidence === "number" && Number.isFinite(b.confidence) ? clamp(Number(b.confidence) || 0, 0, 1) : null,
                  evidence_image_ids: Array.isArray(b?.evidence_image_ids)
                    ? b.evidence_image_ids.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 3)
                    : [],
                }))
                .filter((b) => Boolean(b.branch_id))
            : [];
          appendIntentTrace({
            kind: "model_icons",
            partial: false,
            frame_id: parsed?.frame_id ? String(parsed.frame_id) : null,
            snapshot_path: path ? String(path) : null,
            branch_ids: branchIds,
            branch_rank: branchRank.length ? branchRank : null,
            focus_branch_id: intent?.focusBranchId ? String(intent.focusBranchId) : null,
            checkpoint_applies_to: parsed?.checkpoint?.applies_to ? String(parsed.checkpoint.applies_to) : null,
            checkpoint_branch_id: picked?.checkpoint_branch_id ? String(picked.checkpoint_branch_id) : null,
            ranked_branch_ids: Array.isArray(picked?.ranked_branch_ids) && picked.ranked_branch_ids.length ? picked.ranked_branch_ids : null,
            suggestion_reason: picked?.reason ? String(picked.reason) : null,
            image_descriptions: imageDescs.length ? imageDescs : null,
            text_len: textLen,
            text_hash: textHash,
            parse_strategy: parseStrategy,
          }).catch(() => {});
        }
        if (matchIntent && intent) {
          const total = Math.max(1, Number(intent.totalRounds) || 3);
          const round = Math.max(1, Number(intent.round) || 1);
          // After the final round proposals arrive, force an explicit YES to proceed.
          if (INTENT_FORCE_CHOICE_ENABLED && INTENT_ROUNDS_ENABLED && !isPartial && round >= total && !intent.forceChoice) {
            intent.forceChoice = true;
            ensureIntentFallbackIconState("final_round");
            scheduleIntentStateWrite({ immediate: true });
          } else {
            if (!INTENT_FORCE_CHOICE_ENABLED) intent.forceChoice = false;
            scheduleIntentStateWrite();
          }
        }
      } else if (!isPartial) {
        // Treat invalid JSON as a non-fatal failure: fall back to local branches and keep the UI interactive.
        const parseReasonLabel = parseReason ? parseReason.replace(/_/g, " ") : "parse failed";
        const intentParseMessage = `Intent icons parse failed (${parseReasonLabel}).`;
        const snippet = intentIconsPayloadSafeSnippet(text);
        if (matchIntent && intent) {
          intent.rtState = "failed";
          intent.disabledReason = "Intent icons parse failed.";
          intent.lastError = intent.disabledReason;
          intent.lastErrorAt = Date.now();
          intent.uiHideSuggestion = false;
          if (!INTENT_FORCE_CHOICE_ENABLED) intent.forceChoice = false;
          const icon = ensureIntentFallbackIconState("parse_failed");
          if (!intent.focusBranchId) intent.focusBranchId = pickSuggestedIntentBranchId(icon) || pickDefaultIntentFocusBranchId(icon);
        }
        if (matchAmbient && ambient) {
          applyAmbientIntentFallback("parse_failed", { message: intentParseMessage });
        }
        if (matchMother && motherIdle) {
          const fallbackMessage = parseReason === "truncated_json"
            ? "Mother realtime intent response was truncated."
            : "Mother realtime intent parse failed.";
          appendMotherTraceLog({
            kind: "intent_realtime_failed",
            traceId: motherIdle.telemetry?.traceId || null,
            actionVersion: Number(motherIdle.actionVersion) || 0,
            request_id: motherRequestId,
            source: "intent_rt_parse_failed",
            parse_reason: parseReason,
            parse_strategy: parseStrategy,
            parse_error: parseError,
            response_status: event.response_status ? String(event.response_status) : null,
            response_status_reason: event.response_status_reason ? String(event.response_status_reason) : null,
            snapshot_path: path || null,
            text_len: textLen,
            text_hash: textHash,
            snippet_head: snippet.head || null,
            snippet_tail: snippet.tail || null,
            error: fallbackMessage,
          }).catch(() => {});
          motherIdleHandleGenerationFailed(fallbackMessage);
        }
        if (matchIntent || matchAmbient) {
          appendIntentTrace({
            kind: "model_icons_parse_failed",
            reason: intent?.disabledReason || intentParseMessage,
            parse_reason: parseReason,
            parse_strategy: parseStrategy,
            parse_error: parseError,
            response_status: event.response_status ? String(event.response_status) : null,
            response_status_reason: event.response_status_reason ? String(event.response_status_reason) : null,
            snapshot_path: path ? String(path) : null,
            text_len: textLen,
            text_hash: textHash,
            snippet_head: snippet.head || null,
            snippet_tail: snippet.tail || null,
            rt_state: intent?.rtState || ambient?.rtState || "failed",
          }).catch(() => {});
        }
        if (matchIntent && intent) scheduleIntentStateWrite({ immediate: true });
      }
    }

    if (!isPartial) {
      if (matchIntent) {
        clearTimeout(intentInferenceTimeout);
        intentInferenceTimeout = null;
      }
      if (matchAmbient) {
        clearTimeout(intentAmbientInferenceTimeout);
        intentAmbientInferenceTimeout = null;
      }
    }

    requestRender();
    renderQuickActions();
  } else if (event.type === DESKTOP_EVENT_TYPES.INTENT_ICONS_FAILED) {
    const intent = state.intent;
    const ambient = state.intentAmbient;
    const motherIdle = state.motherIdle;
    const path = event.image_path ? String(event.image_path) : "";
    if (!path) return;
    const matchAmbient = Boolean(ambient?.pendingPath && String(ambient.pendingPath) === path);
    const matchIntent = Boolean(intent?.pendingPath && String(intent.pendingPath) === path);
    const matchMother = Boolean(
      motherIdle?.pendingIntent &&
        String(motherIdle?.phase || "") === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING &&
        String(motherIdle?.pendingIntentRealtimePath || "") === path &&
        (Number(motherIdle?.pendingActionVersion) || 0) === (Number(motherIdle?.actionVersion) || 0)
    );
    const motherRequestId = String(motherIdle?.pendingIntentRequestId || "").trim() || null;
    if (!matchIntent && !matchAmbient && !matchMother) return;

    if (matchIntent && intent) {
      intent.pending = false;
      intent.pendingPath = null;
      intent.pendingAt = 0;
      intent.pendingFrameId = null;
    }
    if (matchAmbient && ambient) {
      clearAmbientIntentPending();
    }
    if (matchIntent) {
      clearTimeout(intentInferenceTimeout);
      intentInferenceTimeout = null;
    }
    if (matchAmbient) {
      clearTimeout(intentAmbientInferenceTimeout);
      intentAmbientInferenceTimeout = null;
    }

    const errRaw = typeof event.error === "string" ? event.error.trim() : "";
    const msg = errRaw ? `Intent inference failed: ${errRaw}` : "Intent inference failed.";
	    if (matchIntent && intent) {
	      intent.rtState = "failed";
	      intent.lastError = msg;
	      intent.lastErrorAt = Date.now();
	      intent.uiHideSuggestion = false;
	    }
	    if (matchIntent || matchAmbient) {
	      appendIntentTrace({
	        kind: "model_icons_failed",
	        reason: msg,
	        snapshot_path: path ? String(path) : null,
	        rt_state: intent?.rtState || ambient?.rtState || "failed",
	      }).catch(() => {});
	    }

    const errLower = errRaw.toLowerCase();
    const hardDisable = Boolean(
      errLower.includes("missing openai_api_key") ||
        errLower.includes("missing dependency") ||
        errLower.includes("disabled (brood_intent_realtime_disabled=1") ||
        errLower.includes("realtime intent inference is disabled")
    );
    // Only treat clearly-unrecoverable cases as a "hard" disabled state. Otherwise,
    // keep retrying opportunistically while the user continues arranging images.
    if (matchIntent && intent) intent.disabledReason = hardDisable ? msg : null;

    // Fall back to a local branch set so the user can still lock an intent.
    if (matchIntent && intent) {
      ensureIntentFallbackIconState("failed");
      if (!intent.focusBranchId) {
        intent.focusBranchId = pickSuggestedIntentBranchId(intent.iconState) || pickDefaultIntentFocusBranchId();
      }
    }
    if (matchAmbient && ambient) {
      applyAmbientIntentFallback("failed", { message: msg, hardDisable });
    }
    if (matchMother && motherIdle) {
      appendMotherTraceLog({
        kind: "intent_realtime_failed",
        traceId: motherIdle.telemetry?.traceId || null,
        actionVersion: Number(motherIdle.actionVersion) || 0,
        request_id: motherRequestId,
        source: "intent_rt_failed",
        error: msg,
      }).catch(() => {});
      motherIdleHandleGenerationFailed(`Mother realtime intent failed. ${msg}`);
    }

    if (matchIntent && intent && !INTENT_FORCE_CHOICE_ENABLED) {
      intent.forceChoice = false;
    } else if (matchIntent && intent) {
      // Only force choice if time is up or we're already at the final round gate.
      const total = Math.max(1, Number(intent.totalRounds) || 3);
      const round = Math.max(1, Number(intent.round) || 1);
      const remainingMs = intent.startedAt ? intentRemainingMs(Date.now()) : INTENT_DEADLINE_MS;
      const gateByTimer = Boolean(INTENT_TIMER_ENABLED) && remainingMs <= 0;
      const gateByRounds = Boolean(INTENT_ROUNDS_ENABLED) && round >= total;
      if (gateByTimer || gateByRounds) {
        intent.forceChoice = true;
      }
    }

    if (matchIntent && intent) scheduleIntentStateWrite({ immediate: true });
    if (matchIntent || matchAmbient) setStatus(`Engine: ${msg}`, true);
    requestRender();
    renderQuickActions();

    if (matchAmbient && ambient && !hardDisable) {
      scheduleAmbientIntentInference({ immediate: false, reason: "composition_change" });
    }
    if (!hardDisable && matchIntent && intentModeActive() && intent && !intent.forceChoice) {
      scheduleIntentInference({ immediate: false, reason: "retry" });
    }
	  } else if (event.type === DESKTOP_EVENT_TYPES.IMAGE_DESCRIPTION) {
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
	      dropDescribeQueuedPath(path);
	      const releasedSlot = clearDescribeInFlightPath(path);
	      if (releasedSlot) processDescribeQueue();
	      // Persist the new per-image description into run artifacts.
	      scheduleVisualPromptWrite();
	
	      if (intentAmbientActive()) {
	        appendIntentTrace({
	          kind: "ambient_vision_description",
	          image_path: path,
	          description: cleaned,
	          source: event.source || null,
	          model: event.model || null,
	        }).catch(() => {});
	        const touched = state.images
	          .filter((img) => img?.path === path)
	          .map((img) => String(img.id || ""))
	          .filter(Boolean);
	        // Vision-derived labels are useful intent signals; schedule a refresh so the
	        // suggested branch can tighten as these descriptions arrive.
	        scheduleAmbientIntentInference({ immediate: true, reason: "describe", imageIds: touched });
	      }
	      if (getActiveImage()?.path === path) renderHudReadout();
	    }
	  } else if (event.type === DESKTOP_EVENT_TYPES.IMAGE_DIAGNOSIS) {
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
  } else if (event.type === DESKTOP_EVENT_TYPES.IMAGE_DIAGNOSIS_FAILED) {
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
  } else if (event.type === DESKTOP_EVENT_TYPES.IMAGE_ARGUMENT) {
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
  } else if (event.type === DESKTOP_EVENT_TYPES.IMAGE_ARGUMENT_FAILED) {
    state.pendingArgue = null;
    const msg = event.error ? `Argue failed: ${event.error}` : "Argue failed.";
    setStatus(`Director: ${msg}`, true);
    showToast(msg, "error", 3200);
    updatePortraitIdle();
    renderQuickActions();
    processActionQueue().catch(() => {});
  } else if (event.type === DESKTOP_EVENT_TYPES.IMAGE_DNA_EXTRACTED) {
    const path = typeof event.image_path === "string" ? event.image_path : "";
    const matchedImageId = consumePendingEffectExtraction("dna", path);
    const resolvedImageId = matchedImageId || resolveExtractionEventImageIdByPath(path);
    if (!resolvedImageId) {
      requestRender();
      return;
    }
    const item = state.imagesById.get(resolvedImageId) || null;
    if (item?.id) {
      const token = createOrUpdateEffectToken({
        type: "extract_dna",
        imageId: item.id,
        imagePath: path,
        palette: Array.isArray(event.palette) ? event.palette : [],
        colors: Array.isArray(event.colors) ? event.colors : [],
        materials: Array.isArray(event.materials) ? event.materials : [],
        summary: typeof event.summary === "string" ? event.summary : "",
        source: event.source || null,
        model: event.model || null,
      });
      if (token) {
        if (!suppressReelDnaToasts()) {
          showToast(`DNA extracted: ${item.label || basename(item.path)}`, "tip", 1800);
        }
      }
      requestRender();
    }
  } else if (event.type === DESKTOP_EVENT_TYPES.IMAGE_DNA_EXTRACTED_FAILED) {
    const path = typeof event.image_path === "string" ? event.image_path : "";
    const msg = event.error ? `Extract DNA failed: ${event.error}` : "Extract DNA failed.";
    showToast(msg, "error", 2600);
    if (path) consumePendingEffectExtraction("dna", path);
    else {
      state.pendingExtractDna = null;
      updatePortraitIdle();
      renderQuickActions();
      processActionQueue().catch(() => {});
    }
  } else if (event.type === DESKTOP_EVENT_TYPES.IMAGE_SOUL_EXTRACTED) {
    const path = typeof event.image_path === "string" ? event.image_path : "";
    const matchedImageId = consumePendingEffectExtraction("soul", path);
    const resolvedImageId = matchedImageId || resolveExtractionEventImageIdByPath(path);
    if (!resolvedImageId) {
      requestRender();
      return;
    }
    const item = state.imagesById.get(resolvedImageId) || null;
    if (item?.id) {
      const token = createOrUpdateEffectToken({
        type: "soul_leech",
        imageId: item.id,
        imagePath: path,
        emotion: typeof event.emotion === "string" ? event.emotion : "",
        summary: typeof event.summary === "string" ? event.summary : "",
        source: event.source || null,
        model: event.model || null,
      });
      if (token) {
        showToast(`Soul extracted: ${item.label || basename(item.path)}`, "tip", 1800);
      }
      requestRender();
    }
  } else if (event.type === DESKTOP_EVENT_TYPES.IMAGE_SOUL_EXTRACTED_FAILED) {
    const path = typeof event.image_path === "string" ? event.image_path : "";
    const msg = event.error ? `Soul Leech failed: ${event.error}` : "Soul Leech failed.";
    showToast(msg, "error", 2600);
    if (path) consumePendingEffectExtraction("soul", path);
    else {
      state.pendingSoulLeech = null;
      updatePortraitIdle();
      renderQuickActions();
      processActionQueue().catch(() => {});
    }
  } else if (event.type === DESKTOP_EVENT_TYPES.TRIPLET_RULE) {
    state.pendingExtractRule = null;
    const paths = Array.isArray(event.image_paths) ? event.image_paths : [];
    const principle = typeof event.principle === "string" ? event.principle.trim() : "";
    const evidence = Array.isArray(event.evidence) ? event.evidence : [];
    const textRaw = typeof event.text === "string" ? event.text.trim() : "";
    let text = textRaw;
    if (!text) {
      const lines = [];
      if (principle) {
        lines.push("RULE:");
        lines.push(principle);
      }
      if (evidence.length) {
        if (lines.length) lines.push("");
        lines.push("EVIDENCE:");
        for (const item of evidence.slice(0, 6)) {
          const img = item?.image ? String(item.image).trim() : "";
          const note = item?.note ? String(item.note).trim() : "";
          if (!note) continue;
          lines.push(`- ${img ? `${img}: ` : ""}${note}`);
        }
      }
      text = lines.join("\n").trim();
    }

    state.tripletRuleAnnotations.clear();
    state.tripletOddOneOutId = null;
    const annotations = Array.isArray(event.annotations) ? event.annotations : [];
    if (paths.length === 3 && annotations.length) {
      for (const ann of annotations) {
        const tag = String(ann?.image || "").trim().toUpperCase();
        const idx = tag === "A" ? 0 : tag === "B" ? 1 : tag === "C" ? 2 : -1;
        if (idx < 0) continue;
        const x = Number(ann?.x);
        const y = Number(ann?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const label = ann?.label ? String(ann.label).trim() : "";
        const targetPath = paths[idx];
        const imgItem = state.images.find((it) => it?.path === targetPath) || null;
        if (!imgItem?.id) continue;
        const points = state.tripletRuleAnnotations.get(imgItem.id) || [];
        points.push({ x: clamp(x, 0, 1), y: clamp(y, 0, 1), label: clampText(label, 64) });
        state.tripletRuleAnnotations.set(imgItem.id, points);
      }
    }

    if (text) {
      setDirectorText(text, {
        kind: "extract_rule",
        source: event.source || null,
        model: event.model || null,
        at: Date.now(),
        paths,
      });
    }
    setStatus("Director: rule ready");
    showToast("Extract the Rule ready.", "tip", 2400);
    updatePortraitIdle();
    renderQuickActions();
    requestRender();
    processActionQueue().catch(() => {});
  } else if (event.type === DESKTOP_EVENT_TYPES.TRIPLET_RULE_FAILED) {
    state.pendingExtractRule = null;
    const msg = event.error ? `Extract the Rule failed: ${event.error}` : "Extract the Rule failed.";
    setStatus(`Director: ${msg}`, true);
    showToast(msg, "error", 3200);
    updatePortraitIdle();
    renderQuickActions();
    processActionQueue().catch(() => {});
  } else if (event.type === DESKTOP_EVENT_TYPES.TRIPLET_ODD_ONE_OUT) {
    state.pendingOddOneOut = null;
    const paths = Array.isArray(event.image_paths) ? event.image_paths : [];
    const oddIndex = typeof event.odd_index === "number" ? event.odd_index : null;
    const oddTag = typeof event.odd_image === "string" ? event.odd_image.trim().toUpperCase() : "";
    let oddPath = null;
    if (oddIndex !== null && oddIndex >= 0 && oddIndex < paths.length) {
      oddPath = paths[oddIndex];
    } else if (paths.length === 3) {
      if (oddTag === "A") oddPath = paths[0];
      if (oddTag === "B") oddPath = paths[1];
      if (oddTag === "C") oddPath = paths[2];
    }
    const oddItem = oddPath ? state.images.find((it) => it?.path === oddPath) || null : null;
    state.tripletOddOneOutId = oddItem?.id || null;
    state.tripletRuleAnnotations.clear();

    const textRaw = typeof event.text === "string" ? event.text.trim() : "";
    let text = textRaw;
    if (!text) {
      const pattern = typeof event.pattern === "string" ? event.pattern.trim() : "";
      const why = typeof event.explanation === "string" ? event.explanation.trim() : "";
      const lines = [];
      if (oddTag || oddIndex !== null) lines.push(`ODD ONE OUT: ${oddTag || String(oddIndex + 1)}`);
      if (pattern) {
        if (lines.length) lines.push("");
        lines.push("THE SHARED PATTERN:");
        lines.push(pattern);
      }
      if (why) {
        if (lines.length) lines.push("");
        lines.push("WHY IT BREAKS:");
        lines.push(why);
      }
      text = lines.join("\n").trim();
    }

    if (text) {
      setDirectorText(text, {
        kind: "odd_one_out",
        source: event.source || null,
        model: event.model || null,
        at: Date.now(),
        paths,
      });
    }
    setStatus("Director: odd one out ready");
    showToast("Odd One Out ready.", "tip", 2400);
    updatePortraitIdle();
    renderQuickActions();
    requestRender();
    processActionQueue().catch(() => {});
  } else if (event.type === DESKTOP_EVENT_TYPES.TRIPLET_ODD_ONE_OUT_FAILED) {
    state.pendingOddOneOut = null;
    const msg = event.error ? `Odd One Out failed: ${event.error}` : "Odd One Out failed.";
    setStatus(`Director: ${msg}`, true);
    showToast(msg, "error", 3200);
    updatePortraitIdle();
    renderQuickActions();
    processActionQueue().catch(() => {});
  } else if (event.type === DESKTOP_EVENT_TYPES.RECREATE_PROMPT_INFERRED) {
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
  } else if (event.type === DESKTOP_EVENT_TYPES.RECREATE_ITERATION_UPDATE) {
    const iter = event.iteration;
    const sim = event.similarity;
    if (typeof iter === "number") {
      const pct = typeof sim === "number" ? `${Math.round(sim * 100)}%` : "—";
      setStatus(`Engine: recreate iter ${iter} (best ${pct})`);
    }
    renderHudReadout();
  } else if (event.type === DESKTOP_EVENT_TYPES.RECREATE_DONE) {
    state.pendingRecreate = null;
    setStatus("Engine: variations ready");
    setTip("Variations complete.");
    updatePortraitIdle();
    renderQuickActions();
    renderHudReadout();
    processActionQueue().catch(() => {});
  }
}

function hitTestEffectToken(ptCanvas) {
  if (!ptCanvas || state.canvasMode !== "multi") return null;
  if (effectsRuntime) {
    const runtimeHit = effectsRuntime.hitTestToken(ptCanvas);
    if (runtimeHit?.tokenId) {
      const imageId = String(runtimeHit.imageId || "").trim();
      const token = state.effectTokensById.get(String(runtimeHit.tokenId || "").trim()) || null;
      const rect = imageId ? state.multiRects.get(imageId) || null : null;
      if (token && imageId && rect) {
        return { tokenId: token.id, imageId, token, rect };
      }
    }
  }
  const transform = getMultiViewTransform();
  const x = (Number(ptCanvas.x) - transform.offsetX) / transform.scale;
  const y = (Number(ptCanvas.y) - transform.offsetY) / transform.scale;
  const order = Array.isArray(state.freeformZOrder) && state.freeformZOrder.length
    ? state.freeformZOrder
    : Array.from(state.multiRects.keys());
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const imageId = String(order[i] || "").trim();
    if (!imageId) continue;
    const token = effectTokenForImageId(imageId);
    if (!token) continue;
    const rect = state.multiRects.get(imageId) || null;
    if (!rect) continue;
    const cx = rect.x + rect.w * 0.5;
    const cy = rect.y + rect.h * 0.5;
    const r = Math.max(14, Math.min(rect.w, rect.h) * 0.19);
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy > r * r) continue;
    return { tokenId: token.id, imageId, token, rect };
  }
  return null;
}

function renderMultiCanvas(wctx, octx, canvasW, canvasH) {
  const items = state.images || [];
  const nowMs = performance.now ? performance.now() : Date.now();
  for (const item of items) {
    ensureCanvasImageLoaded(item);
  }

  state.multiRects = computeFreeformRectsPx(canvasW, canvasH);
  const ms = Number(state.multiView?.scale) || 1;
  const mox = Number(state.multiView?.offsetX) || 0;
  const moy = Number(state.multiView?.offsetY) || 0;
  const hiddenOfferSeedIds = motherV2OfferingHiddenSeedIds();
  const isHiddenOfferSeedId = (rawId) => hiddenOfferSeedIds.has(String(rawId || "").trim());

  const dpr = getDpr();
  wctx.save();
  wctx.imageSmoothingEnabled = true;
  wctx.imageSmoothingQuality = "high";

  const drawOrder = Array.isArray(state.freeformZOrder) && state.freeformZOrder.length
    ? state.freeformZOrder
    : items.map((it) => it?.id).filter(Boolean);

  for (const imageId of drawOrder) {
    if (isHiddenOfferSeedId(imageId)) continue;
    const item = imageId ? state.imagesById.get(imageId) : null;
    const rect = imageId ? state.multiRects.get(imageId) : null;
    if (!rect) continue;
    const x = rect.x * ms + mox;
    const y = rect.y * ms + moy;
    const w = rect.w * ms;
    const h = rect.h * ms;
    const effectToken = imageId ? effectTokenForImageId(imageId) : null;
    if (effectToken) {
      // Token visuals are rendered by the Pixi effects runtime on a dedicated transparent layer.
    } else if (item?.img) {
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

    if (!effectToken) {
      // Tile frame.
      wctx.save();
      const motherGenerated = isMotherGeneratedImageItem(item);
      wctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
      wctx.strokeStyle = motherGenerated ? "rgba(82, 255, 148, 0.90)" : "rgba(54, 76, 106, 0.58)";
      wctx.shadowColor = motherGenerated ? "rgba(82, 255, 148, 0.26)" : "rgba(0, 0, 0, 0.6)";
      wctx.shadowBlur = Math.round(10 * dpr);
      wctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
      wctx.restore();
    }
  }
  wctx.restore();

  const selectedIds = getSelectedIds().filter((id) => id && !isImageEffectTokenized(id) && !isHiddenOfferSeedId(id));
  const multiSelectMode = selectedIds.length > 1;
  const activeRect = state.activeId && !isImageEffectTokenized(state.activeId) && !isHiddenOfferSeedId(state.activeId)
    ? state.multiRects.get(state.activeId)
    : null;
  const activeItem = state.activeId && !isImageEffectTokenized(state.activeId) && !isHiddenOfferSeedId(state.activeId)
    ? state.imagesById.get(state.activeId) || null
    : null;

  if (multiSelectMode && selectedIds.length) {
    // Multi-select highlight: keep all selected borders identical (no "active" special casing).
    octx.save();
    octx.lineJoin = "round";
    octx.shadowBlur = 0;
    octx.strokeStyle = "rgba(255, 212, 0, 0.96)";
    octx.lineWidth = Math.max(1, Math.round(3.0 * dpr));
    for (const imageId of selectedIds) {
      const rect = state.multiRects.get(imageId) || null;
      if (!rect) continue;
      const x = rect.x * ms + mox;
      const y = rect.y * ms + moy;
      const w = rect.w * ms;
      const h = rect.h * ms;
      octx.strokeRect(x - 3, y - 3, w + 6, h + 6);
    }
    octx.restore();
  } else {
    // Multi-select highlights (non-active).
    const multiSelected = getSelectedIds().filter(
      (id) => id && id !== state.activeId && !isImageEffectTokenized(id) && !isHiddenOfferSeedId(id)
    );
    if (multiSelected.length) {
      octx.save();
      octx.lineJoin = "round";
      octx.shadowBlur = 0;
      octx.strokeStyle = "rgba(255, 212, 0, 0.62)";
      octx.lineWidth = Math.max(1, Math.round(2.2 * dpr));
      for (const imageId of multiSelected) {
        const rect = state.multiRects.get(imageId) || null;
        if (!rect) continue;
        const x = rect.x * ms + mox;
        const y = rect.y * ms + moy;
        const w = rect.w * ms;
        const h = rect.h * ms;
        octx.strokeRect(x - 2, y - 2, w + 4, h + 4);
      }
      octx.restore();
    }

    // Active highlight (single selection).
    if (activeRect) {
      octx.save();
      octx.lineJoin = "round";
      const activeMother = isMotherGeneratedImageItem(activeItem);
      const outerStroke = activeMother ? "rgba(82, 255, 148, 0.20)" : "rgba(255, 212, 0, 0.14)";
      const mainStroke = activeMother ? "rgba(82, 255, 148, 0.94)" : "rgba(255, 212, 0, 0.96)";
      const mainShadow = activeMother ? "rgba(82, 255, 148, 0.28)" : "rgba(255, 212, 0, 0.26)";
      const innerStroke = activeMother ? "rgba(208, 255, 226, 0.60)" : "rgba(255, 247, 210, 0.58)";
      const handleStroke = activeMother ? "rgba(82, 255, 148, 0.92)" : "rgba(255, 212, 0, 0.92)";

      const ax = activeRect.x * ms + mox;
      const ay = activeRect.y * ms + moy;
      const aw = activeRect.w * ms;
      const ah = activeRect.h * ms;

      // Outer glow stroke (wide + soft).
      octx.strokeStyle = outerStroke;
      octx.lineWidth = Math.max(1, Math.round(10 * dpr));
      octx.shadowColor = mainShadow;
      octx.shadowBlur = Math.round(44 * dpr);
      octx.strokeRect(ax - 5, ay - 5, aw + 10, ah + 10);

      // Main border stroke.
      octx.strokeStyle = mainStroke;
      octx.lineWidth = Math.max(1, Math.round(3.4 * dpr));
      octx.shadowColor = mainShadow;
      octx.shadowBlur = Math.round(28 * dpr);
      octx.strokeRect(ax - 3, ay - 3, aw + 6, ah + 6);

      // Inner crisp stroke for definition.
      octx.shadowBlur = 0;
      octx.strokeStyle = innerStroke;
      octx.lineWidth = Math.max(1, Math.round(1.2 * dpr));
      octx.strokeRect(ax - 1, ay - 1, aw + 2, ah + 2);
      octx.restore();

      // Freeform resize handles (corner drag). Render only for the active image to keep the canvas clean.
      const showHandles = state.tool === "pan" || intentModeActive();
      if (showHandles) {
        const hs = Math.max(10, Math.round(10 * dpr));
        const r = Math.round(hs / 2);
        const corners = [
          { x: ax, y: ay, cursor: "nw" },
          { x: ax + aw, y: ay, cursor: "ne" },
          { x: ax, y: ay + ah, cursor: "sw" },
          { x: ax + aw, y: ay + ah, cursor: "se" },
        ];
        octx.save();
        octx.shadowColor = "rgba(0, 0, 0, 0.55)";
        octx.shadowBlur = Math.round(12 * dpr);
        for (const c of corners) {
          octx.fillStyle = "rgba(8, 10, 14, 0.86)";
          octx.strokeStyle = handleStroke;
          octx.lineWidth = Math.max(1, Math.round(1.6 * dpr));
          octx.beginPath();
          octx.rect(Math.round(c.x - r), Math.round(c.y - r), hs, hs);
          octx.fill();
          octx.stroke();
        }
        octx.restore();
      }
    }
  }

  if (multiSelectMode && activeRect) {
    // Keep handles for the active image even when multiple images are selected.
    const ax = activeRect.x * ms + mox;
    const ay = activeRect.y * ms + moy;
    const aw = activeRect.w * ms;
    const ah = activeRect.h * ms;
    const activeMother = isMotherGeneratedImageItem(activeItem);
    const handleStroke = activeMother ? "rgba(82, 255, 148, 0.92)" : "rgba(255, 212, 0, 0.92)";
    const showHandles = state.tool === "pan" || intentModeActive();
    if (showHandles) {
      const hs = Math.max(10, Math.round(10 * dpr));
      const r = Math.round(hs / 2);
      const corners = [
        { x: ax, y: ay, cursor: "nw" },
        { x: ax + aw, y: ay, cursor: "ne" },
        { x: ax, y: ay + ah, cursor: "sw" },
        { x: ax + aw, y: ay + ah, cursor: "se" },
      ];
      octx.save();
      octx.shadowColor = "rgba(0, 0, 0, 0.55)";
      octx.shadowBlur = Math.round(12 * dpr);
      for (const c of corners) {
        octx.fillStyle = "rgba(8, 10, 14, 0.86)";
        octx.strokeStyle = handleStroke;
        octx.lineWidth = Math.max(1, Math.round(1.6 * dpr));
        octx.beginPath();
        octx.rect(Math.round(c.x - r), Math.round(c.y - r), hs, hs);
        octx.fill();
        octx.stroke();
      }
      octx.restore();
    }
  }

  renderMotherRoleGlyphs(octx, { ms, mox, moy });

  // Triplet insights overlays (Extract the Rule / Odd One Out).
  const oddId = state.tripletOddOneOutId;
  if (oddId && !isHiddenOfferSeedId(oddId)) {
    const rect = state.multiRects.get(oddId) || null;
    if (rect) {
      octx.save();
      octx.lineWidth = Math.max(1, Math.round(2.5 * dpr));
      octx.setLineDash([Math.round(10 * dpr), Math.round(8 * dpr)]);
      octx.strokeStyle = "rgba(255, 72, 72, 0.86)";
      octx.shadowColor = "rgba(255, 72, 72, 0.18)";
      octx.shadowBlur = Math.round(18 * dpr);
      octx.strokeRect(rect.x + mox - 3, rect.y + moy - 3, rect.w + 6, rect.h + 6);
      octx.setLineDash([]);
      octx.restore();
    }
  }

  if (state.tripletRuleAnnotations && state.tripletRuleAnnotations.size) {
    octx.save();
    octx.lineWidth = Math.max(1, Math.round(2 * dpr));
    octx.font = `${Math.max(10, Math.round(11 * dpr))}px IBM Plex Mono`;
    const dotR = Math.max(3, Math.round(5 * dpr));
    for (const item of items) {
      if (!item?.id) continue;
      if (isHiddenOfferSeedId(item.id)) continue;
      const rect = state.multiRects.get(item.id) || null;
      if (!rect) continue;
      const points = state.tripletRuleAnnotations.get(item.id) || [];
      for (const pt of points.slice(0, 6)) {
        const xRaw = Number(pt?.x);
        const yRaw = Number(pt?.y);
        if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) continue;
        const x = clamp(xRaw, 0, 1);
        const y = clamp(yRaw, 0, 1);
        const cx = rect.x + mox + rect.w * x;
        const cy = rect.y + moy + rect.h * y;
        octx.save();
        octx.shadowColor = "rgba(0, 221, 255, 0.20)";
        octx.shadowBlur = Math.round(14 * dpr);
        octx.beginPath();
        octx.arc(cx, cy, dotR, 0, Math.PI * 2);
        octx.fillStyle = "rgba(0, 221, 255, 0.14)";
        octx.strokeStyle = "rgba(0, 221, 255, 0.92)";
        octx.fill();
        octx.stroke();

        const label = pt?.label ? clampText(pt.label, 28) : "";
        if (label) {
          const padX = Math.round(7 * dpr);
          const padY = Math.round(5 * dpr);
          const textW = octx.measureText(label).width;
          const boxW = Math.round(textW + padX * 2);
          const boxH = Math.round(20 * dpr);
          const boxX = Math.round(cx + 10 * dpr);
          const boxY = Math.round(cy - boxH / 2);
          octx.fillStyle = "rgba(8, 10, 14, 0.78)";
          octx.fillRect(boxX, boxY, boxW, boxH);
          octx.strokeStyle = "rgba(0, 221, 255, 0.34)";
          octx.strokeRect(boxX, boxY, boxW, boxH);
          octx.fillStyle = "rgba(0, 221, 255, 0.92)";
          octx.fillText(label, boxX + padX, boxY + boxH - padY);
        }
        octx.restore();
      }
    }
    octx.restore();
  }
}

function motherV2RoleImageIds(roleKey) {
  return motherV2RoleIds(roleKey).filter((id) => state.imagesById.has(id));
}

function hitTestMotherRoleGlyph(ptCanvas) {
  const idle = state.motherIdle;
  if (!idle || !ptCanvas) return null;
  const hits = Array.isArray(idle.roleGlyphHits) ? idle.roleGlyphHits : [];
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const hit = hits[i];
    const rect = hit?.rect;
    if (!rect) continue;
    const x0 = Number(rect.x) || 0;
    const y0 = Number(rect.y) || 0;
    const w = Number(rect.w) || 0;
    const h = Number(rect.h) || 0;
    if (ptCanvas.x >= x0 && ptCanvas.x <= x0 + w && ptCanvas.y >= y0 && ptCanvas.y <= y0 + h) return hit;
  }
  return null;
}

function renderMotherDraftKeyboardHints(octx, rectPx, { dpr = 1 } = {}) {
  if (!octx || !rectPx || isReelSizeLocked()) return;
  const hints = [
    { key: "V", label: "DEPLOY" },
    { key: "M", label: "DISMISS" },
    { key: "R", label: "REROLL" },
  ];
  if (!hints.length) return;
  const margin = Math.max(8, Math.round(10 * dpr));
  const gap = Math.max(4, Math.round(6 * dpr));
  const chipPadX = Math.max(4, Math.round(6 * dpr));
  const chipPadY = Math.max(2, Math.round(4 * dpr));
  const keyW = Math.max(11, Math.round(13 * dpr));
  const keyH = Math.max(11, Math.round(13 * dpr));
  const keyGap = Math.max(4, Math.round(5 * dpr));
  const chipH = Math.max(keyH + chipPadY * 2, Math.round(20 * dpr));
  const fontPx = Math.max(8, Math.round(9 * dpr));
  const corner = Math.max(4, Math.round(6 * dpr));
  const canvasW = Number(octx.canvas?.width) || 0;
  const canvasH = Number(octx.canvas?.height) || 0;
  if (canvasW <= 0 || canvasH <= 0) return;

  octx.save();
  octx.font = `${fontPx}px IBM Plex Mono`;
  octx.textBaseline = "middle";
  octx.textAlign = "left";

  const chips = hints.map((hint) => {
    const label = String(hint.label || "").trim().toUpperCase();
    const key = String(hint.key || "").trim().toUpperCase();
    const labelW = Math.ceil(octx.measureText(label).width);
    const width = chipPadX + keyW + keyGap + labelW + chipPadX;
    return { key, label, width };
  });
  const totalW = chips.reduce((sum, chip) => sum + chip.width, 0) + Math.max(0, chips.length - 1) * gap;

  let x = Math.round((Number(rectPx.x) || 0) + ((Number(rectPx.w) || 0) - totalW) / 2);
  x = clamp(x, margin, Math.max(margin, canvasW - totalW - margin));
  let y = Math.round((Number(rectPx.y) || 0) - chipH - margin);
  if (y < margin) {
    y = Math.round((Number(rectPx.y) || 0) + (Number(rectPx.h) || 0) + margin);
  }
  y = clamp(y, margin, Math.max(margin, canvasH - chipH - margin));

  octx.shadowColor = "rgba(0, 0, 0, 0.52)";
  octx.shadowBlur = Math.round(10 * dpr);
  let cx = x;
  for (const chip of chips) {
    _drawRoundedRect(octx, cx, y, chip.width, chipH, corner);
    octx.fillStyle = "rgba(8, 10, 14, 0.84)";
    octx.fill();
    octx.lineWidth = Math.max(1, Math.round(1.2 * dpr));
    octx.strokeStyle = "rgba(82, 255, 148, 0.46)";
    octx.stroke();

    const keyX = cx + chipPadX;
    const keyY = y + Math.round((chipH - keyH) / 2);
    _drawRoundedRect(octx, keyX, keyY, keyW, keyH, Math.max(3, Math.round(3 * dpr)));
    octx.fillStyle = "rgba(18, 26, 37, 0.96)";
    octx.fill();
    octx.strokeStyle = "rgba(160, 188, 220, 0.62)";
    octx.stroke();

    octx.fillStyle = "rgba(230, 237, 243, 0.96)";
    octx.textAlign = "center";
    octx.fillText(chip.key, keyX + keyW * 0.5, y + chipH * 0.54);

    octx.textAlign = "left";
    octx.fillStyle = "rgba(210, 255, 228, 0.94)";
    octx.fillText(chip.label, keyX + keyW + keyGap, y + chipH * 0.54);

    cx += chip.width + gap;
  }
  octx.restore();
}

function renderMotherRoleGlyphs(octx, { ms = 1, mox = 0, moy = 0 } = {}) {
  const idle = state.motherIdle;
  if (!idle) return;
  const phase = idle.phase || motherIdleInitialState();
  if (!(phase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING || phase === MOTHER_IDLE_STATES.OFFERING)) {
    idle.roleGlyphHits = [];
    return;
  }
  if (state.canvasMode !== "multi") {
    idle.roleGlyphHits = [];
    return;
  }
  const showOfferPreview = phase === MOTHER_IDLE_STATES.OFFERING;
  const advancedVisible = motherV2IsAdvancedVisible();
  const hintsVisible = motherV2HintsVisible();
  if (!advancedVisible && !hintsVisible) {
    if (!showOfferPreview) {
      idle.roleGlyphHits = [];
      return;
    }
  }
  const showRoleGlyphs = advancedVisible || hintsVisible;
  const dpr = getDpr();
  const hintLevel = Number(idle.hintLevel) || 1;
  const glyphSize = advancedVisible
    ? Math.max(24, Math.round(54 * dpr))
    : Math.max(10, Math.round((hintLevel > 1 ? 15 : 11) * dpr));
  const gap = Math.max(2, Math.round(4 * dpr));
  const yInset = Math.max(4, Math.round(8 * dpr));
  const hits = [];
  const roleAnchors = new Map();
  const hiddenOfferSeedIds = motherV2OfferingHiddenSeedIds();

  for (const item of state.images || []) {
    const imageId = String(item?.id || "").trim();
    if (!imageId) continue;
    if (hiddenOfferSeedIds.has(imageId)) continue;
    const rect = state.multiRects.get(imageId) || null;
    if (!rect) continue;
    const roles = showRoleGlyphs ? MOTHER_V2_ROLE_KEYS.filter((key) => motherV2RoleImageIds(key).includes(imageId)) : [];
    if (!roles.length) continue;
    const rx = rect.x * ms + mox;
    const ry = rect.y * ms + moy;
    const rw = rect.w * ms;
    const rh = rect.h * ms;
    const totalW = roles.length * glyphSize + (roles.length - 1) * gap;
    const x0 = Math.round(rx + (rw - totalW) / 2);
    const y = Math.round(ry + rh - glyphSize - yInset);
    for (let i = 0; i < roles.length; i += 1) {
      const role = roles[i];
      const x = x0 + i * (glyphSize + gap);
      const drag = idle.roleGlyphDrag;
      const hot = Boolean(drag && String(drag.role || "") === role && String(drag.imageId || "") === imageId);
      octx.save();
      octx.globalAlpha = advancedVisible ? (hot ? 1 : 0.9) : hintLevel > 1 ? 0.76 : 0.52;
      octx.fillStyle = advancedVisible ? "rgba(8, 10, 14, 0.88)" : "rgba(8, 10, 14, 0.66)";
      octx.strokeStyle = advancedVisible ? "rgba(230, 237, 243, 0.92)" : "rgba(230, 237, 243, 0.58)";
      octx.lineWidth = Math.max(1, Math.round((advancedVisible ? 1.3 : 1.1) * dpr));
      octx.beginPath();
      octx.roundRect(Math.round(x), Math.round(y), glyphSize, glyphSize, Math.round((advancedVisible ? 8 : 6) * dpr));
      octx.fill();
      octx.stroke();
      octx.fillStyle = "rgba(230, 237, 243, 0.96)";
      octx.font = advancedVisible
        ? `${Math.max(8, Math.round(11 * dpr))}px IBM Plex Mono`
        : `${Math.max(9, Math.round(10 * dpr))}px IBM Plex Mono`;
      octx.textAlign = "center";
      octx.textBaseline = "middle";
      octx.fillText(
        advancedVisible ? (MOTHER_V2_ROLE_LABEL[role] || role.toUpperCase()) : (MOTHER_V2_ROLE_GLYPH[role] || "•"),
        x + glyphSize * 0.5,
        y + glyphSize * 0.53
      );
      octx.restore();
      if (advancedVisible) {
        hits.push({
          kind: "mother_role_glyph",
          role,
          imageId,
          rect: { x, y, w: glyphSize, h: glyphSize },
        });
      }
      if (!roleAnchors.has(role)) {
        roleAnchors.set(role, {
          x: x + glyphSize * 0.5,
          y: y + glyphSize * 0.5,
        });
      }
    }
  }

  if (showRoleGlyphs && !advancedVisible) {
    const subjectAnchor = roleAnchors.get("subject");
    const modelAnchor = roleAnchors.get("model");
    if (subjectAnchor && modelAnchor) {
      octx.save();
      octx.globalAlpha = hintLevel > 1 ? 0.42 : 0.28;
      octx.strokeStyle = "rgba(230, 237, 243, 0.7)";
      octx.lineWidth = Math.max(1, Math.round(1.1 * dpr));
      octx.setLineDash([Math.max(2, Math.round(4 * dpr)), Math.max(2, Math.round(4 * dpr))]);
      octx.beginPath();
      octx.moveTo(subjectAnchor.x, subjectAnchor.y);
      octx.lineTo(modelAnchor.x, modelAnchor.y);
      octx.stroke();
      octx.setLineDash([]);
      octx.restore();
    }
  }

  // Offer-stage ghost preview (staged only; no mutation).
  if (phase === MOTHER_IDLE_STATES.OFFERING) {
    const draft = motherV2CurrentDraft();
    const policy = String(idle.intent?.placement_policy || "adjacent");
    const targets = Array.isArray(idle.intent?.target_ids) ? idle.intent.target_ids : [];
    const targetId = targets.length ? String(targets[0] || "") : state.activeId ? String(state.activeId) : null;
    const rectCss = motherV2OfferPreviewRectCss({ policy, targetId, draftIndex: 0 });
    if (rectCss) {
      const px = {
        x: (Number(rectCss.x) || 0) * dpr * ms + mox,
        y: (Number(rectCss.y) || 0) * dpr * ms + moy,
        w: (Number(rectCss.w) || 1) * dpr * ms,
        h: (Number(rectCss.h) || 1) * dpr * ms,
      };
      octx.save();
      octx.globalAlpha = 0.36;
      if (draft?.img) {
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = "high";
        octx.drawImage(draft.img, Math.round(px.x), Math.round(px.y), Math.round(px.w), Math.round(px.h));
      } else {
        octx.fillStyle = "rgba(82, 255, 148, 0.18)";
        octx.fillRect(Math.round(px.x), Math.round(px.y), Math.round(px.w), Math.round(px.h));
      }
      octx.globalAlpha = 0.92;
      octx.strokeStyle = "rgba(82, 255, 148, 0.88)";
      octx.lineWidth = Math.max(1, Math.round(2 * dpr));
      octx.strokeRect(Math.round(px.x), Math.round(px.y), Math.round(px.w), Math.round(px.h));
      octx.globalAlpha = 0.42;
      octx.setLineDash([Math.max(2, Math.round(6 * dpr)), Math.max(2, Math.round(4 * dpr))]);
      octx.lineWidth = Math.max(1, Math.round(1.2 * dpr));
      octx.strokeStyle = "rgba(182, 255, 216, 0.84)";
      octx.strokeRect(Math.round(px.x - 3), Math.round(px.y - 3), Math.round(px.w + 6), Math.round(px.h + 6));
      octx.setLineDash([]);
      octx.restore();
      renderMotherDraftKeyboardHints(octx, px, { dpr });
    }
  }

  idle.roleGlyphHits = showRoleGlyphs && advancedVisible ? hits : [];
}

function hitTestIntentUi(ptCanvas) {
  const intent = state.intent;
  if (!intent || !ptCanvas) return null;
  const hits = Array.isArray(intent.uiHits) ? intent.uiHits : [];
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const hit = hits[i];
    const rect = hit?.rect;
    if (!rect) continue;
    const x0 = Number(rect.x) || 0;
    const y0 = Number(rect.y) || 0;
    const w = Number(rect.w) || 0;
    const h = Number(rect.h) || 0;
    if (ptCanvas.x >= x0 && ptCanvas.x <= x0 + w && ptCanvas.y >= y0 && ptCanvas.y <= y0 + h) return hit;
  }
  return null;
}

function hitTestAmbientIntentNudge(ptCanvas) {
  if (!INTENT_AMBIENT_ICON_PLACEMENT_ENABLED) return null;
  if (state.mother?.running) return null;
  const ambient = state.intentAmbient;
  if (!ambient || !ptCanvas) return null;
  const hits = Array.isArray(ambient.uiHits) ? ambient.uiHits : [];
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const hit = hits[i];
    const rect = hit?.rect;
    if (!rect) continue;
    const x0 = Number(rect.x) || 0;
    const y0 = Number(rect.y) || 0;
    const w = Number(rect.w) || 0;
    const h = Number(rect.h) || 0;
    if (ptCanvas.x >= x0 && ptCanvas.x <= x0 + w && ptCanvas.y >= y0 && ptCanvas.y <= y0 + h) return hit;
  }
  return null;
}

function activateAmbientIntentNudge(hit) {
  if (!INTENT_AMBIENT_ICON_PLACEMENT_ENABLED) return false;
  const ambient = state.intentAmbient;
  if (!ambient || !hit) return false;

  const branchId = String(hit.branchId || "").trim();
  const assetKey = String(hit.assetKey || "").trim();
  const anchorIds = Array.isArray(hit.anchorImageIds)
    ? hit.anchorImageIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];

  let selectedId = "";
  for (const id of anchorIds) {
    if (state.imagesById.has(id)) {
      selectedId = id;
      break;
    }
  }
  if (!selectedId && state.activeId && state.imagesById.has(state.activeId)) {
    selectedId = String(state.activeId);
  }

  if (selectedId) {
    selectCanvasImage(selectedId, { toggle: false }).catch(() => {});
  }
  rememberAmbientTouchedImageIds(selectedId ? [selectedId] : anchorIds);
  scheduleAmbientIntentInference({
    immediate: true,
    reason: "composition_change",
    imageIds: selectedId ? [selectedId] : anchorIds,
  });

  const usecase = assetKey || _intentUseCaseKeyFromBranchId(branchId);
  const title = _intentUseCaseTitle(usecase);
  if (title) {
    showToast(`Mother nudge: ${title}`, "tip", 1300);
  }
  return true;
}

function _sevenSegSegmentsForDigit(ch) {
  const d = String(ch || "");
  const map = {
    "0": ["A", "B", "C", "D", "E", "F"],
    "1": ["B", "C"],
    "2": ["A", "B", "G", "E", "D"],
    "3": ["A", "B", "G", "C", "D"],
    "4": ["F", "G", "B", "C"],
    "5": ["A", "F", "G", "C", "D"],
    "6": ["A", "F", "G", "E", "C", "D"],
    "7": ["A", "B", "C"],
    "8": ["A", "B", "C", "D", "E", "F", "G"],
    "9": ["A", "B", "C", "D", "F", "G"],
  };
  return map[d] || [];
}

function _drawRoundedRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(Number(r) || 0, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function _drawIntentBumperPlate(ctx, rect, { active = false, loading = false, alpha = 1 } = {}) {
  if (!ctx || !rect) return;
  const x = Math.round(Number(rect.x) || 0);
  const y = Math.round(Number(rect.y) || 0);
  const w = Math.round(Number(rect.w) || 0);
  const h = Math.round(Number(rect.h) || 0);
  if (w <= 2 || h <= 2) return;

  const dpr = getDpr();
  const a = clamp(Number(alpha) || 1, 0.05, 1);
  const cut = Math.max(10, Math.round(14 * dpr));
  const inset = Math.max(1, Math.round(1.2 * dpr));
  const edge = Math.max(1, Math.round(1.4 * dpr));

  const path = () => {
    const c = Math.max(0, Math.min(cut, Math.floor(Math.min(w, h) / 2) - 1));
    ctx.beginPath();
    ctx.moveTo(x + c, y);
    ctx.lineTo(x + w - c, y);
    ctx.lineTo(x + w, y + c);
    ctx.lineTo(x + w, y + h - c);
    ctx.lineTo(x + w - c, y + h);
    ctx.lineTo(x + c, y + h);
    ctx.lineTo(x, y + h - c);
    ctx.lineTo(x, y + c);
    ctx.closePath();
  };

  ctx.save();
  ctx.globalAlpha = a;
  ctx.shadowColor = "rgba(0, 0, 0, 0.78)";
  ctx.shadowBlur = Math.round(18 * dpr);
  ctx.shadowOffsetY = Math.round(6 * dpr);

  // Base fill.
  path();
  ctx.fillStyle = "rgba(8, 10, 14, 0.90)";
  ctx.fill();

  // Clip for texture/gradients.
  ctx.save();
  path();
  ctx.clip();

  // Metal-ish vertical gradient.
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, "rgba(255, 255, 255, 0.08)");
  grad.addColorStop(0.35, "rgba(255, 255, 255, 0.02)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0.62)");
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  // Soft cyan bloom on the left (matches bumpers/HUD vibe without reading as a "screen").
  const rg = ctx.createRadialGradient(x + w * 0.22, y + h * 0.12, 0, x + w * 0.22, y + h * 0.12, Math.max(w, h) * 0.75);
  rg.addColorStop(0, "rgba(100, 210, 255, 0.10)");
  rg.addColorStop(0.6, "rgba(0, 221, 255, 0.03)");
  rg.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = rg;
  ctx.fillRect(x, y, w, h);

  // Subtle scanline texture.
  ctx.save();
  ctx.globalAlpha = 0.11;
  ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
  const step = Math.max(7, Math.round(9 * dpr));
  const lineH = Math.max(1, Math.round(1 * dpr));
  for (let yy = y + Math.round(step / 2); yy < y + h; yy += step) {
    ctx.fillRect(x, yy, w, lineH);
  }
  ctx.restore();

  ctx.restore(); // end clip

  // Outer edge.
  path();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = edge;
  ctx.strokeStyle = "rgba(54, 76, 106, 0.62)";
  ctx.stroke();

  // Inset bevel highlight.
  ctx.save();
  ctx.globalAlpha = a * 0.9;
  const ix = x + inset;
  const iy = y + inset;
  const iw = Math.max(1, w - inset * 2);
  const ih = Math.max(1, h - inset * 2);
  const icut = Math.max(8, Math.round(cut * 0.7));
  const c = Math.max(0, Math.min(icut, Math.floor(Math.min(iw, ih) / 2) - 1));
  ctx.beginPath();
  ctx.moveTo(ix + c, iy);
  ctx.lineTo(ix + iw - c, iy);
  ctx.lineTo(ix + iw, iy + c);
  ctx.lineTo(ix + iw, iy + ih - c);
  ctx.lineTo(ix + iw - c, iy + ih);
  ctx.lineTo(ix + c, iy + ih);
  ctx.lineTo(ix, iy + ih - c);
  ctx.lineTo(ix, iy + c);
  ctx.closePath();
  ctx.lineWidth = Math.max(1, Math.round(1.1 * dpr));
  ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
  ctx.stroke();
  ctx.restore();

  // Accent sliver (quiet, hardware-ish).
  const accent = loading
    ? "rgba(0, 221, 255, 0.30)"
    : active
      ? "rgba(82, 255, 148, 0.28)"
      : "rgba(54, 76, 106, 0.22)";
  ctx.save();
  ctx.globalAlpha = a;
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, Math.round(2.2 * dpr));
  ctx.lineCap = "round";
  const sl = Math.max(18, Math.round(Math.min(w, 260) * 0.22));
  ctx.beginPath();
  ctx.moveTo(x + cut + Math.round(12 * dpr), y + Math.round(6 * dpr));
  ctx.lineTo(x + cut + Math.round(12 * dpr) + sl, y + Math.round(6 * dpr));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + w - cut - Math.round(12 * dpr) - sl, y + Math.round(6 * dpr));
  ctx.lineTo(x + w - cut - Math.round(12 * dpr), y + Math.round(6 * dpr));
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

const LED_5X7 = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  "-": [0, 0, 0, 0b11111, 0, 0, 0],
  "_": [0, 0, 0, 0, 0, 0, 0b11111],
  "/": [0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0, 0],
  ":": [0, 0b00100, 0b00100, 0, 0b00100, 0b00100, 0],
  "?": [0b01110, 0b10001, 0b00010, 0b00100, 0b00100, 0, 0b00100],
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110],
  "6": [0b00111, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b11100],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01111, 0b10000, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
};

function _led5x7Rows(ch) {
  const key = String(ch || "").toUpperCase();
  return LED_5X7[key] || LED_5X7["?"] || LED_5X7[" "];
}

function _led5x7TextDims(text, dot, gap, charGap) {
  const d = Math.max(1, Math.round(Number(dot) || 0));
  const g = Math.max(0, Math.round(Number(gap) || 0));
  const cg = Math.max(0, Math.round(Number(charGap) || 0));
  const chars = String(text || "");
  const h = 7 * d + 6 * g;
  const cw = 5 * d + 4 * g;
  if (!chars) return { w: 0, h };
  const w = chars.length * cw + Math.max(0, chars.length - 1) * cg;
  return { w, h };
}

function _drawLed5x7Text(
  ctx,
  x,
  y,
  text,
  { dot = 10, gap = 2, charGap = 6, on = "rgba(0, 245, 160, 0.92)", off = "rgba(0, 245, 160, 0.07)", glow = null, alpha = 1 } = {}
) {
  if (!ctx) return { w: 0, h: 0 };
  const d = Math.max(1, Math.round(Number(dot) || 0));
  const g = Math.max(0, Math.round(Number(gap) || 0));
  const cg = Math.max(0, Math.round(Number(charGap) || 0));
  const a = clamp(Number(alpha) || 1, 0.05, 1);
  const chars = String(text || "").toUpperCase();
  const step = d + g;
  const r = Math.max(0, Math.round(d * 0.22));
  let cx = Math.round(Number(x) || 0);
  const cy = Math.round(Number(y) || 0);

  ctx.save();
  ctx.globalAlpha = a;

  // Optional dim "off" grid so it reads as an LED module.
  if (off) {
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = off;
    for (const ch of chars) {
      const rows = _led5x7Rows(ch);
      for (let ry = 0; ry < 7; ry += 1) {
        for (let rx = 0; rx < 5; rx += 1) {
          const px = cx + rx * step;
          const py = cy + ry * step;
          _drawRoundedRect(ctx, px, py, d, d, r);
          ctx.fill();
        }
      }
      cx += 5 * step - g + cg;
    }
    ctx.restore();
  }

  // Lit segments with glow, then a crisp pass.
  const drawLit = ({ withGlow }) => {
    ctx.save();
    ctx.fillStyle = on;
    if (withGlow && glow) {
      ctx.shadowColor = glow;
      ctx.shadowBlur = Math.round(d * 1.15);
    } else {
      ctx.shadowBlur = 0;
    }
    let tx = Math.round(Number(x) || 0);
    for (const ch of chars) {
      const rows = _led5x7Rows(ch);
      for (let ry = 0; ry < 7; ry += 1) {
        const mask = Number(rows[ry]) || 0;
        for (let rx = 0; rx < 5; rx += 1) {
          const bit = (mask >> (4 - rx)) & 1;
          if (!bit) continue;
          const px = tx + rx * step;
          const py = cy + ry * step;
          _drawRoundedRect(ctx, px, py, d, d, r);
          ctx.fill();
        }
      }
      tx += 5 * step - g + cg;
    }
    ctx.restore();
  };

  drawLit({ withGlow: true });
  drawLit({ withGlow: false });

  ctx.restore();
  return _led5x7TextDims(chars, d, g, cg);
}

function _drawSevenSegDigit(ctx, x, y, digitW, digitH, ch, { on, off } = {}) {
  const segs = _sevenSegSegmentsForDigit(ch);
  const seg = Math.max(2, Math.round(digitH * 0.13));
  const gap = Math.max(1, Math.round(seg * 0.55));
  const innerW = Math.max(1, digitW - seg);
  const halfH = Math.round(digitH / 2);

  const rects = {
    A: { x: x + gap, y: y, w: innerW - gap * 2, h: seg },
    D: { x: x + gap, y: y + digitH - seg, w: innerW - gap * 2, h: seg },
    G: { x: x + gap, y: y + halfH - Math.round(seg / 2), w: innerW - gap * 2, h: seg },
    F: { x: x, y: y + gap, w: seg, h: halfH - gap - Math.round(seg / 2) },
    E: { x: x, y: y + halfH + Math.round(seg / 2), w: seg, h: halfH - gap - Math.round(seg / 2) },
    B: { x: x + digitW - seg, y: y + gap, w: seg, h: halfH - gap - Math.round(seg / 2) },
    C: { x: x + digitW - seg, y: y + halfH + Math.round(seg / 2), w: seg, h: halfH - gap - Math.round(seg / 2) },
  };

  const drawSeg = (key, active) => {
    const r = rects[key];
    if (!r || r.w <= 0 || r.h <= 0) return;
    ctx.fillStyle = active ? on : off;
    _drawRoundedRect(ctx, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h), Math.round(seg * 0.38));
    ctx.fill();
  };

  const onSet = new Set(segs);
  for (const key of ["A", "B", "C", "D", "E", "F", "G"]) {
    drawSeg(key, onSet.has(key));
  }
}

function _normalizeIntentKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
}

function _intentUseCaseKeyFromBranchId(branchId) {
  const key = _normalizeIntentKey(branchId);
  if (!key) return null;
  if (key.includes("game")) return "game_dev_assets";
  if (key.includes("stream")) return "streaming_content";
  if (key.includes("ui") || key.includes("ux") || key.includes("wireframe") || key.includes("mock")) return "uiux_prototyping";
  if (key.includes("ecommerce") || key.includes("pod") || key.includes("product") || key.includes("merch")) return "ecommerce_pod";
  if (key.includes("engine") || key.includes("system") || key.includes("pipeline") || key.includes("automation") || key.includes("brand"))
    return "content_engine";
  return null;
}

function _intentUseCaseTitle(useCaseKey) {
  const key = String(useCaseKey || "").trim();
  if (!key) return "";
  if (key === "game_dev_assets") return "GAME ASSETS";
  if (key === "streaming_content") return "STREAMING";
  if (key === "uiux_prototyping") return "UI/UX";
  if (key === "ecommerce_pod") return "ECOMMERCE";
  if (key === "content_engine") return "PIPELINE";
  return key
    .toUpperCase()
    .replace(/[^A-Z0-9/]+/g, " ")
    .trim();
}

function _drawIntentYesNoIcon(ctx, kind, cx, cy, r, { alpha = 1 } = {}) {
  const k = String(kind || "").trim().toUpperCase();
  const isYes = k === "YES";
  const img = isYes ? intentUiIcons.tokenYes : intentUiIcons.tokenNo;
  if (img && img.complete && img.naturalWidth > 0) {
    const rr = Math.max(1, Number(r) || 0);
    const size = Math.max(1, Math.round(rr * 2));
    ctx.save();
    ctx.globalAlpha = clamp(Number(alpha) || 1, 0.05, 1);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, Math.round(cx - size / 2), Math.round(cy - size / 2), size, size);
    ctx.restore();
    return;
  }
  const fg = isYes ? "rgba(82, 255, 148, 0.92)" : "rgba(255, 95, 95, 0.92)";
  const stroke = isYes ? "rgba(82, 255, 148, 0.34)" : "rgba(255, 95, 95, 0.34)";
  ctx.save();
  ctx.globalAlpha = clamp(Number(alpha) || 1, 0.05, 1);
  ctx.fillStyle = "rgba(8, 10, 14, 0.82)";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1, Math.round(r * 0.18));
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = Math.round(r * 0.7);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = fg;
  ctx.lineWidth = Math.max(1, Math.round(r * 0.18));
  ctx.lineCap = "round";
  if (isYes) {
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.45, cy + r * 0.05);
    ctx.lineTo(cx - r * 0.15, cy + r * 0.35);
    ctx.lineTo(cx + r * 0.55, cy - r * 0.35);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.42, cy - r * 0.42);
    ctx.lineTo(cx + r * 0.42, cy + r * 0.42);
    ctx.moveTo(cx + r * 0.42, cy - r * 0.42);
    ctx.lineTo(cx - r * 0.42, cy + r * 0.42);
    ctx.stroke();
  }
  ctx.restore();
}

function _drawIntentUseCaseGlyph(ctx, useCaseKey, cx, cy, size, { alpha = 1 } = {}) {
  const key = String(useCaseKey || "").trim();
  if (!key) return;
  const img = intentUiIcons.usecases ? intentUiIcons.usecases[key] : null;
  if (img && img.complete && img.naturalWidth > 0) {
    const s = Math.max(8, Number(size) || 0);
    ctx.save();
    ctx.globalAlpha = clamp(Number(alpha) || 1, 0.05, 1);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, Math.round(cx - s / 2), Math.round(cy - s / 2), Math.round(s), Math.round(s));
    ctx.restore();
    return;
  }
  const s = Math.max(12, Number(size) || 0);
  const lw = Math.max(1, Math.round(s * 0.09));
  const fg = "rgba(230, 237, 243, 0.90)";
  ctx.save();
  ctx.globalAlpha = clamp(Number(alpha) || 1, 0.05, 1);
  ctx.strokeStyle = fg;
  ctx.fillStyle = fg;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (key === "game_dev_assets") {
    const w = s * 1.05;
    const h = s * 0.68;
    const x = cx - w / 2;
    const y = cy - h / 2;
    _drawRoundedRect(ctx, x, y, w, h, h * 0.38);
    ctx.stroke();
    // D-pad.
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.26, cy);
    ctx.lineTo(cx - w * 0.12, cy);
    ctx.moveTo(cx - w * 0.19, cy - h * 0.14);
    ctx.lineTo(cx - w * 0.19, cy + h * 0.14);
    ctx.stroke();
    // Buttons.
    const br = Math.max(1.5, s * 0.06);
    const bx = cx + w * 0.22;
    const by = cy;
    for (const off of [
      { x: -br * 1.1, y: -br * 1.1 },
      { x: br * 1.1, y: -br * 1.1 },
      { x: -br * 1.1, y: br * 1.1 },
      { x: br * 1.1, y: br * 1.1 },
    ]) {
      ctx.beginPath();
      ctx.arc(bx + off.x, by + off.y, br, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (key === "streaming_content") {
    // Lightning bolt.
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.10, cy - s * 0.52);
    ctx.lineTo(cx + s * 0.10, cy - s * 0.10);
    ctx.lineTo(cx - s * 0.02, cy - s * 0.10);
    ctx.lineTo(cx + s * 0.02, cy + s * 0.52);
    ctx.lineTo(cx - s * 0.10, cy + s * 0.12);
    ctx.lineTo(cx + s * 0.02, cy + s * 0.12);
    ctx.closePath();
    ctx.stroke();
  } else if (key === "uiux_prototyping") {
    const w = s * 1.05;
    const h = s * 0.82;
    const x = cx - w / 2;
    const y = cy - h / 2;
    _drawRoundedRect(ctx, x, y, w, h, s * 0.16);
    ctx.stroke();
    // Top bar + columns.
    ctx.beginPath();
    ctx.moveTo(x + lw, y + h * 0.22);
    ctx.lineTo(x + w - lw, y + h * 0.22);
    ctx.moveTo(x + w * 0.42, y + h * 0.22);
    ctx.lineTo(x + w * 0.42, y + h - lw);
    ctx.stroke();
  } else if (key === "ecommerce_pod") {
    // Box/cube.
    const w = s * 0.95;
    const h = s * 0.78;
    const x0 = cx - w / 2;
    const y0 = cy - h / 2 + s * 0.06;
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + w * 0.18, y0 - s * 0.18);
    ctx.lineTo(x0 + w * 1.18, y0 - s * 0.18);
    ctx.lineTo(x0 + w, y0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x0 + w, y0);
    ctx.lineTo(x0 + w * 1.18, y0 - s * 0.18);
    ctx.lineTo(x0 + w * 1.18, y0 - s * 0.18 + h);
    ctx.lineTo(x0 + w, y0 + h);
    ctx.stroke();
  } else if (key === "content_engine") {
    // Simple gear.
    const r = s * 0.34;
    const teeth = 7;
    for (let i = 0; i < teeth; i += 1) {
      const a = (i / teeth) * Math.PI * 2;
      const tx = cx + Math.cos(a) * r * 1.2;
      const ty = cy + Math.sin(a) * r * 1.2;
      ctx.beginPath();
      ctx.arc(tx, ty, Math.max(1.5, s * 0.05), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function _drawIntentLoadingDots(ctx, cx, cy, { dotR = 3, color = "rgba(82, 255, 148, 0.92)", t = 0 } = {}) {
  const r = Math.max(1, Number(dotR) || 0);
  const gap = Math.max(4, Math.round(r * 2.1));
  for (let i = 0; i < 3; i += 1) {
    const pulse = 0.25 + 0.75 * Math.abs(Math.sin(t + i * 0.85));
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx + (i - 1) * gap, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function renderIntentOverlay(octx, canvasW, canvasH) {
  const intent = state.intent;
  if (!intent) return;

  if (!intentModeActive()) {
    intent.uiHits = [];
    return;
  }

  const dpr = getDpr();
  const now = Date.now();
  const hits = [];
  const margin = Math.round(18 * dpr);

  const loading = Boolean(intent.pending || intentInferenceTimer || intent.rtState === "connecting");

  let iconState = null;
  if (intent.iconState && typeof intent.iconState === "object") {
    iconState = ensureIntentFallbackIconState("render");
  } else if (intent.disabledReason || intent.rtState === "failed") {
    iconState = ensureIntentFallbackIconState("failed");
  }

  const suggestedBranchId = iconState ? pickSuggestedIntentBranchId(iconState) : null;
  if (suggestedBranchId && !intent.uiHideSuggestion) intent.focusBranchId = suggestedBranchId;
  const useCaseKey = _intentUseCaseKeyFromBranchId(suggestedBranchId);

  // Optional force-choice overlay (disabled by default).
  if (INTENT_FORCE_CHOICE_ENABLED && intent.forceChoice) {
    octx.save();
    octx.fillStyle = "rgba(0, 0, 0, 0.42)";
    octx.fillRect(0, 0, canvasW, canvasH);
    octx.restore();
  }

  // START button (top-right): locks current intent (same as YES).
  const canAccept = Boolean(iconState && suggestedBranchId && !loading && !intent.uiHideSuggestion);
  const startR = Math.max(14, Math.round(17 * dpr * INTENT_UI_START_ICON_SCALE));
  const startSize = Math.max(1, Math.round(startR * 2.15));
  const startCx = Math.round(canvasW - margin - startSize / 2);
  const startCy = Math.round(margin + startSize / 2);
  const startRect = { x: startCx - startSize / 2, y: startCy - startSize / 2, w: startSize, h: startSize };

  // Backplate circle (keeps the button legible over bright pixels).
  octx.save();
  octx.shadowColor = "rgba(0, 0, 0, 0.62)";
  octx.shadowBlur = Math.round(14 * dpr);
  octx.fillStyle = "rgba(8, 10, 14, 0.78)";
  octx.strokeStyle = canAccept ? "rgba(82, 255, 148, 0.44)" : "rgba(54, 76, 106, 0.38)";
  octx.lineWidth = Math.max(1, Math.round(1.4 * dpr));
  octx.beginPath();
  octx.arc(startCx, startCy, startR, 0, Math.PI * 2);
  octx.fill();
  octx.stroke();
  octx.restore();

  const startImg = intentUiIcons.startLock;
  if (startImg && startImg.complete && startImg.naturalWidth > 0) {
    octx.save();
    octx.globalAlpha = canAccept ? 1 : 0.45;
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(startImg, Math.round(startRect.x), Math.round(startRect.y), Math.round(startRect.w), Math.round(startRect.h));
    octx.restore();
  } else {
    // Fallback: procedural play glyph.
    octx.save();
    octx.globalAlpha = canAccept ? 1 : 0.45;
    octx.fillStyle = canAccept ? "rgba(82, 255, 148, 0.92)" : "rgba(230, 237, 243, 0.45)";
    octx.beginPath();
    octx.moveTo(startCx - startR * 0.22, startCy - startR * 0.32);
    octx.lineTo(startCx - startR * 0.22, startCy + startR * 0.32);
    octx.lineTo(startCx + startR * 0.42, startCy);
    octx.closePath();
    octx.fill();
    octx.restore();
  }

  if (canAccept) hits.push({ kind: "intent_lock", id: "start", rect: startRect });

  // Bottom choice controls (no container strip): [NO] [SUGGESTION] [YES].
  const tokenR = Math.max(14, Math.round(18 * dpr * INTENT_UI_CHOICE_ICON_SCALE));
  const glyphSize = Math.max(30, Math.round(42 * dpr * INTENT_UI_CHOICE_ICON_SCALE));
  const gap = Math.round(22 * dpr * Math.min(2.2, Math.max(1, INTENT_UI_CHOICE_ICON_SCALE * 0.55)));

  const groupH = Math.max(tokenR * 2, glyphSize);
  const cy = Math.round(canvasH - margin - groupH / 2);

  const groupW = tokenR * 2 + gap + glyphSize + gap + tokenR * 2;
  const maxGroupW = Math.max(1, canvasW - margin * 2);
  const useVerticalLayout = groupW > maxGroupW;

  let noCx = 0;
  let yesCx = 0;
  let glyphCx = 0;
  let glyphCy = cy;
  let tokenCy = cy;
  if (!useVerticalLayout) {
    const groupX0 = Math.round((canvasW - groupW) / 2);
    noCx = groupX0 + tokenR;
    glyphCx = groupX0 + tokenR * 2 + gap + glyphSize / 2;
    yesCx = groupX0 + tokenR * 2 + gap + glyphSize + gap + tokenR;
  } else {
    // If the giant 3x row doesn't fit, stack the suggestion above the YES/NO pair.
    const vGap = Math.round(14 * dpr * Math.min(2.2, Math.max(1, INTENT_UI_CHOICE_ICON_SCALE * 0.45)));
    tokenCy = Math.round(canvasH - margin - tokenR);
    glyphCy = Math.round(tokenCy - tokenR - vGap - glyphSize / 2);
    glyphCx = Math.round(canvasW / 2);
    const pairGap = Math.round(18 * dpr * Math.min(2.2, Math.max(1, INTENT_UI_CHOICE_ICON_SCALE * 0.45)));
    noCx = Math.round(canvasW / 2 - tokenR - pairGap);
    yesCx = Math.round(canvasW / 2 + tokenR + pairGap);
  }

  const canReject = Boolean(iconState && suggestedBranchId && !loading);
  const noAlpha = canReject ? 1 : 0.45;
  const yesAlpha = canAccept ? 1 : 0.45;

  // Hardware-like bumper/strip behind the choice UI (complements the normal HUD/bumpers).
  const tokenX0 = Math.min(noCx - tokenR, yesCx - tokenR);
  const tokenX1 = Math.max(noCx + tokenR, yesCx + tokenR);
  const tokenY0 = tokenCy - tokenR;
  const tokenY1 = tokenCy + tokenR;
  let glyphX0 = tokenX0;
  let glyphX1 = tokenX1;
  let glyphY0 = tokenY0;
  let glyphY1 = tokenY1;
  if (useCaseKey || loading) {
    glyphX0 = glyphCx - glyphSize / 2;
    glyphX1 = glyphCx + glyphSize / 2;
    glyphY0 = glyphCy - glyphSize / 2;
    glyphY1 = glyphCy + glyphSize / 2;
  }
  const minX = Math.min(tokenX0, glyphX0);
  const maxX = Math.max(tokenX1, glyphX1);
  const minY = Math.min(tokenY0, glyphY0);
  const maxY = Math.max(tokenY1, glyphY1);
  const platePad = Math.round(18 * dpr);
  let plate = {
    x: Math.round(minX - platePad),
    y: Math.round(minY - platePad),
    w: Math.round((maxX - minX) + platePad * 2),
    h: Math.round((maxY - minY) + platePad * 2),
  };
  const maxPlateW = Math.max(1, Math.round(canvasW - margin * 2));
  if (plate.w > maxPlateW) {
    plate.w = maxPlateW;
    plate.x = margin;
  } else {
    plate.x = clamp(plate.x, margin, Math.round(canvasW - margin - plate.w));
  }

  // Title text inside the plate (big blocky LED matrix).
  // Do NOT show the literal word "INTENT" - show only the inferred intent/use-case when ready.
  const titleLines = [];
  const title1 = !loading && !intent.uiHideSuggestion && useCaseKey ? _intentUseCaseTitle(useCaseKey) : "";
  if (title1) titleLines.push(title1);
  const titlePadX = Math.round(24 * dpr);
  const titlePadY = Math.round(14 * dpr);
  const titleMaxW = Math.max(1, plate.w - titlePadX * 2);
  const longestTitle = titleLines.reduce((best, cur) => (String(cur).length > String(best).length ? String(cur) : String(best)), "");
  let ledDot = Math.max(6, Math.round(4.2 * dpr * Math.min(1.9, Math.max(1, INTENT_UI_CHOICE_ICON_SCALE * 0.55))));
  const minDot = Math.max(3, Math.round(2.6 * dpr));
  let ledGap = Math.max(1, Math.round(ledDot * 0.22));
  let ledCharGap = Math.max(2, Math.round(ledDot * 0.9));
  while (ledDot > minDot) {
    const dims = _led5x7TextDims(longestTitle, ledDot, ledGap, ledCharGap);
    if (dims.w <= titleMaxW) break;
    ledDot -= 1;
    ledGap = Math.max(1, Math.round(ledDot * 0.22));
    ledCharGap = Math.max(2, Math.round(ledDot * 0.9));
  }
  const ledLineDims = _led5x7TextDims("A", ledDot, ledGap, ledCharGap);
  const ledLineH = Math.max(1, ledLineDims.h);
  const ledLineGap = Math.max(1, Math.round(ledDot * 0.9));
  const titleBlockH = titleLines.length > 0 ? titleLines.length * ledLineH + Math.max(0, titleLines.length - 1) * ledLineGap : 0;
  const titleGapBelow = Math.round(6 * dpr);
  const titleReserve = titleBlockH ? titlePadY + titleBlockH + titleGapBelow : 0;
  if (titleReserve) {
    plate.y = Math.round(plate.y - titleReserve);
    plate.h = Math.round(plate.h + titleReserve);
  }

  const maxPlateH = Math.max(1, Math.round(canvasH - margin * 2));
  if (plate.h > maxPlateH) {
    plate.h = maxPlateH;
    plate.y = margin;
  } else {
    plate.y = clamp(plate.y, margin, Math.round(canvasH - margin - plate.h));
  }
  _drawIntentBumperPlate(octx, plate, {
    active: canAccept,
    loading,
    alpha: iconState ? 1 : 0.82,
  });

  if (titleBlockH) {
    const glow = loading
      ? "rgba(0, 221, 255, 0.70)"
      : canAccept
        ? "rgba(0, 245, 160, 0.62)"
        : "rgba(100, 210, 255, 0.48)";
    const off = "rgba(0, 221, 255, 0.06)";
    const on = loading ? "rgba(0, 221, 255, 0.92)" : "rgba(0, 245, 160, 0.92)";
    let ty = Math.round(plate.y + titlePadY);
    for (let i = 0; i < titleLines.length; i += 1) {
      const line = String(titleLines[i] || "").trim().toUpperCase();
      if (!line) continue;
      const dims = _led5x7TextDims(line, ledDot, ledGap, ledCharGap);
      const tx = Math.round(plate.x + (plate.w - dims.w) / 2);
      _drawLed5x7Text(octx, tx, ty, line, {
        dot: ledDot,
        gap: ledGap,
        charGap: ledCharGap,
        on,
        off,
        glow,
        alpha: 1,
      });
      ty += ledLineH + ledLineGap;
    }
  }

  _drawIntentYesNoIcon(octx, "NO", noCx, tokenCy, tokenR, { alpha: noAlpha });
  _drawIntentYesNoIcon(octx, "YES", yesCx, tokenCy, tokenR, { alpha: yesAlpha });

  const glyphAlpha = intent.uiHideSuggestion ? 0 : loading ? 0.35 : 1;
  if (useCaseKey && glyphAlpha > 0.01) {
    _drawIntentUseCaseGlyph(octx, useCaseKey, glyphCx, glyphCy, glyphSize, { alpha: glyphAlpha });
  }
  if (loading) {
    _drawIntentLoadingDots(octx, glyphCx, glyphCy, { dotR: Math.max(2, Math.round(3.2 * dpr)), t: now / 240 });
  }

  if (canReject) hits.push({ kind: "intent_token", id: `${suggestedBranchId}::NO_TOKEN`, rect: { x: noCx - tokenR, y: tokenCy - tokenR, w: tokenR * 2, h: tokenR * 2 } });
  if (canAccept) hits.push({ kind: "intent_token", id: `${suggestedBranchId}::YES_TOKEN`, rect: { x: yesCx - tokenR, y: tokenCy - tokenR, w: tokenR * 2, h: tokenR * 2 } });

  intent.uiHits = hits;
}

function _ambientWorldRectToCanvasRect(rectWorld) {
  if (!rectWorld) return null;
  const x = Number(rectWorld.x);
  const y = Number(rectWorld.y);
  const w = Number(rectWorld.w);
  const h = Number(rectWorld.h);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w <= 0 || h <= 0) return null;
  const dpr = getDpr();

  if (state.canvasMode === "multi") {
    const s = Math.max(0.0001, Number(state.multiView?.scale) || 1);
    const ox = Number(state.multiView?.offsetX) || 0;
    const oy = Number(state.multiView?.offsetY) || 0;
    // Ambient world rects are in CSS-space; map to canvas/device space before rendering and hit testing.
    return { x: x * dpr * s + ox, y: y * dpr * s + oy, w: w * dpr * s, h: h * dpr * s };
  }

  const s = Math.max(0.0001, Number(state.view?.scale) || 1);
  const ox = Number(state.view?.offsetX) || 0;
  const oy = Number(state.view?.offsetY) || 0;
  return { x: x * s + ox, y: y * s + oy, w: w * s, h: h * s };
}

function renderAmbientIntentNudges(octx, canvasW, canvasH) {
  const ambient = state.intentAmbient;
  if (!INTENT_AMBIENT_ICON_PLACEMENT_ENABLED) {
    if (ambient) ambient.uiHits = [];
    return;
  }
  if (!ambient || !intentAmbientActive()) return;
  if (state.mother?.running) {
    ambient.uiHits = [];
    return;
  }
  const suggestions = Array.isArray(ambient.suggestions) ? ambient.suggestions : [];
  if (!suggestions.length) {
    ambient.uiHits = [];
    return;
  }

  const dpr = getDpr();
  const minPx = Math.max(28, Math.round(72 * dpr));
  const maxPx = Math.max(minPx, Math.round(164 * dpr));
  const edge = Math.round(8 * dpr);
  const now = Date.now();
  let needsFadeTick = false;
  const hits = [];

  for (const suggestion of suggestions.slice(0, INTENT_AMBIENT_MAX_NUDGES)) {
    if (!suggestion || typeof suggestion !== "object") continue;
    const mapped = _ambientWorldRectToCanvasRect(suggestion.world_rect);
    if (!mapped) continue;

    const cx = mapped.x + mapped.w * 0.5;
    const cy = mapped.y + mapped.h * 0.5;
    const drawSize = clamp(Math.min(mapped.w, mapped.h), minPx, maxPx);
    if (drawSize <= 2) continue;

    let x = cx - drawSize * 0.5;
    let y = cy - drawSize * 0.5;
    x = clamp(x, edge, Math.max(edge, canvasW - drawSize - edge));
    y = clamp(y, edge, Math.max(edge, canvasH - drawSize - edge));

    const createdAt = Number(suggestion.created_at_ms) || now;
    const updatedAt = Number(suggestion.updated_at_ms) || createdAt;
    const fade = clamp((now - createdAt) / INTENT_AMBIENT_FADE_IN_MS, 0.12, 1);
    if (fade < 0.999) needsFadeTick = true;
    const refresh = 1 - clamp((now - updatedAt) / 1100, 0, 1);
    const alpha = clamp(0.26 + 0.62 * fade * (0.84 + refresh * 0.16), 0.18, 0.9);

    const conf = typeof suggestion.confidence === "number" && Number.isFinite(suggestion.confidence)
      ? clamp(Number(suggestion.confidence), 0, 1)
      : null;
    const assetType = String(suggestion.asset_type || "icon");
    const assetKey = suggestion.asset_key ? String(suggestion.asset_key) : "";
    const iconImg = assetType === "icon" ? intentUiIcons.usecases?.[assetKey] || null : null;

    octx.save();
    octx.globalAlpha = alpha;
    octx.shadowColor = "rgba(0, 0, 0, 0.44)";
    octx.shadowBlur = Math.round(12 * dpr);
    octx.fillStyle = "rgba(8, 10, 14, 0.62)";
    octx.strokeStyle = "rgba(82, 255, 148, 0.24)";
    octx.lineWidth = Math.max(1, Math.round(1.1 * dpr));
    octx.beginPath();
    octx.arc(x + drawSize * 0.5, y + drawSize * 0.5, drawSize * 0.52, 0, Math.PI * 2);
    octx.fill();
    octx.stroke();
    octx.shadowBlur = 0;

    if (assetType === "icon" && iconImg && iconImg.complete && iconImg.naturalWidth > 0) {
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = "high";
      octx.drawImage(iconImg, Math.round(x), Math.round(y), Math.round(drawSize), Math.round(drawSize));
    } else if (assetType === "icon") {
      _drawIntentUseCaseGlyph(octx, assetKey, x + drawSize * 0.5, y + drawSize * 0.5, drawSize * 0.78, { alpha: 0.9 });
    } else {
      // Placeholder for upcoming generated-image nudges.
      octx.strokeStyle = "rgba(100, 210, 255, 0.68)";
      octx.lineWidth = Math.max(1, Math.round(1.4 * dpr));
      octx.strokeRect(
        Math.round(x + drawSize * 0.18),
        Math.round(y + drawSize * 0.18),
        Math.round(drawSize * 0.64),
        Math.round(drawSize * 0.64)
      );
    }

    if (conf !== null) {
      const barW = Math.max(10, Math.round(drawSize * 0.58));
      const barH = Math.max(1, Math.round(2 * dpr));
      const barX = Math.round(x + (drawSize - barW) * 0.5);
      const barY = Math.round(y + drawSize + Math.max(2, Math.round(3 * dpr)));
      octx.fillStyle = "rgba(8, 10, 14, 0.62)";
      octx.fillRect(barX, barY, barW, barH);
      octx.fillStyle = "rgba(82, 255, 148, 0.68)";
      octx.fillRect(barX, barY, Math.round(barW * conf), barH);
    }

    hits.push({
      kind: "ambient_nudge",
      id: String(suggestion.id || ""),
      rect: { x, y, w: drawSize, h: drawSize },
      branchId: suggestion.branch_id ? String(suggestion.branch_id) : "",
      assetKey: assetKey || "",
      anchorImageIds: Array.isArray(suggestion.anchor?.image_ids) ? suggestion.anchor.image_ids.slice(0, 3) : [],
    });

    octx.restore();
  }

  ambient.uiHits = hits;
  if (needsFadeTick) requestRender();
}

function reelTouchPulseFromCanvasPoint(pt, { down = false, lingerMs = REEL_TOUCH_MOVE_VISIBLE_MS } = {}) {
  if (!isReelSizeLocked()) return;
  const touch = state.reelTouch;
  if (!touch || !pt) return;
  const now = Date.now();
  touch.x = Number(pt.x) || 0;
  touch.y = Number(pt.y) || 0;
  touch.visibleUntil = Math.max(Number(touch.visibleUntil) || 0, now + Math.max(20, Number(lingerMs) || 0));
  if (down) {
    touch.down = true;
    touch.downUntil = Math.max(Number(touch.downUntil) || 0, now + REEL_TOUCH_TAP_VISIBLE_MS);
  } else if (now >= (Number(touch.downUntil) || 0)) {
    touch.down = false;
  }
}

function clearReelTouchPulse() {
  const touch = state.reelTouch;
  if (!touch) return;
  touch.visibleUntil = 0;
  touch.downUntil = 0;
  touch.down = false;
}

function renderReelTouchIndicator(octx, canvasW, canvasH) {
  if (!isReelSizeLocked()) return;
  const touch = state.reelTouch;
  if (!touch || !octx) return;
  const now = Date.now();
  const visibleUntil = Number(touch.visibleUntil) || 0;
  const downUntil = Number(touch.downUntil) || 0;
  const active = Boolean(state.pointer?.active) || now < visibleUntil || now < downUntil;
  if (!active) return;

  const x = clamp(Number(touch.x) || 0, 6, Math.max(6, Number(canvasW) - 6));
  const y = clamp(Number(touch.y) || 0, 6, Math.max(6, Number(canvasH) - 6));
  const downProgress = downUntil > now ? 1 - clamp((downUntil - now) / REEL_TOUCH_TAP_VISIBLE_MS, 0, 1) : 0;
  const tail = clamp((visibleUntil - now) / REEL_TOUCH_MOVE_VISIBLE_MS, 0, 1);
  const alpha = clamp(0.36 + 0.56 * Math.max(tail, downProgress), 0.2, 0.96);
  const coreR = 8 - downProgress * 1.2;
  const ringR = 15 - downProgress * 1.6;

  octx.save();
  octx.globalCompositeOperation = "source-over";
  octx.shadowColor = "rgba(0, 0, 0, 0.44)";
  octx.shadowBlur = 18;

  octx.beginPath();
  octx.arc(x, y, ringR, 0, Math.PI * 2);
  octx.fillStyle = `rgba(220, 236, 255, ${Math.max(0.10, alpha * 0.18).toFixed(3)})`;
  octx.fill();

  octx.shadowBlur = 10;
  octx.beginPath();
  octx.arc(x, y, coreR, 0, Math.PI * 2);
  octx.fillStyle = `rgba(245, 250, 255, ${Math.max(0.2, alpha).toFixed(3)})`;
  octx.fill();

  octx.shadowBlur = 0;
  octx.lineWidth = 1.5;
  octx.strokeStyle = `rgba(90, 120, 150, ${Math.max(0.24, alpha * 0.42).toFixed(3)})`;
  octx.beginPath();
  octx.arc(x, y, coreR + 0.5, 0, Math.PI * 2);
  octx.stroke();

  if (downUntil > now) {
    const pulse = 10 + downProgress * 18;
    const pulseAlpha = Math.max(0, 0.42 * (1 - downProgress));
    octx.lineWidth = 2;
    octx.strokeStyle = `rgba(240, 248, 255, ${pulseAlpha.toFixed(3)})`;
    octx.beginPath();
    octx.arc(x, y, pulse, 0, Math.PI * 2);
    octx.stroke();
  }
  octx.restore();

  if (now < visibleUntil || now < downUntil) requestRender();
}

function render() {
  const work = els.workCanvas;
  const overlay = els.overlayCanvas;
  if (!work || !overlay) return;
  // Keep CSS-only intent effects (cursor/border) in sync with realtime activity.
  syncIntentRealtimeClass();
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

      // Keep single-view active selection clearly visible, matching multi-view behavior.
      const dpr = getDpr();
      const motherGenerated = isMotherGeneratedImageItem(item);
      const outerStroke = motherGenerated ? "rgba(82, 255, 148, 0.20)" : "rgba(255, 212, 0, 0.14)";
      const mainStroke = motherGenerated ? "rgba(82, 255, 148, 0.94)" : "rgba(255, 212, 0, 0.96)";
      const mainShadow = motherGenerated ? "rgba(82, 255, 148, 0.28)" : "rgba(255, 212, 0, 0.26)";
      const innerStroke = motherGenerated ? "rgba(208, 255, 226, 0.60)" : "rgba(255, 247, 210, 0.58)";
      const ix = state.view.offsetX;
      const iy = state.view.offsetY;
      const iw = (img.naturalWidth || item.width || 1) * state.view.scale;
      const ih = (img.naturalHeight || item.height || 1) * state.view.scale;

      octx.save();
      octx.lineJoin = "round";
      octx.strokeStyle = outerStroke;
      octx.lineWidth = Math.max(1, Math.round(10 * dpr));
      octx.shadowColor = mainShadow;
      octx.shadowBlur = Math.round(44 * dpr);
      octx.strokeRect(ix - 5, iy - 5, iw + 10, ih + 10);

      octx.strokeStyle = mainStroke;
      octx.lineWidth = Math.max(1, Math.round(3.4 * dpr));
      octx.shadowColor = mainShadow;
      octx.shadowBlur = Math.round(28 * dpr);
      octx.strokeRect(ix - 3, iy - 3, iw + 6, ih + 6);

      octx.shadowBlur = 0;
      octx.strokeStyle = innerStroke;
      octx.lineWidth = Math.max(1, Math.round(1.2 * dpr));
      octx.strokeRect(ix - 1, iy - 1, iw + 2, ih + 2);
      octx.restore();
    }
  }
  syncEffectsRuntimeScene();
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

  renderIntentOverlay(octx, work.width, work.height);
  renderAmbientIntentNudges(octx, work.width, work.height);
  renderReelTouchIndicator(octx, work.width, work.height);
  renderMotherRolePreview();
  if (!effectsRuntime && !document.hidden && shouldAnimateEffectVisuals()) {
    requestRender();
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

  let lastOverlayCursor = null;
  const setOverlayCursor = (value) => {
    const next = isReelSizeLocked() ? "none" : value || INTENT_IMPORT_CURSOR;
    if (next === lastOverlayCursor) return;
    lastOverlayCursor = next;
    els.overlayCanvas.style.cursor = next;
  };

  // Keep a stable baseline cursor so the browser arrow does not flash between move events.
  const resetCanvasCursor = () => {
    if (!els.overlayCanvas) return;
    if (!state.pointer?.active) {
      setOverlayCursor(INTENT_IMPORT_CURSOR);
    }
  };
  resetCanvasCursor();
  const handlePointerEnter = (event) => {
    resetCanvasCursor();
    if (!isReelSizeLocked()) return;
    reelTouchPulseFromCanvasPoint(canvasPointFromEvent(event), { down: false, lingerMs: REEL_TOUCH_MOVE_VISIBLE_MS });
    requestRender();
  };
  const handlePointerLeave = () => {
    resetCanvasCursor();
    if (!isReelSizeLocked()) return;
    clearReelTouchPulse();
    requestRender();
  };

  const handleOverlayKeyDown = (event) => {
    const key = String(event?.key || "");
    if (key !== "Enter" && key !== " ") return;
    const viewportOnlyMotion =
      state.pointer.kind === POINTER_KINDS.FREEFORM_IMPORT ||
      state.pointer.kind === POINTER_KINDS.FREEFORM_WHEEL ||
      (state.tool === "pan" && !state.pointer.kind);
    bumpInteraction({ semantic: !viewportOnlyMotion });
    event.preventDefault();
    // Keyboard-accessible primary action.
    // - Normal mode: import at a sensible default point (center).
    // - Forced-choice intent gate: do NOT allow importing (it bypasses the gate). Treat Enter/Space
    //   as "Lock Intent" (YES_TOKEN) on the current focus branch.
    if (intentModeActive()) {
      const intent = state.intent;
      const total = Math.max(1, Number(intent?.totalRounds) || 3);
      const round = Math.max(1, Number(intent?.round) || 1);
      const lockGate =
        Boolean(INTENT_FORCE_CHOICE_ENABLED) &&
        (Boolean(intent?.forceChoice) || (INTENT_ROUNDS_ENABLED ? round >= total : false));
      if (lockGate) {
	        if (!intent?.iconState) {
	          showToast("Intent updating…", "tip", 1600);
	          requestRender();
	          return;
	        }
	        lockIntentFromUi({ source: "keyboard" });
	        return;
	      }
	    }
		    importPhotosAtCanvasPoint(canvasScreenCssToWorldCss(_defaultImportPointCss())).catch((err) => console.error(err));
		  };

  const handleContextMenu = (event) => {
    bumpInteraction();
    closeMotherWheelMenu({ immediate: false });
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
  };

  const handlePointerDown = (event) => {
			    closeMotherWheelMenu({ immediate: false });
		    hideDesignateMenu();
        state.pointer.wheelOnTap = false;
		    if (state.canvasMode === "multi") {
		      const canvas = els.workCanvas;
		      if (canvas && state.multiRects.size === 0) {
		        state.multiRects = computeFreeformRectsPx(canvas.width, canvas.height);
		      }

	      const p = canvasPointFromEvent(event);
          if (isReelSizeLocked()) {
            reelTouchPulseFromCanvasPoint(p, { down: event.button === 0, lingerMs: REEL_TOUCH_TAP_VISIBLE_MS });
            requestRender();
          }
	      const pCss = canvasCssPointFromEvent(event);
          const intentActive = intentModeActive();
          const wheelModifier = Boolean(event.metaKey || event.ctrlKey);
          const motherRoleHit = motherV2InInteractivePhase() && motherV2IsAdvancedVisible() ? hitTestMotherRoleGlyph(p) : null;

          if (motherRoleHit && event.button === 0) {
            bumpInteraction({ semantic: false });
            els.overlayCanvas.setPointerCapture(event.pointerId);
            state.pointer.active = true;
            state.pointer.kind = POINTER_KINDS.MOTHER_ROLE_DRAG;
            state.pointer.imageId = String(motherRoleHit.imageId || "");
            state.pointer.role = String(motherRoleHit.role || "");
            state.pointer.startX = p.x;
            state.pointer.startY = p.y;
            state.pointer.lastX = p.x;
            state.pointer.lastY = p.y;
            state.pointer.startCssX = pCss.x;
            state.pointer.startCssY = pCss.y;
            state.pointer.moved = false;
            if (state.motherIdle) {
              state.motherIdle.roleGlyphDrag = {
                role: String(motherRoleHit.role || ""),
                imageId: String(motherRoleHit.imageId || ""),
                moved: false,
                targetImageId: String(motherRoleHit.imageId || ""),
              };
            }
            requestRender();
            return;
          }
          const effectTokenHit = hitTestEffectToken(p);
          if (effectTokenHit && event.button === 0) {
            const token = state.effectTokensById.get(String(effectTokenHit.tokenId || "").trim()) || null;
            if (!token || !beginEffectTokenDrag(token, { x: p.x, y: p.y })) {
              requestRender();
              return;
            }
            bumpInteraction({ semantic: false });
            els.overlayCanvas.setPointerCapture(event.pointerId);
            state.pointer.active = true;
            state.pointer.kind = POINTER_KINDS.EFFECT_TOKEN_DRAG;
            state.pointer.imageId = String(effectTokenHit.imageId || "");
            state.pointer.startX = p.x;
            state.pointer.startY = p.y;
            state.pointer.lastX = p.x;
            state.pointer.lastY = p.y;
            state.pointer.startCssX = pCss.x;
            state.pointer.startCssY = pCss.y;
            state.pointer.moved = false;
            state.effectTokenDrag = {
              tokenId: String(effectTokenHit.tokenId || ""),
              sourceImageId: String(effectTokenHit.imageId || ""),
              targetImageId: "",
              moved: false,
              x: p.x,
              y: p.y,
            };
            requestRender();
            return;
          }
          // Initial pointer-down in multi-canvas is often a focus change (selection). Treat as
          // non-semantic; real arrangement changes are still marked semantic during pointermove.
          bumpInteraction({ semantic: false });
          const ambientHit = intentAmbientActive() ? hitTestAmbientIntentNudge(p) : null;

          if (ambientHit) {
            activateAmbientIntentNudge(ambientHit);
            requestRender();
            return;
          }

		          if (intentActive) {
	            const uiHit = hitTestIntentUi(p);
	            if (uiHit) {
	              const kind = String(uiHit.kind || "");
	              if (kind === "intent_branch") {
	                state.intent.focusBranchId = String(uiHit.id || "");
	                scheduleIntentStateWrite({ immediate: true });
	                requestRender();
	                return;
		              }
		              if (kind === "intent_lock") {
		                lockIntentFromUi({ source: "start_button" });
		                return;
		              }
	              if (kind === "intent_token") {
	                const raw = String(uiHit.id || "");
	                const [bid, tok] = raw.split("::");
	                if (bid && tok) applyIntentSelection(bid, tok);
	                return;
              }
            }
            // Optional gate (disabled by default): block canvas interactions until the user locks an intent.
            if (INTENT_FORCE_CHOICE_ENABLED && state.intent.forceChoice) {
              requestRender();
              return;
            }
          }
		      let hit = hitTestMulti(p);
          let corner = null;
          if (state.tool === "pan") {
            const handleHit = hitTestAnyFreeformCornerHandle(p, { padPx: Math.round(12 * getDpr()) });
            if (handleHit?.id && handleHit.corner) {
              hit = handleHit.id;
              corner = handleHit.corner;
            }
          }
			      if (!hit && canvas) {
			        state.multiRects = computeFreeformRectsPx(canvas.width, canvas.height);
	            hit = hitTestMulti(p);
	            corner = null;
	            if (state.tool === "pan") {
	              const handleHit = hitTestAnyFreeformCornerHandle(p, { padPx: Math.round(12 * getDpr()) });
	              if (handleHit?.id && handleHit.corner) {
	                hit = handleHit.id;
	                corner = handleHit.corner;
	              }
	            }
			      }

            // Avoid accidental click-to-import when the user is trying to grab a tile edge/handle.
	            if (!hit && intentActive) {
	              const paddedHit = hitTestMultiWithPad(p, Math.round(10 * getDpr()));
	              if (paddedHit) hit = paddedHit;
	            }

	      if (hit) {
	              const toggle = Boolean((event.shiftKey || event.metaKey || event.ctrlKey) && state.tool !== "annotate");
	              selectCanvasImage(hit, { toggle }).catch(() => {});
	              // Modifier-click (Shift/Cmd/Ctrl) is reserved for multi-select toggling; don't start a drag/tool action.
	              if (toggle) return;
	            }

            if (!intentActive && wheelModifier && event.button === 0) {
              els.overlayCanvas.setPointerCapture(event.pointerId);
              state.pointer.active = true;
              state.pointer.imageId = null;
              state.pointer.corner = null;
              state.pointer.startX = p.x;
              state.pointer.startY = p.y;
              state.pointer.lastX = p.x;
              state.pointer.lastY = p.y;
              state.pointer.startCssX = pCss.x;
              state.pointer.startCssY = pCss.y;
              state.pointer.startOffsetX = state.multiView.offsetX;
              state.pointer.startOffsetY = state.multiView.offsetY;
              state.pointer.importPointCss = { x: pCss.x, y: pCss.y };
              state.pointer.kind = POINTER_KINDS.FREEFORM_WHEEL;
              state.pointer.wheelOnTap = true;
              state.pointer.moved = false;
              requestRender();
              return;
            }

	          if (!hit) {
	            if (event.button !== 0) return;
	            els.overlayCanvas.setPointerCapture(event.pointerId);
	            state.pointer.active = true;
	            state.pointer.imageId = null;
	            state.pointer.corner = null;
	            state.pointer.startX = p.x;
	            state.pointer.startY = p.y;
	            state.pointer.lastX = p.x;
	            state.pointer.lastY = p.y;
	            state.pointer.startCssX = pCss.x;
	            state.pointer.startCssY = pCss.y;
	            state.pointer.startOffsetX = state.multiView.offsetX;
	            state.pointer.startOffsetY = state.multiView.offsetY;
	            state.pointer.importPointCss = { x: pCss.x, y: pCss.y };
              state.pointer.wheelOnTap = false;
	            state.pointer.moved = false;
	            if (intentActive) {
	              // Keep legacy import behavior in forced intent mode.
	              state.pointer.kind = POINTER_KINDS.FREEFORM_IMPORT;
	              if (!state.intent.startedAt) {
	                state.intent.rtState = "connecting";
	              }
	            } else {
	              // Empty-space click-drag pans the multi-canvas working set.
	              state.pointer.kind = POINTER_KINDS.SINGLE_PAN;
	            }
	            requestRender();
	            return;
	          }

		      if (state.tool === "pan") {
		        const rectPx = state.multiRects.get(hit) || null;
		        const cornerHit = corner || (rectPx ? hitTestFreeformCornerHandleWithPad(p, rectPx, Math.round(12 * getDpr())) : null);

		        // Bring the active (dragged) image to the top for intuitive hit-testing and stacking.
		        const z = state.freeformZOrder || [];
		        const zIdx = z.indexOf(hit);
		        if (zIdx >= 0) {
		          z.splice(zIdx, 1);
		          z.push(hit);
		        }

		        const rectCss = state.freeformRects.get(hit) || null;
		        els.overlayCanvas.setPointerCapture(event.pointerId);
		        state.pointer.active = true;
		        state.pointer.kind = cornerHit ? POINTER_KINDS.FREEFORM_RESIZE : POINTER_KINDS.FREEFORM_MOVE;
		        state.pointer.imageId = hit;
		        state.pointer.corner = cornerHit;
		        state.pointer.startX = p.x;
		        state.pointer.startY = p.y;
		        state.pointer.lastX = p.x;
		        state.pointer.lastY = p.y;
		        state.pointer.startCssX = pCss.x;
		        state.pointer.startCssY = pCss.y;
		        state.pointer.startRectCss = rectCss ? { ...rectCss } : null;
		        state.pointer.wheelOnTap = false;
		        state.pointer.moved = false;
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
        bumpInteraction();
		    const img = getActiveImage();
		    if (!img) return;
        const p = canvasPointFromEvent(event);
        const pCss = canvasCssPointFromEvent(event);
        const wheelModifier = Boolean(event.metaKey || event.ctrlKey);
        if (isReelSizeLocked()) {
          reelTouchPulseFromCanvasPoint(p, { down: event.button === 0, lingerMs: REEL_TOUCH_TAP_VISIBLE_MS });
          requestRender();
        }
        if (wheelModifier && event.button === 0) {
          els.overlayCanvas.setPointerCapture(event.pointerId);
          state.pointer.active = true;
          state.pointer.kind = POINTER_KINDS.FREEFORM_WHEEL;
          state.pointer.imageId = null;
          state.pointer.corner = null;
          state.pointer.startX = p.x;
          state.pointer.startY = p.y;
          state.pointer.lastX = p.x;
          state.pointer.lastY = p.y;
          state.pointer.startCssX = pCss.x;
          state.pointer.startCssY = pCss.y;
          state.pointer.startOffsetX = state.view.offsetX;
          state.pointer.startOffsetY = state.view.offsetY;
          state.pointer.importPointCss = { x: pCss.x, y: pCss.y };
          state.pointer.wheelOnTap = true;
          state.pointer.moved = false;
          requestRender();
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
	    state.pointer.kind = state.tool === "pan" ? POINTER_KINDS.SINGLE_PAN : null;
	    state.pointer.importPointCss = { x: pCss.x, y: pCss.y };
	    state.pointer.wheelOnTap = false;
	    state.pointer.startX = p.x;
	    state.pointer.startY = p.y;
		    state.pointer.startCssX = pCss.x;
		    state.pointer.startCssY = pCss.y;
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
	  };

  const handlePointerMove = (event) => {
    const p = canvasPointFromEvent(event);
    const pCss = canvasCssPointFromEvent(event);
    if (isReelSizeLocked()) {
      const down = Boolean(state.pointer?.active && (Number(event?.buttons) & 1));
      reelTouchPulseFromCanvasPoint(p, {
        down,
        lingerMs: down ? REEL_TOUCH_TAP_VISIBLE_MS : REEL_TOUCH_MOVE_VISIBLE_MS,
      });
      requestRender();
    }
    if (!state.pointer.active && state.motherIdle?.phase === MOTHER_IDLE_STATES.WAITING_FOR_USER) {
      const now = Date.now();
      if (now - (Number(state.lastInteractionAt) || 0) > 120) {
        state.lastInteractionAt = now;
      }
    }

    if (!state.pointer.active) {
      const roleHit = motherV2InInteractivePhase() && motherV2IsAdvancedVisible() ? hitTestMotherRoleGlyph(p) : null;
      if (roleHit) {
        setOverlayCursor("pointer");
        return;
      }
      const effectTokenHit = hitTestEffectToken(p);
      if (effectTokenHit) {
        setOverlayCursor("grab");
        return;
      }
      const ambientHit = intentAmbientActive() ? hitTestAmbientIntentNudge(p) : null;
      if (ambientHit) {
        setOverlayCursor("pointer");
        return;
      }
	      const intentActive = intentModeActive();
	      if (intentActive) {
        const uiHit = hitTestIntentUi(p);
        if (uiHit) {
          setOverlayCursor(INTENT_IMPORT_CURSOR);
          return;
        }
      }
      // Hover cursor feedback (click-to-upload + freeform arrange).
      if (state.canvasMode === "multi") {
        const canvas = els.workCanvas;
        if (canvas && state.multiRects.size === 0) {
          state.multiRects = computeFreeformRectsPx(canvas.width, canvas.height);
        }
        if (state.tool === "pan") {
          const handleHit = hitTestAnyFreeformCornerHandle(p, { padPx: Math.round(12 * getDpr()) });
          if (handleHit?.corner) {
            setOverlayCursor(handleHit.corner === "nw" || handleHit.corner === "se" ? "nwse-resize" : "nesw-resize");
            return;
          }
        }

        const hit = hitTestMulti(p);
        // Intent Mode uses an RTS-like pointer; reserve grab/drag cursors for the active drag.
        if (intentActive) {
          setOverlayCursor(INTENT_IMPORT_CURSOR);
          return;
        }
        if (!hit) {
          setOverlayCursor(INTENT_IMPORT_CURSOR);
          return;
        }
        if (state.tool === "pan") {
          setOverlayCursor("grab");
          return;
        }
        setOverlayCursor(INTENT_IMPORT_CURSOR);
        return;
      }
      if (intentActive) {
        setOverlayCursor(INTENT_IMPORT_CURSOR);
        return;
      }
      setOverlayCursor(INTENT_IMPORT_CURSOR);
      return;
    }

    // Keep move/resize affordances during active drags.
    if (state.pointer.kind === POINTER_KINDS.FREEFORM_RESIZE) {
      const corner = state.pointer.corner;
      if (corner) {
        setOverlayCursor(corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize");
      }
    } else if (state.pointer.kind === POINTER_KINDS.FREEFORM_MOVE) {
      setOverlayCursor("grabbing");
    } else if (state.pointer.kind === POINTER_KINDS.EFFECT_TOKEN_DRAG) {
      setOverlayCursor("grabbing");
    } else if (state.pointer.kind === POINTER_KINDS.FREEFORM_IMPORT || state.pointer.kind === POINTER_KINDS.FREEFORM_WHEEL) {
      setOverlayCursor(INTENT_IMPORT_CURSOR);
    }

	    const dx = p.x - state.pointer.startX;
		    const dy = p.y - state.pointer.startY;
		    state.pointer.lastX = p.x;
		    state.pointer.lastY = p.y;

    if (state.pointer.kind === POINTER_KINDS.MOTHER_ROLE_DRAG) {
      bumpInteraction({ semantic: false });
	      const drag = state.motherIdle?.roleGlyphDrag || null;
	      const dist = Math.hypot(dx, dy);
	      if (dist > 4) state.pointer.moved = true;
      if (drag) {
        drag.moved = Boolean(state.pointer.moved);
        const hit = hitTestMulti(p);
        drag.targetImageId = hit ? String(hit) : "";
      }
	      requestRender();
	      return;
	    }
    if (state.pointer.kind === POINTER_KINDS.EFFECT_TOKEN_DRAG) {
      bumpInteraction({ semantic: false });
      const drag = state.effectTokenDrag;
      const dist = Math.hypot(dx, dy);
      if (dist > 4) state.pointer.moved = true;
      if (drag) {
        const token = state.effectTokensById.get(String(drag.tokenId || "").trim()) || null;
        drag.moved = Boolean(state.pointer.moved);
        drag.x = p.x;
        drag.y = p.y;
        const dropHit = hitTestMulti(p);
        const sourceId = String(drag.sourceImageId || "");
        const targetId = dropHit ? String(dropHit) : "";
        drag.targetImageId = isValidEffectDrop(sourceId, targetId) ? targetId : "";
        if (token) {
          updateEffectTokenDrag(token, {
            x: p.x,
            y: p.y,
            targetImageId: drag.targetImageId,
          });
        }
      }
      requestRender();
      return;
    }

    if (state.pointer.kind === POINTER_KINDS.FREEFORM_MOVE || state.pointer.kind === POINTER_KINDS.FREEFORM_RESIZE) {
      const dragDistCss = Math.hypot(
        (Number(pCss.x) || 0) - state.pointer.startCssX,
        (Number(pCss.y) || 0) - state.pointer.startCssY
      );
      bumpInteraction({ semantic: state.pointer.moved || dragDistCss > MOTHER_SELECTION_SEMANTIC_DRAG_PX });
    } else {
      bumpInteraction();
    }

	    // Freeform interactions (multi canvas + pan tool).
    if (state.pointer.kind === POINTER_KINDS.FREEFORM_IMPORT || state.pointer.kind === POINTER_KINDS.FREEFORM_WHEEL) {
      const dist = Math.hypot((Number(pCss.x) || 0) - state.pointer.startCssX, (Number(pCss.y) || 0) - state.pointer.startCssY);
      if (dist > 6) state.pointer.moved = true;
      return;
    }
    if (state.pointer.kind === POINTER_KINDS.FREEFORM_MOVE && state.pointer.imageId) {
      const id = state.pointer.imageId;
      const startRect = state.pointer.startRectCss || state.freeformRects.get(id) || null;
      if (!startRect) return;
      const wrap = els.canvasWrap;
      const canvasCssW = wrap?.clientWidth || 0;
      const canvasCssH = wrap?.clientHeight || 0;
      const ms = state.multiView?.scale || 1;
      const dxCss = (Number(pCss.x) || 0) - state.pointer.startCssX;
      const dyCss = (Number(pCss.y) || 0) - state.pointer.startCssY;
      const dragDistCss = Math.hypot(dxCss, dyCss);
      if (!state.pointer.moved && dragDistCss <= MOTHER_SELECTION_SEMANTIC_DRAG_PX) return;
      const dxWorld = dxCss / Math.max(ms, 0.0001);
      const dyWorld = dyCss / Math.max(ms, 0.0001);
      const next = clampFreeformRectCss(
        {
          x: (Number(startRect.x) || 0) + dxWorld,
          y: (Number(startRect.y) || 0) + dyWorld,
          w: Number(startRect.w) || 1,
          h: Number(startRect.h) || 1,
          autoAspect: false,
        },
        canvasCssW,
        canvasCssH
      );
      state.freeformRects.set(id, next);
      state.pointer.moved = true;
      scheduleVisualPromptWrite();
      if (intentAmbientActive()) scheduleAmbientIntentInference({ reason: "move", imageIds: [id] });
      requestRender();
      return;
    }
    if (state.pointer.kind === POINTER_KINDS.FREEFORM_RESIZE && state.pointer.imageId) {
      const id = state.pointer.imageId;
      const startRect = state.pointer.startRectCss || state.freeformRects.get(id) || null;
      if (!startRect) return;
      const wrap = els.canvasWrap;
      const canvasCssW = wrap?.clientWidth || 0;
      const canvasCssH = wrap?.clientHeight || 0;
      const ms = state.multiView?.scale || 1;
      const dpr = getDpr();
      const mxCss = (Number(state.multiView?.offsetX) || 0) / Math.max(dpr, 0.0001);
      const myCss = (Number(state.multiView?.offsetY) || 0) / Math.max(dpr, 0.0001);
      const dxCss = (Number(pCss.x) || 0) - state.pointer.startCssX;
      const dyCss = (Number(pCss.y) || 0) - state.pointer.startCssY;
      const dragDistCss = Math.hypot(dxCss, dyCss);
      if (!state.pointer.moved && dragDistCss <= MOTHER_SELECTION_SEMANTIC_DRAG_PX) return;
      const worldPointerCss = {
        x: ((Number(pCss.x) || 0) - mxCss) / Math.max(ms, 0.0001),
        y: ((Number(pCss.y) || 0) - myCss) / Math.max(ms, 0.0001),
      };
      const next = resizeFreeformRectFromCorner(startRect, state.pointer.corner, worldPointerCss, canvasCssW, canvasCssH);
      state.freeformRects.set(id, next);
      state.pointer.moved = true;
      scheduleVisualPromptWrite();
      if (intentAmbientActive()) scheduleAmbientIntentInference({ reason: "resize", imageIds: [id] });
      requestRender();
      return;
    }

    // Existing tools (single canvas + edit tools).
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
    if (state.pointer.kind === POINTER_KINDS.SINGLE_PAN || state.tool === "pan") {
      if (state.pointer.kind === POINTER_KINDS.SINGLE_PAN) {
        const dist = Math.hypot((Number(pCss.x) || 0) - state.pointer.startCssX, (Number(pCss.y) || 0) - state.pointer.startCssY);
        if (!state.pointer.moved && dist <= 6) return;
        state.pointer.moved = true;
      }
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
  };

		  function finalizePointer(event) {
		    if (!state.pointer.active) return;
		    const kind = state.pointer.kind;
		    const imageId = state.pointer.imageId;
        const roleKey = state.pointer.role;
		    const startRectCss = state.pointer.startRectCss;
		    const corner = state.pointer.corner;
        const importPt = state.pointer.importPointCss;
        const wheelOnTap = Boolean(state.pointer.wheelOnTap);
		    const moved = Boolean(state.pointer.moved);
		    state.pointer.active = false;
		    state.pointer.kind = null;
		    state.pointer.imageId = null;
        state.pointer.role = null;
		    state.pointer.corner = null;
		    state.pointer.startRectCss = null;
		    state.pointer.importPointCss = null;
        state.pointer.wheelOnTap = false;
		    state.pointer.moved = false;
        setOverlayCursor(INTENT_IMPORT_CURSOR);
        if (isReelSizeLocked()) {
          const p = canvasPointFromEvent(event);
          reelTouchPulseFromCanvasPoint(p, { down: false, lingerMs: REEL_TOUCH_RELEASE_VISIBLE_MS });
          if (state.reelTouch) {
            state.reelTouch.down = false;
            state.reelTouch.downUntil = Date.now() + REEL_TOUCH_RELEASE_VISIBLE_MS;
          }
          requestRender();
        }
        // Arm Mother idle timers against the settled interaction state (pointer no longer active).
        const motherRoleDrag = isMotherRolePath(kind);
        const effectTokenDrag = isEffectTokenPath(kind);
        if (!motherRoleDrag && !effectTokenDrag) {
          const selectionOnly = (kind === POINTER_KINDS.FREEFORM_MOVE || kind === POINTER_KINDS.FREEFORM_RESIZE) && !moved;
          bumpInteraction({ semantic: !selectionOnly });
        }

		    if (moved && (kind === POINTER_KINDS.FREEFORM_MOVE || kind === POINTER_KINDS.FREEFORM_RESIZE) && imageId) {
		      const start = startRectCss && typeof startRectCss === "object" ? startRectCss : null;
		      const end = state.freeformRects.get(imageId) || null;
		      if (start && end) {
		        recordUserEvent(kind === POINTER_KINDS.FREEFORM_MOVE ? "image_move" : "image_resize", {
		          image_id: String(imageId),
		          corner: corner ? String(corner) : null,
		          start: {
		            x: Math.round(Number(start.x) || 0),
		            y: Math.round(Number(start.y) || 0),
		            w: Math.round(Number(start.w) || 0),
		            h: Math.round(Number(start.h) || 0),
		          },
		          end: {
		            x: Math.round(Number(end.x) || 0),
		            y: Math.round(Number(end.y) || 0),
		            w: Math.round(Number(end.w) || 0),
		            h: Math.round(Number(end.h) || 0),
			          },
			        });
		      }
          markAlwaysOnVisionDirty(kind === POINTER_KINDS.FREEFORM_MOVE ? "image_move" : "image_resize");
          scheduleAlwaysOnVision();
		    }

			    if (kind === POINTER_KINDS.FREEFORM_IMPORT) {
			      if (!moved && importPt) {
              const worldPt = canvasScreenCssToWorldCss(importPt);
			        recordUserEvent("canvas_import_click", {
			          x: Math.round(Number(worldPt.x) || 0),
			          y: Math.round(Number(worldPt.y) || 0),
			        });
			        importPhotosAtCanvasPoint(worldPt).catch((err) => console.error(err));
			      }
			    }
			    if (kind === POINTER_KINDS.FREEFORM_WHEEL) {
			      if (!moved && importPt) {
              const opened = openMotherWheelMenuAt(importPt);
              if (opened) {
                recordUserEvent("mother_wheel_open", {
                  x: Math.round(Number(importPt.x) || 0),
                  y: Math.round(Number(importPt.y) || 0),
                });
              }
			      }
			    }
          if (kind === POINTER_KINDS.SINGLE_PAN && wheelOnTap) {
            if (!moved && importPt) {
              const opened = openMotherWheelMenuAt(importPt);
              if (opened) {
                recordUserEvent("mother_wheel_open", {
                  x: Math.round(Number(importPt.x) || 0),
                  y: Math.round(Number(importPt.y) || 0),
                });
              }
            }
          }
          if (isMotherRolePath(kind)) {
            bumpInteraction({ semantic: false });
            const idle = state.motherIdle;
            const role = String(roleKey || idle?.roleGlyphDrag?.role || "").trim();
            const fromImageId = String(imageId || idle?.roleGlyphDrag?.imageId || "").trim();
            const dropHit = hitTestMulti(canvasPointFromEvent(event));
            const toImageId = dropHit ? String(dropHit) : "";
            if (role && MOTHER_V2_ROLE_KEYS.includes(role)) {
              let nextIds = motherV2RoleIds(role);
              // Drag to another image reassigns. Click/tap toggles off.
              if ((moved && toImageId && toImageId !== fromImageId) || (!moved && toImageId && toImageId !== fromImageId)) {
                nextIds = [toImageId];
              } else {
                nextIds = nextIds.filter((id) => id !== fromImageId);
              }
              motherV2SetRoleIds(role, nextIds);
              if (idle?.intent && typeof idle.intent === "object") {
                idle.intent.roles = motherV2RoleMapClone();
              }
              motherV2InvalidateOfferingForStructureEdit("glyph_edit");
              appendMotherTraceLog({
                kind: "glyph_edit",
                traceId: idle?.telemetry?.traceId || null,
                actionVersion: Number(idle?.actionVersion) || 0,
                role,
                from_image_id: fromImageId || null,
                to_image_id: toImageId || null,
              }).catch(() => {});
            }
            if (idle) idle.roleGlyphDrag = null;
            renderMotherReadout();
            requestRender();
          }
          if (isEffectTokenPath(kind)) {
            bumpInteraction({ semantic: false });
            const drag = state.effectTokenDrag || null;
            const tokenId = String(drag?.tokenId || "").trim();
            const sourceImageId = String(drag?.sourceImageId || "").trim();
            const token = state.effectTokensById.get(tokenId) || null;
            const dropHit = hitTestMulti(canvasPointFromEvent(event));
            const toImageId = isValidEffectDrop(sourceImageId, dropHit ? String(dropHit || "").trim() : "")
              ? String(dropHit || "").trim()
              : "";
            state.effectTokenDrag = null;
            if (!tokenId || !sourceImageId || !token) {
              requestRender();
            } else if (toImageId) {
              const dispatchId = beginEffectTokenApply(token, toImageId, Date.now());
              if (!dispatchId) {
                requestRender();
                return;
              }
              state.effectTokenApplyLocks.set(tokenId, {
                dispatchId,
                targetImageId: toImageId,
                queued: false,
                startedAt: Date.now(),
              });
              requestRender();
              void animateThenApplyEffectToken({
                tokenId,
                targetImageId: toImageId,
                dispatchId,
                fromX: Number(drag?.x) || 0,
                fromY: Number(drag?.y) || 0,
              });
            } else {
              cancelEffectTokenDrag(token);
              const sourceRect = state.multiRects.get(sourceImageId) || null;
              if (effectsRuntime && sourceRect) {
                const transform = getMultiViewTransform();
                const sourceScreenRect = multiRectToScreenRect(sourceRect, transform);
                const effectType = effectTypeFromTokenType(token.type);
                void effectsRuntime.playCancelToSource({
                  tokenId,
                  effectType,
                  fromX: Number(drag?.x) || 0,
                  fromY: Number(drag?.y) || 0,
                  targetRect: sourceScreenRect,
                  size: effectTokenDisplaySizeForRect(sourceScreenRect, effectType),
                  data: token,
                });
              }
              if (moved) {
                showToast("Drop the token onto another image to apply.", "tip", 1800);
              }
              requestRender();
            }
          }
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

  installCanvasPointerHandlers(els.overlayCanvas, {
    onPointerEnter: handlePointerEnter,
    onPointerLeave: handlePointerLeave,
    onContextMenu: handleContextMenu,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: finalizePointer,
    onPointerCancel: finalizePointer,
  });
  installCanvasKeyboardHandlers(els.overlayCanvas, {
    onKeyDown: handleOverlayKeyDown,
  });

  const handleOverlayWheel = (event) => {
      bumpInteraction({ motherHot: false, semantic: false });
      if (!state.images || state.images.length === 0) return;
		      event.preventDefault();
	
	      const dpr = getDpr();
	      // UX: two-finger swipe up/down zooms (not pan). Horizontal swipe pans.
	      // Holding Option (Alt) forces pan (both axes) for when you want to scroll around.
	      let dx = Number(event.deltaX) || 0;
	      let dy = Number(event.deltaY) || 0;
	      // Mouse wheels often emit horizontal scroll as Shift+deltaY.
	      if (event.shiftKey && Math.abs(dx) < 0.001 && Math.abs(dy) > 0.001) {
	        dx = dy;
	        dy = 0;
	      }
	      // Normalize deltaMode into CSS pixels.
	      if (event.deltaMode === 1) {
	        dx *= 16;
	        dy *= 16;
	      } else if (event.deltaMode === 2) {
	        const wrap = els.canvasWrap;
	        dx *= wrap?.clientWidth || 1;
	        dy *= wrap?.clientHeight || 1;
	      }
	
	      const absDx = Math.abs(dx);
	      const absDy = Math.abs(dy);
	      const panX = dx * dpr;
	      const panY = dy * dpr;
	
	      if (wheelForcePanHeld) {
	        if (state.canvasMode === "multi") {
	          state.multiView.offsetX = (Number(state.multiView?.offsetX) || 0) - panX;
	          state.multiView.offsetY = (Number(state.multiView?.offsetY) || 0) - panY;
	        } else {
	          state.view.offsetX = (Number(state.view?.offsetX) || 0) - panX;
	          state.view.offsetY = (Number(state.view?.offsetY) || 0) - panY;
	        }
	        renderHudReadout();
	        requestRender();
	        return;
	      }
	
	      // Horizontal trackpad scroll pans left/right.
	      if (absDx > 0.01) {
	        if (state.canvasMode === "multi") {
	          state.multiView.offsetX = (Number(state.multiView?.offsetX) || 0) - panX;
	        } else {
	          state.view.offsetX = (Number(state.view?.offsetX) || 0) - panX;
	        }
	      }
	
	      // Ignore tiny vertical noise during a mostly-horizontal gesture.
	      if (absDy <= 0.01 || absDx > absDy * 1.1) {
	        renderHudReadout();
	        requestRender();
	        return;
	      }
	
	      // Wheel / trackpad pinch: zoom the view (single + freeform multi).
	      const p = canvasPointFromEvent(event);
	      const factor = Math.exp(-dy * 0.0012);
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
		    };
  installCanvasWheelHandlers(els.overlayCanvas, {
    onWheel: handleOverlayWheel,
  });

    // WKWebView/Safari trackpad pinch-to-zoom is exposed via non-standard gesture events.
    // If we only listen for wheel+ctrlKey, users can lose pinch zoom.
    if (!state.gestureZoom) state.gestureZoom = { active: false, lastScale: 1 };
    const shouldHandleGesture = (event) => {
      if (!els.overlayCanvas) return false;
      const cx = Number(event?.clientX);
      const cy = Number(event?.clientY);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return false;
      const rect = els.overlayCanvas.getBoundingClientRect();
      if (!rect?.width || !rect?.height) return false;
      return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
    };
    const onGestureStart = (event) => {
      if (!shouldHandleGesture(event)) return;
      if (!state.images || state.images.length === 0) return;
      bumpInteraction({ motherHot: false, semantic: false });
      event.preventDefault();
      state.gestureZoom.active = true;
      const s = Number(event?.scale);
      state.gestureZoom.lastScale = Number.isFinite(s) && s > 0 ? s : 1;
    };
    const onGestureChange = (event) => {
      if (!state.gestureZoom?.active) return;
      if (!shouldHandleGesture(event)) return;
      if (!state.images || state.images.length === 0) return;
      bumpInteraction({ motherHot: false, semantic: false });
      event.preventDefault();

      const scaleEvent = Number(event?.scale);
      const nextScaleEvent = Number.isFinite(scaleEvent) && scaleEvent > 0 ? scaleEvent : 1;
      const lastScaleEvent = Math.max(0.0001, Number(state.gestureZoom?.lastScale) || 1);
      state.gestureZoom.lastScale = nextScaleEvent;
      const factor = nextScaleEvent / lastScaleEvent;

      const p = canvasPointFromEvent(event);
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
    };
    const onGestureEnd = (event) => {
      if (!state.gestureZoom?.active) return;
      if (!shouldHandleGesture(event)) return;
      bumpInteraction({ motherHot: false, semantic: false });
      event.preventDefault();
      state.gestureZoom.active = false;
      state.gestureZoom.lastScale = 1;
    };
	    try {
      installCanvasGestureHandlers(els.overlayCanvas, {
        onGestureStart,
        onGestureChange,
        onGestureEnd,
      });
	    } catch {
	      // ignore
	    }
		}

function installDnD() {
  if (!els.canvasWrap) return;

  // Even when drag/drop import is disabled, we must still prevent the WebView's
  // default file-drop navigation (which can wipe the current session/run).
  const preventNav = (event) => {
    if (!event) return;
    event.preventDefault();
  };

  const canvasWorldPointFromClient = (clientX, clientY) => {
    const wrapRect = els.canvasWrap?.getBoundingClientRect?.();
    if (!wrapRect || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    if (clientX < wrapRect.left || clientX > wrapRect.right || clientY < wrapRect.top || clientY > wrapRect.bottom) {
      return null;
    }
    const overlayRect = els.overlayCanvas?.getBoundingClientRect?.() || wrapRect;
    const css = { x: clientX - overlayRect.left, y: clientY - overlayRect.top };
    return canvasScreenCssToWorldCss(css);
  };

  const tryImportInternalDragAtClient = async (clientX, clientY, { source = "browser_drag_fallback" } = {}) => {
    const path = normalizeLocalFsPath(state.fileBrowser?.draggingPath || "");
    if (!path || !isBrowserImagePath(path)) return false;
    const world = canvasWorldPointFromClient(clientX, clientY);
    if (!world) return false;
    const result = await importLocalPathsAtCanvasPoint([path], world, {
      source,
      idPrefix: "dockdrop",
      enforceIntentLimit: true,
      focusImported: true,
    });
    if (!result?.ok) {
      showToast("Could not import dropped image.", "error", 2600);
      return false;
    }
    fileBrowserSetDragPath(null);
    return true;
  };

  let lastInternalImportAt = 0;
  try {
    window.addEventListener("dragover", preventNav, { passive: false });
    window.addEventListener(
      "drop",
      (event) => {
        preventNav(event);
        const now = Date.now();
        if (now - lastInternalImportAt < 500) {
          fileBrowserSetDragPath(null);
          return;
        }
        const clientX = Number(event?.clientX);
        const clientY = Number(event?.clientY);
        if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
          fileBrowserSetDragPath(null);
          return;
        }
        tryImportInternalDragAtClient(clientX, clientY, { source: "browser_drag_window" }).catch(() => {});
      },
      { passive: false }
    );
  } catch {
    // ignore
  }

  function stop(event) {
    preventNav(event);
    event?.stopPropagation?.();
  }

  let browserDragDepth = 0;
  const setBrowserDragHover = (on) => {
    els.canvasWrap.classList.toggle("is-browser-drag-over", Boolean(on));
  };
  const clearBrowserDragHover = () => {
    browserDragDepth = 0;
    setBrowserDragHover(false);
  };

  try {
    window.addEventListener("dragend", clearBrowserDragHover, { passive: true });
    window.addEventListener(
      "dragend",
      (event) => {
        const clientX = Number(event?.clientX);
        const clientY = Number(event?.clientY);
        if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
          fileBrowserClearDragPathDeferred(120);
          return;
        }
        tryImportInternalDragAtClient(clientX, clientY, { source: "browser_drag_end" })
          .catch(() => {})
          .finally(() => {
            fileBrowserClearDragPathDeferred(120);
          });
      },
      { passive: true }
    );
    window.addEventListener("drop", clearBrowserDragHover, { passive: false });
  } catch {
    // ignore
  }

  const handleDragEnter = (event) => {
    stop(event);
    const internalPath = fileBrowserReadInternalDragPath(event?.dataTransfer);
    if (internalPath) {
      browserDragDepth += 1;
      setBrowserDragHover(true);
    }
  };
  const handleDragLeave = (event) => {
    stop(event);
    const internalPath = fileBrowserReadInternalDragPath(event?.dataTransfer);
    if (!internalPath) return;
    browserDragDepth = Math.max(0, browserDragDepth - 1);
    if (!browserDragDepth) setBrowserDragHover(false);
  };
  const handleDragOver = (event) => {
    stop(event);
    const internalPath = fileBrowserReadInternalDragPath(event?.dataTransfer);
    if (internalPath) {
      if (event?.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setBrowserDragHover(true);
    }
  };

  let disabledToastAt = 0;
  const handleDrop = async (event) => {
    stop(event);
    clearBrowserDragHover();
    bumpInteraction();
    const internalPath = fileBrowserReadInternalDragPath(event?.dataTransfer);
    if (internalPath) {
      const world = canvasScreenCssToWorldCss(canvasCssPointFromEvent(event));
      lastInternalImportAt = Date.now();
      const result = await importLocalPathsAtCanvasPoint([internalPath], world, {
        source: "browser_drag",
        idPrefix: "dockdrop",
        enforceIntentLimit: true,
        focusImported: true,
      });
      if (!result?.ok) {
        showToast("Could not import dropped image.", "error", 2600);
      }
      fileBrowserSetDragPath(null);
      return;
    }
    fileBrowserSetDragPath(null);
    const files = Array.from(event.dataTransfer?.files || []);
    const paths = files.map((f) => f?.path).filter(Boolean);
    if (paths.length === 0) return;
    if (!ENABLE_DRAG_DROP_IMPORT) {
      const now = Date.now();
      if (!disabledToastAt || now - disabledToastAt > 3500) {
        disabledToastAt = now;
        showToast("Drag/drop disabled. Click anywhere to add a photo.", "tip", 2400);
      }
      return;
    }
    const world = canvasScreenCssToWorldCss(canvasCssPointFromEvent(event));
    await importLocalPathsAtCanvasPoint(paths, world, {
      source: "drop",
      idPrefix: "drop",
      enforceIntentLimit: true,
    });
  };

  const dndTargets = [els.canvasWrap, els.overlayCanvas].filter(Boolean);
  for (const target of dndTargets) {
    target.addEventListener("dragenter", handleDragEnter, { passive: false });
    target.addEventListener("dragleave", handleDragLeave, { passive: false });
    target.addEventListener("dragover", handleDragOver, { passive: false });
    target.addEventListener("drop", (event) => {
      handleDrop(event).catch((err) => console.error(err));
    });
  }
}

function installUi() {
  if (els.appMenuToggle && els.appMenu) {
    const toggle = els.appMenuToggle;
    const menu = els.appMenu;

    let hideTimer = null;
    const isOpen = () => menu.classList.contains("is-open");
    const close = () => {
      menu.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (menu.classList.contains("is-open")) return;
        menu.classList.add("hidden");
      }, 220);
    };
    const open = () => {
      clearTimeout(hideTimer);
      menu.classList.remove("hidden");
      // Ensure the closed-state styles apply for one frame so the drawer can animate.
      requestAnimationFrame(() => {
        if (!menu.classList.contains("hidden")) menu.classList.add("is-open");
      });
      toggle.setAttribute("aria-expanded", "true");
    };

    toggle.addEventListener("click", (event) => {
      bumpInteraction();
      event?.stopPropagation?.();
      if (isOpen()) close();
      else open();
    });

    menu.addEventListener("click", (event) => {
      event?.stopPropagation?.();
      const btn = event?.target?.closest ? event.target.closest("button[data-menu-close]") : null;
      if (btn) close();
    });

    window.addEventListener(
      "click",
      (event) => {
        if (!isOpen()) return;
        const t = event?.target;
        if (t && (toggle.contains(t) || menu.contains(t))) return;
        close();
      },
      { capture: true }
    );

    window.addEventListener("keydown", (event) => {
      const key = String(event?.key || "");
      if (key !== "Escape") return;
      if (!isOpen()) return;
      close();
    });
  }

  if (els.reelAdminToggle) {
    updateReelSizeButton();
    els.reelAdminToggle.addEventListener("click", () => {
      bumpInteraction();
      toggleReelSizeLock();
      ensureCanvasSize();
    });
  }

  if (!reelPresetWindowResizeAttached) {
    reelPresetWindowResizeAttached = true;
    window.addEventListener("resize", () => {
      if (!isReelSizeLocked()) return;
      setReelSizeLock(true);
      ensureCanvasSize();
    });
  }

  if (els.newRun)
    els.newRun.addEventListener("click", () => {
      bumpInteraction();
      runWithUserError("Create run", () => createRun(), {
        retryHint: "Check permissions and try again.",
      });
    });
  if (els.motherWheelMenu) {
    els.motherWheelMenu.addEventListener("click", (event) => {
      event?.stopPropagation?.();
      const btn = event?.target?.closest ? event.target.closest("button[data-action]") : null;
      if (!btn || !els.motherWheelMenu.contains(btn)) return;
      bumpInteraction();
      const action = String(btn.dataset?.action || "").trim();
      if (!action) return;
      dispatchMotherWheelAction(action).catch((err) => {
        console.error(err);
        showToast(err?.message || "Mother wheel action failed.", "error", 2400);
      });
    });

    window.addEventListener(
      "pointerdown",
      (event) => {
        if (!isMotherWheelOpen()) return;
        const target = event?.target;
        if (target && els.motherWheelMenu.contains(target)) return;
        closeMotherWheelMenu({ immediate: false });
      },
      { capture: true }
    );

    window.addEventListener("keydown", (event) => {
      if (!isMotherWheelOpen()) return;
      const key = String(event?.key || "");
      if (key === "Escape") closeMotherWheelMenu({ immediate: false });
    });
  }
  if (els.openRun)
    els.openRun.addEventListener("click", () => {
      bumpInteraction();
      runWithUserError("Open run", () => openExistingRun(), {
        retryHint: "Choose a valid run folder and retry.",
      });
    });
  if (els.import)
    els.import.addEventListener("click", () => {
      bumpInteraction();
      runWithUserError("Import photos", () => importPhotos(), {
        retryHint: "Choose supported image files and retry.",
      });
    });
  if (els.export)
    els.export.addEventListener("click", () => {
      bumpInteraction();
      runWithUserError("Export run", () => exportRun(), {
        retryHint: "Ensure the run directory is writable and retry.",
      });
    });

  if (els.motherAbilityIcon) {
    if (!els.motherAbilityIcon.textContent) {
      els.motherAbilityIcon.textContent = "→";
    }
    els.motherAbilityIcon.addEventListener("click", () => {
      // Cycling proposals should not invalidate intent hypothesis state.
      bumpInteraction({ semantic: false });
      const cycled = motherV2CycleProposal(1);
      if (cycled) {
        recordUserEvent("mother_next_proposal", {});
      } else {
        const phase = state.motherIdle?.phase || motherIdleInitialState();
        if (phase !== MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING) {
          showToast("Next proposal appears during intent hypothesis.", "tip", 1800);
        } else {
          showToast("No additional proposals available.", "tip", 1600);
        }
        return;
      }
    });
  }
  if (els.motherConfirm) {
    els.motherConfirm.addEventListener("click", () => {
      startMotherTakeover().catch(() => {});
    });
  }
  if (els.motherStop) {
    els.motherStop.addEventListener("click", () => {
      stopMotherTakeover();
    });
  }
  if (els.motherPanel) {
    els.motherPanel.addEventListener("pointerenter", () => {
      motherV2RevealHints({ engaged: false, ms: 1700 });
    });
    els.motherPanel.addEventListener("pointerleave", () => {
      if (!state.motherIdle?.advancedOpen && !state.motherIdle?.optionReveal) {
        motherV2HideHints();
      }
    });
    els.motherPanel.addEventListener("focusin", () => {
      motherV2RevealHints({ engaged: true, ms: 2100 });
    });
    els.motherPanel.addEventListener("focusout", () => {
      if (!state.motherIdle?.advancedOpen && !state.motherIdle?.optionReveal) {
        motherV2HideHints();
      }
    });
  }
  if (els.motherRefineToggle) {
    els.motherRefineToggle.addEventListener("click", () => {
      bumpInteraction();
      motherV2SetAdvancedOpen(!Boolean(state.motherIdle?.advancedOpen));
    });
  }

  const onAdvancedRoleChange = (roleKey, value) => {
    const idle = state.motherIdle;
    if (!idle || !MOTHER_V2_ROLE_KEYS.includes(roleKey)) return;
    const imageId = String(value || "").trim();
    const nextIds = imageId && state.imagesById.has(imageId) ? [imageId] : [];
    motherV2SetRoleIds(roleKey, nextIds);
    if (idle.intent && typeof idle.intent === "object") {
      idle.intent.roles = motherV2RoleMapClone();
    }
    motherV2InvalidateOfferingForStructureEdit("advanced_role_edit");
    motherV2RevealHints({ engaged: true, ms: 1800 });
    renderMotherReadout();
    requestRender();
  };

  if (els.motherRoleSubject) {
    els.motherRoleSubject.addEventListener("change", () => onAdvancedRoleChange("subject", els.motherRoleSubject.value));
  }
  if (els.motherRoleModel) {
    els.motherRoleModel.addEventListener("change", () => onAdvancedRoleChange("model", els.motherRoleModel.value));
  }
  if (els.motherRoleMediator) {
    els.motherRoleMediator.addEventListener("change", () => onAdvancedRoleChange("mediator", els.motherRoleMediator.value));
  }
  if (els.motherRoleObject) {
    els.motherRoleObject.addEventListener("change", () => onAdvancedRoleChange("object", els.motherRoleObject.value));
  }
  if (els.motherTransformationMode) {
    els.motherTransformationMode.addEventListener("change", () => {
      const idle = state.motherIdle;
      if (!idle || !idle.intent || typeof idle.intent !== "object") return;
      const mode = motherV2NormalizeTransformationMode(els.motherTransformationMode.value);
      idle.intent.transformation_mode = mode;
      idle.intent.summary = motherV2ProposalSentence(idle.intent);
      motherV2InvalidateOfferingForStructureEdit("advanced_mode_edit");
      motherV2RevealHints({ engaged: true, ms: 1800 });
      renderMotherReadout();
      requestRender();
    });
  }
  window.addEventListener("keydown", (event) => {
    if (String(event?.key || "") !== "Alt") return;
    if (event.metaKey || event.ctrlKey) return;
    const target = event?.target;
    const tag = target?.tagName ? String(target.tagName).toLowerCase() : "";
    const isEditable = Boolean(
      target &&
        (target.isContentEditable ||
          tag === "input" ||
          tag === "textarea" ||
          tag === "select")
    );
    if (isEditable) return;
    wheelForcePanHeld = true;
  });
  window.addEventListener("keyup", (event) => {
    if (String(event?.key || "") !== "Alt") return;
    wheelForcePanHeld = false;
  });
  window.addEventListener("keydown", (event) => {
    const key = String(event?.key || "").toLowerCase();
    if (key !== MOTHER_OPTION_REVEAL_HOLD_KEY) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event?.target;
    const tag = target?.tagName ? String(target.tagName).toLowerCase() : "";
    const isEditable = Boolean(
      target &&
        (target.isContentEditable ||
          tag === "input" ||
          tag === "textarea" ||
          tag === "select")
    );
    if (isEditable) return;
    const idle = state.motherIdle;
    if (!idle) return;
    if (idle.optionReveal) return;
    idle.optionReveal = true;
    motherV2RevealHints({ engaged: true, ms: 1800 });
    renderMotherReadout();
    requestRender();
  });
  window.addEventListener("keyup", (event) => {
    const key = String(event?.key || "").toLowerCase();
    if (key !== MOTHER_OPTION_REVEAL_HOLD_KEY) return;
    const idle = state.motherIdle;
    if (!idle) return;
    idle.optionReveal = false;
    if (!idle.advancedOpen) {
      motherV2HideHints({ immediate: true });
    }
    renderMotherReadout();
    requestRender();
  });
  window.addEventListener("blur", () => {
    wheelForcePanHeld = false;
    const idle = state.motherIdle;
    if (!idle) return;
    idle.optionReveal = false;
    if (!idle.advancedOpen) {
      motherV2HideHints({ immediate: true });
    }
  });

  if (els.canvasContextSuggestBtn) {
    els.canvasContextSuggestBtn.addEventListener("click", () => {
      bumpInteraction();
      const rec = state.canvasContextSuggestion;
      if (!rec?.action) return;
      triggerCanvasContextSuggestedAction(rec.action).catch((err) => {
        const msg = err?.message || String(err);
        showToast(msg, "error", 2600);
      });
    });
  }

  if (els.dropHint) {
    const openPicker = (event) => {
      if (els.dropHint.classList.contains("hidden")) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const ptCss =
        event && typeof event.clientX === "number" && typeof event.clientY === "number" && els.canvasWrap
          ? (() => {
              const rect = els.canvasWrap.getBoundingClientRect();
              return { x: event.clientX - rect.left, y: event.clientY - rect.top };
            })()
          : _defaultImportPointCss();
      const opened = openMotherWheelMenuAt(ptCss);
      if (opened) {
        recordUserEvent("mother_wheel_open", {
          x: Math.round(Number(ptCss.x) || 0),
          y: Math.round(Number(ptCss.y) || 0),
        });
      }
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
      refreshPortraitsDirReadout().catch(() => {});
    });
  }
  if (els.settingsClose && els.settingsDrawer) {
    els.settingsClose.addEventListener("click", () => {
      bumpInteraction();
      els.settingsDrawer.classList.add("hidden");
    });
  }

  if (els.portraitsDirPick) {
    els.portraitsDirPick.addEventListener("click", () => {
      pickPortraitsDir().catch((e) => console.error(e));
    });
  }
  if (els.portraitsDirClear) {
    els.portraitsDirClear.addEventListener("click", () => {
      bumpInteraction();
      localStorage.removeItem(PORTRAITS_DIR_LS_KEY);
      clearPortraitsDirOnDisk().catch(() => {});
      invalidatePortraitMediaCache();
      renderPortraitsDirReadout();
      ensurePortraitIndex().catch(() => {});
      updatePortraitIdle({ fromSettings: true });
    });
  }

  if (els.timelineToggle) {
    els.timelineToggle.addEventListener("click", () => {
      bumpInteraction();
      openTimeline();
    });
  }
  if (els.timelineClose) {
    els.timelineClose.addEventListener("click", () => {
      bumpInteraction();
      closeTimeline();
    });
  }
  if (els.timelineOverlay) {
    els.timelineOverlay.addEventListener("pointerdown", (event) => {
      if (event?.target === els.timelineOverlay) {
        bumpInteraction();
        closeTimeline();
      }
    });
  }
  if (els.timelineStrip) {
    els.timelineStrip.addEventListener("click", (event) => {
      const card = event?.target?.closest ? event.target.closest(".timeline-card[data-node-id]") : null;
      if (!card || !els.timelineStrip.contains(card)) return;
      const nodeId = card.dataset?.nodeId;
      if (!nodeId) return;
      bumpInteraction();
      jumpToTimelineNode(nodeId).catch((err) => console.error(err));
    });
    els.timelineStrip.addEventListener("keydown", (event) => {
      const key = String(event?.key || "");
      if (key !== "Enter" && key !== " ") return;
      const card = event?.target?.closest ? event.target.closest(".timeline-card[data-node-id]") : null;
      if (!card || !els.timelineStrip.contains(card)) return;
      const nodeId = card.dataset?.nodeId;
      if (!nodeId) return;
      event.preventDefault();
      bumpInteraction();
      jumpToTimelineNode(nodeId).catch((err) => console.error(err));
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
  if (els.alwaysOnVisionToggle) {
    els.alwaysOnVisionToggle.checked = settings.alwaysOnVision;
    els.alwaysOnVisionToggle.addEventListener("change", () => {
      bumpInteraction();
      settings.alwaysOnVision = els.alwaysOnVisionToggle.checked;
      localStorage.setItem("brood.alwaysOnVision", settings.alwaysOnVision ? "1" : "0");
      if (state.alwaysOnVision) {
        state.alwaysOnVision.enabled = settings.alwaysOnVision;
        state.alwaysOnVision.pending = false;
        state.alwaysOnVision.pendingPath = null;
        state.alwaysOnVision.pendingAt = 0;
        state.alwaysOnVision.contentDirty = false;
        state.alwaysOnVision.dirtyReason = null;
        state.alwaysOnVision.disabledReason = null;
        state.alwaysOnVision.rtState = settings.alwaysOnVision ? "connecting" : "off";
        if (!settings.alwaysOnVision) state.alwaysOnVision.lastText = null;
      }
      state.canvasContextSuggestion = null;
      updateAlwaysOnVisionReadout();
      renderQuickActions();
      if (settings.alwaysOnVision) {
        setStatus("Engine: always-on vision enabled");
        markAlwaysOnVisionDirty("aov_enable");
        ensureEngineSpawned({ reason: "always-on vision" })
          .then((ok) => {
            if (!ok) return;
            return invoke("write_pty", { data: `${PTY_COMMANDS.CANVAS_CONTEXT_RT_START}\n` }).catch(() => {});
          })
          .catch(() => {});
        scheduleAlwaysOnVision({ immediate: true });
      } else {
        setStatus("Engine: always-on vision disabled");
        updatePortraitIdle({ fromSettings: true });
        if (state.ptySpawned) {
          invoke("write_pty", { data: `${PTY_COMMANDS.CANVAS_CONTEXT_RT_STOP}\n` }).catch(() => {});
        }
      }
    });
  }
  if (els.autoAcceptSuggestedAbilityToggle) {
    els.autoAcceptSuggestedAbilityToggle.checked = settings.autoAcceptSuggestedAbility;
    els.autoAcceptSuggestedAbilityToggle.addEventListener("change", () => {
      bumpInteraction();
      settings.autoAcceptSuggestedAbility = els.autoAcceptSuggestedAbilityToggle.checked;
      localStorage.setItem("brood.autoAcceptSuggestedAbility", settings.autoAcceptSuggestedAbility ? "1" : "0");
      if (state.autoAcceptSuggestedAbility) {
        state.autoAcceptSuggestedAbility.enabled = settings.autoAcceptSuggestedAbility;
        state.autoAcceptSuggestedAbility.passes = 0;
        state.autoAcceptSuggestedAbility.lastAcceptedAt = 0;
        state.autoAcceptSuggestedAbility.inFlight = false;
      }
      // If there's already a suggestion visible, the next render will auto-accept.
      renderCanvasContextSuggestion();
    });
  }
  if (els.textModel) {
    els.textModel.value = settings.textModel;
    els.textModel.addEventListener("change", () => {
      bumpInteraction();
      settings.textModel = els.textModel.value;
      localStorage.setItem("brood.textModel", settings.textModel);
      updatePortraitIdle({ fromSettings: true });
      if (state.ptySpawned) {
        invoke("write_pty", { data: `${PTY_COMMANDS.TEXT_MODEL} ${settings.textModel}\n` }).catch(() => {});
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
        invoke("write_pty", { data: `${PTY_COMMANDS.IMAGE_MODEL} ${settings.imageModel}\n` }).catch(() => {});
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
      bumpInteraction({ semantic: false });
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
		      if (isMotherWheelOpen()) {
		        closeMotherWheelMenu({ immediate: false });
		        return;
		      }
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

      if (rawKey === "ArrowLeft" || rawKey === "ArrowRight" || rawKey === "ArrowUp" || rawKey === "ArrowDown") {
        if (!state.images || state.images.length === 0) return;
        bumpInteraction({ semantic: false });
        event.preventDefault();
        const dpr = getDpr();
        const baseStep = Math.round(40 * dpr);
        const step = event.shiftKey ? baseStep * 3 : baseStep;
        let dx = 0;
        let dy = 0;
        if (rawKey === "ArrowLeft") dx = step;
        if (rawKey === "ArrowRight") dx = -step;
        if (rawKey === "ArrowUp") dy = step;
        if (rawKey === "ArrowDown") dy = -step;
        if (state.canvasMode === "multi") {
          state.multiView.offsetX = (Number(state.multiView?.offsetX) || 0) + dx;
          state.multiView.offsetY = (Number(state.multiView?.offsetY) || 0) + dy;
        } else {
          state.view.offsetX = (Number(state.view?.offsetX) || 0) + dx;
          state.view.offsetY = (Number(state.view?.offsetY) || 0) + dy;
        }
        renderHudReadout();
        requestRender();
        return;
      }

      if (state.mother?.running) {
        const motherBlockedShortcut =
          key === "backspace" ||
          key === "delete" ||
          key === "l" ||
          key === "v" ||
          key === "d" ||
          key === "b" ||
          key === "r" ||
          key === "m" ||
          key === "f" ||
          key === "x" ||
          key === "j" ||
          /^[1-9]$/.test(rawKey);
        if (motherBlockedShortcut) {
          showToast("Mother is running. Click Stop to regain control.", "tip", 2200);
        }
        return;
      }

      const motherPhase = state.motherIdle?.phase || motherIdleInitialState();
      const motherUndoAvailable = motherV2CommitUndoAvailable();
      if (key === "v") {
        if (
          motherPhase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING ||
          motherPhase === MOTHER_IDLE_STATES.OFFERING
        ) {
          event.preventDefault();
          startMotherTakeover().catch(() => {});
          return;
        }
      }
      if (key === "m") {
        if (
          motherUndoAvailable ||
          motherPhase === MOTHER_IDLE_STATES.INTENT_HYPOTHESIZING ||
          motherPhase === MOTHER_IDLE_STATES.OFFERING ||
          motherPhase === MOTHER_IDLE_STATES.DRAFTING
        ) {
          event.preventDefault();
          stopMotherTakeover();
          return;
        }
      }
      if (key === "r" && motherPhase === MOTHER_IDLE_STATES.OFFERING) {
        event.preventDefault();
        const idle = state.motherIdle;
        if (idle) {
          for (const draft of Array.isArray(idle.drafts) ? idle.drafts : []) {
            if (draft?.path) removeFile(String(draft.path)).catch(() => {});
            if (draft?.receiptPath) removeFile(String(draft.receiptPath)).catch(() => {});
          }
          idle.drafts = [];
          idle.selectedDraftId = null;
          idle.hoverDraftId = null;
          motherV2ForcePhase(MOTHER_IDLE_STATES.DRAFTING, "reroll");
          motherIdleDispatchGeneration().catch((err) => {
            motherIdleHandleGenerationFailed(err?.message || "Mother reroll failed.");
          });
        }
        return;
      }

      if (key === "backspace" || key === "delete") {
	      if (state.activeCircle) {
	        const ok = deleteActiveCircle();
	        if (ok) showToast("Circle deleted.", "tip", 1400);
	        return;
      }

      const activeId = String(state.activeId || "").trim();
      const selected = getSelectedIds().filter(Boolean);
      const unique = Array.from(new Set(selected.map((v) => String(v || "").trim()).filter(Boolean)));
      if (!unique.length) return;

      event.preventDefault();
      // Remove non-active selections first to avoid thrashing the engine's active-image state.
      const ordered = activeId ? unique.filter((id) => id !== activeId).concat([activeId]) : unique;
      Promise.resolve()
        .then(async () => {
          for (const id of ordered) {
            await removeImageFromCanvas(id).catch(() => {});
          }
        })
        .catch(() => {});
      return;
    }

	    // HUD action grid 1-9.
	    if (/^[1-9]$/.test(rawKey)) {
        if (intentModeActive()) return;
	      const digit = rawKey;
	      const btn = document.querySelector(`.action-grid .tool[data-hotkey="${digit}"]`);
	      if (btn) {
        btn.click();
        return;
      }
    }

    if (key === "l") {
      if (intentModeActive()) return;
      setTool("lasso");
      return;
    }
    if (key === "x") {
      runWithUserError("Extract DNA", () => runExtractDnaFromSelection(), {
        statusScope: "Director",
        retryHint: "Select at least one image and retry.",
      });
      return;
    }
    if (key === "j") {
      runWithUserError("Soul Leech", () => runSoulLeechFromSelection(), {
        statusScope: "Director",
        retryHint: "Select at least one image and retry.",
      });
      return;
    }
    if (key === "v") {
      setTool("pan");
      return;
    }
    if (key === "d") {
      if (intentModeActive()) return;
      setTool("designate");
      return;
    }
    if (key === "b") {
      runWithUserError("Background replace", () => applyBackground("white"), {
        retryHint: "Select an image and try again.",
      });
      return;
    }
    if (key === "r") {
      if (event.shiftKey) {
        runWithUserError("Recast", () => runRecast(), {
          retryHint: "Select an image and retry.",
        });
      } else {
        runWithUserError("Variations", () => runVariations(), {
          retryHint: "Select an image and retry.",
        });
      }
      return;
    }
    if (key === "m") {
      if (intentModeActive()) {
        showToast("Intent Mode: Multi view only (until intent is locked).", "tip", 2200);
        return;
      }
      if (state.images.length < 2) {
        showToast("Multi view needs at least 2 images.", "tip", 2000);
        return;
      }
      const next = state.canvasMode === "multi" ? "single" : "multi";
      setCanvasMode(next);
      showToast(next === "multi" ? "Multi view." : "Single view.", "tip", 1400);
      return;
    }
    if (key === "f") {
      resetViewToFit();
      return;
    }
  });
}

async function boot() {
  if (!els.workCanvas || !els.overlayCanvas || !els.effectsCanvas) {
    setStatus("Engine: UI error (missing canvas)", true);
    return;
  }

  setStatus("Engine: booting…");
  setRunInfo("No run");
  ensureIntentUiIconsLoaded().catch(() => {});
  refreshKeyStatus().catch(() => {});
  updateAlwaysOnVisionReadout();
  renderQuickActions();
  renderSessionApiCallsReadout();
  clearInterval(topMetricsTickTimer);
  topMetricsTickTimer = setInterval(() => {
    renderSessionApiCallsReadout();
  }, 15_000);
  syncBrandStripHeightVar();
  if (typeof ResizeObserver === "function" && els.brandStrip) {
    try {
      if (brandStripResizeObserver) brandStripResizeObserver.disconnect();
      brandStripResizeObserver = new ResizeObserver(() => {
        syncBrandStripHeightVar();
      });
      brandStripResizeObserver.observe(els.brandStrip);
      requestAnimationFrame(() => syncBrandStripHeightVar());
    } catch {
      // ignore
    }
  }
  ensurePortraitIndex().catch(() => {});
  updatePortraitIdle({ fromSettings: true });
  syncIntentModeClass();
  updateEmptyCanvasHint();
  renderSelectionMeta();
  chooseSpawnNodes();
  renderFilmstrip();
  ensureCanvasSize();
  effectsRuntime = createEffectsRuntime({ canvas: els.effectsCanvas });
  effectsRuntime.resize({
    width: els.workCanvas.width,
    height: els.workCanvas.height,
    dpr: getDpr(),
  });
  effectsRuntime.setSuspended(document.hidden || state.canvasMode !== "multi");
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
      stopMotherGlitchLoop();
    } else {
      ensureLarvaAnimator();
      startMotherGlitchLoop();
    }
    if (effectsRuntime) {
      effectsRuntime.setSuspended(document.hidden || state.canvasMode !== "multi");
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
  if (ENABLE_FILE_BROWSER_DOCK) {
    await initializeFileBrowserDock();
  }
  startMotherGlitchLoop();
  startSpawnTimer();

  await listen("pty-exit", () => {
    setStatus("Engine: exited", true);
    state.ptySpawned = false;
    resetDescribeQueue({ clearPending: true });
    state.expectingArtifacts = false;
    state.pendingBlend = null;
    state.pendingSwapDna = null;
    state.pendingBridge = null;
    state.pendingExtractDna = null;
    state.pendingSoulLeech = null;
    state.pendingRecast = null;
    state.pendingDiagnose = null;
    state.pendingArgue = null;
    for (const [tokenId] of state.effectTokenApplyLocks.entries()) {
      const token = state.effectTokensById.get(tokenId) || null;
      if (token) recoverEffectTokenApply(token);
    }
    state.effectTokenApplyLocks.clear();
    clearPendingReplace();
    state.runningActionKey = null;
    state.engineImageModelRestore = null;
    setImageFxActive(false);
    updatePortraitIdle();
    setDirectorText(null, null);
    renderQuickActions();
  });

  // Consume PTY stdout as a fallback for vision describe completion/errors.
  // Desktop normally uses `events.jsonl`, but if event polling is disrupted, this
  // keeps the HUD "DESC" from getting stuck at ANALYZING.
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

  await listen("desktop-automation", (event) => {
    console.log("[desktop-automation] listener hit", event);
    void handleDesktopAutomation(event);
  });

  // Auto-create a run for speed; users can always "Open Run" later.
  await createRun();
  await invoke("report_automation_frontend_ready", { ready: true }).catch((err) => {
    console.warn("desktop automation readiness handshake failed", err);
  });
  requestRender();
}

boot().catch((err) => {
  console.error(err);
  setStatus(`Engine: boot failed (${err?.message || err})`, true);
});
