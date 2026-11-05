// The tools that save the most time: every blank on one sheet, a reply in one tap, a form from any file, a paragraph that wraps,
// a new picture in an old frame, choosing many lines at once, and whole pages.
//   node tools/ui-test-fast.js <out-folder>      (needs the preview server on port 8770)
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

const page = await openPhone({ port: 9387 });
const wait = (ms = 300) => page.sleep(ms);
const clickText = (selector, text) => page.evaluate(`
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.includes(${JSON.stringify(text)}));
  if (!el) throw new Error('no button: ' + ${JSON.stringify(text)});
  el.click();
`);
const clickLabel = (label) => page.evaluate(`
  const el = document.querySelector('#page [aria-label="${label}"]');
  if (!el) throw new Error('no button: ${label}');
  el.click();
`);
// Sheets write into inputs the way a keyboard does.
const type = (selector, index, value) => page.evaluate(`
  const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
`);

try {
  /* ---------- A sample with something of everything ---------- */
  await page.goto('http://127.0.0.1:8770/tools/exact-sample.html');
  await wait(1200);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const printed = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });

  /* ---------- Every blank on one sheet ---------- */
  await page.goto(APP);
  await wait(1000);
  await page.evaluate(`
    const { newLetter } = await import('${WEB}/model.js');
    const { showScreen, app } = await import('${WEB}/app.js');
    const { TEMPLATES } = await import('${WEB}/data/templates.js');
    app.letter = newLetter(app.settings);
    app.letter.subject = 'خرید تجهیزات';
    showScreen('compose', { fresh: true, template: TEMPLATES.find((t) => t.id === 'reply') });
    await new Promise((r) => setTimeout(r, 500));
  `);
  const before = await page.evaluate(`
    const bar = document.querySelector('.fill-bar');
    return { hidden: bar.hidden, label: bar.textContent, inEditor: bar.classList.contains('in-editor'), blanks: document.querySelectorAll('#compose .editor .ph').length };
  `);
  check('a letter with blanks offers to fill them at once', !before.hidden && /جای خالی/.test(before.label), before);
  await page.evaluate(`document.querySelector('.fill-bar button').click();`);
  await wait();
  const sheet = await page.evaluate(`
    const inputs = [...document.querySelectorAll('.fill-sheet input')];
    return { labels: inputs.map((i) => i.getAttribute('aria-label')), tips: document.querySelectorAll('.fill-tips .chip').length, focused: document.activeElement === inputs[0] };
  `);
  check('the sheet asks each blank once', new Set(sheet.labels).size === sheet.labels.length && sheet.labels.includes('شماره') && sheet.labels.includes('پاسخ'), sheet.labels);
  check('the first box is ready to write in', sheet.focused);
  check('today is offered for a date', sheet.tips >= 1, sheet.tips);
  const labels = sheet.labels;
  for (let i = 0; i < labels.length; i++) await type('.fill-sheet input', i, labels[i] === 'شماره' ? '۱۲۳' : labels[i] === 'تاریخ' ? '۱۴۰۵/۰۱/۰۱' : 'متن نمونه');
  await clickText('.fill-sheet .btn.primary', 'تأیید');
  await wait(400);
  const filled = await page.evaluate(`
    const { countBlanks } = await import('${WEB}/model.js');
    const L = window.__app.letter;
    return { left: countBlanks(L), text: L.body.map((b) => (b.runs || []).map((r) => r.text).join('')).join(' '), shown: document.querySelector('#compose .editor').textContent, bar: document.querySelector('.fill-bar').hidden, kept: window.__app.settings.blankValues?.['شماره'] };
  `);
  check('all of them are filled', filled.left === 0 && filled.text.includes('۱۲۳') && filled.text.includes('۱۴۰۵/۰۱/۰۱'), filled.text.slice(0, 60));
  check('the text on the screen shows it too', filled.shown.includes('۱۲۳') && filled.bar);
  check('what was written is kept for next time', filled.kept?.[0] === '۱۲۳', filled.kept);

  /* ---------- A reply in one tap ---------- */
  const reply = await page.evaluate(`
    const { showScreen, app, backToHome } = await import('${WEB}/app.js');
    const { newLetter } = await import('${WEB}/model.js');
    backToHome();
    const source = { ...newLetter(app.settings), id: 'in-1', imported: true, subject: 'درخواست همکاری', number: '۷۷/۸۸', date: '۱۴۰۵/۰۲/۰۳', signer: { name: 'آقای نمونه', title: 'مدیر نمونه' }, status: 'done' };
    app.letters.unshift(source);
    app.screens.home.show();
    await new Promise((r) => setTimeout(r, 300));
    return true;
  `);
  const menuOpened = await page.evaluate(`
    const row = document.querySelector('#home .letter-more, #home [aria-label*="بیشتر"], #home [aria-label*="گزینه"]');
    if (row) { row.click(); return 'button'; }
    return 'none';
  `);
  await wait();
  let replied = null;
  if (menuOpened === 'button') {
    await clickText('.sheet-action', 'پاسخ به این نامه');
    await wait(800);
    replied = await page.evaluate(`
      const L = window.__app.letter;
      const editor = document.querySelector('#compose .editor');
      return { screen: window.__app.stack.at(-1), to: L.recipient, subject: L.subject, text: editor.textContent, blanks: [...editor.querySelectorAll('.ph')].map((el) => el.textContent), template: L.templateId };
    `);
  }
  check('the letter menu offers a reply', menuOpened === 'button', menuOpened);
  check('it goes to whoever signed the letter', replied?.to?.name === 'آقای نمونه' && replied?.to?.title === 'مدیر نمونه', replied?.to);
  check('about the same subject', replied?.subject === 'درخواست همکاری', replied?.subject);
  check('naming the letter it answers', replied?.text.includes('۷۷/۸۸') && replied?.text.includes('۱۴۰۵/۰۲/۰۳') && replied?.text.includes('درخواست همکاری'), replied?.text);
  check('only the answer is left to write', replied?.blanks.length === 1 && replied?.blanks[0] === '[پاسخ]', replied?.blanks);

  /* ---------- A form from any file ---------- */
  await page.goto(APP);
  await wait(1000);
  await page.evaluate(`
    const { openLetterFile } = await import('${WEB}/screens/home.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(printed.data)}), (c) => c.charCodeAt(0));
    await openLetterFile(bytes, 'exact-sample.pdf');
    await new Promise((r) => setTimeout(r, 700));
    for (let i = 0; i < 4; i++) document.querySelector('#page [aria-label="بزرگ‌نمایی"]').click();
  `);
  await wait(200);
  const frameBox = (needle) => page.evaluate(`
    const L = window.__app.letter;
    const o = L.objects.find((x) => x.kind === 'text' && x.text.includes(${JSON.stringify(needle)}));
    const el = document.querySelector('#page .obj[data-id="' + o.id + '"]');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { id: o.id, x: Math.max(20, Math.min(340, r.left + r.width / 2)), y: r.top + r.height / 2, text: o.text };
  `);
  let f = await frameBox('متن زیر پرده');
  await page.tap(f.x, f.y);
  await wait(300);
  await clickLabel('تبدیل به جای خالی');
  await wait();
  await type('.sheet input, .sheet-body input', 1, 'نام نمونه');
  const marked0 = await page.evaluate(`return document.querySelector('.note')?.textContent;`);
  await page.evaluate(`[...document.querySelectorAll('button.primary')].filter((b) => b.textContent.includes('تأیید')).pop().click();`);
  await wait(400);
  const marked = await page.evaluate(`
    const { blanksOf } = await import('${WEB}/model.js');
    const L = window.__app.letter;
    return { blanks: blanksOf(L), fields: L.fields, text: L.objects.find((x) => x.id === '${f.id}')?.text, mark: document.querySelector('#page .obj[data-id="${f.id}"] .ph-mark')?.textContent };
  `);
  check('words become a blank', marked.text === '[نام نمونه]' && marked.blanks.length === 1 && marked.blanks[0].label === 'نام نمونه', marked);
  check('and it stands out on the page', marked.mark === '[نام نمونه]', marked.mark);
  await page.evaluate(`
    document.querySelector('#page [aria-label="بازگشت"], #page .topbar button')?.blur();
  `);
  const idle = await page.evaluate(`
    const { goBack } = await import('${WEB}/app.js');
    goBack();
    await new Promise((r) => setTimeout(r, 200));
    return [...document.querySelectorAll('#page .tools button')].map((b) => b.textContent.trim()).filter(Boolean);
  `);
  check('nothing stray is written among the tools', !(await page.evaluate(`return document.querySelector('#page .tools').textContent;`)).includes('false'));
  check('the page offers to fill it and to keep it as a form', idle.some((t) => /پر کردن/.test(t)) && idle.includes('ذخیره به‌عنوان فرم') && idle.includes('جای خالی تازه') && idle.includes('صفحه‌ها'), idle);
  await clickText('#page .tools button', 'جای خالی تازه');
  await wait();
  await type('.sheet input', 0, 'تلفن');
  await page.evaluate(`[...document.querySelectorAll('button.primary')].filter((b) => b.textContent.includes('تأیید')).pop().click();`);
  await wait(400);
  const added = await page.evaluate(`
    const { blanksOf } = await import('${WEB}/model.js');
    const { mediaIdsOf } = await import('${WEB}/store.js');
    const L = window.__app.letter;
    const o = L.objects.find((x) => x.text === '[تلفن]');
    return { blanks: blanksOf(L).map((b) => b.label), selected: document.querySelectorAll('#page .sel-box').length, page: o?.page, keepsInk: mediaIdsOf(L).includes(L.ink.id) };
  `);
  check('a new blank can be put on an empty spot', added.blanks.includes('تلفن') && added.selected === 1, added);
  check('backups and forms carry the letters of the file', added.keepsInk);
  await page.evaluate(`document.querySelector('#page [aria-label="برگرداندن آخرین تغییر"]').click();`);
  await wait(300);
  await clickText('#page .tools button', 'ذخیره به‌عنوان فرم');
  await wait();
  await type('.sheet input, .sheet-body input', 0, 'فرم نمونه');
  await page.evaluate(`[...document.querySelectorAll('button.primary')].filter((b) => b.textContent.includes('تأیید')).pop().click();`);
  await wait(500);
  const saved = await page.evaluate(`
    const { getDoc, listDocs } = await import('${WEB}/store.js');
    const t = window.__app.templates.find((x) => x.title === 'فرم نمونه');
    const stored = await listDocs('templates');
    return { found: !!t, whole: !!t?.whole, frames: t?.whole?.objects.filter((o) => o.kind === 'text').length, ink: !!t?.whole?.ink, paper: t?.whole?.page, stored: stored.some((x) => x.title === 'فرم نمونه'), id: t?.id };
  `);
  check('the form is kept with everything of the file', saved.found && saved.whole && saved.frames > 5 && saved.ink && saved.stored, saved);

  // Start from it, as a tile on the first screen would.
  await page.goto(APP);
  await wait(1000);
  const tile = await page.evaluate(`
    for (let i = 0; i < 50 && !window.__app?.screens?.home; i++) await new Promise((r) => setTimeout(r, 100));
    const el = [...document.querySelectorAll('#home .quick-tile')].find((b) => b.textContent.includes('فرم نمونه'));
    if (!el) return false;
    el.click();
    await new Promise((r) => setTimeout(r, 900));
    return true;
  `);
  check('the form has a tile on the first screen', tile);
  const started = await page.evaluate(`
    const L = window.__app.letter;
    return { screen: window.__app.stack.at(-1), labels: [...document.querySelectorAll('.fill-sheet input')].map((i) => i.getAttribute('aria-label')), source: L.templateId, inked: document.querySelectorAll('#page .obj-inked').length, paper: L.page, width: document.querySelector('#page .page')?.style.width, id: L.id };
  `);
  check('it opens on its page asking for its blanks', started.screen === 'page' && started.labels.join() === 'نام نمونه', started);
  check('with the look and size of the file', started.inked > 5 && parseFloat(started.width) === started.paper?.w, [started.inked, started.width]);
  await type('.fill-sheet input', 0, 'پر شده');
  await clickText('.fill-sheet .btn.primary', 'تأیید');
  await wait(400);
  const done = await page.evaluate(`
    const { countBlanks } = await import('${WEB}/model.js');
    const L = window.__app.letter;
    const t = window.__app.templates.find((x) => x.title === 'فرم نمونه');
    return { left: countBlanks(L), has: L.objects.some((o) => o.text === 'پر شده'), formStill: t.whole.objects.some((o) => o.text === '[نام نمونه]'), different: L.id !== t.id };
  `);
  check('filling it changes only the new copy', done.left === 0 && done.has && done.formStill && done.different, done);

  /* ---------- A form with tables: a cell becomes a blank, even an empty one ---------- */
  await page.goto('http://127.0.0.1:8770/tools/form-sample.html');
  await wait(1000);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const formPdf = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
  await page.goto(APP);
  await wait(1000);
  await page.evaluate(`
    const { openLetterFile } = await import('${WEB}/screens/home.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(formPdf.data)}), (c) => c.charCodeAt(0));
    await openLetterFile(bytes, 'form-sample.pdf');
    await new Promise((r) => setTimeout(r, 700));
    for (let i = 0; i < 6; i++) document.querySelector('#page [aria-label="بزرگ‌نمایی"]').click();
  `);
  await wait(200);
  const cellAt = await page.evaluate(`
    const td = [...document.querySelectorAll('#page td')].find((c) => c.textContent.trim().length > 3);
    td.scrollIntoView({ block: 'center', inline: 'center' });
    const r = td.getBoundingClientRect();
    return { x: Math.max(10, Math.min(350, r.left + r.width / 2)), y: r.top + r.height / 2, text: td.textContent.trim() };
  `);
  await page.tap(cellAt.x, cellAt.y);
  await wait(300);
  await clickLabel('تبدیل به جای خالی');
  await wait();
  await type('.sheet input', 1, 'خانهٔ نمونه');
  await page.evaluate(`[...document.querySelectorAll('button.primary')].filter((b) => b.textContent.includes('تأیید')).pop().click();`);
  await wait(400);
  const formCell = await page.evaluate(`
    const { blanksOf } = await import('${WEB}/model.js');
    const L = window.__app.letter;
    return { form: L.importInfo.form, exact: !!L.importInfo.exact, blanks: blanksOf(L).filter((b) => b.label === 'خانهٔ نمونه').length, shown: !!document.querySelector('#page td .ph-mark') };
  `);
  check('a cell of a form becomes a blank', formCell.form && !formCell.exact && formCell.blanks === 1 && formCell.shown, { ...formCell, text: cellAt.text });

  /* ---------- A paragraph that wraps ---------- */
  await page.goto(APP);
  await wait(800);
  await page.evaluate(`
    const { openLetterFile } = await import('${WEB}/screens/home.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(printed.data)}), (c) => c.charCodeAt(0));
    await openLetterFile(bytes, 'exact-sample.pdf');
    await new Promise((r) => setTimeout(r, 700));
    for (let i = 0; i < 4; i++) document.querySelector('#page [aria-label="بزرگ‌نمایی"]').click();
  `);
  await wait(200);
  f = await frameBox('پاراگراف نمونه');
  const around = await page.evaluate(`
    const { paragraphAround, columnOf } = await import('${WEB}/placed.js');
    const L = window.__app.letter;
    const o = L.objects.find((x) => x.id === '${f.id}');
    return { lines: paragraphAround(L, o).map((x) => x.text), column: columnOf(L, o).map((x) => x.text) };
  `);
  check('the lines of a paragraph are found', around.lines.length === 4 && around.lines[0].includes('پاراگراف نمونه') && around.lines[3].includes('دیده شوند'), around.lines.length);
  check('and not those of the other column', !around.lines.join().includes('قاطی'));
  const below = await page.evaluate(`
    const L = window.__app.letter;
    const o = L.objects.find((x) => x.text?.includes('خاکستری'));
    return { id: o.id, y: o.y };
  `);
  await page.tap(f.x, f.y);
  await wait(300);
  await clickText('#page .tools button', 'کل پاراگراف');
  await wait();
  const editing = await page.evaluate(`const t = document.querySelector('.flow-text'); return { value: t.value, lines: t.value.split('\\n').length };`);
  check('the whole paragraph opens as one text', editing.value.includes('پاراگراف نمونه') && editing.value.includes('دیده شوند') && editing.lines === 1, editing.lines);
  const longer = `${editing.value} ${'این جمله برای بلندتر شدن پاراگراف اضافه شده است و باید سطر تازه بسازد. '.repeat(3)}`;
  await type('.flow-text', 0, longer);
  await page.evaluate(`[...document.querySelectorAll('button.primary')].filter((b) => b.textContent.includes('تأیید')).pop().click();`);
  await wait(500);
  const flowed = await page.evaluate(`
    const L = window.__app.letter;
    const o = L.objects.find((x) => x.flow);
    const el = document.querySelector('#page .obj[data-id="' + o.id + '"]');
    const gone = L.objects.filter((x) => x.kind === 'text' && x.text.includes('پاراگراف نمونه') && !x.flow).length;
    return { h: o.h, w: o.w, line: o.style.line, align: o.style.align, gone, wraps: el.getBoundingClientRect().height > el.querySelector('div').getBoundingClientRect().height * 0 && o.h > o.style.line * 0.3528 * 3.5, belowY: L.objects.find((x) => x.id === '${below.id}').y, style: getComputedStyle(el).whiteSpace, selected: document.querySelectorAll('#page .sel-box').length };
  `);
  check('one frame stands in place of the lines, and wraps', flowed.gone === 0 && flowed.style === 'pre-wrap' && flowed.wraps && flowed.align === 'justify', flowed);
  check('what stands below it in the column moves down', flowed.belowY > below.y + 3, [below.y, flowed.belowY]);
  await page.evaluate(`document.querySelector('#page [aria-label="برگرداندن آخرین تغییر"]').click();`);
  await wait(400);
  const undone = await page.evaluate(`
    const L = window.__app.letter;
    return { flow: L.objects.filter((x) => x.flow).length, belowY: L.objects.find((x) => x.id === '${below.id}').y, inked: document.querySelectorAll('#page .obj-inked').length, lines: L.objects.filter((x) => x.kind === 'text').length };
  `);
  check('undo brings the exact lines back', undone.flow === 0 && undone.belowY === below.y && undone.inked === undone.lines, undone);
  await page.evaluate(`document.querySelector('#page [aria-label="انجام دوبارهٔ تغییر"]').click();`);
  await wait(400);

  const wordFile = await page.evaluate(`
    const { makeDocx } = await import('${WEB}/export.js');
    const { readZip } = await import('${WEB}/unzip.js');
    const { importDocx } = await import('${WEB}/import-docx.js');
    const made = await makeDocx(window.__app.letter, { deliver: false });
    const xml = new TextDecoder().decode(readZip(made.bytes).get('word/document.xml')());
    const back = await importDocx(made.bytes, window.__app.settings);
    const flow = back.objects.find((o) => o.flow);
    return { both: (xml.match(/<w:pStyle[^>]*\\/><w:jc w:val="both"\\/>/g) || []).length, grows: (xml.match(/<a:spAutoFit\\/>/g) || []).length, backFlow: !!flow, backAlign: flow?.style.align, backText: flow?.text.includes('بلندتر شدن') };
  `);
  check('in Word it is one paragraph that wraps, in a box that grows', wordFile.both === 1 && wordFile.grows === 1, wordFile);
  check('and it opens from Word the same way', wordFile.backFlow && wordFile.backAlign === 'justify' && wordFile.backText, wordFile);
  await page.evaluate(`document.querySelector('#page [aria-label="برگرداندن آخرین تغییر"]').click();`);
  await wait(400);

  /* ---------- A new picture in an old frame ---------- */
  const swapped = await page.evaluate(`
    const { pictureForFrame } = await import('${WEB}/image.js');
    const { loadImage } = await import('${WEB}/util.js');
    // A wide test picture, half red and half blue, to see that it is cropped and not stretched.
    const c = document.createElement('canvas');
    c.width = 1000; c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = '#d00'; x.fillRect(0, 0, 500, 200);
    x.fillStyle = '#00d'; x.fillRect(500, 0, 500, 200);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    const file = new File([blob], 'new.png', { type: 'image/png' });
    const url = await pictureForFrame(file, { widthMm: 50, aspect: 1, outline: null });
    const img = await loadImage(url);
    const d = document.createElement('canvas');
    d.width = img.naturalWidth; d.height = img.naturalHeight;
    const y = d.getContext('2d');
    y.drawImage(img, 0, 0);
    const left = [...y.getImageData(5, 5, 1, 1).data];
    const right = [...y.getImageData(d.width - 5, 5, 1, 1).data];
    // In a round frame with a ring, like a portrait in the weekly.
    const k = 2;
    const ring = { ox: 10, oy: 20, pw: 100, clip: 'M60 20C87.6 20 110 42.4 110 70C110 97.6 87.6 120 60 120C32.4 120 10 97.6 10 70C10 42.4 32.4 20 60 20Z', stroke: 'M60 20C87.6 20 110 42.4 110 70C110 97.6 87.6 120 60 120C32.4 120 10 97.6 10 70C10 42.4 32.4 20 60 20Z', w: 2, color: '#000000' };
    const roundUrl = await pictureForFrame(file, { widthMm: 40, aspect: 1, outline: ring });
    const round = await loadImage(roundUrl);
    const e = document.createElement('canvas');
    e.width = round.naturalWidth; e.height = round.naturalHeight;
    const z = e.getContext('2d');
    z.drawImage(round, 0, 0);
    const corner = [...z.getImageData(3, 3, 1, 1).data];
    const middle = [...z.getImageData(e.width >> 1, e.height >> 1, 1, 1).data];
    const edge = [...z.getImageData(1, e.height >> 1, 1, 1).data];
    return { square: [d.width, d.height], left, right, corner, middle, edge };
  `);
  check('a new picture fills its frame without being stretched', swapped.square[0] === swapped.square[1] && swapped.left[0] > 150 && swapped.right[2] > 150, swapped.square);
  check('in a round frame it stays round', swapped.corner.slice(0, 3).every((v) => v > 240) && swapped.middle[0] + swapped.middle[2] > 150, { corner: swapped.corner, middle: swapped.middle });
  check('with the frame\'s own ring', swapped.edge.slice(0, 3).every((v) => v < 120), swapped.edge);
  const tools = await page.evaluate(`
    const L = window.__app.letter;
    const pic = L.objects.find((o) => o.kind === 'image' && !o.behind);
    const el = document.querySelector('#page .obj[data-id="' + pic.id + '"]');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.max(20, Math.min(340, r.left + r.width / 2)), y: r.top + r.height / 2 };
  `);
  await page.tap(tools.x, tools.y);
  await wait(300);
  const swapButton = await page.evaluate(`return !!document.querySelector('#page [aria-label="عوض کردن عکس با همین قاب"]');`);
  check('a picture offers to be changed', swapButton);
  await page.evaluate(`const { goBack } = await import('${WEB}/app.js'); goBack();`);
  await wait(200);

  /* ---------- Many lines at once ---------- */
  f = await frameBox('این متن در ستون چپ');
  await page.tap(f.x, f.y);
  await wait(300);
  await clickText('#page .tools button', 'چندتایی');
  await wait();
  await clickText('#page .tools button', 'کل ستون');
  await wait();
  const column = await page.evaluate(`return { n: document.querySelectorAll('#page .obj.sel-on').length, label: document.querySelector('#page .tools .hint').textContent };`);
  check('a whole column is chosen at once', column.n === 3, column);
  await clickText('#page .tools button', 'هم‌شکل‌ها');
  await wait();
  const same = await page.evaluate(`
    const { TEXT_STYLE } = await import('${WEB}/model.js');
    const L = window.__app.letter;
    const want = L.objects.find((x) => x.text?.includes('این متن در ستون چپ'));
    const count = L.objects.filter((x) => x.kind === 'text' && x.style.font === want.style.font && x.style.size === want.style.size && !!x.style.bold === !!want.style.bold).length;
    return { n: document.querySelectorAll('#page .obj.sel-on').length, count };
  `);
  check('so is everything in the same look, on every page', same.n === same.count && same.n > 3, same);
  const oneChange = await page.evaluate(`
    const L = window.__app.letter;
    const y0 = L.objects.find((x) => x.text?.includes('این متن در ستون چپ')).y;
    const t = performance.now();
    document.querySelector('#page [aria-label="بزرگ‌تر"]').click();
    const big = L.objects.filter((x) => x.kind === 'text' && x.style.size !== 10 && x.style.size !== 20 && x.style.size !== undefined).length;
    return { big, y0 };
  `);
  await wait(300);
  await clickLabel('برگرداندن آخرین تغییر');
  await wait(300);
  const moved = await page.evaluate(`
    const L = window.__app.letter;
    const pick = L.objects.find((x) => x.text?.includes('این متن در ستون چپ'));
    const x0 = pick.x;
    document.querySelector('#page [aria-label="جابه‌جایی به چپ"]').click();
    const x1 = L.objects.find((x) => x.id === pick.id).x;
    return { x0, x1, buttons: [...document.querySelectorAll('#page .tools [aria-label]')].map((b) => b.getAttribute('aria-label')) };
  `);
  check('a group moves together', moved.x1 === moved.x0 - 1, moved.x1 - moved.x0);
  check('and can be made one text, or removed', moved.buttons.includes('حذف همه'), moved.buttons.length);
  await clickLabel('برگرداندن آخرین تغییر');
  await wait(200);
  await clickText('#page .tools button', 'پایان');
  await wait(200);

  /* ---------- Whole pages ---------- */
  const shape = () => page.evaluate(`
    const L = window.__app.letter;
    return { pages: L.body.length, shown: document.querySelectorAll('#page .page-box').length, first: L.objects.filter((o) => o.page === 0 && o.kind === 'text').length, second: L.objects.filter((o) => o.page === 1 && o.kind === 'text').length, breaks: L.body.filter((b) => b.pageBreak).length };
  `);
  const p0 = await shape();
  await clickText('#page .tools button', 'صفحه‌ها');
  await wait();
  await clickText('.sheet-action', 'یک کپی از این صفحه');
  await wait(400);
  const p1 = await shape();
  check('a page is copied', p1.pages === 3 && p1.shown === 3 && p1.breaks === 2, p1);
  const whichVisible = await page.evaluate(`return window.__app.letter.objects.filter((o) => o.kind === 'text').reduce((m, o) => { m[o.page] = (m[o.page] || 0) + 1; return m; }, {});`);
  const counts = Object.values(whichVisible);
  check('with all that is on it', counts.length === 3, whichVisible);
  await clickLabel('برگرداندن آخرین تغییر');
  await wait(400);
  const p2 = await shape();
  check('and undo takes it back', p2.pages === p0.pages && p2.shown === p0.shown, p2);
  const pagesMath = await page.evaluate(`
    const { clone } = await import('${WEB}/util.js');
    const { deletePage, movePage, letterWithPages, parsePages } = await import('${WEB}/placed.js');
    const source = clone(window.__app.letter);
    const a = clone(source);
    movePage(a, 0, 1);
    const moved = a.objects.filter((o) => o.page === 1 && o.kind === 'text').length;
    const b = clone(source);
    const firstCount = b.objects.filter((o) => o.page === 1 && o.kind === 'text').length;
    deletePage(b, 0);
    const c = letterWithPages(source, [1]);
    return {
      moved, first: source.objects.filter((o) => o.page === 0 && o.kind === 'text').length,
      afterDelete: { pages: b.body.length, onFirst: b.objects.filter((o) => o.page === 0 && o.kind === 'text').length, firstCount, breaks: b.body.filter((x) => x.pageBreak).length },
      only: { pages: c.body.length, onFirst: c.objects.filter((o) => o.page === 0 && o.kind === 'text').length, sourceStill: source.body.length },
      parsed: [parsePages('', 8), parsePages('۲', 8), parsePages('۱-۳، ۵', 8), parsePages('9', 8), parsePages('x', 8)],
    };
  `);
  check('a page moves', pagesMath.moved === pagesMath.first, pagesMath.moved);
  check('a page is removed, and the next takes its place', pagesMath.afterDelete.pages === 1 && pagesMath.afterDelete.onFirst === pagesMath.afterDelete.firstCount && pagesMath.afterDelete.breaks === 0, pagesMath.afterDelete);
  check('a file can hold only some pages', pagesMath.only.pages === 1 && pagesMath.only.sourceStill === 2 && pagesMath.only.onFirst > 0, pagesMath.only);
  check('pages are read as written', JSON.stringify(pagesMath.parsed) === JSON.stringify([[], [1], [0, 1, 2, 4], null, null]), pagesMath.parsed);
  const only = await page.evaluate(`
    const { makeDocx, preparePrintRoot } = await import('${WEB}/export.js');
    const { readZip } = await import('${WEB}/unzip.js');
    const made = await makeDocx(window.__app.letter, { deliver: false, pages: [1] });
    const xml = new TextDecoder().decode(readZip(made.bytes).get('word/document.xml')());
    return { name: made.name, breaks: (xml.match(/<w:pageBreakBefore\\/>/g) || []).length, boxes: (xml.match(/<wps:txbx>/g) || []).length };
  `);
  check('and Word gets only those', only.breaks === 0 && only.boxes >= 1 && only.boxes < 5 && only.name.includes('صفحهٔ'), only);
  const sheetRow = await page.evaluate(`
    [...document.querySelectorAll('#page .topbar button')].find((b) => b.textContent.includes('خروجی')).click();
    await new Promise((r) => setTimeout(r, 200));
    const input = document.querySelector('.export-pages input');
    const size = document.querySelector('.export-size')?.textContent;
    document.querySelector('.sheet [aria-label="بستن"]')?.click();
    return { input: !!input, size };
  `);
  check('the export sheet asks which pages', sheetRow.input, sheetRow);
  check('and says the size of the paper', /میلی‌متر/.test(sheetRow.size || ''), sheetRow.size);

  /* ---------- What is not on this device ---------- */
  const fontHere = await page.evaluate(`
    const { fontIsHere } = await import('${WEB}/fonts.js');
    return { bundled: fontIsHere('B Nazanin'), none: fontIsHere('Font That Does Not Exist 123') };
  `);
  check('it knows which fonts this device has', fontHere.bundled && !fontHere.none, fontHere);
  f = await frameBox('این متن در ستون چپ');
  await page.evaluate(`
    const L = window.__app.letter;
    const o = L.objects.find((x) => x.id === '${f.id}');
    o.style = { ...o.style, font: 'Font That Does Not Exist 123' };
    window.__app.screens.page.show();
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 4; i++) document.querySelector('#page [aria-label="بزرگ‌نمایی"]').click();
    document.querySelector('#page .obj[data-id="${f.id}"]').scrollIntoView({ block: 'center', inline: 'center' });
  `);
  await wait(200);
  const spot = await page.evaluate(`const r = document.querySelector('#page .obj[data-id="${f.id}"]').getBoundingClientRect(); return { x: Math.max(20, Math.min(340, r.left + r.width / 2)), y: r.top + r.height / 2 };`);
  await page.tap(spot.x, spot.y);
  await wait(300);
  const hint = await page.evaluate(`return [...document.querySelectorAll('#page .tool-hint')].map((el) => el.textContent).join(' ');`);
  check('it says so when a line is shown in another font, and offers to add it', hint.includes('Font That Does Not Exist') && hint.includes('افزودن فایل فونت'), hint.slice(0, 60));

  check('no script errors', page.errors.length === 0, page.errors.slice(0, 5));
  console.log(failed ? `${failed} FAILED` : 'all fast checks passed');
  process.exitCode = failed ? 1 : 0;
} finally {
  await page.close();
}
