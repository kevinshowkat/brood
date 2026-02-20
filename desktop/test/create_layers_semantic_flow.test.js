import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Create Layers: semantic 3-pass pipeline replaces checkerboard partitioning", () => {
  assert.match(app, /function createSemanticLayerSpecs\(imgItem = null\)/);
  assert.match(app, /Layer 1\/3 - Background/);
  assert.match(app, /Layer 2\/3 - Main Subject/);
  assert.match(app, /Layer 3\/3 - Key Props/);
  assert.match(app, /flat solid #00FF00 background/);
  assert.doesNotMatch(app, /partition:\s*"checkerboard_mod2"/);
  assert.doesNotMatch(app, /const layerCount = 4;/);
});

test("Create Layers: pending artifact flow and chroma-key cleanup are wired", () => {
  assert.match(app, /pendingCreateLayers/);
  assert.match(app, /function applyChromaKeyToCreateLayerCanvas\(canvas/);
  assert.match(app, /async function dispatchCreateLayersPass\(\)/);
  assert.match(app, /async function handleCreateLayersArtifact\(event\)/);
});
