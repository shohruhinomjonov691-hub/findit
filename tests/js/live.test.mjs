// Unit tests for findit/web/live.js (tracker, governor, motion gate, meter). No browser.
// Run: node --test tests/js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const L = createRequire(import.meta.url)("../../findit/web/live.js");
const FRAME = { w: 640, h: 480 };
const det = (cls, score, box) => ({ class_name: cls, score, bbox_xyxy: box });
const CUP = [100, 100, 200, 200];

test("a weak detection needs two frames before it is shown; a confident one shows at once", () => {
  const tr = L.createTracker();
  assert.equal(tr.update([det("cup", 0.5, CUP)], FRAME, 0).length, 0);
  const second = tr.update([det("cup", 0.52, CUP)], FRAME, 300);
  assert.equal(second.length, 1);
  assert.equal(second[0].class_name, "cup");
  const t2 = L.createTracker();
  assert.equal(t2.update([det("book", 0.9, CUP)], FRAME, 0).length, 1);
});

test("a one-frame false positive never appears", () => {
  const tr = L.createTracker();
  tr.update([det("cup", 0.45, CUP)], FRAME, 0);
  for (let i = 1; i <= 6; i++) assert.equal(tr.update([], FRAME, i * 300).length, 0);
  assert.equal(tr.count, 0, "the unconfirmed track is dropped after maxMisses");
});

test("a missed frame does not make the box blink; it disappears only after maxMisses", () => {
  const tr = L.createTracker({ maxMisses: 3 });
  tr.update([det("cup", 0.8, CUP)], FRAME, 0);
  tr.update([det("cup", 0.8, CUP)], FRAME, 300);
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    const v = tr.update([], FRAME, 300 + i * 300);
    assert.equal(v.length, 1, `still shown after ${i} empty frame(s)`);
    assert.equal(v[0].misses, i);
    ids.push(v[0].id);
  }
  assert.equal(tr.update([], FRAME, 1500).length, 0, "gone after the 4th empty frame");
  assert.equal(new Set(ids).size, 1, "same track throughout");
});

test("the same object keeps its id and its box moves smoothly (no jump)", () => {
  const tr = L.createTracker({ alpha: 0.5 });
  const a = tr.update([det("cup", 0.9, [100, 100, 200, 200])], FRAME, 0)[0];
  const b = tr.update([det("cup", 0.9, [120, 100, 220, 200])], FRAME, 300)[0];
  assert.equal(a.id, b.id);
  assert.ok(b.box[0] > 100 && b.box[0] < 120, `smoothed x1 = ${b.box[0]}`);
});

test("two cups side by side are two tracks and keep separate ids", () => {
  const tr = L.createTracker();
  const L1 = [50, 100, 120, 200], R1 = [400, 100, 470, 200];
  const first = tr.update([det("cup", 0.9, L1), det("cup", 0.85, R1)], FRAME, 0);
  const second = tr.update([det("cup", 0.9, [52, 100, 122, 200]), det("cup", 0.85, [402, 100, 472, 200])], FRAME, 300);
  assert.equal(first.length, 2);
  assert.deepEqual(second.map((t) => t.id).sort(), first.map((t) => t.id).sort());
});

test("book/phone flip-flop on one box does not flicker the label", () => {
  const tr = L.createTracker();
  const seq = ["book", "book", "cell phone", "book", "book", "cell phone", "book"];
  const labels = seq.map((c, i) => tr.update([det(c, 0.6, CUP)], FRAME, i * 300)).map((v) => v.map((t) => t.class_name));
  assert.deepEqual(labels.slice(1).flat(), Array(6).fill("book"));
  assert.equal(tr.count, 1, "one track, not one per label");
});

test("a lasting class change wins after a few frames", () => {
  const tr = L.createTracker();
  let last;
  for (let i = 0; i < 3; i++) last = tr.update([det("book", 0.8, CUP)], FRAME, i * 300);
  assert.equal(last[0].class_name, "book");
  for (let i = 3; i < 9; i++) last = tr.update([det("cell phone", 0.8, CUP)], FRAME, i * 300);
  assert.equal(last[0].class_name, "cell phone");
});

test("cell is computed from the smoothed centre and frame size (3x3)", () => {
  const tr = L.createTracker();
  const v = tr.update([det("cup", 0.9, [500, 20, 620, 100])], FRAME, 0)[0];
  assert.deepEqual(v.cell, { row: 0, col: 2 });
  assert.deepEqual(L.gridCell(320, 240, 640, 480), { row: 1, col: 1 });
  assert.deepEqual(L.gridCell(640, 480, 640, 480), { row: 2, col: 2 });
});

test("a frame size change (device rotated) resets the tracks", () => {
  const tr = L.createTracker();
  tr.update([det("cup", 0.9, CUP)], FRAME, 0);
  const v = tr.update([det("cup", 0.9, [10, 10, 60, 60])], { w: 480, h: 640 }, 300);
  assert.equal(v[0].hits, 1);
});

test("stale tracks expire after a long gap even without miss counting", () => {
  const tr = L.createTracker({ maxAgeMs: 2500, maxMisses: 99 });
  tr.update([det("cup", 0.9, CUP)], FRAME, 0);
  assert.equal(tr.update([], FRAME, 5000).length, 0);
});

// ---------- governor ----------
test("Auto starts balanced, steps down on slow answers, only once per 3 s", () => {
  const g = L.createGovernor("auto");
  assert.equal(g.profile().name, "balanced");
  g.record({ ok: true, latencyMs: 2500 }, 9_000); // model warm-up answer: ignored
  assert.equal(g.profile().name, "balanced", "a slow first answer (warm-up) does not step down");
  g.record({ ok: true, latencyMs: 900 }, 10_000);
  assert.equal(g.profile().name, "low");
  g.record({ ok: true, latencyMs: 900 }, 10_500);
  assert.equal(g.profile().name, "low", "already the lowest");
});

test("Auto steps down after repeated busy answers", () => {
  const g = L.createGovernor("auto");
  g.record({ busy: true }, 10_000);
  assert.equal(g.profile().name, "balanced");
  g.record({ busy: true }, 10_200);
  assert.equal(g.profile().name, "low");
});

test("Auto steps up only after a long run of quick answers", () => {
  const g = L.createGovernor("auto");
  g.record({ ok: true, latencyMs: 150 }, 9_000); // first answer is ignored
  for (let i = 0; i < 7; i++) g.record({ ok: true, latencyMs: 150 }, 10_000 + i * 400);
  assert.equal(g.profile().name, "balanced");
  g.record({ ok: true, latencyMs: 150 }, 13_000);
  assert.equal(g.profile().name, "fast");
});

test("a pinned mode is never changed by results", () => {
  const g = L.createGovernor("fast");
  for (let i = 0; i < 5; i++) g.record({ ok: true, latencyMs: 3000 }, i * 5000);
  g.record({ busy: true }, 99_000); g.record({ busy: true }, 99_500);
  assert.equal(g.profile().name, "fast");
  g.setMode("low");
  assert.equal(g.profile().name, "low");
  g.setMode("auto");
  assert.equal(g.mode, "auto");
});

test("profiles only use model sizes the server accepts", () => {
  for (const p of Object.values(L.PROFILES)) assert.ok([320, 416, 512].includes(p.imgsz), p.name);
  for (const p of Object.values(L.PROFILES)) assert.ok(p.frame >= 416 && p.quality >= 0.8, `${p.name}: no tiny or blocky frames`);
});

test("delay between frames: profile interval, or the server's retry hint after busy", () => {
  const p = L.PROFILES.balanced;
  assert.equal(L.nextDelayMs(p, 100), 250);
  assert.equal(L.nextDelayMs(p, 800), 0);
  assert.equal(L.nextDelayMs(p, 50, 1200), 1200);
  assert.equal(L.nextDelayMs(L.PROFILES.low, 10, 200), 1000, "never faster than the profile");
});

// ---------- motion gate ----------
test("static scene is skipped, movement is sent, heartbeat forces a send", () => {
  const a = new Uint8Array(768).fill(100);
  const same = new Uint8Array(768).fill(101); // sensor noise
  const moved = new Uint8Array(768).fill(100); moved.fill(200, 0, 300);
  assert.ok(L.motionScore(a, same) < 0.01);
  assert.ok(L.motionScore(a, moved) > 0.1);
  assert.equal(L.motionScore(null, a), 1, "first frame always counts as motion");
  assert.equal(L.shouldSend(L.motionScore(a, same), 200), false);
  assert.equal(L.shouldSend(L.motionScore(a, moved), 200), true);
  assert.equal(L.shouldSend(L.motionScore(a, same), 1600), true, "heartbeat");
});

test("toGray converts RGBA", () => {
  const g = L.toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]));
  assert.ok(g[0] >= 253 && g[1] === 0);
});

// ---------- meter ----------
test("meter reports FPS over its window and a smoothed latency", () => {
  const m = L.createMeter(3000);
  assert.equal(m.fps(0), 0);
  for (let i = 0; i < 6; i++) m.push(i * 250, 200);
  assert.ok(Math.abs(m.fps(1250) - 4) < 0.01, `fps ${m.fps(1250)}`);
  assert.equal(Math.round(m.latency), 200);
  assert.equal(m.fps(60_000), 0, "old samples fall out of the window");
});

// ---------- box accuracy: following, projection, filtering ----------
test("a moving object is followed almost fully; a still one is only smoothed", () => {
  const tr = L.createTracker();
  tr.update([det("cup", 0.9, [100, 100, 200, 200])], FRAME, 0, 0);
  const moved = tr.update([det("cup", 0.9, [140, 100, 240, 200])], FRAME, 400, 300)[0]; // jumped 40 px
  assert.ok(moved.box[0] >= 135, `followed: x1 ${moved.box[0]}`);
  const still = L.createTracker();
  still.update([det("cup", 0.9, [100, 100, 200, 200])], FRAME, 0, 0);
  const jitter = still.update([det("cup", 0.9, [102, 101, 202, 201])], FRAME, 400, 300)[0]; // 2 px noise
  assert.ok(jitter.box[0] > 100 && jitter.box[0] < 101.5, `smoothed: x1 ${jitter.box[0]}`);
});

test("projectBox moves a box on at its measured speed, within limits; still and stale boxes stay", () => {
  const tr = L.createTracker();
  tr.update([det("cup", 0.9, [100, 100, 200, 200])], FRAME, 0, 0);
  let t = tr.update([det("cup", 0.9, [140, 100, 240, 200])], FRAME, 400, 300)[0]; // 40 px per 300 ms
  const later = L.projectBox(t, t.stamp + 150);
  assert.ok(later[0] > t.box[0], "moved forward");
  assert.ok(later[0] - t.box[0] <= 100 / 3 + 1e-6, "never by more than a third of the box");
  assert.deepEqual(L.projectBox(t, t.stamp), t.box, "no lead, no move");
  assert.ok(L.projectBox(t, t.stamp + 60_000)[0] - t.box[0] <= 100 / 3 + 1e-6, "capped for very old answers");
  const still = L.createTracker();
  still.update([det("cup", 0.9, CUP)], FRAME, 0, 0);
  const s = still.update([det("cup", 0.9, CUP)], FRAME, 400, 300)[0];
  assert.deepEqual(L.projectBox(s, s.stamp + 300), s.box, "a still box does not drift");
  const stale = tr.update([], FRAME, 800, 700)[0];
  assert.equal(stale.misses, 1);
  assert.deepEqual(L.projectBox(stale, stale.stamp + 300), stale.box, "a missed (stale) box is not extrapolated");
});

test("settle() stops the extrapolation: a box that was moving does not run ahead of an object that has stopped", () => {
  const tr = L.createTracker();
  let x = 100, last;
  for (let i = 0; i < 5; i++, x += 40) last = tr.update([det("cup", 0.9, [x, 100, x + 100, 200])], FRAME, i * 300 + 120, i * 300)[0];
  last = tr.update([det("cup", 0.9, [x, 100, x + 100, 200])], FRAME, 5 * 300 + 120, 5 * 300)[0]; // the final, resting frame
  assert.ok(L.projectBox(last, last.stamp + 400)[0] - x > 10, "precondition: the stale speed would push the box ahead");
  tr.settle(); // the app calls this when the motion gate skips a frame (the picture is still)
  const [after] = tr.update([], FRAME, 5 * 300 + 400, 5 * 300 + 400); // an empty frame keeps the track (1 miss) ...
  assert.equal(after.misses, 1);
  const kept = tr.update([det("cup", 0.9, [x, 100, x + 100, 200])], FRAME, 6 * 300 + 400, 6 * 300 + 400)[0];
  assert.ok(Math.abs(L.projectBox(kept, kept.stamp + 600)[0] - x) < 2, "no drift after settle + a resting frame");
  const s2 = L.createTracker();
  for (let i = 0; i < 4; i++) s2.update([det("cup", 0.9, [100 + 40 * i, 100, 200 + 40 * i, 200])], FRAME, i * 300 + 120, i * 300);
  s2.settle();
  const t = s2.update([det("cup", 0.9, [220, 100, 320, 200])], FRAME, 4 * 300 + 120, 4 * 300)[0];
  assert.ok(Math.abs(L.projectBox(t, t.stamp + 400)[0] - t.box[0]) < 20, "speed restarts from a short measurement, not the old one");
});

test("settleTracks stops the copies that update() handed out (the ones that are drawn)", () => {
  const tr = L.createTracker();
  tr.update([det("cup", 0.9, [100, 100, 200, 200])], FRAME, 120, 0);
  const [moving] = tr.update([det("cup", 0.9, [140, 100, 240, 200])], FRAME, 420, 300);
  assert.ok(L.projectBox(moving, moving.stamp + 300)[0] > moving.box[0], "precondition: it is being extrapolated");
  L.settleTracks([moving]);
  assert.deepEqual(L.projectBox(moving, moving.stamp + 300), moving.box);
});

test("projection never reaches further than 400 ms (a busy server or a long wait must not park the box ahead)", () => {
  const tr = L.createTracker();
  tr.update([det("cup", 0.9, [100, 100, 200, 200])], FRAME, 120, 0);
  const t = tr.update([det("cup", 0.9, [120, 100, 220, 200])], FRAME, 420, 300)[0];
  const at400 = L.projectBox(t, t.stamp + 400)[0];
  assert.equal(L.projectBox(t, t.stamp + 5000)[0], at400);
});

test("filterTracks: minimum confidence, and large boxes need a high confidence", () => {
  const frame = { w: 640, h: 480 };
  const track = (score, box) => ({ score, box });
  const small = track(0.5, [0, 0, 100, 100]), weakSmall = track(0.4, [0, 0, 100, 100]);
  const bigWeak = track(0.55, [0, 0, 600, 400]), bigSure = track(0.8, [0, 0, 600, 400]);
  const kept = L.filterTracks([small, weakSmall, bigWeak, bigSure], frame);
  assert.deepEqual(kept, [small, bigSure]);
  assert.equal(L.filterTracks([weakSmall], frame, 0.35).length, 1, "the user can lower the threshold");
  assert.equal(L.filterTracks([small], frame, 0.6).length, 0, "or raise it");
  assert.equal(L.DEFAULT_MIN_CONF, 0.45);
});

test("fewer stale boxes: a box disappears after two empty frames", () => {
  const tr = L.createTracker();
  tr.update([det("cup", 0.9, CUP)], FRAME, 0, 0);
  tr.update([det("cup", 0.9, CUP)], FRAME, 300, 300);
  assert.equal(tr.update([], FRAME, 600, 600).length, 1);
  assert.equal(tr.update([], FRAME, 900, 900).length, 1);
  assert.equal(tr.update([], FRAME, 1200, 1200).length, 0);
});
