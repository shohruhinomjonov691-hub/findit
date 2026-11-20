"use strict";
// Live camera helpers with no DOM access (unit-tested in Node):
//  - tracker:  steadies per-frame detections (matching, smoothing, appear/disappear delay)
//  - governor: picks the speed profile (Auto steps down when the server is slow or busy)
//  - motion:   skips frames of a static scene so the server is not asked for nothing
//  - meter:    FPS and latency for the status line
(function (root) {
  // frame = longest side of the JPEG that is sent; imgsz = model input size (the server only
  // accepts the sizes listed in /api/info); minIntervalMs = shortest time between two frames.
  // Measured on 20 photos against a 1280x960 reference: 320 px / JPEG 0.6 found 62 % of the
  // reference objects, 512 px / JPEG 0.85 found 78 %, so frames are no smaller than 416 px and
  // the JPEG quality is high (a frame is still only ~15-35 KiB). Low-Power keeps the accuracy and
  // saves server time by sending fewer frames.
  const PROFILES = {
    fast: { name: "fast", frame: 416, imgsz: 416, quality: 0.8, minIntervalMs: 200 },
    balanced: { name: "balanced", frame: 512, imgsz: 512, quality: 0.85, minIntervalMs: 350 },
    low: { name: "low", frame: 512, imgsz: 512, quality: 0.85, minIntervalMs: 1000 },
  };
  const DEFAULT_MIN_CONF = 0.45;
  const ORDER = ["fast", "balanced", "low"];

  function iou(a, b) {
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (w <= 0 || h <= 0) return 0;
    const inter = w * h;
    const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return union > 0 ? inter / union : 0;
  }

  // Same 3x3 cell rule as the server (findit/app.py grid_cell).
  function gridCell(cx, cy, w, h) {
    return { row: Math.min(2, Math.floor((3 * cy) / h)), col: Math.min(2, Math.floor((3 * cx) / w)) };
  }

  // ---------- tracker ----------
  // Boxes follow the detections closely while the object moves (a heavy smoothing would
  // make them trail behind) and are smoothed only against jitter when it is still. Each track
  // also carries its speed so the box can be moved forward by the time the answer took:
  // projectBox() puts it where the object is at the moment it is drawn.
  // Detections of consecutive frames are matched by overlap. A track shows up after `minHits`
  // frames (or at once for a confident detection), moves smoothly, keeps its label unless
  // another class wins over several frames, and disappears only after `maxMisses` empty frames.
  function createTracker(options) {
    const o = Object.assign({
      alphaMin: 0.45, alphaMax: 0.95, scoreAlpha: 0.5, voteDecay: 0.8, minHits: 2, instantScore: 0.75,
      maxMisses: 2, maxAgeMs: 2500, sameClassIou: 0.3, otherClassIou: 0.6,
    }, options);
    let tracks = [];
    let nextId = 1;
    let size = null;

    // The label is the class with the largest decayed vote total, so one odd frame cannot
    // change it but a lasting change wins after a few frames; the score is that class's
    // smoothed confidence.
    const best = (t) => {
      let cls = null, vote = -1;
      for (const [c, v] of Object.entries(t.votes)) if (v > vote) { cls = c; vote = v; }
      return { cls, score: t.scores[cls] };
    };

    function visible() {
      if (!size) return [];
      const out = [];
      for (const t of tracks) {
        const { cls, score } = best(t);
        if (t.hits < o.minHits && score < o.instantScore) continue;
        const cx = (t.box[0] + t.box[2]) / 2, cy = (t.box[1] + t.box[3]) / 2;
        out.push({
          id: t.id, class_name: cls, score, box: t.box.slice(), vel: t.vel.slice(), stamp: t.stamp,
          hits: t.hits, misses: t.misses, cell: gridCell(cx, cy, size.w, size.h),
        });
      }
      return out.sort((a, b) => b.score - a.score);
    }

    return {
      reset() { tracks = []; size = null; },
      // The picture is still (the motion gate skips frames): nothing is moving, so every speed is
      // dropped. Without this the last measured speed would keep pushing the boxes ahead of
      // objects that have stopped, until the next heartbeat frame corrects them.
      settle() { for (const t of tracks) t.vel = [0, 0, 0, 0]; },
      get count() { return tracks.length; },
      // detections: [{ class_name, score, bbox_xyxy }], frame: { w, h }, now: ms (when the
      // answer arrived), capturedAt: ms (when the frame was taken; defaults to `now`)
      update(detections, frame, now, capturedAt) {
        const stamp = capturedAt === undefined ? now : capturedAt;
        if (!size || size.w !== frame.w || size.h !== frame.h) { tracks = []; size = { w: frame.w, h: frame.h }; }
        const pairs = [];
        tracks.forEach((t, ti) => detections.forEach((d, di) => {
          const same = d.class_name === best(t).cls;
          const v = iou(t.box, d.bbox_xyxy);
          if (v >= (same ? o.sameClassIou : o.otherClassIou)) pairs.push({ ti, di, v: v + (same ? 0.001 : 0), iou: v });
        }));
        pairs.sort((a, b) => b.v - a.v);
        const usedT = new Set(), usedD = new Set();
        for (const { ti, di, iou: overlap } of pairs) {
          if (usedT.has(ti) || usedD.has(di)) continue;
          usedT.add(ti); usedD.add(di);
          const t = tracks[ti], d = detections[di];
          // little overlap with the old box = the object moved: follow (almost) fully
          const alpha = Math.min(o.alphaMax, o.alphaMin + (1 - overlap) * 1.5);
          const dt = Math.max(1, stamp - t.stamp);
          for (let k = 0; k < 4; k++) {
            const before = t.box[k];
            t.box[k] += (d.bbox_xyxy[k] - t.box[k]) * alpha;
            t.vel[k] = t.vel[k] * 0.5 + ((t.box[k] - before) / dt) * 0.5;
          }
          t.stamp = stamp;
          for (const c of Object.keys(t.votes)) t.votes[c] *= o.voteDecay;
          t.votes[d.class_name] = (t.votes[d.class_name] || 0) + d.score;
          const prev = t.scores[d.class_name];
          t.scores[d.class_name] = prev === undefined ? d.score : prev + (d.score - prev) * o.scoreAlpha;
          t.hits++; t.misses = 0; t.lastSeen = now;
        }
        tracks.forEach((t, ti) => { if (!usedT.has(ti)) t.misses++; });
        detections.forEach((d, di) => {
          if (usedD.has(di)) return;
          tracks.push({
            id: nextId++, box: d.bbox_xyxy.slice(), vel: [0, 0, 0, 0], stamp,
            votes: { [d.class_name]: d.score }, scores: { [d.class_name]: d.score },
            hits: 1, misses: 0, lastSeen: now,
          });
        });
        tracks = tracks.filter((t) => t.misses <= o.maxMisses && now - t.lastSeen <= o.maxAgeMs);
        return visible();
      },
    };
  }

  // Where a track's box is at `atMs`: its last position moved on at its measured speed, at most
  // PROJECT_MAX_MS ahead (about one answer's age: a longer wait, e.g. a busy server, must not park
  // the box ahead of the object) and never by more than a third of the box. Still boxes do not move.
  const PROJECT_MAX_MS = 400;
  function projectBox(track, atMs) {
    const lead = Math.min(PROJECT_MAX_MS, Math.max(0, atMs - track.stamp));
    if (!lead || track.misses > 0) return track.box.slice();
    const limit = Math.max(track.box[2] - track.box[0], track.box[3] - track.box[1]) / 3;
    return track.box.map((v, k) => v + Math.max(-limit, Math.min(limit, track.vel[k] * lead)));
  }

  // The tracks handed out by update() are copies: a still picture also has to stop the ones that are
  // being drawn (tracker.settle() only reaches the tracker's own state).
  function settleTracks(tracks) { for (const t of tracks) t.vel = [0, 0, 0, 0]; }

  // What is worth drawing: confidence at least `minConf`, and a box that covers more than half
  // of the frame (a table, a person filling the view) only when the model is quite sure. On the 20
  // test photos this halved the wrong boxes (0.85 -> 0.40 per image) for a recall of 0.73 vs 0.78.
  function filterTracks(tracks, frame, minConf) {
    const min = minConf === undefined ? DEFAULT_MIN_CONF : minConf;
    const frameArea = frame.w * frame.h;
    return tracks.filter((t) => {
      if (t.score < min) return false;
      const share = ((t.box[2] - t.box[0]) * (t.box[3] - t.box[1])) / frameArea;
      return share <= 0.5 || t.score >= Math.max(min, 0.7);
    });
  }

  // ---------- governor ----------
  // mode: "auto" | "fast" | "balanced" | "low". Auto starts balanced, steps down on slow answers
  // or repeated "busy", and steps up only after a long run of quick answers.
  function createGovernor(mode) {
    const g = { mode: mode || "auto", level: 1, ema: null, good: 0, busy: 0, changedAt: -Infinity, warm: false };
    const pinned = () => ORDER.indexOf(g.mode);
    const api = {
      get mode() { return g.mode; },
      get latency() { return g.ema; },
      setMode(m) { g.mode = ORDER.includes(m) ? m : "auto"; g.good = g.busy = 0; g.warm = false; g.ema = null; if (pinned() >= 0) g.level = pinned(); },
      profile() { return PROFILES[ORDER[pinned() >= 0 ? pinned() : g.level]]; },
      // outcome: { ok, busy, latencyMs }, now: ms
      record(outcome, now) {
        // The first answer of a session is not counted: the server's first inference (model
        // warm-up) is much slower than the following ones and says nothing about its speed.
        if (outcome.ok && !g.warm) { g.warm = true; return; }
        if (outcome.ok) {
          g.ema = g.ema === null ? outcome.latencyMs : g.ema + (outcome.latencyMs - g.ema) * 0.3;
          g.busy = 0;
        } else if (outcome.busy) {
          g.busy++; g.good = 0;
        }
        if (pinned() >= 0 || now - g.changedAt < 3000) return;
        const slow = outcome.ok && g.ema > 650;
        if ((slow || g.busy >= 2) && g.level < ORDER.length - 1) {
          g.level++; g.changedAt = now; g.good = 0; g.busy = 0;
        } else if (outcome.ok && g.ema < 260 && ++g.good >= 8 && g.level > 0) {
          g.level--; g.changedAt = now; g.good = 0;
        } else if (outcome.ok && g.ema >= 260) {
          g.good = 0;
        }
      },
    };
    return api;
  }

  // Wait before the next frame: the profile's interval counted from the start of the last
  // request, or the server's retry hint after a "busy" answer.
  function nextDelayMs(profile, elapsedMs, busyRetryMs) {
    if (busyRetryMs !== undefined && busyRetryMs !== null) return Math.max(busyRetryMs, profile.minIntervalMs);
    return Math.max(0, profile.minIntervalMs - elapsedMs);
  }

  // ---------- motion gate ----------
  function toGray(rgba) {
    const out = new Uint8Array(rgba.length >> 2);
    for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    return out;
  }
  function motionScore(prev, cur) {
    if (!prev || prev.length !== cur.length || !cur.length) return 1;
    let sum = 0;
    for (let i = 0; i < cur.length; i++) sum += Math.abs(cur[i] - prev[i]);
    return sum / cur.length / 255;
  }
  // A frame is sent when the picture changed, or when the last one is older than the heartbeat.
  function shouldSend(motion, sinceLastSendMs, opts) {
    const o = Object.assign({ threshold: 0.015, heartbeatMs: 1500 }, opts);
    return motion >= o.threshold || sinceLastSendMs >= o.heartbeatMs;
  }

  // ---------- meter ----------
  function createMeter(windowMs) {
    const win = windowMs || 3000;
    let times = [];
    let ema = null;
    return {
      push(now, latencyMs) {
        times.push(now);
        ema = ema === null ? latencyMs : ema + (latencyMs - ema) * 0.3;
      },
      reset() { times = []; ema = null; },
      fps(now) {
        times = times.filter((t) => now - t <= win);
        if (times.length < 2) return 0;
        return ((times.length - 1) * 1000) / (times[times.length - 1] - times[0]);
      },
      get latency() { return ema; },
    };
  }

  const api = { PROFILES, ORDER, DEFAULT_MIN_CONF, iou, gridCell, createTracker, projectBox, settleTracks, filterTracks, createGovernor, nextDelayMs, toGray, motionScore, shouldSend, createMeter };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FindItLive = api;
})(typeof window !== "undefined" ? window : globalThis);
