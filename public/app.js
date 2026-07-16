import * as pdfjsLib from "./vendor/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";
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
  pendingSig: null, pendingText: { size: 14, color: "#191b1f", bold: false, italic: false, underline: false, align: "left" },
  activeText: null,
  pendingImage: null,
  ink: { color: "#dc2b3b", width: 3 },
  shape: { type: "rect", color: "#4f46e5", fill: false, width: 2 },
  placeArmed: false,
};
const RECIPIENT_COLORS = ["#4f46e5", "#17936a", "#b5760b", "#dc2b3b", "#7a3fb5"];
const SVG_NS = "http://www.w3.org/2000/svg";
// pdf.js render scale: canvas px = PDF points * RENDER_SCALE. Used to keep on-canvas text
// sizing and vector stroke widths visually consistent with the exported PDF.
const RENDER_SCALE = 1.4;
const TOOL_LABELS = {
  select: ["Select", "Click any element on the page to select it, or use a tool from the rail."],
  hand: ["Hand", "Drag the page to pan around. Nothing is added to the document."],
  text: ["Text", "Click anywhere on the page, then type directly on it."],
  edittext: ["Edit text", "OCR the page, then edit its existing text in place (Adobe-style)."],
  signature: ["Signature", "Draw, type, or upload a signature, then click the page to place it."],
  draw: ["Draw", "Pick a color and thickness, then drag on the page to draw freehand."],
  shape: ["Shapes", "Pick a shape, then drag on the page to place it."],
  highlight: ["Highlight", "Pick a color, then drag across the page to highlight."],
  image: ["Image", "Upload an image, then click the page to place it."],
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
  invalidateRender();
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
// Rendering (thumbnails + main canvas) reads through pdf.js, which needs the
// serialized bytes of the working document. Serializing + re-parsing on every
// navigation is expensive, so we cache the parsed pdf.js document and only rebuild
// it when the underlying pages actually change (invalidateRender). Reordering or
// navigating pages doesn't change the bytes — it just picks a different page — so
// those paths reuse the cache.
async function getRenderDoc() {
  if (!tk._renderDoc || tk._renderDirty) {
    const bytes = await tk.pdfDoc.save();
    tk._renderDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    tk._renderDirty = false;
  }
  return tk._renderDoc;
}
function invalidateRender() { tk._renderDirty = true; }

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
  const doc = await getRenderDoc();
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

// Lighter re-render for page navigation: the thumbnails don't change, so we just
// move the "current" highlight instead of rebuilding and re-rasterizing them all.
async function fullRerenderLight() { clampPage(); await renderCurrentPage(); updatePageNav(); highlightCurrentThumb(); }
function highlightCurrentThumb() {
  for (const btn of $("thumbList").querySelectorAll(".thumb")) {
    btn.classList.toggle("current", Number(btn.dataset.idx) === tk.currentPage);
  }
}

function clampPage() {
  if (!hasDoc()) { tk.currentPage = 0; return; }
  if (tk.currentPage >= tk.order.length) tk.currentPage = tk.order.length - 1;
  if (tk.currentPage < 0) tk.currentPage = 0;
}

async function renderCurrentPage() {
  const shell = $("pageShell");
  shell.innerHTML = "";
  if (!hasDoc()) return;
  const doc = await getRenderDoc();
  const page = await doc.getPage(tk.order[tk.currentPage] + 1);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width; canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  tk._pageDims = { w: viewport.width, h: viewport.height };

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
    tk.activeText = null;
    document.querySelectorAll("#toolRail [data-tool]").forEach((x) => x.classList.toggle("active", x === b));
    if (hasDoc()) renderCurrentPage(); // text boxes are editable only under Text/Select
    renderPropsPanel();
  };
});

// ------------------------------------------------------------------ marker drawing + canvas interaction
function drawMarker(box, a) {
  if (a.kind === "ink" || a.kind === "shape") return drawVectorMarker(box, a);
  if (a.kind === "text") return drawTextMarker(box, a);
  if (a.kind === "edittext") return drawEditTextMarker(box, a);
  const m = document.createElement("div");
  m.className = "marker";
  m.style.left = a.x * 100 + "%"; m.style.top = a.y * 100 + "%";
  m.style.width = a.w * 100 + "%"; m.style.height = a.h * 100 + "%";
  const isImg = a.kind === "signature" || a.kind === "initials" || a.kind === "image";
  if (a.kind === "redact") { m.style.background = "rgba(0,0,0,.85)"; m.style.borderColor = "#000"; }
  else if (a.kind === "highlight") { m.style.background = hexToRgba(a.color, .35); m.style.borderStyle = "solid"; m.style.borderColor = a.color; }
  else { m.textContent = isImg ? "" : a.kind; }
  if (isImg && a.dataUrl) {
    const img = document.createElement("img"); img.src = a.dataUrl; img.style.width = "100%"; img.style.height = "100%"; img.style.objectFit = "contain"; m.appendChild(img);
    if (a.kind === "image") m.style.border = "none";
  }
  m.appendChild(removeBtn(a));
  box.appendChild(m);
}

// Text is edited directly on the page: the marker itself is contenteditable, so you type
// on the PDF instead of in the side panel. Editable only under the Text/Select tools so it
// doesn't intercept drawing/shape drags. The side panel is a style inspector for the
// currently-focused text (tk.activeText).
function styleTextEl(m, a) {
  m.style.fontSize = (a.size * RENDER_SCALE) + "px";
  m.style.color = a.color || "#191b1f";
  m.style.fontWeight = a.bold ? "700" : "400";
  m.style.fontStyle = a.italic ? "italic" : "normal";
  m.style.textDecoration = a.underline ? "underline" : "none";
  m.style.textAlign = a.align || "left";
}
function drawTextMarker(box, a) {
  const editable = tk.tool === "text" || tk.tool === "select";
  const m = document.createElement("div");
  m.className = "textmarker";
  m.style.cssText = "position:absolute;white-space:pre-wrap;outline:none;padding:0 1px;line-height:1.25";
  m.style.left = a.x * 100 + "%"; m.style.top = a.y * 100 + "%";
  m.style.maxWidth = (100 - a.x * 100) + "%";
  m.textContent = a.text;
  styleTextEl(m, a);
  a._el = m;
  if (editable) {
    m.contentEditable = "true"; m.spellcheck = false;
    m.style.border = "1px dashed " + (a === tk.activeText ? "var(--accent)" : "rgba(120,120,130,.45)");
    m.style.background = "rgba(255,255,255,.5)";
    m.addEventListener("pointerdown", (e) => e.stopPropagation());
    m.addEventListener("click", (e) => e.stopPropagation());
    m.addEventListener("focus", () => { if (tk.activeText !== a) { tk.activeText = a; highlightActiveText(); renderPropsPanel(); } });
    m.addEventListener("input", () => (a.text = m.innerText));
    m.addEventListener("blur", () => {
      a.text = m.innerText;
      if (!a.text.trim()) { tk.annos = tk.annos.filter((x) => x !== a); if (tk.activeText === a) tk.activeText = null; renderCurrentPage(); renderPropsPanel(); }
    });
  } else {
    m.style.pointerEvents = "none";
  }
  box.appendChild(m);
  if (editable) {
    const rm = removeBtn(a);
    rm.style.position = "absolute"; rm.style.left = a.x * 100 + "%"; rm.style.top = a.y * 100 + "%"; rm.style.transform = "translate(-50%,-50%)";
    box.appendChild(rm);
  }
}
function highlightActiveText() {
  document.querySelectorAll("#pageShell .textmarker").forEach((el) => {
    el.style.borderColor = el === tk.activeText?._el ? "var(--accent)" : "rgba(120,120,130,.45)";
  });
}
function placeCaretEnd(el) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

// OCR-recognized text lines: each becomes an editable box sitting exactly over the original
// text. Until you change one it's transparent (you see the real page underneath); once edited
// it turns opaque white so it "covers" the original, previewing the patch that export applies.
function drawEditTextMarker(box, a) {
  const editable = tk.tool === "edittext" || tk.tool === "select";
  const m = document.createElement("div");
  m.className = "edittext";
  m.style.left = a.x * 100 + "%"; m.style.top = a.y * 100 + "%";
  m.style.width = a.w * 100 + "%"; m.style.height = a.h * 100 + "%";
  m.style.fontSize = (a.h * (tk._pageDims?.h || 1000) * 0.82) + "px";
  m.textContent = a.text;
  // Until a line is edited it shows the real page underneath (transparent text over a faint
  // tint); editing/focusing reveals the text on an opaque white patch (see .edittext:focus).
  m.style.background = a.dirty ? "#fff" : (editable ? "rgba(79,70,229,.07)" : "transparent");
  m.style.color = a.dirty ? "#0d0d14" : "transparent";
  a._el = m;
  if (editable) {
    m.contentEditable = "true"; m.spellcheck = false;
    m.addEventListener("pointerdown", (e) => e.stopPropagation());
    m.addEventListener("click", (e) => e.stopPropagation());
    m.addEventListener("input", () => { a.text = m.innerText; if (a.text !== a.origText && !a.dirty) { a.dirty = true; m.style.background = "#fff"; m.style.color = "#0d0d14"; } });
  } else {
    m.style.pointerEvents = "none";
  }
  box.appendChild(m);
  if (editable) {
    const rm = removeBtn(a);
    rm.style.position = "absolute"; rm.style.left = a.x * 100 + "%"; rm.style.top = a.y * 100 + "%"; rm.style.transform = "translate(-50%,-50%)";
    box.appendChild(rm);
  }
}

// ------------------------------------------------------------------ OCR (Tesseract, vendored)
let ocrWorker = null, ocrBusy = false;
async function getOcrWorker(onProgress) {
  if (ocrWorker) return ocrWorker;
  const mod = await import("./vendor/tesseract/tesseract.esm.min.js");
  const createWorker = mod.createWorker || mod.default?.createWorker;
  ocrWorker = await createWorker("eng", 1, {
    workerPath: "/vendor/tesseract/worker.min.js",
    corePath: "/vendor/tesseract/tesseract-core-simd-lstm.wasm.js",
    langPath: "/vendor/tesseract/",
    gzip: true,
    logger: onProgress || undefined,
  });
  return ocrWorker;
}
async function ocrCurrentPage(statusEl) {
  if (!hasDoc() || ocrBusy) return;
  ocrBusy = true;
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  try {
    setStatus("Loading OCR engine… (first run only)");
    const worker = await getOcrWorker((m) => { if (m.status) setStatus(m.status[0].toUpperCase() + m.status.slice(1) + (m.progress ? ` — ${Math.round(m.progress * 100)}%` : "…")); });
    setStatus("Rendering page…");
    const doc = await getRenderDoc();
    const page = await doc.getPage(tk.order[tk.currentPage] + 1);
    const vp = page.getViewport({ scale: 2.5 }); // higher res than the editor canvas for accuracy
    const canvas = document.createElement("canvas");
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    setStatus("Recognizing text…");
    const { data } = await worker.recognize(canvas);
    tk.annos = tk.annos.filter((a) => !(a.kind === "edittext" && a.page === tk.currentPage)); // re-scan replaces
    let n = 0;
    for (const line of data.lines || []) {
      const t = (line.text || "").replace(/\n/g, " ").trim();
      if (!t) continue;
      const bb = line.bbox;
      const x = bb.x0 / canvas.width, y = bb.y0 / canvas.height, w = (bb.x1 - bb.x0) / canvas.width, h = (bb.y1 - bb.y0) / canvas.height;
      if (w <= 0 || h <= 0) continue;
      tk.annos.push({ kind: "edittext", page: tk.currentPage, x, y, w, h, text: t, origText: t, dirty: false });
      n++;
    }
    await renderCurrentPage();
    setStatus(n ? `${n} line${n === 1 ? "" : "s"} recognized — click any line to edit it in place.` : "No text detected on this page.");
  } catch (e) {
    console.error(e); setStatus("OCR failed: " + (e?.message || e));
  } finally {
    ocrBusy = false;
  }
}
function removeBtn(a) {
  const rm = document.createElement("button");
  rm.className = "x"; rm.textContent = "×";
  rm.onclick = (ev) => { ev.stopPropagation(); tk.annos = tk.annos.filter((x) => x !== a); renderCurrentPage(); };
  return rm;
}

// Ink strokes and shapes don't fit the x/y/w/h box model (a line has no area), so they
// render into a full-page SVG overlay in page-fraction coordinates (0-100 viewBox), with a
// separate × button anchored at their bounding box. non-scaling-stroke keeps line weight
// constant regardless of the page's aspect ratio.
function drawVectorMarker(box, a) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible";
  let bbox;
  if (a.kind === "ink") {
    const el = document.createElementNS(SVG_NS, "polyline");
    el.setAttribute("points", a.points.map((p) => `${p.x * 100},${p.y * 100}`).join(" "));
    el.setAttribute("fill", "none"); el.setAttribute("stroke", a.color); el.setAttribute("stroke-width", a.width);
    el.setAttribute("stroke-linecap", "round"); el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(el);
    const xs = a.points.map((p) => p.x), ys = a.points.map((p) => p.y);
    bbox = { x: Math.min(...xs), y: Math.min(...ys) };
  } else {
    for (const el of shapeSvgEls(a)) svg.appendChild(el);
    bbox = { x: Math.min(a.x0, a.x1), y: Math.min(a.y0, a.y1) };
  }
  box.appendChild(svg);
  const rm = removeBtn(a);
  rm.style.position = "absolute"; rm.style.left = bbox.x * 100 + "%"; rm.style.top = bbox.y * 100 + "%"; rm.style.transform = "translate(-50%,-50%)";
  box.appendChild(rm);
}
function shapeSvgEls(a) {
  const x = Math.min(a.x0, a.x1) * 100, y = Math.min(a.y0, a.y1) * 100;
  const w = Math.abs(a.x1 - a.x0) * 100, h = Math.abs(a.y1 - a.y0) * 100;
  const common = (el) => { el.setAttribute("stroke", a.color); el.setAttribute("stroke-width", a.width); el.setAttribute("fill", a.fill ? hexToRgba(a.color, 0.18) : "none"); el.setAttribute("vector-effect", "non-scaling-stroke"); return el; };
  if (a.type === "rect") { const r = document.createElementNS(SVG_NS, "rect"); r.setAttribute("x", x); r.setAttribute("y", y); r.setAttribute("width", w); r.setAttribute("height", h); return [common(r)]; }
  if (a.type === "ellipse") { const e = document.createElementNS(SVG_NS, "ellipse"); e.setAttribute("cx", x + w / 2); e.setAttribute("cy", y + h / 2); e.setAttribute("rx", w / 2); e.setAttribute("ry", h / 2); return [common(e)]; }
  // line / arrow
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", a.x0 * 100); line.setAttribute("y1", a.y0 * 100); line.setAttribute("x2", a.x1 * 100); line.setAttribute("y2", a.y1 * 100);
  common(line); line.setAttribute("stroke-linecap", "round");
  if (a.type === "line") return [line];
  const head = document.createElementNS(SVG_NS, "polyline");
  head.setAttribute("points", arrowHeadPoints(a).map((p) => `${p.x * 100},${p.y * 100}`).join(" "));
  head.setAttribute("fill", "none"); head.setAttribute("stroke", a.color); head.setAttribute("stroke-width", a.width);
  head.setAttribute("stroke-linecap", "round"); head.setAttribute("stroke-linejoin", "round"); head.setAttribute("vector-effect", "non-scaling-stroke");
  return [line, head];
}
// Two short segments forming the arrowhead at (x1,y1), each rotated ±25° back along the shaft.
function arrowHeadPoints(a) {
  const ang = Math.atan2(a.y1 - a.y0, a.x1 - a.x0);
  const len = 0.03, spread = 0.44; // fraction of page; ~25°
  const p1 = { x: a.x1 - len * Math.cos(ang - spread), y: a.y1 - len * Math.sin(ang - spread) };
  const p2 = { x: a.x1 - len * Math.cos(ang + spread), y: a.y1 - len * Math.sin(ang + spread) };
  return [p1, { x: a.x1, y: a.y1 }, p2];
}
function hexToRgba(hex, alpha) {
  const h = (hex || "#ffe14d").replace("#", ""); const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(f, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

let dragState = null;
function ptIn(box, e) { const r = box.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; }
function clampPt(x, y) { return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }; }

function bindCanvasInteraction(box) {
  box.style.cursor = tk.tool === "hand" ? "grab"
    : ["text", "edittext"].includes(tk.tool) ? "text"
    : ["draw", "shape", "highlight", "redact"].includes(tk.tool) ? "crosshair"
    : (["signature", "image"].includes(tk.tool) && tk.placeArmed) ? "copy" : "default";

  box.onclick = (e) => {
    if (dragState && dragState.dragged) { dragState = null; return; }
    const { x, y } = ptIn(box, e);
    if (tk.tool === "text") placeText(x, y);
    else if (tk.tool === "signature" && tk.placeArmed) placeSig(x, y);
    else if (tk.tool === "image" && tk.placeArmed) placeImage(box, x, y);
  };
  box.onpointerdown = (e) => {
    if (tk.tool === "hand") return startPan(box, e);
    if (tk.tool === "draw") return startInk(box, e);
    if (tk.tool === "shape") return startShape(box, e);
    if (["highlight", "redact"].includes(tk.tool)) return startBoxDrag(box, e);
  };
}
function currentToolColor() { return tk.tool === "highlight" ? (tk._hlColor || "#ffe14d") : "#000000"; }

function startPan(box, e) {
  const scroller = $("canvasScroll");
  const sx = scroller.scrollLeft, sy = scroller.scrollTop, px = e.clientX, py = e.clientY;
  box.style.cursor = "grabbing";
  const move = (ev) => { scroller.scrollLeft = sx - (ev.clientX - px); scroller.scrollTop = sy - (ev.clientY - py); };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); box.style.cursor = "grab"; };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}

function startBoxDrag(box, e) {
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
}

function newOverlaySvg() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("preserveAspectRatio", "none");
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible";
  return svg;
}
function startInk(box, e) {
  const rect = box.getBoundingClientRect();
  const pts = [clampPt((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height)];
  dragState = { dragged: false };
  const svg = newOverlaySvg();
  const poly = document.createElementNS(SVG_NS, "polyline");
  poly.setAttribute("fill", "none"); poly.setAttribute("stroke", tk.ink.color); poly.setAttribute("stroke-width", tk.ink.width);
  poly.setAttribute("stroke-linecap", "round"); poly.setAttribute("stroke-linejoin", "round"); poly.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(poly); box.appendChild(svg);
  const draw = () => poly.setAttribute("points", pts.map((p) => `${p.x * 100},${p.y * 100}`).join(" "));
  draw();
  const move = (ev) => { pts.push(clampPt((ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height)); dragState.dragged = true; draw(); };
  const up = () => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
    svg.remove();
    if (pts.length > 1) { tk.annos.push({ kind: "ink", page: tk.currentPage, points: pts, color: tk.ink.color, width: tk.ink.width }); renderCurrentPage(); }
    setTimeout(() => (dragState = null), 0);
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}
function startShape(box, e) {
  const rect = box.getBoundingClientRect();
  const x0 = (e.clientX - rect.left) / rect.width, y0 = (e.clientY - rect.top) / rect.height;
  dragState = { dragged: false };
  const svg = newOverlaySvg(); box.appendChild(svg);
  const render = (x1, y1) => { svg.replaceChildren(...shapeSvgEls({ ...tk.shape, x0, y0, x1, y1 })); };
  const move = (ev) => {
    const x1 = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)), y1 = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    dragState.x1 = x1; dragState.y1 = y1; dragState.dragged = true; render(x1, y1);
  };
  const up = () => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
    svg.remove();
    if (dragState && dragState.dragged && (Math.abs(dragState.x1 - x0) > 0.005 || Math.abs(dragState.y1 - y0) > 0.005)) {
      tk.annos.push({ kind: "shape", type: tk.shape.type, page: tk.currentPage, x0, y0, x1: dragState.x1, y1: dragState.y1, color: tk.shape.color, fill: tk.shape.fill, width: tk.shape.width });
      renderCurrentPage();
    }
    setTimeout(() => (dragState = null), 0);
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}
function placeImage(box, x, y) {
  if (!tk.pendingImage) return;
  const rect = box.getBoundingClientRect();
  const w = 0.28, h = (w * rect.width / tk.pendingImage.ar) / rect.height;
  tk.annos.push({ kind: "image", page: tk.currentPage, x: Math.max(0, x - w / 2), y: Math.max(0, y - h / 2), w, h, dataUrl: tk.pendingImage.dataUrl });
  renderCurrentPage();
}

async function placeText(x, y) {
  const t = tk.pendingText;
  const a = { kind: "text", page: tk.currentPage, x, y, text: "", size: t.size, color: t.color, bold: t.bold, italic: t.italic, underline: t.underline, align: t.align };
  tk.annos.push(a);
  tk.activeText = a;
  await renderCurrentPage();
  if (a._el) { a._el.focus(); placeCaretEnd(a._el); }
  renderPropsPanel();
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
  const builders = { select: buildSelectPanel, hand: buildHandPanel, text: buildTextPanel, edittext: buildEditTextPanel, signature: buildSigPanel, draw: buildDrawPanel, shape: buildShapePanel, highlight: buildHighlightPanel, image: buildImagePanel, redact: buildRedactPanel, watermark: buildWatermarkPanel, pagenum: buildPagenumPanel, organize: buildOrganizePanel };
  (builders[tk.tool] || buildSelectPanel)(body);
}
function buildSelectPanel(body) { body.innerHTML = '<div class="props-empty">Nothing selected.<br>Click any element on the page to remove it (×), or pick a tool from the rail on the left.</div>'; }
function buildHandPanel(body) { body.innerHTML = '<p class="hint">Drag anywhere on the page to pan around. Handy when zoomed in. This tool never changes the document.</p>'; }

function buildEditTextPanel(body) {
  const count = tk.annos.filter((a) => a.kind === "edittext" && a.page === tk.currentPage).length;
  const edited = tk.annos.filter((a) => a.kind === "edittext" && a.page === tk.currentPage && a.dirty).length;
  body.innerHTML = `
    <p class="hint" style="margin-bottom:12px">Make an existing PDF's text editable. Signet reads the current page with OCR, then lets you edit each line right on the page. Edited lines get patched into the exported PDF; untouched text is left exactly as it was.</p>
    <button class="btn primary" id="ocrBtn" style="width:100%;justify-content:center" ${ocrBusy ? "disabled" : ""}>${count ? "Re-scan this page" : "Scan this page for text"}</button>
    <p class="hint" id="ocrStatus" style="margin-top:12px">${count ? `${count} line(s) recognized${edited ? `, ${edited} edited` : ""}.` : ""}</p>
    <p class="hint" style="margin-top:14px;color:var(--sub3)">Patched text is set in Helvetica, so it reads best on plain / white backgrounds. First scan downloads the OCR model once (it's bundled, no network).</p>`;
  $("ocrBtn").onclick = () => ocrCurrentPage($("ocrStatus"));
}

function buildDrawPanel(body) {
  body.innerHTML = `
    <div class="label">Ink color</div>
    <div class="swrow">
      <button class="sw" data-c="#dc2b3b" style="background:#dc2b3b"></button>
      <button class="sw" data-c="#191b1f" style="background:#191b1f"></button>
      <button class="sw" data-c="#4f46e5" style="background:#4f46e5"></button>
      <button class="sw" data-c="#17936a" style="background:#17936a"></button>
      <input type="color" id="inkCustom" value="${tk.ink.color}" style="width:32px;height:32px;border:1px solid var(--line2);border-radius:7px;padding:2px" />
    </div>
    <div class="label" style="margin-top:6px">Thickness <span style="color:var(--sub2);font-weight:500">${tk.ink.width}px</span></div>
    <input type="range" id="inkWidth" min="1" max="10" value="${tk.ink.width}" style="width:100%" />
    <p class="hint" style="margin-top:12px">Drag on the page to draw. Each stroke can be removed with its ×.</p>`;
  document.querySelectorAll('#propsBody .sw').forEach((b) => (b.onclick = () => { tk.ink.color = b.dataset.c; renderPropsPanel(); }));
  $("inkCustom").oninput = (e) => (tk.ink.color = e.target.value);
  $("inkWidth").oninput = (e) => { tk.ink.width = Number(e.target.value); renderPropsPanel(); };
}

function buildShapePanel(body) {
  const types = [["rect", "Rectangle"], ["ellipse", "Ellipse"], ["line", "Line"], ["arrow", "Arrow"]];
  body.innerHTML = `
    <div class="label">Shape</div>
    <div class="row" style="flex-wrap:wrap;margin-bottom:14px">
      ${types.map(([t, lbl]) => `<button class="btn${tk.shape.type === t ? " primary" : ""}" data-st="${t}" style="height:30px">${lbl}</button>`).join("")}
    </div>
    <div class="label">Color</div>
    <div class="swrow">
      <button class="sw" data-c="#4f46e5" style="background:#4f46e5"></button>
      <button class="sw" data-c="#dc2b3b" style="background:#dc2b3b"></button>
      <button class="sw" data-c="#191b1f" style="background:#191b1f"></button>
      <button class="sw" data-c="#17936a" style="background:#17936a"></button>
      <input type="color" id="shColor" value="${tk.shape.color}" style="width:32px;height:32px;border:1px solid var(--line2);border-radius:7px;padding:2px" />
    </div>
    <div class="label" style="margin-top:6px">Thickness <span style="color:var(--sub2);font-weight:500">${tk.shape.width}px</span></div>
    <input type="range" id="shWidth" min="1" max="8" value="${tk.shape.width}" style="width:100%;margin-bottom:12px" />
    <label class="row" style="gap:8px${["line", "arrow"].includes(tk.shape.type) ? ";opacity:.4;pointer-events:none" : ""}"><input type="checkbox" id="shFill" ${tk.shape.fill ? "checked" : ""} /> <span class="hint" style="margin:0">Fill (rectangle / ellipse)</span></label>
    <p class="hint" style="margin-top:12px">Drag on the page to draw the shape.</p>`;
  document.querySelectorAll('#propsBody [data-st]').forEach((b) => (b.onclick = () => { tk.shape.type = b.dataset.st; renderPropsPanel(); }));
  document.querySelectorAll('#propsBody .sw').forEach((b) => (b.onclick = () => { tk.shape.color = b.dataset.c; renderPropsPanel(); }));
  $("shColor").oninput = (e) => (tk.shape.color = e.target.value);
  $("shWidth").oninput = (e) => { tk.shape.width = Number(e.target.value); renderPropsPanel(); };
  $("shFill").onchange = (e) => (tk.shape.fill = e.target.checked);
}

function buildImagePanel(body) {
  body.innerHTML = `
    <div class="label">Image file</div>
    <input type="file" id="imgInput" accept="image/png,image/jpeg" style="width:100%;margin-bottom:12px" />
    <div id="imgPreview"></div>
    <button class="btn primary" id="imgArm" style="width:100%;justify-content:center;margin-top:12px" ${tk.pendingImage ? "" : "disabled"}>${tk.placeArmed && tk.tool === "image" ? "Click the page to place…" : "Click the page to place"}</button>
    <p class="hint" style="margin-top:10px">PNG or JPEG. Aspect ratio is preserved.</p>`;
  $("imgInput").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
    const ar = await new Promise((res) => { const im = new Image(); im.onload = () => res(im.naturalWidth / im.naturalHeight || 1); im.src = dataUrl; });
    tk.pendingImage = { dataUrl, ar };
    renderPropsPanel();
    $("imgPreview").innerHTML = `<img src="${dataUrl}" style="max-width:100%;max-height:120px;border:1px solid var(--line2);border-radius:8px" />`;
  };
  if (tk.pendingImage) $("imgPreview").innerHTML = `<img src="${tk.pendingImage.dataUrl}" style="max-width:100%;max-height:120px;border:1px solid var(--line2);border-radius:8px" />`;
  $("imgArm").onclick = () => { if (!tk.pendingImage) return; tk.placeArmed = !tk.placeArmed; renderPropsPanel(); };
}

function buildTextPanel(body) {
  const a = tk.activeText;
  const t = a || tk.pendingText; // style the focused text box, or set defaults for the next one
  const aligns = [["left", "⬅"], ["center", "⬌"], ["right", "➡"]];
  body.innerHTML = `
    <p class="hint" style="margin-bottom:14px">${a ? "Editing text — type directly on the page. Styling applies to this box." : "Click anywhere on the page to add text, then just type."}</p>
    <div class="row">
      <div class="field"><div class="label">Size</div><input type="number" id="pSize" value="${t.size}" min="6" max="96" style="width:100%" /></div>
      <div class="field"><div class="label">Color</div><input type="color" id="pColor" value="${t.color}" style="width:100%;height:38px" /></div>
    </div>
    <div class="label" style="margin-top:14px">Style</div>
    <div class="row" style="margin-bottom:12px">
      <button class="btn" id="pBold" style="flex:1;justify-content:center;font-weight:800${t.bold ? ";background:var(--chip)" : ""}">B</button>
      <button class="btn" id="pItalic" style="flex:1;justify-content:center;font-style:italic${t.italic ? ";background:var(--chip)" : ""}">i</button>
      <button class="btn" id="pUnderline" style="flex:1;justify-content:center;text-decoration:underline${t.underline ? ";background:var(--chip)" : ""}">U</button>
    </div>
    <div class="label">Align</div>
    <div class="row">
      ${aligns.map(([v, g]) => `<button class="btn" data-align="${v}" style="flex:1;justify-content:center${(t.align || "left") === v ? ";background:var(--chip)" : ""}">${g}</button>`).join("")}
    </div>`;
  // Commit a style change to the focused text (or defaults) and reflect it live on the page.
  const apply = () => { if (a && a._el) styleTextEl(a._el, a); renderPropsPanel(); };
  $("pSize").oninput = (e) => { t.size = Number(e.target.value) || 14; if (a && a._el) styleTextEl(a._el, a); };
  $("pColor").oninput = (e) => { t.color = e.target.value; if (a && a._el) styleTextEl(a._el, a); };
  // preventDefault on mousedown keeps the caret in the on-page text box when toggling styles.
  for (const [id, prop] of [["pBold", "bold"], ["pItalic", "italic"], ["pUnderline", "underline"]]) {
    const btn = $(id);
    btn.onmousedown = (e) => e.preventDefault();
    btn.onclick = () => { t[prop] = !t[prop]; apply(); };
  }
  document.querySelectorAll("#propsBody [data-align]").forEach((b) => {
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => { t.align = b.dataset.align; apply(); };
  });
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
  invalidateRender();
  fullRerender();
}
async function duplicateCurrent() {
  const idx = tk.order[tk.currentPage];
  const [copied] = await tk.pdfDoc.copyPages(tk.pdfDoc, [idx]);
  const newIdx = tk.pdfDoc.getPageCount(); tk.pdfDoc.addPage(copied);
  tk.order.splice(tk.currentPage + 1, 0, newIdx);
  invalidateRender();
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
  tk.pdfDoc.addPage();
  const newIdx = tk.pdfDoc.getPageCount() - 1;
  tk.order.splice(tk.currentPage + 1, 0, newIdx);
  invalidateRender();
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
    } else if (a.kind === "signature" || a.kind === "initials" || a.kind === "image") {
      const bytes = dataUrlToBytes(a.dataUrl);
      const img = await ordered.embedPng(bytes).catch(() => ordered.embedJpg(bytes));
      const w = a.w * width, h = a.h * height;
      const scale = Math.min(w / img.width, h / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      const boxX = a.x * width, boxYtop = a.y * height, y = height - boxYtop - h;
      page.drawImage(img, { x: boxX + (w - dw) / 2, y: y + (h - dh) / 2, width: dw, height: dh });
    } else if (a.kind === "edittext") {
      if (!a.dirty) continue; // untouched OCR lines: leave the original page exactly as-is
      const bx = a.x * width, bw = a.w * width, bh = a.h * height, by = height - a.y * height - bh;
      const padY = bh * 0.18, padX = 2; // over-cover a little so ascenders/descenders of the original are hidden
      page.drawRectangle({ x: bx - padX, y: by - padY, width: bw + padX * 2, height: bh + padY * 2, color: rgb(1, 1, 1) });
      const lines = String(a.text || "").split("\n").filter((l) => l.length);
      if (lines.length) {
        const per = bh / lines.length;
        let size = per * 0.82;
        const widest = Math.max(1, ...lines.map((l) => font.widthOfTextAtSize(l, size)));
        if (widest > bw) size = Math.max(4, size * (bw / widest));
        lines.forEach((l, i) => page.drawText(l, { x: bx, y: by + bh - (i + 1) * per + per * 0.2, size, font, color: rgb(0.05, 0.05, 0.08) }));
      }
    } else if (a.kind === "ink") {
      const c = hexToRgb01(a.color); const col = rgb(c.r, c.g, c.b); const t = a.width / RENDER_SCALE;
      for (let i = 1; i < a.points.length; i++) {
        const p0 = a.points[i - 1], p1 = a.points[i];
        page.drawLine({ start: { x: p0.x * width, y: height - p0.y * height }, end: { x: p1.x * width, y: height - p1.y * height }, thickness: t, color: col });
      }
    } else if (a.kind === "shape") {
      const c = hexToRgb01(a.color); const col = rgb(c.r, c.g, c.b); const bw = a.width / RENDER_SCALE;
      const X0 = a.x0 * width, Y0 = height - a.y0 * height, X1 = a.x1 * width, Y1 = height - a.y1 * height;
      const x = Math.min(X0, X1), yb = Math.min(Y0, Y1), w = Math.abs(X1 - X0), h = Math.abs(Y1 - Y0);
      const fillOpts = a.fill ? { color: col, opacity: 0.18 } : {};
      if (a.type === "rect") page.drawRectangle({ x, y: yb, width: w, height: h, borderColor: col, borderWidth: bw, ...fillOpts });
      else if (a.type === "ellipse") page.drawEllipse({ x: x + w / 2, y: yb + h / 2, xScale: w / 2, yScale: h / 2, borderColor: col, borderWidth: bw, ...fillOpts });
      else {
        page.drawLine({ start: { x: X0, y: Y0 }, end: { x: X1, y: Y1 }, thickness: bw, color: col });
        if (a.type === "arrow") {
          const hp = arrowHeadPoints(a);
          for (const p of [hp[0], hp[2]]) page.drawLine({ start: { x: p.x * width, y: height - p.y * height }, end: { x: X1, y: Y1 }, thickness: bw, color: col });
        }
      }
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
  invalidateRender();
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
