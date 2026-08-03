const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROG_ID = "SignetPDF.Document";
const REGISTERED_APP = "Signet PDF Editor";
const CAPABILITIES_KEY = "HKCU\\Software\\SignetPDFEditor\\Capabilities";

function extractPdfPaths(argv, workingDirectory = process.cwd()) {
  const found = [];
  const seen = new Set();
  for (const raw of argv || []) {
    if (typeof raw !== "string") continue;
    const candidate = raw.replace(/^"|"$/g, "");
    if (!candidate.toLowerCase().endsWith(".pdf")) continue;
    const resolved = path.resolve(workingDirectory, candidate);
    if (seen.has(resolved.toLowerCase())) continue;
    try {
      if (!fs.statSync(resolved).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(resolved.toLowerCase());
    found.push(resolved);
  }
  return found;
}

function reg(args) {
  execFileSync("reg.exe", args, { stdio: "ignore", windowsHide: true });
}

function addValue(key, name, value, type = "REG_SZ") {
  const args = ["add", key];
  if (name === null) args.push("/ve");
  else args.push("/v", name);
  args.push("/t", type, "/d", value, "/f");
  reg(args);
}

function tryDelete(args) {
  try { reg(["delete", ...args, "/f"]); } catch { /* already absent */ }
}

function registerWindowsPdfHandler(executable = process.execPath) {
  if (process.platform !== "win32") return false;
  const classes = "HKCU\\Software\\Classes";
  const progKey = `${classes}\\${PROG_ID}`;
  const appKey = `${classes}\\Applications\\SignetPDFEditor.exe`;
  const openCommand = `\"${executable}\" \"%1\"`;

  try {
    addValue(progKey, null, "Signet PDF Document");
    addValue(`${progKey}\\DefaultIcon`, null, `${executable},0`);
    addValue(`${progKey}\\shell\\open\\command`, null, openCommand);
    addValue(`${classes}\\.pdf\\OpenWithProgids`, PROG_ID, "", "REG_NONE");

    addValue(appKey, null, "Signet PDF Editor");
    addValue(`${appKey}\\SupportedTypes`, ".pdf", "");
    addValue(`${appKey}\\shell\\open\\command`, null, openCommand);

    addValue(CAPABILITIES_KEY, "ApplicationName", "Signet PDF Editor");
    addValue(CAPABILITIES_KEY, "ApplicationDescription", "Open and edit PDF documents with Signet.");
    addValue(`${CAPABILITIES_KEY}\\FileAssociations`, ".pdf", PROG_ID);
    addValue("HKCU\\Software\\RegisteredApplications", REGISTERED_APP, "Software\\SignetPDFEditor\\Capabilities");
    return true;
  } catch {
    return false;
  }
}

function unregisterWindowsPdfHandler() {
  if (process.platform !== "win32") return;
  const classes = "HKCU\\Software\\Classes";
  tryDelete([`${classes}\\.pdf\\OpenWithProgids`, "/v", PROG_ID]);
  tryDelete([`${classes}\\${PROG_ID}`]);
  tryDelete([`${classes}\\Applications\\SignetPDFEditor.exe`]);
  tryDelete(["HKCU\\Software\\SignetPDFEditor"]);
  tryDelete(["HKCU\\Software\\RegisteredApplications", "/v", REGISTERED_APP]);
}

function canOverwritePdf(requestedPath, allowedPaths) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) return false;
  const resolved = path.resolve(requestedPath);
  return resolved.toLowerCase().endsWith(".pdf") && allowedPaths instanceof Set && allowedPaths.has(resolved.toLowerCase());
}

module.exports = {
  canOverwritePdf,
  extractPdfPaths,
  registerWindowsPdfHandler,
  unregisterWindowsPdfHandler,
};
