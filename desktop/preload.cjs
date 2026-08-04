const { contextBridge, ipcRenderer } = require("electron");

// Sandboxed Electron preloads cannot require local CommonJS modules. Keep this bridge
// self-contained so it runs inside the renderer sandbox and exposes only narrow APIs.
let openPdfCallback = null;
let deliveryChain = Promise.resolve();

function normalizePdfPayload(payload) {
  if (!payload || typeof payload.id !== "string" || typeof payload.name !== "string" || !payload.name.trim()) return null;
  const bytes = payload.bytes;
  if (bytes instanceof ArrayBuffer) {
    return { id: payload.id, name: payload.name, path: typeof payload.path === "string" ? payload.path : null, bytes: new Uint8Array(bytes) };
  }
  if (ArrayBuffer.isView(bytes)) {
    return {
      id: payload.id,
      name: payload.name,
      path: typeof payload.path === "string" ? payload.path : null,
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
  }
  return null;
}

ipcRenderer.on("signet:open-pdf", (_event, rawPayload) => {
  const payload = normalizePdfPayload(rawPayload);
  if (!payload || typeof openPdfCallback !== "function") return;
  deliveryChain = deliveryChain.then(async () => {
    try {
      const opened = await openPdfCallback(payload);
      if (opened === false) throw new Error("The editor rejected this PDF.");
      ipcRenderer.send("signet:pdf-open-result", { id: payload.id, ok: true });
    } catch (error) {
      ipcRenderer.send("signet:pdf-open-result", {
        id: payload.id,
        ok: false,
        error: String(error?.message || "The PDF could not be opened."),
      });
    }
  });
});

contextBridge.exposeInMainWorld("signetDesktop", {
  onOpenPdf(callback) {
    if (typeof callback !== "function") return false;
    openPdfCallback = callback;
    ipcRenderer.send("signet:editor-ready");
    return true;
  },
  openDefaultApps() {
    return ipcRenderer.invoke("signet:open-default-apps");
  },
  savePdf(payload) {
    return ipcRenderer.invoke("signet:save-pdf", payload);
  },
});
