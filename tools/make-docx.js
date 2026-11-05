// Writes a sample .docx so Word itself can be used to check the export:
//   node tools/make-docx.js out.docx [--long] [--images]
import { writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleLetter } from './sample-letter.js';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '../app/src/main/assets/web/js');
const { buildDocx } = await import(pathToFileURL(resolve(web, 'export-docx.js')).href);

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) || 'sample.docx';
const long = args.includes('--long');
const images = args.includes('--images');
const moved = args.includes('--moved');

const png = images ? readFileSync(resolve(here, 'test-image.png')) : null;
const lookup = (id) => (png ? { bytes: new Uint8Array(png), ext: 'png' } : null);

const bytes = buildDocx(sampleLetter({ long, images, moved }), lookup, { pageCount: long ? 2 : 1, pageAnchors: [0] });
writeFileSync(out, bytes);
console.log(`wrote ${out}: ${bytes.length} bytes`);
