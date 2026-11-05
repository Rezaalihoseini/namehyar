// The tools of the page: going back to exactly how it was, colour, exact size, taking a look, saved looks,
// fill and lines of a cell, a group of things far apart, redo, copying and turning, find and replace.
// Everything is done with a finger, and checked in the letter, on the page, in Word's file and in the archive.
//   node tools/ui-test-tools.js <out-folder>      (needs the preview server on port 8770)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPhone } from './cdp.js';

const out = resolve(process.argv[2] || 'ui-test-out');
mkdirSync(out, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const WEB = '/app/src/main/assets/web/js';
const APP = 'http://127.0.0.1:8770/app/src/main/assets/web/index.html';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? `: ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed++;
}

const page = await openPhone({ port: 9358 });

/* ---------- What a person does ---------- */

const pause = (ms = 450) => page.sleep(ms);
const CELL = (words) => `[...document.querySelectorAll('#page .page td')].find((c) => c.textContent.includes(${JSON.stringify(words)}))`;
const FRAME = (words) => `[...document.querySelectorAll('#page .obj-text')].find((f) => f.textContent.includes(${JSON.stringify(words)}))`;
const PARA = (words) => `[...document.querySelectorAll('#page .blk.p')].find((p) => p.textContent.includes(${JSON.stringify(words)}))`;

const wordCentre = (holder, word) => page.evaluate(`
  const el = ${holder};
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const i = walker.currentNode.data.indexOf(${JSON.stringify(word)});
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(walker.currentNode, i);
    range.setEnd(walker.currentNode, i + ${word.length});
    const stage = document.querySelector('#page .stage');
    const view = stage.getBoundingClientRect();
    const seen = range.getBoundingClientRect();
    stage.scrollBy({ left: seen.left + seen.width / 2 - (view.left + view.width / 2), top: seen.top + seen.height / 2 - (view.top + view.height / 2), behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 200));
    const b = range.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }
  return null;
`);
const tapWord = async (holder, word) => {
  const at = await wordCentre(holder, word);
  if (!at) throw new Error(`no word ${word} on the page`);
  await page.tap(at.x, at.y);
  await pause();
};
const tapSelector = async (selector) => {
  await page.tapOn(selector);
  await pause(250);
};
const pressTool = (label) => tapSelector(`.tools [aria-label="${label}"]`);
const pressButton = async (text, where = '.tools .btn') => {
  const at = await page.evaluate(`const b = [...document.querySelectorAll(${JSON.stringify(where)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  if (!at) throw new Error(`no button ${text}`);
  await page.tap(at.x, at.y);
  await pause(250);
};
const chooseFont = (font) => page.evaluate(`const s = document.querySelector('.tools select'); s.value = ${JSON.stringify(font)}; s.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 250));`);
const undo = () => tapSelector('#page [aria-label="برگرداندن آخرین تغییر"]');
const redo = () => tapSelector('#page [aria-label="انجام دوبارهٔ تغییر"]');
const endSelection = () => page.evaluate(`while (document.querySelector('#page .sel-cell, #page .sel-on, #page .sel-box') || window.__app.stack.at(-1) !== 'page') { if (window.__app.stack.at(-1) !== 'page') break; window.__onBack(); await new Promise((r) => setTimeout(r, 100)); if (!document.querySelector('#page .sel-cell, #page .sel-on, #page .sel-box')) break; }`);

/* ---------- What is in the letter and on the page ---------- */

const looks = () => page.evaluate(`
  const L = window.__app.letter;
  const cells = {};
  L.body.filter((b) => b.kind === 'table').forEach((t, n) => t.rows.forEach((row, r) => row.forEach((c, k) => { cells[n + ':' + r + ':' + k] = JSON.stringify({ paras: c.paras, bg: c.bg, borders: c.borders }); })));
  return { cells, frames: JSON.stringify(L.objects.map(({ orig, h, ...o }) => o)), paragraphs: JSON.stringify(L.body.filter((b) => b.kind === 'p').map(({ orig, ...b }) => b)), styles: JSON.stringify(L.styles) };
`);
const changedCells = (a, b) => Object.keys(a.cells).filter((k) => a.cells[k] !== b.cells[k]);
const cellOf = (words) => page.evaluate(`
  const L = window.__app.letter;
  return L.body.filter((b) => b.kind === 'table').flatMap((t) => t.rows.flat()).find((c) => c.paras.some((p) => (p.runs || []).map((r) => r.text).join('').includes(${JSON.stringify(words)})));
`);
const heights = () => page.evaluate(`
  const sheet = document.querySelector('#page .page');
  const box = sheet.getBoundingClientRect();
  const k = box.width / 210;
  return { rows: [...sheet.querySelectorAll('tr')].map((tr) => +(tr.getBoundingClientRect().height / k).toFixed(2)), tops: [...sheet.querySelectorAll('table')].map((t) => +((t.getBoundingClientRect().top - box.top) / k).toFixed(2)) };
`);
const colorOf = (holder) => page.evaluate(`const el = ${holder}; return getComputedStyle(el.querySelector('span') || el).color;`);
const toolsState = () => page.evaluate(`return {
  title: document.querySelector('.tools .hint.grow')?.textContent,
  size: document.querySelector('.tools .size-btn')?.textContent,
  font: document.querySelector('.tools select')?.value,
  bold: !!document.querySelector('.tools [aria-label="توپر"].on'),
  underline: !!document.querySelector('.tools [aria-label="زیرخط"].on'),
  cells: document.querySelectorAll('#page .sel-cell').length,
  whole: document.querySelectorAll('#page .sel-on').length,
  word: document.querySelectorAll('#page .sel-word').length,
};`);
const wordFile = () => page.evaluate(`
  const { makeDocx } = await import('${WEB}/export.js');
  const { importDocx } = await import('${WEB}/import-docx.js');
  const { bytesToBase64 } = await import('${WEB}/util.js');
  const { readZip } = await import('${WEB}/unzip.js');
  const made = await makeDocx(window.__app.letter, { deliver: false });
  const zip = readZip(made.bytes);
  const doc = new TextDecoder().decode(zip.get('word/document.xml')());
  const L = await importDocx(made.bytes, window.__app.settings);
  return { docx: bytesToBase64(made.bytes), doc, back: { body: L.body, objects: L.objects, styles: L.styles } };
`);

/* ---------- Opening the sample ---------- */

async function openSample() {
  await page.goto('http://127.0.0.1:8770/tools/form-sample.html');
  await page.sleep(1200);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const printed = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
  await page.goto(APP);
  await page.sleep(1200);
  await page.evaluate(`
    const { openLetterFile } = await import('${WEB}/screens/home.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(printed.data)}), (c) => c.charCodeAt(0));
    await openLetterFile(bytes, 'form-sample.pdf');
    await new Promise((r) => setTimeout(r, 900));
  `);
  await page.sleep(4300);
  for (let i = 0; i < 5; i++) {
    await page.tapOn('#page [aria-label="بزرگ‌نمایی"]');
    await pause(100);
  }
}

try {
  await openSample();

  /* ---------- Bigger and back again: nothing may stay changed ---------- */
  const first = await looks();
  const firstHeights = await heights();
  const name = CELL('سیستم‌عامل');
  await tapWord(name, 'سیستم‌عامل');
  const startSize = (await toolsState()).size;
  let steps = 0;
  while ((await toolsState()).size !== '۱۸' && steps < 40) {
    await pressTool('بزرگ‌تر');
    steps++;
  }
  const atBig = await heights();
  check('from six to eighteen, one step at a time', (await toolsState()).size === '۱۸' && steps > 5, { steps, from: startSize });
  const sum = (list) => list.reduce((a, b) => a + b, 0);
  check('and the row grows to hold it', sum(atBig.rows) > sum(firstHeights.rows) + 1, [sum(firstHeights.rows), sum(atBig.rows)]);
  await page.screenshot(join(out, 'tools-1-big.png'));
  for (let i = 0; i < steps; i++) await pressTool('کوچک‌تر');
  let now = await looks();
  const atStart = await heights();
  check('back at six the tools say so', (await toolsState()).size === startSize, (await toolsState()).size);
  check('every row is the height it was, with no gap left', JSON.stringify(atStart.rows) === JSON.stringify(firstHeights.rows), atStart.rows.filter((h, i) => h !== firstHeights.rows[i]));
  check('every table stands where it stood', JSON.stringify(atStart.tops) === JSON.stringify(firstHeights.tops), atStart.tops);
  check('and in the letter nothing is different', changedCells(first, now).length === 0, changedCells(first, now).map((k) => [k, first.cells[k], now.cells[k]]).slice(0, 2));
  await page.screenshot(join(out, 'tools-2-back.png'));

  /* The same for a word, for a whole table, and for a frame. */
  const many = CELL('اخلاق اسلامی');
  await tapWord(many, 'اسلامی');
  await tapWord(many, 'اسلامی');
  for (let i = 0; i < 12; i++) await pressTool('بزرگ‌تر');
  for (let i = 0; i < 12; i++) await pressTool('کوچک‌تر');
  now = await looks();
  check('a word made bigger and smaller leaves its cell as it was', changedCells(first, now).length === 0 && JSON.stringify((await heights()).rows) === JSON.stringify(firstHeights.rows), changedCells(first, now).map((k) => now.cells[k]).slice(0, 1));
  await endSelection();
  await tapWord(CELL('3021120'), '3021120');
  await pressButton('همهٔ جدول');
  for (let i = 0; i < 6; i++) await pressTool('بزرگ‌تر');
  for (let i = 0; i < 6; i++) await pressTool('کوچک‌تر');
  now = await looks();
  check('a whole table made bigger and smaller comes back too', changedCells(first, now).length === 0 && JSON.stringify((await heights()).rows) === JSON.stringify(firstHeights.rows), changedCells(first, now).length);
  await pressButton('همهٔ جدول');
  const frameY = () => page.evaluate(`return window.__app.letter.objects.find((o) => o.text?.includes('دانشگاه نمونه'));`);
  const frameFirst = await frameY();
  await tapWord(FRAME('دانشگاه نمونه'), 'دانشگاه');
  for (let i = 0; i < 6; i++) await pressTool('بزرگ‌تر');
  for (let i = 0; i < 6; i++) await pressTool('کوچک‌تر');
  const frameBack = await frameY();
  check('a frame made bigger and smaller comes back to its place', Math.abs(frameBack.y - frameFirst.y) < 0.001 && frameBack.style.line === frameFirst.style.line && frameBack.style.size === frameFirst.style.size, [frameFirst.y, frameBack.y, frameBack.style]);
  await endSelection();

  /* ---------- An exact size, in one tap ---------- */
  await tapWord(name, 'سیستم‌عامل');
  await tapSelector('.tools .size-btn');
  await page.screenshot(join(out, 'tools-3-size.png'));
  await pressButton('۱۸', '.size-grid .btn');
  check('a size can be chosen from a list, at once', (await toolsState()).size === '۱۸' && (await cellOf('سیستم‌عامل')).paras[0].runs[0].size === 18, (await toolsState()).size);
  await tapSelector('.tools .size-btn');
  await page.evaluate(`const f = document.querySelector('.size-input'); f.value = '۹.۵'; await new Promise((r) => setTimeout(r, 50));`);
  await pressButton('این اندازه', '.sheet .btn');
  check('or typed, in Persian digits too', (await cellOf('سیستم‌عامل')).paras[0].runs[0].size === 9.5, (await cellOf('سیستم‌عامل')).paras[0].runs[0]);

  /* ---------- Going back all at once ---------- */
  await chooseFont('B Titr');
  await pressTool('توپر');
  await pressTool('زیرخط');
  now = await looks();
  check('underline reaches that cell alone', changedCells(first, now).length === 1 && (await cellOf('سیستم‌عامل')).paras[0].runs[0].u === true, changedCells(first, now));
  await pressTool('برگشت به حالت اول');
  now = await looks();
  check('one button takes a cell back to how it first looked', changedCells(first, now).length === 0 && JSON.stringify((await heights()).rows) === JSON.stringify(firstHeights.rows), changedCells(first, now).map((k) => now.cells[k]));
  await endSelection();

  /* ---------- Colour ---------- */
  const beforeColor = await looks();
  await tapWord(name, 'سیستم‌عامل');
  await pressTool('رنگ متن');
  await page.screenshot(join(out, 'tools-4-colors.png'));
  await tapSelector('.sheet .swatch[data-color="C00000"]');
  now = await looks();
  check('a colour reaches that cell alone', changedCells(beforeColor, now).length === 1 && (await cellOf('سیستم‌عامل')).paras[0].runs[0].color === 'C00000', changedCells(beforeColor, now));
  check('the page shows it in that colour', (await colorOf(name)) === 'rgb(192, 0, 0)', await colorOf(name));
  check('and the cell beside it stays black', (await colorOf(CELL('3021109'))) === 'rgb(0, 0, 0)', await colorOf(CELL('3021109')));
  await page.screenshot(join(out, 'tools-5-colored.png'));
  // A colour by its code, and the list of the last ones used.
  await tapWord(CELL('3021109'), '3021109');
  await pressTool('رنگ متن');
  await page.evaluate(`const f = document.querySelector('.hex-input'); f.value = '#00707c'; await new Promise((r) => setTimeout(r, 50));`);
  await pressButton('این رنگ', '.sheet .btn');
  check('a colour can be given by its code', (await cellOf('3021109')).paras[0].runs[0].color === '00707C', (await cellOf('3021109')).paras[0].runs[0]);
  await pressTool('رنگ متن');
  const recent = await page.evaluate(`return [...document.querySelectorAll('.sheet .swatches')].at(-1).querySelectorAll('.swatch').length;`);
  check('the last colours used are kept at hand', recent >= 2, recent);
  await pressButton('رنگ معمولی (سیاه)', '.sheet .btn');
  check('and the usual colour is one tap away', !(await cellOf('3021109')).paras[0].runs[0].color, (await cellOf('3021109')).paras[0].runs[0]);
  // One word, a paragraph, a frame.
  await endSelection();
  await tapWord(many, 'مبانی');
  await tapWord(many, 'مبانی');
  await pressTool('رنگ متن');
  await tapSelector('.sheet .swatch[data-color="0070C0"]');
  const manyRuns = (await cellOf('اخلاق')).paras[0].runs;
  check('a colour reaches one word alone', manyRuns.find((r) => r.text === 'مبانی')?.color === '0070C0' && manyRuns.filter((r) => r.text !== 'مبانی').every((r) => !r.color), manyRuns);
  await pressTool('زیرخط');
  check('and so does an underline', (await cellOf('اخلاق')).paras[0].runs.find((r) => r.text === 'مبانی')?.u === true);
  await endSelection();
  await tapWord(PARA('این کارنامه'), 'کارنامه');
  await pressTool('رنگ متن');
  await tapSelector('.sheet .swatch[data-color="00B050"]');
  const paragraphRuns = await page.evaluate(`return window.__app.letter.body.find((b) => b.kind === 'p' && b.runs?.some((r) => r.text.includes('این'))).runs;`);
  check('a colour reaches a paragraph', paragraphRuns.every((r) => r.color === '00B050'), paragraphRuns);
  await endSelection();
  await tapWord(FRAME('آموزشکده نمونه'), 'آموزشکده');
  await pressTool('رنگ متن');
  await tapSelector('.sheet .swatch[data-color="7030A0"]');
  check('a colour reaches a frame', (await page.evaluate(`return window.__app.letter.objects.find((o) => o.text?.includes('آموزشکده')).style.color;`)) === '7030A0' && (await colorOf(FRAME('آموزشکده نمونه'))) === 'rgb(112, 48, 160)');
  await pressTool('رنگ زمینه');
  await tapSelector('.sheet .swatch[data-color="FFF2CC"]');
  check('a frame can have a fill', (await page.evaluate(`return window.__app.letter.objects.find((o) => o.text?.includes('آموزشکده')).fill;`)) === 'FFF2CC');
  await endSelection();

  /* ---------- Fill and lines of a cell ---------- */
  const beforeFill = await looks();
  await tapWord(CELL('3021116'), '3021116');
  await pressTool('رنگ زمینه');
  await page.screenshot(join(out, 'tools-6-fills.png'));
  await tapSelector('.sheet .swatch[data-color="FFF2CC"]');
  now = await looks();
  check('a fill reaches that cell alone', changedCells(beforeFill, now).length === 1 && (await cellOf('3021116')).bg === 'FFF2CC', changedCells(beforeFill, now));
  check('the page shows it', (await page.evaluate(`return getComputedStyle(${CELL('3021116')}).backgroundColor;`)).length > 0);
  await pressTool('خط‌های خانه');
  await page.screenshot(join(out, 'tools-7-lines.png'));
  await tapSelector('.sheet [data-width="1.5"]');
  await pressButton('خط بکش', '.sheet .btn');
  const lined = await cellOf('3021116');
  check('lines can be drawn around a cell', lined.borders.every((w) => w === 1.5), lined.borders);
  const beside = await page.evaluate(`
    const t = window.__app.letter.body.filter((b) => b.kind === 'table')[1];
    const td = ${CELL('3021116')};
    const row = t.rows[Number(td.dataset.r)];
    const c = Number(td.dataset.c);
    return row[c + 1].borders;
  `);
  check('and the cell beside it shares that line', beside?.[1] === 1.5, beside);
  await pressTool('خط‌های خانه');
  await tapSelector('.sheet [data-side="top"]');
  await tapSelector('.sheet [data-side="bottom"]');
  await pressButton('خط را بردار', '.sheet .btn');
  const cleared = await cellOf('3021116');
  check('and taken away from the sides chosen', cleared.borders[0] === 1.5 && cleared.borders[1] === 0 && cleared.borders[2] === 1.5 && cleared.borders[3] === 0, cleared.borders);
  await page.screenshot(join(out, 'tools-8-lined.png'));
  await pressTool('برگشت به حالت اول');
  now = await looks();
  const stillChanged = changedCells(beforeFill, now);
  check('going back takes fill and lines away', !(await cellOf('3021116')).bg && JSON.stringify((await cellOf('3021116')).borders) === JSON.stringify(JSON.parse(beforeFill.cells[Object.keys(beforeFill.cells).find((k) => beforeFill.cells[k].includes('3021116'))]).borders), stillChanged);
  await endSelection();
  await undo();
  await undo();

  /* ---------- Taking a look and giving it to others ---------- */
  await tapWord(CELL('9102'), '9102');
  await pressTool('رنگ متن');
  await tapSelector('.sheet .swatch[data-color="C00000"]');
  await tapSelector('.tools .size-btn');
  await pressButton('۹', '.size-grid .btn');
  await pressTool('برداشتن قالب برای چیزهای دیگر');
  const painterBar = await page.evaluate(`return document.querySelector('.tools .painter-row')?.textContent;`);
  check('a look can be taken, and the screen says what to do next', !!painterBar?.includes('همین قالب'), painterBar);
  await page.screenshot(join(out, 'tools-9-painter.png'));
  await tapWord(CELL('3021119'), '3021119');
  await tapWord(CELL('9107'), '9107');
  const painted = [await cellOf('3021119'), await cellOf('9107')].map((c) => c.paras[0].runs[0]);
  check('each tap gives that look', painted.every((r) => r.color === 'C00000' && r.size === 9), painted);
  await tapWord(PARA('این کارنامه'), 'این');
  const paintedParagraph = await page.evaluate(`return window.__app.letter.body.find((b) => b.kind === 'p' && b.runs?.some((r) => r.text.includes('این')));`);
  check('to a paragraph as well', paintedParagraph.runs.every((r) => r.color === 'C00000') && paintedParagraph.over?.size === 9, paintedParagraph);
  await pressButton('پایان');
  const afterPaint = await looks();
  await tapWord(CELL('3021120'), '3021120');
  check('after the end, a tap only picks again', changedCells(afterPaint, await looks()).length === 0 && (await toolsState()).cells === 1);

  /* ---------- Saved looks ---------- */
  await endSelection();
  await tapWord(CELL('9102'), '9102');
  await pressTool('سبک‌ها');
  await page.evaluate(`const f = [...document.querySelectorAll('.sheet input')].at(-1); f.value = 'نمرهٔ مهم'; await new Promise((r) => setTimeout(r, 50));`);
  await pressButton('ذخیره', '.sheet .btn');
  await page.screenshot(join(out, 'tools-10-looks.png'));
  const saved = await page.evaluate(`return window.__app.settings.looks;`);
  check('a look can be saved under a name', saved.length === 1 && saved[0].name === 'نمرهٔ مهم' && saved[0].color === 'C00000' && saved[0].size === 9, saved);
  await page.evaluate(`document.querySelector('.sheet [aria-label="بستن"]').click(); await new Promise((r) => setTimeout(r, 200));`);
  await endSelection();
  await tapWord(many, 'اخلاق');
  await tapWord(many, 'اخلاق');
  await pressTool('سبک‌ها');
  await tapSelector(`.sheet .look-pick[data-look="${saved[0].id}"]`);
  const looked = (await cellOf('اخلاق')).paras[0].runs.find((r) => r.text === 'اخلاق');
  check('a saved look goes on one word with one tap', looked.color === 'C00000' && looked.size === 9, looked);
  await endSelection();

  /* ---------- A group of things far apart ---------- */
  const beforeGroup = await looks();
  await tapWord(CELL('3021120'), '3021120');
  await pressButton('چندتایی');
  await tapWord(CELL('3021116'), '3021116');
  await tapWord(CELL('9102'), '9102');
  let state = await toolsState();
  check('more cells join with a tap each', state.cells === 3 && state.title.includes('۳'), state);
  await page.screenshot(join(out, 'tools-11-group.png'));
  await tapWord(CELL('9102'), '9102');
  state = await toolsState();
  check('a second tap takes one out', state.cells === 2 && state.title.includes('۲'), state);
  const beforeSize = [(await cellOf('3021120')).paras[0].runs[0].size, (await cellOf('3021116')).paras[0].runs[0].size];
  await pressTool('رنگ متن');
  await tapSelector('.sheet .swatch[data-color="185ABD"]');
  await pressTool('بزرگ‌تر');
  now = await looks();
  let changed = changedCells(beforeGroup, now);
  check('a change reaches the group and nothing else', changed.length === 2, changed);
  const grouped = [await cellOf('3021120'), await cellOf('3021116')].map((c) => c.paras[0].runs[0]);
  check('all of the group take the colour and the size', grouped.every((r) => r.color === '185ABD') && grouped.every((r, i) => r.size === beforeSize[i] + 0.5), grouped);
  state = await toolsState();
  check('the group stays chosen for the next change', state.cells === 2, state);
  await undo();
  await undo();
  now = await looks();
  check('and each change is taken back in one step, whole', changedCells(beforeGroup, now).length === 0 && (await toolsState()).cells === 2, changedCells(beforeGroup, now));
  await redo();
  check('redo brings a change back', (await cellOf('3021120')).paras[0].runs[0].color === '185ABD' && (await cellOf('3021116')).paras[0].runs[0].color === '185ABD');
  await undo();
  // A row, a column, the same words.
  await tapWord(CELL('3021116'), '3021116');
  await tapWord(CELL('3021116'), '3021116');
  await pressButton('کل سطر');
  state = await toolsState();
  check('a whole row joins with one button', state.cells >= 15, state);
  await pressButton('کل سطر');
  const afterRow = (await toolsState()).cells;
  check('and leaves with the same button', afterRow < state.cells, afterRow);
  await pressButton('کل ستون');
  state = await toolsState();
  check('a whole column too', state.cells >= afterRow + 4, state);
  await pressButton('کل ستون');
  await tapWord(CELL('19.00'), '19.00');
  await pressButton('مشابه‌ها');
  state = await toolsState();
  const nineteen = await page.evaluate(`return [...document.querySelectorAll('#page .sel-cell')].filter((c) => c.textContent.trim() === '19.00').length;`);
  check('every cell with the same words joins with one button', nineteen >= 2 && nineteen === (await page.evaluate(`return [...document.querySelectorAll('#page .page td')].filter((c) => c.textContent.trim() === '19.00').length;`)), nineteen);
  await page.screenshot(join(out, 'tools-12-similar.png'));
  await pressTool('زیرخط');
  check('and they all change together', (await page.evaluate(`
    const cells = window.__app.letter.body.filter((b) => b.kind === 'table').flatMap((t) => t.rows.flat()).filter((c) => c.paras[0].runs?.[0]?.text === '19.00');
    return cells.length > 1 && cells.every((c) => c.paras[0].runs[0].u === true);
  `)));
  await undo();
  // Paragraphs and frames can be in the group too, and fill and alignment work on it.
  await tapWord(PARA('این کارنامه'), 'نمونه');
  await tapWord(FRAME('ساعت'), 'ساعت');
  const mixed = await toolsState();
  check('a paragraph and a frame can join the group', mixed.whole >= 2, mixed);
  await pressTool('توپر');
  await pressTool('رنگ زمینه');
  await tapSelector('.sheet .swatch[data-color="DEEAF6"]');
  const filled = await page.evaluate(`
    const L = window.__app.letter;
    return { cells: L.body.filter((b) => b.kind === 'table').flatMap((t) => t.rows.flat()).filter((c) => c.bg === 'DEEAF6').length, frame: L.objects.find((o) => o.text?.includes('ساعت')).fill };
  `);
  check('a fill reaches its cells and frames', filled.cells > 1 && filled.frame === 'DEEAF6', filled);
  await pressTool('وسط');
  // The same words into all of them.
  await pressTool('نوشتن در همهٔ خانه‌ها');
  await page.evaluate(`const f = document.querySelector('.sheet textarea'); f.value = '20.00'; await new Promise((r) => setTimeout(r, 50));`);
  await page.screenshot(join(out, 'tools-13-write.png'));
  await pressButton('تأیید', '.sheet .btn');
  const written = await page.evaluate(`return window.__app.letter.body.filter((b) => b.kind === 'table').flatMap((t) => t.rows.flat()).filter((c) => c.bg === 'DEEAF6').every((c) => c.paras[0].runs[0].text === '20.00');`);
  check('the same words can go into all the cells of the group', written);
  await pressButton('پایان');
  check('and the end lets go of them', (await toolsState()).cells === 0, await toolsState());

  /* ---------- Copying a frame, turning a picture ---------- */
  const objects = await page.evaluate(`return window.__app.letter.objects.length;`);
  await tapWord(FRAME('تاریخ چاپ'), 'تاریخ');
  await pressTool('یک کپی از این کادر');
  const copied = await page.evaluate(`const L = window.__app.letter; const o = L.objects.at(-1); return { count: L.objects.length, text: o.text, id: o.id, ids: new Set(L.objects.map((x) => x.id)).size };`);
  check('a frame can be copied', copied.count === objects + 1 && copied.text.includes('تاریخ چاپ') && copied.ids === copied.count, copied);
  await undo();
  await page.evaluate(`
    const { putMedia } = await import('${WEB}/store.js');
    await putMedia('test-stamp', ${JSON.stringify(`data:image/png;base64,${readFileSync(join(here, 'test-image.png')).toString('base64')}`)});
    const { app } = await import('${WEB}/app.js');
    app.letter.objects.push({ id: 'stamp-1', kind: 'image', anchor: 'page', page: 0, mediaId: 'test-stamp', aspect: 1, x: 150, y: 90, w: 30 });
    window.__onBack();
    await new Promise((r) => setTimeout(r, 300));
    (await import('${WEB}/app.js')).showScreen('page');
    await new Promise((r) => setTimeout(r, 600));
    document.querySelector('#page .obj[data-id="stamp-1"]').scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((r) => setTimeout(r, 200));
  `);
  const stamp = await page.centre('#page .obj[data-id="stamp-1"]');
  await page.tap(stamp.x, stamp.y);
  await pause();
  await pressTool('چرخش به راست');
  await pressTool('چرخش به راست');
  await page.screenshot(join(out, 'tools-14-rotated.png'));
  const turned = await page.evaluate(`const el = document.querySelector('#page .obj[data-id="stamp-1"]'); return { rotate: window.__app.letter.objects.find((o) => o.id === 'stamp-1').rotate, css: el.style.transform };`);
  check('a picture can be turned', turned.rotate === 10 && turned.css.includes('10deg'), turned);

  /* ---------- Find and replace ---------- */
  await endSelection();
  await pressTool('جستجو و جایگزینی');
  await page.evaluate(`
    const [find, to] = document.querySelectorAll('.sheet input');
    find.value = 'نمونه';
    find.dispatchEvent(new Event('input', { bubbles: true }));
    to.value = 'تازه';
    await new Promise((r) => setTimeout(r, 100));
  `);
  await page.screenshot(join(out, 'tools-15-find.png'));
  const foundText = await page.evaluate(`return document.querySelector('.sheet .note').textContent;`);
  check('find says how many there are', /[۰-۹]+ مورد/.test(foundText), foundText);
  await pressButton('همه را عوض کن', '.sheet .btn');
  const replaced = await page.evaluate(`
    const L = window.__app.letter;
    const text = JSON.stringify([L.body.map((b) => b.kind === 'p' ? b.runs.map((r) => r.text) : b.rows.flat().map((c) => c.paras.map((p) => (p.runs || []).map((r) => r.text)))), L.objects.filter((o) => o.kind === 'text').map((o) => o.text)]);
    return { old: text.includes('نمونه'), now: text.includes('تازه') , frame: L.objects.find((o) => o.text?.includes('دانشگاه'))?.text };
  `);
  check('replace reaches table, paragraph and frame', !replaced.old && replaced.now && replaced.frame === 'دانشگاه تازه', replaced);
  const stayed = await page.evaluate(`return window.__app.letter.objects.find((o) => o.text?.includes('آموزشکده')).style.color;`);
  check('the words keep their look', stayed === '7030A0', stayed);
  await undo();
  check('and it can be taken back', (await page.evaluate(`return window.__app.letter.objects.find((o) => o.text?.includes('دانشگاه'))?.text;`)) === 'دانشگاه نمونه');

  /* ---------- The form screen, Word, and the archive keep all of it ---------- */
  const same = await page.evaluate(`
    const { blocksToHtml, serializeEditor } = await import('${WEB}/editor.js');
    const L = window.__app.letter;
    const holder = document.createElement('div');
    holder.innerHTML = blocksToHtml(L.body);
    const again = serializeEditor(holder);
    const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
    return JSON.stringify(canon(L.body)) === JSON.stringify(canon(again));
  `);
  check('going through the form screen loses nothing', same);
  await page.screenshot(join(out, 'tools-16-final-page.png'));
  const word = await wordFile();
  writeFileSync(join(out, 'tools-export.docx'), Buffer.from(word.docx, 'base64'));
  check('Word gets the colours', word.doc.includes('w:color w:val="C00000"') && word.doc.includes('w:color w:val="0070C0"'));
  check('and the underlines', word.doc.includes('<w:u w:val="single"/>'));
  check('and the fills of cells', word.doc.includes('w:fill="DEEAF6"'));
  check('and the fill of a frame', word.doc.includes('<a:srgbClr val="FFF2CC"/>'));
  check('and the turn of a picture', word.doc.includes('rot="600000"'));
  const backCells = word.back.body.filter((b) => b.kind === 'table').flatMap((t) => t.rows.flat());
  const backRun = (text) => backCells.flatMap((c) => c.paras.flatMap((p) => p.runs || [])).find((r) => r.text === text);
  check('read back from Word, a word keeps its colour and underline', backRun('مبانی')?.color === '0070C0' && backRun('مبانی')?.u === true, backRun('مبانی'));
  check('a cell keeps its fill', backCells.some((c) => c.bg === 'DEEAF6'));
  check('a frame keeps its fill and colour', word.back.objects.some((o) => o.fill === 'FFF2CC'), word.back.objects.map((o) => o.fill).filter(Boolean));
  check('a picture keeps its turn', word.back.objects.some((o) => o.rotate === 10), word.back.objects.map((o) => o.rotate).filter(Boolean));
  const reopened = await page.evaluate(`
    const id = window.__app.letter.id;
    // The order of a thing's properties means nothing.
    const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
    const before = JSON.stringify(canon(window.__app.letter.body));
    for (let i = 0; i < 4 && window.__app.stack.at(-1) !== 'home'; i++) {
      window.__onBack();
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 900));
    document.querySelector('#home .letter-row').click();
    await new Promise((r) => setTimeout(r, 900));
    return { same: window.__app.letter.id === id && JSON.stringify(window.__app.letter.body).includes('DEEAF6') && JSON.stringify(canon(window.__app.letter.body)) === before, screen: window.__app.stack.at(-1), colored: [...document.querySelectorAll('#page span')].some((s) => s.style.color === 'rgb(192, 0, 0)') };
  `);
  check('saved and opened again, every look comes back', reopened.same && reopened.screen === 'page' && reopened.colored, reopened);
  // A look saved under a name stays for other letters.
  const kept = await page.evaluate(`
    const { getDoc } = await import('${WEB}/store.js');
    const settings = await getDoc('settings', 'main');
    return settings.looks?.map((look) => look.name);
  `);
  check('a saved look stays for other letters', kept?.includes('نمرهٔ مهم'), kept);

  /* ---------- An ordinary letter ---------- */
  const ordinary = await page.evaluate(`
    const { sampleLetter } = await import('/tools/sample-letter.js');
    const { showScreen, backToHome, saveLetterNow } = await import('${WEB}/app.js');
    backToHome();
    const L = sampleLetter({});
    window.__app.letter = L;
    showScreen('compose', { fresh: false });
    showScreen('page');
    await new Promise((r) => setTimeout(r, 900));
    return !!document.querySelector('#page [data-section="subject"]');
  `);
  await page.sleep(300);
  const subject = await page.centre('#page [data-section="subject"]');
  await page.tap(subject.x, subject.y);
  await pause();
  await pressTool('رنگ متن');
  await tapSelector('.sheet .swatch[data-color="C00000"]');
  const partColor = await page.evaluate(`return { style: window.__app.letter.styles.subject.color, css: getComputedStyle(document.querySelector('#page [data-section="subject"] span')).color };`);
  check('a part such as the subject changes colour as a whole', ordinary && partColor.style === 'C00000' && partColor.css === 'rgb(192, 0, 0)', partColor);
  const partWord = await page.evaluate(`
    const { makeDocx } = await import('${WEB}/export.js');
    const { readZip } = await import('${WEB}/unzip.js');
    const made = await makeDocx(window.__app.letter, { deliver: false });
    return new TextDecoder().decode(readZip(made.bytes).get('word/document.xml')()).includes('w:color w:val="C00000"');
  `);
  check('and in Word too', partWord);

  if (page.errors.length) console.log('script errors:', page.errors);
  check('no script errors', page.errors.length === 0);
} catch (err) {
  console.log('FAIL the run stopped:', err.message);
  failed++;
} finally {
  await page.close();
}

console.log(failed ? `${failed} checks failed` : 'all tool checks passed');
process.exit(failed ? 1 : 0);
