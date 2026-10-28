// Loads the real findit/web/app.js (with i18n.js, search.js, camera.js) into a vm
// context with a minimal fake DOM, then drives the camera through app.js's own
// event listeners. The fake <dialog> follows the HTML rule that close() hides the
// dialog at once but delivers the "close" event later; tests deliver it by hand.
// This is a Node harness, not a browser: it checks app.js's wiring and ordering,
// not real browser event timing. Run: node --test tests/js/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const WEB = new URL("../../findit/web/", import.meta.url);

class El extends EventTarget {
  constructor(tag = "div", id = "") {
    super();
    Object.assign(this, { tagName: tag.toUpperCase(), id, hidden: false, disabled: false, textContent: "", value: "",
      innerHTML: "", style: {}, dataset: {}, children: [], attrs: {} });
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...c) { this.children.push(...c); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  scrollIntoView() {}
  click() { this.dispatchEvent(new Event("click")); }
  getContext() { return { fillRect() {}, drawImage() {} }; }
  toBlob() {}
}

class FakeDialog extends El {
  constructor(id) { super("dialog", id); this.open = false; this.queued = []; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.queued.push(new Event("close")); }
  // A close the browser starts itself (e.g. its own Escape handling), not via app.js.
  closeByBrowser() { this.close(); }
  deliverClose() { for (const e of this.queued.splice(0)) this.dispatchEvent(e); }
}

function fakeStream() {
  const tracks = ["video", "audio"].map((kind) => ({ kind, readyState: "live", stop() { this.readyState = "ended"; } }));
  return { getTracks: () => tracks, live: () => tracks.every((t) => t.readyState === "live"),
    ended: () => tracks.every((t) => t.readyState === "ended") };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function loadApp() {
  const els = new Map();
  const byId = (id) => {
    if (!els.has(id)) els.set(id, id === "cameraDialog" ? new FakeDialog(id) : new El("div", id));
    return els.get(id);
  };
  const doc = new EventTarget();
  Object.assign(doc, {
    documentElement: { lang: "en" },
    body: new El("body"),
    getElementById: byId,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => new El(tag),
  });
  const calls = [];
  const gum = () => new Promise((resolve, reject) => calls.push({ resolve, reject }));
  const win = new EventTarget();
  const ctx = {
    document: doc,
    navigator: { language: "en", mediaDevices: { getUserMedia: gum } },
    location: { hash: "" },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    isSecureContext: true,
    fetch: async () => ({ ok: true, json: async () => ({
      model: { loaded: true, classes: [], conf_threshold: 0.25, imgsz: 640, device: "cpu", file: "m.pt", sha256: null },
      limits: { max_upload_mib: 10, max_megapixels: 40, min_side: 16, max_side: 12000 },
      source: { url: null, commit: null },
    }) }),
    Option: function Option(text, value) { const o = new El("option"); o.textContent = text; o.value = value; return o; },
    File: class {},
    setTimeout, clearTimeout, console,
    addEventListener: win.addEventListener.bind(win),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ["i18n.js", "search.js", "camera.js", "app.js"]) {
    vm.runInContext(readFileSync(new URL(f, WEB), "utf8"), ctx, { filename: f });
  }
  return { $: byId, calls, doc };
}

async function openWithStream(app) {
  app.$("cameraBtn").click();
  const s = fakeStream();
  app.calls.at(-1).resolve(s);
  await flush();
  return s;
}

test("stale close event after Cancel → reopen does not close the new session", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  const s1 = await openWithStream(app);
  app.$("cameraCancel").click();
  assert.ok(s1.ended(), "Cancel stops the first stream");
  assert.equal(dialog.queued.length, 1, "close event still queued");

  const s2 = await openWithStream(app);
  assert.equal(dialog.open, true);
  dialog.deliverClose(); // the first session's close event arrives late

  assert.equal(dialog.open, true, "new session's dialog stays open");
  assert.ok(s2.live(), "new session's stream keeps running");
  assert.equal(app.$("cameraVideo").srcObject, s2);
  assert.equal(app.$("cameraShoot").disabled, false);

  app.$("cameraCancel").click();
  dialog.deliverClose();
  assert.ok(s2.ended());
});

test("stale close event while the reopened request is still pending does not cancel it", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  await openWithStream(app);
  app.$("cameraCancel").click();
  app.$("cameraBtn").click(); // second request pending
  dialog.deliverClose();
  const s2 = fakeStream();
  app.calls.at(-1).resolve(s2);
  await flush();
  assert.equal(dialog.open, true);
  assert.ok(s2.live());
  assert.equal(app.$("cameraVideo").srcObject, s2);
});

test("a close started by the browser stops the stream", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  const s = await openWithStream(app);
  dialog.closeByBrowser();
  dialog.deliverClose();
  assert.ok(s.ended());
  assert.equal(app.$("cameraVideo").srcObject, null);
});

test("Escape stops the stream and closes the dialog", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  const s = await openWithStream(app);
  const esc = new Event("keydown");
  esc.key = "Escape";
  app.doc.dispatchEvent(esc); // app.js listens for keydown on document
  assert.ok(s.ended());
  assert.equal(dialog.open, false);
  dialog.deliverClose();
  assert.ok(s.ended());
});

test("Capture stops the stream and closes the dialog", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  const s = await openWithStream(app);
  app.$("cameraVideo").videoWidth = 640;
  app.$("cameraVideo").videoHeight = 480;
  app.$("cameraShoot").click();
  assert.ok(s.ended());
  assert.equal(dialog.open, false);
  dialog.deliverClose();
  assert.ok(s.ended());
});

test("a stream arriving after Cancel during the request is stopped", async () => {
  const app = loadApp();
  const dialog = app.$("cameraDialog");
  app.$("cameraBtn").click();
  app.$("cameraCancel").click();
  dialog.deliverClose();
  const late = fakeStream();
  app.calls.at(-1).resolve(late);
  await flush();
  assert.ok(late.ended());
  assert.equal(dialog.open, false);
});
