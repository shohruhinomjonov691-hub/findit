"use strict";
// Spoken output for live detection (no DOM access, unit-tested in Node):
//  - sentence():     "90% cup on the right, 97% book on the left" / "오른쪽에 컵 90%, 왼쪽에 책 97%"
//  - createAnnouncer(): decides what is worth saying now (per-object cooldown, at most a few items)
//  - createSpeaker():   wraps speechSynthesis and reports when it is unsupported or fails
(function (root) {
  const PHRASES = {
    en: { left: "on the left", right: "on the right", top: "at the top", bottom: "at the bottom", center: "in the center" },
    ko: { left: "왼쪽에", right: "오른쪽에", top: "위쪽에", bottom: "아래쪽에", center: "가운데" },
  };
  const LANG_TAG = { en: "en-US", ko: "ko-KR" };

  // Short spoken position from the 3x3 cell: left/right wins, then top/bottom, else center.
  function zoneOf(cell) {
    if (cell.col === 0) return "left";
    if (cell.col === 2) return "right";
    if (cell.row === 0) return "top";
    if (cell.row === 2) return "bottom";
    return "center";
  }

  const percent = (score) => Math.round(score * 100);

  // items: [{ name, score, cell }] with `name` already in the UI language.
  function sentence(lang, items) {
    const words = PHRASES[lang] || PHRASES.en;
    return items.map((it) => {
      const loc = words[zoneOf(it.cell)];
      return lang === "ko" ? `${loc} ${it.name} ${percent(it.score)}%` : `${percent(it.score)}% ${it.name} ${loc}`;
    }).join(", ");
  }

  // The same object is not repeated before `cooldownMs` has passed (key: class + spoken position),
  // and the same class is not repeated within `classGapMs` even if it moved to another zone.
  function createAnnouncer(options) {
    const o = Object.assign({ cooldownMs: 8000, classGapMs: 3000, maxItems: 2 }, options);
    const byKey = new Map(), byClass = new Map();
    const keyOf = (t) => `${t.class_name}|${zoneOf(t.cell)}`;
    return {
      // tracks: steadied detections (live.js tracker output), best score first. Only objects seen
      // in the latest frame are considered.
      pick(tracks, now) {
        const out = [], keys = new Set();
        for (const t of tracks) {
          if (t.misses > 0) continue;
          const key = keyOf(t);
          if (keys.has(key)) continue;
          if (now - (byKey.get(key) ?? -Infinity) < o.cooldownMs) continue;
          if (now - (byClass.get(t.class_name) ?? -Infinity) < o.classGapMs) continue;
          keys.add(key);
          out.push(t);
          if (out.length >= o.maxItems) break;
        }
        return out;
      },
      mark(items, now) {
        for (const t of items) { byKey.set(keyOf(t), now); byClass.set(t.class_name, now); }
      },
      reset() { byKey.clear(); byClass.clear(); },
    };
  }

  // Voice choice: the browser's default voice for the language, a local (installed) voice, an
  // exact language tag (en-US / ko-KR) and well-known natural voices score higher; macOS novelty
  // voices (Albert, Bells, Zarvox, ...) are avoided. The first voice in the list is NOT used blindly:
  // for Korean that is often a novelty or a network voice.
  const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Fred|Good News|Jester|Junior|Kathy|Organ|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;
  const NATURAL = /^(Samantha|Yuna|Alex|Karen|Daniel|Heami|Zira|David)\b/i;
  const voiceTag = (v) => String(v.lang).replace("_", "-").toLowerCase();
  function pickVoice(voices, lang) {
    const tag = (LANG_TAG[lang] || LANG_TAG.en).toLowerCase();
    const candidates = voices.filter((v) => voiceTag(v).split("-")[0] === lang);
    if (!candidates.length) return null;
    const score = (v) => (v.default ? 4 : 0) + (v.localService ? 3 : 0) + (voiceTag(v) === tag ? 2 : 0)
      + (NATURAL.test(v.name || "") ? 3 : 0) - (NOVELTY.test(v.name || "") ? 6 : 0);
    return candidates.reduce((best, v) => (score(v) > score(best) ? v : best));
  }

  // availability(): "ok" | "unsupported" | "no_voice" | "error".
  //  - "error" after an utterance error other than our own cancel, a speak() that throws, or two
  //    utterances in a row that never started; it lasts until resetError() (the user clicks again).
  //  - speaking is our own state, not synth.speaking: a browser that never delivers "end" would
  //    otherwise keep it true for ever and silence everything after it. A failsafe timer ends it.
  //  - the utterance is kept referenced while it plays (browsers may drop events of a collected one).
  function createSpeaker(synth, Utterance, hooks) {
    const h = Object.assign({
      setTimeout: (fn, ms) => root.setTimeout(fn, ms), clearTimeout: (id) => root.clearTimeout(id),
      startTimeoutMs: 6000, onChange() {},
    }, hooks);
    let failed = false, reason = "", noStart = 0;
    let current = null, startTimer = null, failsafe = null;
    const supported = () => !!synth && typeof Utterance === "function" && typeof synth.speak === "function";
    const voices = () => { try { return (synth.getVoices && synth.getVoices()) || []; } catch { return []; } };
    const clearTimers = () => {
      if (startTimer !== null) { h.clearTimeout(startTimer); startTimer = null; }
      if (failsafe !== null) { h.clearTimeout(failsafe); failsafe = null; }
    };
    function finish() { current = null; clearTimers(); }
    function fail(why) { if (!failed) { failed = true; reason = why || "error"; h.onChange(); } }
    function engineCancel() { try { if (synth && synth.cancel) synth.cancel(); } catch { /* nothing to cancel */ } }

    return {
      availability(lang) {
        if (!supported()) return "unsupported";
        if (failed) return "error";
        // An empty list may only mean the voices have not loaded yet; that is not a failure.
        const available = voices();
        if (available.length && !pickVoice(available, lang)) return "no_voice";
        return "ok";
      },
      get speaking() { return current !== null; },
      get lastError() { return reason; },
      resetError() { failed = false; reason = ""; noStart = 0; },
      voiceName(lang) { const v = supported() ? pickVoice(voices(), lang) : null; return v ? v.name : ""; },
      speak(text, lang, onStart) {
        if (!supported() || failed) return false;
        try {
          if (current !== null) { finish(); engineCancel(); }
          if (synth.paused && synth.resume) synth.resume(); // a paused engine would swallow it
          const u = new Utterance(text);
          u.lang = LANG_TAG[lang] || LANG_TAG.en;
          u.rate = 1.1; // a little faster: a long sentence about a scene that has moved on is useless
          const v = pickVoice(voices(), lang);
          if (v) u.voice = v;
          current = u;
          u.onstart = () => {
            if (current !== u) return;
            noStart = 0;
            if (startTimer !== null) { h.clearTimeout(startTimer); startTimer = null; }
            failsafe = h.setTimeout(() => { if (current === u) { finish(); engineCancel(); } }, 3000 + text.length * 200);
            if (onStart) onStart();
          };
          u.onend = () => { if (current === u) finish(); };
          u.onerror = (e) => {
            if (current !== u) return;
            finish();
            // Cancelling our own speech is normal, not a failure.
            if (!e || (e.error !== "interrupted" && e.error !== "canceled")) fail(e && e.error);
          };
          // One slow start (a voice loading for the first time) is tolerated; two in a row are not.
          startTimer = h.setTimeout(() => {
            if (current !== u) return;
            finish(); engineCancel();
            if (++noStart >= 2) fail("no-start");
          }, h.startTimeoutMs);
          synth.speak(u);
          return !failed;
        } catch {
          finish();
          fail("throw");
          return false;
        }
      },
      cancel() { finish(); engineCancel(); },
    };
  }

  const api = { PHRASES, zoneOf, sentence, createAnnouncer, createSpeaker, pickVoice, percent };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FindItVoice = api;
})(typeof window !== "undefined" ? window : globalThis);
