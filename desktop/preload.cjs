const { contextBridge, ipcRenderer } = require("electron");
const { createPdfOpenDelivery } = require("./pdf-open-delivery.cjs");

// Start listening during preload, before the remote editor's scripts execute. A PDF may be
// sent as soon as navigation finishes; buffering here prevents cold-start launches from
// losing that one-time message while the editor is still registering its callback.
const pdfDelivery = createPdfOpenDelivery();
ipcRenderer.on("signet:open-pdf", (_event, payload) => pdfDelivery.receive(payload));

contextBridge.exposeInMainWorld("signetDesktop", {
  onOpenPdf(callback) {
    pdfDelivery.subscribe(callback);
  },
  openDefaultApps() {
    return ipcRenderer.invoke("signet:open-default-apps");
  },
  savePdf(payload) {
    return ipcRenderer.invoke("signet:save-pdf", payload);
  },
});
