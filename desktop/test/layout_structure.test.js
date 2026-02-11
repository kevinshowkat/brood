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

test("Mother: top-right overlay keeps portrait + controls while dialog panel is hidden", () => {
  assert.match(html, /id=\"mother-overlay\"/);
  assert.match(html, /id=\"mother-panel-stack\"/);
  assert.match(html, /id=\"mother-panel\"/);
  assert.match(html, /id=\"mother-portrait-shell\"/);
  assert.match(html, /id=\"mother-video\"/);
  assert.match(html, /id=\"mother-panel\"[\s\S]*id=\"tips-text\"/);
  assert.match(html, /id=\"mother-panel\"[\s\S]*mother-actions-floating/);
  assert.match(css, /\.mother-overlay\s*\{[\s\S]*position:\s*absolute/);
  assert.match(css, /\.mother-overlay\s*\{[\s\S]*top:\s*12px/);
  assert.match(css, /\.mother-overlay\s*\{[\s\S]*right:\s*12px/);
  assert.match(css, /\.mother-overlay\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(css, /\.mother-overlay\s*\{[\s\S]*align-items:\s*flex-end/);
  assert.match(css, /#mother-portrait-shell\s*\{/);
  assert.match(css, /#mother-panel-stack\s*\{[\s\S]*width:\s*fit-content/);
  assert.match(css, /#mother-panel\s*\{/);
  assert.match(css, /#mother-panel\s*\{[\s\S]*display:\s*none/);
  assert.match(css, /#mother-panel-stack\s+\.mother-actions\s*\{[\s\S]*justify-content:\s*center/);
});
