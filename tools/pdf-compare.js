// Compares two PDFs of the same document piece by piece: does every piece of text of the first appear in the second,
// and how far from where it was? For checking a PDF that went through the app, as the app's page or as Word's rendering of it.
//   node tools/pdf-compare.js source.pdf other.pdf [max-mm]      (needs the preview server on port 8770)
import { readFileSync } from 'node:fs';
import { openPhone } from './cdp.js';

const [first, second, limitArg] = process.argv.slice(2);
const limit = Number(limitArg) || 1.5;
const page = await openPhone({ port: 9342 });
try {
  await page.goto('http://127.0.0.1:8770/app/src/main/assets/web/index.html');
  await page.sleep(800);
  const run = (b64a, b64b) => page.evaluate(`
    const pdfjs = await import('/app/src/main/assets/web/vendor/pdfjs/pdf.min.js');
    globalThis.pdfjsWorker = await import('/app/src/main/assets/web/vendor/pdfjs/pdf.worker.min.js');
    // What is compared: the letters and digits only, whichever way the two files spell or order them.
    const key = (s) => [...s.normalize('NFKC').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0).replace(/[^0-9A-Za-z\\u0621-\\u06ff]/g, '')].sort().join('');
    const pieces = async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, isOffscreenCanvasSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
      const out = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const pg = await pdf.getPage(n);
        const vp = pg.getViewport({ scale: 1 });
        const k = 210 / vp.width;
        const content = await pg.getTextContent();
        const items = content.items.filter((it) => it.str.trim()).map((it) => {
          const t = pdfjs.Util.transform(vp.transform, it.transform);
          return { s: it.str, x: t[4] * k, y: t[5] * k, w: it.width * k, pt: Math.hypot(t[2], t[3]) };
        });
        items.sort((a, b) => a.y - b.y || a.x - b.x);
        const lines = [];
        for (const it of items) {
          const line = lines.find((l) => Math.abs(l.y - it.y) < 1.1);
          if (line) line.items.push(it);
          else lines.push({ y: it.y, items: [it] });
        }
        for (const line of lines) {
          line.items.sort((a, b) => a.x - b.x);
          let cur = null;
          for (const it of line.items) {
            if (cur && it.x - cur.x1 < Math.max(1.3, it.pt * 0.2)) {
              cur.s += it.s;
              cur.x1 = Math.max(cur.x1, it.x + it.w);
              cur.y = Math.max(cur.y, it.y);
            } else {
              cur = { s: it.s, x0: it.x, x1: it.x + it.w, y: it.y, page: n, pt: it.pt };
              out.push(cur);
            }
          }
        }
      }
      for (const p of out) p.key = key(p.s);
      return out.filter((p) => p.key);
    };
    const a = await pieces(${JSON.stringify(b64a)});
    const b = await pieces(${JSON.stringify(b64b)});
    // Pieces can be split differently in the two files, so whatever of the second lies near the first piece counts as it.
    const rows = a.map((p) => {
      const same = b.filter((q) => q.key === p.key && q.page === p.page);
      let best = null;
      for (const q of same) {
        const d = Math.hypot((q.x0 + q.x1) / 2 - (p.x0 + p.x1) / 2, q.y - p.y);
        if (!best || d < best.d) best = { d, dx: (q.x0 + q.x1) / 2 - (p.x0 + p.x1) / 2, dy: q.y - p.y, width: q.x1 - q.x0 };
      }
      if (best) return { text: p.s, x: p.x0, y: p.y, ...best, srcWidth: p.x1 - p.x0 };
      const near = b.filter((q) => q.page === p.page && Math.abs(q.y - p.y) < 3 && q.x1 > p.x0 - 3 && q.x0 < p.x1 + 3);
      const together = key(near.map((q) => q.s).join(''));
      const found = [...p.key].every((c) => together.includes(c));
      return { text: p.s, x: p.x0, y: p.y, missing: !found, split: found, near: near.map((q) => q.s).join(' | ') };
    });
    return { a: a.length, b: b.length, rows };
  `);
  const { a, b, rows } = await run(readFileSync(first).toString('base64'), readFileSync(second).toString('base64'));
  const matched = rows.filter((r) => r.d !== undefined);
  const far = matched.filter((r) => r.d > limit);
  const missing = rows.filter((r) => r.missing);
  const split = rows.filter((r) => r.split);
  const mean = (list, f) => (list.length ? list.reduce((s, r) => s + f(r), 0) / list.length : 0);
  console.log(`pieces: ${a} in the first, ${b} in the second; ${matched.length} found whole, ${split.length} found split, ${missing.length} missing`);
  console.log(`distance: mean ${mean(matched, (r) => r.d).toFixed(2)} mm, worst ${Math.max(0, ...matched.map((r) => r.d)).toFixed(2)} mm; mean shift dx ${mean(matched, (r) => r.dx).toFixed(2)}, dy ${mean(matched, (r) => r.dy).toFixed(2)}`);
  const buckets = new Map();
  for (const r of matched) {
    const y = Math.floor(r.y / 15) * 15;
    if (!buckets.has(y)) buckets.set(y, []);
    buckets.get(y).push(r);
  }
  console.log('down the page (y: mean dy, mean dx):', [...buckets.keys()].sort((p, q) => p - q).map((y) => `${y}: ${mean(buckets.get(y), (r) => r.dy).toFixed(2)}, ${mean(buckets.get(y), (r) => r.dx).toFixed(2)}`).join(' | '));
  for (const r of far.sort((p, q) => q.d - p.d).slice(0, 15)) console.log(`FAR  ${r.d.toFixed(1)}mm (${r.dx.toFixed(1)}, ${r.dy.toFixed(1)}) at ${r.x.toFixed(0)},${r.y.toFixed(0)}: ${r.text}`);
  for (const r of missing.slice(0, 25)) console.log(`MISSING at ${r.x.toFixed(0)},${r.y.toFixed(0)}: ${r.text}   near: ${r.near}`);
  if (page.errors.length) console.log('script errors:', page.errors);
  process.exitCode = missing.length || far.length ? 1 : 0;
} finally {
  await page.close();
}
