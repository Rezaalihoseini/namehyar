// Removes the modern text boxes from a .docx, leaving only the older fallback drawing inside each,
// to check what a viewer that does not understand the modern form will show.
//   node tools/strip-choice.js in.docx out.docx      (works on this app's own uncompressed files)
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { zipStore } = await import(pathToFileURL(resolve(here, '../app/src/main/assets/web/js/zip.js')).href);

const [input, output] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(input));
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const decoder = new TextDecoder();
const files = [];
for (let i = 0; view.getUint32(i, true) === 0x04034b50;) {
  const size = view.getUint32(i + 18, true);
  const nameLen = view.getUint16(i + 26, true);
  const extraLen = view.getUint16(i + 28, true);
  const name = decoder.decode(bytes.subarray(i + 30, i + 30 + nameLen));
  const start = i + 30 + nameLen + extraLen;
  let data = bytes.slice(start, start + size);
  if (name.startsWith('word/') && name.endsWith('.xml')) {
    data = decoder.decode(data).replace(/<mc:AlternateContent><mc:Choice[^>]*>[\s\S]*?<\/mc:Choice><mc:Fallback>([\s\S]*?)<\/mc:Fallback><\/mc:AlternateContent>/g, '$1');
  }
  files.push({ name, data });
  i = start + size;
}
writeFileSync(output, zipStore(files));
console.log(`wrote ${output}`);
