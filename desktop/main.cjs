const path = require("node:path");
const { app, BrowserWindow, Menu, session } = require("electron");

if (require("electron-squirrel-startup")) app.quit();

const APP_URL = "https://signet.ridgeline.workers.dev/";
const APP_ORIGIN = new URL(APP_URL).origin;
const SMOKE_TEST = process.argv.includes("--smoke-test");

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

function createWindow() {
  const window = new BrowserWindow({
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => {
    if (!SMOKE_TEST) window.show();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => {
    if (!hasAllowedOrigin(target)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("did-fail-load", (_event, errorCode, _description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !hasAllowedOrigin(validatedUrl)) return;
    if (SMOKE_TEST) return app.exit(2);
    window.loadFile(path.join(__dirname, "offline.html"));
  });
  window.webContents.on("did-finish-load", () => {
    if (SMOKE_TEST && hasAllowedOrigin(window.webContents.getURL())) app.exit(0);
  });

  window.loadURL(APP_URL);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
