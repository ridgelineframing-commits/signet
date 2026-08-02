const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { extractPdfPaths } = require("../desktop/file-handling.cjs");

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
