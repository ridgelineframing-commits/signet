const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, Menu, ipcMain, session, shell } = require("electron");
const {
  extractPdfPaths,
  registerWindowsPdfHandler,
  unregisterWindowsPdfHandler,
} = require("./file-handling.cjs");

const squirrelCommand = process.platform === "win32" ? process.argv[1] : "";
if (squirrelCommand === "--squirrel-install" || squirrelCommand === "--squirrel-updated") {
  registerWindowsPdfHandler();
} else if (squirrelCommand === "--squirrel-uninstall") {
  unregisterWindowsPdfHandler();
}

if (require("electron-squirrel-startup")) app.quit();

const APP_URL = "https://signet.ridgeline.workers.dev/";
const APP_ORIGIN = new URL(APP_URL).origin;
const SMOKE_TEST = process.argv.includes("--smoke-test");
const MAX_OPEN_FILE_BYTES = 200 * 1024 * 1024;
let mainWindow = null;
let pendingPdfPaths = extractPdfPaths(process.argv.slice(1));

app.setAppUserModelId("com.squirrel.SignetPDFEditor.SignetPDFEditor");
app.enableSandbox();
if (SMOKE_TEST) app.commandLine.appendSwitch("disable-gpu");

const hasAllowedOrigin = (candidate) => {
  try {
    return new URL(candidate).origin === APP_ORIGIN;
  } catch {
    return false;
  }
};

async function sendPendingPdfs() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  const paths = pendingPdfPaths;
  pendingPdfPaths = [];
  for (const pdfPath of paths) {
    try {
      const stat = await fs.promises.stat(pdfPath);
      if (!stat.isFile() || stat.size > MAX_OPEN_FILE_BYTES) continue;
      const bytes = await fs.promises.readFile(pdfPath);
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      mainWindow.webContents.send("signet:open-pdf", { name: path.basename(pdfPath), bytes: arrayBuffer });
      app.addRecentDocument(pdfPath);
    } catch {
      // The file may have moved or become unreadable after the OS launched Signet.
    }
  }
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
  mainWindow.webContents.on("did-finish-load", () => {
    if (SMOKE_TEST && hasAllowedOrigin(mainWindow.webContents.getURL())) return app.exit(0);
    sendPendingPdfs();
  });

  mainWindow.loadURL(APP_URL);
}

const gotLock = app.requestSingleInstanceLock();
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
    if (!process.defaultApp) registerWindowsPdfHandler();
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    ipcMain.handle("signet:open-default-apps", () => shell.openExternal("ms-settings:defaultapps"));
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
