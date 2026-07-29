const path = require("node:path");

module.exports = {
  packagerConfig: {
    asar: true,
    icon: path.join(__dirname, "desktop", "icon"),
    executableName: "SignetPDFEditor",
    ignore: [
      /^\/android(?:\/|$)/,
      /^\/migrations(?:\/|$)/,
      /^\/public(?:\/|$)/,
      /^\/test(?:\/|$)/,
      /^\/worker(?:\/|$)/,
      /^\/(?:README\.md|schema\.sql|wrangler\.toml|CLAUDE\.md)$/,
    ],
    win32metadata: {
      CompanyName: "Ridgeline Framing",
      FileDescription: "Signet PDF Editor",
      OriginalFilename: "SignetPDFEditor.exe",
      ProductName: "Signet PDF Editor",
      InternalName: "SignetPDFEditor",
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "SignetPDFEditor",
        authors: "Ridgeline Framing",
        description: "Browser-first PDF editor with optional signature requests.",
        setupExe: "Signet-PDF-Editor-Setup.exe",
        setupIcon: path.join(__dirname, "desktop", "icon.ico"),
        noMsi: true,
      },
    },
  ],
};
