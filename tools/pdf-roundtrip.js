// A PDF through the whole round: read by the app, saved as Word, the Word file read back by the app.
// Nothing of a form may be lost on the way: words, lines, cells, row heights, frames.
//   node tools/pdf-roundtrip.js in.pdf      (needs the preview server on port 8770)
import { readFileSync } from 'node:fs';
import { openPhone } from './cdp.js';

const [input] = process.argv.slice(2);
const WEB = '/app/src/main/assets/web/js';
const page = await openPhone({ port: 9353 });
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? `: ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed++;
};
try {
  await page.goto('http://127.0.0.1:8770/app/src/main/assets/web/index.html');
  await page.sleep(1000);
  const res = await page.evaluate(`
    const { importPdf } = await import('${WEB}/import-pdf.js');
    const { importDocx } = await import('${WEB}/import-docx.js');
    const { makeDocx } = await import('${WEB}/export.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(readFileSync(input).toString('base64'))}), (c) => c.charCodeAt(0));
    const first = await importPdf(bytes, window.__app.settings);
    await document.fonts.ready;
    const made = await makeDocx(first, { deliver: false });
    const second = await importDocx(made.bytes, window.__app.settings);
    const made2 = await makeDocx(second, { deliver: false });
    const third = await importDocx(made2.bytes, window.__app.settings);
    // Word rounds the width of a double line, so only that it is double has to hold.
    const round = (w) => (w < 0 ? 'double' : Math.round(w * 4) / 4);
    const summary = (L) => ({
      form: !!L.importInfo.form,
      autoFix: L.autoFix,
      frames: L.objects.filter((o) => o.kind === 'text').map((o) => o.text),
      images: L.objects.filter((o) => o.kind === 'image').length,
      tables: L.body.filter((b) => b.kind === 'table').map((t) => ({
        rows: t.rows.length,
        pad: t.pad,
        cells: t.rows.flat().map((c) => ({
          text: c.paras.map((p) => (p.runs || []).map((r) => r.text).join('')).join('/'),
          borders: (c.borders || []).map(round),
          span: c.colSpan || 1,
          rowSpan: c.rowSpan || 1,
          rowH: Math.round((c.rowH || 0) * 10) / 10,
        })),
      })),
      paragraphs: L.body.filter((b) => b.kind === 'p').map((p) => (p.runs || []).map((r) => r.text).join('')).filter(Boolean),
    });
    return { a: summary(first), b: summary(second), c: summary(third), sizes: [made.bytes.length, made2.bytes.length] };
  `);
  const compare = (a, b, label) => {
    const diffs = [];
    a.tables.forEach((t, i) => t.cells.forEach((c, j) => {
      const other = b.tables[i]?.cells[j];
      for (const key of ['text', 'span', 'rowSpan', 'borders']) if (JSON.stringify(c[key]) !== JSON.stringify(other?.[key])) diffs.push([i, j, key, c[key], other?.[key]]);
      // A row's height shows on the cells that lie in that row alone.
      if (c.rowSpan === 1 && Math.abs(c.rowH - (other?.rowH || 0)) > 0.15) diffs.push([i, j, 'rowH', c.rowH, other?.rowH]);
    }));
    check(`${label}: same number of tables and rows`, JSON.stringify(a.tables.map((t) => t.rows)) === JSON.stringify(b.tables.map((t) => t.rows)), [a.tables.map((t) => t.rows), b.tables.map((t) => t.rows)]);
    check(`${label}: same cells, words, lines and heights`, !diffs.length, diffs.length ? { count: diffs.length, first: diffs.slice(0, 6) } : '');
    check(`${label}: same frames`, JSON.stringify(a.frames) === JSON.stringify(b.frames), JSON.stringify(a.frames) === JSON.stringify(b.frames) ? '' : [a.frames, b.frames]);
    check(`${label}: same text outside the tables`, JSON.stringify(a.paragraphs) === JSON.stringify(b.paragraphs), JSON.stringify(a.paragraphs) === JSON.stringify(b.paragraphs) ? '' : [a.paragraphs, b.paragraphs]);
    check(`${label}: still kept exactly`, b.autoFix === false && b.tables.every((t) => t.pad !== undefined), { autoFix: b.autoFix, pad: b.tables.map((t) => t.pad) });
  };
  console.log(`read as a form: ${res.a.form}; ${res.a.tables.length} tables, ${res.a.frames.length} frames, Word file ${Math.round(res.sizes[0] / 1024)} KB`);
  compare(res.a, res.b, 'PDF to Word and back');
  compare(res.b, res.c, 'and once more');
  if (page.errors.length) console.log('script errors:', page.errors);
  check('no script errors', page.errors.length === 0);
} finally {
  await page.close();
}
console.log(failed ? `${failed} checks failed` : 'the round trip lost nothing');
process.exit(failed ? 1 : 0);
