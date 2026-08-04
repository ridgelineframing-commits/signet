const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require("electron");
const {
  canOverwritePdf,
  extractPdfPaths,
} = require("./file-handling.cjs");

const SMOKE_TEST = process.argv.includes("--smoke-test") || process.env.SIGNET_SMOKE_TEST === "1";
const APP_URL = "https://signet.ridgeline.workers.dev/";
const APP_ORIGIN = new URL(APP_URL).origin;
const MAX_OPEN_FILE_BYTES = 200 * 1024 * 1024;
let mainWindow = null;
let pendingPdfPaths = extractPdfPaths(process.argv.slice(1));
const writablePdfPaths = new Set();
let editorReady = false;
let inFlightPdf = null;
let deliverySequence = 0;
let deliveryTimer = null;

app.setAppUserModelId("com.ridgelineframing.signet");
app.enableSandbox();
if (SMOKE_TEST) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
}

const hasAllowedOrigin = (candidate) => {
  try {
    return new URL(candidate).origin === APP_ORIGIN;
  } catch {
    return false;
  }
};

async function sendPendingPdfs() {
  if (!editorReady || inFlightPdf || !pendingPdfPaths.length || !mainWindow || mainWindow.isDestroyed()) return;
  const resolvedPath = path.resolve(pendingPdfPaths[0]);
  try {
    const stat = await fs.promises.stat(resolvedPath);
    if (!stat.isFile()) throw new Error("The selected path is not a file.");
    if (stat.size > MAX_OPEN_FILE_BYTES) throw new Error("This PDF is larger than Signet's 200 MB desktop limit.");
    const bytes = await fs.promises.readFile(resolvedPath);
    const id = `${Date.now()}-${++deliverySequence}`;
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    inFlightPdf = { id, path: resolvedPath };
    writablePdfPaths.add(resolvedPath.toLowerCase());
    mainWindow.webContents.send("signet:open-pdf", { id, name: path.basename(resolvedPath), path: resolvedPath, bytes: arrayBuffer });
    deliveryTimer = setTimeout(() => {
      finishPdfDelivery({ id, ok: false, error: "The editor did not respond within 30 seconds." });
    }, 30_000);
  } catch (error) {
    pendingPdfPaths.shift();
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Signet couldn't open this PDF",
      message: `Signet couldn't read ${path.basename(resolvedPath)}.`,
      detail: String(error?.message || "The file may have moved or become unreadable."),
      buttons: ["OK"],
    });
    sendPendingPdfs();
  }
}

async function finishPdfDelivery(payload) {
  if (!inFlightPdf || payload?.id !== inFlightPdf.id) return;
  if (deliveryTimer) clearTimeout(deliveryTimer);
  deliveryTimer = null;
  const completed = inFlightPdf;
  inFlightPdf = null;
  if (payload?.ok === true) {
    if (pendingPdfPaths[0]?.toLowerCase() === completed.path.toLowerCase()) pendingPdfPaths.shift();
    app.addRecentDocument(completed.path);
    sendPendingPdfs();
    return;
  }
  const result = await dialog.showMessageBox(mainWindow, {
    type: "error",
    title: "Signet couldn't open this PDF",
    message: `Signet couldn't open ${path.basename(completed.path)}.`,
    detail: String(payload?.error || "The editor did not accept the file."),
    buttons: ["Retry", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 1 && pendingPdfPaths[0]?.toLowerCase() === completed.path.toLowerCase()) pendingPdfPaths.shift();
  sendPendingPdfs();
}

function queuePdfPaths(argv, workingDirectory) {
  const incoming = extractPdfPaths(argv, workingDirectory);
  const known = new Set(pendingPdfPaths.map((item) => item.toLowerCase()));
  for (const item of incoming) {
    if (!known.has(item.toLowerCase())) pendingPdfPaths.push(item);
  }
  sendPendingPdfs();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#ecebef",
    icon: path.join(__dirname, "icon.ico"),
    title: "Signet PDF Editor",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (!SMOKE_TEST) mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!hasAllowedOrigin(target)) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, _description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !hasAllowedOrigin(validatedUrl)) return;
    if (SMOKE_TEST) return app.exit(2);
    mainWindow.loadFile(path.join(__dirname, "offline.html"));
  });
  mainWindow.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    editorReady = false;
    inFlightPdf = null;
    if (deliveryTimer) clearTimeout(deliveryTimer);
    deliveryTimer = null;
  });

  mainWindow.loadURL(APP_URL);
}

// Smoke tests must be isolated from any real Signet session already open on the PC.
const gotLock = SMOKE_TEST || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine, workingDirectory) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
    queuePdfPaths(commandLine, workingDirectory);
  });

  app.whenReady().then(() => {
    if (SMOKE_TEST) return app.exit(0);
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    ipcMain.handle("signet:open-default-apps", () => shell.openExternal("ms-settings:defaultapps"));
    ipcMain.on("signet:editor-ready", (event) => {
      if (!hasAllowedOrigin(event.senderFrame?.url || "")) return;
      editorReady = true;
      sendPendingPdfs();
    });
    ipcMain.on("signet:pdf-open-result", async (event, payload) => {
      if (!hasAllowedOrigin(event.senderFrame?.url || "") || !inFlightPdf || payload?.id !== inFlightPdf.id) return;
      await finishPdfDelivery(payload);
    });
    ipcMain.handle("signet:save-pdf", async (event, payload) => {
      if (!hasAllowedOrigin(event.senderFrame?.url || "")) throw new Error("Untrusted save request");
      const rawBytes = payload?.bytes;
      if (!(rawBytes instanceof ArrayBuffer) && !ArrayBuffer.isView(rawBytes)) throw new Error("Invalid PDF data");
      const bytes = rawBytes instanceof ArrayBuffer
        ? Buffer.from(rawBytes)
        : Buffer.from(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
      if (!bytes.length || bytes.length > MAX_OPEN_FILE_BYTES) throw new Error("PDF is too large to save");

      const requested = typeof payload?.path === "string" ? path.resolve(payload.path) : "";
      const canOverwrite = canOverwritePdf(requested, writablePdfPaths);
      let target = !payload?.saveAs && canOverwrite ? requested : "";
      if (!target) {
        const suggested = path.basename(String(payload?.suggestedName || "document.pdf")).replace(/[^\w .()-]/g, "_");
        const result = await dialog.showSaveDialog(mainWindow, {
          title: payload?.saveAs ? "Save PDF As" : "Save PDF",
          defaultPath: suggested.toLowerCase().endsWith(".pdf") ? suggested : `${suggested}.pdf`,
          filters: [{ name: "PDF document", extensions: ["pdf"] }],
        });
        if (result.canceled || !result.filePath) return { canceled: true };
        target = result.filePath.toLowerCase().endsWith(".pdf") ? result.filePath : `${result.filePath}.pdf`;
      }
      await fs.promises.writeFile(target, bytes);
      writablePdfPaths.add(path.resolve(target).toLowerCase());
      app.addRecentDocument(target);
      return { canceled: false, path: target, name: path.basename(target) };
    });
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
