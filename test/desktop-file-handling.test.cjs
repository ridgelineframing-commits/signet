const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { extractPdfPaths } = require("../desktop/file-handling.cjs");
const { createPdfOpenDelivery, normalizePdfPayload } = require("../desktop/pdf-open-delivery.cjs");

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

test("desktop PDF delivery buffers a cold-start file until the editor subscribes", () => {
  const delivery = createPdfOpenDelivery();
  const opened = [];
  const source = Uint8Array.from([37, 80, 68, 70]);

  assert.equal(delivery.receive({ name: "cold-start.pdf", bytes: source.buffer }), true);
  assert.deepEqual(opened, []);

  assert.equal(delivery.subscribe((payload) => opened.push(payload)), true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].name, "cold-start.pdf");
  assert.deepEqual([...opened[0].bytes], [...source]);
});

test("desktop PDF delivery sends later files to an already-running editor", () => {
  const delivery = createPdfOpenDelivery();
  const opened = [];
  delivery.subscribe((payload) => opened.push(payload.name));

  assert.equal(delivery.receive({ name: "first.pdf", bytes: new Uint8Array([1, 2]) }), true);
  assert.equal(delivery.receive({ name: "second.pdf", bytes: new Uint8Array([3, 4]) }), true);
  assert.deepEqual(opened, ["first.pdf", "second.pdf"]);
});

test("desktop PDF delivery rejects malformed messages", () => {
  assert.equal(normalizePdfPayload(null), null);
  assert.equal(normalizePdfPayload({ name: "not-a-pdf.pdf", bytes: "bad" }), null);
});
