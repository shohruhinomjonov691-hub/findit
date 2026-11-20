// Drives the real app.js (live camera, voice, upload/export states) through its own event
// listeners in the shared Node harness: fake camera, fake fetch, fake speechSynthesis and a
// virtual clock. Not a browser. Run: node --test tests/js/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { El, fakeStream, fakeSpeech, flush, loadApp, until } from "./harness.mjs";

const LIVE_URL = "/api/detect/live";
const INFO = {
  model: { loaded: true, classes: [], conf_threshold: 0.25, imgsz: 640, device: "cpu", file: "m.pt", sha256: null },
  limits: { max_upload_mib: 10, max_megapixels: 40, min_side: 16, max_side: 12000 },
  live: { enabled: true, imgsz: [320, 416, 512], conf_threshold: 0.35, max_frame_kib: 512, max_duty: 0.6 },
  source: { url: null, commit: null },
};
const CUP_RIGHT = { class_name: "cup", score: 0.9, bbox_xyxy: [230, 100, 300, 170] }; // 320x240 frame, middle right
const BOOK_LEFT = { class_name: "book", score: 0.97, bbox_xyxy: [10, 100, 80, 170] };
const liveBody = (dets) => ({ image: { width: 320, height: 240 }, imgsz: 320, detections: dets,
  timing: { inference_ms: 100, server_ms: 110 } });
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Routes /api/info and the live endpoint; every live answer takes 120 ms of virtual time and,
// unless `still`, changes the camera picture so the motion gate lets the next frame through.
function route(app, liveAnswer, { still = false, info = INFO } = {}) {
  let n = 0;
  app.liveTimes = [];
  app.respond = async (url, opts) => {
    if (String(url).includes("/api/info")) return reply(200, info);
    if (!String(url).includes(LIVE_URL)) throw new Error("unexpected URL " + url);
    app.liveTimes.push(app.clock);
    const answer = await liveAnswer(n++, url, opts);
    app.clock += 120;
    if (!still) app.canvas.frame.fill(n % 2 ? 40 : 200);
    return answer;
  };
}

async function startLive(app, answer, opts) {
  route(app, answer, opts);
  await flush();
  app.$("liveVideo").videoWidth = 640;
  app.$("liveVideo").videoHeight = 480;
  app.$("liveToggle").click();
  const stream = fakeStream();
  app.calls.at(-1).resolve(stream);
  await until(() => app.$("liveState").dataset.state === "active", "Live Active");
  return stream;
}
const stopLive = (app) => { if (app.$("liveState").dataset.state !== "off") app.$("liveToggle").click(); };
const overlayLabels = (app) => app.$("liveOverlay").children.map((el) => el.children[0].textContent);
const livePage = (extra = {}) => loadApp({ hash: "live", ...extra });

// ---------- camera permission, missing camera, insecure page ----------
test("camera permission denied: clear message, Live stays Off, nothing is sent", async () => {
  const app = livePage();
  route(app, async () => reply(200, liveBody([])));
  await flush();
  app.$("liveToggle").click();
  assert.equal(app.$("liveState").dataset.state, "starting");
  app.calls.at(-1).reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  await until(() => !app.$("banner").hidden, "error banner");
  assert.match(app.$("bannerText").textContent, /Camera access was denied/);
  assert.equal(app.$("liveState").dataset.state, "off");
  assert.equal(app.$("liveState").textContent, "Live Off");
  assert.equal(app.$("liveToggle").textContent, "Start live");
  assert.equal(app.liveFetches().length, 0);
  // and a new attempt is possible afterwards
  app.$("liveToggle").click();
  assert.equal(app.calls.length, 2);
});

test("no camera / no mediaDevices / insecure page give their own messages", async () => {
  const none = livePage();
  route(none, async () => reply(200, liveBody([])));
  await flush();
  none.$("liveToggle").click();
  none.calls.at(-1).reject(Object.assign(new Error("x"), { name: "NotFoundError" }));
  await until(() => !none.$("banner").hidden);
  assert.match(none.$("bannerText").textContent, /No camera was found/);

  const insecure = livePage({ secure: false });
  route(insecure, async () => reply(200, liveBody([])));
  await flush();
  insecure.$("liveToggle").click();
  assert.match(insecure.$("bannerText").textContent, /secure \(HTTPS or localhost\)/);
  assert.equal(insecure.calls.length, 0, "the camera is not even requested");
});

test("Live switched off on the server: message, camera never requested", async () => {
  const app = livePage({ info: { ...INFO, live: { ...INFO.live, enabled: false } } });
  route(app, async () => reply(200, liveBody([])), { info: { ...INFO, live: { ...INFO.live, enabled: false } } });
  await flush();
  app.$("liveToggle").click();
  assert.match(app.$("bannerText").textContent, /switched off on this server/);
  assert.equal(app.calls.length, 0);
});

// ---------- detection display ----------
test("Live Active shows name, confidence % and position for each object, plus FPS and latency", async () => {
  const app = livePage();
  const stream = await startLive(app, async () => reply(200, liveBody([CUP_RIGHT, BOOK_LEFT])));
  assert.equal(app.$("liveState").textContent, "Live Active (Balanced)");
  await until(() => app.liveFetches().length >= 6, "6 frames");
  assert.deepEqual(overlayLabels(app).sort(), ["Book 97% · Middle left", "Cup 90% · Middle right"]);
  const rows = app.$("liveList").children.map((item) => item.children[0].children[0].children.map((c) => c.textContent).join(" | "));
  assert.deepEqual(rows.sort(), ["Book | 97% · Middle left", "Cup | 90% · Middle right"]);
  assert.match(app.$("liveMetrics").textContent, /^FPS \d+\.\d · Latency 1\d\d ms$/);
  assert.ok(Number(/FPS (\d+\.\d)/.exec(app.$("liveMetrics").textContent)[1]) > 1, "FPS measured");
  const first = app.liveFetches()[0];
  assert.match(first.url, /imgsz=512$/);
  assert.equal(first.opts.headers["Content-Type"], "image/jpeg");
  assert.ok(first.opts.body.size > 0, "a JPEG blob is the body");
  assert.equal(app.$("liveNone").hidden, true);
  const box = app.$("liveOverlay").children[0];
  assert.match(box.style.left, /%$/);
  stopLive(app);
  assert.ok(stream.ended(), "camera tracks stopped");
  assert.equal(app.$("liveOverlay").children.length, 0, "boxes cleared");
});

test("Korean UI: names, positions and status in Korean", async () => {
  const en = new El("button"), ko = new El("button");
  en.dataset.lang = "en"; ko.dataset.lang = "ko";
  const app = livePage({ lists: { ".lang-btn": [en, ko] } });
  await startLive(app, async () => reply(200, liveBody([CUP_RIGHT])));
  ko.click();
  assert.equal(app.$("liveState").textContent, "라이브 작동 중 (균형)");
  await until(() => overlayLabels(app)[0] === "컵 90% · 오른쪽 가운데", "Korean label");
  assert.match(app.$("liveMetrics").textContent, /지연/);
  stopLive(app);
});

test("a one-frame glitch does not make boxes blink and 'nothing detected' shows only when truly empty", async () => {
  const app = livePage();
  const seq = [[CUP_RIGHT], [CUP_RIGHT], [], [CUP_RIGHT], [CUP_RIGHT]];
  await startLive(app, async (n) => reply(200, liveBody(seq[n] || [CUP_RIGHT])));
  const seen = [];
  let last = 0;
  await until(() => {
    if (app.liveFetches().length !== last) { last = app.liveFetches().length; seen.push(overlayLabels(app).length); }
    return last >= 5;
  }, "5 frames");
  assert.deepEqual(seen.slice(1), [1, 1, 1, 1], "box stays through the empty frame");
  stopLive(app);
});

// ---------- stream interruption ----------
test("camera stream interruption: Live turns off with a message and the camera is released", async () => {
  const app = livePage();
  const stream = await startLive(app, async () => reply(200, liveBody([CUP_RIGHT])));
  await until(() => app.liveFetches().length >= 2);
  stream.videoTrack.onended();
  assert.equal(app.$("liveState").dataset.state, "off");
  assert.match(app.$("bannerText").textContent, /camera stream stopped/);
  assert.ok(stream.ended());
  assert.equal(app.$("liveVideo").srcObject, null);
  const sent = app.liveFetches().length;
  await flush(); await flush();
  assert.equal(app.liveFetches().length, sent, "no more frames after the stream ended");
});

test("tab hidden pauses sending and speech; visible resumes", async () => {
  const app = livePage();
  await startLive(app, async () => reply(200, liveBody([CUP_RIGHT])));
  await until(() => app.liveFetches().length >= 2);
  app.doc.hidden = true;
  app.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(app.$("liveState").textContent, "Live Paused (tab hidden)");
  assert.ok(app.speech.cancelled >= 1);
  await flush(); await flush();
  const frozen = app.liveFetches().length;
  const t0 = app.clock;
  await until(() => app.clock - t0 > 2000, "time passes while hidden");
  assert.equal(app.liveFetches().length, frozen, "nothing sent while hidden");
  app.doc.hidden = false;
  app.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(app.$("liveState").dataset.state, "active");
  await until(() => app.liveFetches().length > frozen, "resumed");
  stopLive(app);
});

test("camera granted while the tab is hidden starts paused, not sending", async () => {
  const app = livePage();
  route(app, async () => reply(200, liveBody([CUP_RIGHT])));
  await flush();
  app.$("liveVideo").videoWidth = 640; app.$("liveVideo").videoHeight = 480;
  app.$("liveToggle").click();
  app.doc.hidden = true;
  app.calls.at(-1).resolve(fakeStream());
  await until(() => app.$("liveState").dataset.state === "paused", "paused");
  const t0 = app.clock;
  await until(() => app.clock - t0 > 1500);
  assert.equal(app.liveFetches().length, 0);
  stopLive(app);
});

test("leaving the Live page stops the camera; opening the single-frame camera does too", async () => {
  const app = livePage();
  const s1 = await startLive(app, async () => reply(200, liveBody([])));
  app.ctx.location.hash = "#finder";
  app.win.dispatchEvent(new Event("hashchange"));
  assert.ok(s1.ended());
  assert.equal(app.$("liveState").dataset.state, "off");

  const app2 = livePage();
  const s2 = await startLive(app2, async () => reply(200, liveBody([])));
  app2.$("cameraBtn").click();
  assert.ok(s2.ended(), "one camera at a time");
  assert.equal(app2.$("liveState").dataset.state, "off");
});

test("Live stops by itself after 5 minutes", async () => {
  const app = livePage();
  const stream = await startLive(app, async () => reply(200, liveBody([])));
  app.clock += 5 * 60 * 1000 + 1;
  await until(() => app.$("liveState").dataset.state === "off", "auto stop");
  assert.match(app.$("bannerText").textContent, /after 5 minutes/);
  assert.ok(stream.ended());
});

// ---------- speed, dropped frames, server protection ----------
test("a still scene is mostly skipped (heartbeat only); movement is sent at once", async () => {
  const app = livePage();
  await startLive(app, async () => reply(200, liveBody([])), { still: true });
  await until(() => app.liveFetches().length >= 3, "3 heartbeat frames");
  const [a, b] = app.liveTimes;
  assert.ok(b - a >= 1500, `heartbeat gap ${b - a} ms`);
  assert.match(app.$("liveStats").textContent, /still skipped (\d+)/);
  const skipped = Number(/still skipped (\d+)/.exec(app.$("liveStats").textContent)[1]);
  assert.ok(skipped >= 10, `skipped ${skipped}`);
  const sent = app.liveFetches().length;
  app.canvas.frame.fill(230); // the picture changes
  await until(() => app.liveFetches().length > sent, "moved frame sent");
  stopLive(app);
});

test("server busy: frames are dropped, the loop waits for the retry hint and Auto steps down", async () => {
  const app = livePage();
  await startLive(app, async (n) => (n < 3
    ? reply(503, { error: { code: "busy", message: "busy", retry_ms: 1500 } })
    : reply(200, liveBody([CUP_RIGHT]))));
  await until(() => app.liveFetches().length >= 5, "5 attempts");
  for (let i = 1; i <= 2; i++) assert.ok(app.liveTimes[i] - app.liveTimes[i - 1] >= 1500, `gap after busy #${i}: ${app.liveTimes[i] - app.liveTimes[i - 1]}`);
  assert.match(app.$("liveStats").textContent, /server busy 3/);
  assert.equal(app.$("liveState").textContent, "Live Active (Low-Power)", "Auto stepped down after repeated busy");
  assert.equal(app.$("liveState").dataset.state, "active", "Live keeps running");
  assert.ok(overlayLabels(app).length >= 1, "detections resume once the server answers");
  stopLive(app);
});

test("HTTP 429 from a rate limit in front of the app is treated like busy, not as an error", async () => {
  const app = livePage();
  await startLive(app, async (n) => (n < 4 ? { ok: false, status: 429, json: async () => { throw new Error("html"); },
    headers: { get: () => "2" } } : reply(200, liveBody([CUP_RIGHT]))));
  await until(() => app.liveFetches().length >= 6, "6 attempts");
  assert.equal(app.$("liveState").dataset.state, "active", "Live keeps running after four 429s");
  assert.match(app.$("liveStats").textContent, /server busy 4/);
  assert.ok(app.liveTimes[1] - app.liveTimes[0] >= 2000, "waits for Retry-After");
  assert.equal(app.$("bannerText").textContent, "");
  stopLive(app);
});

test("Minimum confidence slider filters both boxes and the results list, and keeps the saved value", async () => {
  const weak = { class_name: "book", score: 0.40, bbox_xyxy: [10, 100, 80, 170] };
  const app = livePage();
  await startLive(app, async () => reply(200, liveBody([CUP_RIGHT, weak])));
  assert.equal(app.$("liveConfValue").textContent, "45%");
  await until(() => app.liveFetches().length >= 4);
  assert.deepEqual(overlayLabels(app), ["Cup 90% · Middle right"], "the 40 % book is not drawn at the default 45 %");
  const slider = app.$("liveConf");
  slider.value = "35";
  slider.dispatchEvent(new Event("input"));
  assert.equal(app.$("liveConfValue").textContent, "35%");
  assert.deepEqual(overlayLabels(app).sort(), ["Book 40% · Middle left", "Cup 90% · Middle right"]);
  assert.equal(app.$("liveList").children.length, 2);
  slider.value = "80";
  slider.dispatchEvent(new Event("input"));
  assert.deepEqual(overlayLabels(app), ["Cup 90% · Middle right"]);
  assert.equal(app.$("liveList").children.length, 1);
  slider.value = "95"; // out of range is clamped
  slider.dispatchEvent(new Event("input"));
  assert.equal(app.$("liveConfValue").textContent, "80%");
  stopLive(app);
  const again = livePage({ storage: { "findit.liveMinConf": JSON.stringify(0.6) } });
  await flush();
  assert.equal(again.$("liveConfValue").textContent, "60%");
});

test("boxes do not run ahead of an object that stopped moving (the still picture is skipped, the box is not extrapolated)", async () => {
  const app = livePage({ raf: true });
  route(app, async (n) => {
    const x1 = Math.min(200, 100 + 25 * n); // moves right 25 px per frame for 4 frames, then rests at 200
    // Picture of the NEXT capture: it changes while the object moves and for the first resting frame,
    // then stays identical, so the motion gate skips every frame after that single resting one.
    app.canvas.frame.fill(n < 3 ? (n % 2 ? 200 : 40) : 120);
    return reply(200, liveBody([{ class_name: "cup", score: 0.9, bbox_xyxy: [x1, 100, x1 + 70, 170] }]));
  }, { still: true });
  await flush();
  app.$("liveVideo").videoWidth = 640; app.$("liveVideo").videoHeight = 480;
  app.$("liveToggle").click();
  app.calls.at(-1).resolve(fakeStream());
  await until(() => app.$("liveState").dataset.state === "active");
  await until(() => app.liveFetches().length >= 5, "5 frames (4 moving + 1 resting)");
  // Measure between the single resting frame (the 5th) and the next heartbeat (1.5 s later), when only
  // the old speed could move the box.
  await until(() => app.clock >= app.liveTimes[4] + 800, "0.8 s after the resting frame");
  assert.equal(app.liveFetches().length, 5, "no frame was sent in between: the still picture was skipped");
  assert.match(app.$("liveStats").textContent, /still skipped [1-9]/);
  const left = parseFloat(app.$("liveOverlay").children[0].style.left); // percent of the 320 px frame
  assert.ok(Math.abs(left - (200 / 320) * 100) < 3, `box rests at the object (200 px = 62.5 %), drawn at ${left.toFixed(1)} %`);
  stopLive(app);
});

test("a pinned Fast mode stays Fast and asks the server for imgsz 416", async () => {
  const app = livePage({ storage: { "findit.liveMode": JSON.stringify("fast") } });
  await startLive(app, async () => reply(200, liveBody([])));
  await until(() => app.liveFetches().length >= 2);
  assert.equal(app.$("liveState").textContent, "Live Active (Fast)");
  assert.ok(app.liveFetches().every((f) => f.url.endsWith("imgsz=416")));
  stopLive(app);
});

test("repeated network failures stop Live with a message instead of retrying forever", async () => {
  const app = livePage();
  const stream = await startLive(app, async () => { throw new Error("offline"); });
  await until(() => app.$("liveState").dataset.state === "off", "stopped");
  assert.equal(app.liveFetches().length, 3);
  assert.match(app.$("bannerText").textContent, /Could not reach the server/);
  assert.ok(stream.ended());
});

test("Live refused by the server (disabled / model missing) stops Live at once", async () => {
  for (const [status, code, message] of [[404, "live_disabled", /switched off on this server/],
    [503, "model_unavailable", /not loaded on the server/]]) {
    const app = livePage();
    route(app, async () => reply(status, { error: { code } }));
    await flush();
    app.$("liveVideo").videoWidth = 640; app.$("liveVideo").videoHeight = 480;
    app.$("liveToggle").click();
    const stream = fakeStream();
    app.calls.at(-1).resolve(stream);
    await until(() => app.liveFetches().length === 1 && app.$("liveState").dataset.state === "off", code);
    assert.match(app.$("bannerText").textContent, message, code);
    assert.ok(stream.ended(), `${code}: camera released`);
  }
});

// ---------- voice ----------
test("Voice ON (EN): speaks 'NN% name on the side', once per cooldown, then again", async () => {
  const app = livePage();
  await startLive(app, async () => reply(200, liveBody([CUP_RIGHT, BOOK_LEFT])));
  assert.equal(app.$("voiceLabel").textContent, "Voice OFF (Muted)");
  await until(() => app.liveFetches().length >= 3);
  assert.deepEqual(app.speech.spoken, [], "muted by default: nothing spoken");
  app.$("voiceToggle").click();
  assert.equal(app.$("voiceLabel").textContent, "Voice ON (EN)");
  assert.equal(app.$("voiceToggle").attrs["aria-checked"], "true");
  await until(() => app.speech.spoken[0] === "Voice on.", "confirmation");
  await until(() => app.speech.spoken.length >= 2, "first announcement");
  assert.equal(app.speech.spoken[1], "97% book on the left, 90% cup on the right");
  assert.equal(app.speech.lastLang, "en-US");
  const t0 = app.clock;
  await until(() => app.clock - t0 > 6000, "6 s of frames");
  assert.equal(app.speech.spoken.length, 2, "the same objects are not repeated every frame");
  await until(() => app.speech.spoken.length >= 3, "announcement after the cooldown");
  assert.equal(app.speech.spoken[2], "97% book on the left, 90% cup on the right");
  stopLive(app);
});

test("Voice OFF (Muted): speech stops at once, boxes keep updating; unmute speaks again", async () => {
  const app = livePage();
  await startLive(app, async () => reply(200, liveBody([CUP_RIGHT])));
  app.$("voiceToggle").click();
  await until(() => app.speech.spoken.length >= 2);
  const cancelled = app.speech.cancelled;
  app.$("voiceToggle").click(); // mute
  assert.equal(app.$("voiceLabel").textContent, "Voice OFF (Muted)");
  assert.ok(app.speech.cancelled > cancelled, "current speech is cancelled");
  const spoken = app.speech.spoken.length, frames = app.liveFetches().length;
  const t0 = app.clock;
  await until(() => app.clock - t0 > 12_000, "12 s muted");
  assert.equal(app.speech.spoken.length, spoken, "nothing spoken while muted");
  assert.ok(app.liveFetches().length > frames + 5, "detection continues");
  assert.deepEqual(overlayLabels(app), ["Cup 90% · Middle right"], "still shown on screen");
  app.$("voiceToggle").click(); // unmute
  assert.equal(app.$("voiceLabel").textContent, "Voice ON (EN)");
  await until(() => app.speech.spoken.length > spoken + 1, "speaks again");
  assert.equal(app.speech.spoken.at(-1), "90% cup on the right");
  stopLive(app);
});

test("Switching the UI to Korean mid-live: voice follows the language", async () => {
  const en = new El("button"), ko = new El("button");
  en.dataset.lang = "en"; ko.dataset.lang = "ko";
  const app = livePage({ lists: { ".lang-btn": [en, ko] } });
  await startLive(app, async () => reply(200, liveBody([CUP_RIGHT, BOOK_LEFT])));
  app.$("voiceToggle").click();
  await until(() => app.speech.spoken.length >= 2);
  const cancelled = app.speech.cancelled;
  ko.click();
  assert.ok(app.speech.cancelled > cancelled, "old-language speech cancelled");
  assert.equal(app.$("voiceLabel").textContent, "음성 켜짐 (KO)");
  await until(() => app.speech.spoken.some((s) => s.includes("컵")), "Korean announcement");
  assert.equal(app.speech.spoken.at(-1), "왼쪽에 책 97%, 오른쪽에 컵 90%");
  assert.equal(app.speech.lastLang, "ko-KR");
  en.click();
  assert.equal(app.$("voiceLabel").textContent, "Voice ON (EN)");
  stopLive(app);
});

test("Voice Unavailable when the browser has no speech output; the picture still works", async () => {
  const app = livePage({ speech: false });
  await startLive(app, async () => reply(200, liveBody([CUP_RIGHT])));
  assert.equal(app.$("voiceLabel").textContent, "Voice Unavailable");
  assert.equal(app.$("voiceToggle").disabled, true);
  assert.equal(app.$("voiceWhy").hidden, false);
  assert.match(app.$("voiceWhy").textContent, /no speech output/);
  await until(() => overlayLabels(app).length === 1);
  assert.deepEqual(overlayLabels(app), ["Cup 90% · Middle right"]);
  stopLive(app);
});

test("Voice Unavailable when speech throws; Live keeps running", async () => {
  const app = livePage();
  app.speech.fail = true;
  await startLive(app, async () => reply(200, liveBody([CUP_RIGHT])));
  app.$("voiceToggle").click();
  await until(() => app.$("voiceLabel").textContent === "Voice Unavailable", "unavailable after the failed speak");
  assert.match(app.$("voiceWhy").textContent, /Speech output failed/);
  const frames = app.liveFetches().length;
  await until(() => app.liveFetches().length > frames + 3);
  assert.equal(app.$("liveState").dataset.state, "active");
  assert.deepEqual(overlayLabels(app), ["Cup 90% · Middle right"]);
  // clicking again retries once the browser works: voice comes back ON
  app.speech.fail = false;
  app.$("voiceToggle").click();
  assert.equal(app.$("voiceLabel").textContent, "Voice ON (EN)");
  await until(() => app.speech.spoken[0] === "Voice on.", "confirmation after retry");
  stopLive(app);
});

test("Voice keeps announcing after an utterance whose 'end' event never arrives (no permanent silence)", async () => {
  const app = livePage();
  app.speech.stuck = true; // starts, never ends
  await startLive(app, async () => reply(200, liveBody([CUP_RIGHT])));
  app.$("voiceToggle").click();
  await until(() => app.speech.spoken.length >= 1);
  const frames = app.liveFetches().length;
  await until(() => app.liveFetches().length > frames + 8);
  assert.equal(app.speech.spoken.length, 1, "while one is 'playing' nothing is stacked on top of it");
  // In a browser the failsafe timer frees it (this harness never runs timers of 3.5 s or more);
  // here the user presses the switch twice, which cancels and starts over:
  app.speech.stuck = false;
  app.$("voiceToggle").click(); app.$("voiceToggle").click();
  await until(() => app.speech.spoken.some((s) => s.includes("cup")), "announcement after recovery");
  stopLive(app);
});

test("the browser blocking sound (not-allowed) shows a hint and a click recovers", async () => {
  const app = livePage();
  app.speech.errorOnSpeak = "not-allowed";
  await startLive(app, async () => reply(200, liveBody([CUP_RIGHT])));
  app.$("voiceToggle").click();
  await until(() => app.$("voiceLabel").textContent === "Voice Unavailable");
  assert.match(app.$("voiceWhy").textContent, /blocked sound/);
  app.speech.errorOnSpeak = null;
  app.$("voiceTest").click(); // a user gesture on the test button retries
  await until(() => app.speech.spoken.includes("90% cup on the right"), "test sentence");
  assert.equal(app.$("voiceWhy").hidden, true);
  stopLive(app);
});

test("Test voice says a sample in the UI language even while muted; the voice note explains silence", async () => {
  const en = new El("button"), ko = new El("button");
  en.dataset.lang = "en"; ko.dataset.lang = "ko";
  const weak = { class_name: "book", score: 0.40, bbox_xyxy: [10, 100, 80, 170] };
  const app = livePage({ lists: { ".lang-btn": [en, ko] } });
  await startLive(app, async () => reply(200, liveBody([weak])));
  assert.equal(app.$("voiceLabel").textContent, "Voice OFF (Muted)");
  assert.equal(app.$("voiceNote").hidden, true, "no note while muted");
  app.$("voiceTest").click();
  await until(() => app.speech.spoken.length === 1);
  assert.equal(app.speech.spoken[0], "90% cup on the right");
  ko.click();
  app.$("voiceTest").click();
  await until(() => app.speech.spoken.length === 2);
  assert.equal(app.speech.spoken[1], "오른쪽에 컵 90%");
  assert.equal(app.speech.lastLang, "ko-KR");
  en.click();
  // voice on, but the only object is below the 45 % limit: say why nothing is heard
  app.$("voiceToggle").click();
  await until(() => app.liveFetches().length >= 3);
  assert.match(app.$("voiceNote").textContent, /no object is above 45%/);
  const slider = app.$("liveConf");
  slider.value = "35"; slider.dispatchEvent(new Event("input"));
  await until(() => /Last said/.test(app.$("voiceNote").textContent), "last said");
  assert.match(app.$("voiceNote").textContent, /40% book on the left/);
  stopLive(app);
});

test("Test voice uses the natural voice for the language (default English voice)", async () => {
  const app = livePage();
  app.speech.voices = [{ name: "Albert", lang: "en-US", localService: true }, { name: "Samantha", lang: "en-US", localService: true, default: true },
    { name: "Eddy (Korean (South Korea))", lang: "ko-KR", localService: true }, { name: "Yuna", lang: "ko-KR", localService: true }];
  await flush();
  app.$("voiceTest").click();
  await until(() => app.speech.spoken.length === 1);
  assert.equal(app.speech.voicesUsed[0], "Samantha");
});

test("Test voice and voice enable call speechSynthesis within the click", async () => {
  const app = livePage();
  await flush();
  const cancelled = app.speech.cancelled;
  app.$("voiceTest").click();
  assert.equal(app.speech.spoken[0], "90% cup on the right");
  app.$("voiceToggle").click();
  assert.equal(app.speech.spoken[1], "Voice on.");
  assert.equal(app.speech.cancelled, cancelled, "idle engine is not cancelled before speaking");
  app.$("voiceToggle").click();
  await flush();
  assert.equal(app.speech.spoken.length, 2, "no speech remains scheduled after mute");
});

test("Switching languages recovers from an error in the previous voice", async () => {
  const ko = new El("button");
  ko.dataset.lang = "ko";
  const app = livePage({ lists: { ".lang-btn": [ko] } });
  await startLive(app, async () => reply(200, liveBody([CUP_RIGHT])));
  await until(() => overlayLabels(app).length === 1);
  app.speech.errorOnSpeak = "voice-unavailable";
  app.$("voiceToggle").click();
  await until(() => app.$("voiceLabel").textContent === "Voice Unavailable");
  assert.doesNotMatch(app.$("voiceNote").textContent, /Last said/);
  app.speech.errorOnSpeak = null;
  ko.click();
  assert.equal(app.$("voiceLabel").textContent, "음성 켜짐 (KO)");
  assert.equal(app.speech.spoken.at(-1), "오른쪽에 컵 90%");
  assert.equal(app.speech.lastLang, "ko-KR");
  stopLive(app);
});

test("Voice Unavailable when no Korean voice is installed (Korean UI)", async () => {
  const en = new El("button"), ko = new El("button");
  en.dataset.lang = "en"; ko.dataset.lang = "ko";
  const app = livePage({ lists: { ".lang-btn": [en, ko] } });
  app.speech.voices = [{ lang: "en-US" }];
  await flush();
  ko.click();
  assert.equal(app.$("voiceLabel").textContent, "음성 사용 불가");
  assert.match(app.$("voiceWhy").textContent, /한국어 음성이 설치되어 있지 않습니다/);
  assert.equal(app.$("voiceToggle").disabled, true);
  en.click();
  assert.equal(app.$("voiceLabel").textContent, "Voice OFF (Muted)");
});

// ---------- upload / deep inspect states ----------
const PHONE = { id: 0, class_id: 67, class_name: "cell phone", score: 0.91, bbox_xyxy: [10, 20, 40, 80], area_px: 1800,
  area_fraction: 0.09, center: [25, 50], cell: { row: 0, col: 0 } };
const detectBody = { model: "m.pt", conf_threshold: 0.25,
  image: { width: 200, height: 100, raw_width: 200, raw_height: 100, exif_orientation: 1, format: "JPEG" },
  preview: { data_url: "data:image/jpeg;base64,AAAA", width: 200, height: 100 },
  detections: [PHONE], timing: { inference_ms: 12, server_ms: 15 } };

async function upload(app, file, answer) {
  app.respond = async (url) => (String(url).includes("/api/info") ? reply(200, INFO) : answer());
  const input = app.$("fileInput");
  input.files = [file];
  input.dispatchEvent(new Event("change"));
  await until(() => !app.$("stageLoading").hidden === false, "upload settled");
  await flush();
}

test("upload: results list shows %, position; Inspect shows Ready then Exported / Error states", async () => {
  const app = loadApp({ hash: "inspect" });
  await flush();
  assert.equal(app.$("exportStatus").textContent, "No result yet");
  await upload(app, { size: 1000, type: "image/jpeg" }, async () => reply(200, detectBody));
  const row = app.$("inspectList").children[0].children[0].children[0].children.map((c) => c.textContent);
  assert.deepEqual(row, ["Cell phone", "91% confidence · Top left"]);
  assert.equal(app.$("exportStatus").textContent, "Ready");
  assert.equal(app.$("exportStatus").dataset.state, "ready");

  app.$("downloadJson").click();
  assert.equal(app.$("exportStatus").textContent, "Exported — JSON file");
  assert.equal(app.$("exportStatus").dataset.state, "exported");

  app.$("copyJson").click(); // no clipboard in this environment -> Error
  await until(() => app.$("exportStatus").dataset.state === "error", "clipboard error");
  assert.equal(app.$("exportStatus").textContent, "Error — the clipboard is not available");

  app.canvas.blobFails = true;
  app.$("downloadImage").click();
  await until(() => /annotated image could not/.test(app.$("exportStatus").textContent), "image error");
  app.canvas.blobFails = false;
  app.$("downloadImage").click();
  await until(() => app.$("exportStatus").dataset.state === "exported", "image exported");
  assert.equal(app.$("exportStatus").textContent, "Exported — annotated image");

  // a new detection resets the export state to Ready
  await upload(app, { size: 1000, type: "image/jpeg" }, async () => reply(200, detectBody));
  assert.equal(app.$("exportStatus").dataset.state, "ready");
});

test("Finder 'Speak location' uses the shared speaker: natural voice, confidence, UI language, failure state", async () => {
  const app = loadApp();
  await flush();
  await upload(app, { size: 1000, type: "image/jpeg" }, async () => reply(200, detectBody));
  const pick = new Event("click");
  Object.defineProperty(pick, "target", { value: { closest: () => ({ dataset: { id: "0" } }) } });
  app.$("results").dispatchEvent(pick); // select the detection like a click on the list row
  app.$("speakBtn").click();
  assert.equal(app.speech.spoken.length, 1, "submitted synchronously on click");
  assert.equal(app.speech.spoken[0], "Cell phone, Top left, 91%.");
  assert.equal(app.speech.lastLang, "en-US");
  assert.equal(app.speech.voicesUsed[0], undefined, "(fake voices have no names; the speaker still goes through pickVoice)");
  app.speech.fail = true;
  app.$("speakBtn").click();
  await flush(); await flush();
  app.speech.fail = false;
  app.$("speakBtn").click(); // a click is a fresh try after a failure
  await until(() => app.speech.spoken.length === 2, "spoken again");
});

test("upload errors show the right message and never leave the UI stuck", async () => {
  const cases = [
    [415, "unsupported_format", /Only JPEG and PNG/],
    [415, "invalid_image", /not a readable image/],
    [413, "file_too_large", /too large/],
    [413, "image_dimensions", /outside the limits/],
    [503, "busy", /detector is busy/],
    [503, "model_unavailable", /not loaded on the server/],
    [500, "server_error", /Server error/],
  ];
  for (const [status, code, message] of cases) {
    const app = loadApp();
    await flush();
    await upload(app, { size: 1000, type: "image/jpeg" }, async () => reply(status, { error: { code, message: "x" } }));
    assert.match(app.$("bannerText").textContent, message, code);
    assert.equal(app.$("stageLoading").hidden, true, `${code}: spinner gone`);
    assert.equal(app.$("uploadBtn").disabled, false, `${code}: can retry`);
  }
});

test("upload: oversized and empty files are refused before any request; network loss is reported", async () => {
  const app = loadApp();
  await flush();
  const before = app.fetches.length;
  app.$("fileInput").files = [{ size: 11 * 1024 * 1024, type: "image/jpeg" }];
  app.$("fileInput").dispatchEvent(new Event("change"));
  assert.match(app.$("bannerText").textContent, /too large \(max 10 MiB\)/);
  app.$("fileInput").files = [{ size: 0, type: "image/jpeg" }];
  app.$("fileInput").dispatchEvent(new Event("change"));
  assert.match(app.$("bannerText").textContent, /file is empty/);
  assert.equal(app.fetches.length, before, "no request was made");
  await upload(app, { size: 1000, type: "image/jpeg" }, async () => { throw new Error("offline"); });
  assert.match(app.$("bannerText").textContent, /Could not reach the server/);
  assert.equal(app.$("uploadBtn").disabled, false);
});

test("EN/KO switch: starts from the browser language, marks the active language, switches every Live text", async () => {
  const mk = () => { const en = new El("button"), ko = new El("button"); en.dataset.lang = "en"; ko.dataset.lang = "ko"; return [en, ko]; };
  const [sideEn, sideKo] = mk(), [liveEn, liveKo] = mk();
  const app = livePage({ language: "ko-KR", lists: { ".lang-btn": [sideEn, sideKo, liveEn, liveKo] } });
  await flush();
  assert.equal(app.$("liveState").textContent, "라이브 꺼짐", "Korean browser -> Korean UI");
  assert.deepEqual([sideEn, sideKo, liveEn, liveKo].map((b) => b.attrs["aria-pressed"]), ["false", "true", "false", "true"]);
  liveEn.click(); // the switch inside the Live panel works too
  assert.equal(app.$("liveState").textContent, "Live Off");
  assert.equal(app.$("liveToggle").textContent, "Start live");
  assert.equal(app.$("voiceLabel").textContent, "Voice OFF (Muted)");
  assert.deepEqual([sideEn, sideKo, liveEn, liveKo].map((b) => b.attrs["aria-pressed"]), ["true", "false", "true", "false"], "both switches show EN");
  assert.equal(app.doc.documentElement.lang, "en");
  sideKo.click();
  assert.equal(app.$("liveState").textContent, "라이브 꺼짐");
  assert.equal(app.$("voiceLabel").textContent, "음성 꺼짐 (음소거)");
  assert.equal(app.doc.documentElement.lang, "ko");
});
