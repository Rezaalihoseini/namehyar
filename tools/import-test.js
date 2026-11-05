// Opens a .docx in the real app, prints what was recognised, and writes the app's page as a PDF and its new .docx,
// so a letter can be compared before and after passing through the app.
//   node tools/import-test.js in.docx out-folder      (needs the preview server on port 8770)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { openPhone } from './cdp.js';

const [input, outArg] = process.argv.slice(2);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });

const page = await openPhone({ port: 9335 });
try {
  await page.goto('http://127.0.0.1:8770/app/src/main/assets/web/index.html');
  await page.sleep(1200);
  const b64 = readFileSync(input).toString('base64');
  const summary = await page.evaluate(`
    const { openLetterFile } = await import('/app/src/main/assets/web/js/screens/home.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    await openLetterFile(bytes, ${JSON.stringify(basename(input))});
    await new Promise((r) => setTimeout(r, 700));
    const L = window.__app.letter;
    return {
      screen: window.__app.stack.at(-1),
      recipient: L.recipient, subject: L.subject, greeting: L.greeting, closing: L.closing, signer: L.signer, cc: L.cc,
      number: L.number, date: L.date, attachment: L.attachment,
      letterhead: { org: L.letterhead.org, invocation: L.letterhead.invocation, footer: L.letterhead.footer, logo: !!L.letterhead.logo, parts: L.letterhead.parts },
      geom: L.geom, styles: L.styles, offsets: L.offsets,
      blocks: L.body.map((b) => b.kind === 'table' ? { table: b.rows.length + ' rows', widths: b.widths, header: b.header, borderless: b.borderless } : { p: b.runs.map((r) => r.text ?? '[image]').join('').slice(0, 60), align: b.align, indent: b.indent }),
      objects: L.objects.map((o) => ({ kind: o.kind, anchor: o.anchor, x: o.x, y: o.y, dy: o.dy, w: o.w, text: o.text })),
      info: L.importInfo,
      toast: document.querySelector('#toast')?.textContent,
    };
  `);
  console.log(JSON.stringify(summary, null, 1));
  await page.screenshot(join(out, 'phone-page.png'));

  const size = await page.evaluate(`
    const { makeDocx, preparePrintRoot } = await import('/app/src/main/assets/web/js/export.js');
    const { bytesToBase64 } = await import('/app/src/main/assets/web/js/util.js');
    const made = await makeDocx(window.__app.letter, { deliver: false });
    await preparePrintRoot(window.__app.letter);
    window.__docx = bytesToBase64(made.bytes);
    return window.__docx.length;
  `);
  // A large answer in one piece can take this connection many minutes.
  const pieces = [];
  for (let at = 0; at < size; at += 1500000) pieces.push(await page.evaluate(`return window.__docx.slice(${at}, ${at + 1500000});`));
  writeFileSync(join(out, 'app-export.docx'), Buffer.from(pieces.join(''), 'base64'));
  await page.send('Emulation.clearDeviceMetricsOverride');
  const pdf = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  writeFileSync(join(out, 'app-page.pdf'), Buffer.from(pdf.data, 'base64'));
  if (page.errors.length) console.log('script errors:', page.errors);
} finally {
  await page.close();
}
