const fs = require("node:fs");
const path = require("node:path");

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

function canOverwritePdf(requestedPath, allowedPaths) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) return false;
  const resolved = path.resolve(requestedPath);
  return resolved.toLowerCase().endsWith(".pdf") && allowedPaths instanceof Set && allowedPaths.has(resolved.toLowerCase());
}

module.exports = {
  canOverwritePdf,
  extractPdfPaths,
};
