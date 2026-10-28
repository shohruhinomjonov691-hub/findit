"use strict";
(() => {
  const I18N = window.FINDIT_I18N;
  const CLASS_KO = window.FINDIT_CLASS_KO;
  const SYNONYMS = window.FINDIT_SYNONYMS;
  const CATEGORIES = window.FINDIT_CATEGORIES;
  const VIEWS = ["finder", "inspect", "how", "model", "objects", "source"];
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
  const locText = (d) => t(`loc.${d.cell.row}.${d.cell.col}`);
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
  }

  function renderView() {
    const work = S.view === "finder" || S.view === "inspect";
    $("workspace").hidden = !work;
    $("toolbar").hidden = !work;
    $("panelFinder").hidden = S.view !== "finder";
    $("panelInspect").hidden = S.view !== "inspect";
    for (const v of VIEWS.slice(2)) $("page-" + v).hidden = S.view !== v;
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
      meta.textContent = `${locText(d)} · ${t("score", { s: fmtScore(d.score) })}`;
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
    $("selScore").textContent = `${t("score", { s: fmtScore(d.score) })} — ${t("score.note")}`;
    const grid = $("grid3");
    grid.textContent = "";
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const cell = document.createElement("span");
      if (r === d.cell.row && c === d.cell.col) cell.className = "on";
      grid.append(cell);
    }
    $("speakBtn").hidden = !("speechSynthesis" in window);
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
    $("coordOut").textContent = d ? fmtBox(d) : "—";
    $("copyCoords").disabled = !d;
    const json = exportJson();
    $("jsonView").textContent = json ? JSON.stringify(json, null, 2) : "{}";
    ["copyJson", "downloadJson", "downloadImage"].forEach((id) => { $(id).disabled = !json; });
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
    const known = ["file_too_large", "empty_file", "invalid_image", "unsupported_format", "image_dimensions", "busy", "model_unavailable"];
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
  async function openCamera() {
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
      const name = res.error && res.error.name;
      showError(name === "NotAllowedError" || name === "SecurityError" ? "err.camera_denied"
        : name === "NotFoundError" || name === "OverconstrainedError" ? "err.camera_missing" : "err.camera_other");
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

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch { return; }
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
      S.lang = b.dataset.lang; store.set("lang", S.lang); applyStaticText(); renderInfo(); render();
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
      else if (e.key === "/" && !typing && !$("cameraDialog").open) { e.preventDefault(); $("search").focus(); }
      else if (e.key === "Escape" && !$("cameraDialog").open) {
        if (S.error) { S.error = null; renderBanner(); }
        else if (S.selected !== null) { S.selected = null; render(); }
      }
    });

    $("speakBtn").addEventListener("click", () => {
      const d = selectedDet();
      if (!d || !("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(t("speak.text", { name: detLabel(d), loc: locText(d) }));
      u.lang = S.lang === "ko" ? "ko-KR" : "en-US";
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
    $("bannerClose").addEventListener("click", () => { S.error = null; renderBanner(); });

    $("copyCoords").addEventListener("click", (e) => { const d = selectedDet(); if (d) copyText(fmtBox(d), e.currentTarget); });
    $("copyJson").addEventListener("click", (e) => copyText(JSON.stringify(exportJson(), null, 2), e.currentTarget));
    $("downloadJson").addEventListener("click", () => {
      download(new Blob([JSON.stringify(exportJson(), null, 2)], { type: "application/json" }), "findit-detections.json");
    });
    $("downloadImage").addEventListener("click", async () => {
      if (!S.result) return;
      const blob = await annotatedBlob();
      if (blob) download(blob, "findit-annotated.jpg");
    });

    $("cameraShoot").addEventListener("click", shootCamera);
    $("cameraCancel").addEventListener("click", closeCamera);
    $("cameraDialog").addEventListener("close", closeCamera);
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
