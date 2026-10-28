// Unit tests for findit/web/search.js using the real class and synonym tables
// from findit/web/i18n.js (no browser). Run: node --test tests/js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const { queryClasses } = createRequire(import.meta.url)("../../findit/web/search.js");
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL("../../findit/web/i18n.js", import.meta.url), "utf8"), sandbox);
const KO = sandbox.window.FINDIT_CLASS_KO;
const SYN = sandbox.window.FINDIT_SYNONYMS;
const CLASSES = Object.keys(KO);
const q = (text) => {
  const r = queryClasses(text, CLASSES, KO, SYN);
  return r === null ? null : [...r].sort();
};

test("unsupported objects are not mapped to a similar class", () => {
  assert.deepEqual(q("tablet"), []);
  assert.deepEqual(q("phone case"), []);
  assert.deepEqual(q("pen"), []);
  assert.deepEqual(q("tables"), []);
});

test("no partial or prefix matches", () => {
  assert.deepEqual(q("car"), ["car"]); // not "carrot"
  assert.deepEqual(q("pho"), []);
  assert.deepEqual(q("휴대"), []);
});

test("full class names and listed synonyms work in EN and KO", () => {
  assert.deepEqual(q("cell phone"), ["cell phone"]);
  assert.deepEqual(q("  Cell   PHONE "), ["cell phone"]);
  assert.deepEqual(q("phone"), ["cell phone"]);
  assert.deepEqual(q("핸드폰"), ["cell phone"]);
  assert.deepEqual(q("휴대폰"), ["cell phone"]);
  assert.deepEqual(q("mug"), ["cup"]);
  assert.deepEqual(q("table"), ["dining table"]);
  assert.deepEqual(q("TV"), ["tv"]);
  assert.deepEqual(q("노트북"), ["laptop"]);
});

test("every synonym points to a real COCO class", () => {
  for (const [word, cls] of Object.entries(SYN)) assert.ok(CLASSES.includes(cls), `${word} -> ${cls}`);
});

test("empty query means no filter", () => {
  assert.equal(q("   "), null);
});
