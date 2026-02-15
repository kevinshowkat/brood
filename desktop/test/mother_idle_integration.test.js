import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DESKTOP_EVENT_TYPES, PTY_COMMANDS, buildPtyCommand, quoteForPtyArg } from "../src/canvas_protocol.js";
import { createDesktopEventHandlerMap } from "../src/event_handlers/index.js";
import { POINTER_KINDS, isEffectTokenPath, isMotherRolePath, isPanPath } from "../src/canvas_handlers/pointer_paths.js";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "src", "index.html");
const appPath = join(here, "..", "src", "canvas_app.js");

const html = readFileSync(htmlPath, "utf8");
const app = readFileSync(appPath, "utf8");

test("Mother wheel markup exposes the required actions", () => {
  assert.match(html, /id=\"mother-wheel-menu\"/);
  assert.match(html, /data-action=\"add_photo\"/);
  assert.match(html, /data-action=\"add_role\"/);
});

test("Canvas app keeps modular event/canvas handler wiring", () => {
  assert.match(app, /createDesktopEventHandlerMap/);
  assert.match(app, /installCanvasPointerHandlers/);
  assert.match(app, /installCanvasWheelHandlers/);
  assert.match(app, /installCanvasKeyboardHandlers/);
  assert.match(app, /installCanvasGestureHandlers/);
  assert.match(app, /POINTER_KINDS/);
});

test("Canvas app keeps role/effect path guards in finalize pointer flow", () => {
  assert.match(app, /const motherRoleDrag = isMotherRolePath\(kind\);/);
  assert.match(app, /const effectTokenDrag = isEffectTokenPath\(kind\);/);
});

test("Protocol constants keep stable event and command contracts", () => {
  assert.equal(DESKTOP_EVENT_TYPES.INTENT_ICONS, "intent_icons");
  assert.equal(DESKTOP_EVENT_TYPES.ARTIFACT_CREATED, "artifact_created");
  assert.equal(PTY_COMMANDS.INTENT_RT_MOTHER, "/intent_rt_mother");
  assert.equal(PTY_COMMANDS.CANVAS_CONTEXT_RT_START, "/canvas_context_rt_start");
});

test("PTY command helpers preserve quoting and newline semantics", () => {
  const arg = quoteForPtyArg('a "b" \\ c');
  assert.equal(arg, '"a \\"b\\" \\\\ c"');
  assert.equal(buildPtyCommand(PTY_COMMANDS.USE, arg), '/use "a \\"b\\" \\\\ c"\n');
});

test("Pointer path helpers classify drag kinds", () => {
  assert.equal(isMotherRolePath(POINTER_KINDS.MOTHER_ROLE_DRAG), true);
  assert.equal(isEffectTokenPath(POINTER_KINDS.EFFECT_TOKEN_DRAG), true);
  assert.equal(isPanPath(POINTER_KINDS.SINGLE_PAN), true);
  assert.equal(isPanPath("unknown"), false);
});

test("Desktop event handler map routes grouped event types", () => {
  const calls = [];
  const handlers = {
    onMother: () => calls.push("mother"),
    onArtifact: () => calls.push("artifact"),
    onIntent: () => calls.push("intent"),
    onDiagnostics: () => calls.push("diagnostics"),
    onRecreate: () => calls.push("recreate"),
  };
  const map = createDesktopEventHandlerMap(DESKTOP_EVENT_TYPES, handlers);
  assert.equal(map.get(DESKTOP_EVENT_TYPES.MOTHER_PROMPT_COMPILED), handlers.onMother);
  assert.equal(map.get(DESKTOP_EVENT_TYPES.GENERATION_FAILED), handlers.onArtifact);
  assert.equal(map.get(DESKTOP_EVENT_TYPES.INTENT_ICONS), handlers.onIntent);
  assert.equal(map.get(DESKTOP_EVENT_TYPES.IMAGE_DIAGNOSIS), handlers.onDiagnostics);
  assert.equal(map.get(DESKTOP_EVENT_TYPES.RECREATE_DONE), handlers.onRecreate);
});
