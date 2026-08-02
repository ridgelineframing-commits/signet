const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("signetDesktop", {
  onOpenPdf(callback) {
    if (typeof callback !== "function") return;
    ipcRenderer.removeAllListeners("signet:open-pdf");
    ipcRenderer.on("signet:open-pdf", (_event, payload) => {
      if (!payload || typeof payload.name !== "string" || !(payload.bytes instanceof ArrayBuffer)) return;
      callback({ name: payload.name, bytes: new Uint8Array(payload.bytes) });
    });
  },
  openDefaultApps() {
    return ipcRenderer.invoke("signet:open-default-apps");
  },
});
