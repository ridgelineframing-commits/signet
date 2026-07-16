import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.1.200/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.1.200/pdf.worker.min.mjs";
const { PDFDocument, degrees, rgb, StandardFonts } = window.PDFLib;
const $ = (id) => document.getElementById(id);
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ------------------------------------------------------------------ auth
const tokenKey = "signet_token";
const getToken = () => localStorage.getItem(tokenKey);
const setToken = (t) => localStorage.setItem(tokenKey, t);
const clearToken = () => localStorage.removeItem(tokenKey);
async function api(path, opts = {}) {
  const headers = opts.headers || {};
  const token = getToken();
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { clearToken(); showLogin(); throw new Error("Not authenticated"); }
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "Request failed"); }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res;
}
function showLogin() { $("loginScreen").hidden = false; $("app").hidden = true; }
function showApp() { $("loginScreen").hidden = true; $("app").hidden = false; }
$("loginBtn").onclick = async () => {
  const password = $("loginPassword").value;
  try {
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    if (!res.ok) throw new Error("wrong");
    const { token } = await res.json();
    setToken(token); showApp(); refreshEnvelopes();
  } catch { $("loginErr").textContent = "Wrong password."; }
};
if (getToken()) showApp(); else showLogin();

// ------------------------------------------------------------------ core state
const tk = {
  pdfDoc: null, order: [], annos: [], fileName: "",
  tool: "select", currentPage: 0, zoom: 100,
  pendingSig: null, pendingText: { text: "Text", size: 14, color: "#191b1f", bold: false, italic: false, underline: false, align: "left" },
  placeArmed: false,
};
const RECIPIENT_COLORS = ["#4f46e5", "#17936a", "#b5760b", "#dc2b3b", "#7a3fb5"];
const TOOL_LABELS = {
  select: ["Select", "Click any element on the page to select it, or use a tool from the rail."],
  text: ["Text", "Set your text below, then click the page to place it."],
  signature: ["Signature", "Draw, type, or upload a signature, then click the page to place it."],
  highlight: ["Highlight", "Pick a color, then drag across the page to highlight."],
  redact: ["Redact", "Drag boxes over anything to black out, then apply."],
  watermark: ["Watermark", "Stamped across every page."],
  pagenum: ["Page numbers", "Stamped on every page."],
  organize: ["Organize pages", "Acts on the page you're currently viewing."],
};

function hasDoc() { return !!tk.pdfDoc && tk.order.length > 0; }

async function loadFiles(files, replacing) {
  if (replacing || !tk.pdfDoc) { tk.pdfDoc = await PDFDocument.create(); tk.order = []; tk.annos = []; tk.currentPage = 0; }
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copied = await tk.pdfDoc.copyPages(src, src.getPageIndices());
    for (const p of copied) { const idx = tk.pdfDoc.getPageCount(); tk.pdfDoc.addPage(p); tk.order.push(idx); }
    if (replacing || !tk.fileName) tk.fileName = file.name;
  }
  $("emptyState").hidden = true;
  $("pageShell").hidden = false;
  $("pageNav").hidden = false;
  $("propsPanel").hidden = false;
  $("downloadBtn").disabled = false;
  $("requestSigBtn").disabled = false;
  $("addPagesBtn").hidden = false;
  $("docTitleLbl").textContent = tk.fileName || "Untitled document";
  $("pageCountChip").hidden = false;
  await fullRerender();
}

$("fileInput").onchange = async (e) => { const files = [...e.target.files]; if (files.length) await loadFiles(files, true); };
$("addPagesInput").onchange = async (e) => { const files = [...e.target.files]; if (files.length) await loadFiles(files, false); };
$("addPagesBtn").onclick = () => $("addPagesInput").click();

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
const emptyState = $("emptyState");
["dragenter", "dragover"].forEach((evt) => emptyState.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); emptyState.classList.add("dragover"); }));
["dragleave", "drop"].forEach((evt) => emptyState.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); emptyState.classList.remove("dragover"); }));
emptyState.addEventListener("drop", async (e) => {
  const files = [...e.dataTransfer.files].filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
  if (files.length) await loadFiles(files, true);
});
// also allow dropping a new doc onto the canvas area generally (adds pages)
$("canvasScroll").addEventListener("drop", async (e) => {
  if (!hasDoc()) return;
  const files = [...e.dataTransfer.files].filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
  if (files.length) { e.preventDefault(); e.stopPropagation(); await loadFiles(files, false); }
});

// ------------------------------------------------------------------ render engine
async function fullRerender() {
  await renderThumbs();
  clampPage();
  await renderCurrentPage();
  updatePageNav();
  renderPropsPanel();
}

async function renderThumbs() {
  const list = $("thumbList");
  list.innerHTML = "";
  if (!hasDoc()) return;
  const bytes = await tk.pdfDoc.save();
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  for (let i = 0; i < tk.order.length; i++) {
    const page = await doc.getPage(tk.order[i] + 1);
    const viewport = page.getViewport({ scale: 0.26 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const btn = document.createElement("button");
    btn.className = "thumb" + (i === tk.currentPage ? " current" : "");
    btn.draggable = true;
    btn.dataset.idx = i;
    const card = document.createElement("div"); card.className = "card"; card.appendChild(canvas);
    const lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = "Page " + (i + 1);
    btn.appendChild(card); btn.appendChild(lbl);
    btn.onclick = () => { tk.currentPage = i; fullRerenderLight(); };
    btn.ondragstart = (ev) => ev.dataTransfer.setData("text/plain", String(i));
    btn.ondragover = (ev) => ev.preventDefault();
    btn.ondrop = (ev) => {
      ev.preventDefault();
      const from = Number(ev.dataTransfer.getData("text/plain"));
      const to = i;
      const [moved] = tk.order.splice(from, 1);
      tk.order.splice(to, 0, moved);
      if (tk.currentPage === from) tk.currentPage = to;
      fullRerender();
    };
    list.appendChild(btn);
  }
}

// lighter re-render used on page navigation (skips full thumb rebuild for annotation-only cases)
async function fullRerenderLight() { clampPage(); await renderCurrentPage(); updatePageNav(); await renderThumbs(); }

function clampPage() {
  if (!hasDoc()) { tk.currentPage = 0; return; }
  if (tk.currentPage >= tk.order.length) tk.currentPage = tk.order.length - 1;
  if (tk.currentPage < 0) tk.currentPage = 0;
}

let currentPageCanvasSize = { w: 0, h: 0 };
async function renderCurrentPage() {
  const shell = $("pageShell");
  shell.innerHTML = "";
  if (!hasDoc()) return;
  const bytes = await tk.pdfDoc.save();
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const page = await doc.getPage(tk.order[tk.currentPage] + 1);
  const viewport = page.getViewport({ scale: 1.4 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width; canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  currentPageCanvasSize = { w: viewport.width, h: viewport.height };

  const box = document.createElement("div");
  box.className = "pagebox";
  box.style.width = viewport.width + "px";
  box.style.height = viewport.height + "px";
  box.appendChild(canvas);
  shell.appendChild(box);
  shell.style.transform = "scale(" + (tk.zoom / 100) + ")";

  for (const a of tk.annos.filter((a) => a.page === tk.currentPage)) drawMarker(box, a);
  bindCanvasInteraction(box);
}

function updatePageNav() {
  if (!hasDoc()) return;
  $("pnLabel").textContent = (tk.currentPage + 1) + " / " + tk.order.length;
  $("pnZoomReset").textContent = tk.zoom + "%";
  $("pageCountChip").textContent = tk.order.length + (tk.order.length === 1 ? " page" : " pages");
}
$("pnPrev").onclick = () => { if (tk.currentPage > 0) { tk.currentPage--; fullRerenderLight(); } };
$("pnNext").onclick = () => { if (tk.currentPage < tk.order.length - 1) { tk.currentPage++; fullRerenderLight(); } };
$("pnZoomOut").onclick = () => { tk.zoom = Math.max(30, tk.zoom - 10); applyZoom(); };
$("pnZoomIn").onclick = () => { tk.zoom = Math.min(400, tk.zoom + 10); applyZoom(); };
$("pnZoomReset").onclick = () => { tk.zoom = 100; applyZoom(); };
function applyZoom() { $("pageShell").style.transform = "scale(" + (tk.zoom / 100) + ")"; $("pnZoomReset").textContent = tk.zoom + "%"; }

// ------------------------------------------------------------------ tool rail
document.querySelectorAll("#toolRail [data-tool]").forEach((b) => {
  b.onclick = () => {
    tk.tool = b.dataset.tool;
    tk.placeArmed = false;
    document.querySelectorAll("#toolRail [data-tool]").forEach((x) => x.classList.toggle("active", x === b));
    renderPropsPanel();
  };
});

// ------------------------------------------------------------------ marker drawing + canvas interaction
function drawMarker(box, a) {
  const m = document.createElement("div");
  m.className = "marker";
  m.style.left = a.x * 100 + "%"; m.style.top = a.y * 100 + "%";
  m.style.width = a.w * 100 + "%"; m.style.height = a.h * 100 + "%";
  if (a.kind === "redact") { m.style.background = "rgba(0,0,0,.85)"; m.style.borderColor = "#000"; }
  else if (a.kind === "highlight") { m.style.background = hexToRgba(a.color, .35); m.style.borderStyle = "solid"; m.style.borderColor = a.color; }
  else { m.textContent = a.kind === "signature" || a.kind === "initials" ? "" : a.kind; }
  if ((a.kind === "signature" || a.kind === "initials") && a.dataUrl) {
    const img = document.createElement("img"); img.src = a.dataUrl; img.style.width = "100%"; img.style.height = "100%"; img.style.objectFit = "contain"; m.appendChild(img);
  }
  if (a.kind === "text") { m.textContent = a.text; m.style.color = a.color || "#191b1f"; m.style.fontSize = "11px"; m.style.borderStyle = "solid"; m.style.background = "rgba(255,255,255,.6)"; }
  const rm = document.createElement("button");
  rm.className = "x"; rm.textContent = "×";
  rm.onclick = (ev) => { ev.stopPropagation(); tk.annos = tk.annos.filter((x) => x !== a); renderCurrentPage(); };
  m.appendChild(rm);
  box.appendChild(m);
}
function hexToRgba(hex, alpha) {
  const h = (hex || "#ffe14d").replace("#", ""); const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(f, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

let dragState = null;
function bindCanvasInteraction(box) {
  box.onclick = (e) => {
    if (dragState && dragState.dragged) { dragState = null; return; }
    const rect = box.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (tk.tool === "text" && tk.placeArmed) placeText(x, y);
    else if (tk.tool === "signature" && tk.placeArmed) placeSig(x, y);
  };
  box.onpointerdown = (e) => {
    if (!["highlight", "redact"].includes(tk.tool)) return;
    const rect = box.getBoundingClientRect();
    dragState = { box, rect, x0: (e.clientX - rect.left) / rect.width, y0: (e.clientY - rect.top) / rect.height, dragged: false };
    const prev = document.createElement("div");
    prev.id = "dragPreview";
    prev.style.position = "absolute"; prev.style.border = "1.5px dashed " + (tk.tool === "redact" ? "#000" : (currentToolColor() || "#ffe14d"));
    prev.style.background = tk.tool === "redact" ? "rgba(0,0,0,.5)" : hexToRgba(currentToolColor(), .3);
    prev.style.pointerEvents = "none";
    box.appendChild(prev);
    const move = (ev) => {
      const x1 = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      const y1 = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
      dragState.x1 = x1; dragState.y1 = y1; dragState.dragged = true;
      const x = Math.min(dragState.x0, x1), y = Math.min(dragState.y0, y1);
      const w = Math.abs(x1 - dragState.x0), h = Math.abs(y1 - dragState.y0);
      prev.style.left = x * 100 + "%"; prev.style.top = y * 100 + "%"; prev.style.width = w * 100 + "%"; prev.style.height = h * 100 + "%";
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      prev.remove();
      if (dragState && dragState.dragged) {
        const x = Math.min(dragState.x0, dragState.x1), y = Math.min(dragState.y0, dragState.y1);
        const w = Math.abs(dragState.x1 - dragState.x0), h = Math.abs(dragState.y1 - dragState.y0);
        if (w > 0.01 && h > 0.01) {
          if (tk.tool === "redact") tk.annos.push({ kind: "redact", page: tk.currentPage, x, y, w, h });
          else tk.annos.push({ kind: "highlight", page: tk.currentPage, x, y, w, h, color: currentToolColor() });
          renderCurrentPage();
        }
      }
      setTimeout(() => { dragState = null; }, 0);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
}
function currentToolColor() { return tk.tool === "highlight" ? (tk._hlColor || "#ffe14d") : "#000000"; }

function placeText(x, y) {
  const t = tk.pendingText;
  tk.annos.push({ kind: "text", page: tk.currentPage, x, y, w: 0.35, h: 0.05, text: t.text, size: t.size, color: t.color, bold: t.bold, italic: t.italic, underline: t.underline, align: t.align });
  renderCurrentPage();
}
function placeSig(x, y) {
  if (!tk.pendingSig) return;
  const isInit = tk.pendingSig.kind === "initials";
  const w = isInit ? 0.09 : 0.24, h = isInit ? 0.05 : 0.09;
  tk.annos.push({ kind: tk.pendingSig.kind, page: tk.currentPage, x, y, w, h, dataUrl: tk.pendingSig.dataUrl });
  renderCurrentPage();
}

// ------------------------------------------------------------------ properties panel
function renderPropsPanel() {
  const [title, hint] = TOOL_LABELS[tk.tool] || ["", ""];
  $("propsTitle").textContent = title;
  $("propsHint").textContent = hint;
  const body = $("propsBody");
  body.innerHTML = "";
  if (!hasDoc() && tk.tool !== "select") { body.innerHTML = '<div class="props-empty">Load a PDF first.</div>'; return; }
  const builders = { select: buildSelectPanel, text: buildTextPanel, signature: buildSigPanel, highlight: buildHighlightPanel, redact: buildRedactPanel, watermark: buildWatermarkPanel, pagenum: buildPagenumPanel, organize: buildOrganizePanel };
  (builders[tk.tool] || buildSelectPanel)(body);
}
function buildSelectPanel(body) { body.innerHTML = '<div class="props-empty">Nothing selected.<br>Click any element on the page to remove it (×), or pick a tool from the rail on the left.</div>'; }

function buildTextPanel(body) {
  const t = tk.pendingText;
  body.innerHTML = `
    <div class="label">Content</div>
    <textarea id="pText" style="width:100%;min-height:56px;margin-bottom:12px">${escapeHtml(t.text)}</textarea>
    <div class="row">
      <div class="field"><div class="label">Size</div><input type="number" id="pSize" value="${t.size}" style="width:100%" /></div>
      <div class="field"><div class="label">Color</div><input type="color" id="pColor" value="${t.color}" style="width:100%;height:38px" /></div>
    </div>
    <div class="label" style="margin-top:14px">Style</div>
    <div class="row" style="margin-bottom:14px">
      <button class="btn" id="pBold" style="flex:1;justify-content:center;font-weight:800${t.bold ? ";background:var(--chip)" : ""}">B</button>
      <button class="btn" id="pItalic" style="flex:1;justify-content:center;font-style:italic${t.italic ? ";background:var(--chip)" : ""}">i</button>
      <button class="btn" id="pUnderline" style="flex:1;justify-content:center;text-decoration:underline${t.underline ? ";background:var(--chip)" : ""}">U</button>
    </div>
    <button class="btn primary" id="pArm" style="width:100%;justify-content:center">${tk.tool === "text" && tk.placeArmed ? "Click the page to place…" : "Click the page to place"}</button>`;
  $("pText").oninput = (e) => (t.text = e.target.value);
  $("pSize").oninput = (e) => (t.size = Number(e.target.value) || 14);
  $("pColor").oninput = (e) => (t.color = e.target.value);
  $("pBold").onclick = () => { t.bold = !t.bold; renderPropsPanel(); };
  $("pItalic").onclick = () => { t.italic = !t.italic; renderPropsPanel(); };
  $("pUnderline").onclick = () => { t.underline = !t.underline; renderPropsPanel(); };
  $("pArm").onclick = () => { tk.placeArmed = !tk.placeArmed; renderPropsPanel(); };
}

let sigPadCtx = null, sigDrawing = false, sigLast = null, sigActiveTab = "draw", sigUploadDataUrl = null;
function buildSigPanel(body) {
  body.innerHTML = `
    <div class="tabbtns">
      <button data-t="draw" class="${sigActiveTab === "draw" ? "active" : ""}">Draw</button>
      <button data-t="type" class="${sigActiveTab === "type" ? "active" : ""}">Type</button>
      <button data-t="upload" class="${sigActiveTab === "upload" ? "active" : ""}">Upload</button>
    </div>
    <div id="sTabDraw" ${sigActiveTab !== "draw" ? "hidden" : ""}>
      <canvas id="sigPad" width="256" height="90"></canvas>
      <button class="btn" id="sigClear" style="width:100%;justify-content:center;margin-top:8px">Clear</button>
    </div>
    <div id="sTabType" ${sigActiveTab !== "type" ? "hidden" : ""}>
      <input type="text" id="sigTypeInput" placeholder="Type your name" style="width:100%;font-size:22px;font-family:'Brush Script MT',cursive;padding:12px" />
    </div>
    <div id="sTabUpload" ${sigActiveTab !== "upload" ? "hidden" : ""}>
      <input type="file" id="sigUploadInput" accept="image/*" style="width:100%" />
    </div>
    <button class="btn primary" id="placeSigBtn" style="width:100%;justify-content:center;margin-top:16px">${tk.placeArmed && tk.pendingSig?.kind === "signature" ? "Click the page to place…" : "Place signature → click on page"}</button>
    <button class="btn" id="placeInitBtn" style="width:100%;justify-content:center;margin-top:8px">${tk.placeArmed && tk.pendingSig?.kind === "initials" ? "Click the page to place…" : "Place initials"}</button>`;
  document.querySelectorAll('#propsBody .tabbtns button').forEach((b) => (b.onclick = () => { sigActiveTab = b.dataset.t; renderPropsPanel(); }));
  if (sigActiveTab === "draw") {
    const pad = $("sigPad"); sigPadCtx = pad.getContext("2d");
    sigPadCtx.lineWidth = 2.4; sigPadCtx.strokeStyle = "#16232f"; sigPadCtx.lineCap = "round";
    const ptFrom = (ev) => { const r = pad.getBoundingClientRect(); const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left; const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY) - r.top; return [cx * (pad.width / r.width), cy * (pad.height / r.height)]; };
    pad.onpointerdown = (ev) => { sigDrawing = true; sigLast = ptFrom(ev); };
    pad.onpointermove = (ev) => { if (!sigDrawing) return; const [x, y] = ptFrom(ev); sigPadCtx.beginPath(); sigPadCtx.moveTo(...sigLast); sigPadCtx.lineTo(x, y); sigPadCtx.stroke(); sigLast = [x, y]; };
    window.addEventListener("pointerup", () => (sigDrawing = false));
    $("sigClear").onclick = () => sigPadCtx.clearRect(0, 0, pad.width, pad.height);
  }
  if (sigActiveTab === "upload") {
    $("sigUploadInput").onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      sigUploadDataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
    };
  }
  async function buildDataUrl() {
    if (sigActiveTab === "draw") return $("sigPad").toDataURL("image/png");
    if (sigActiveTab === "type") {
      const name = $("sigTypeInput").value || "Signed";
      const c = document.createElement("canvas"); c.width = 500; c.height = 140;
      const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height);
      cx.fillStyle = "#16232f"; cx.font = "56px 'Brush Script MT', cursive"; cx.fillText(name, 20, 90);
      return c.toDataURL("image/png");
    }
    return sigUploadDataUrl;
  }
  $("placeSigBtn").onclick = async () => {
    const dataUrl = await buildDataUrl(); if (!dataUrl) return alert("Draw, type, or upload a signature first.");
    tk.pendingSig = { dataUrl, kind: "signature" }; tk.placeArmed = true; renderPropsPanel();
  };
  $("placeInitBtn").onclick = async () => {
    const dataUrl = await buildDataUrl(); if (!dataUrl) return alert("Draw, type, or upload a signature first.");
    tk.pendingSig = { dataUrl, kind: "initials" }; tk.placeArmed = true; renderPropsPanel();
  };
}

function buildHighlightPanel(body) {
  tk._hlColor = tk._hlColor || "#ffe14d";
  body.innerHTML = `
    <div class="label">Highlight color</div>
    <div class="swrow">
      <button class="sw" data-c="#ffe14d" style="background:#ffe14d"></button>
      <button class="sw" data-c="#a6f0c6" style="background:#a6f0c6"></button>
      <button class="sw" data-c="#bcd7ff" style="background:#bcd7ff"></button>
      <button class="sw" data-c="#ffc4dd" style="background:#ffc4dd"></button>
      <input type="color" id="hlCustom" value="${tk._hlColor}" style="width:32px;height:32px;border:1px solid var(--line2);border-radius:7px;padding:2px" />
    </div>
    <p class="hint">Drag across the page to highlight an area.</p>`;
  document.querySelectorAll('#propsBody .sw').forEach((b) => (b.onclick = () => { tk._hlColor = b.dataset.c; renderPropsPanel(); }));
  $("hlCustom").oninput = (e) => (tk._hlColor = e.target.value);
}

function buildRedactPanel(body) {
  const count = tk.annos.filter((a) => a.kind === "redact").length;
  body.innerHTML = `
    <p class="hint">Drag boxes over anything to black out. Nothing is removed until you apply.</p>
    <div class="row" style="background:var(--badbg);border:1px solid var(--badline);border-radius:9px;padding:10px 12px;margin:12px 0">
      <div style="width:22px;height:22px;border-radius:5px;background:#191b1f;flex:0 0 auto"></div>
      <span style="font-size:12px;color:#8a4b4b">${count} box${count === 1 ? "" : "es"} marked on this document.</span>
    </div>
    <button class="btn danger" id="applyRedact" style="width:100%;justify-content:center" ${count ? "" : "disabled"}>Apply &amp; flatten redactions</button>`;
  $("applyRedact").onclick = flattenNow;
}

function buildWatermarkPanel(body) {
  tk._wm = tk._wm || { text: "DRAFT", opacity: 20, angle: -45 };
  body.innerHTML = `
    <div class="label">Text</div><input type="text" id="wmText" value="${escapeHtml(tk._wm.text)}" style="width:100%;margin-bottom:12px" />
    <div class="label">Opacity <span style="color:var(--sub2);font-weight:500">${tk._wm.opacity}%</span></div><input type="range" id="wmOpacity" min="5" max="60" value="${tk._wm.opacity}" style="width:100%;margin-bottom:12px" />
    <div class="label">Angle</div><input type="number" id="wmAngle" value="${tk._wm.angle}" style="width:100%;margin-bottom:16px" />
    <button class="btn primary" id="wmApply" style="width:100%;justify-content:center">Apply to all pages</button>`;
  $("wmApply").onclick = () => {
    tk._wm.text = $("wmText").value || "DRAFT"; tk._wm.opacity = Number($("wmOpacity").value); tk._wm.angle = Number($("wmAngle").value);
    tk.annos = tk.annos.filter((a) => a.kind !== "watermark");
    for (let i = 0; i < tk.order.length; i++) tk.annos.push({ kind: "watermark", page: i, text: tk._wm.text, opacity: tk._wm.opacity / 100, angle: tk._wm.angle });
    renderCurrentPage(); alert("Watermark applied to all " + tk.order.length + " pages. It'll appear in the exported/sent PDF.");
  };
}
function buildPagenumPanel(body) {
  tk._pn = tk._pn || { start: 1, pos: "bc" };
  body.innerHTML = `
    <div class="label">Start at</div><input type="number" id="pnStart" value="${tk._pn.start}" style="width:100%;margin-bottom:12px" />
    <div class="label">Position</div>
    <select id="pnPos" style="width:100%;margin-bottom:16px">
      <option value="bc" ${tk._pn.pos === "bc" ? "selected" : ""}>Bottom center</option>
      <option value="br" ${tk._pn.pos === "br" ? "selected" : ""}>Bottom right</option>
      <option value="tr" ${tk._pn.pos === "tr" ? "selected" : ""}>Top right</option>
    </select>
    <button class="btn primary" id="pnApply" style="width:100%;justify-content:center">Apply to all pages</button>`;
  $("pnApply").onclick = () => {
    tk._pn.start = Number($("pnStart").value) || 1; tk._pn.pos = $("pnPos").value;
    tk.annos = tk.annos.filter((a) => a.kind !== "pagenum");
    for (let i = 0; i < tk.order.length; i++) tk.annos.push({ kind: "pagenum", page: i, number: tk._pn.start + i, pos: tk._pn.pos });
    renderCurrentPage(); alert("Page numbers applied. They'll appear in the exported/sent PDF.");
  };
}
function buildOrganizePanel(body) {
  body.innerHTML = `
    <div class="label">This page</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <button class="btn" id="orgRotL" style="flex-direction:column;height:60px">⟲<br><span style="font-size:11px">Rotate left</span></button>
      <button class="btn" id="orgRotR" style="flex-direction:column;height:60px">⟳<br><span style="font-size:11px">Rotate right</span></button>
      <button class="btn" id="orgDup" style="flex-direction:column;height:60px">⧉<br><span style="font-size:11px">Duplicate</span></button>
      <button class="btn danger" id="orgDel" style="flex-direction:column;height:60px">🗑<br><span style="font-size:11px">Delete</span></button>
    </div>
    <button class="btn" id="orgExtract" style="width:100%;justify-content:center;margin-bottom:8px">Extract this page → new PDF</button>
    <button class="btn" id="orgInsertBlank" style="width:100%;justify-content:center">+ Insert blank page after</button>
    <p class="hint" style="margin-top:14px">Tip: drag pages in the rail on the left to reorder them.</p>`;
  $("orgRotL").onclick = () => rotateCurrent(-90);
  $("orgRotR").onclick = () => rotateCurrent(90);
  $("orgDup").onclick = duplicateCurrent;
  $("orgDel").onclick = deleteCurrent;
  $("orgExtract").onclick = extractCurrent;
  $("orgInsertBlank").onclick = insertBlankAfterCurrent;
}
function rotateCurrent(delta) {
  const page = tk.pdfDoc.getPage(tk.order[tk.currentPage]);
  page.setRotation(degrees((page.getRotation().angle + delta + 360) % 360));
  fullRerender();
}
async function duplicateCurrent() {
  const idx = tk.order[tk.currentPage];
  const [copied] = await tk.pdfDoc.copyPages(tk.pdfDoc, [idx]);
  const newIdx = tk.pdfDoc.getPageCount(); tk.pdfDoc.addPage(copied);
  tk.order.splice(tk.currentPage + 1, 0, newIdx);
  fullRerender();
}
function deleteCurrent() {
  if (tk.order.length <= 1) return alert("Can't delete the only page.");
  tk.order.splice(tk.currentPage, 1);
  tk.annos = tk.annos.filter((a) => a.page !== tk.currentPage).map((a) => (a.page > tk.currentPage ? { ...a, page: a.page - 1 } : a));
  fullRerender();
}
async function extractCurrent() {
  const newDoc = await PDFDocument.create();
  const [copied] = await newDoc.copyPages(tk.pdfDoc, [tk.order[tk.currentPage]]);
  newDoc.addPage(copied);
  downloadBytes(await newDoc.save(), "page-" + (tk.currentPage + 1) + ".pdf");
}
function insertBlankAfterCurrent() {
  const page = tk.pdfDoc.addPage();
  const newIdx = tk.pdfDoc.getPageCount() - 1;
  tk.order.splice(tk.currentPage + 1, 0, newIdx);
  fullRerender();
}

// ------------------------------------------------------------------ bake / export / flatten
async function bakeAndExport() {
  const ordered = await PDFDocument.create();
  const copied = await ordered.copyPages(tk.pdfDoc, tk.order);
  copied.forEach((p) => ordered.addPage(p));
  const font = await ordered.embedFont(StandardFonts.Helvetica);
  const fontBold = await ordered.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await ordered.embedFont(StandardFonts.HelveticaOblique);
  const fontBoldItalic = await ordered.embedFont(StandardFonts.HelveticaBoldOblique);
  const pages = ordered.getPages();
  for (const a of tk.annos) {
    const page = pages[a.page]; if (!page) continue;
    const { width, height } = page.getSize();
    if (a.kind === "watermark") {
      page.drawText(a.text, { x: width * 0.15, y: height * 0.45, size: Math.min(width, height) * 0.09, font, color: rgb(0.4, 0.4, 0.4), opacity: a.opacity, rotate: degrees(a.angle) });
    } else if (a.kind === "pagenum") {
      const label = String(a.number); let x = width / 2 - 6, y = 18;
      if (a.pos === "br") x = width - 40; if (a.pos === "tr") { x = width - 40; y = height - 28; }
      page.drawText(label, { x, y, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
    } else if (a.kind === "redact") {
      const x = a.x * width, w = a.w * width, h = a.h * height, y = height - a.y * height - h;
      page.drawRectangle({ x, y, width: w, height: h, color: rgb(0, 0, 0) });
    } else if (a.kind === "highlight") {
      const x = a.x * width, w = a.w * width, h = a.h * height, y = height - a.y * height - h;
      const c = hexToRgb01(a.color);
      page.drawRectangle({ x, y, width: w, height: h, color: rgb(c.r, c.g, c.b), opacity: 0.4 });
    } else if (a.kind === "text") {
      const x = a.x * width, yTop = a.y * height;
      const f = a.bold && a.italic ? fontBoldItalic : a.bold ? fontBold : a.italic ? fontItalic : font;
      const c = hexToRgb01(a.color || "#191b1f");
      const lines = String(a.text || "").split("\n");
      lines.forEach((line, i) => {
        let lx = x + 2;
        if (a.align === "center") lx = x + (a.w * width) / 2 - (f.widthOfTextAtSize(line, a.size) / 2);
        if (a.align === "right") lx = x + a.w * width - f.widthOfTextAtSize(line, a.size) - 2;
        const ly = height - yTop - a.size - i * (a.size * 1.25);
        page.drawText(line, { x: lx, y: ly, size: a.size, font: f, color: rgb(c.r, c.g, c.b) });
        if (a.underline) page.drawLine({ start: { x: lx, y: ly - 2 }, end: { x: lx + f.widthOfTextAtSize(line, a.size), y: ly - 2 }, thickness: 1, color: rgb(c.r, c.g, c.b) });
      });
    } else if (a.kind === "signature" || a.kind === "initials") {
      const bytes = dataUrlToBytes(a.dataUrl);
      const img = await ordered.embedPng(bytes).catch(() => ordered.embedJpg(bytes));
      const w = a.w * width, h = a.h * height;
      const scale = Math.min(w / img.width, h / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      const boxX = a.x * width, boxYtop = a.y * height, y = height - boxYtop - h;
      page.drawImage(img, { x: boxX + (w - dw) / 2, y: y + (h - dh) / 2, width: dw, height: dh });
    }
  }
  return ordered.save();
}
function hexToRgb01(hex) { const h = (hex || "#000000").replace("#", ""); const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h; const n = parseInt(f, 16); return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }; }

async function rasterizePdf(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const out = await PDFDocument.create();
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const png = dataUrlToBytes(canvas.toDataURL("image/png"));
    const img = await out.embedPng(png);
    const p = out.addPage([viewport.width / 2, viewport.height / 2]);
    p.drawImage(img, { x: 0, y: 0, width: viewport.width / 2, height: viewport.height / 2 });
  }
  return out.save();
}
function dataUrlToBytes(dataUrl) { const b64 = dataUrl.split(",")[1]; const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return bytes; }
function downloadBytes(bytes, filename) { const blob = new Blob([bytes], { type: "application/pdf" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }

async function flattenNow() {
  if (!tk.annos.some((a) => a.kind === "redact")) return alert("Mark at least one redaction box first.");
  const baked = await bakeAndExport();
  const rasterized = await rasterizePdf(baked);
  tk.pdfDoc = await PDFDocument.load(rasterized);
  tk.order = tk.pdfDoc.getPageIndices();
  tk.annos = [];
  await fullRerender();
  alert("Redactions applied and flattened — the underlying content is permanently removed.");
}

$("downloadBtn").onclick = async () => { if (!hasDoc()) return; const bytes = await bakeAndExport(); downloadBytes(bytes, (tk.fileName || "signet-export").replace(/\.pdf$/i, "") + "-export.pdf"); };

// ------------------------------------------------------------------ envelopes: requests drawer
const STATUS_LABEL = { draft: "Draft", sent: "Sent", partially_signed: "Partially signed", completed: "Completed", voided: "Voided", declined: "Declined" };
const STATUS_COLOR = { draft: ["#eef2f6", "#5b6068"], sent: ["#eef1ff", "#4f46e5"], partially_signed: ["#fff3e0", "#b5760b"], completed: ["#e4f6ea", "#17936a"], voided: ["#fbf5f5", "#dc2b3b"], declined: ["#fbf5f5", "#dc2b3b"] };
const envelopesPanel = $("envelopesPanelBack");
$("openEnvelopesBtn").onclick = () => { envelopesPanel.hidden = false; refreshEnvelopes(); };
$("closeEnvelopesPanel").onclick = () => (envelopesPanel.hidden = true);

async function refreshEnvelopes() {
  try {
    const { envelopes } = await api("/api/admin/envelopes");
    const wrap = $("envCards"); wrap.innerHTML = "";
    $("envEmpty").hidden = envelopes.length > 0;
    for (const e of envelopes) {
      const [bg, fg] = STATUS_COLOR[e.status] || ["#eef2f6", "#5b6068"];
      const pct = e.recipient_count ? Math.round((e.signed_count / e.recipient_count) * 100) : 0;
      const card = document.createElement("div"); card.className = "envcard";
      card.innerHTML = `
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div style="font-size:14px;font-weight:600">${escapeHtml(e.title)}</div>
          <span class="pill" style="background:${bg};color:${fg}">${STATUS_LABEL[e.status] || e.status}</span>
        </div>
        <div class="row" style="margin-top:12px"><div class="pbar"><i style="background:${fg};width:${pct}%"></i></div><span class="hint" style="white-space:nowrap">${e.signed_count}/${e.recipient_count} signed</span></div>
        <div class="hint" style="margin-top:8px">Sent ${e.sent_at ? new Date(e.sent_at).toLocaleDateString() : "—"} &nbsp;·&nbsp; <a href="#" data-open="${e.id}" style="color:var(--accent)">View →</a></div>`;
      card.querySelector("[data-open]").onclick = (ev) => { ev.preventDefault(); openEnvelope(e.id); };
      wrap.appendChild(card);
    }
  } catch (e) { console.error(e); }
}
async function openEnvelope(id) {
  const { envelope, recipients, audit } = await api(`/api/admin/envelopes/${id}`);
  const card = $("envDetailCard");
  card.innerHTML = `
    <div class="row" style="justify-content:space-between"><div style="font-size:15px;font-weight:700">${escapeHtml(envelope.title)}</div><span class="pill" style="background:${STATUS_COLOR[envelope.status][0]};color:${STATUS_COLOR[envelope.status][1]}">${STATUS_LABEL[envelope.status] || envelope.status}</span></div>
    <div class="label" style="margin-top:14px">Recipients</div>
    ${recipients.map((r) => `<div class="rowbox"><div class="avatar">${escapeHtml((r.name || "?").slice(0, 2).toUpperCase())}</div><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600">${escapeHtml(r.name)}</div><div class="hint">${escapeHtml(r.email)}</div></div><span class="chip">${r.role}</span><span class="hint">${r.status}</span>${r.status !== "signed" ? `<button class="btn" data-remind="${r.id}" style="height:28px;padding:0 8px">Remind</button>` : ""}</div>`).join("")}
    <div class="label" style="margin-top:14px">Audit trail</div>
    <div style="max-height:160px;overflow:auto">${audit.map((a) => `<div class="hint" style="padding:4px 0;border-bottom:1px solid #eeeef1">${new Date(a.created_at).toLocaleString()} — ${a.event}${a.detail ? " — " + escapeHtml(a.detail) : ""}</div>`).join("")}</div>
    <div class="row" style="margin-top:14px">
      ${envelope.status === "completed" ? `<a class="btn primary" href="/api/admin/envelopes/${envelope.id}/download">Download signed PDF</a>` : ""}
      ${!["voided", "completed", "declined"].includes(envelope.status) ? `<button class="btn danger" id="voidBtn">Void envelope</button>` : ""}
    </div>`;
  card.querySelectorAll("[data-remind]").forEach((b) => (b.onclick = async () => { await api(`/api/admin/envelopes/${id}/remind/${b.dataset.remind}`, { method: "POST" }); alert("Reminder sent."); }));
  const voidBtn = card.querySelector("#voidBtn");
  if (voidBtn) voidBtn.onclick = async () => { if (confirm("Void this envelope? Signers will no longer be able to sign.")) { await api(`/api/admin/envelopes/${id}/void`, { method: "POST" }); openEnvelope(id); refreshEnvelopes(); } };
}

// ------------------------------------------------------------------ send-for-signature wizard
const ev = { file: null, presetFile: null, pdfDoc: null, recipients: [{ name: "", email: "", order: 1, role: "signer" }], fields: [], currentRecipient: 0, currentFieldType: "signature" };
const envModal = $("envModalBack");
function renderRecipientsList() {
  const wrap = $("recipientsList"); wrap.innerHTML = "";
  ev.recipients.forEach((r, i) => {
    const row = document.createElement("div"); row.className = "rowbox";
    row.innerHTML = `
      <div class="dot" style="background:${RECIPIENT_COLORS[i % 5]}"></div>
      <input type="text" placeholder="Name" class="r-name" value="${escapeHtml(r.name)}" style="flex:1;min-width:0" />
      <input type="email" placeholder="Email" class="r-email" value="${escapeHtml(r.email)}" style="flex:1;min-width:0" />
      <input type="number" placeholder="Order" class="r-order" value="${r.order}" style="width:58px" />
      <select class="r-role" style="width:96px"><option value="signer" ${r.role === "signer" ? "selected" : ""}>Signer</option><option value="approver" ${r.role === "approver" ? "selected" : ""}>Approver</option><option value="cc" ${r.role === "cc" ? "selected" : ""}>CC only</option></select>
      <button class="closex" style="width:30px;height:30px" data-rm>&#10005;</button>`;
    row.querySelector(".r-name").oninput = (e) => (r.name = e.target.value);
    row.querySelector(".r-email").oninput = (e) => (r.email = e.target.value);
    row.querySelector(".r-order").oninput = (e) => (r.order = Number(e.target.value) || 1);
    row.querySelector(".r-role").onchange = (e) => (r.role = e.target.value);
    row.querySelector("[data-rm]").onclick = () => { ev.recipients.splice(i, 1); renderRecipientsList(); };
    wrap.appendChild(row);
  });
}
$("addRecipientBtn").onclick = () => { ev.recipients.push({ name: "", email: "", order: 1, role: "signer" }); renderRecipientsList(); };

function openEnvelopeWizard(presetFile, presetTitle) {
  ev.file = null; ev.presetFile = presetFile || null; ev.pdfDoc = null; ev.fields = []; ev.currentRecipient = 0;
  ev.recipients = [{ name: "", email: "", order: 1, role: "signer" }];
  $("envTitle").value = presetTitle || (presetFile ? presetFile.name.replace(/\.pdf$/i, "") : "");
  $("envMessage").value = "";
  $("envModalDoc").textContent = presetFile ? presetFile.name : "Choose a PDF below";
  renderRecipientsList();
  $("envStep1").hidden = false; $("envStep2").hidden = true;
  $("envBack").hidden = true; $("envNext").hidden = false; $("envSend").hidden = true;
  $("envFootHint").textContent = "Next: drop signature fields onto the document.";
  envModal.hidden = false;
}
$("envCancel").onclick = () => (envModal.hidden = true);
$("requestSigBtn").onclick = async () => {
  if (!hasDoc()) return;
  const bytes = await bakeAndExport();
  const file = new File([bytes], (tk.fileName || "edited-document.pdf"), { type: "application/pdf" });
  envelopesPanel.hidden = false;
  openEnvelopeWizard(file);
};

const FIELD_DEFAULT_SIZE = { signature: [0.28, 0.09], initials: [0.1, 0.06], date: [0.16, 0.04], text: [0.24, 0.04], checkbox: [0.04, 0.04] };
$("envNext").onclick = async () => {
  const nextBtn = $("envNext");
  try {
    const file = ev.presetFile; if (!file) return alert("This envelope needs a document — send one from the PDF Editor first via \"Send for signature\".");
    const recipients = ev.recipients.filter((r) => r.name.trim() && r.email.trim());
    if (!recipients.length) return alert("Add at least one recipient with a name and email.");
    ev.recipients = recipients;
    nextBtn.disabled = true; nextBtn.textContent = "Loading…";
    ev.fields = [];
    const bytes = new Uint8Array(await file.arrayBuffer());
    ev.pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

    const chips = $("recipientChips"); chips.innerHTML = "";
    recipients.forEach((r, i) => {
      const chip = document.createElement("button");
      chip.className = "btn" + (i === 0 ? " primary" : "");
      chip.style.height = "30px"; chip.textContent = `${r.name} (${r.role})`;
      chip.onclick = () => { ev.currentRecipient = i; [...chips.children].forEach((c) => c.classList.remove("primary")); chip.classList.add("primary"); };
      chips.appendChild(chip);
    });
    ev.currentRecipient = 0;

    const ftWrap = $("fieldTypeBtns"); ftWrap.innerHTML = "";
    ["signature", "initials", "date", "text", "checkbox"].forEach((ft, i) => {
      const b = document.createElement("button");
      b.className = "btn" + (i === 0 ? " primary" : ""); b.style.height = "30px"; b.textContent = ft[0].toUpperCase() + ft.slice(1);
      b.onclick = () => { ev.currentFieldType = ft; [...ftWrap.children].forEach((c) => c.classList.remove("primary")); b.classList.add("primary"); };
      ftWrap.appendChild(b);
    });
    ev.currentFieldType = "signature";

    await renderEnvPages(bytes);
    $("envStep1").hidden = true; $("envStep2").hidden = false;
    $("envBack").hidden = false; $("envNext").hidden = true; $("envSend").hidden = false;
    $("envFootHint").textContent = "Click the document to drop the selected field for the selected recipient.";
  } catch (err) { console.error(err); alert("Couldn't load that PDF for field placement: " + (err?.message || err)); }
  finally { nextBtn.disabled = false; nextBtn.textContent = "Continue → place fields"; }
};
$("envBack").onclick = () => { $("envStep1").hidden = false; $("envStep2").hidden = true; $("envBack").hidden = true; $("envNext").hidden = false; $("envSend").hidden = true; $("envFootHint").textContent = "Next: drop signature fields onto the document."; };

async function renderEnvPages(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const wrap = $("envPagesWrap"); wrap.innerHTML = "";
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const viewport = page.getViewport({ scale: 0.42 });
    const canvas = document.createElement("canvas"); canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const box = document.createElement("div"); box.style.position = "relative"; box.style.border = "1px solid var(--line)"; box.appendChild(canvas);
    wrap.appendChild(box);
    box.onclick = (e) => placeEnvField(e, box, i);
    drawEnvMarkers(box, i);
  }
}
function drawEnvMarkers(box, pageIdx) {
  box.querySelectorAll(".marker").forEach((n) => n.remove());
  ev.fields.filter((f) => f.page === pageIdx).forEach((f) => {
    const m = document.createElement("div"); m.className = "marker";
    m.style.left = f.x * 100 + "%"; m.style.top = f.y * 100 + "%"; m.style.width = f.w * 100 + "%"; m.style.height = f.h * 100 + "%";
    m.style.borderColor = RECIPIENT_COLORS[f.recipientIndex % 5]; m.textContent = f.type;
    const rm = document.createElement("button"); rm.className = "x"; rm.textContent = "×";
    rm.onclick = (e2) => { e2.stopPropagation(); ev.fields = ev.fields.filter((x) => x !== f); drawEnvMarkers(box, pageIdx); };
    m.appendChild(rm); box.appendChild(m);
  });
}
function placeEnvField(e, box, pageIdx) {
  const rect = box.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width, y = (e.clientY - rect.top) / rect.height;
  const [w, h] = FIELD_DEFAULT_SIZE[ev.currentFieldType];
  ev.fields.push({ recipientIndex: ev.currentRecipient, type: ev.currentFieldType, page: pageIdx, x, y: Math.max(0, y - h / 2), w, h, required: true, label: ev.currentFieldType });
  drawEnvMarkers(box, pageIdx);
}
$("envSend").onclick = async () => {
  if (!ev.fields.length) return alert("Place at least one field before sending.");
  const form = new FormData();
  form.append("title", $("envTitle").value || "Untitled document");
  form.append("message", $("envMessage").value || "");
  form.append("senderName", $("envSenderName").value || "");
  form.append("senderEmail", $("envSenderEmail").value || "");
  form.append("file", ev.presetFile);
  form.append("recipients", JSON.stringify(ev.recipients));
  form.append("fields", JSON.stringify(ev.fields));
  form.append("sendNow", "true");
  try { await api("/api/admin/envelopes", { method: "POST", body: form }); envModal.hidden = true; refreshEnvelopes(); }
  catch (e) { alert("Couldn't send: " + e.message); }
};

if (getToken()) refreshEnvelopes();
renderPropsPanel();
