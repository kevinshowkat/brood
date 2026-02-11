import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "src", "index.html");
const cssPath = join(here, "..", "src", "styles.css");
const html = readFileSync(htmlPath, "utf8");
const css = readFileSync(cssPath, "utf8");

test("Action Deck: contains Action Grid + Agents Dock with two stacked portrait videos", () => {
  assert.match(html, /id=\"control-strip\"/);
  assert.match(html, /id=\"minimap\"/);
  assert.match(html, /id=\"hud\"/);
  assert.match(html, /id=\"action-grid\"/);
  assert.match(html, /id=\"agents-dock\"/);
  assert.match(html, /id=\"portrait-video\"/);
  assert.match(html, /id=\"portrait-video-2\"/);
  assert.match(html, /id=\"control-strip\"[\s\S]*canvas-bumper--left[\s\S]*id=\"minimap\"[\s\S]*id=\"hud\"[\s\S]*id=\"action-grid\"[\s\S]*id=\"agents-dock\"[\s\S]*canvas-bumper--right/);
});

test("Agents Dock: CSS stacks portraits vertically and keeps dock height aligned to grid", () => {
  assert.match(css, /\.agents-dock\s*\{/);
  assert.match(css, /height:\s*calc\(var\(--hud-keybar-h\)\s*\+\s*2px\)/);
  assert.match(css, /\.agents-dock\s+\.agent-portraits\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(css, /\.control-strip\s*\{[\s\S]*gap:\s*0/);
});

test("Action Grid: CSS uses hazard stripe frame", () => {
  assert.match(css, /\.action-grid::before\s*\{/);
  assert.match(css, /repeating-linear-gradient\([\s\S]*135deg/);
  assert.match(css, /rgba\(255,\s*197,\s*0/);
});

test("Mother: floating overlay exists in HTML and is positioned top-right in CSS", () => {
  assert.match(html, /id=\"mother-panel\"/);
  assert.match(html, /id=\"mother-panel\"[\s\S]*id=\"tips-text\"/);
  assert.match(html, /id=\"mother-video\"/);
  assert.match(css, /\.mother-overlay\s*\{[\s\S]*position:\s*absolute/);
  assert.match(css, /\.mother-overlay\s*\{[\s\S]*top:\s*12px/);
  assert.match(css, /\.mother-overlay\s*\{[\s\S]*right:\s*12px/);
  assert.match(css, /#mother-panel\s*\{/);
  assert.match(css, /#mother-panel\s*\{[\s\S]*position:\s*absolute/);
  assert.match(css, /#mother-panel\s*\{[\s\S]*right:\s*12px/);
  assert.match(css, /conic-gradient/);
});
