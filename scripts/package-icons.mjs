// Package standard Tauri-converted PNG sizes into the Windows runtime icon.
// Usage: node scripts/package-icons.mjs <size-directory> <output-directory>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const [inputDirectory, outputDirectory] = process.argv.slice(2);
if (!inputDirectory || !outputDirectory) throw new Error('Choose the PNG-size directory and the icon output directory.');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const size of sizes) {
  const data = await readFile(join(resolve(inputDirectory), `${size}x${size}.png`));
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.readUInt32BE(16) !== size || data.readUInt32BE(20) !== size) {
    throw new Error(`Expected a square ${size}-pixel PNG from the icon converter.`);
  }
  images.push(data);
}
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let index = 0; index < sizes.length; index++) {
  const position = 6 + index * 16;
  header[position] = sizes[index] === 256 ? 0 : sizes[index];
  header[position + 1] = header[position];
  header.writeUInt16LE(1, position + 4);
  header.writeUInt16LE(32, position + 6);
  header.writeUInt32LE(images[index].length, position + 8);
  header.writeUInt32LE(offset, position + 12);
  offset += images[index].length;
}
const target = resolve(outputDirectory);
await mkdir(target, { recursive: true });
await writeFile(join(target, 'icon.ico'), Buffer.concat([header, ...images]));
await writeFile(join(target, 'icon.png'), images.at(-1));
console.log(`Packaged ${sizes.length} Windows icon sizes (${offset} bytes); runtime PNG ${images.at(-1).length} bytes.`);
