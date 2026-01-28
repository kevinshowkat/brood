import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { FitAddon } from "xterm-addon-fit";
import { invoke, convertFileSrc } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { readTextFile, readDir, exists, readBinaryFile } from "@tauri-apps/api/fs";
import { open } from "@tauri-apps/api/dialog";
import { writeText } from "@tauri-apps/api/clipboard";

const terminalEl = document.getElementById("terminal");
const terminalInput = document.getElementById("terminal-input");
const terminalSend = document.getElementById("terminal-send");
const engineStatus = document.getElementById("engine-status");
const galleryEl = document.getElementById("gallery");
const detailEl = document.getElementById("detail");
const runInfoEl = document.getElementById("run-info");
const contextEl = document.getElementById("context-usage");

const state = {
  runDir: null,
  eventsPath: null,
  eventsOffset: 0,
  artifacts: new Map(),
  selected: new Set(),
  placeholders: [],
  flickerTimer: null,
  ptyReady: false,
  poller: null,
  blobUrls: new Map(),
  pendingEchoes: [],
  echoBuffer: "",
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
function resizePty() {
  const cols = term?.cols || 0;
  const rows = term?.rows || 0;
  if (!cols || !rows) return;
  invoke("resize_pty", { cols, rows }).catch(() => {});
}
requestAnimationFrame(() => {
  fitAddon.fit();
  resizePty();
  term.writeln(formatBroodLine("[brood] terminal ready."));
  term.write("\u001b[?25h");
  if (terminalInput) {
    terminalInput.focus();
  }
});
window.addEventListener("resize", () => {
  fitAddon.fit();
  resizePty();
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

async function sendTerminalInput() {
  const value = terminalInput.value.trim();
  if (!value) return;
  if (!state.runDir) {
    await createRun();
    if (!state.runDir) {
      return;
    }
  }
  state.pendingEchoes.push(value);
  invoke("write_pty", { data: `${value}\n` }).catch((err) => {
    term.writeln(formatBroodLine(`\r\n[brood] send failed: ${err}`));
    setStatus(`Engine: send failed (${err})`, true);
  });
  setStatus("Engine: sent input");
  if (!state.ptyReady) {
    term.writeln(value);
  }
  terminalInput.value = "";
  terminalInput.focus();
}

terminalInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  sendTerminalInput().catch(() => {});
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
  term.write(styleSystemLines(highlightEchoes(event.payload)));
});

listen("pty-exit", () => {
  setStatus("Engine: exited", true);
});

const INPUT_COLOR = "\x1b[38;2;139;213;255m";
const USER_BG = "\x1b[48;2;46;46;46m";
const USER_FG = "\x1b[38;2;230;237;243m";
const SYSTEM_COLOR = "\x1b[38;2;150;157;165m";
const BROOD_COLOR = "\x1b[38;2;255;107;107m";
const ITALIC = "\x1b[3m";
const RESET_COLOR = "\x1b[0m";
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function highlightEchoes(payload) {
  let combined = state.echoBuffer + payload;
  const hasTrailingNewline = combined.endsWith("\n");
  const lines = combined.split("\n");
  let tail = null;
  if (!hasTrailingNewline) {
    tail = lines.pop() || "";
    state.echoBuffer = "";
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
    if (tail.includes("\x1b[") || tail.includes("\r")) {
      outputLines.push(tail);
    } else {
      state.echoBuffer = tail;
    }
  }
  const output = outputLines.join("\n");
  return hasTrailingNewline ? `${output}\n` : output;
}

function styleSystemLines(payload) {
  if (!payload) return payload;
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
  const idx = line.lastIndexOf("\r");
  if (idx === -1) return line;
  return `\r${line.slice(idx + 1)}`;
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
    trimmed.startsWith("Context usage:") ||
    trimmed.startsWith("Plan:")
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
  const full = `${USER_BG}${USER_FG}${clean}${pad}${RESET_COLOR}`;
  return full;
}

const settings = {
  memory: localStorage.getItem("brood.memory") === "1",
  textModel: localStorage.getItem("brood.textModel") || "gpt-5.1-codex-max",
  imageModel: localStorage.getItem("brood.imageModel") || "dryrun-image-1",
};

const memoryToggle = document.getElementById("memory-toggle");
const textModelSelect = document.getElementById("text-model");
const imageModelSelect = document.getElementById("image-model");

memoryToggle.checked = settings.memory;
textModelSelect.value = settings.textModel;
imageModelSelect.value = settings.imageModel;
if (textModelSelect.value !== settings.textModel) {
  settings.textModel = "gpt-5.1-codex-max";
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

async function createRun() {
  try {
    setStatus("Engine: creating run…");
    const payload = await invoke("create_run_dir");
    state.runDir = payload.run_dir;
    state.eventsPath = payload.events_path;
    state.eventsOffset = 0;
    state.artifacts.clear();
    state.selected.clear();
    runInfoEl.textContent = `Run: ${state.runDir}`;
    await spawnEngine();
    await startWatching();
  } catch (err) {
    setStatus(`Engine: failed to create run (${err})`, true);
    reportError(err);
  }
}

async function spawnEngine() {
  if (!state.runDir) return;
  setStatus("Engine: starting…");
  term.writeln(formatBroodLine("[brood] starting engine..."));
  try {
    await invoke("spawn_pty", {
      command: "brood",
      args: ["chat", "--out", state.runDir, "--events", state.eventsPath],
      cwd: state.runDir,
      env: { BROOD_MEMORY: settings.memory ? "1" : "0" },
    });
    resizePty();
    setStatus("Engine: started");
    invoke("write_pty", { data: `/text_model ${settings.textModel}\n` }).catch(() => {});
    invoke("write_pty", { data: `/image_model ${settings.imageModel}\n` }).catch(() => {});
  } catch (err) {
    term.writeln(formatBroodLine(`\r\n[brood] failed to spawn engine: ${err}`));
    setStatus(`Engine: failed (${err})`, true);
  }
}

async function openRun() {
  const selected = await open({ directory: true, multiple: false });
  if (!selected) return;
  state.runDir = selected;
  state.eventsPath = `${selected}/events.jsonl`;
  state.eventsOffset = 0;
  state.artifacts.clear();
  state.selected.clear();
  runInfoEl.textContent = `Run: ${state.runDir}`;
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
  state.poller = setInterval(async () => {
    const existsNow = await exists(state.eventsPath);
    if (!existsNow) return;
    await readEvents().catch(() => {});
  }, 750);
}

async function readEvents() {
  const content = await readTextFile(state.eventsPath);
  const lines = content.trim().split("\n").filter(Boolean);
  for (let i = state.eventsOffset; i < lines.length; i += 1) {
    try {
      const event = JSON.parse(lines[i]);
      handleEvent(event);
    } catch {
      // ignore malformed lines
    }
  }
  state.eventsOffset = lines.length;
}

function handleEvent(event) {
  if (event.type === "plan_preview") {
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
    const artifact = {
      artifact_id: event.artifact_id,
      image_path: event.image_path,
      receipt_path: event.receipt_path,
      version_id: event.version_id,
    };
    state.artifacts.set(event.artifact_id, artifact);
    if (state.placeholders.length > 0) {
      state.placeholders.pop();
    }
    renderGallery();
  }
  if (event.type === "context_window_update") {
    const pct = Math.round((event.pct || 0) * 100);
    contextEl.textContent = `Context: ${pct}%`;
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

function renderGallery() {
  galleryEl.innerHTML = "";
  for (const placeholder of state.placeholders) {
    const card = document.createElement("div");
    card.className = "card placeholder";
    const frame = document.createElement("div");
    frame.className = "placeholder-frame";
    if (placeholder.width && placeholder.height) {
      frame.style.aspectRatio = `${placeholder.width} / ${placeholder.height}`;
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = placeholder.width && placeholder.height ? `generating • ${placeholder.width}x${placeholder.height}` : "generating";
    card.appendChild(frame);
    card.appendChild(meta);
    galleryEl.appendChild(card);
  }
  for (const artifact of state.artifacts.values()) {
    const card = document.createElement("div");
    card.className = "card" + (state.selected.has(artifact.artifact_id) ? " selected" : "");
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

async function renderDetail() {
  detailEl.innerHTML = "";
  const selectedIds = Array.from(state.selected);
  if (selectedIds.length === 0) {
    detailEl.textContent = "Select an image to view details.";
    return;
  }
  if (selectedIds.length === 1) {
    const artifact = state.artifacts.get(selectedIds[0]);
    if (!artifact) return;
    const receipt = await readTextFile(artifact.receipt_path).catch(() => null);
    let detail = "";
    let promptText = "";
    if (receipt) {
      try {
        const payload = JSON.parse(receipt);
        const detailPayload = {
          warnings: payload.warnings || [],
          metrics: payload.result_metadata || {},
        };
        detail = JSON.stringify(detailPayload, null, 2);
        promptText = payload.request?.prompt || "";
      } catch {
        detail = "";
      }
    }
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
  renderGallery();
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
if (uploadBtn) {
  uploadBtn.addEventListener("click", () => uploadReference().catch((err) => reportError(err)));
}
if (exportBtn) {
  exportBtn.addEventListener("click", () => exportReport().catch((err) => reportError(err)));
}
if (compareBtn) {
  compareBtn.addEventListener("click", () => renderDetail());
}
if (flickerBtn) {
  flickerBtn.addEventListener("click", () => flicker());
}

createRun().catch((err) => reportError(err));
