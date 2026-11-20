// Unit tests for findit/web/voice.js (phrases, cooldown, speaker failure states). No browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const V = createRequire(import.meta.url)("../../findit/web/voice.js");
const trk = (cls, score, row, col, misses = 0) => ({ class_name: cls, score, cell: { row, col }, misses });

test("English sentence matches the required style", () => {
  const s = V.sentence("en", [
    { name: "cup", score: 0.9, cell: { row: 1, col: 2 } },
    { name: "book", score: 0.97, cell: { row: 1, col: 0 } },
  ]);
  assert.equal(s, "90% cup on the right, 97% book on the left");
});

test("Korean sentence matches the required style", () => {
  const s = V.sentence("ko", [
    { name: "컵", score: 0.9, cell: { row: 1, col: 2 } },
    { name: "책", score: 0.97, cell: { row: 1, col: 0 } },
  ]);
  assert.equal(s, "오른쪽에 컵 90%, 왼쪽에 책 97%");
});

test("spoken zone: left/right first, then top/bottom, else center", () => {
  assert.equal(V.zoneOf({ row: 0, col: 0 }), "left");
  assert.equal(V.zoneOf({ row: 2, col: 2 }), "right");
  assert.equal(V.zoneOf({ row: 0, col: 1 }), "top");
  assert.equal(V.zoneOf({ row: 2, col: 1 }), "bottom");
  assert.equal(V.zoneOf({ row: 1, col: 1 }), "center");
  assert.equal(V.sentence("en", [{ name: "vase", score: 0.5, cell: { row: 2, col: 1 } }]), "50% vase at the bottom");
  assert.equal(V.sentence("ko", [{ name: "화분", score: 0.5, cell: { row: 1, col: 1 } }]), "가운데 화분 50%");
});

test("percent rounds the score", () => {
  assert.equal(V.percent(0.896), 90);
  assert.equal(V.percent(0.994), 99);
});

test("cooldown: the same object is not repeated every frame, but is after the cooldown", () => {
  const a = V.createAnnouncer({ cooldownMs: 8000, classGapMs: 3000 });
  const tracks = [trk("cup", 0.9, 1, 2)];
  let said = a.pick(tracks, 0);
  assert.equal(said.length, 1);
  a.mark(said, 0);
  for (let t = 300; t < 8000; t += 300) assert.equal(a.pick(tracks, t).length, 0, `silent at ${t} ms`);
  assert.equal(a.pick(tracks, 8000).length, 1, "said again after the cooldown");
});

test("a new object is announced at once even while another is in cooldown", () => {
  const a = V.createAnnouncer();
  a.mark(a.pick([trk("cup", 0.9, 1, 2)], 0), 0);
  const said = a.pick([trk("cup", 0.9, 1, 2), trk("book", 0.8, 1, 0)], 400);
  assert.deepEqual(said.map((t) => t.class_name), ["book"]);
});

test("same class moving to another zone is not repeated within the class gap", () => {
  const a = V.createAnnouncer({ classGapMs: 3000 });
  a.mark(a.pick([trk("cup", 0.9, 1, 0)], 0), 0);
  assert.equal(a.pick([trk("cup", 0.9, 1, 1)], 1000).length, 0);
  assert.equal(a.pick([trk("cup", 0.9, 1, 1)], 3100).length, 1);
});

test("at most three items per sentence; objects not seen in the latest frame are skipped", () => {
  const a = V.createAnnouncer({ maxItems: 3 });
  const many = ["cup", "book", "cell phone", "vase", "bottle"].map((c, i) => trk(c, 0.9 - i * 0.1, 1, i % 3));
  assert.equal(a.pick(many, 0).length, 3);
  assert.equal(a.pick([trk("cup", 0.9, 1, 2, 2)], 0).length, 0, "stale track (misses>0) is not spoken");
});

test("reset forgets the cooldowns (used when the language changes)", () => {
  const a = V.createAnnouncer();
  const tracks = [trk("cup", 0.9, 1, 2)];
  a.mark(a.pick(tracks, 0), 0);
  a.reset();
  assert.equal(a.pick(tracks, 100).length, 1);
});

// ---------- speaker ----------
class FakeUtterance { constructor(text) { this.text = text; } }
function fakeSynth(voices = [{ lang: "en-US" }, { lang: "ko-KR" }]) {
  const s = { spoken: [], cancelled: 0, speaking: false, pending: false, throwOnSpeak: false,
    getVoices: () => voices,
    speak(u) { if (s.throwOnSpeak) throw new Error("boom"); s.spoken.push(u); },
    cancel() { s.cancelled++; } };
  return s;
}
function timers() {
  const q = [];
  return { setTimeout: (fn) => { q.push(fn); return q.length; }, clearTimeout: (id) => { q[id - 1] = null; },
    fire: () => q.splice(0).forEach((f) => f && f()) };
}

test("speaker speaks in the requested language and picks that voice", () => {
  const synth = fakeSynth();
  const sp = V.createSpeaker(synth, FakeUtterance, { ...timers() });
  assert.equal(sp.speak("오른쪽에 컵 90%", "ko"), true);
  assert.equal(synth.spoken[0].lang, "ko-KR");
  assert.equal(synth.spoken[0].voice.lang, "ko-KR");
  sp.speak("90% cup on the right", "en");
  assert.equal(synth.spoken[1].lang, "en-US");
  assert.equal(sp.availability("ko"), "ok");
});

test("no speechSynthesis at all -> unsupported, speak() does nothing", () => {
  const sp = V.createSpeaker(undefined, undefined, { ...timers() });
  assert.equal(sp.availability("en"), "unsupported");
  assert.equal(sp.speak("x", "en"), false);
  sp.cancel(); // must not throw
});

test("no installed voice for the language -> no_voice; an empty voice list is not a failure", () => {
  assert.equal(V.createSpeaker(fakeSynth([{ lang: "en-US" }]), FakeUtterance, { ...timers() }).availability("ko"), "no_voice");
  assert.equal(V.createSpeaker(fakeSynth([]), FakeUtterance, { ...timers() }).availability("ko"), "ok");
});

test("an utterance error switches to error until reset; cancel-type errors do not", () => {
  const synth = fakeSynth(), t = timers();
  let changes = 0;
  const sp = V.createSpeaker(synth, FakeUtterance, { ...t, onChange: () => changes++ });
  sp.speak("a", "en");
  synth.spoken[0].onerror({ error: "interrupted" });
  assert.equal(sp.availability("en"), "ok");
  sp.speak("b", "en");
  synth.spoken[1].onerror({ error: "synthesis-failed" });
  assert.equal(sp.availability("en"), "error");
  assert.equal(changes, 1);
  assert.equal(sp.speak("c", "en"), false);
  sp.resetError();
  assert.equal(sp.availability("en"), "ok");
});

test("speak() throwing is caught and reported as error", () => {
  const synth = fakeSynth();
  synth.throwOnSpeak = true;
  const sp = V.createSpeaker(synth, FakeUtterance, { ...timers() });
  assert.equal(sp.speak("a", "en"), false);
  assert.equal(sp.availability("en"), "error");
});

test("one slow start is tolerated; two utterances in a row that never start are an error", () => {
  const synth = fakeSynth(), t = timers();
  const sp = V.createSpeaker(synth, FakeUtterance, { ...t });
  sp.speak("a", "en");
  synth.spoken[0].onstart();
  synth.spoken[0].onend();
  t.fire();
  assert.equal(sp.availability("en"), "ok");
  sp.speak("b", "en");
  t.fire(); // no start event within the time limit: tolerated once (a voice may be loading)
  assert.equal(sp.availability("en"), "ok");
  assert.equal(sp.speaking, false, "the stuck utterance is given up");
  sp.speak("c", "en");
  t.fire();
  assert.equal(sp.availability("en"), "error", "second silent failure in a row");
  assert.equal(sp.lastError, "no-start");
});

test("a start in between resets the silent-failure count", () => {
  const synth = fakeSynth(), t = timers();
  const sp = V.createSpeaker(synth, FakeUtterance, { ...t });
  sp.speak("a", "en"); t.fire();
  sp.speak("b", "en"); synth.spoken[1].onstart(); synth.spoken[1].onend();
  sp.speak("c", "en"); t.fire();
  assert.equal(sp.availability("en"), "ok");
});

test("the playback watchdog waits for start even for a short confirmation", () => {
  const synth = fakeSynth();
  const delays = [];
  const sp = V.createSpeaker(synth, FakeUtterance, {
    setTimeout(_fn, ms) { delays.push(ms); return delays.length; }, clearTimeout() {},
  });
  sp.speak("Voice on.", "en");
  assert.deepEqual(delays, [6000], "only the start timeout is scheduled");
  synth.spoken[0].onstart();
  assert.deepEqual(delays, [6000, 4800], "playback timeout starts with the utterance");
});

test("speaking is our own state: it ends with 'end', and a lost 'end' cannot silence speech for ever", () => {
  const synth = fakeSynth(), t = timers();
  const sp = V.createSpeaker(synth, FakeUtterance, { ...t });
  assert.equal(sp.speaking, false);
  synth.speaking = true; // the engine's flag alone does not count
  assert.equal(sp.speaking, false);
  sp.speak("hello", "en");
  assert.equal(sp.speaking, true);
  synth.spoken[0].onstart();
  synth.spoken[0].onend();
  assert.equal(sp.speaking, false);
  sp.speak("lost end", "en");
  synth.spoken[1].onstart(); // ... and no 'end' ever arrives
  assert.equal(sp.speaking, true);
  const cancels = synth.cancelled;
  t.fire(); // failsafe
  assert.equal(sp.speaking, false);
  assert.ok(synth.cancelled > cancels, "the stuck engine is cancelled");
  assert.equal(sp.availability("en"), "ok", "and it is not an error");
});

test("an old utterance's late events do not disturb the current one", () => {
  const synth = fakeSynth(), t = timers();
  const sp = V.createSpeaker(synth, FakeUtterance, { ...t });
  const started = [];
  sp.speak("first", "en", () => started.push("first"));
  sp.speak("second", "ko", () => started.push("second"));
  assert.equal(synth.cancelled, 1, "replacing speech cancels the old utterance");
  assert.deepEqual(started, [], "queuing does not count as starting");
  synth.spoken[0].onstart();
  synth.spoken[0].onend();
  assert.equal(sp.speaking, true, "second is still playing");
  synth.spoken[0].onerror({ error: "voice-unavailable" });
  assert.equal(sp.availability("en"), "ok");
  synth.spoken[1].onstart();
  assert.deepEqual(started, ["second"]);
});

test("not-allowed is reported with its reason (the UI asks for a click)", () => {
  const synth = fakeSynth();
  const sp = V.createSpeaker(synth, FakeUtterance, { ...timers() });
  sp.speak("x", "en");
  synth.spoken[0].onerror({ error: "not-allowed" });
  assert.equal(sp.availability("en"), "error");
  assert.equal(sp.lastError, "not-allowed");
  sp.resetError();
  assert.equal(sp.availability("en"), "ok");
});

test("a paused engine is resumed before speaking", () => {
  const synth = fakeSynth();
  synth.paused = true; synth.resume = () => { synth.paused = false; synth.resumed = (synth.resumed || 0) + 1; };
  const sp = V.createSpeaker(synth, FakeUtterance, { ...timers() });
  sp.speak("x", "en");
  assert.equal(synth.resumed, 1);
});

test("voice choice: default/local/natural voices win, novelty and network voices lose", () => {
  const koList = [
    { name: "Eddy (Korean (South Korea))", lang: "ko-KR", localService: true }, { name: "Flo (Korean (South Korea))", lang: "ko-KR", localService: true },
    { name: "Grandma (Korean (South Korea))", lang: "ko-KR", localService: true },
    { name: "Yuna", lang: "ko-KR", localService: true }, { name: "Google 한국의", lang: "ko-KR", localService: false },
  ];
  assert.equal(V.pickVoice(koList, "ko").name, "Yuna", "not simply the first Korean voice");
  const enList = [{ name: "Albert", lang: "en-US", localService: true }, { name: "Bells", lang: "en-US", localService: true },
    { name: "Samantha", lang: "en-US", localService: true, default: true }, { name: "Daniel", lang: "en-GB", localService: true }];
  assert.equal(V.pickVoice(enList, "en").name, "Samantha");
  assert.equal(V.pickVoice([{ name: "Albert", lang: "en-US", localService: true }, { name: "Bells", lang: "en-US", localService: true }], "en").name, "Albert", "still speaks when only novelty voices exist");
  assert.equal(V.pickVoice([{ name: "x", lang: "ko_KR" }], "ko").name, "x", "ko_KR (underscore) matches");
  assert.equal(V.pickVoice(enList, "ko"), null);
  const sp = V.createSpeaker({ speak() {}, getVoices: () => koList }, FakeUtterance, { ...timers() });
  assert.equal(sp.voiceName("ko"), "Yuna");
  assert.equal(sp.availability("ko"), "ok");
});
