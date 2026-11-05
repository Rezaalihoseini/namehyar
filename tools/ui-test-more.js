// The features around the letter: archive menu, similar letter, templates, own phrases, settings, backup, fonts.
//   node tools/ui-test-more.js <out-folder> [word-file.docx]      (needs the preview server on port 8770)
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openPhone } from './cdp.js';

const out = resolve(process.argv[2] || 'ui-test-out');
const wordFile = process.argv[3];
mkdirSync(out, { recursive: true });
const URL_APP = 'http://127.0.0.1:8770/app/src/main/assets/web/index.html';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? `: ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed++;
}

const page = await openPhone({ port: 9336 });
const shot = (name) => page.screenshot(join(out, `${name}.png`));
const clickText = (scope, text) => `[...document.querySelectorAll(${JSON.stringify(scope)})].find((b) => b.textContent.includes(${JSON.stringify(text)})).click();`;
const wait = (ms = 200) => `await new Promise((r) => setTimeout(r, ${ms}));`;

try {
  await page.goto(URL_APP);
  await page.sleep(1200);

  /* ---------- A letter to work with ---------- */
  await page.evaluate(`
    ${clickText('#home button', 'نامهٔ جدید')} ${wait(300)}
    ${clickText('#compose .chip', 'گزارش')} ${wait(200)}
    const subject = document.querySelector('#compose input[placeholder*="موضوع"]');
    subject.value = 'گزارش عملکرد ماهانه';
    subject.dispatchEvent(new Event('input'));
    subject.dispatchEvent(new Event('change'));
    ${wait(300)}
  `);

  /* ---------- Saving it as a template, with a blank typed by hand ---------- */
  await page.evaluate(`
    const editor = document.querySelector('.editor');
    editor.innerHTML = '<p>این نامه برای [نام شرکت] نوشته شده است.</p>';
    editor.dispatchEvent(new Event('input'));
    ${wait(250)}
    ${clickText('#compose .chip.add', 'ذخیره به‌عنوان قالب')} ${wait(150)}
    document.querySelector('.sheet input').value = 'قالب آزمایشی';
    ${clickText('.sheet .btn', 'ذخیره')} ${wait(300)}
  `);
  const saved = await page.evaluate(`const t = window.__app.templates[0]; return t && { title: t.title, html: t.bodyHtml };`);
  check('a letter can be saved as a template', saved?.title === 'قالب آزمایشی', saved);
  check('[text] typed by hand becomes a blank', /class="ph"/.test(saved?.html || ''), saved?.html);
  const chips = await page.evaluate(`return [...document.querySelectorAll('#compose .chips.wrap .chip')].map((c) => c.textContent);`);
  check('the template appears among the letter types', chips.includes('قالب آزمایشی'), chips.slice(0, 3));

  /* ---------- Own phrases ---------- */
  await page.evaluate(`
    document.querySelector('.editor').focus(); ${wait(200)}
    ${clickText('.fmtbar .btn', 'عبارت')} ${wait(150)}
    ${clickText('.panel .chip', 'عبارت‌های من')} ${wait(100)}
    ${clickText('.panel .btn', 'عبارت جدید')} ${wait(150)}
    document.querySelector('.sheet textarea').value = 'این عبارت را خودم نوشته‌ام.';
    ${clickText('.sheet .btn', 'ذخیره')} ${wait(150)}
  `);
  check('an own phrase is saved', (await page.evaluate(`return window.__app.settings.phrases?.[0];`)) === 'این عبارت را خودم نوشته‌ام.');
  await page.evaluate(`
    document.querySelector('.editor').focus(); ${wait(150)}
    if (document.querySelector('.panel').hidden) { ${clickText('.fmtbar .btn', 'عبارت')} ${wait(100)} }
    ${clickText('.panel .chip', 'عبارت‌های من')} ${wait(100)}
  `);
  await shot('20-my-phrases');
  await page.evaluate(`document.querySelector('.editor').blur(); ${wait(120)}`);

  /* ---------- More letter types, with the usual ones one tap away ---------- */
  await page.evaluate(`
    document.querySelector('.editor').blur(); ${wait(100)}
    ${clickText('#compose .chip.more', 'همهٔ قالب‌ها')} ${wait(150)}
  `);
  const sheetTemplates = await page.evaluate(`return document.querySelectorAll('.sheet .template-row').length;`);
  check('the template list holds many letter types', sheetTemplates >= 25, sheetTemplates);
  await shot('19-all-templates');
  await page.evaluate(`
    ${clickText('.sheet .template-row', 'صورت‌جلسه')} ${wait(200)}
    if (document.querySelector('.sheet')) { ${clickText('.sheet .btn', 'جایگزین کن')} ${wait(300)} }
  `);
  check('a template can bring a table with it', (await page.evaluate(`return document.querySelectorAll('.editor table td').length;`)) === 16);

  /* ---------- Swapping columns, rows and cells of a table ---------- */
  await page.evaluate(`
    ${clickText('#compose .chip.more', 'همهٔ قالب‌ها')} ${wait(150)}
    ${clickText('.sheet .template-row', 'نامه با جدول')} ${wait(200)}
    if (document.querySelector('.sheet')) { ${clickText('.sheet .btn', 'جایگزین کن')} ${wait(300)} }
    const cells = [...document.querySelectorAll('.editor td')];
    const fill = ['ردیف', 'نام', 'تاریخ', '۱۴۰۵/۰۱/۰۱', 'علی', '۱', '۱۴۰۵/۰۲/۰۲', 'رضا', '۲', '۱۴۰۵/۰۳/۰۳', 'سارا', '۳'];
    cells.forEach((td, i) => { td.textContent = fill[i]; });
    document.querySelector('.editor').dispatchEvent(new Event('input'));
    ${wait(300)}
    ${clickText('#compose .bottombar .btn', 'چیدمان')} ${wait(500)}
  `);
  const tableCell = await page.centre('#page [data-section="table:0"]');
  await page.tap(tableCell.x, tableCell.y);
  await page.tapOn('.tools [aria-label="جابه‌جایی ستون و سطر"]');
  await page.sleep(200);
  await shot('18-table-swap');
  const rowsOf = () => page.evaluate(`
    const t = window.__app.letter.body.find((b) => b.kind === 'table');
    return t.rows.map((row) => row.map((c) => c.paras.map((p) => p.runs.map((r) => r.text).join('')).join('')));
  `);
  const swapCell = (r, c) => page.evaluate(`document.querySelectorAll('.swap-grid tr')[${r}].children[${c}].click(); ${wait(80)}`);
  await swapCell(1, 0);
  check('tapping a column highlights it, without the title row', (await page.evaluate(`return document.querySelectorAll('.swap-grid td.picked').length;`)) === 3);
  await swapCell(1, 2);
  let rows = await rowsOf();
  check('two columns swap their data under fixed titles', rows[0][0] === 'ردیف' && rows[1][0] === '۱' && rows[1][2] === '۱۴۰۵/۰۱/۰۱', rows);
  await page.evaluate(`${clickText('.sheet .btn', 'برگرداندن')} ${wait(120)}`);
  rows = await rowsOf();
  check('the sheet undoes a swap', rows[1][0] === '۱۴۰۵/۰۱/۰۱', rows);
  await page.evaluate(`document.querySelector('.check-row input').click(); ${wait(80)}`);
  await swapCell(0, 0);
  await swapCell(0, 1);
  rows = await rowsOf();
  check('whole columns swap with their titles when asked', rows[0][0] === 'نام' && rows[0][1] === 'ردیف' && rows[1][0] === 'علی', rows);
  await page.evaluate(`[...document.querySelectorAll('.sheet .seg button')].find((b) => b.dataset.value === 'row').click(); ${wait(80)}`);
  await swapCell(1, 0);
  await swapCell(2, 0);
  rows = await rowsOf();
  check('two rows swap', rows[1][0] === 'رضا' && rows[2][0] === 'علی', rows);
  await page.evaluate(`[...document.querySelectorAll('.sheet .seg button')].find((b) => b.dataset.value === 'cell').click(); ${wait(80)}`);
  await swapCell(1, 0);
  await swapCell(3, 2);
  rows = await rowsOf();
  check('two single cells swap', rows[1][0] === '۳' && rows[3][2] === 'رضا', rows);
  check('the page shows the swapped table', (await page.evaluate(`return document.querySelector('#page [data-section="table:0"]').textContent;`)).includes('علی'));
  await page.evaluate(`window.__onBack(); ${wait(100)} window.__onBack(); ${wait(100)} window.__onBack(); ${wait(300)}`);
  check('the form shows it too', (await page.evaluate(`return document.querySelector('.editor td').textContent;`)) === 'نام');

  /* ---------- Ready-made arrangements ---------- */
  await page.evaluate(`${clickText('#compose .bottombar .btn', 'چیدمان')} ${wait(500)} ${clickText('.tools .btn', 'چیدمان آماده')} ${wait(250)}`);
  const cards = await page.evaluate(`return document.querySelectorAll('.layout-card').length;`);
  check('ready-made arrangements are offered', cards >= 5, cards);
  await shot('17-layouts');
  await page.evaluate(`${clickText('.layout-card', 'سربرگ وسط')} ${wait(300)}`);
  const centred = await page.evaluate(`return window.__app.letter.letterhead.parts;`);
  check('an arrangement moves the letterhead', centred.number?.x === 130 && centred.org?.x === 45, centred);
  await shot('16-layout-applied');
  await page.tapOn('#page [aria-label="برگرداندن آخرین تغییر"]');
  await page.evaluate(`window.__onBack(); ${wait(300)}`);

  /* ---------- Editing text on the page reaches the form ---------- */
  await page.evaluate(`${clickText('#compose .bottombar .btn', 'چیدمان')} ${wait(500)}`);
  const s = await page.centre('#page [data-section="subject"]');
  await page.tap(s.x, s.y);
  await page.tapOn('.tools [aria-label="ویرایش متن"]');
  await page.sleep(200);
  await shot('21-edit-text');
  await page.evaluate(`
    document.querySelector('.sheet input').value = 'موضوع تازه از صفحه';
    ${clickText('.sheet .btn', 'تأیید')} ${wait(200)}
  `);
  check('text edited on the page is on the page', (await page.evaluate(`return document.querySelector('#page [data-section="subject"]').textContent;`)).includes('موضوع تازه از صفحه'));
  await page.evaluate(`window.__onBack(); ${wait(100)} window.__onBack(); ${wait(300)}`);
  check('and in the form', (await page.evaluate(`return document.querySelector('#compose input[placeholder*="موضوع"]').value;`)) === 'موضوع تازه از صفحه');

  /* ---------- Keeping a layout for the next letters ---------- */
  await page.evaluate(`${clickText('#compose .bottombar .btn', 'چیدمان')} ${wait(500)}`);
  const inv = await page.centre('#page [data-part="invocation"]');
  await page.drag(inv.x, inv.y, inv.x - 40, inv.y + 10);
  const moved = await page.evaluate(`return window.__app.letter.letterhead.parts.invocation;`);
  await page.evaluate(`window.__onBack(); ${wait(100)} ${clickText('.tools .btn', 'پیش‌فرض')} ${wait(200)}`);
  await page.evaluate(`window.__onBack(); ${wait(100)} window.__onBack(); ${wait(300)}`);
  await page.evaluate(`${clickText('#home button', 'نامهٔ جدید')} ${wait(400)}`);
  const inherited = await page.evaluate(`return window.__app.letter.letterhead.parts?.invocation;`);
  check('a new letter starts with the saved layout', inherited?.x === moved?.x && inherited?.y === moved?.y, { moved, inherited });
  await page.evaluate(`window.__onBack(); ${wait(300)}`);

  /* ---------- The archive: filter, menu, similar letter, delete ---------- */
  await shot('22-archive');
  const before = await page.evaluate(`return window.__app.letters.length;`);
  await page.tapOn('#home .letter-line [aria-label="گزینه‌های نامه"]');
  await page.sleep(200);
  await shot('23-letter-menu');
  await page.evaluate(`${clickText('.sheet-action', 'نامهٔ مشابه')} ${wait(400)}`);
  const copy = await page.evaluate(`const l = window.__app.letter; return { status: l.status, number: l.number, subject: l.subject };`);
  check('a similar letter starts as a fresh draft', copy.status === 'draft' && copy.number === '', copy);
  await page.evaluate(`window.__onBack(); ${wait(400)}`);
  const count = await page.evaluate(`return window.__app.letters.length;`);
  check('it joined the archive', count === before + 1, { before, count });
  await page.evaluate(`
    document.querySelector('#home .letter-line [aria-label="گزینه‌های نامه"]').click(); ${wait(150)}
    ${clickText('.sheet-action', 'حذف')} ${wait(150)}
    ${clickText('.sheet .btn', 'حذف شود')} ${wait(250)}
  `);
  check('a letter can be deleted', (await page.evaluate(`return window.__app.letters.length;`)) === count - 1);

  /* ---------- Settings, in the dark theme ---------- */
  await page.evaluate(`
    document.querySelector('#home [aria-label="تنظیمات"]').click(); ${wait(300)}
    [...document.querySelectorAll('#settings .seg button')].find((b) => b.dataset.value === 'dark').click(); ${wait(150)}
  `);
  check('settings can choose the dark theme', (await page.evaluate(`return document.documentElement.dataset.theme;`)) === 'dark');
  await shot('24-settings-dark');
  await page.evaluate(`document.querySelector('#settings .scroll').scrollTop = 1200; ${wait(150)}`);
  await shot('25-settings-dark-lower');

  /* ---------- Backup comes back whole ---------- */
  const backup = await page.evaluate(`
    const { deliverFile } = await import('/app/src/main/assets/web/js/export.js');
    const { makeBackup, importAppFile } = await import('/app/src/main/assets/web/js/files.js');
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured = blob; return realCreate.call(URL, blob); };
    await makeBackup('save');
    URL.createObjectURL = realCreate;
    const text = await captured.text();
    const data = JSON.parse(text);
    const letters = window.__app.letters.length;
    window.__app.letters = [];
    const message = await importAppFile(new File([text], 'b.json'));
    return { kind: data.kind, inFile: data.letters.length, before: letters, after: window.__app.letters.length, message };
  `);
  check('a backup restores every letter', backup.kind === 'namehyar-backup' && backup.after === backup.before, backup);

  /* ---------- A font file ---------- */
  const font = await page.evaluate(`
    const { installFont, readFontInfo } = await import('/app/src/main/assets/web/js/fonts.js');
    const { allFonts } = await import('/app/src/main/assets/web/js/model.js');
    const res = await fetch('/app/src/main/assets/web/fonts/BZar.ttf');
    const blob = await res.blob();
    const info = readFontInfo(new Uint8Array(await blob.arrayBuffer()));
    const family = await installFont(new File([blob], 'x.ttf'), window.__app.settings);
    return { info, family, listed: allFonts() };
  `);
  check('a font file is read and added', font.family === 'B Zar' && Math.abs(font.info.ratio - 1.666) < 0.01, font);

  /* ---------- Opening a Word file ---------- */
  if (wordFile) {
    const b64 = readFileSync(wordFile).toString('base64');
    await page.evaluate(`
      const { openLetterFile } = await import('/app/src/main/assets/web/js/screens/home.js');
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      await openLetterFile(bytes, 'word.docx');
      ${wait(800)}
    `);
    await shot('26-word-on-page');
    await page.evaluate(`window.__onBack(); ${wait(500)}`);
    await shot('27-word-in-form');
    const editorText = await page.evaluate(`return document.querySelector('.editor').innerText;`);
    check('the Word text is in the editor', editorText.includes('مرکز رشد واحدهای فناور'), editorText.slice(0, 80));
    const again = await page.evaluate(`
      const editor = document.querySelector('.editor');
      editor.focus();
      const p = editor.querySelector('p');
      p.append(' جمله‌ای تازه');
      editor.dispatchEvent(new Event('input'));
      ${wait(350)}
      editor.blur();
      const body = window.__app.letter.body;
      return { firstHasNew: body[0].runs.map((r) => r.text).join('').includes('جمله‌ای تازه'), indent: body[0].indent, kinds: body.map((b) => b.kind).join(','), tableWidths: body.find((b) => b.kind === 'table')?.widths };
    `);
    check('the Word text can be edited', again.firstHasNew, again);
    check('editing keeps the first-line indent and the table', !!again.indent?.first && again.kinds.includes('table'), again);
  }

  check('no script errors', page.errors.length === 0, page.errors);
} catch (err) {
  console.error(err);
  failed++;
  await shot('zz-failure').catch(() => null);
} finally {
  await page.close();
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
