// Builds a letter whose paragraphs and sections were placed by hand, with free move and without,
// and writes the app's page as a PDF and its .docx, to compare in real Word.
//   node tools/free-test.js out-folder      (needs the preview server on port 8770)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openPhone } from './cdp.js';

const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const page = await openPhone({ port: 9339 });
try {
  await page.goto('http://127.0.0.1:8770/app/src/main/assets/web/index.html');
  await page.sleep(1200);
  const docx = await page.evaluate(`
    const { sampleLetter } = await import('/tools/sample-letter.js');
    const { makeDocx, preparePrintRoot } = await import('/app/src/main/assets/web/js/export.js');
    const { layoutLetter } = await import('/app/src/main/assets/web/js/render.js');
    const { bytesToBase64 } = await import('/app/src/main/assets/web/js/util.js');
    const L = sampleLetter({});
    L.body[0].move = { dx: 0, dy: 0, fy: -30 };
    L.body[1].move = { dx: -25, dy: 6, fy: 0 };
    L.body[2].over = { font: 'B Titr', size: 16, bold: true };
    L.body[3].align = 'center';
    L.offsets = { 'table:0': { dx: 8, dy: 0, fy: -12 }, closing: { dx: 0, dy: 0, fy: 22 }, sign: { dx: 60, dy: 0, fy: -20 }, cc: { dy: 8 } };
    window.__app.letter = L;
    const made = await makeDocx(L, { deliver: false });
    await preparePrintRoot(L);
    const info = layoutLetter(L);
    window.__totals = info.total;
    return bytesToBase64(made.bytes);
  `);
  writeFileSync(join(out, 'free.docx'), Buffer.from(docx, 'base64'));
  await page.send('Emulation.clearDeviceMetricsOverride');
  const pdf = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  writeFileSync(join(out, 'free-page.pdf'), Buffer.from(pdf.data, 'base64'));
  if (page.errors.length) console.log('script errors:', page.errors);
  console.log('written');
} finally {
  await page.close();
}
