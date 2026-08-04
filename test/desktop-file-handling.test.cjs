const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { canOverwritePdf, extractPdfPaths } = require("../desktop/file-handling.cjs");

function executeSandboxedPreload() {
  const listeners = new Map();
  const sent = [];
  let desktopApi = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { desktopApi = api; } },
    ipcRenderer: {
      invoke: async () => null,
      on: (channel, callback) => listeners.set(channel, callback),
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "../desktop/preload.cjs"), "utf8");
  vm.runInNewContext(source, {
    ArrayBuffer,
    Uint8Array,
    require(moduleName) {
      assert.equal(moduleName, "electron", "sandboxed preload must not require local modules");
      return electron;
    },
  });
  return { desktopApi, listeners, sent };
}

test("extractPdfPaths accepts existing PDFs and ignores other arguments", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signet-file-handler-"));
  try {
    fs.writeFileSync(path.join(tempDir, "Drawing Set.PDF"), "%PDF-test");
    fs.writeFileSync(path.join(tempDir, "notes.txt"), "not a pdf");
    assert.deepEqual(
      extractPdfPaths(["--flag", "Drawing Set.PDF", "notes.txt", "missing.pdf"], tempDir),
      [path.join(tempDir, "Drawing Set.PDF")]
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extractPdfPaths de-duplicates paths case-insensitively", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signet-file-handler-"));
  try {
    const pdfPath = path.join(tempDir, "sample.pdf");
    fs.writeFileSync(pdfPath, "%PDF-test");
    assert.deepEqual(extractPdfPaths([pdfPath, pdfPath]), [pdfPath]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("native Save only overwrites PDF paths previously opened by Signet", () => {
  const allowed = new Set([path.resolve("C:\\Jobs\\estimate.pdf").toLowerCase()]);
  assert.equal(canOverwritePdf("C:\\Jobs\\estimate.pdf", allowed), true);
  assert.equal(canOverwritePdf("C:\\Jobs\\other.pdf", allowed), false);
  assert.equal(canOverwritePdf("C:\\Jobs\\estimate.txt", allowed), false);
});

test("sandboxed preload exposes the desktop API without requiring a local module", () => {
  const { desktopApi, sent } = executeSandboxedPreload();
  assert.ok(desktopApi);
  assert.equal(desktopApi.onOpenPdf(() => true), true);
  assert.equal(sent[0].channel, "signet:editor-ready");
});

test("sandboxed preload reports successful PDF delivery to the native queue", async () => {
  const { desktopApi, listeners, sent } = executeSandboxedPreload();
  const opened = [];
  desktopApi.onOpenPdf(async (payload) => { opened.push(payload); return true; });
  listeners.get("signet:open-pdf")(null, {
    id: "delivery-1",
    name: "estimate.pdf",
    path: "C:\\Jobs\\estimate.pdf",
    bytes: Uint8Array.from([37, 80, 68, 70]),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened[0].path, "C:\\Jobs\\estimate.pdf");
  assert.deepEqual([...opened[0].bytes], [37, 80, 68, 70]);
  assert.equal(sent.at(-1).channel, "signet:pdf-open-result");
  assert.equal(sent.at(-1).payload.id, "delivery-1");
  assert.equal(sent.at(-1).payload.ok, true);
});
