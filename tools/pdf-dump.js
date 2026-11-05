// Writes what pdf.js sees on each page of a PDF as JSON: every piece of text, every line and box, every picture, in mm.
// For working out why a PDF came in wrongly.
//   node tools/pdf-dump.js in.pdf out.json      (needs the preview server on port 8770)
import { readFileSync, writeFileSync } from 'node:fs';
import { openPhone } from './cdp.js';

const [input, output] = process.argv.slice(2);
const page = await openPhone({ port: 9338 });
try {
  await page.goto('http://127.0.0.1:8770/app/src/main/assets/web/index.html');
  await page.sleep(800);
  const b64 = readFileSync(input).toString('base64');
  const dump = await page.evaluate(`
    const pdfjs = await import('/app/src/main/assets/web/vendor/pdfjs/pdf.min.js');
    globalThis.pdfjsWorker = await import('/app/src/main/assets/web/vendor/pdfjs/pdf.worker.min.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, isOffscreenCanvasSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
    const { OPS, Util } = pdfjs;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const pg = await pdf.getPage(n);
      const vp = pg.getViewport({ scale: 1 });
      const k = 210 / vp.width;
      const ops = await pg.getOperatorList();
      const content = await pg.getTextContent({ disableNormalization: true });
      const fonts = {};
      const items = content.items.map((it) => {
        const t = Util.transform(vp.transform, it.transform);
        if (!fonts[it.fontName] && pg.commonObjs.has(it.fontName)) {
          const f = pg.commonObjs.get(it.fontName);
          fonts[it.fontName] = { name: f.name, bold: f.bold, black: f.black, italic: f.italic, type: f.type, missing: f.missingFile };
        }
        return { s: it.str, x: +(t[4] * k).toFixed(2), y: +(t[5] * k).toFixed(2), w: +(it.width * k).toFixed(2), h: +(it.height * k).toFixed(2), pt: +Math.hypot(t[2], t[3]).toFixed(2), dir: it.dir, font: it.fontName, eol: it.hasEOL || undefined };
      });
      const shapes = [];
      const stack = [];
      let ctm = vp.transform;
      let gs = { lw: 1, stroke: null, fill: null };
      const gsStack = [];
      const P = (x, y) => { const p = Util.applyTransform([x, y], ctm); return [+(p[0] * k).toFixed(2), +(p[1] * k).toFixed(2)]; };
      const names = Object.fromEntries(Object.entries(OPS).map(([a, b]) => [b, a]));
      const seen = {};
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        seen[names[fn]] = (seen[names[fn]] || 0) + 1;
        if (fn === OPS.save) { stack.push(ctm); gsStack.push({ ...gs }); }
        else if (fn === OPS.restore) { ctm = stack.pop() || ctm; gs = gsStack.pop() || gs; }
        else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
        else if (fn === OPS.setLineWidth) gs.lw = args[0];
        else if (fn === OPS.setStrokeRGBColor) gs.stroke = args[0];
        else if (fn === OPS.setFillRGBColor) gs.fill = args[0];
        else if (fn === OPS.constructPath) {
          const paint = names[ops.fnArray[i + 1]];
          const [pathOps, coords] = args;
          let c = 0;
          let at = null;
          const segs = [];
          for (const op of pathOps) {
            if (op === OPS.rectangle) {
              const [x, y, w, h] = coords.slice(c, c + 4);
              c += 4;
              const a = P(x, y);
              const b = P(x + w, y + h);
              segs.push({ rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
            } else if (op === OPS.moveTo) { at = P(coords[c], coords[c + 1]); c += 2; }
            else if (op === OPS.lineTo) { const to = P(coords[c], coords[c + 1]); c += 2; segs.push({ line: [...at, ...to] }); at = to; }
            else if (op === OPS.curveTo) { c += 6; segs.push({ curve: true }); }
            else if (op === OPS.curveTo2 || op === OPS.curveTo3) { c += 4; segs.push({ curve: true }); }
          }
          shapes.push({ paint, lw: +(gs.lw * Math.abs(ctm[0]) * k).toFixed(3), stroke: gs.stroke, fill: gs.fill, segs });
        } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
          const a = P(0, 0);
          const b = P(1, 1);
          shapes.push({ paint: 'image', box: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], src: typeof args[0] === 'string' ? args[0] : 'inline' });
        }
      }
      pages.push({ w: vp.width, h: vp.height, rotate: pg.rotate, fonts, items, shapes, ops: seen });
    }
    const meta = await pdf.getMetadata().catch(() => null);
    return { info: meta?.info, pages };
  `);
  writeFileSync(output, JSON.stringify(dump, null, 0));
  for (const p of dump.pages) {
    console.log(`page ${p.w}x${p.h}: ${p.items.length} text pieces, ${p.shapes.length} shapes`);
    console.log('fonts', JSON.stringify(p.fonts));
    console.log('ops', JSON.stringify(p.ops));
  }
  console.log('info', JSON.stringify(dump.info));
  if (page.errors.length) console.log('script errors:', page.errors);
} finally {
  await page.close();
}
