import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { FitAddon } from "xterm-addon-fit";
import { invoke, listen, convertFileSrc } from "@tauri-apps/api/tauri";
import { readTextFile, readDir, exists, watch } from "@tauri-apps/api/fs";
import { open } from "@tauri-apps/api/dialog";
import { writeText } from "@tauri-apps/api/clipboard";

const terminalEl = document.getElementById("terminal");
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
};

const term = new Terminal({
  fontFamily: "IBM Plex Mono",
  fontSize: 13,
  cursorBlink: true,
  cursorStyle: "bar",
  theme: {
    background: "#0d1117",
    foreground: "#e6edf3",
  },
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(terminalEl);
fitAddon.fit();
terminalEl.setAttribute("tabindex", "0");
term.focus();
term.writeln("[brood] terminal ready");
term.write("\u001b[?25h");
window.addEventListener("resize", () => fitAddon.fit());

terminalEl.addEventListener("click", () => {
  term.focus();
});

document.addEventListener("keydown", (event) => {
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (event.key.length === 1) {
    term.focus();
  }
});

term.onData((data) => {
  invoke("write_pty", { data }).catch(() => {});
});

listen("pty-data", (event) => {
  term.write(event.payload);
});

listen("pty-exit", () => {
  term.writeln("\r\n[brood] engine exited");
});

const settings = {
  memory: localStorage.getItem("brood.memory") === "1",
  textModel: localStorage.getItem("brood.textModel") || "dryrun-text-1",
  imageModel: localStorage.getItem("brood.imageModel") || "dryrun-image-1",
};

const memoryToggle = document.getElementById("memory-toggle");
const textModelSelect = document.getElementById("text-model");
const imageModelSelect = document.getElementById("image-model");

memoryToggle.checked = settings.memory;
textModelSelect.value = settings.textModel;
imageModelSelect.value = settings.imageModel;

memoryToggle.addEventListener("change", () => {
  settings.memory = memoryToggle.checked;
  localStorage.setItem("brood.memory", settings.memory ? "1" : "0");
  term.writeln("\r\n[brood] memory setting will apply to next run");
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
  const payload = await invoke("create_run_dir");
  state.runDir = payload.run_dir;
  state.eventsPath = payload.events_path;
  state.eventsOffset = 0;
  state.artifacts.clear();
  state.selected.clear();
  runInfoEl.textContent = `Run: ${state.runDir}`;
  await spawnEngine();
  await startWatching();
}

async function spawnEngine() {
  if (!state.runDir) return;
  term.writeln("[brood] starting engine...");
  try {
    await invoke("spawn_pty", {
      command: "brood",
      args: ["chat", "--out", state.runDir, "--events", state.eventsPath],
      cwd: state.runDir,
      env: { BROOD_MEMORY: settings.memory ? "1" : "0" },
    });
    invoke("write_pty", { data: `/text_model ${settings.textModel}\n` }).catch(() => {});
    invoke("write_pty", { data: `/image_model ${settings.imageModel}\n` }).catch(() => {});
  } catch (err) {
    term.writeln(`\r\n[brood] failed to spawn engine: ${err}`);
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
    await watch(state.eventsPath, () => {
      readEvents().catch(() => {});
    });
    return;
  }
  await loadReceiptsFallback();
  await watch(state.runDir, async () => {
    const hasEvents = await exists(state.eventsPath);
    if (!hasEvents) return;
    await readEvents().catch(() => {});
    await watch(state.eventsPath, () => {
      readEvents().catch(() => {});
    });
  });
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
    state.placeholders = Array.from({ length: count }).map((_, idx) => ({
      artifact_id: `placeholder-${Date.now()}-${idx}`,
      placeholder: true,
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
    card.className = "card";
    card.innerHTML = `<div class=\"meta\">placeholder</div>`;
    galleryEl.appendChild(card);
  }
  for (const artifact of state.artifacts.values()) {
    const card = document.createElement("div");
    card.className = "card" + (state.selected.has(artifact.artifact_id) ? " selected" : "");
    const img = document.createElement("img");
    img.src = convertFileSrc(artifact.image_path);
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
        detail = JSON.stringify(payload.result_metadata || {}, null, 2);
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

document.getElementById("new-run").addEventListener("click", () => createRun());
document.getElementById("open-run").addEventListener("click", () => openRun());
document.getElementById("upload").addEventListener("click", () => uploadReference());
document.getElementById("export").addEventListener("click", () => exportReport());
document.getElementById("compare").addEventListener("click", () => renderDetail());
document.getElementById("flicker").addEventListener("click", () => flicker());

createRun().catch(() => {});
