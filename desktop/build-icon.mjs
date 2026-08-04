import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
await import("./render-brand-assets.mjs");
const png = await readFile(path.join(directory, "..", "public", "icon-doc-256.png"));

// Windows Vista and newer accept a PNG-compressed 256px image inside an ICO.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // 0 represents 256px in the ICO directory.
entry.writeUInt8(0, 1);
entry.writeUInt8(0, 2);
entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12);

await writeFile(path.join(directory, "icon.ico"), Buffer.concat([header, entry, png]));
console.log("Prepared desktop/icon.ico");
