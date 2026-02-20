import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { FitAddon } from "xterm-addon-fit";
import { invoke, convertFileSrc } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import {
  readTextFile,
  readDir,
  exists,
  readBinaryFile,
  writeTextFile,
  createDir,
  copyFile,
  removeDir,
} from "@tauri-apps/api/fs";
import { open } from "@tauri-apps/api/dialog";
import { writeText } from "@tauri-apps/api/clipboard";

const terminalEl = document.getElementById("terminal");
const terminalShell = document.querySelector(".terminal-shell");
const terminalInput = document.getElementById("terminal-input");
const terminalSend = document.getElementById("terminal-send");
const goalsToggle = document.getElementById("goals-toggle");
const engineStatus = document.getElementById("engine-status");
const galleryEl = document.getElementById("gallery");
const detailEl = document.getElementById("detail");
const runInfoEl = document.getElementById("run-info");
const contextEl = document.getElementById("context-usage");
const goalChipsEl = document.getElementById("goal-chips");
const goalRowEl = document.getElementById("goal-row");
const optimizeModeSelect = document.getElementById("optimize-mode");
const optimizeTimingEl = document.getElementById("optimize-timing");
const optimizePanel = document.getElementById("optimize-panel");
const optimizeMetaEl = document.getElementById("optimize-meta");
const optimizeAnalysisEl = document.getElementById("optimize-analysis");
const optimizeRecsEl = document.getElementById("optimize-recs");
const aestheticCountEl = document.getElementById("aesthetic-count");
const aestheticWarningEl = document.getElementById("aesthetic-warning");
const aestheticModalEl = document.getElementById("aesthetic-modal");
const aestheticPickFolderBtn = document.getElementById("aesthetic-pick-folder");
const aestheticPickFilesBtn = document.getElementById("aesthetic-pick-files");
const aestheticSelectionEl = document.getElementById("aesthetic-selection");
const aestheticSelectionTitleEl = document.getElementById("aesthetic-selection-title");
const aestheticSelectionListEl = document.getElementById("aesthetic-selection-list");
const aestheticSelectionWarningEl = document.getElementById("aesthetic-selection-warning");
const aestheticStepSelectEl = document.getElementById("aesthetic-step-select");
const aestheticStepSummaryEl = document.getElementById("aesthetic-step-summary");
const aestheticProgressImagesEl = document.getElementById("aesthetic-progress-images");
const aestheticProgressAnnotationsEl = document.getElementById("aesthetic-progress-annotations");
const aestheticProgressMetaEl = document.getElementById("aesthetic-progress-meta");
const aestheticSummaryEl = document.getElementById("aesthetic-summary");
const aestheticImportBtn = document.getElementById("aesthetic-import");
const aestheticCancelBtn = document.getElementById("aesthetic-cancel");
const aestheticCloseBtn = document.getElementById("aesthetic-close");
const aestheticReplaceNoteEl = document.getElementById("aesthetic-replace-note");
const aestheticBackBtn = document.getElementById("aesthetic-back");
const aestheticDoneBtn = document.getElementById("aesthetic-done");
const aestheticStepDots = document.querySelectorAll(".wizard-dot");

const state = {
  runDir: null,
  eventsPath: null,
  eventsOffset: 0,
  eventsByteOffset: 0,
  eventsTail: "",
  eventsDecoder: new TextDecoder("utf-8"),
  fallbackToFullRead: false,
  pollInFlight: false,
  artifacts: new Map(),
  galleryCardById: new Map(),
  selected: new Set(),
  placeholders: [],
  flickerTimer: null,
  ptyReady: false,
  ptySpawning: false,
  engineLaunchMode: "compat",
  engineLaunchPath: null,
  engineCompatRetried: false,
  pendingPtyExit: false,
  poller: null,
  blobUrls: new Map(),
  receiptCache: new Map(),
  pendingEchoes: [],
  echoBuffer: "",
  controlBuffer: "",
  lastError: null,
  goalChipsShown: false,
  goalChipsSuppressed: false,
  goalChipsAutoHold: false,
  goalSelections: new Set(),
  goalSendTimer: null,
  goalAnalyzeInFlight: false,
  optimizeMode: "auto",
  optimize: {
    goals: [],
    analysisExcerpt: "",
    recommendations: [],
    analysisElapsedS: null,
    generationElapsedS: null,
    round: null,
    roundTotal: null,
    mode: "auto",
    error: null,
  },
  aesthetic: {
    images: [],
    count: 0,
    importedAt: null,
  },
};

function setStatus(message, isError = false) {
  if (!engineStatus) return;
  engineStatus.textContent = message;
  engineStatus.classList.toggle("error", isError);
}

function reportError(err) {
  const msg = err?.message || String(err);
  term.writeln(formatBroodLine(`\r\n[brood] error: ${msg}`));
  setStatus(`Engine: error (${msg})`, true);
}

const term = new Terminal({
  fontFamily: "IBM Plex Mono",
  fontSize: 15,
  lineHeight: 1.3,
  cursorBlink: false,
  cursorStyle: "bar",
  disableStdin: true,
  theme: {
    background: "#0d1219",
    foreground: "#e6edf3",
    cursor: "#ffb300",
  },
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(terminalEl);
terminalEl.setAttribute("tabindex", "0");
const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();
  resizePty();
  positionGoalChips();
});
resizeObserver.observe(terminalEl);
function resizePty() {
  const cols = term?.cols || 0;
  const rows = term?.rows || 0;
  if (!cols || !rows) return;
  invoke("resize_pty", { cols, rows }).catch(() => {});
}
requestAnimationFrame(() => {
  fitAddon.fit();
  resizePty();
  positionGoalChips();
  term.writeln(formatBroodLine("[brood] terminal ready."));
  term.write("\u001b[?25h");
  if (terminalInput) {
    terminalInput.focus();
  }
});
window.addEventListener("resize", () => {
  fitAddon.fit();
  resizePty();
  positionGoalChips();
});
setStatus("Engine: idle — click New Run");

window.addEventListener("error", (event) => {
  reportError(event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  reportError(event.reason);
});

terminalEl.addEventListener("click", () => {
  if (terminalInput) terminalInput.focus();
});

const GOAL_OPTIONS = [
  {
    id: "quality",
    label: "Maximize quality",
    token: "quality",
  },
  {
    id: "cost",
    label: "Minimize cost",
    token: "cost",
  },
  {
    id: "time",
    label: "Minimize time",
    token: "time",
  },
  {
    id: "retrieval",
    label: "Maximize retrieval",
    token: "retrieval",
  },
];

const AESTHETIC_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic"]);
const AESTHETIC_RECOMMENDED_MIN = 10;
const AESTHETIC_WARNING_MAX = 50;

let aestheticDraft = {
  sourceKind: null,
  sourceDir: null,
  sourcePaths: [],
  scanRecursive: false,
  error: "",
};

let aestheticWizardStep = 1;
let aestheticWizardProgress = {
  images: "Pending",
  annotations: "Pending",
  meta: "Pending",
  summary: "",
};

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}h ${minutes}m ${String(secs).padStart(2, "0")}s`;
  if (minutes) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function basename(path) {
  if (!path) return "";
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/");
}

function getExtension(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "";
  return name.slice(dot).toLowerCase();
}

function isAestheticImage(path) {
  return AESTHETIC_EXTENSIONS.has(getExtension(path));
}

function uniqueAestheticNames(paths) {
  const seen = new Set();
  return paths.map((path, idx) => {
    const original = basename(path) || `aesthetic-${idx + 1}${getExtension(path) || ""}`;
    const dot = original.lastIndexOf(".");
    const stem = dot === -1 ? original : original.slice(0, dot);
    const ext = dot === -1 ? "" : original.slice(dot);
    let candidate = original;
    let counter = 1;
    while (seen.has(candidate)) {
      candidate = `${stem}-${counter}${ext}`;
      counter += 1;
    }
    seen.add(candidate);
    return { source: path, filename: candidate };
  });
}

function relativeToRun(path) {
  if (!state.runDir) return path;
  const runRoot = normalizePath(state.runDir);
  const target = normalizePath(path);
  const prefix = `${runRoot}/`;
  if (target.startsWith(prefix)) {
    return target.slice(prefix.length);
  }
  return path;
}

function aestheticWarning(count) {
  if (!Number.isFinite(count) || count === 0) return "";
  if (count < AESTHETIC_RECOMMENDED_MIN) {
    return `Only ${count} image${count === 1 ? "" : "s"}; 10-20 recommended.`;
  }
  if (count > AESTHETIC_WARNING_MAX) {
    return `${count} images selected; >50 may dilute consistency.`;
  }
  return "";
}

function renderAestheticStatus() {
  const count = Number.isFinite(state.aesthetic.count) ? state.aesthetic.count : 0;
  if (aestheticCountEl) {
    aestheticCountEl.textContent = `Aesthetic: ${count} image${count === 1 ? "" : "s"}`;
  }
  if (aestheticWarningEl) {
    const warning = aestheticWarning(count);
    if (warning) {
      aestheticWarningEl.textContent = warning;
      aestheticWarningEl.classList.remove("hidden");
    } else {
      aestheticWarningEl.textContent = "";
      aestheticWarningEl.classList.add("hidden");
    }
  }
  if (clearAestheticBtn) {
    clearAestheticBtn.disabled = count === 0;
  }
}

function updateOptimizeTiming() {
  if (!optimizeTimingEl) return;
  const analysis = formatDuration(state.optimize.analysisElapsedS);
  const generation = formatDuration(state.optimize.generationElapsedS);
  optimizeTimingEl.textContent = `Analysis ${analysis} · Generate ${generation}`;
}

function formatRecommendation(rec) {
  if (typeof rec === "string") return rec;
  if (!rec || typeof rec !== "object") return "";
  const name = rec.setting_name;
  const value = rec.setting_value;
  const target = rec.setting_target || "provider_options";
  if (target === "comment") return String(value || "");
  if (target === "request" || target === "top_level") {
    return `${name}=${value}`;
  }
  return `provider_options.${name}=${value}`;
}

function renderOptimizePanel() {
  if (!optimizePanel) return;
  const data = state.optimize;
  const hasContent =
    Boolean(data.analysisExcerpt) ||
    (data.recommendations && data.recommendations.length > 0) ||
    Number.isFinite(data.analysisElapsedS) ||
    Number.isFinite(data.generationElapsedS);
  if (!hasContent) {
    optimizePanel.classList.add("hidden");
    return;
  }
  optimizePanel.classList.remove("hidden");
  if (optimizeMetaEl) {
    const parts = [];
    if (data.mode) parts.push(`Mode: ${data.mode}`);
    if (data.round && data.roundTotal) {
      parts.push(`Round ${data.round}/${data.roundTotal}`);
    }
    if (data.goals && data.goals.length) {
      parts.push(`Goals: ${data.goals.join(", ")}`);
    }
    if (Number.isFinite(data.analysisElapsedS)) {
      parts.push(`Analysis ${formatDuration(data.analysisElapsedS)}`);
    }
    if (Number.isFinite(data.generationElapsedS)) {
      parts.push(`Generate ${formatDuration(data.generationElapsedS)}`);
    }
    optimizeMetaEl.textContent = parts.join(" · ");
  }
  if (optimizeAnalysisEl) {
    if (data.analysisExcerpt) {
      optimizeAnalysisEl.textContent = `Analysis: ${data.analysisExcerpt}`;
      optimizeAnalysisEl.style.display = "block";
    } else {
      optimizeAnalysisEl.textContent = "";
      optimizeAnalysisEl.style.display = "none";
    }
  }
  if (optimizeRecsEl) {
    optimizeRecsEl.innerHTML = "";
    if (!data.recommendations || data.recommendations.length === 0) {
      const empty = document.createElement("div");
      empty.className = "optimize-rec";
      empty.textContent = "No recommendations.";
      optimizeRecsEl.appendChild(empty);
    } else {
      for (const rec of data.recommendations) {
        const row = document.createElement("div");
        row.className = "optimize-rec";
        const line = document.createElement("div");
        line.textContent = formatRecommendation(rec);
        row.appendChild(line);
        if (rec?.rationale) {
          const note = document.createElement("div");
          note.className = "optimize-rec-note";
          note.textContent = rec.rationale;
          row.appendChild(note);
        }
        optimizeRecsEl.appendChild(row);
      }
    }
  }
  updateOptimizeTiming();
}

function resetOptimizeState() {
  state.optimize = {
    goals: [],
    analysisExcerpt: "",
    recommendations: [],
    analysisElapsedS: null,
    generationElapsedS: null,
    round: null,
    roundTotal: null,
    mode: state.optimizeMode || "auto",
    error: null,
  };
  renderOptimizePanel();
  updateOptimizeTiming();
}

function renderGoalChips() {
  if (!goalRowEl) return;
  goalRowEl.innerHTML = "";
  for (const goal of GOAL_OPTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "goal-chip";
    button.textContent = goal.label;
    button.dataset.goalId = goal.id;
    button.addEventListener("click", () => toggleGoal(goal));
    goalRowEl.appendChild(button);
  }
  syncGoalChipState();
}

function syncGoalChipState() {
  if (!goalRowEl) return;
  for (const button of goalRowEl.querySelectorAll(".goal-chip")) {
    const goalId = button.dataset.goalId;
    button.classList.toggle("selected", state.goalSelections.has(goalId));
  }
}

function showGoalChips() {
  if (!goalChipsEl || state.goalChipsShown) return;
  state.goalChipsShown = true;
  renderGoalChips();
  goalChipsEl.classList.remove("hidden");
  if (terminalShell) {
    requestAnimationFrame(() => {
      const height = goalChipsEl.getBoundingClientRect().height;
      const padding = Math.ceil(height + 12);
      terminalShell.style.setProperty("--goal-chips-height", `${padding}px`);
      terminalShell.classList.add("goal-active");
      fitAddon.fit();
      resizePty();
      positionGoalChips();
    });
  }
}

function hideGoalChips() {
  if (!goalChipsEl) return;
  goalChipsEl.classList.add("hidden");
  state.goalChipsShown = false;
  if (terminalShell) {
    terminalShell.classList.remove("goal-active");
    terminalShell.style.removeProperty("--goal-chips-height");
    fitAddon.fit();
    resizePty();
  }
}

function positionGoalChips() {
  if (!goalChipsEl || !terminalEl || !state.goalChipsShown) return;
  const height = terminalEl.clientHeight;
  if (!height || !term?.rows) return;
  const cellHeight = height / term.rows;
  let targetRow = null;
  const buffer = term.buffer?.active;
  if (buffer) {
    const index =
      findLineIndex(buffer, "Generation complete.") ??
      findLineIndex(buffer, "Generated in");
    if (index != null) {
      const viewportY = buffer.viewportY || 0;
      targetRow = index - viewportY + 1;
    }
  }
  if (targetRow == null || !Number.isFinite(targetRow)) {
    targetRow = term.rows - 1;
  }
  targetRow = Math.max(0, Math.min(term.rows - 1, targetRow));
  const chipsHeight = goalChipsEl.getBoundingClientRect().height;
  const maxTop = Math.max(8, height - chipsHeight - 6);
  let top = Math.round(targetRow * cellHeight + 2);
  top = Math.min(top, maxTop);
  goalChipsEl.style.top = `${top}px`;
}

function findLineIndex(buffer, needle) {
  if (!buffer || !needle) return null;
  for (let i = buffer.length - 1; i >= 0; i -= 1) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trimEnd();
    if (text.includes(needle)) return i;
  }
  return null;
}

function shouldAutoShowGoalChips() {
  if (state.goalChipsShown || state.goalChipsSuppressed || state.goalChipsAutoHold) return false;
  if (!state.ptyReady) return false;
  return state.artifacts.size > 0;
}

function isEditPrompt(command) {
  if (!command) return false;
  const normalized = command.trim().toLowerCase();
  if (!normalized || normalized.startsWith("/")) return false;
  return /^(?:now|please|just)?\s*(edit|replace)\b/.test(normalized);
}

function updateGoalChipsSuppression(command) {
  if (!command) return;
  const trimmed = command.trim();
  if (!trimmed) return;
  const normalized = trimmed.toLowerCase();
  if (normalized.startsWith("/optimize")) {
    state.goalChipsSuppressed = true;
    return;
  }
  const isPrompt = !normalized.startsWith("/");
  const isRecreate = normalized.startsWith("/recreate");
  if (isPrompt || isRecreate) {
    if (isPrompt && isEditPrompt(normalized)) {
      state.goalChipsSuppressed = true;
    } else {
      state.goalChipsSuppressed = false;
    }
  }
}

async function readRunMetadata() {
  if (!state.runDir) return {};
  const runPath = `${state.runDir}/run.json`;
  const has = await exists(runPath);
  if (!has) return {};
  try {
    const raw = await readTextFile(runPath);
    const payload = JSON.parse(raw);
    if (payload && typeof payload === "object") {
      return payload;
    }
  } catch {
    // ignore malformed run metadata
  }
  return {};
}

async function writeRunMetadata(payload) {
  if (!state.runDir) return;
  const runPath = `${state.runDir}/run.json`;
  await writeTextFile(runPath, JSON.stringify(payload, null, 2));
}

async function loadAestheticMetadata() {
  state.aesthetic.images = [];
  state.aesthetic.count = 0;
  state.aesthetic.importedAt = null;
  if (!state.runDir) {
    renderAestheticStatus();
    return;
  }
  const meta = await readRunMetadata();
  const stored = meta?.aesthetic;
  if (stored && typeof stored === "object") {
    const images = Array.isArray(stored.images) ? stored.images : [];
    const count =
      typeof stored.count === "number" && Number.isFinite(stored.count)
        ? stored.count
        : images.length;
    state.aesthetic.images = images;
    state.aesthetic.count = count;
    state.aesthetic.importedAt = stored.imported_at || null;
    renderAestheticStatus();
    return;
  }
  const aestheticDir = `${state.runDir}/aesthetic`;
  if (await exists(aestheticDir)) {
    try {
      const entries = await readDir(aestheticDir, { recursive: false });
      const images = entries
        .map((entry) => entry.path)
        .filter((path) => path && isAestheticImage(path));
      state.aesthetic.images = images.map((path) => relativeToRun(path));
      state.aesthetic.count = images.length;
    } catch {
      state.aesthetic.images = [];
      state.aesthetic.count = 0;
    }
  }
  renderAestheticStatus();
}

async function setupAestheticScaffold() {
  if (!state.runDir) return;
  const aestheticDir = `${state.runDir}/aesthetic`;
  const annotationsDir = `${aestheticDir}/annotations`;
  await createDir(aestheticDir, { recursive: true });
  await createDir(annotationsDir, { recursive: true });
  await writeTextFile(
    `${annotationsDir}/aesthetic_pairs_seed.csv`,
    "image_a,image_b\n"
  );
  await writeTextFile(`${annotationsDir}/aesthetic_votes.jsonl`, "");
  // Oscillo arousal training used BT scores -> Ridge on CLIP embeddings + image metrics; we'll mirror this for brand aesthetic.
  await writeTextFile(
    `${aestheticDir}/aesthetic_scores.json`,
    JSON.stringify(
      {
        schema_version: 1,
        scores: {},
        updated_at: null,
      },
      null,
      2
    )
  );
}

async function clearAestheticData() {
  if (!state.runDir) return;
  const aestheticDir = `${state.runDir}/aesthetic`;
  if (await exists(aestheticDir)) {
    await removeDir(aestheticDir, { recursive: true });
  }
  const meta = await readRunMetadata();
  meta.aesthetic = {
    images: [],
    imported_at: null,
    source_paths: [],
    count: 0,
    cleared_at: new Date().toISOString(),
  };
  await writeRunMetadata(meta);
  state.aesthetic.images = [];
  state.aesthetic.count = 0;
  state.aesthetic.importedAt = null;
  renderAestheticStatus();
  renderAestheticWizard();
  setStatus("Engine: aesthetic references cleared");
}

function resetAestheticDraft() {
  aestheticDraft = {
    sourceKind: null,
    sourceDir: null,
    sourcePaths: [],
    scanRecursive: false,
    error: "",
  };
  renderAestheticWizard();
}

function resetAestheticProgress() {
  aestheticWizardProgress = {
    images: "Pending",
    annotations: "Pending",
    meta: "Pending",
    summary: "",
  };
}

function setProgressStatus(el, status) {
  if (!el) return;
  el.textContent = status;
  el.dataset.status = status.toLowerCase();
}

function renderAestheticProgress() {
  setProgressStatus(aestheticProgressImagesEl, aestheticWizardProgress.images);
  setProgressStatus(aestheticProgressAnnotationsEl, aestheticWizardProgress.annotations);
  setProgressStatus(aestheticProgressMetaEl, aestheticWizardProgress.meta);
  if (aestheticSummaryEl) {
    aestheticSummaryEl.textContent = aestheticWizardProgress.summary || "";
  }
}

function renderAestheticSelectionList(paths) {
  if (!aestheticSelectionListEl) return;
  aestheticSelectionListEl.innerHTML = "";
  const limit = 8;
  const list = paths.slice(0, limit);
  for (const path of list) {
    const row = document.createElement("div");
    row.className = "aesthetic-selection-item";
    row.textContent = basename(path);
    aestheticSelectionListEl.appendChild(row);
  }
  if (paths.length > limit) {
    const row = document.createElement("div");
    row.className = "aesthetic-selection-item";
    row.textContent = `+${paths.length - limit} more...`;
    aestheticSelectionListEl.appendChild(row);
  }
}

function renderAestheticWizard() {
  if (!aestheticModalEl) return;
  const hasSelection = Boolean(aestheticDraft.sourceKind);
  const count = Array.isArray(aestheticDraft.sourcePaths) ? aestheticDraft.sourcePaths.length : 0;
  const isStepOne = aestheticWizardStep === 1;
  if (aestheticStepSelectEl) {
    aestheticStepSelectEl.classList.toggle("hidden", !isStepOne);
  }
  if (aestheticStepSummaryEl) {
    aestheticStepSummaryEl.classList.toggle("hidden", isStepOne);
  }
  if (aestheticStepDots && aestheticStepDots.length) {
    aestheticStepDots.forEach((dot) => {
      const step = Number(dot.dataset.step || "0");
      dot.classList.toggle("active", step === aestheticWizardStep);
    });
  }
  if (aestheticBackBtn) {
    aestheticBackBtn.classList.toggle("hidden", isStepOne);
    const working =
      aestheticWizardProgress.images === "Working" ||
      aestheticWizardProgress.annotations === "Working" ||
      aestheticWizardProgress.meta === "Working";
    aestheticBackBtn.disabled = !isStepOne && working;
  }
  if (aestheticDoneBtn) {
    aestheticDoneBtn.classList.toggle("hidden", isStepOne);
    const working =
      aestheticWizardProgress.images === "Working" ||
      aestheticWizardProgress.annotations === "Working" ||
      aestheticWizardProgress.meta === "Working";
    aestheticDoneBtn.disabled = !isStepOne && working;
  }
  if (aestheticCancelBtn) {
    aestheticCancelBtn.classList.toggle("hidden", !isStepOne);
  }
  if (aestheticImportBtn) {
    aestheticImportBtn.classList.toggle("hidden", !isStepOne);
  }
  if (aestheticReplaceNoteEl) {
    if (isStepOne && state.aesthetic.count > 0) {
      aestheticReplaceNoteEl.textContent = `Importing will replace the current set (${state.aesthetic.count} image${state.aesthetic.count === 1 ? "" : "s"}).`;
      aestheticReplaceNoteEl.classList.remove("hidden");
    } else {
      aestheticReplaceNoteEl.textContent = "";
      aestheticReplaceNoteEl.classList.add("hidden");
    }
  }
  if (isStepOne) {
    if (aestheticSelectionEl) {
      aestheticSelectionEl.classList.toggle("hidden", !hasSelection);
    }
    if (aestheticSelectionTitleEl) {
      if (!hasSelection) {
        aestheticSelectionTitleEl.textContent = "";
      } else if (count === 0) {
        aestheticSelectionTitleEl.textContent =
          aestheticDraft.sourceKind === "folder"
            ? "No supported images found in the selected folder."
            : "No supported images selected.";
      } else if (aestheticDraft.sourceKind === "folder") {
        aestheticSelectionTitleEl.textContent = `Folder: ${aestheticDraft.sourceDir} (${count} image${count === 1 ? "" : "s"})`;
      } else {
        aestheticSelectionTitleEl.textContent = `${count} file${count === 1 ? "" : "s"} selected`;
      }
    }
    if (aestheticSelectionListEl) {
      if (count > 0) {
        renderAestheticSelectionList(aestheticDraft.sourcePaths);
      } else {
        aestheticSelectionListEl.innerHTML = "";
      }
    }
    if (aestheticSelectionWarningEl) {
      const warning = aestheticDraft.error || aestheticWarning(count);
      if (warning) {
        aestheticSelectionWarningEl.textContent = warning;
        aestheticSelectionWarningEl.classList.remove("hidden");
      } else {
        aestheticSelectionWarningEl.textContent = "";
        aestheticSelectionWarningEl.classList.add("hidden");
      }
    }
    if (aestheticImportBtn) {
      aestheticImportBtn.disabled = count === 0;
      aestheticImportBtn.textContent =
        count > 0 ? `Import ${count} image${count === 1 ? "" : "s"}` : "Import";
    }
  } else {
    renderAestheticProgress();
  }
}

function openAestheticWizard() {
  if (!state.runDir) {
    setStatus("Engine: open or create a run first", true);
    return;
  }
  if (!aestheticModalEl) return;
  aestheticWizardStep = 1;
  resetAestheticProgress();
  aestheticModalEl.classList.remove("hidden");
  aestheticModalEl.style.display = "flex";
  resetAestheticDraft();
}

function closeAestheticWizard() {
  if (!aestheticModalEl) return;
  aestheticModalEl.classList.add("hidden");
  aestheticModalEl.style.display = "none";
}

async function selectAestheticFolder() {
  const folder = await open({ directory: true, multiple: false });
  if (!folder) return;
  let images = [];
  aestheticDraft.error = "";
  try {
    const entries = await readDir(folder, { recursive: false });
    images = entries.map((entry) => entry.path).filter((path) => path && isAestheticImage(path));
  } catch (err) {
    setStatus(`Engine: failed to read folder (${err})`, true);
    aestheticDraft.error = `Failed to read folder: ${err}`;
  }
  aestheticDraft = {
    sourceKind: "folder",
    sourceDir: folder,
    sourcePaths: Array.from(new Set(images)),
    scanRecursive: false,
    error: aestheticDraft.error || "",
  };
  renderAestheticWizard();
}

async function selectAestheticFiles() {
  const files = await open({
    multiple: true,
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "webp", "heic"],
      },
    ],
  });
  if (!files) return;
  const list = Array.isArray(files) ? files : [files];
  const images = list.filter((path) => path && isAestheticImage(path));
  aestheticDraft = {
    sourceKind: "files",
    sourceDir: null,
    sourcePaths: Array.from(new Set(images)),
    scanRecursive: false,
    error: "",
  };
  renderAestheticWizard();
}

async function persistAestheticSelection(selection) {
  if (!state.runDir) {
    setStatus("Engine: open or create a run first", true);
    return false;
  }
  const sourcePaths = Array.from(new Set(selection.sourcePaths || []));
  if (sourcePaths.length === 0) {
    setStatus("Engine: no supported images found", true);
    return false;
  }
  const aestheticDir = `${state.runDir}/aesthetic`;
  if (await exists(aestheticDir)) {
    await removeDir(aestheticDir, { recursive: true });
  }
  await setupAestheticScaffold();
  const unique = uniqueAestheticNames(sourcePaths);
  const copied = [];
  const copyErrors = [];
  for (const item of unique) {
    const destPath = `${aestheticDir}/${item.filename}`;
    try {
      await copyFile(item.source, destPath);
      copied.push(destPath);
    } catch (err) {
      copyErrors.push(err?.message || String(err));
      term.writeln(
        formatBroodLine(`\r\n[brood] failed to copy ${item.source}: ${err}`)
      );
    }
  }
  if (copied.length === 0) {
    const hint = copyErrors.length
      ? `No images imported. ${copyErrors[0]}`
      : "No images imported.";
    throw new Error(hint);
  }
  const meta = await readRunMetadata();
  const importedAt = new Date().toISOString();
  meta.aesthetic = {
    images: copied.map((path) => relativeToRun(path)),
    imported_at: importedAt,
    source_paths: sourcePaths,
    count: copied.length,
    source_kind: selection.sourceKind,
    source_dir: selection.sourceDir,
    scan_recursive: selection.scanRecursive,
  };
  await writeRunMetadata(meta);
  state.aesthetic.images = meta.aesthetic.images;
  state.aesthetic.count = meta.aesthetic.count;
  state.aesthetic.importedAt = meta.aesthetic.imported_at;
  renderAestheticStatus();
  const warning = aestheticWarning(state.aesthetic.count);
  setStatus(
    warning
      ? `Engine: aesthetic imported (${state.aesthetic.count} images, outside 10-20)`
      : `Engine: aesthetic imported (${state.aesthetic.count} images)`
  );
  return {
    count: copied.length,
    aestheticDir,
    importedAt,
  };
}

async function importAestheticSelection() {
  const count = Array.isArray(aestheticDraft.sourcePaths) ? aestheticDraft.sourcePaths.length : 0;
  aestheticDraft.error = "";
  aestheticWizardStep = 2;
  aestheticWizardProgress = {
    images: "Working",
    annotations: "Working",
    meta: "Working",
    summary: "Importing reference images...",
  };
  renderAestheticWizard();
  setStatus("Engine: importing aesthetic...");
  try {
    const result = await persistAestheticSelection(aestheticDraft);
    if (result) {
      aestheticWizardProgress = {
        images: "Done",
        annotations: "Done",
        meta: "Done",
        summary: `Imported ${result.count} image${result.count === 1 ? "" : "s"}.\nSaved to ${result.aestheticDir}.\nMetadata written to run.json.\nAnnotations scaffolding ready for pairwise scoring.`,
      };
      renderAestheticWizard();
      return;
    }
  } catch (err) {
    aestheticWizardProgress = {
      images: "Error",
      annotations: "Error",
      meta: "Error",
      summary: `Import failed: ${err?.message || err}`,
    };
    setStatus(`Engine: aesthetic import failed (${err?.message || err})`, true);
    renderAestheticWizard();
  }
}

function toggleGoal(goal) {
  if (state.goalSelections.has(goal.id)) {
    state.goalSelections.delete(goal.id);
  } else {
    state.goalSelections.add(goal.id);
  }
  syncGoalChipState();
  scheduleGoalAnalyze();
}

function scheduleGoalAnalyze() {
  if (state.goalSendTimer) {
    clearTimeout(state.goalSendTimer);
  }
  if (state.goalSelections.size === 0) return;
  state.goalSendTimer = setTimeout(() => {
    state.goalSendTimer = null;
    triggerGoalAnalyze();
  }, 700);
}

function triggerGoalAnalyze() {
  const selectedTokens = GOAL_OPTIONS.filter((goal) => state.goalSelections.has(goal.id)).map(
    (goal) => goal.token
  );
  if (!selectedTokens.length) return;
  state.goalAnalyzeInFlight = true;
  state.goalChipsSuppressed = true;
  setStatus("Engine: optimizing…");
  hideGoalChips();
  const mode = state.optimizeMode || "auto";
  const command = `/optimize ${mode} ${selectedTokens.join(",")}`;
  sendPtyCommand(command);
}

function sendPtyCommand(command) {
  if (!command) return;
  if (!state.runDir) return;
  state.goalChipsAutoHold = true;
  updateGoalChipsSuppression(command);
  state.pendingEchoes.push(command);
  invoke("write_pty", { data: `${command}\n` }).catch((err) => {
    term.writeln(formatBroodLine(`\r\n[brood] send failed: ${err}`));
    setStatus(`Engine: send failed (${err})`, true);
  });
  setStatus("Engine: sent input");
  if (!state.ptyReady) {
    term.writeln(command);
  }
}

async function sendTerminalInput() {
  const value = terminalInput.value.trim();
  if (!value) return;
  if (!state.runDir) {
    await createRun();
    if (!state.runDir) {
      return;
    }
  }
  sendPtyCommand(value);
  terminalInput.value = "";
  terminalInput.focus();
}

terminalInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  sendTerminalInput().catch(() => {});
});

terminalInput.addEventListener("input", () => {
  if (state.goalChipsShown) {
    hideGoalChips();
  }
});

terminalSend.addEventListener("click", () => {
  sendTerminalInput().catch(() => {});
});

document.addEventListener("keydown", (event) => {
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (terminalInput && document.activeElement !== terminalInput) {
    terminalInput.focus();
  }
});

listen("pty-data", (event) => {
  state.ptyReady = true;
  setStatus("Engine: connected");
  const formatted = styleSystemLines(highlightEchoes(event.payload));
  term.write(normalizeNewlines(formatted));
  positionGoalChips();
  if (shouldAutoShowGoalChips()) {
    showGoalChips();
  }
});

async function handlePtyExit() {
  try {
    const status = await invoke("get_pty_status");
    if (status?.running) {
      if (state.pendingPtyExit) {
        state.pendingPtyExit = false;
      }
      return;
    }
  } catch (_) {
    // Best-effort stale-exit guard; continue with legacy handling on errors.
  }
  if (state.ptySpawning) {
    state.pendingPtyExit = true;
    return;
  }
  state.pendingPtyExit = false;
  setStatus("Engine: exited", true);
  state.ptyReady = false;
}

async function flushDeferredPtyExit() {
  if (!state.pendingPtyExit || state.ptySpawning) return;
  await handlePtyExit();
}

listen("pty-exit", () => {
  handlePtyExit().catch(() => {});
});

const INPUT_COLOR = "\x1b[38;2;139;213;255m";
const USER_BG = "\x1b[48;2;46;46;46m";
const USER_FG = "\x1b[38;2;230;237;243m";
const SYSTEM_COLOR = "\x1b[38;2;150;157;165m";
const BROOD_COLOR = "\x1b[38;2;255;107;107m";
const ITALIC = "\x1b[3m";
const RESET_COLOR = "\x1b[0m";
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function normalizeNewlines(payload) {
  if (!payload) return payload;
  let out = "";
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i];
    if (ch === "\n") {
      if (i === 0 || payload[i - 1] !== "\r") {
        out += "\r";
      }
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

function highlightEchoes(payload) {
  let combined = state.echoBuffer + state.controlBuffer + payload;
  state.echoBuffer = "";
  state.controlBuffer = "";
  const hasTrailingNewline = combined.endsWith("\n");
  const lines = combined.split("\n");
  let tail = null;
  if (!hasTrailingNewline) {
    tail = lines.pop() || "";
  } else {
    state.echoBuffer = "";
  }

  const outputLines = [];
  for (const line of lines) {
    if (
      state.pendingEchoes.length &&
      !line.includes("\x1b[") &&
      line.includes(state.pendingEchoes[0])
    ) {
      outputLines.push(formatUserBlock(line));
      state.pendingEchoes.shift();
    } else {
      outputLines.push(line);
    }
  }
  if (tail !== null) {
    const hasAnsi = tail.includes("\x1b[");
    const hasCarriage = tail.includes("\r");
    const hasClear = tail.includes("\x1b[K");
    if (hasAnsi || hasCarriage) {
      if (hasClear) {
        outputLines.push(tail);
      } else {
        state.controlBuffer = tail;
      }
    } else {
      state.echoBuffer = tail;
    }
  }
  const output = outputLines.join("\n");
  return hasTrailingNewline ? `${output}\n` : output;
}

function styleSystemLines(payload) {
  if (!payload) return payload;
  if (payload.includes("\r") && !payload.includes("\n")) {
    return normalizeCarriage(payload);
  }
  const styled = [];
  let lastWasBlank = false;
  let lastHidden = false;
  for (const line of payload.split("\n")) {
    const normalized = normalizeCarriage(line);
    if (shouldHideLine(normalized)) {
      lastHidden = true;
      continue;
    }
    const plain = normalized.replace(ANSI_PATTERN, "").replace(/^\r/, "");
    const isBlank = !plain.trim();
    if (isBlank) {
      if (lastWasBlank || lastHidden) {
        continue;
      }
      lastWasBlank = true;
      lastHidden = false;
      styled.push(styleTerminalLine(normalized));
      continue;
    }
    lastWasBlank = false;
    lastHidden = false;
    styled.push(styleTerminalLine(normalized));
  }
  return styled.join("\n");
}

function normalizeCarriage(line) {
  if (!line) return line;
  let normalized = line;
  if (normalized.endsWith("\r")) {
    normalized = normalized.slice(0, -1);
  }
  const idx = normalized.lastIndexOf("\r");
  const coalesced =
    idx === -1 ? coalesceProgressFragments(normalized) : coalesceProgressFragments(`\r${normalized.slice(idx + 1)}`);
  return simplifyReasoningLine(coalesced);
}

function coalesceProgressFragments(line) {
  if (!line) return line;
  const hasCarriage = line.startsWith("\r");
  const raw = hasCarriage ? line.slice(1) : line;
  if (!raw.includes("esc to")) return line;
  const matches = [...raw.matchAll(/• [^•]*\(/g)];
  if (matches.length === 0) return line;
  const last = matches[matches.length - 1];
  if (last.index == null) return line;
  if (last.index === 0) return line;
  const prefix = hasCarriage ? "\r" : "";
  const ansiPrefixMatch = raw.match(/^(?:\x1b\[[0-9;]*m)+/);
  const ansiPrefix = ansiPrefixMatch ? ansiPrefixMatch[0] : "";
  return `${prefix}${ansiPrefix}${raw.slice(last.index)}`;
}

function simplifyReasoningLine(line) {
  if (!line || !line.includes("Reasoning:")) return line;
  const raw = line.startsWith("\r") ? line.slice(1) : line;
  const ansiPrefixMatch = raw.match(/^(?:\x1b\[[0-9;]*m)+/);
  const ansiPrefix = ansiPrefixMatch ? ansiPrefixMatch[0] : "";
  const content = raw.slice(ansiPrefix.length);
  const lastIdx = content.lastIndexOf("• Reasoning:");
  if (lastIdx === -1) return line;
  const segment = content.slice(lastIdx);
  const match = segment.match(/\(([^)]*)\)/);
  let timePart = "";
  let suffixPart = "";
  if (match) {
    const inside = match[1];
    const parts = inside.split("•").map((part) => part.trim()).filter(Boolean);
    timePart = parts[0] || "";
    suffixPart = parts.slice(1).join(" • ");
  }
  let rebuilt = "• Generating image";
  if (timePart) {
    rebuilt += ` (${timePart}`;
    if (suffixPart) {
      rebuilt += ` • ${suffixPart}`;
    }
    rebuilt += ")";
  }
  return `\r${ansiPrefix}${rebuilt}\x1b[K`;
}

function shouldHideLine(line) {
  if (line.includes(USER_BG) || line.includes(USER_FG)) return false;
  const plain = line.replace(ANSI_PATTERN, "").replace(/^\r/, "");
  const trimmed = plain.trim();
  if (!trimmed) return false;
  if (trimmed === "[brood] engine exited") return true;
  if (trimmed === "Brood chat started. Type /help for commands.") return true;
  if (trimmed.startsWith("/text_model")) return true;
  if (trimmed.startsWith("/image_model")) return true;
  if (trimmed.startsWith("Text model set to")) return true;
  if (trimmed.startsWith("Image model set to")) return true;
  if (trimmed.startsWith("> Text model set to")) return true;
  if (trimmed.startsWith("> Image model set to")) return true;
  return false;
}

function styleTerminalLine(line) {
  if (!line) return line;
  const hasCarriage = line.startsWith("\r");
  const body = hasCarriage ? line.slice(1) : line;
  if (body.includes("\x1b[")) return line;
  const styled = styleSystemLine(body);
  return hasCarriage ? `\r${styled}` : styled;
}

function styleSystemLine(line) {
  if (!line) return line;
  if (line.includes("\x1b[")) return line;
  const trimmed = line.trimStart();
  const broodIndex = line.indexOf("[brood]");
  if (broodIndex !== -1) {
    return formatBroodLine(line, broodIndex);
  }
  if (
    trimmed.startsWith("[brood]") ||
    trimmed.startsWith("/text_model") ||
    trimmed.startsWith("/image_model") ||
    trimmed.startsWith("> Text model set to") ||
    trimmed.startsWith("> Image model set to") ||
    trimmed.startsWith("• Planning run") ||
    trimmed.startsWith("Optimizing for:") ||
    trimmed.startsWith("Context usage:") ||
    trimmed.startsWith("Plan:") ||
    trimmed.startsWith("Reasoning:") ||
    trimmed.startsWith("Analysis:")
  ) {
    return `${SYSTEM_COLOR}${ITALIC}${line}${RESET_COLOR}`;
  }
  return line;
}

function formatBroodLine(line, broodIndex = line.indexOf("[brood]")) {
  if (broodIndex === -1) return line;
  const before = line.slice(0, broodIndex);
  const after = line.slice(broodIndex + "[brood]".length);
  return `${before}${BROOD_COLOR}[brood]${RESET_COLOR}${after}`;
}

function formatUserBlock(line) {
  const cols = term?.cols || 80;
  const clean = line.replace(/\r/g, "");
  const pad = cols > clean.length ? " ".repeat(cols - clean.length) : "";
  const full = `${USER_BG}${USER_FG}${clean}${pad}${RESET_COLOR}\x1b[K`;
  return full;
}

const storedRustNative = localStorage.getItem("brood.rsNative");
const rustNativeDefaultMigrated = localStorage.getItem("brood.rsNative.default.v2") === "1";
if (!rustNativeDefaultMigrated) {
  if (storedRustNative == null) {
    localStorage.setItem("brood.rsNative", "1");
  }
  localStorage.setItem("brood.rsNative.default.v2", "1");
} else if (storedRustNative == null) {
  localStorage.setItem("brood.rsNative", "1");
}
const effectiveRustNative = localStorage.getItem("brood.rsNative");

const settings = {
  memory: localStorage.getItem("brood.memory") === "1",
  rustNative: effectiveRustNative == null ? true : effectiveRustNative === "1",
  textModel: localStorage.getItem("brood.textModel") || "gpt-5.2",
  imageModel: localStorage.getItem("brood.imageModel") || "dryrun-image-1",
  optimizeMode: localStorage.getItem("brood.optimizeMode") || "auto",
};
if (!["auto", "review"].includes(settings.optimizeMode)) {
  settings.optimizeMode = "auto";
}

function emergencyCompatFallbackEnabled() {
  return localStorage.getItem("brood.emergencyCompatFallback") === "1";
}

const memoryToggle = document.getElementById("memory-toggle");
const textModelSelect = document.getElementById("text-model");
const imageModelSelect = document.getElementById("image-model");

state.optimizeMode = settings.optimizeMode;
state.optimize.mode = settings.optimizeMode;

memoryToggle.checked = settings.memory;
textModelSelect.value = settings.textModel;
imageModelSelect.value = settings.imageModel;
if (optimizeModeSelect) {
  optimizeModeSelect.value = settings.optimizeMode;
}
if (textModelSelect.value !== settings.textModel) {
  settings.textModel = "gpt-5.2";
  textModelSelect.value = settings.textModel;
  localStorage.setItem("brood.textModel", settings.textModel);
}

memoryToggle.addEventListener("change", () => {
  settings.memory = memoryToggle.checked;
  localStorage.setItem("brood.memory", settings.memory ? "1" : "0");
  term.writeln(formatBroodLine("\r\n[brood] memory setting will apply to next run"));
});

textModelSelect.addEventListener("change", () => {
  settings.textModel = textModelSelect.value;
  localStorage.setItem("brood.textModel", settings.textModel);
  invoke("write_pty", { data: `/text_model ${settings.textModel}\n` }).catch(() => {});
});

imageModelSelect.addEventListener("change", () => {
  settings.imageModel = imageModelSelect.value;
  localStorage.setItem("brood.imageModel", settings.imageModel);
  invoke("write_pty", { data: `/image_model ${settings.imageModel}\n` }).catch(() => {});
});

if (optimizeModeSelect) {
  optimizeModeSelect.addEventListener("change", () => {
    settings.optimizeMode = optimizeModeSelect.value;
    localStorage.setItem("brood.optimizeMode", settings.optimizeMode);
    state.optimizeMode = settings.optimizeMode;
    state.optimize.mode = settings.optimizeMode;
    renderOptimizePanel();
    updateOptimizeTiming();
  });
}

async function createRun() {
  try {
    setStatus("Engine: creating run…");
    const payload = await invoke("create_run_dir");
    state.runDir = payload.run_dir;
    state.eventsPath = payload.events_path;
    state.eventsOffset = 0;
    state.eventsByteOffset = 0;
    state.eventsTail = "";
    state.fallbackToFullRead = false;
    state.pollInFlight = false;
    state.artifacts.clear();
    state.placeholders = [];
    state.galleryCardById.clear();
    state.receiptCache.clear();
    state.selected.clear();
    state.lastError = null;
    state.goalChipsShown = false;
    state.goalChipsSuppressed = false;
    state.goalChipsAutoHold = false;
    state.goalSelections.clear();
    state.goalAnalyzeInFlight = false;
    resetOptimizeState();
    renderGallery();
    hideGoalChips();
    if (detailEl) {
      detailEl.textContent = "";
      detailEl.classList.add("hidden");
    }
    runInfoEl.textContent = `Run: ${state.runDir}`;
    await loadAestheticMetadata();
    await spawnEngine();
    await startWatching();
  } catch (err) {
    setStatus(`Engine: failed to create run (${err})`, true);
    reportError(err);
  }
}

async function spawnEngine({ forceCompat = false } = {}) {
  if (!state.runDir) return;
  if (state.ptySpawning) return;
  state.ptySpawning = true;
  if (!forceCompat) {
    state.engineCompatRetried = false;
  }
  setStatus("Engine: starting…");
  term.writeln(formatBroodLine("[brood] starting engine..."));
  try {
    const preferredMode = forceCompat ? "compat" : settings.rustNative ? "native" : "compat";
    const baseEnv = { BROOD_MEMORY: settings.memory ? "1" : "0" };
    const broodArgs = ["chat", "--out", state.runDir, "--events", state.eventsPath];
    let spawned = false;
    let lastErr = null;
    let launchMeta = null;
    let repoRoot = null;

    const envForMode = (mode) => ({
      ...baseEnv,
      BROOD_RS_MODE: mode,
    });

    const spawnAttempt = async ({ command, args, cwd, mode, label }) => {
      if (spawned) return;
      try {
        await invoke("spawn_pty", {
          command,
          args,
          cwd,
          env: envForMode(mode),
        });
        spawned = true;
        launchMeta = { mode, label };
      } catch (err) {
        lastErr = err;
      }
    };

    try {
      repoRoot = await invoke("get_repo_root");
    } catch (_) {
      repoRoot = null;
    }

    const tryModeChain = async (mode) => {
      if (repoRoot) {
        await spawnAttempt({
          command: "cargo",
          args: ["run", "-q", "-p", "brood-cli", "--", ...broodArgs],
          cwd: `${repoRoot}/rust_engine`,
          mode,
          label: "cargo run -p brood-cli",
        });
      }

      await spawnAttempt({
        command: "brood-rs",
        args: broodArgs,
        cwd: state.runDir,
        mode,
        label: "brood-rs",
      });

      if (mode !== "native" && !spawned) {
        await spawnAttempt({
          command: "brood",
          args: broodArgs,
          cwd: state.runDir,
          mode,
          label: "brood",
        });
      }
    };

    if (preferredMode === "native") {
      await tryModeChain("native");
      if (!spawned && emergencyCompatFallbackEnabled()) {
        term.writeln(
          formatBroodLine(
            "\r\n[brood] native launch failed; retrying compat mode for startup (emergency fallback enabled)..."
          )
        );
        await tryModeChain("compat");
      }
      if (!spawned) {
        const detail = lastErr?.message || String(lastErr || "native engine launch failed");
        throw new Error(
          `${detail}. Native launch failed and emergency compat fallback is disabled (set localStorage.brood.emergencyCompatFallback=\"1\" to allow compat retry).`
        );
      }
    } else {
      await tryModeChain("compat");
    }

    if (!spawned) {
      throw lastErr;
    }

    state.engineLaunchMode = launchMeta?.mode || "compat";
    state.engineLaunchPath = launchMeta?.label || "unknown";
    term.writeln(
      formatBroodLine(
        `\r\n[brood] engine path=${state.engineLaunchPath} mode=${state.engineLaunchMode} preferred=${preferredMode}`
      )
    );
    resizePty();
    setStatus(`Engine: started (${state.engineLaunchMode})`);
    invoke("write_pty", { data: `/text_model ${settings.textModel}\n` }).catch(() => {});
    invoke("write_pty", { data: `/image_model ${settings.imageModel}\n` }).catch(() => {});
  } catch (err) {
    term.writeln(formatBroodLine(`\r\n[brood] failed to spawn engine: ${err}`));
    setStatus(`Engine: failed (${err})`, true);
  } finally {
    state.ptySpawning = false;
    await flushDeferredPtyExit();
  }
}

async function openRun() {
  const selected = await open({ directory: true, multiple: false });
  if (!selected) return;
  state.runDir = selected;
  state.eventsPath = `${selected}/events.jsonl`;
  state.eventsOffset = 0;
  state.eventsByteOffset = 0;
  state.eventsTail = "";
  state.fallbackToFullRead = false;
  state.pollInFlight = false;
  state.artifacts.clear();
  state.placeholders = [];
  state.galleryCardById.clear();
  state.receiptCache.clear();
  state.selected.clear();
  state.lastError = null;
  state.goalChipsShown = false;
  state.goalChipsSuppressed = false;
  state.goalChipsAutoHold = false;
  state.goalSelections.clear();
  state.goalAnalyzeInFlight = false;
  resetOptimizeState();
  renderGallery();
  hideGoalChips();
  if (detailEl) {
    detailEl.textContent = "";
    detailEl.classList.add("hidden");
  }
  runInfoEl.textContent = `Run: ${state.runDir}`;
  await loadAestheticMetadata();
  await startWatching();
}

async function startWatching() {
  if (!state.runDir) return;
  const eventsExists = await exists(state.eventsPath);
  if (eventsExists) {
    await readEvents();
    await pollEvents();
    return;
  }
  await loadReceiptsFallback();
  await pollEvents();
}

async function pollEvents() {
  if (state.poller) return;
  state.poller = setInterval(() => {
    pollEventsOnce().catch(() => {});
  }, 750);
}

async function pollEventsOnce() {
  if (!state.eventsPath) return;
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const existsNow = await exists(state.eventsPath);
    if (!existsNow) return;
    await readEvents();
  } finally {
    state.pollInFlight = false;
  }
}

async function readEvents() {
  if (!state.eventsPath) return;
  if (state.fallbackToFullRead) {
    await readEventsFallback();
    return;
  }
  try {
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
    let chunkText = "";
    if (typeof chunk === "string") {
      chunkText = chunk;
    } else if (chunk instanceof Uint8Array) {
      chunkText = state.eventsDecoder.decode(chunk, { stream: true });
    } else if (Array.isArray(chunk)) {
      chunkText = state.eventsDecoder.decode(Uint8Array.from(chunk), { stream: true });
    }
    if (Number.isFinite(newOffset)) {
      state.eventsByteOffset = newOffset;
    }
    if (!chunkText) return;
    state.eventsTail += chunkText;
    const lines = state.eventsTail.split("\n");
    state.eventsTail = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleEvent(JSON.parse(trimmed));
      } catch {
        // ignore malformed lines
      }
    }
  } catch (err) {
    console.warn("Incremental event reader failed, falling back:", err);
    state.eventsTail = "";
    state.eventsDecoder = new TextDecoder("utf-8");
    state.fallbackToFullRead = true;
    await readEventsFallback();
  }
}

async function readEventsFallback() {
  const data = await readBinaryFile(state.eventsPath);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const decoder = new TextDecoder("utf-8");
  let start = Math.max(0, Number(state.eventsByteOffset) || 0);
  if (start > bytes.length) {
    start = bytes.length;
    state.eventsTail = "";
  }
  let chunk = bytes.slice(start);
  if (start > 0 && bytes[start - 1] !== 0x0a && !state.eventsTail) {
    const newlineIdx = chunk.indexOf(0x0a);
    if (newlineIdx === -1) {
      state.eventsByteOffset = bytes.length;
      return;
    }
    chunk = chunk.slice(newlineIdx + 1);
  }
  if (chunk.length === 0) {
    state.eventsByteOffset = bytes.length;
    return;
  }
  state.eventsTail += decoder.decode(chunk);
  const lines = state.eventsTail.split("\n");
  state.eventsTail = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      handleEvent(event);
    } catch {
      // ignore malformed lines
    }
  }
  state.eventsByteOffset = bytes.length;
}

function handleEvent(event) {
  if (event.type === "plan_preview") {
    state.lastError = null;
    const count = event.plan?.images || 0;
    const [width, height] = resolveSize(event.plan?.size);
    state.placeholders = Array.from({ length: count }).map((_, idx) => ({
      artifact_id: `placeholder-${Date.now()}-${idx}`,
      placeholder: true,
      width,
      height,
    }));
    renderGallery();
  }
  if (event.type === "artifact_created") {
    state.lastError = null;
    const artifact = {
      artifact_id: event.artifact_id,
      image_path: event.image_path,
      receipt_path: event.receipt_path,
      version_id: event.version_id,
    };
    state.artifacts.set(event.artifact_id, artifact);
    if (state.placeholders.length > 0) {
      state.placeholders.shift();
      removeOnePlaceholderCard();
    }
    if (artifact.receipt_path) {
      state.receiptCache.delete(artifact.receipt_path);
    }
    state.goalChipsAutoHold = false;
    upsertArtifactCard(artifact);
    updateGallerySelectionClasses();
    renderDetail();
    if (shouldAutoShowGoalChips()) {
      showGoalChips();
    }
  }
  if (event.type === "context_window_update") {
    const pct = Math.round((event.pct || 0) * 100);
    contextEl.textContent = `Context: ${pct}%`;
  }
  if (event.type === "analysis_ready") {
    if (state.goalAnalyzeInFlight) {
      state.goalAnalyzeInFlight = false;
      setStatus("Engine: analysis ready");
    }
    state.optimize.analysisExcerpt = event.analysis_excerpt || "";
    state.optimize.recommendations = Array.isArray(event.recommendations) ? event.recommendations : [];
    state.optimize.analysisElapsedS =
      typeof event.analysis_elapsed_s === "number" ? event.analysis_elapsed_s : null;
    state.optimize.goals = Array.isArray(event.goals) ? event.goals : [];
    state.optimize.round = typeof event.round === "number" ? event.round : null;
    state.optimize.roundTotal = typeof event.round_total === "number" ? event.round_total : null;
    state.optimize.mode = event.mode || state.optimize.mode || state.optimizeMode;
    state.optimize.generationElapsedS = null;
    state.optimize.error = null;
    renderOptimizePanel();
  }
  if (event.type === "optimize_generation_done") {
    state.optimize.generationElapsedS =
      typeof event.elapsed_s === "number" ? event.elapsed_s : null;
    state.optimize.round = typeof event.round === "number" ? event.round : state.optimize.round;
    state.optimize.roundTotal =
      typeof event.round_total === "number" ? event.round_total : state.optimize.roundTotal;
    state.optimize.goals = Array.isArray(event.goals) ? event.goals : state.optimize.goals;
    state.optimize.error = event.success === false ? event.error || "Generation failed." : null;
    renderOptimizePanel();
  }
  if (event.type === "generation_failed") {
    const msg = event.error ? `Generation failed: ${event.error}` : "Generation failed.";
    state.lastError = msg;
    setStatus(`Engine: ${msg}`, true);
    if (state.selected.size === 0) {
      detailEl.textContent = msg;
      detailEl.classList.remove("hidden");
    }
  }
}

async function loadReceiptsFallback() {
  const entries = await readDir(state.runDir);
  for (const entry of entries) {
    if (entry.name && entry.name.startsWith("receipt-") && entry.name.endsWith(".json")) {
      const receipt = await readTextFile(entry.path);
      try {
        const payload = JSON.parse(receipt);
        const artifacts = payload.artifacts || {};
        const artifactId = entry.name.replace("receipt-", "").replace(".json", "");
        state.receiptCache.delete(entry.path);
        state.artifacts.set(artifactId, {
          artifact_id: artifactId,
          image_path: artifacts.image_path,
          receipt_path: entry.path,
          version_id: "v?",
        });
      } catch {
        // ignore
      }
    }
  }
  renderGallery();
}

function createPlaceholderCard(placeholder) {
  const card = document.createElement("div");
  card.className = "card placeholder";
  const frame = document.createElement("div");
  frame.className = "placeholder-frame";
  if (placeholder.width && placeholder.height) {
    frame.style.aspectRatio = `${placeholder.width} / ${placeholder.height}`;
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent =
    placeholder.width && placeholder.height
      ? `generating • ${placeholder.width}x${placeholder.height}`
      : "generating";
  card.appendChild(frame);
  card.appendChild(meta);
  return card;
}

function createArtifactCard(artifact) {
  const card = document.createElement("div");
  card.className = "card" + (state.selected.has(artifact.artifact_id) ? " selected" : "");
  card.dataset.artifactId = artifact.artifact_id;
  const img = document.createElement("img");
  img.src = convertFileSrc(artifact.image_path);
  img.onerror = () => {
    loadImageBinary(artifact.image_path, img).catch(() => {});
  };
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${artifact.version_id} • ${artifact.artifact_id}`;
  card.appendChild(img);
  card.appendChild(meta);
  card.addEventListener("click", () => toggleSelect(artifact.artifact_id));
  return card;
}

function removeOnePlaceholderCard() {
  const card = galleryEl.querySelector(".card.placeholder");
  if (card) card.remove();
}

function upsertArtifactCard(artifact) {
  if (!artifact?.artifact_id) return;
  const existing = state.galleryCardById.get(artifact.artifact_id);
  const card = createArtifactCard(artifact);
  if (existing) {
    existing.replaceWith(card);
  } else {
    galleryEl.appendChild(card);
  }
  state.galleryCardById.set(artifact.artifact_id, card);
}

function updateGallerySelectionClasses() {
  for (const [artifactId, card] of state.galleryCardById.entries()) {
    card.classList.toggle("selected", state.selected.has(artifactId));
  }
}

function renderGallery() {
  galleryEl.innerHTML = "";
  state.galleryCardById.clear();
  for (const placeholder of state.placeholders) {
    galleryEl.appendChild(createPlaceholderCard(placeholder));
  }
  for (const artifact of state.artifacts.values()) {
    const card = createArtifactCard(artifact);
    state.galleryCardById.set(artifact.artifact_id, card);
    galleryEl.appendChild(card);
  }
  renderDetail();
}

function resolveSize(size) {
  if (!size) return [1024, 1024];
  const normalized = String(size).trim().toLowerCase();
  if (["portrait", "tall"].includes(normalized)) return [1024, 1536];
  if (["landscape", "wide"].includes(normalized)) return [1536, 1024];
  if (["square", "1:1"].includes(normalized)) return [1024, 1024];
  if (normalized.includes("x")) {
    const parts = normalized.split("x");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return [w, h];
    }
  }
  return [1024, 1024];
}

async function loadImageBinary(path, imgEl) {
  if (!path) return;
  if (state.blobUrls.has(path)) {
    imgEl.src = state.blobUrls.get(path);
    return;
  }
  try {
    const data = await readBinaryFile(path);
    const mime = path.endsWith(".jpg") || path.endsWith(".jpeg")
      ? "image/jpeg"
      : path.endsWith(".webp")
        ? "image/webp"
        : "image/png";
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    state.blobUrls.set(path, url);
    imgEl.src = url;
  } catch (err) {
    term.writeln(formatBroodLine(`\r\n[brood] failed to load image: ${err}`));
  }
}

async function loadReceiptDetail(artifact) {
  const empty = { detail: "", promptText: "" };
  const receiptPath = artifact?.receipt_path;
  if (!receiptPath) return empty;
  const cached = state.receiptCache.get(receiptPath);
  if (cached) return cached;

  const receipt = await readTextFile(receiptPath).catch(() => null);
  if (!receipt) return empty;
  try {
    const payload = JSON.parse(receipt);
    const requestPayload =
      payload.provider_request?.payload ??
      payload.provider_request?.payloads ??
      payload.provider_request ??
      payload.request ??
      {};
    const parsed = {
      detail: JSON.stringify(requestPayload, null, 2),
      promptText: payload.request?.prompt || "",
    };
    state.receiptCache.set(receiptPath, parsed);
    return parsed;
  } catch {
    return empty;
  }
}

async function renderDetail() {
  detailEl.innerHTML = "";
  const selectedIds = Array.from(state.selected);
  if (selectedIds.length === 0) {
    detailEl.textContent = "";
    if (state.lastError) {
      detailEl.textContent = state.lastError;
      detailEl.classList.remove("hidden");
    } else {
      detailEl.classList.add("hidden");
    }
    return;
  }
  detailEl.classList.remove("hidden");
  if (selectedIds.length === 1) {
    const artifact = state.artifacts.get(selectedIds[0]);
    if (!artifact) return;
    const receiptDetail = await loadReceiptDetail(artifact);
    const detail = receiptDetail.detail || "";
    const promptText = receiptDetail.promptText || "";
    detailEl.innerHTML = `
      <div><strong>${artifact.artifact_id}</strong></div>
      <div class="meta">${artifact.image_path}</div>
      <button id="copy-prompt">Copy prompt</button>
      <pre>${detail}</pre>
    `;
    const copyBtn = document.getElementById("copy-prompt");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => writeText(promptText || ""));
    }
    return;
  }
  const compare = document.createElement("div");
  compare.style.display = "grid";
  compare.style.gridTemplateColumns = `repeat(${selectedIds.length}, 1fr)`;
  compare.style.gap = "8px";
  for (const id of selectedIds) {
    const artifact = state.artifacts.get(id);
    if (!artifact) continue;
    const img = document.createElement("img");
    img.src = convertFileSrc(artifact.image_path);
    img.style.width = "100%";
    compare.appendChild(img);
  }
  detailEl.appendChild(compare);
}

function toggleSelect(artifactId) {
  if (state.selected.has(artifactId)) {
    state.selected.delete(artifactId);
  } else {
    if (state.selected.size >= 4) return;
    state.selected.add(artifactId);
  }
  updateGallerySelectionClasses();
  renderDetail();
}

function flicker() {
  const selectedIds = Array.from(state.selected);
  if (selectedIds.length !== 2) return;
  const images = detailEl.querySelectorAll("img");
  if (images.length !== 2) return;
  let showFirst = true;
  clearInterval(state.flickerTimer);
  state.flickerTimer = setInterval(() => {
    images[0].style.opacity = showFirst ? "1" : "0";
    images[1].style.opacity = showFirst ? "0" : "1";
    showFirst = !showFirst;
  }, 400);
}

async function uploadReference() {
  const selected = await open({ multiple: false });
  if (!selected) return;
  term.write(`\r\n/recreate ${selected}\r\n`);
  invoke("write_pty", { data: `/recreate ${selected}\n` });
}

async function exportReport() {
  if (!state.runDir) return;
  const outPath = `${state.runDir}/export.html`;
  await invoke("export_run", { runDir: state.runDir, outPath });
}

// Buttons

const newRunBtn = document.getElementById("new-run");
const openRunBtn = document.getElementById("open-run");
const uploadBtn = document.getElementById("upload");
const exportBtn = document.getElementById("export");
const buildAestheticBtn = document.getElementById("build-aesthetic");
const clearAestheticBtn = document.getElementById("clear-aesthetic");
const compareBtn = document.getElementById("compare");
const flickerBtn = document.getElementById("flicker");

if (!newRunBtn) {
  setStatus("Engine: UI error (missing #new-run)", true);
} else {
  newRunBtn.addEventListener("click", () => {
    setStatus("Engine: New Run clicked");
    term.writeln(formatBroodLine("[brood] New Run clicked"));
    createRun().catch((err) => reportError(err));
  });
}
if (openRunBtn) {
  openRunBtn.addEventListener("click", () => openRun().catch((err) => reportError(err)));
}
if (goalsToggle) {
  goalsToggle.addEventListener("click", () => {
    if (state.goalChipsShown) {
      hideGoalChips();
    } else {
      showGoalChips();
    }
  });
}
if (uploadBtn) {
  uploadBtn.addEventListener("click", () => uploadReference().catch((err) => reportError(err)));
}
if (exportBtn) {
  exportBtn.addEventListener("click", () => exportReport().catch((err) => reportError(err)));
}
if (buildAestheticBtn) {
  buildAestheticBtn.addEventListener("click", () => openAestheticWizard());
}
if (clearAestheticBtn) {
  clearAestheticBtn.addEventListener("click", () =>
    clearAestheticData().catch((err) => reportError(err))
  );
}
if (aestheticPickFolderBtn) {
  aestheticPickFolderBtn.addEventListener("click", () =>
    selectAestheticFolder().catch((err) => reportError(err))
  );
}
if (aestheticPickFilesBtn) {
  aestheticPickFilesBtn.addEventListener("click", () =>
    selectAestheticFiles().catch((err) => reportError(err))
  );
}
if (aestheticImportBtn) {
  aestheticImportBtn.addEventListener("click", () =>
    importAestheticSelection().catch((err) => reportError(err))
  );
}
if (aestheticCancelBtn) {
  aestheticCancelBtn.addEventListener("click", () => closeAestheticWizard());
}
if (aestheticBackBtn) {
  aestheticBackBtn.addEventListener("click", () => {
    aestheticWizardStep = 1;
    renderAestheticWizard();
  });
}
if (aestheticDoneBtn) {
  aestheticDoneBtn.addEventListener("click", () => closeAestheticWizard());
}
if (aestheticCloseBtn) {
  aestheticCloseBtn.addEventListener("click", () => closeAestheticWizard());
}
if (aestheticModalEl) {
  aestheticModalEl.addEventListener("click", (event) => {
    if (event.target?.dataset?.close === "true") {
      closeAestheticWizard();
    }
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && aestheticModalEl && !aestheticModalEl.classList.contains("hidden")) {
    closeAestheticWizard();
  }
});
if (compareBtn) {
  compareBtn.addEventListener("click", () => renderDetail());
}
if (flickerBtn) {
  flickerBtn.addEventListener("click", () => flicker());
}

createRun().catch((err) => reportError(err));
