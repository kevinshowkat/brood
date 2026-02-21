import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "src", "canvas_app.js");
const app = readFileSync(appPath, "utf8");

test("Mother replace commit snapshot preserves provenance fields for undo", () => {
  assert.match(
    app,
    /const beforeTarget = [\s\S]*motherVersionId:\s*t\.motherVersionId\s*\?\s*String\(t\.motherVersionId\)\s*:\s*null,[\s\S]*receiptMeta:\s*t\.receiptMeta\s*&&\s*typeof t\.receiptMeta === "object"\s*\?\s*\{\s*\.\.\.t\.receiptMeta\s*\}\s*:\s*null,[\s\S]*receiptMetaChecked:\s*Boolean\(t\.receiptMetaChecked\),/
  );
});

test("Mother replace undo restores provenance fields on the target image", () => {
  const undoBlock = app.match(/if \(undo\.mode === "replace"[\s\S]*?if \(Array\.isArray\(undo\.removedSeeds\)/);
  assert.ok(undoBlock, "replace undo block not found");
  const block = undoBlock[0];

  assert.match(block, /targetItem\.motherVersionId = undo\.before\.motherVersionId \? String\(undo\.before\.motherVersionId\) : null;/);
  assert.match(
    block,
    /targetItem\.receiptMeta =[\s\S]*undo\.before\.receiptMeta && typeof undo\.before\.receiptMeta === "object"[\s\S]*\{ \.\.\.undo\.before\.receiptMeta \}[\s\S]*: null;/
  );
  assert.match(block, /targetItem\.receiptMetaChecked = Boolean\(undo\.before\.receiptMetaChecked\);/);
  assert.match(block, /targetItem\.receiptMetaLoading = false;/);
});

test("ensureReceiptMeta requests a repaint after async metadata resolves", () => {
  const ensureFn = app.match(/async function ensureReceiptMeta\(item\) \{[\s\S]*?\n}\n\nasync function ingestTopMetricsFromReceiptPath/);
  assert.ok(ensureFn, "ensureReceiptMeta function not found");
  assert.match(ensureFn[0], /requestRender\(\);/);
});
