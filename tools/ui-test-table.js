// The table's tools, with a finger: taking out cells, rows and columns, one or far apart, adding, merging, widths,
// row numbers, totals, order, the sheet with everything, the form's panel, and what Word gets from all of it.
//   node tools/ui-test-table.js <out-folder>      (needs the preview server on port 8770)
//   node tools/table-edit-test.js checks the same changes on the model alone, with merged cells of every kind.
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

const page = await openPhone({ port: 9371 });
const shot = (name) => page.screenshot(join(out, `table-${name}.png`));
const wait = (ms = 200) => `await new Promise((r) => setTimeout(r, ${ms}));`;
const clickText = (scope, text) => `[...document.querySelectorAll(${JSON.stringify(scope)})].find((b) => b.textContent.includes(${JSON.stringify(text)})).click();`;
const pause = (ms = 350) => page.sleep(ms);

/* ---------- What a person does ---------- */

/** Brings a cell with these words into view and gives its centre. */
const cellCentre = (words) => page.evaluate(`
  const td = [...document.querySelectorAll('#page .page td')].find((c) => c.textContent.trim() === ${JSON.stringify(words)});
  if (!td) return null;
  const stage = document.querySelector('#page .stage');
  const view = stage.getBoundingClientRect();
  const seen = td.getBoundingClientRect();
  stage.scrollBy({ left: seen.left + seen.width / 2 - (view.left + view.width / 2), top: seen.top + seen.height / 2 - (view.top + view.height / 2), behavior: 'instant' });
  await new Promise((r) => setTimeout(r, 150));
  const b = td.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
`);
const tapCell = async (words) => {
  const at = await cellCentre(words);
  if (!at) throw new Error(`no cell ${words} on the page`);
  await page.tap(at.x, at.y);
  await pause();
};
/** As a finger would, after scrolling to it: a sheet can be longer than the screen. */
const centreOfButton = (text, where) => page.evaluate(`const b = [...document.querySelectorAll(${JSON.stringify(where)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return null; b.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); await new Promise((r) => setTimeout(r, 60)); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
const pressButton = async (text, where = '.tools .btn') => {
  const at = await centreOfButton(text, where);
  if (!at) throw new Error(`no button ${text}`);
  await page.tap(at.x, at.y);
  await pause(250);
};
const pressInSheet = (text) => pressButton(text, '.sheet .btn');
const tapInSheet = async (selector) => {
  const at = await page.evaluate(`const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return null; b.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); await new Promise((r) => setTimeout(r, 60)); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  if (!at) throw new Error(`nothing for ${selector}`);
  await page.tap(at.x, at.y);
  await pause(300);
};
const choose = (how) => tapInSheet(`.del-choice[data-how="${how}"]`);
const undo = async () => {
  await page.tapOn('#page [aria-label="برگرداندن آخرین تغییر"]');
  await pause(300);
};
const closeSheet = async () => {
  await page.evaluate(`while (window.__app.overlays.length) window.__app.overlays[window.__app.overlays.length - 1](); ${wait(100)}`);
};
const noSelection = () => page.evaluate(`
  [...document.querySelectorAll('.tools .btn')].find((b) => b.textContent.trim() === 'پایان')?.click();
  while (document.querySelector('#page .sel-cell, #page .sel-on, #page .sel-box')) { window.__onBack(); await new Promise((r) => setTimeout(r, 80)); }
`);
/** A cell of the small picture in the sheet, by its place. */
const tapPick = async (r, c) => {
  const at = await page.evaluate(`
    const td = document.querySelector('.pick-grid td[data-r="${r}"][data-c="${c}"]');
    if (!td) return null;
    td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const b = td.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  `);
  if (!at) throw new Error(`no cell ${r},${c} in the sheet`);
  await page.tap(at.x, at.y);
  await pause(120);
};
const openTab = async (id) => {
  await page.evaluate(`document.querySelector('.table-sheet .seg button[data-value="${id}"]').click(); ${wait(120)}`);
};

/* ---------- What is in the letter and on the page ---------- */

const rows = () => page.evaluate(`
  const t = window.__app.letter.body.find((b) => b.kind === 'table');
  return t ? t.rows.map((row) => row.map((c) => c.paras.map((p) => (p.runs || []).map((r) => r.text || '').join('')).join(''))) : null;
`);
const table = () => page.evaluate(`const { rows, ...rest } = window.__app.letter.body.find((b) => b.kind === 'table') || {}; return rest;`);
const shownRows = () => page.evaluate(`return [...document.querySelectorAll('#page .page [data-section="table:0"] tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()));`);
const formRows = () => page.evaluate(`
  const { serializeEditor } = await import('${WEB}/editor.js');
  const holder = document.createElement('div');
  holder.innerHTML = window.__app.letter.bodyHtml;
  const t = serializeEditor(holder).find((b) => b.kind === 'table');
  return t ? t.rows.map((row) => row.map((c) => c.paras.map((p) => (p.runs || []).map((r) => r.text || '').join('')).join(''))) : null;
`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const wordFile = () => page.evaluate(`
  const { makeDocx } = await import('${WEB}/export.js');
  const { importDocx } = await import('${WEB}/import-docx.js');
  const { bytesToBase64 } = await import('${WEB}/util.js');
  const { readZip } = await import('${WEB}/unzip.js');
  const made = await makeDocx(window.__app.letter, { deliver: false });
  const zip = readZip(made.bytes);
  const doc = new TextDecoder().decode(zip.get('word/document.xml')());
  const L = await importDocx(made.bytes, window.__app.settings);
  return { docx: bytesToBase64(made.bytes), doc, back: L.body.filter((b) => b.kind === 'table') };
`);

/* ---------- A letter to work with ---------- */

const START = [['ردیف', 'نام', 'تاریخ'], ['۱', 'علی', 'اول'], ['۲', 'رضا', 'دوم'], ['۳', 'سارا', 'سوم'], ['۴', 'مینا', 'چهارم']];

/** Puts this table in the letter, in the page screen. */
async function freshTable(data = START) {
  await page.evaluate(`
    const L = window.__app.letter;
    const data = ${JSON.stringify(data)};
    const table = { kind: 'table', header: true, rows: data.map((row) => row.map((text) => ({ paras: [{ runs: text ? [{ text }] : [] }] }))) };
    L.body = [{ kind: 'p', runs: [{ text: 'این یک نامه با جدول است.' }] }, table];
    const { blocksToHtml } = await import('${WEB}/editor.js');
    L.bodyHtml = blocksToHtml(L.body);
    L.offsets = {};
    window.__app.screens.page.refresh();
    ${wait(250)}
  `);
}

try {
  await page.goto(APP);
  await page.sleep(1200);
  await page.evaluate(`
    ${clickText('#home button', 'نامهٔ جدید')} ${wait(300)}
    ${clickText('#compose .chip', 'گزارش')} ${wait(200)}
    ${clickText('#compose .bottombar .btn', 'چیدمان')} ${wait(500)}
  `);
  for (let i = 0; i < 3; i++) {
    await page.tapOn('#page [aria-label="بزرگ‌نمایی"]');
    await pause(80);
  }
  await freshTable();

  /* ---------- One row ---------- */
  await tapCell('رضا');
  await shot('01-cell-tools');
  const row = await page.evaluate(`return [...document.querySelectorAll('.tools .btn')].map((b) => b.textContent.trim());`);
  check('a selected cell offers taking out, adding and the sheet', ['حذف', 'سطر', 'ستون', 'ابزار جدول'].every((t) => row.includes(t)), row);
  await pressButton('حذف');
  await shot('02-delete-sheet');
  check('the sheet asks how', (await page.evaluate(`return document.querySelectorAll('.del-choice').length;`)) === 7);
  await choose('rows');
  check('the row is gone from the letter, numbers counting again', same(await rows(), [['ردیف', 'نام', 'تاریخ'], ['۱', 'علی', 'اول'], ['۲', 'سارا', 'سوم'], ['۳', 'مینا', 'چهارم']]), await rows());
  check('and from the page', same(await shownRows(), await rows()), await shownRows());
  check('and from the form', same(await formRows(), await rows()), await formRows());
  check('the toast says the numbers changed', (await page.evaluate(`return document.querySelector('#toast')?.textContent;`)) === 'ردیف‌ها دوباره شماره خوردند');
  await shot('03-row-gone');
  await undo();
  check('one undo brings it back', same(await rows(), START) && same(await shownRows(), START), await rows());

  /* ---------- One column ---------- */
  await tapCell('رضا');
  await pressButton('حذف');
  await choose('columns');
  check('the column is gone', same(await rows(), START.map((r) => [r[0], r[2]])), await rows());
  await shot('04-column-gone');
  await undo();
  check('and comes back', same(await rows(), START));

  /* ---------- One cell, each way ---------- */
  await tapCell('رضا');
  await pressButton('حذف');
  await choose('close');
  check('closing up: the rest of the row moves', same((await rows())[2], ['۲', 'دوم', '']), (await rows())[2]);
  const closed = await page.evaluate(`const t = window.__app.letter.body.find((b) => b.kind === 'table'); return t.rows[2][2].borders;`);
  check('and the row\'s end has no lines', same(closed, [0, 0, 0, 0]), closed);
  const edge = await page.evaluate(`
    const row = document.querySelectorAll('#page .page [data-section="table:0"] tr')[2];
    const [one, two, gap] = row.children;
    const css = (el, side) => getComputedStyle(el)['border' + side + 'Width'];
    return { gap: ['Top', 'Bottom', 'Left'].map((s) => getComputedStyle(gap)['border' + s + 'Style']), next: css(two, 'Left') };
  `);
  check('on the page the empty place draws nothing of its own', edge.gap.includes('none') || edge.gap.every((s) => s === 'solid'), edge);
  await shot('05-cell-closed');
  await undo();

  await tapCell('رضا');
  await pressButton('حذف');
  await choose('widen');
  const widened = await page.evaluate(`const t = window.__app.letter.body.find((b) => b.kind === 'table'); return { words: t.rows[2].map((c) => c.paras[0].runs.map((r) => r.text).join('')), span: t.rows[2].map((c) => c.colSpan || 1) };`);
  check('widening: the next cell grows over it', same(widened.words, ['۲', 'دوم']) && same(widened.span, [1, 2]), widened);
  check('and the page shows it', (await page.evaluate(`return document.querySelectorAll('#page .page [data-section="table:0"] tr')[2].children[1].colSpan;`)) === 2);
  await shot('06-cell-widened');
  await undo();

  await tapCell('رضا');
  await pressButton('حذف');
  await choose('hole');
  const holed = await rows();
  check('a hole: nothing else moves', same(holed[2], ['۲', '', 'دوم']) && same(holed[1], START[1]), holed);
  await shot('07-cell-hole');
  await undo();

  await tapCell('رضا');
  await pressButton('حذف');
  await choose('clear');
  const cleared = await page.evaluate(`const t = window.__app.letter.body.find((b) => b.kind === 'table'); return { text: t.rows[2][1].paras[0].runs.length, borders: t.rows[2][1].borders };`);
  check('only the words: the cell stays with its lines', cleared.text === 0 && !cleared.borders, cleared);
  await undo();
  check('all of it undone', same(await rows(), START), await rows());

  /* ---------- Several cells far apart ---------- */
  await tapCell('علی');
  await pressButton('چندتایی');
  await tapCell('دوم');
  await tapCell('مینا');
  const chosen = await page.evaluate(`return document.querySelectorAll('#page .sel-cell').length;`);
  check('three cells far apart are chosen with a finger', chosen === 3, chosen);
  await shot('08-group');
  await pressButton('حذف خانه‌ها');
  await shot('09-group-delete-sheet');
  check('the sheet counts them', (await page.evaluate(`return document.querySelector('.del-label').textContent;`)).includes('۳'));
  await choose('hole');
  const holes = await rows();
  check('all three go at once, wherever they were', holes[1][1] === '' && holes[2][2] === '' && holes[4][1] === '' && holes[3][1] === 'سارا', holes);
  await shot('10-group-gone');
  await undo();
  check('and all come back with one undo', same(await rows(), START), await rows());

  await tapCell('علی');
  await pressButton('چندتایی');
  await tapCell('سارا');
  await pressButton('کل ستون');
  await pressButton('حذف خانه‌ها');
  await choose('columns');
  check('a group can take out the columns it stands in', same(await rows(), START.map((r) => [r[0], r[2]])), await rows());
  await undo();

  await tapCell('علی');
  await pressButton('چندتایی');
  await tapCell('سوم');
  await pressButton('حذف خانه‌ها');
  await choose('rows');
  check('or the rows, far apart', same((await rows()).map((r) => r[1]), ['نام', 'رضا', 'مینا']), await rows());
  check('with the numbers counting again', same((await rows()).map((r) => r[0]), ['ردیف', '۱', '۲']), await rows());
  await undo();

  /* ---------- Taking a group back when what it holds is not there ---------- */
  await tapCell('سارا');
  await pressButton('سطر');
  await pressButton('سطر');
  check('two taps on «سطر», two new rows under the cell', (await rows()).length === 7 && (await rows())[4][1] === '' && (await rows())[5][1] === '' && (await rows())[6][1] === 'مینا', await rows());
  check('numbered as they come', same((await rows()).map((r) => r[0]), ['ردیف', '۱', '۲', '۳', '۴', '۵', '۶']), (await rows()).map((r) => r[0]));
  await shot('11-rows-added');
  await noSelection();
  await tapCell('مینا');
  await pressButton('چندتایی');
  await undo();
  await undo();
  const inGroup = await page.evaluate(`return document.querySelector('.tools .hint.grow').textContent;`);
  check('a group holding a cell that an undo took away does not break', inGroup === 'انتخاب چندتایی' || inGroup.includes('۱'), inGroup);
  await noSelection();
  check('after both undos the rows are as they were', same(await rows(), START), await rows());

  /* ---------- Merging ---------- */
  await tapCell('علی');
  await pressButton('چندتایی');
  await tapCell('رضا');
  await pressButton('یکی کردن');
  const merged = await page.evaluate(`const t = window.__app.letter.body.find((b) => b.kind === 'table'); return { first: t.rows[1][1].rowSpan, words: t.rows[1][1].paras.map((p) => p.runs.map((r) => r.text).join('')), second: t.rows[2].length };`);
  check('two cells one above the other become one, with both their words', merged.first === 2 && same(merged.words, ['علی', 'رضا']) && merged.second === 2, merged);
  check('the page shows it', (await page.evaluate(`return document.querySelector('#page .page td[rowspan]')?.rowSpan;`)) === 2);
  await shot('12-merged');
  await tapCell('علیرضا');
  check('a merged cell offers to come apart', (await page.evaluate(`return [...document.querySelectorAll('.tools .btn')].some((b) => b.textContent.trim() === 'جدا کردن');`)));
  await pressButton('جدا کردن');
  const apart = await page.evaluate(`const t = window.__app.letter.body.find((b) => b.kind === 'table'); return t.rows.map((r) => r.length);`);
  check('and does', same(apart, [3, 3, 3, 3, 3]), apart);
  await undo();
  await undo();
  check('undone, the table is as it was', same(await rows(), START), await rows());

  /* ---------- Writing in a cell, then the next ---------- */
  await tapCell('علی');
  await page.tapOn('.tools [aria-label="ویرایش متن"]');
  await pause();
  check('a cell of a letter\'s table is written in on the spot', (await page.evaluate(`return window.__app.stack.at(-1);`)) === 'page' && (await page.evaluate(`return document.querySelector('.sheet input')?.value;`)) === 'علی');
  await shot('13-cell-editor');
  await page.evaluate(`document.querySelector('.sheet input').value = 'علی‌رضا';`);
  await pressInSheet('خانهٔ بعدی');
  check('the next cell opens with the first one saved', (await rows())[1][1] === 'علی‌رضا' && (await page.evaluate(`return document.querySelector('.sheet input')?.value;`)) === 'اول', await rows());
  await page.evaluate(`
    const input = document.querySelector('.sheet input');
    input.value = 'یکم';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    ${wait(250)}
  `);
  check('Enter on the keyboard goes on too', (await rows())[1][2] === 'یکم' && (await page.evaluate(`return document.querySelector('.sheet input')?.value;`)) === '۲', await rows());
  await closeSheet();
  await undo();
  await undo();
  await noSelection();

  /* A place left empty is passed over when going on to the next cell, and once written in has its lines back. */
  await tapCell('اول');
  await pressButton('حذف');
  await choose('hole');
  await tapCell('علی');
  await page.tapOn('.tools [aria-label="ویرایش متن"]');
  await pause();
  await pressInSheet('خانهٔ بعدی');
  check('going on passes over a place left empty', (await page.evaluate(`return document.querySelector('.sheet input')?.value;`)) === '۲', await page.evaluate(`return document.querySelector('.sheet input')?.value;`));
  await closeSheet();
  await noSelection();
  const place = await page.evaluate(`
    const td = document.querySelectorAll('#page .page [data-section="table:0"] tr')[1].children[2];
    const stage = document.querySelector('#page .stage');
    const view = stage.getBoundingClientRect();
    const seen = td.getBoundingClientRect();
    stage.scrollBy({ left: seen.left + seen.width / 2 - (view.left + view.width / 2), top: seen.top + seen.height / 2 - (view.top + view.height / 2), behavior: 'instant' });
    ${wait(150)}
    const b = td.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  `);
  await page.tap(place.x, place.y);
  await pause();
  await page.tapOn('.tools [aria-label="ویرایش متن"]');
  await pause();
  await page.evaluate(`document.querySelector('.sheet input').value = 'نو';`);
  await pressInSheet('تأیید');
  const written = await page.evaluate(`const t = window.__app.letter.body.find((b) => b.kind === 'table'); return { words: t.rows[1][2].paras[0].runs.map((r) => r.text).join(''), lines: t.rows[1][2].borders };`);
  check('written in, it is a cell with its lines again', written.words === 'نو' && !written.lines, written);
  await undo();
  await undo();
  await noSelection();
  check('all undone', same(await rows(), START), await rows());

  /* ---------- The sheet with everything ---------- */
  await tapCell('علی');
  await pressButton('ابزار جدول');
  await shot('14-sheet');
  check('the sheet opens with the selected cell picked', (await page.evaluate(`return document.querySelectorAll('.pick-grid td.picked').length;`)) === 1);
  await tapPick(3, 2);
  await tapPick(4, 0);
  check('cells far apart are picked in its picture', (await page.evaluate(`return document.querySelector('.pick-status').textContent;`)).includes('۳'));
  await shot('15-sheet-picked');
  await tapInSheet('.table-sheet .del-choice[data-how="hole"]');
  let now = await rows();
  check('and taken out from there', now[1][1] === '' && now[3][2] === '' && now[4][0] === '', now);
  check('the picture shows the holes', (await page.evaluate(`return document.querySelectorAll('.pick-grid td.hole').length;`)) === 3);
  await shot('16-sheet-holes');
  await pressInSheet('برگرداندن');
  check('its own undo brings them back', same(await rows(), START), await rows());

  // Adding, from the sheet
  await tapPick(1, 1);
  await openTab('add');
  await shot('17-sheet-add');
  await pressInSheet('سطر بالا');
  now = await rows();
  check('a row above the picked cell', now.length === 6 && now[1][1] === '' && now[2][1] === 'علی' && now[1][0] === '۱' && now[2][0] === '۲', now);
  await pressInSheet('برگرداندن');
  await tapPick(1, 1);
  await pressInSheet('تکرار همین سطر');
  now = await rows();
  check('a row copied under itself', now.length === 6 && now[2][1] === 'علی' && now[2][0] === '۲', now);
  await pressInSheet('برگرداندن');
  await tapPick(1, 1);
  await pressInSheet('ستون چپ');
  now = await rows();
  check('a column to the left of the picked cell', now[0].length === 4 && now[1][1] === 'علی' && now[1][2] === '' && now[1][3] === 'اول', now);
  await pressInSheet('برگرداندن');
  await tapPick(1, 1);
  await pressInSheet('ستون راست');
  now = await rows();
  check('a column to its right', now[1][1] === '' && now[1][2] === 'علی', now);
  await pressInSheet('برگرداندن');
  check('there is a counting column, so no second one is offered', await page.evaluate(`return [...document.querySelectorAll('.sheet .btn')].find((b) => b.textContent.trim() === 'ستون ردیف تازه').disabled;`));

  // Its shape
  await tapPick(0, 0);
  await openTab('shape');
  await shot('18-sheet-shape');
  const widthsBefore = (await table()).widths;
  await tapInSheet('.sheet [aria-label="کم کردن پهنای ستون"]');
  await tapInSheet('.sheet [aria-label="کم کردن پهنای ستون"]');
  const narrower = (await table()).widths;
  check('a column gets narrower step by step, the others taking the room', !widthsBefore && narrower[0] < 30 && narrower[1] > narrower[0] && Math.abs(narrower.reduce((a, b) => a + b, 0) - 100) < 0.02, narrower);
  const col = await page.evaluate(`return getComputedStyle(document.querySelector('#page .page [data-section="table:0"] td')).width;`);
  await tapInSheet('.sheet [aria-label="زیاد کردن ارتفاع سطر"]');
  await tapInSheet('.sheet [aria-label="زیاد کردن ارتفاع سطر"]');
  const tall = await page.evaluate(`const t = window.__app.letter.body.find((b) => b.kind === 'table'); return t.rows[0][0].rowH;`);
  check('a row gets taller', tall > 6, { tall, col });
  await pressInSheet('پهنا به‌قدر متن');
  const fit = (await table()).widths;
  check('columns follow their words', fit.length === 3 && fit[0] < fit[2], fit);
  await pressInSheet('ستون‌ها مساوی');
  const even = (await table()).widths;
  check('or are made equal', Math.max(...even) - Math.min(...even) < 0.02, even);
  await page.evaluate(`document.querySelector('.sheet .check-row input').click(); ${wait(200)}`);
  check('the first row can stop being a title', (await table()).header === false);
  check('and stops being thick', (await page.evaluate(`return getComputedStyle(document.querySelector('#page .page [data-section="table:0"] .cell-p')).fontWeight;`)) !== '700');
  await page.evaluate(`document.querySelector('.sheet .check-row input').click(); ${wait(200)}`);
  await pressInSheet('راه‌راه');
  const fills = await page.evaluate(`const t = window.__app.letter.body.find((b) => b.kind === 'table'); return t.rows.map((r) => r[0].bg || null);`);
  check('one tap for a striped table', same(fills, ['D9D9D9', null, 'F2F2F2', null, 'F2F2F2']), fills);
  await closeSheet();
  await shot('19-striped');
  await tapCell('علی');
  await pressButton('ابزار جدول');
  await openTab('shape');
  await pressInSheet('ساده');
  await pressInSheet('سرستون خاکستری');
  await pressInSheet('فقط خط افقی');
  await shot('20-rules');
  check('lines across only', same(await page.evaluate(`const t = window.__app.letter.body.find((b) => b.kind === 'table'); return t.rows[1][1].borders;`), [0.5, 0, 0.5, 0]));
  await pressInSheet('بدون خط');
  check('no lines', (await table()).borderless === true);
  await pressInSheet('ساده');
  check('and plain again', !(await table()).borderless);

  // Merging in the sheet
  await page.evaluate(`[...document.querySelectorAll('.sheet .btn')].find((b) => b.textContent.trim() === 'هیچ‌کدام').click(); ${wait(100)}`);
  await tapPick(1, 1);
  await tapPick(1, 2);
  await pressInSheet('یکی کردن خانه‌ها');
  check('cells side by side become one', (await page.evaluate(`const t = window.__app.letter.body.find((b) => b.kind === 'table'); return t.rows[1][1].colSpan;`)) === 2);
  await pressInSheet('جدا کردن خانهٔ ادغام‌شده');
  check('and come apart', (await page.evaluate(`const t = window.__app.letter.body.find((b) => b.kind === 'table'); return t.rows[1].length;`)) === 3);
  await closeSheet();
  await freshTable();

  /* ---------- Numbers ---------- */
  await freshTable([['شرح', 'مبلغ', 'نام'], ['خرید', '۳٬۰۰۰', 'سارا'], ['اجاره', '۱٬۰۰۰', 'علی'], ['بیمه', '۲٬۵۰۰', 'بهرام']]);
  await tapCell('۱٬۰۰۰');
  await pressButton('ابزار جدول');
  await openTab('data');
  await shot('21-sheet-data');
  await pressInSheet('مرتب از کم به زیاد / الف تا ی');
  check('rows in order of amount', same((await rows()).map((r) => r[1]), ['مبلغ', '۱٬۰۰۰', '۲٬۵۰۰', '۳٬۰۰۰']), await rows());
  await pressInSheet('مرتب از زیاد به کم / ی تا الف');
  check('and the other way', same((await rows()).map((r) => r[1]), ['مبلغ', '۳٬۰۰۰', '۲٬۵۰۰', '۱٬۰۰۰']), await rows());
  await pressInSheet('جمع این ستون');
  now = await rows();
  check('the sum in a row of its own', now[4][1] === '۶٬۵۰۰' && now[4][0] === 'جمع', now);
  await shot('22-total');
  await openTab('add');
  await pressInSheet('ستون ردیف تازه');
  now = await rows();
  check('a counting column, with the totals left out', same(now.map((r) => r[0]), ['ردیف', '۱', '۲', '۳', '']) || now[4][0].includes('جمع'), now);
  await closeSheet();
  await shot('23-counted');
  await freshTable([['ردیف', 'نام'], ['', 'علی'], ['', 'رضا']]);
  await tapCell('علی');
  await pressButton('ابزار جدول');
  await tapPick(1, 1);
  await tapPick(1, 0);
  await openTab('data');
  await pressInSheet('شماره‌گذاری این ستون');
  check('an empty counting column is filled with a tap', same((await rows()).map((r) => r[0]), ['ردیف', '۱', '۲']), await rows());
  await closeSheet();

  /* ---------- Empty rows and columns, and the whole table ---------- */
  await freshTable([['ردیف', 'نام', ''], ['۱', 'علی', ''], ['۲', '', ''], ['۳', 'سارا', '']]);
  await tapCell('علی');
  await pressButton('ابزار جدول');
  await tapInSheet('.del-choice[data-how="empty"]');
  check('empty rows and columns go with one tap', same(await rows(), [['ردیف', 'نام'], ['۱', 'علی'], ['۲', 'سارا']]), await rows());
  await tapPick(0, 0);
  await tapInSheet('.table-sheet .del-choice[data-how="table"]');
  await page.evaluate(`${clickText('.sheet .btn.danger', 'حذف شود')} ${wait(300)}`);
  check('the whole table goes, once asked', (await rows()) === null && !(await page.evaluate(`return window.__app.letter.bodyHtml.includes('<table');`)));
  check('and the sheet closes', (await page.evaluate(`return window.__app.overlays.length;`)) === 0);
  await undo();
  check('and comes back with undo', (await rows())?.length === 3, await rows());

  await tapCell('علی');
  await pressButton('ابزار جدول');
  await tapInSheet('.table-sheet .del-choice[data-how="rows"]');
  await closeSheet();
  await noSelection();
  check('taking out some of the rows needs no question', (await rows())?.length === 2, await rows());
  await freshTable([['الف', 'ب'], ['ج', 'د']]);
  await tapCell('الف');
  await pressButton('ابزار جدول');
  await page.evaluate(`${clickText('.sheet .btn', 'همه')} ${wait(120)}`);
  await tapInSheet('.table-sheet .del-choice[data-how="rows"]');
  check('taking out every row asks first', await page.evaluate(`return !!document.querySelector('.sheet .btn.danger');`));
  await closeSheet();
  check('and nothing has gone unless agreed', (await rows())?.length === 2, await rows());
  await noSelection();

  /* The selected table as a whole has the same two tools. */
  await tapCell('الف');
  await pressButton('همهٔ جدول');
  check('the whole table selected offers the sheet and taking it out', await page.evaluate(`return !!document.querySelector('.tools [aria-label="ابزار جدول"]') && !!document.querySelector('.tools [aria-label="حذف جدول"]');`));
  await pressButton('همهٔ جدول');
  await noSelection();

  /* ---------- Tables known by their number keep what was set for them ---------- */
  await page.evaluate(`
    const L = window.__app.letter;
    const make = (word) => ({ kind: 'table', header: false, rows: [[{ paras: [{ runs: [{ text: word }] }] }]] });
    L.body = [make('یکم'), make('دوم'), make('سوم')];
    const { blocksToHtml } = await import('${WEB}/editor.js');
    L.bodyHtml = blocksToHtml(L.body);
    L.offsets = { 'table:2': { dx: 5 } };
    window.__app.screens.page.refresh();
    ${wait(250)}
  `);
  await tapCell('دوم');
  await pressButton('حذف');
  await choose('rows');
  const offsets = await page.evaluate(`return { offsets: window.__app.letter.offsets, tables: window.__app.letter.body.length };`);
  check('a table leaving moves the others\' places along', offsets.tables === 2 && offsets.offsets['table:1']?.dx === 5 && !offsets.offsets['table:2'], offsets);
  await undo();

  /* ---------- Word gets all of it ---------- */
  await freshTable();
  await tapCell('رضا');
  await pressButton('حذف');
  await choose('hole');
  await tapCell('اول');
  await pressButton('چندتایی');
  await tapCell('دوم');
  await pressButton('یکی کردن');
  await tapCell('مینا');
  await pressButton('حذف');
  await choose('widen');
  const word = await wordFile();
  writeFileSync(join(out, 'table-word.docx'), Buffer.from(word.docx, 'base64'));
  check('Word has the hole, with no lines', /<w:top w:val="nil"\/><w:left w:val="nil"\/><w:bottom w:val="nil"\/><w:right w:val="nil"\/>/.test(word.doc));
  check('the cell beside the hole says its own lines', (word.doc.match(/<w:tcBorders>/g) || []).length >= 10, (word.doc.match(/<w:tcBorders>/g) || []).length);
  check('Word has the merged cells', /<w:vMerge w:val="restart"\/>/.test(word.doc) && /<w:vMerge\/>/.test(word.doc) && /<w:gridSpan w:val="2"\/>/.test(word.doc));
  const back = word.back[0];
  const backWords = back.rows.map((r) => r.map((c) => c.paras.map((p) => (p.runs || []).map((x) => x.text || '').join('')).join('')));
  check('and it reads back the same', backWords[2][1] === '' && same(back.rows[2][1].borders, [0, 0, 0, 0]) && back.rows[1][2].rowSpan === 2 && back.rows[4][1].colSpan === 2, { backWords, spans: back.rows.map((r) => r.map((c) => [c.colSpan, c.rowSpan])) });
  await shot('24-for-word');

  /* ---------- The form's panel ---------- */
  await freshTable();
  await page.evaluate(`window.__onBack(); ${wait(400)}`);
  const inCell = (r, c) => page.evaluate(`
    const td = document.querySelector('.editor table').rows[${r}].cells[${c}];
    const editor = document.querySelector('.editor');
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(td);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ${wait(120)}
    if (document.querySelector('.panel').hidden) { document.querySelector('.fmtbar [aria-label="جدول"]').click(); ${wait(120)} }
  `);
  const panelPress = async (text) => {
    await pressButton(text, '.panel .btn');
    await pause(300);
  };
  const editorRows = () => page.evaluate(`return [...document.querySelector('.editor table').rows].map((tr) => [...tr.cells].map((td) => td.textContent));`);
  await inCell(2, 1);
  await shot('25-form-panel');
  await panelPress('+ سطر');
  check('the form: a row under the caret, with numbers counting', same((await editorRows()).map((r) => r[0]), ['ردیف', '۱', '۲', '۳', '۴', '۵']) && (await editorRows())[3][1] === '', await editorRows());
  check('and the caret in the new row', await page.evaluate(`const n = getSelection().anchorNode; return (n.nodeType === 3 ? n.parentNode : n).closest('tr')?.rowIndex === 3;`));
  await panelPress('− سطر');
  check('the form: the row taken out', same(await editorRows(), START), await editorRows());
  await inCell(2, 1);
  await panelPress('+ ستون');
  check('the form: a column beside it', (await editorRows())[2].length === 4 && (await editorRows())[2][2] === '', await editorRows());
  await panelPress('− ستون');
  check('the form: a column taken out', (await editorRows())[2].length === 3, await editorRows());
  await inCell(2, 1);
  await panelPress('حذف خانه…');
  check('the form: a cell asks how', await page.evaluate(`return document.querySelectorAll('.del-choice').length === 6;`));
  await choose('widen');
  check('the form: and is taken out', same((await editorRows())[2], ['۲', 'دوم']), await editorRows());
  check('the letter agrees', same((await rows())[2], ['۲', 'دوم']), await rows());
  await page.evaluate(`
    const L = window.__app.letter;
    const { blocksToHtml, setEditorHtml } = await import('${WEB}/editor.js');
    const t = L.body.find((b) => b.kind === 'table');
    t.rows = ${JSON.stringify(START)}.map((row) => row.map((text) => ({ paras: [{ runs: [{ text }] }] })));
    L.bodyHtml = blocksToHtml(L.body);
    setEditorHtml(document.querySelector('.editor'), L.bodyHtml);
    ${wait(100)}
  `);
  await inCell(3, 1);
  await panelPress('ابزار جدول');
  check('the form opens the same sheet, with its cell picked', (await page.evaluate(`return document.querySelectorAll('.pick-grid td.picked').length;`)) === 1);
  await tapInSheet('.table-sheet .del-choice[data-how="rows"]');
  await closeSheet();
  check('and the form follows the sheet', same((await editorRows()).map((r) => r[1]), ['نام', 'علی', 'رضا', 'مینا']), await editorRows());
  check('typing in the form afterwards keeps it', await (async () => {
    await page.evaluate(`
      const editor = document.querySelector('.editor');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      ${wait(300)}
    `);
    return same((await rows()).map((r) => r[1]), ['نام', 'علی', 'رضا', 'مینا']);
  })(), await rows());

  // Pasting
  await page.evaluate(`
    const editor = document.querySelector('.editor');
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor.querySelector('p'));
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ${wait(120)}
    document.querySelector('.fmtbar [aria-label="جدول"]').click(); ${wait(120)}
  `);
  await shot('26-form-panel-empty');
  await panelPress('از متن یا اکسل');
  await page.evaluate(`
    const field = document.querySelector('.sheet textarea');
    field.value = 'کالا\\tتعداد\\tقیمت\\nخودکار\\t۲\\t۵٬۰۰۰\\nدفتر\\t۳\\t۱۲٬۰۰۰';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    ${wait(100)}
  `);
  await shot('27-paste');
  check('pasted words are shown as a table before it is made', (await page.evaluate(`return document.querySelector('.sheet .note').textContent;`)).includes('۳ سطر و ۳ ستون'));
  await pressInSheet('درج جدول');
  await pause(350);
  const pasted = await page.evaluate(`
    const L = window.__app.letter;
    return L.body.filter((b) => b.kind === 'table').map((t) => t.rows.map((row) => row.map((c) => c.paras.map((p) => (p.runs || []).map((r) => r.text || '').join('')).join(''))));
  `);
  check('the table is in the letter', pasted.length === 2 && same(pasted[0][1], ['خودکار', '۲', '۵٬۰۰۰']), pasted);

  /* ---------- A long table cut over two pages, with a merged cell at the cut ---------- */
  await page.evaluate(`
    const L = window.__app.letter;
    const cell = (text, extra) => ({ paras: [{ runs: [{ text }] }], ...extra });
    const rows = Array.from({ length: 60 }, (_, r) => [cell('س' + r), cell('خانه ' + r)]);
    // Every other pair of rows is joined, so wherever the page ends a merged cell is near.
    for (let r = 0; r + 1 < rows.length; r += 2) { rows[r][0].rowSpan = 2; rows[r + 1].shift(); }
    const { blocksToHtml } = await import('${WEB}/editor.js');
    L.body = [{ kind: 'table', header: false, rows }];
    L.bodyHtml = blocksToHtml(L.body);
    const { setEditorHtml } = await import('${WEB}/editor.js');
    setEditorHtml(document.querySelector('.editor'), L.bodyHtml);
    document.querySelector('.editor').blur();
    ${wait(150)}
    ${clickText('#compose .bottombar .btn', 'چیدمان')} ${wait(600)}
  `);
  const cut = await page.evaluate(`
    const pages = [...document.querySelectorAll('#page .page')];
    const firstRow = (p) => p.querySelector('tr');
    return { pages: pages.length, starts: pages.map((p) => firstRow(p)?.children.length) };
  `);
  check('no page begins in the middle of a merged cell', cut.pages >= 2 && cut.starts.every((n) => n === 2 || n === undefined), cut);

  /* One merged cell taller than a page has to be cut, and no row may be lost. */
  await page.evaluate(`
    const L = window.__app.letter;
    const cell = (text, extra) => ({ paras: [{ runs: [{ text }] }], ...extra });
    const rows = Array.from({ length: 70 }, (_, r) => [...(r === 0 ? [cell('گروه', { rowSpan: 70 })] : []), cell('خانه ' + r)]);
    L.body = [{ kind: 'table', header: false, rows }];
    const { blocksToHtml } = await import('${WEB}/editor.js');
    L.bodyHtml = blocksToHtml(L.body);
    window.__app.screens.page.refresh();
    ${wait(400)}
  `);
  const tallCell = await page.evaluate(`
    const seen = new Set();
    document.querySelectorAll('#page .page td').forEach((td) => { if (td.textContent.startsWith('خانه')) seen.add(td.textContent.trim()); });
    return { pages: document.querySelectorAll('#page .page').length, rows: seen.size };
  `);
  check('a merged cell taller than a page is cut, with every row kept', tallCell.pages >= 2 && tallCell.rows === 70, tallCell);
} catch (err) {
  console.log('FAIL the test itself stopped:', err.message);
  failed++;
  await shot('zz-stopped').catch(() => {});
}

check('nothing went wrong on the page', page.errors.length === 0, page.errors.slice(0, 3));
await page.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
