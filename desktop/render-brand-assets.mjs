import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(directory, "..", "public");
const source = await readFile(path.join(publicDirectory, "icon.svg"));

const outputs = [
  ["icon-512.png", 512],
  ["icon-192.png", 192],
  ["apple-touch-icon.png", 180],
  ["icon-doc-256.png", 256],
];

await Promise.all(outputs.map(([name, size]) =>
  sharp(source).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(publicDirectory, name))
));

console.log("Rendered Prism Ink app icons");
