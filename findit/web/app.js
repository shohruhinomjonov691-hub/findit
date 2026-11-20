"use strict";
(() => {
  const I18N = window.FINDIT_I18N;
  const CLASS_KO = window.FINDIT_CLASS_KO;
  const SYNONYMS = window.FINDIT_SYNONYMS;
  const CATEGORIES = window.FINDIT_CATEGORIES;
  const LIVE = window.FindItLive;
  const VOICE = window.FindItVoice;
  const VIEWS = ["finder", "live", "inspect", "how", "model", "objects", "source"];
  const PAGE_VIEWS = ["how", "model", "objects", "source"];
  const LIVE_MODES = ["auto", "fast", "balanced", "low"];
  const LIVE_MAX_MS = 5 * 60 * 1000; // live stops by itself so a forgotten tab cannot load the server
  const $ = (id) => document.getElementById(id);

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("findit." + key); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("findit." + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };

  const S = {
    lang: store.get("lang", (navigator.language || "").toLowerCase().startsWith("ko") ? "ko" : "en"),
    view: "finder",
    info: null,
    result: null,
    requestMs: null,
    instance: new Map(), // detection id -> number within its class (1-based), only when the class repeats
    query: "",
    cat: "all",
    cls: "all",
    sort: "score",
    selected: null,
    busy: false,
    error: null, // { key, vars }
    toggles: Object.assign({ labels: true, scores: false, coords: false }, store.get("toggles", {})),
    exportInfo: null, // { state: "exported" | "error", key, vars }; null = Ready
    voiceOn: store.get("voice", false) === true,
    voiceLast: "", // the last detection announcement that started
    live: {
      state: "off", // off | starting | active | paused
      mode: LIVE_MODES.includes(store.get("liveMode", "auto")) ? store.get("liveMode", "auto") : "auto",
      minConf: Math.min(0.8, Math.max(0.35, Number(store.get("liveMinConf", LIVE.DEFAULT_MIN_CONF)) || LIVE.DEFAULT_MIN_CONF)),
      profile: "balanced", all: [], tracks: [], frame: null, fps: 0, latency: null, slowed: false, okStreak: 0,
      stats: { sent: 0, skipped: 0, busy: 0 },
    },
  };
  if (!I18N[S.lang]) S.lang = "en";

  // ---------- text ----------
  function t(key, vars) {
    let s = (I18N[S.lang] && I18N[S.lang][key]) || I18N.en[key] || key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split("{" + k + "}").join(String(v));
    return s;
  }
  const className = (name) => (S.lang === "ko" && CLASS_KO[name]) || name;
  const capital = (s) => (S.lang === "en" ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  function detLabel(d) {
    const n = S.instance.get(d.id);
    return capital(className(d.class_name)) + (n ? " " + n : "");
  }
  const locOf = (cell) => t(`loc.${cell.row}.${cell.col}`);
  const locText = (d) => locOf(d.cell);
  const pct = (score) => Math.round(score * 100);
  const fmtScore = (s) => s.toFixed(2);
  const fmtBox = (d) => d.bbox_xyxy.map((v) => Math.round(v)).join(", ");

  function applyStaticText() {
    document.documentElement.lang = S.lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
    document.querySelectorAll(".lang-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === S.lang)));
  }

  // ---------- filtering ----------
  function allClasses() {
    return S.info && S.info.model.classes.length ? S.info.model.classes : Object.keys(CLASS_KO);
  }

  // Returns null for an empty query, otherwise the set of COCO classes it names exactly (may be empty).
  const queryClasses = () => window.FindItSearch.queryClasses(S.query, allClasses(), CLASS_KO, SYNONYMS);

  function visibleDetections() {
    if (!S.result) return [];
    const qc = queryClasses();
    const cat = S.cat === "all" ? null : new Set(CATEGORIES[S.cat]);
    const list = S.result.detections.filter((d) =>
      (!qc || qc.has(d.class_name)) && (!cat || cat.has(d.class_name)) && (S.cls === "all" || d.class_name === S.cls));
    const by = {
      score: (a, b) => b.score - a.score,
      name: (a, b) => detLabel(a).localeCompare(detLabel(b), S.lang) || b.score - a.score,
      area: (a, b) => b.area_px - a.area_px,
    }[S.sort];
    return list.sort(by);
  }

  const selectedDet = () => (S.result && S.selected !== null ? S.result.detections.find((d) => d.id === S.selected) : null);

  // ---------- rendering ----------
  function render() {
    renderView();
    renderStage();
    renderResults();
    renderSelected();
    renderInspect();
    renderControls();
    renderBanner();
    if (S.view === "live") renderLive();
  }

  function renderView() {
    const work = S.view === "finder" || S.view === "inspect";
    $("workspace").hidden = !work;
    $("toolbar").hidden = !work;
    $("panelFinder").hidden = S.view !== "finder";
    $("panelInspect").hidden = S.view !== "inspect";
    $("page-live").hidden = S.view !== "live";
    for (const v of PAGE_VIEWS) $("page-" + v).hidden = S.view !== v;
    document.querySelectorAll(".nav-item").forEach((b) => {
      if (b.dataset.view === S.view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.cat === S.cat)));
    $("sort").value = S.sort;
    $("searchClear").hidden = !S.query;
  }

  function renderStage() {
    const has = !!S.result;
    $("stageEmpty").hidden = has;
    $("canvasWrap").hidden = !has;
    $("stageLoading").hidden = !S.busy;
    $("stage").setAttribute("aria-busy", String(S.busy));
    ["uploadBtn", "cameraBtn"].forEach((id) => { $(id).disabled = S.busy; });
    document.querySelectorAll("[data-action]").forEach((b) => { b.disabled = S.busy; });
    const overlay = $("overlay");
    overlay.textContent = "";
    if (!has) return;
    const { width: W, height: H } = S.result.image;
    const sel = selectedDet();
    overlay.classList.toggle("has-selection", !!sel);
    const showCoords = S.toggles.coords || S.view === "inspect";
    for (const d of visibleDetections()) {
      const [x1, y1, x2, y2] = d.bbox_xyxy;
      const box = document.createElement("button");
      box.type = "button";
      // Boxes on the right half anchor their tags to the right edge so they stay inside the image.
      box.className = "box" + (sel && sel.id === d.id ? " is-selected" : "") + (x1 / W > 0.5 ? " flip" : "");
      box.style.left = (x1 / W) * 100 + "%";
      box.style.top = (y1 / H) * 100 + "%";
      box.style.width = ((x2 - x1) / W) * 100 + "%";
      box.style.height = ((y2 - y1) / H) * 100 + "%";
      box.dataset.id = d.id;
      box.setAttribute("aria-label", `${detLabel(d)}, ${locText(d)}, ${t("score", { s: fmtScore(d.score) })}`);
      box.setAttribute("aria-pressed", String(!!sel && sel.id === d.id));
      const parts = [];
      if (S.toggles.labels) parts.push(detLabel(d));
      if (S.toggles.scores) parts.push(fmtScore(d.score));
      if (parts.length) {
        const tag = document.createElement("span");
        tag.className = "box-tag" + (y1 / H < 0.06 ? " inside" : "");
        tag.textContent = parts.join(" ");
        box.append(tag);
      }
      if (showCoords) {
        const c = document.createElement("span");
        c.className = "box-coords";
        c.textContent = `(${fmtBox(d)})`;
        box.append(c);
      }
      overlay.append(box);
    }
  }

  function resultsTitle() {
    if (!S.result) return t("results.none");
    const n = S.result.detections.length;
    const head = n === 0 ? t("results.zero") : n === 1 ? t("results.one") : t("results.count", { n });
    const shown = visibleDetections().length;
    return shown !== n && n ? `${head} · ${t("results.shown", { shown, n })}` : head;
  }

  function renderResults() {
    $("resultsTitle").textContent = resultsTitle();
    const sel = $("classFilter");
    sel.textContent = "";
    sel.append(new Option(t("filter.allClasses"), "all"));
    sel.disabled = !S.result || !S.result.detections.length;
    if (S.result) {
      const counts = new Map();
      for (const d of S.result.detections) counts.set(d.class_name, (counts.get(d.class_name) || 0) + 1);
      [...counts.keys()].sort((a, b) => className(a).localeCompare(className(b), S.lang))
        .forEach((name) => sel.append(new Option(`${capital(className(name))} (${counts.get(name)})`, name)));
      if (S.cls !== "all" && !counts.has(S.cls)) S.cls = "all";
    }
    sel.value = S.cls;

    const r = S.result;
    $("timing").textContent = r ? t("timing", { inf: r.timing.inference_ms, srv: r.timing.server_ms, tot: S.requestMs }) : "";

    const list = $("results");
    list.textContent = "";
    const vis = visibleDetections();
    for (const d of vis) {
      const item = document.createElement("div");
      item.setAttribute("role", "listitem");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "result" + (d.id === S.selected ? " is-selected" : "");
      btn.dataset.id = d.id;
      btn.setAttribute("aria-pressed", String(d.id === S.selected));
      const thumb = document.createElement("canvas");
      thumb.className = "thumb";
      thumb.width = 112; thumb.height = 112;
      thumb.setAttribute("aria-hidden", "true");
      drawCrop(thumb, d);
      const text = document.createElement("span");
      text.className = "result-text";
      const name = document.createElement("span");
      name.className = "result-name";
      name.textContent = detLabel(d);
      const meta = document.createElement("span");
      meta.className = "result-meta";
      meta.textContent = `${locText(d)} · ${t("conf", { p: pct(d.score) })}`;
      text.append(name, meta);
      const chev = document.createElement("span");
      chev.className = "chev";
      chev.setAttribute("aria-hidden", "true");
      chev.textContent = "›";
      btn.append(thumb, text, chev);
      item.append(btn);
      list.append(item);
    }

    const nf = $("notFound");
    let msg = "";
    if (r && !vis.length) {
      const qc = queryClasses();
      if (!r.detections.length) msg = t("notfound.empty");
      else if (qc && qc.size === 0) msg = t("notfound.unsupported", { q: S.query.trim() });
      else if (qc) msg = t("notfound.query", { q: S.query.trim() });
      else msg = t("notfound.filter");
    } else if (r && queryClasses() && queryClasses().size === 0) {
      msg = t("notfound.unsupported", { q: S.query.trim() });
    }
    nf.textContent = msg;
    nf.hidden = !msg;
  }

  function drawCrop(canvas, d, pad = 0.12) {
    const img = $("photo");
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0b1422";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!S.result || !img.complete || !img.naturalWidth) return;
    const k = img.naturalWidth / S.result.image.width; // preview px per original px
    let [x1, y1, x2, y2] = d.bbox_xyxy.map((v) => v * k);
    const pw = (x2 - x1) * pad, ph = (y2 - y1) * pad;
    x1 = Math.max(0, x1 - pw); y1 = Math.max(0, y1 - ph);
    x2 = Math.min(img.naturalWidth, x2 + pw); y2 = Math.min(img.naturalHeight, y2 + ph);
    const sw = Math.max(1, x2 - x1), sh = Math.max(1, y2 - y1);
    const scale = Math.min(canvas.width / sw, canvas.height / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(img, x1, y1, sw, sh, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  }

  function renderSelected() {
    const d = selectedDet();
    const card = $("selectedCard");
    card.hidden = !d;
    if (!d) return;
    drawCrop($("cropCanvas"), d);
    $("selName").textContent = detLabel(d);
    $("selLoc").textContent = locText(d);
    $("selScore").textContent = `${t("conf", { p: pct(d.score) })} (${t("score", { s: fmtScore(d.score) })}) — ${t("score.note")}`;
    const grid = $("grid3");
    grid.textContent = "";
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const cell = document.createElement("span");
      if (r === d.cell.row && c === d.cell.col) cell.className = "on";
      grid.append(cell);
    }
    $("speakBtn").hidden = speaker.availability(S.lang) === "unsupported";
  }

  function exportJson() {
    if (!S.result) return null;
    const { preview, ...rest } = S.result;
    return Object.assign({}, rest, {
      preview: { width: preview.width, height: preview.height, note: "preview image data omitted" },
      timing: Object.assign({}, rest.timing, { total_request_ms: S.requestMs }),
    });
  }

  function renderInspect() {
    if (S.view !== "inspect") return;
    const box = $("inspectSelected");
    box.textContent = "";
    const d = selectedDet();
    const rows = [];
    if (!S.result) rows.push([t("inspect.image"), t("inspect.noimage")]);
    else if (!d) rows.push([t("selected.title"), t("selected.none")]);
    else {
      rows.push([t("selected.title"), detLabel(d)], [t("inspect.scoreLabel"), `${fmtScore(d.score)} (${t("score.note")})`],
        [t("inspect.format"), "x1, y1, x2, y2 (px)"], [t("inspect.position"), locText(d)]);
    }
    const dl = document.createElement("dl");
    dl.className = "facts compact";
    for (const [k, v] of rows) {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.append(dt, dd);
    }
    if (d) {
      const c = document.createElement("canvas");
      c.className = "crop crop-inspect"; c.width = 160; c.height = 160; c.setAttribute("aria-hidden", "true");
      drawCrop(c, d);
      box.append(c);
    }
    box.append(dl);
    const objects = $("inspectList");
    objects.textContent = "";
    const shown = S.result ? visibleDetections() : [];
    for (const o of shown) {
      const item = document.createElement("div");
      item.setAttribute("role", "listitem");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "result" + (o.id === S.selected ? " is-selected" : "");
      btn.dataset.id = o.id;
      btn.setAttribute("aria-pressed", String(o.id === S.selected));
      const text = document.createElement("span");
      text.className = "result-text";
      const name = document.createElement("span");
      name.className = "result-name";
      name.textContent = detLabel(o);
      const meta = document.createElement("span");
      meta.className = "result-meta";
      meta.textContent = `${t("conf", { p: pct(o.score) })} · ${locText(o)}`;
      text.append(name, meta);
      btn.append(text);
      item.append(btn);
      objects.append(item);
    }
    if (S.result && !shown.length) {
      const none = document.createElement("p");
      none.className = "hint";
      none.textContent = t("inspect.objects.none");
      objects.append(none);
    }
    renderExportStatus();
    $("coordOut").textContent = d ? fmtBox(d) : "—";
    $("copyCoords").disabled = !d;
    const json = exportJson();
    $("jsonView").textContent = json ? JSON.stringify(json, null, 2) : "{}";
    ["copyJson", "downloadJson", "downloadImage"].forEach((id) => { $(id).disabled = !json; });
  }

  // Export status: Ready (a result exists), Exported (a file was saved or text copied), Error.
  function renderExportStatus() {
    const el = $("exportStatus");
    let state = "ready", text = t("export.ready");
    if (!S.result) { state = "none"; text = t("export.none"); }
    else if (S.exportInfo && S.exportInfo.state === "exported") {
      state = "exported"; text = t("export.exported", { what: t(S.exportInfo.key) });
    } else if (S.exportInfo && S.exportInfo.state === "error") {
      state = "error"; text = t("export.error", { why: t(S.exportInfo.key) });
    }
    el.dataset.state = state;
    el.textContent = text;
  }
  function setExport(state, key) {
    S.exportInfo = { state, key };
    renderExportStatus();
  }

  function renderControls() {
    for (const host of [$("controlsFinder"), $("controlsInspect")]) {
      host.textContent = "";
      const h = document.createElement("h3");
      h.className = "panel-sub";
      h.textContent = t("controls.title");
      const row = document.createElement("div");
      row.className = "toggles";
      for (const key of ["labels", "scores", "coords"]) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "toggle";
        b.setAttribute("role", "switch");
        b.setAttribute("aria-checked", String(S.toggles[key]));
        b.dataset.toggle = key;
        b.innerHTML = '<span class="switch" aria-hidden="true"></span>';
        const label = document.createElement("span");
        label.textContent = `${t("controls." + key)} ${S.toggles[key] ? t("on") : t("off")}`;
        b.append(label);
        row.append(b);
      }
      host.append(h, row);
    }
  }

  function renderBanner() {
    $("banner").hidden = !S.error;
    $("bannerText").textContent = S.error ? t(S.error.key, S.error.vars) : "";
  }

  function renderInfo() {
    const info = S.info;
    const lim = info ? info.limits : { max_upload_mib: 10, max_megapixels: 40 };
    $("limitsHint").textContent = t("empty.limits", { mib: lim.max_upload_mib, mp: lim.max_megapixels });

    const facts = $("modelFacts");
    facts.textContent = "";
    if (info) {
      const m = info.model;
      const rows = [
        [t("model.status"), m.loaded ? t("model.loaded") : t("model.notLoaded", { err: m.error || "?" })],
        [t("model.file"), m.file], [t("model.sha"), m.sha256 || "—"], [t("model.classes"), String(m.classes.length || 80)],
        [t("model.conf"), String(m.conf_threshold)], [t("model.imgsz"), `${m.imgsz} px`], [t("model.device"), m.device],
        [t("model.nms"), t("model.nmsValue")],
      ];
      for (const [k, v] of rows) {
        const dt = document.createElement("dt"); dt.textContent = k;
        const dd = document.createElement("dd"); dd.textContent = v;
        if (k === t("model.sha")) dd.className = "mono wrap";
        facts.append(dt, dd);
      }
    }

    const grid = $("classGrid");
    grid.textContent = "";
    for (const name of allClasses()) {
      const li = document.createElement("li");
      li.textContent = S.lang === "ko" ? `${CLASS_KO[name] || name} · ${name}` : name;
      grid.append(li);
    }

    const src = $("sourceBox");
    src.textContent = "";
    const url = info && info.source.url;
    if (url && /^https:\/\//.test(url)) {
      const a = document.createElement("a");
      a.href = url; a.rel = "noopener"; a.textContent = `${t("source.link")}: ${url}`;
      src.append(a);
    } else {
      const p = document.createElement("p");
      p.textContent = t("source.none");
      src.append(p);
    }
    if (info && info.source.commit) {
      const p = document.createElement("p");
      p.className = "mono";
      p.textContent = t("source.commit", { c: info.source.commit });
      src.append(p);
    }
  }

  // ---------- actions ----------
  function setView(v) {
    if (!VIEWS.includes(v)) v = "finder";
    if (v !== "live" && S.live.state !== "off") stopLive();
    S.view = v;
    if (location.hash.slice(1) !== v) history.replaceState(null, "", "#" + v);
    render();
  }

  function select(id, { focusList = false, focusBox = false } = {}) {
    S.selected = id;
    render();
    const d = selectedDet();
    if (d) {
      $("live").textContent = t("live.selected", { name: detLabel(d), loc: locText(d) });
      if (focusList) {
        const b = document.querySelector(`.result[data-id="${id}"]`);
        if (b) { b.focus(); b.scrollIntoView({ block: "nearest" }); }
      }
      if (focusBox) {
        const b = document.querySelector(`.box[data-id="${id}"]`);
        if (b) b.focus();
      }
    }
  }

  function showError(key, vars) {
    S.error = { key, vars };
    renderBanner();
  }

  function errorFromCode(code) {
    const lim = S.info ? S.info.limits : { max_upload_mib: 10, max_megapixels: 40, min_side: 16, max_side: 12000 };
    const vars = { mib: lim.max_upload_mib, mp: lim.max_megapixels, min: lim.min_side, max: lim.max_side };
    const known = ["file_too_large", "empty_file", "invalid_image", "unsupported_format", "image_dimensions", "busy", "model_unavailable", "live_disabled"];
    return known.includes(code) ? ["err." + code, vars] : ["err.server", vars];
  }

  function buildInstances() {
    S.instance = new Map();
    const byClass = new Map();
    for (const d of [...S.result.detections].sort((a, b) => b.score - a.score)) {
      if (!byClass.has(d.class_name)) byClass.set(d.class_name, []);
      byClass.get(d.class_name).push(d);
    }
    for (const list of byClass.values()) if (list.length > 1) list.forEach((d, i) => S.instance.set(d.id, i + 1));
  }

  async function detect(file) {
    if (S.busy) return;
    const limMiB = S.info ? S.info.limits.max_upload_mib : 10;
    if (file.size > limMiB * 1024 * 1024) { showError(...errorFromCode("file_too_large")); return; }
    if (file.size === 0) { showError(...errorFromCode("empty_file")); return; }
    S.busy = true;
    S.error = null;
    render();
    const t0 = performance.now();
    try {
      // Raw body (no multipart, no file name): the server keeps it in memory.
      const res = await fetch("/api/detect", {
        method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) {
        showError(...errorFromCode(body && body.error ? body.error.code : ""));
        return;
      }
      S.requestMs = Math.round(performance.now() - t0);
      await new Promise((resolve) => {
        const img = $("photo");
        img.onload = img.onerror = () => resolve();
        img.src = body.preview.data_url;
      });
      S.result = body;
      S.selected = null;
      S.cls = "all";
      S.exportInfo = null;
      buildInstances();
      const vis = visibleDetections();
      if (S.query && vis.length) S.selected = vis[0].id;
      $("photo").alt = resultsTitle();
      $("live").textContent = resultsTitle();
    } catch {
      showError("err.network");
    } finally {
      S.busy = false;
      render();
    }
  }

  // Camera: one frame on request, stream stopped right after. camera.js allows one
  // request at a time and stops a stream that arrives after the dialog was closed.
  const camera = window.FindItCamera.createCamera((c) => navigator.mediaDevices.getUserMedia(c));
  function closeCamera() {
    camera.close();
    $("cameraVideo").srcObject = null;
    if ($("cameraDialog").open) $("cameraDialog").close();
  }
  const cameraErrorKey = (name) => (name === "NotAllowedError" || name === "SecurityError" ? "err.camera_denied"
    : name === "NotFoundError" || name === "OverconstrainedError" ? "err.camera_missing" : "err.camera_other");
  async function openCamera() {
    if (S.live.state !== "off") stopLive(); // one camera at a time
    if (S.busy || camera.pending || camera.stream) return;
    if (!window.isSecureContext) { showError("err.camera_insecure"); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showError("err.camera_missing"); return; }
    S.error = null;
    renderBanner();
    // The dialog opens before permission is granted so the request can be cancelled.
    $("cameraShoot").disabled = true;
    $("cameraHint").textContent = t("camera.waiting");
    $("cameraDialog").showModal();
    const res = await camera.open({ video: { facingMode: "environment" }, audio: false });
    if (res.status === "open") {
      $("cameraVideo").srcObject = res.stream;
      $("cameraShoot").disabled = false;
      $("cameraHint").textContent = t("camera.hint");
    } else if (res.status === "error") {
      closeCamera();
      showError(cameraErrorKey(res.error && res.error.name));
    }
  }
  function shootCamera() {
    const v = $("cameraVideo");
    if (!v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    closeCamera();
    c.toBlob((blob) => { if (blob) detect(new File([blob], "camera.jpg", { type: "image/jpeg" })); }, "image/jpeg", 0.92);
  }

  // ---------- live camera + voice ----------
  // Frames of the live camera are sent one at a time as small JPEGs. Still scenes are skipped,
  // the speed profile follows the server's answers (Auto) and a busy server only slows the loop.
  const liveCamera = window.FindItCamera.createCamera((c) => navigator.mediaDevices.getUserMedia(c));
  const tracker = LIVE.createTracker();
  const governor = LIVE.createGovernor(S.live.mode);
  const meter = LIVE.createMeter(3000);
  const announcer = VOICE.createAnnouncer();
  const speaker = VOICE.createSpeaker(window.speechSynthesis, window.SpeechSynthesisUtterance, { onChange: () => renderVoice() });
  const liveEls = new Map(); // track id -> overlay element (kept so boxes glide instead of blinking)
  let liveRun = 0; // changes on every start and stop; a running loop stops when its number is old
  let liveAbort = null;
  let liveStartedAt = 0;
  let lastSentAt = 0;
  let prevGray = null;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function liveLabel(tr) {
    return `${capital(className(tr.class_name))} ${pct(tr.score)}% · ${locOf(tr.cell)}`;
  }

  function renderLive() {
    const st = S.live.state;
    $("liveEmpty").hidden = st !== "off";
    $("liveWrap").hidden = !(st === "active" || st === "paused");
    $("liveLoading").hidden = st !== "starting";
    $("liveToggle").textContent = t(st === "off" ? "live.start" : "live.stop");
    $("liveToggle").disabled = S.busy && st === "off";
    $("liveStartBig").disabled = S.busy;
    $("liveMode").value = S.live.mode;
    $("liveConf").value = String(Math.round(S.live.minConf * 100));
    $("liveConfValue").textContent = Math.round(S.live.minConf * 100) + "%";
    const label = $("liveState");
    label.dataset.state = st;
    label.textContent = st === "active" ? t("live.state.active", { mode: t("live.mode." + S.live.profile) })
      : t("live.state." + st);
    renderLiveStatus();
    renderLiveOverlay();
    renderLiveList();
    renderVoice();
  }

  function renderLiveStatus() {
    const l = S.live;
    $("liveMetrics").textContent = l.state === "active" && l.latency !== null
      ? t("live.metrics", { fps: l.fps.toFixed(1), ms: Math.round(l.latency) }) : t("live.metrics.none");
    $("liveStats").textContent = l.state === "off" ? "" : t("live.stats", l.stats);
    const slowed = $("liveSlowed");
    slowed.hidden = !(l.state === "active" && l.slowed);
    slowed.textContent = slowed.hidden ? "" : t("live.slowed");
  }

  function renderLiveOverlay() {
    const host = $("liveOverlay");
    const f = S.live.frame;
    const tracks = S.live.state === "off" || !f ? [] : S.live.tracks;
    const seen = new Set();
    for (const tr of tracks) {
      seen.add(tr.id);
      let el = liveEls.get(tr.id);
      if (!el) {
        el = document.createElement("div");
        const tag = document.createElement("span");
        el.append(tag);
        host.append(el);
        liveEls.set(tr.id, el);
      }
      // Where the object is by now: the answer is some 100-300 ms older than the picture.
      const [x1, y1, x2, y2] = LIVE.projectBox(tr, performance.now()).map((v, k) => Math.max(0, Math.min(k % 2 ? f.h : f.w, v)));
      el.className = "live-box" + (x1 / f.w > 0.5 ? " flip" : "") + (tr.misses > 0 ? " stale" : "");
      el.style.left = (x1 / f.w) * 100 + "%";
      el.style.top = (y1 / f.h) * 100 + "%";
      el.style.width = ((x2 - x1) / f.w) * 100 + "%";
      el.style.height = ((y2 - y1) / f.h) * 100 + "%";
      const tag = el.children[0];
      tag.className = "box-tag" + (y1 / f.h < 0.06 ? " inside" : "");
      tag.textContent = liveLabel(tr);
    }
    for (const [id, el] of liveEls) {
      if (!seen.has(id)) { el.remove(); liveEls.delete(id); }
    }
  }

  function renderLiveList() {
    const list = $("liveList");
    list.textContent = "";
    const tracks = S.live.state === "off" ? [] : S.live.tracks;
    for (const tr of tracks) {
      const item = document.createElement("div");
      item.setAttribute("role", "listitem");
      const row = document.createElement("div");
      row.className = "result";
      const text = document.createElement("span");
      text.className = "result-text";
      const name = document.createElement("span");
      name.className = "result-name";
      name.textContent = capital(className(tr.class_name));
      const meta = document.createElement("span");
      meta.className = "result-meta";
      meta.textContent = `${pct(tr.score)}% · ${locOf(tr.cell)}`;
      text.append(name, meta);
      row.append(text);
      item.append(row);
      list.append(item);
    }
    $("liveNone").hidden = !(S.live.state === "active" && !tracks.length);
  }

  // Voice states: "on" | "off" (muted) | "unavailable" (no speech support, no voice for the
  // language, or the browser failed to speak). The picture keeps working in every state.
  function voiceStatus() {
    if (speaker.availability(S.lang) !== "ok") return "unavailable";
    return S.voiceOn ? "on" : "off";
  }

  function renderVoice() {
    const st = voiceStatus();
    const av = speaker.availability(S.lang);
    const btn = $("voiceToggle");
    btn.disabled = av === "unsupported" || av === "no_voice";
    btn.setAttribute("aria-checked", String(st === "on"));
    btn.dataset.state = st;
    $("voiceLabel").textContent = st === "on" ? t("voice.on", { lang: S.lang.toUpperCase() })
      : st === "off" ? t("voice.off") : t("voice.unavailable");
    $("voiceTest").disabled = av === "unsupported" || av === "no_voice";
    const why = $("voiceWhy");
    why.hidden = av === "ok";
    const key = av === "error" && speaker.lastError === "not-allowed" ? "blocked" : av;
    why.textContent = av === "ok" ? "" : t("voice.why." + key, { lang: S.lang === "ko" ? "한국어" : "English" });
    renderVoiceNote();
  }

  // Tells why nothing is heard when voice is on: waiting, or no object above the confidence limit.
  function renderVoiceNote() {
    const note = $("voiceNote");
    let text = "";
    if (voiceStatus() === "on" && S.live.state === "active") {
      text = S.voiceLast ? t("voice.last", { text: S.voiceLast })
        : S.live.tracks.length ? t("voice.waiting") : t("voice.nothing", { p: Math.round(S.live.minConf * 100) });
    }
    note.hidden = !text;
    note.textContent = text;
  }

  // Keep explicit speech requests in their click handler so they retain user activation.
  function speakFromClick(text) {
    if (speaker.availability(S.lang) === "error") speaker.resetError();
    if (speaker.availability(S.lang) === "ok") speaker.speak(text, S.lang);
    renderVoice();
  }

  // The sample plays on request even when automatic announcements are muted.
  function testVoice() {
    const text = VOICE.sentence(S.lang, [{ name: className("cup"), score: 0.9, cell: { row: 1, col: 2 } }]);
    speakFromClick(text);
  }

  function toggleVoice() {
    if (speaker.availability(S.lang) === "error") { speaker.resetError(); S.voiceOn = false; } // retry
    if (speaker.availability(S.lang) !== "ok") { renderVoice(); return; }
    S.voiceOn = !S.voiceOn;
    store.set("voice", S.voiceOn);
    S.voiceLast = "";
    if (S.voiceOn) {
      announcer.reset();
      speakFromClick(t("voice.hello"));
    } else {
      speaker.cancel();
      renderVoice();
    }
  }

  function voiceStep(tracks, now) {
    if (!S.voiceOn || S.live.state !== "active" || speaker.availability(S.lang) !== "ok" || speaker.speaking) return;
    const items = announcer.pick(tracks, now);
    if (!items.length) return;
    const text = VOICE.sentence(S.lang, items.map((tr) => ({ name: className(tr.class_name), score: tr.score, cell: tr.cell })));
    speaker.speak(text, S.lang, () => {
      announcer.mark(items, performance.now());
      S.voiceLast = text;
      renderVoiceNote();
    });
  }

  function stopLive() {
    liveRun++;
    if (liveAbort) { liveAbort.abort(); liveAbort = null; }
    liveCamera.close();
    $("liveVideo").srcObject = null;
    speaker.cancel();
    S.voiceLast = "";
    tracker.reset(); meter.reset(); announcer.reset();
    prevGray = null;
    const was = S.live.state;
    Object.assign(S.live, { state: "off", all: [], tracks: [], frame: null, fps: 0, latency: null, slowed: false, okStreak: 0 });
    if (was !== "off") $("live").textContent = t("live.state.off");
    if (S.view === "live") renderLive();
  }

  async function startLive() {
    if (S.live.state !== "off" || S.busy) return;
    if ($("cameraDialog").open || camera.pending || camera.stream) return;
    if (S.info && S.info.live && !S.info.live.enabled) { showError("err.live_disabled"); return; }
    if (S.info && !S.info.model.loaded) { showError("err.model_unavailable"); return; }
    if (!window.isSecureContext) { showError("err.camera_insecure"); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showError("err.camera_missing"); return; }
    S.error = null;
    renderBanner();
    const run = ++liveRun;
    S.live.stats = { sent: 0, skipped: 0, busy: 0 };
    S.live.state = "starting";
    renderLive();
    // A low resolution is enough for the model and keeps the work per frame small.
    const res = await liveCamera.open({ video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    if (run !== liveRun) return; // stopped while waiting for permission; the late stream is already stopped
    if (res.status !== "open") {
      stopLive();
      if (res.status === "error") showError(cameraErrorKey(res.error && res.error.name));
      return;
    }
    $("liveVideo").srcObject = res.stream;
    for (const track of res.stream.getTracks()) {
      if (track.kind !== "video") continue;
      track.onended = () => { if (run === liveRun) { stopLive(); showError("err.live_stream_lost"); } };
    }
    governor.setMode(S.live.mode);
    liveStartedAt = performance.now();
    lastSentAt = 0;
    S.live.state = document.hidden ? "paused" : "active"; // the tab may have been hidden while waiting for permission
    S.live.profile = governor.profile().name;
    $("live").textContent = t("live.state.active", { mode: t("live.mode." + S.live.profile) });
    renderLive();
    liveLoop(run);
    paintLoop(run);
  }

  // Boxes are placed again on every animation frame so they follow the picture between answers.
  function paintLoop(run) {
    if (!window.requestAnimationFrame) return;
    const tick = () => {
      if (run !== liveRun) return;
      if (S.live.state === "active" && S.live.tracks.length) renderLiveOverlay();
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  }

  function grabFrame(video, canvas, profile) {
    const scale = Math.min(1, profile.frame / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(16, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(16, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", profile.quality));
  }

  // Tracks that are kept (steadied) vs drawn (filtered by confidence); both come from the same list.
  function refreshLiveTracks() {
    S.live.tracks = S.live.frame ? LIVE.filterTracks(S.live.all, S.live.frame, S.live.minConf) : [];
  }

  function onLiveResult(body, latency, now) {
    const frame = { w: body.image.width, h: body.image.height };
    S.live.frame = frame;
    S.live.all = tracker.update(body.detections, frame, now, now - latency);
    refreshLiveTracks();
    meter.push(now, latency);
    S.live.fps = meter.fps(now);
    S.live.latency = meter.latency;
    if (++S.live.okStreak >= 5) S.live.slowed = false;
    renderLiveOverlay();
    renderLiveList();
    renderLiveStatus();
    voiceStep(S.live.tracks, now);
    renderVoiceNote();
  }

  async function liveLoop(run) {
    const frameCanvas = document.createElement("canvas");
    const tiny = document.createElement("canvas");
    tiny.width = 32; tiny.height = 24;
    const tinyCtx = tiny.getContext("2d", { willReadFrequently: true });
    const video = $("liveVideo");
    let failures = 0;
    while (run === liveRun) {
      if (S.live.state === "paused") { await sleep(250); continue; }
      if (performance.now() - liveStartedAt > LIVE_MAX_MS) { stopLive(); showError("live.timeout"); return; }
      if (!video.videoWidth) { await sleep(100); continue; }
      // Cheap local check first: a picture that did not change is not worth a server request.
      tinyCtx.drawImage(video, 0, 0, 32, 24);
      const gray = LIVE.toGray(tinyCtx.getImageData(0, 0, 32, 24).data);
      const t0 = performance.now();
      if (!LIVE.shouldSend(LIVE.motionScore(prevGray, gray), t0 - lastSentAt)) {
        S.live.stats.skipped++;
        tracker.settle(); // a still picture: boxes stop where the objects are
        LIVE.settleTracks(S.live.all); // ... including the copies that are drawn
        renderLiveStatus();
        await sleep(120);
        continue;
      }
      const profile = governor.profile();
      S.live.profile = profile.name;
      const blob = await grabFrame(video, frameCanvas, profile);
      if (run !== liveRun) return;
      if (!blob) { await sleep(200); continue; }
      prevGray = gray;
      lastSentAt = t0;
      S.live.stats.sent++;
      liveAbort = new AbortController();
      let retry = null;
      try {
        const res = await fetch(`/api/detect/live?imgsz=${profile.imgsz}`, {
          method: "POST", body: blob, headers: { "Content-Type": "image/jpeg" }, signal: liveAbort.signal,
        });
        let body = null;
        try { body = await res.json(); } catch { body = null; }
        if (run !== liveRun) return;
        const now = performance.now();
        const code = body && body.error ? body.error.code : "";
        if (res.ok && body && body.image) {
          failures = 0;
          governor.record({ ok: true, latencyMs: now - t0 }, now);
          onLiveResult(body, now - t0, now);
        } else if ((res.status === 503 && code === "busy") || res.status === 429) {
          // 503 from the app (detector busy / duty cap), or 429 from a rate limit in front of it.
          S.live.stats.busy++;
          S.live.slowed = true; S.live.okStreak = 0;
          governor.record({ busy: true }, now);
          retry = (body && body.error && body.error.retry_ms) || Number(res.headers && res.headers.get && res.headers.get("Retry-After")) * 1000 || 1000;
        } else if (code === "live_disabled" || code === "model_unavailable") {
          stopLive(); showError(...errorFromCode(code)); return;
        } else if (++failures >= 3) {
          stopLive(); showError(...errorFromCode(code)); return;
        } else {
          retry = 1000;
        }
      } catch {
        if (run !== liveRun) return; // aborted by stopLive
        if (++failures >= 3) { stopLive(); showError("err.network"); return; }
        retry = 1000;
      }
      liveAbort = null;
      S.live.profile = governor.profile().name;
      renderLiveStatus();
      const label = $("liveState");
      if (S.live.state === "active") label.textContent = t("live.state.active", { mode: t("live.mode." + S.live.profile) });
      await sleep(LIVE.nextDelayMs(profile, performance.now() - t0, retry));
    }
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyText(text, btn, what) {
    try { await navigator.clipboard.writeText(text); }
    catch { setExport("error", "export.why.clipboard"); return; }
    setExport("exported", what);
    const old = btn.textContent;
    btn.textContent = t("copied");
    setTimeout(() => { btn.textContent = old; }, 1200);
  }

  function annotatedBlob() {
    const img = $("photo");
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const k = img.naturalWidth / S.result.image.width;
    const sel = selectedDet();
    const lw = Math.max(2, Math.round(Math.min(c.width, c.height) / 300));
    const font = Math.max(12, Math.round(Math.min(c.width, c.height) / 45));
    if (sel) {
      const [x1, y1, x2, y2] = sel.bbox_xyxy.map((v) => v * k);
      ctx.save();
      ctx.fillStyle = "rgba(4, 10, 20, 0.55)";
      ctx.beginPath();
      ctx.rect(0, 0, c.width, c.height);
      ctx.rect(x1, y1, x2 - x1, y2 - y1);
      ctx.fill("evenodd");
      ctx.restore();
    }
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    for (const d of visibleDetections()) {
      const [x1, y1, x2, y2] = d.bbox_xyxy.map((v) => v * k);
      const isSel = sel && sel.id === d.id;
      ctx.strokeStyle = isSel ? "#22e1f5" : "#2f80ed";
      ctx.lineWidth = isSel ? lw * 1.6 : lw;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const parts = [];
      if (S.toggles.labels) parts.push(detLabel(d));
      if (S.toggles.scores) parts.push(fmtScore(d.score));
      if (S.toggles.coords) parts.push(`(${fmtBox(d)})`);
      if (!parts.length) continue;
      const text = parts.join(" ");
      const tw = ctx.measureText(text).width + font * 0.6;
      const th = font * 1.35;
      const ty = y1 - th >= 0 ? y1 - th : y1;
      ctx.fillStyle = isSel ? "#22e1f5" : "#2f80ed";
      ctx.fillRect(x1, ty, tw, th);
      ctx.fillStyle = isSel ? "#04121c" : "#ffffff";
      ctx.fillText(text, x1 + font * 0.3, ty + font * 0.18);
    }
    return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.92));
  }

  function moveSelection(step, where) {
    const vis = visibleDetections();
    if (!vis.length) return;
    const i = vis.findIndex((d) => d.id === S.selected);
    const next = i < 0 ? (step > 0 ? 0 : vis.length - 1) : (i + step + vis.length) % vis.length;
    select(vis[next].id, where === "box" ? { focusBox: true } : { focusList: true });
  }

  // ---------- events ----------
  function bind() {
    document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
    window.addEventListener("hashchange", () => setView(location.hash.slice(1)));
    document.querySelectorAll(".lang-btn").forEach((b) => b.addEventListener("click", () => {
      if (S.lang === b.dataset.lang) return;
      S.lang = b.dataset.lang; store.set("lang", S.lang);
      speaker.cancel(); speaker.resetError(); announcer.reset(); S.voiceLast = "";
      applyStaticText(); renderInfo(); render();
      voiceStep(S.live.tracks, performance.now());
    }));

    const pick = () => { if (!S.busy) $("fileInput").click(); };
    $("uploadBtn").addEventListener("click", pick);
    $("cameraBtn").addEventListener("click", openCamera);
    document.querySelectorAll("[data-action]").forEach((b) => b.addEventListener("click", () => (b.dataset.action === "upload" ? pick() : openCamera())));
    $("fileInput").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) detect(f);
    });
    const stage = $("stage");
    stage.addEventListener("dragover", (e) => { e.preventDefault(); stage.classList.add("drag"); });
    stage.addEventListener("dragleave", () => stage.classList.remove("drag"));
    stage.addEventListener("drop", (e) => {
      e.preventDefault(); stage.classList.remove("drag");
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) detect(f);
    });

    $("search").addEventListener("input", (e) => {
      S.query = e.target.value;
      const vis = visibleDetections();
      S.selected = S.query && vis.length ? vis[0].id : (vis.some((d) => d.id === S.selected) ? S.selected : null);
      render();
    });
    $("searchClear").addEventListener("click", () => { S.query = ""; $("search").value = ""; render(); $("search").focus(); });
    document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { S.cat = c.dataset.cat; render(); }));
    $("sort").addEventListener("change", (e) => { S.sort = e.target.value; render(); });
    $("classFilter").addEventListener("change", (e) => { S.cls = e.target.value; render(); });

    $("overlay").addEventListener("click", (e) => {
      const b = e.target.closest(".box");
      if (b) select(Number(b.dataset.id), { focusBox: true });
    });
    $("overlay").addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); moveSelection(1, "box"); }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1, "box"); }
    });
    $("results").addEventListener("click", (e) => {
      const b = e.target.closest(".result");
      if (b) select(Number(b.dataset.id), { focusList: true });
    });
    $("results").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
      if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
    });
    document.addEventListener("click", (e) => {
      const tg = e.target.closest("[data-toggle]");
      if (!tg) return;
      const key = tg.dataset.toggle;
      const host = tg.closest(".controls").id;
      S.toggles[key] = !S.toggles[key];
      store.set("toggles", S.toggles);
      render();
      const again = document.querySelector(`#${host} [data-toggle="${key}"]`);
      if (again) again.focus();
    });
    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === "Escape" && $("cameraDialog").open) { e.preventDefault(); closeCamera(); }
      else if (e.key === "/" && !typing && !$("cameraDialog").open && S.view !== "live") { e.preventDefault(); $("search").focus(); }
      else if (e.key === "Escape" && !$("cameraDialog").open) {
        if (S.live.state !== "off") stopLive();
        else if (S.error) { S.error = null; renderBanner(); }
        else if (S.selected !== null) { S.selected = null; render(); }
      }
    });

    $("speakBtn").addEventListener("click", () => {
      const d = selectedDet();
      if (!d) return;
      speakFromClick(t("speak.text", { name: detLabel(d), loc: locText(d), p: pct(d.score) }));
    });
    $("bannerClose").addEventListener("click", () => { S.error = null; renderBanner(); });

    $("copyCoords").addEventListener("click", (e) => { const d = selectedDet(); if (d) copyText(fmtBox(d), e.currentTarget, "export.what.coords"); });
    $("copyJson").addEventListener("click", (e) => copyText(JSON.stringify(exportJson(), null, 2), e.currentTarget, "export.what.copyjson"));
    $("downloadJson").addEventListener("click", () => {
      download(new Blob([JSON.stringify(exportJson(), null, 2)], { type: "application/json" }), "findit-detections.json");
      setExport("exported", "export.what.json");
    });
    $("downloadImage").addEventListener("click", async () => {
      if (!S.result) return;
      let blob = null;
      try { blob = await annotatedBlob(); } catch { blob = null; }
      if (!blob) { setExport("error", "export.why.image"); return; }
      download(blob, "findit-annotated.jpg");
      setExport("exported", "export.what.image");
    });
    $("inspectList").addEventListener("click", (e) => {
      const b = e.target.closest(".result");
      if (b) select(Number(b.dataset.id));
    });

    $("liveToggle").addEventListener("click", () => (S.live.state === "off" ? startLive() : stopLive()));
    $("liveStartBig").addEventListener("click", startLive);
    $("liveMode").addEventListener("change", (e) => {
      S.live.mode = LIVE_MODES.includes(e.target.value) ? e.target.value : "auto";
      store.set("liveMode", S.live.mode);
      governor.setMode(S.live.mode);
      renderLive();
    });
    $("liveConf").addEventListener("input", (e) => {
      S.live.minConf = Math.min(0.8, Math.max(0.35, Number(e.target.value) / 100 || LIVE.DEFAULT_MIN_CONF));
      store.set("liveMinConf", S.live.minConf);
      refreshLiveTracks();
      renderLive();
    });
    $("voiceToggle").addEventListener("click", toggleVoice);
    $("voiceTest").addEventListener("click", testVoice);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && S.live.state === "active") {
        S.live.state = "paused"; speaker.cancel(); renderLive();
      } else if (!document.hidden && S.live.state === "paused") {
        tracker.reset(); announcer.reset(); prevGray = null; S.live.all = []; S.live.tracks = [];
        S.live.state = "active"; renderLive();
      }
    });
    window.addEventListener("pagehide", stopLive);
    if (window.speechSynthesis && window.speechSynthesis.addEventListener) {
      window.speechSynthesis.addEventListener("voiceschanged", renderVoice);
    }

    $("cameraShoot").addEventListener("click", shootCamera);
    $("cameraCancel").addEventListener("click", closeCamera);
    // The "close" event is delivered after dialog.close() returns. If the camera was
    // reopened in between, the dialog is open again and the event belongs to the
    // previous (already stopped) session, so it must not close the new one.
    $("cameraDialog").addEventListener("close", () => {
      if (!$("cameraDialog").open) closeCamera();
    });
  }

  async function loadInfo() {
    try {
      const res = await fetch("/api/info");
      if (!res.ok) throw new Error(String(res.status));
      S.info = await res.json();
      if (!S.info.model.loaded) showError("err.model_unavailable");
    } catch {
      showError("err.network");
    }
    renderInfo();
    render();
  }

  bind();
  applyStaticText();
  renderInfo();
  setView(location.hash.slice(1) || "finder");
  loadInfo();
})();
