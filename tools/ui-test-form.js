// A PDF that is a form rather than a letter: tables inside tables, rows with no lines, printed by a browser.
// It comes in as it looked, with every piece editable, and goes out to Word and back without losing anything.
//   node tools/ui-test-form.js <out-folder>      (needs the preview server on port 8770)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openPhone } from './cdp.js';

const out = resolve(process.argv[2] || 'ui-test-out');
mkdirSync(out, { recursive: true });
const WEB = '/app/src/main/assets/web/js';
const APP = 'http://127.0.0.1:8770/app/src/main/assets/web/index.html';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? `: ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed++;
}

const page = await openPhone({ port: 9347 });
try {
  /* ---------- The sample, printed by the browser the way a phone prints a web page ---------- */
  await page.goto('http://127.0.0.1:8770/tools/form-sample.html');
  await page.sleep(1200);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const printed = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  writeFileSync(join(out, 'form-sample.pdf'), Buffer.from(printed.data, 'base64'));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });

  await page.goto(APP);
  await page.sleep(1200);
  await page.evaluate(`
    const { openLetterFile } = await import('${WEB}/screens/home.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(printed.data)}), (c) => c.charCodeAt(0));
    await openLetterFile(bytes, 'form-sample.pdf');
    await new Promise((r) => setTimeout(r, 700));
  `);

  /* ---------- What it read ---------- */
  const shape = await page.evaluate(`
    const L = window.__app.letter;
    const cells = (t) => t.rows.flat();
    const text = (c) => c.paras.map((p) => p.runs.map((r) => r.text).join('')).join(' / ');
    const tables = L.body.filter((b) => b.kind === 'table');
    return {
      form: L.importInfo.form,
      screen: window.__app.stack.at(-1),
      kinds: L.body.map((b) => b.kind),
      frames: L.objects.filter((o) => o.kind === 'text').map((o) => ({ text: o.text, align: o.style.align, size: o.style.size, bold: o.style.bold, font: o.style.font, y: o.y })),
      doubleInTerms: tables[1].rows.flat().filter((c) => c.borders?.some((w) => w < 0)).length,
      thickInTerms: tables[1].rows.flat().filter((c) => c.borders?.some((w) => w >= 1.25)).length,
      doubleLast: tables[tables.length - 1].rows.flat().filter((c) => c.borders?.some((w) => w < 0)).length,
      tables: tables.map((t) => ({ rows: t.rows.length, cols: t.widths.length, pad: t.pad, borderless: !!t.borderless, sample: t.rows.slice(0, 2).map((row) => row.map(text)) })),
      info: tables[0].rows.map((row) => row.map(text)),
      termRows: tables[1].rows.map((row) => row.map(text)),
      allText: tables.flatMap((t) => cells(t).map(text)),
      // Words with no look of their own take the look of the whole table.
      bold: tables[1].rows.flat().flatMap((c) => c.paras.flatMap((p) => p.runs.filter((r) => r.b ?? L.styles.table.bold))).length,
      regular: tables[1].rows.flat().flatMap((c) => c.paras.flatMap((p) => p.runs.filter((r) => !(r.b ?? L.styles.table.bold)))).length,
      letterhead: L.letterhead.org,
      hasOwnLines: tables[1].rows.flat().some((c) => c.borders),
      noLineInside: tables[1].rows.flat().some((c) => c.borders && c.borders[0] === 0 && c.borders[2] === 0),
      thickFrames: tables[1].rows.flat().some((c) => c.borders && c.borders.some((w) => Math.abs(w) >= 1)),
      pages: L.body.filter((b) => b.pageBreak).length + 1,
      autoFix: L.autoFix,
      sign: L.signer.name, recipient: L.recipient.name,
    };
  `);
  check('it is taken as a form, not a letter', shape.form === true && !shape.sign && !shape.recipient, { form: shape.form, sign: shape.sign, recipient: shape.recipient });
  check('it opens on the page', shape.screen === 'page');
  check('nothing was made into a letterhead', !shape.letterhead.length, shape.letterhead);
  const frameText = shape.frames.map((f) => f.text);
  check('the head stays in separate frames', frameText.length === 5 && frameText.some((t) => t.includes('دانشگاه نمونه')) && frameText.some((t) => t.includes('آموزشکده نمونه')), frameText);
  const title = shape.frames.find((f) => f.text.includes('دانشگاه نمونه'));
  check('each frame has its own look', title.size === 12 && title.bold && title.align === 'center', title);
  check('each frame keeps its own height on the page, even beside another', title.y > 5, title.y);
  check('a frame of numbers alone keeps the font of the file', shape.frames.every((f) => f.font === 'Vazirmatn'), shape.frames.map((f) => f.font));
  const printDate = shape.frames.find((f) => f.text.includes('تاریخ چاپ'));
  check('and its own side of the page', printDate.align === 'left' && printDate.size === 7, printDate);
  check('there are as many tables as in the file', shape.tables.length === 4, shape.tables.map((t) => [t.rows, t.cols]));
  check('tables are laid out to the millimetre', shape.tables[0].pad === 0 && shape.tables[1].pad === 0);
  check('the box of details has its rows and columns, though no lines show them', shape.tables[0].rows === 5 && shape.tables[0].cols === 6, [shape.tables[0].rows, shape.tables[0].cols]);
  check('its cells hold one thing each', shape.info[0].length === 6 && shape.info[0][0].includes('دانشجویی') && shape.info[0][1] === '9900112233', shape.info[0]);
  const courseRow = shape.termRows.find((row) => row.some((t) => t === '3021120'));
  check('courses without lines come out as rows', !!courseRow, shape.termRows.length);
  check('with each column in its own cell', courseRow && courseRow.includes('19.00') && courseRow.includes('L4') && courseRow.includes('2') && courseRow.some((t) => t.includes('پایگاه')), courseRow);
  const text = shape.allText.join('\n');
  check('half-spaces come back exactly', text.includes('داده‌ها') && text.includes('سیستم‌عامل') && text.includes('تجزیه‌وتحلیل') && text.includes('برنامه‌نویسی') && text.includes('فارغ‌التحصیل'), text.match(/.*(داده|سیستم).*/g)?.slice(0, 4));
  check('no half-space stands where the file has none', text.split('‌').length - 1 === 6, text.split('‌').length - 1);
  check('no space falls inside a word in very small writing', !/وضعی ت|ن ام|واح د/.test(text) && text.includes('کد درس') && text.includes('نام درس'), text.match(/.*وضع.*/g)?.slice(0, 3));
  check('brackets face the right way', text.includes('(مبانی و مفاهیم)') && text.includes('(1)') && text.includes('(مبدأ و معاد)'), text.match(/.*[()].*/g));
  check('a sign after a word stays after it', text.includes('وضعیت: -'), text.match(/.*وضعیت.*/g)?.slice(0, 3));
  check('digits stay as the file writes them', text.includes('19.00') && text.includes('9900112233') && frameText.some((t) => t.includes('1405/08/11')), frameText);
  check('thick words stay thick, and the others stay plain', shape.bold > 10 && shape.regular > 5, [shape.bold, shape.regular]);
  check('lines are kept cell by cell', shape.hasOwnLines && shape.noLineInside, { own: shape.hasOwnLines, none: shape.noLineInside });
  check('the thicker frames stay thicker', shape.thickFrames);
  check('lines that touch make one thick line, not a double one', shape.thickInTerms > 0 && shape.doubleInTerms === 0, { thick: shape.thickInTerms, double: shape.doubleInTerms });
  check('a line with a gap in it stays a double line', shape.doubleLast > 0, shape.doubleLast);
  check('the second page comes after a page break', shape.pages === 2, shape.pages);
  check('the words stay exactly as they are in the file', shape.autoFix === false);

  await page.screenshot(join(out, 'form-phone-page.png'));

  /* ---------- What the page shows, and a PDF from a maker that does not say what its letters are ---------- */
  const shown = await page.evaluate(`
    const pageText = [...document.querySelectorAll('#page .page')].map((p) => p.textContent).join(' ');
    const sheet = document.querySelector('#page .page');
    const box = sheet.getBoundingClientRect();
    const mm = (v) => (v - box.top) / (box.width / 210);
    const frames = [...sheet.querySelectorAll('.obj-text')].map((el) => mm(el.getBoundingClientRect().bottom));
    return { dates: pageText.includes('1405/08/11'), persian: /[۰-۹]/.test(pageText), lowestFrame: Math.max(...frames), tableTop: mm(sheet.querySelector('table').getBoundingClientRect().top) };
  `);
  check('the page shows the digits of the file too', shown.dates && !shown.persian, shown);
  check('the first table stays below the frames above it', shown.tableTop >= shown.lowestFrame - 1.5, shown);
  const guessed = await page.evaluate(`
    const { importPdf } = await import('${WEB}/import-pdf.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(printed.data)}), (c) => c.charCodeAt(0));
    const L = await importPdf(bytes, window.__app.settings, { useActualText: false });
    const words = L.body.filter((b) => b.kind === 'table').flatMap((t) => t.rows.flat()).map((c) => c.paras.map((p) => p.runs.map((r) => r.text).join('')).join(' / '));
    return { words, sameAs: window.__app.letter.body.filter((b) => b.kind === 'table').flatMap((t) => t.rows.flat()).map((c) => c.paras.map((p) => p.runs.map((r) => r.text).join('')).join(' / ')) };
  `);
  const unlike = guessed.words.filter((w, i) => w !== guessed.sameAs[i]);
  check('a PDF that does not say what its letters are reads the same, from their shapes', guessed.words.length === guessed.sameAs.length && !unlike.length, unlike.slice(0, 6));

  /* ---------- Editing a cell on the page ---------- */
  await page.evaluate(`
    const { app } = await import('${WEB}/app.js');
    const stage = document.querySelector('#page .stage');
    stage.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 200));
  `);
  const before = await page.evaluate(`
    const td = [...document.querySelectorAll('#page .page td')].find((c) => c.textContent === '19.00');
    td.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 200));
    const rect = td.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  `);
  await page.tap(before.x, before.y);
  await page.sleep(300);
  const picked = await page.evaluate(`const on = document.querySelector('#page .sel-cell'); return on ? on.textContent : null;`);
  check('tapping a cell picks that very cell', picked === '19.00', picked);
  await page.evaluate(`document.querySelector('#page [aria-label="ویرایش متن"]').click(); await new Promise((r) => setTimeout(r, 200));`);
  const sheet = await page.evaluate(`const f = document.querySelector('.sheet input'); return f ? f.value : null;`);
  check('the pencil opens that cell by itself', sheet === '19.00', sheet);
  await page.screenshot(join(out, 'form-cell-sheet.png'));
  await page.evaluate(`
    const f = document.querySelector('.sheet input');
    f.value = '18.50';
    [...document.querySelectorAll('.sheet .btn')].find((b) => b.textContent === 'تأیید').click();
    await new Promise((r) => setTimeout(r, 300));
  `);
  const edited = await page.evaluate(`
    const L = window.__app.letter;
    const cells = L.body.filter((b) => b.kind === 'table').flatMap((t) => t.rows.flat());
    const hit = cells.find((c) => c.paras.some((p) => p.runs.some((r) => r.text === '18.50')));
    return { inModel: !!hit, look: hit?.paras[0].runs[0], onPage: [...document.querySelectorAll('#page .page td')].some((c) => c.textContent === '18.50'), inForm: L.bodyHtml.includes('18.50') };
  `);
  check('the new words are in the letter, the page and the form', edited.inModel && edited.onPage && edited.inForm, edited);
  check('with the look the old words had', edited.look?.size === 6 || edited.look?.b === true, edited.look);

  /* ---------- The form screen can show it too ---------- */
  // The phone's back button lets go of the cell first, then leaves the page.
  await page.evaluate(`window.__onBack(); await new Promise((r) => setTimeout(r, 300));`);
  const stillOnPage = await page.evaluate(`return { screen: window.__app.stack.at(-1), picked: !!document.querySelector('#page .sel-cell') };`);
  check('back lets go of the cell first', stillOnPage.screen === 'page' && !stillOnPage.picked, stillOnPage);
  await page.evaluate(`window.__onBack(); await new Promise((r) => setTimeout(r, 400));`);
  const formView = await page.evaluate(`
    const editor = document.querySelector('#compose .editor');
    const t = editor.querySelector('table[data-pad]');
    const r = t.getBoundingClientRect();
    const td = [...t.querySelectorAll('td')].find((c) => c.textContent.trim());
    const shownLabels = [...document.querySelectorAll('#compose .compose-form .label')].filter((el) => el.offsetParent !== null).length;
    return { screen: window.__app.stack.at(-1), wide: r.width > editor.clientWidth, scrolls: editor.scrollWidth > editor.clientWidth, font: getComputedStyle(td.querySelector('span') || td).fontSize, has: editor.textContent.includes('18.50'), shownLabels };
  `);
  check('in the form, the table is large enough to read and scrolls sideways', formView.screen === 'compose' && formView.wide && formView.scrolls && parseFloat(formView.font) >= 12 && formView.has, formView);
  check('and it asks for no recipient, subject or greeting', formView.shownLabels === 0, formView.shownLabels);
  await page.screenshot(join(out, 'form-compose.png'));

  /* ---------- Editor and back, without losing a thing ---------- */
  const same = await page.evaluate(`
    const { blocksToHtml, serializeEditor } = await import('${WEB}/editor.js');
    const L = window.__app.letter;
    const holder = document.createElement('div');
    holder.innerHTML = blocksToHtml(L.body);
    const again = serializeEditor(holder);
    // The order of a thing's properties means nothing.
    const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
    const a = JSON.stringify(canon(L.body));
    const b = JSON.stringify(canon(again));
    const firstDiff = [...a].findIndex((ch, i) => ch !== b[i]);
    return { same: a === b, at: firstDiff, a: a.slice(Math.max(0, firstDiff - 60), firstDiff + 60), b: b.slice(Math.max(0, firstDiff - 60), firstDiff + 60) };
  `);
  check('the form keeps every line, width and place of the table', same.same, same.same ? '' : same);

  /* ---------- Out to Word and back ---------- */
  const word = await page.evaluate(`
    const { makeDocx } = await import('${WEB}/export.js');
    const { bytesToBase64 } = await import('${WEB}/util.js');
    const { readZip } = await import('${WEB}/unzip.js');
    const made = await makeDocx(window.__app.letter, { deliver: false });
    const zip = readZip(made.bytes);
    const read = (name) => new TextDecoder().decode(zip.get(name)());
    const doc = read('word/document.xml');
    return {
      docx: bytesToBase64(made.bytes),
      tables: (doc.match(/<w:tbl>/g) || []).length,
      cellLines: (doc.match(/<w:tcBorders>/g) || []).length,
      exact: (doc.match(/w:lineRule="exact"/g) || []).length,
      vmerge: (doc.match(/<w:vMerge/g) || []).length,
      lineAboveFirst: Number(doc.slice(doc.indexOf('<w:body>'), doc.indexOf('<w:tbl>')).match(/w:line="(\\d+)"/)?.[1] || 0),
      carried: !!zip.get('word/fonts/font1.odttf') && !!zip.get('word/fonts/font2.odttf'),
      fontTable: read('word/fontTable.xml').includes('embedRegular'),
      settings: read('word/settings.xml').includes('embedTrueTypeFonts'),
      types: read('[Content_Types].xml').includes('odttf'),
      fontRels: read('word/_rels/fontTable.xml.rels').includes('font1.odttf'),
    };
  `);
  writeFileSync(join(out, 'form-export.docx'), Buffer.from(word.docx, 'base64'));
  check('the Word file has real tables with lines of their own', word.tables === 4 && word.cellLines > 50 && word.exact > 50, { tables: word.tables, lines: word.cellLines, exact: word.exact });
  check('in Word too, the first table stays below the frames above it', word.lineAboveFirst > 500, word.lineAboveFirst);
  check('and carries its font', word.carried && word.fontTable && word.settings && word.types && word.fontRels, { carried: word.carried, table: word.fontTable, settings: word.settings, types: word.types, rels: word.fontRels });

  const back = await page.evaluate(`
    const { importDocx } = await import('${WEB}/import-docx.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(word.docx)}), (c) => c.charCodeAt(0));
    const first = window.__app.letter;
    const L = await importDocx(bytes, window.__app.settings);
    const summary = (letter) => letter.body.filter((b) => b.kind === 'table').map((t) => ({
      rows: t.rows.length,
      pad: t.pad,
      borderless: !!t.borderless,
      cells: t.rows.flat().map((c) => ({
        text: c.paras.map((p) => p.runs.map((r) => r.text).join('')).join('/'),
        // Word rounds the width of a double line, so only that it is double has to hold.
        borders: (c.borders || []).map((w) => (w < 0 ? 'double' : Math.round(w * 4) / 4)),
        span: c.colSpan || 1,
        rowSpan: c.rowSpan || 1,
        rowH: Math.round((c.rowH || 0) * 10) / 10,
      })),
    }));
    const a = summary(first);
    const b = summary(L);
    const diffs = [];
    a.forEach((t, i) => t.cells.forEach((c, j) => {
      const other = b[i]?.cells[j];
      for (const key of ['text', 'span', 'rowSpan']) if (JSON.stringify(c[key]) !== JSON.stringify(other?.[key])) diffs.push([i, j, key, c[key], other?.[key]]);
      if (JSON.stringify(c.borders) !== JSON.stringify(other?.borders)) diffs.push([i, j, 'borders', c.borders, other?.borders]);
      if (Math.abs(c.rowH - (other?.rowH || 0)) > 0.15) diffs.push([i, j, 'rowH', c.rowH, other?.rowH]);
    }));
    return {
      tables: [a.length, b.length],
      pad: b.map((t) => t.pad),
      diffs: diffs.slice(0, 8),
      diffCount: diffs.length,
      frames: L.objects.filter((o) => o.kind === 'text').map((o) => o.text),
      font: L.styles.table?.font,
      autoFix: L.autoFix,
    };
  `);
  check('Word file read back: same tables, kept to the millimetre', back.tables[0] === back.tables[1] && back.pad.every((p) => p === 0), back.tables);
  check('same cells, words, lines and row heights', back.diffCount === 0, back.diffCount ? back.diffs : '');
  check('same frames at the top, down to their digits', back.frames.length === 5 && back.frames.some((t) => t.includes('دانشگاه نمونه')) && back.frames.some((t) => t.includes('1405/08/11')), back.frames);
  check('same font', back.font === 'Vazirmatn', back.font);
  check('and it is still a form, whose words stay as they are', back.autoFix === false, back.autoFix);

  /* ---------- Saved, closed and opened again from the archive ---------- */
  const saved = await page.evaluate(`
    const { getDoc } = await import('${WEB}/store.js');
    const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
    const id = window.__app.letter.id;
    const before = JSON.stringify(canon(window.__app.letter.body));
    const objectsBefore = window.__app.letter.objects.length;
    // The phone's back button, all the way home.
    for (let i = 0; i < 4 && window.__app.stack.at(-1) !== 'home'; i++) {
      window.__onBack();
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 900));
    const stored = await getDoc('letters', id);
    const home = window.__app.stack.at(-1);
    const row = document.querySelector('#home .letter-row');
    row?.click();
    await new Promise((r) => setTimeout(r, 800));
    const L = window.__app.letter;
    return { home, row: !!row, stored: JSON.stringify(canon(stored?.body)) === before, reopened: L.id === id && JSON.stringify(canon(L.body)) === before, frames: L.objects.length === objectsBefore, autoFix: L.autoFix, screen: window.__app.stack.at(-1), edited: JSON.stringify(L.body).includes('18.50') };
  `);
  check('leaving saves it, with every cell', saved.home === 'home' && saved.stored, saved);
  check('opening it again from the archive brings back the same thing', saved.row && saved.reopened && saved.frames && saved.autoFix === false && saved.edited, saved);
  check('and opens on its page', saved.screen === 'page', saved.screen);
  await page.screenshot(join(out, 'form-reopened.png'));
  const afterForm = await page.evaluate(`
    for (let i = 0; i < 4 && window.__app.stack.at(-1) !== 'home'; i++) {
      window.__onBack();
      await new Promise((r) => setTimeout(r, 300));
    }
    document.querySelector('#home .hero-cta').click();
    await new Promise((r) => setTimeout(r, 600));
    const labels = [...document.querySelectorAll('#compose .compose-form .label')].filter((el) => el.offsetParent !== null).length;
    window.__onBack();
    await new Promise((r) => setTimeout(r, 400));
    return labels;
  `);
  check('a new letter after it asks for its usual parts again', afterForm >= 3, afterForm);

  /* ---------- A letter with a table stays a letter ---------- */
  await page.goto('http://127.0.0.1:8770/tools/letter-table-sample.html');
  await page.sleep(1000);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const letterPdf = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
  await page.goto(APP);
  await page.sleep(1000);
  const letter = await page.evaluate(`
    const { importPdf } = await import('${WEB}/import-pdf.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(letterPdf.data)}), (c) => c.charCodeAt(0));
    const L = await importPdf(bytes, window.__app.settings);
    const body = L.body.map((b) => (b.kind === 'p' ? b.runs.map((r) => r.text).join('') : '')).join(' ');
    const all = [body, L.closing].join(' ');
    return { form: !!L.importInfo.form, autoFix: L.autoFix, greeting: L.greeting, subject: L.subject, recipient: L.recipient.name, tables: L.body.filter((b) => b.kind === 'table').length, halfSpace: all.includes('می‌رساند') && all.includes('آن‌ها') && all.includes('جناب‌عالی') && all.includes('نامهٔ'), body: all };
  `);
  check('a letter with a table stays a letter', !letter.form && letter.autoFix !== false && letter.tables === 1 && !!letter.greeting && !!letter.subject, letter);
  check('and keeps its half-spaces', letter.halfSpace, letter.body);
  if (page.errors.length) console.log('script errors:', page.errors);
  check('no script errors', page.errors.length === 0);
} catch (err) {
  console.log('FAIL the run stopped:', err.message);
  failed++;
} finally {
  await page.close();
}

console.log(failed ? `${failed} checks failed` : 'all form checks passed');
process.exit(failed ? 1 : 0);
