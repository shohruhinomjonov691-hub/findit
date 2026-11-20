// Shared Node harness: loads the real findit/web scripts (i18n, search, camera, live, voice,
// app) into a vm context with a minimal fake DOM, fake camera, fake fetch, fake speech and a
// virtual clock (every setTimeout advances `clock`, so waits cost no real time).
// It is not a browser: it checks app.js's wiring and ordering, not real browser behaviour.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const WEB = new URL("../../findit/web/", import.meta.url);
const realSetTimeout = setTimeout;

// Module-level fake canvas state, reset by loadApp().
const canvas = { frame: new Uint8ClampedArray(32 * 24 * 4).fill(100), blobFails: false };

export class El extends EventTarget {
  constructor(tag = "div", id = "") {
    super();
    Object.assign(this, { tagName: tag.toUpperCase(), id, hidden: false, disabled: false, value: "",
      innerHTML: "", style: {}, dataset: {}, children: [], attrs: {}, className: "", parent: null });
    this.textContent = "";
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  // Like the DOM: assigning textContent replaces all children.
  get textContent() { return this._text; }
  set textContent(v) { this._text = v; this.children = []; }
  set src(v) { this._src = v; queueMicrotask(() => this.onload && this.onload()); }
  get src() { return this._src; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...c) { for (const x of c) x.parent = this; this.children.push(...c); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  scrollIntoView() {}
  click() { this.dispatchEvent(new Event("click")); }
  // Any 2D-context method is a no-op, except the two the app reads results from.
  getContext() {
    return new Proxy({}, {
      get: (_, key) => (key === "getImageData" ? () => ({ data: canvas.frame })
        : key === "measureText" ? () => ({ width: 40 }) : () => {}),
      set: () => true,
    });
  }
  toBlob(cb) { cb(canvas.blobFails ? null : { size: 1234, type: "image/jpeg" }); }
}

export class FakeDialog extends El {
  constructor(id) { super("dialog", id); this.open = false; this.queued = []; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.queued.push(new Event("close")); }
  closeByBrowser() { this.close(); }
  deliverClose() { for (const e of this.queued.splice(0)) this.dispatchEvent(e); }
}

export function fakeStream() {
  const tracks = ["video", "audio"].map((kind) => ({ kind, readyState: "live", stop() { this.readyState = "ended"; } }));
  return { getTracks: () => tracks, live: () => tracks.every((t) => t.readyState === "live"),
    ended: () => tracks.every((t) => t.readyState === "ended"), videoTrack: tracks[0] };
}

export function fakeSpeech() {
  const s = { spoken: [], voicesUsed: [], cancelled: 0, resumed: 0, speaking: false, pending: false, paused: false, fail: false, stuck: false, errorOnSpeak: null,
    voices: [{ lang: "en-US" }, { lang: "ko-KR" }],
    getVoices() { return s.voices; },
    // "stuck": starts but never ends (what a browser that drops "end" events looks like).
    speak(u) {
      if (s.fail) throw new Error("synth broken");
      s.spoken.push(u.text); s.voicesUsed.push(u.voice && u.voice.name); u.lang && (s.lastLang = u.lang);
      if (s.errorOnSpeak) { queueMicrotask(() => u.onerror && u.onerror({ error: s.errorOnSpeak })); return; }
      if (u.onstart) u.onstart();
      if (!s.stuck && u.onend) u.onend();
    },
    cancel() { s.cancelled++; },
    resume() { s.resumed++; s.paused = false; },
    addEventListener() {} };
  return s;
}
class FakeUtterance { constructor(text) { this.text = text; } }

export const flush = () => new Promise((r) => realSetTimeout(r, 0));
export async function until(cond, what = "condition", tries = 400) {
  for (let i = 0; i < tries; i++) { if (cond()) return; await flush(); }
  throw new Error("timed out waiting for " + what);
}

const INFO = {
  model: { loaded: true, classes: [], conf_threshold: 0.25, imgsz: 640, device: "cpu", file: "m.pt", sha256: null },
  limits: { max_upload_mib: 10, max_megapixels: 40, min_side: 16, max_side: 12000 },
  live: { enabled: true, imgsz: [320, 416, 512], conf_threshold: 0.35, max_frame_kib: 512, max_duty: 0.6 },
  source: { url: null, commit: null },
};

// options: { hash, secure, speech (false = none), info, lists: { ".lang-btn": [El...] } }
export function loadApp(options = {}) {
  canvas.frame = new Uint8ClampedArray(32 * 24 * 4).fill(100);
  canvas.blobFails = false;
  const els = new Map();
  const byId = (id) => {
    if (!els.has(id)) els.set(id, id === "cameraDialog" ? new FakeDialog(id) : new El("div", id));
    return els.get(id);
  };
  const lists = options.lists || {};
  const doc = new EventTarget();
  Object.assign(doc, {
    documentElement: { lang: "en" }, body: new El("body"), hidden: false,
    getElementById: byId, querySelector: () => null,
    querySelectorAll: (sel) => lists[sel] || [],
    createElement: (tag) => new El(tag),
  });
  const h = { $: byId, doc, calls: [], fetches: [], clock: 0, respond: null, speech: null };
  h.gum = (constraints) => new Promise((resolve, reject) => h.calls.push({ resolve, reject, constraints }));
  h.respond = async (url) => (url.includes("/api/info")
    ? { ok: true, status: 200, json: async () => options.info || INFO }
    : { ok: false, status: 500, json: async () => ({}) });
  h.speech = options.speech === false ? undefined : fakeSpeech();
  const win = new EventTarget();
  const ctx = {
    document: doc,
    navigator: { language: options.language || "en", mediaDevices: { getUserMedia: h.gum } },
    location: { hash: options.hash ? "#" + options.hash : "" },
    history: { replaceState() {} },
    localStorage: { getItem: (k) => (options.storage && k in options.storage ? options.storage[k] : null), setItem() {} },
    isSecureContext: options.secure !== false,
    fetch: async (url, opts) => { h.fetches.push({ url, opts }); return h.respond(url, opts); },
    Option: function Option(text, value) { const o = new El("option"); o.textContent = text; o.value = value; return o; },
    File: class {}, Blob: class {}, AbortController, Event,
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL() {} },
    performance: { now: () => h.clock },
    // Waits of the app's loops advance the virtual clock. Long timers (voice.js's 4 s "speech
    // never started" watchdog) must not: they are cancelled when speech starts, so they are
    // never run here and never move the clock.
    setTimeout: (fn, ms) => {
      if (ms >= 3500) return realSetTimeout(() => {}, 0);
      h.clock += ms || 0;
      return realSetTimeout(fn, 0);
    },
    clearTimeout,
    // Only when asked: an animation-frame loop would keep running for the whole test.
    ...(options.raf ? { requestAnimationFrame: (fn) => realSetTimeout(() => fn(h.clock), 0) } : {}),
    console,
    speechSynthesis: h.speech, SpeechSynthesisUtterance: h.speech ? FakeUtterance : undefined,
    addEventListener: win.addEventListener.bind(win),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ["i18n.js", "search.js", "camera.js", "live.js", "voice.js", "app.js"]) {
    vm.runInContext(readFileSync(new URL(f, WEB), "utf8"), ctx, { filename: f });
  }
  h.win = win;
  h.ctx = ctx;
  h.canvas = canvas;
  h.liveFetches = () => h.fetches.filter((f) => String(f.url).includes("/api/detect/live"));
  return h;
}

export async function openWithStream(app) {
  app.$("cameraBtn").click();
  const s = fakeStream();
  app.calls.at(-1).resolve(s);
  await flush();
  return s;
}
