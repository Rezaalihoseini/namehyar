// A change of font or size reaches only what was picked: one cell, or one word, and nothing beside it.
// Everything is done with a finger on the page, and checked in the letter, on the page, in Word's file and back in the archive.
//   node tools/ui-test-look.js <out-folder>      (needs the preview server on port 8770)
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

const page = await openPhone({ port: 9356 });

/* ---------- What a person does ---------- */

const pause = (ms = 450) => page.sleep(ms);
const touch = (type, points) => page.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y]) => ({ x, y })) });
const CELL = (words) => `[...document.querySelectorAll('#page .page td')].find((c) => c.textContent.includes(${JSON.stringify(words)}))`;

/** Where a word is drawn, after bringing it into view. */
const wordCentre = (holder, word) => page.evaluate(`
  const el = ${holder};
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const i = walker.currentNode.data.indexOf(${JSON.stringify(word)});
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(walker.currentNode, i);
    range.setEnd(walker.currentNode, i + ${word.length});
    // The word itself, not the whole of a wide paragraph, is brought to the middle of the screen.
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
  return at;
};
const pressTool = async (label) => {
  await page.tapOn(`.tools [aria-label="${label}"]`);
  await pause(250);
};
const pressButton = async (text) => {
  const at = await page.evaluate(`const b = [...document.querySelectorAll('.tools .btn')].find((x) => x.textContent === ${JSON.stringify(text)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  if (!at) throw new Error(`no button ${text}`);
  await page.tap(at.x, at.y);
  await pause(250);
};
const chooseFont = async (font) => {
  await page.evaluate(`const s = document.querySelector('.tools select'); s.value = ${JSON.stringify(font)}; s.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 250));`);
};

/* ---------- What is in the letter and on the page ---------- */

const looks = () => page.evaluate(`
  const L = window.__app.letter;
  const cells = {};
  L.body.filter((b) => b.kind === 'table').forEach((t, n) => t.rows.forEach((row, r) => row.forEach((c, k) => { cells[n + ':' + r + ':' + k] = JSON.stringify(c.paras); })));
  return { cells, frames: JSON.stringify(L.objects), paragraphs: JSON.stringify(L.body.filter((b) => b.kind === 'p')), styles: JSON.stringify(L.styles) };
`);
const changedCells = (a, b) => Object.keys(a.cells).filter((k) => a.cells[k] !== b.cells[k]);
const cellRuns = (words) => page.evaluate(`
  const L = window.__app.letter;
  const cell = L.body.filter((b) => b.kind === 'table').flatMap((t) => t.rows.flat()).find((c) => c.paras.some((p) => p.runs.map((r) => r.text).join('').includes(${JSON.stringify(words)})));
  return cell ? cell.paras : null;
`);
const toolsState = () => page.evaluate(`return {
  title: document.querySelector('.tools .hint.grow')?.textContent,
  size: document.querySelector('.tools .tool-row b')?.textContent,
  font: document.querySelector('.tools select')?.value,
  bold: !!document.querySelector('.tools [aria-label="توپر"].on'),
  picked: document.querySelector('#page .sel-cell')?.textContent,
  wholeOn: document.querySelectorAll('#page .sel-on').length,
  wordOn: document.querySelectorAll('#page .sel-word').length,
  hint: document.querySelector('.tools .tool-hint')?.textContent,
};`);
const fontSizeOf = (holder) => page.evaluate(`const el = ${holder}; const span = el.querySelector('span') || el; return parseFloat(getComputedStyle(span).fontSize);`);

try {
  /* ---------- The sample, opened as a person would ---------- */
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
  // The message about the opened file goes away by itself, and the page is made larger to reach its small words.
  await page.sleep(4300);
  for (let i = 0; i < 5; i++) {
    await page.tapOn('#page [aria-label="بزرگ‌نمایی"]');
    await pause(100);
  }

  /* ---------- One cell ---------- */
  const single = CELL('سیستم‌عامل');
  const start = await looks();
  await tapWord(single, 'سیستم‌عامل');
  let state = await toolsState();
  check('a tap picks the cell under the finger', state.picked === 'سیستم‌عامل' && state.title === 'این خانه', state);
  check('and only that cell looks selected, not its table', state.wholeOn === 0, state.wholeOn);
  const neighbourSize = await fontSizeOf(CELL('3021109'));
  const sizeBefore = await fontSizeOf(single);
  await pressTool('بزرگ‌تر');
  await pressTool('بزرگ‌تر');
  await page.screenshot(join(out, 'look-1-cell-bigger.png'));
  let now = await looks();
  let changed = changedCells(start, now);
  check('a bigger size reaches that cell alone', changed.length === 1, changed);
  check('the look of the whole table stays', now.styles === start.styles && now.frames === start.frames && now.paragraphs === start.paragraphs);
  check('the page shows it bigger', (await fontSizeOf(single)) > sizeBefore, [sizeBefore, await fontSizeOf(single)]);
  check('and the cell beside it as it was', (await fontSizeOf(CELL('3021109'))) === neighbourSize, neighbourSize);
  await chooseFont('B Nazanin');
  now = await looks();
  changed = changedCells(start, now);
  let runs = await cellRuns('سیستم‌عامل');
  check('a font reaches that cell alone', changed.length === 1 && runs[0].runs[0].font === 'B Nazanin', { changed, runs });
  const wasBold = (await toolsState()).bold;
  await pressTool('توپر');
  now = await looks();
  state = await toolsState();
  check('thickness reaches that cell alone, and the tools show it', changedCells(start, now).length === 1 && state.bold === !wasBold && state.font === 'B Nazanin', state);
  await page.screenshot(join(out, 'look-2-cell-font.png'));

  /* ---------- A fixed line grows with its letters, or Word would cut them off ---------- */
  runs = await cellRuns('سیستم‌عامل');
  check('the line grows with its letters', runs[0].over.line >= runs[0].runs[0].size * 1.2 - 0.01, runs[0]);

  /* ---------- Very small writing ---------- */
  const small = CELL('کد درس');
  await tapWord(small, 'درس');
  state = await toolsState();
  const smallSize = await page.evaluate(`return window.__app.letter.body.filter((b) => b.kind === 'table')[1].rows[1][0].paras[0].runs[0].size ?? window.__app.letter.styles.table.size;`);
  const smallCell = await page.evaluate(`const td = ${small}; return [td.dataset.r, td.dataset.c];`);
  await pressTool('کوچک‌تر');
  const smaller = await page.evaluate(`return window.__app.letter.body.filter((b) => b.kind === 'table')[1].rows[${smallCell[0]}][${smallCell[1]}].paras[0].runs[0].size;`);
  check('smaller makes small writing smaller, never larger', smaller === smallSize - 0.5, [smallSize, smaller]);
  await pressTool('برگرداندن آخرین تغییر').catch(() => {});
  await page.evaluate(`document.querySelector('#page [aria-label="برگرداندن آخرین تغییر"]').click(); await new Promise((r) => setTimeout(r, 300));`);

  /* ---------- A slow tap and a shaky tap are still taps ---------- */
  const tableTop = () => page.evaluate(`return JSON.stringify(window.__app.letter.offsets);`);
  const offsetsBefore = await tableTop();
  const slow = await wordCentre(CELL('3021120'), '3021120');
  await touch('touchStart', [[slow.x, slow.y]]);
  await page.sleep(500);
  await touch('touchEnd', []);
  await pause();
  state = await toolsState();
  check('a slow tap picks the cell too', state.picked === '3021120' && state.title === 'این خانه', state);
  check('and moves nothing', (await tableTop()) === offsetsBefore);
  const shaky = await wordCentre(CELL('9107'), '9107');
  await touch('touchStart', [[shaky.x, shaky.y]]);
  await page.sleep(60);
  await touch('touchMove', [[shaky.x + 3, shaky.y + 2]]);
  await page.sleep(40);
  await touch('touchEnd', []);
  await pause();
  state = await toolsState();
  check('a shaky tap picks the cell, and does not move the table', state.picked === '9107' && (await tableTop()) === offsetsBefore, state);

  /* ---------- Holding and dragging still moves the whole table ---------- */
  const held = await wordCentre(CELL('9102'), '9102');
  await page.drag(held.x, held.y, held.x, held.y + 30, { hold: 400, steps: 6 });
  await pause();
  check('holding and dragging moves the whole table', (await tableTop()) !== offsetsBefore, await tableTop());
  await page.evaluate(`document.querySelector('#page [aria-label="برگرداندن آخرین تغییر"]').click(); await new Promise((r) => setTimeout(r, 300));`);
  check('and that can be taken back', (await tableTop()) === offsetsBefore);

  /* ---------- One word in a cell of many ---------- */
  const many = CELL('اخلاق اسلامی');
  const beforeWord = await looks();
  await tapWord(many, 'اسلامی');
  state = await toolsState();
  check('a first tap picks the cell', state.picked?.includes('اخلاق اسلامی') && state.wordOn === 0, state);
  check('and says how to reach one word', !!state.hint?.includes('یک کلمه'), state.hint);
  await page.screenshot(join(out, 'look-3-many-words.png'));
  await tapWord(many, 'اسلامی');
  state = await toolsState();
  check('a second tap picks the word under the finger', state.title === 'کلمهٔ «اسلامی»' && state.wordOn > 0, state);
  await pressTool('بزرگ‌تر');
  await pressTool('بزرگ‌تر');
  await pressTool('بزرگ‌تر');
  await chooseFont('B Titr');
  await page.screenshot(join(out, 'look-4-one-word.png'));
  now = await looks();
  changed = changedCells(beforeWord, now);
  runs = await cellRuns('اخلاق');
  const texts = runs[0].runs.map((r) => r.text);
  const own = runs[0].runs.find((r) => r.text === 'اسلامی');
  const others = runs[0].runs.filter((r) => r.text !== 'اسلامی');
  check('the words stay as they were', texts.join('') === 'اخلاق اسلامی (مبانی و مفاهیم)', texts);
  check('that word alone gets the look', own?.font === 'B Titr' && own?.size > 6 && others.every((r) => r.font !== 'B Titr' && !(r.size > 6)), runs[0].runs);
  check('no other cell changes', changed.length === 1, changed);
  state = await toolsState();
  check('the tools show the look of the word', state.font === 'B Titr' && state.title === 'کلمهٔ «اسلامی»', state);
  const place = await page.evaluate(`
    const spans = [...(${many}).querySelectorAll('span')];
    return spans.map((s) => [s.textContent, parseFloat(getComputedStyle(s).fontSize), getComputedStyle(s).fontFamily.split(',')[0]]);
  `);
  check('the page shows that word bigger and the rest as they were', place.find((s) => s[0] === 'اسلامی')?.[1] > Math.max(...place.filter((s) => s[0] !== 'اسلامی').map((s) => s[1])), place);
  await tapWord(many, 'اسلامی');
  state = await toolsState();
  check('a tap on the same word goes back to the whole cell', state.wordOn === 0 && state.title === 'این خانه', state);
  await tapWord(many, 'مفاهیم');
  state = await toolsState();
  check('a tap on another word picks that one', (state.title || '').includes('مفاهیم'), state);
  await pressButton('کل این خانه');
  state = await toolsState();
  check('and a button also goes back to the whole cell', state.wordOn === 0 && state.title === 'این خانه', state);

  /* ---------- One word of a frame ---------- */
  const frame = `[...document.querySelectorAll('#page .obj-text')].find((f) => f.textContent.includes('دانشگاه نمونه'))`;
  const beforeFrame = await looks();
  const frameStyle = () => page.evaluate(`return window.__app.letter.objects.find((o) => o.text?.includes('دانشگاه نمونه'));`);
  const frameBefore = await frameStyle();
  await tapWord(frame, 'نمونه');
  state = await toolsState();
  check('a tap picks the frame', state.title === 'کادر متن', state);
  await tapWord(frame, 'نمونه');
  state = await toolsState();
  check('a second tap picks a word of the frame', state.title === 'کلمهٔ «نمونه»' && state.wordOn > 0, state);
  await pressTool('بزرگ‌تر');
  await chooseFont('B Lotus');
  await page.screenshot(join(out, 'look-5-frame-word.png'));
  let framed = await frameStyle();
  const frameWord = framed.lines?.[0]?.find((r) => r.text === 'نمونه');
  const frameRest = framed.lines?.[0]?.filter((r) => r.text !== 'نمونه');
  check('that word of the frame alone gets the look', frameWord?.font === 'B Lotus' && frameWord?.size === frameBefore.style.size + 1 && frameRest?.every((r) => !r.font && !r.size), framed.lines);
  check('the look of the rest of the frame stays', framed.style.size === frameBefore.style.size && framed.style.font === frameBefore.style.font, framed.style);
  check('the frame is otherwise as it was', framed.text === frameBefore.text && changedCells(beforeFrame, await looks()).length === 0);
  await pressButton('کل این کادر');
  await pressTool('کوچک‌تر');
  framed = await frameStyle();
  check('a size for the whole frame reaches all of its words', framed.style.size === frameBefore.style.size - 1 && framed.lines[0].every((r) => !r.size), framed);

  /* ---------- One word of a paragraph ---------- */
  const paragraph = `[...document.querySelectorAll('#page .blk.p')].find((p) => p.textContent.includes('این کارنامه'))`;
  await tapWord(paragraph, 'کارنامه');
  state = await toolsState();
  check('a tap picks the paragraph', (state.title || '').startsWith('بند') && state.wholeOn > 0, state);
  await tapWord(paragraph, 'کارنامه');
  state = await toolsState();
  check('a second tap picks a word of the paragraph', state.title === 'کلمهٔ «کارنامه»', state);
  await pressTool('بزرگ‌تر');
  await page.screenshot(join(out, 'look-6-paragraph-word.png'));
  const paragraphRuns = await page.evaluate(`return window.__app.letter.body.find((b) => b.kind === 'p' && b.runs?.some((r) => r.text.includes('این'))).runs;`);
  check('that word of the paragraph alone gets the look', paragraphRuns.length === 3 && paragraphRuns[1].text === 'کارنامه' && paragraphRuns[1].size > 0 && !paragraphRuns[0].size && !paragraphRuns[2].size, paragraphRuns);

  /* ---------- The whole table, when that is what is wanted ---------- */
  const beforeAll = await looks();
  await tapWord(CELL('3021116'), '3021116');
  await pressButton('همهٔ جدول');
  state = await toolsState();
  check('a button selects the whole table', state.wholeOn > 0 && !state.picked, state);
  await pressTool('بزرگ‌تر');
  await page.screenshot(join(out, 'look-7-whole-table.png'));
  now = await looks();
  changed = changedCells(beforeAll, now);
  const inThisTable = changed.filter((k) => k.startsWith('1:'));
  check('then a change reaches all of that table', inThisTable.length > 20, inThisTable.length);
  check('and no other table', inThisTable.length === changed.length, changed.filter((k) => !k.startsWith('1:')).slice(0, 3));
  await pressButton('همهٔ جدول');
  await tapWord(CELL('3021116'), '3021116');
  state = await toolsState();
  check('turned off, a tap picks one cell again', state.picked === '3021116' && state.wholeOn === 0, state);
  await page.evaluate(`document.querySelector('#page [aria-label="برگرداندن آخرین تغییر"]').click(); await new Promise((r) => setTimeout(r, 300));`);
  now = await looks();
  check('and a step back takes the whole-table change away', changedCells(beforeAll, now).length === 0);

  /* ---------- Alignment of one cell ---------- */
  const beforeAlign = await looks();
  await tapWord(CELL('3021120'), '3021120');
  await pressTool('چپ');
  changed = changedCells(beforeAlign, await looks());
  runs = await cellRuns('3021120');
  check('alignment reaches that cell alone', changed.length === 1 && runs[0].align === 'left', { changed, align: runs[0].align });

  /* ---------- The form screen keeps every look ---------- */
  const same = await page.evaluate(`
    const { blocksToHtml, serializeEditor } = await import('${WEB}/editor.js');
    const L = window.__app.letter;
    const holder = document.createElement('div');
    holder.innerHTML = blocksToHtml(L.body);
    const again = serializeEditor(holder);
    const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
    return JSON.stringify(canon(L.body)) === JSON.stringify(canon(again));
  `);
  check('going through the form screen loses no look', same);

  /* ---------- Out to Word, and back ---------- */
  const word = await page.evaluate(`
    const { makeDocx } = await import('${WEB}/export.js');
    const { importDocx } = await import('${WEB}/import-docx.js');
    const { bytesToBase64 } = await import('${WEB}/util.js');
    const made = await makeDocx(window.__app.letter, { deliver: false });
    const L = await importDocx(made.bytes, window.__app.settings);
    const all = L.body.filter((b) => b.kind === 'table').flatMap((t) => t.rows.flat());
    const find = (w) => all.find((c) => c.paras.some((p) => p.runs.map((r) => r.text).join('').includes(w)))?.paras[0];
    const st = L.styles.table;
    const lookOf = (run) => ({ text: run.text, font: run.font || st.font, size: run.size || st.size, b: run.b ?? st.bold });
    const frame = L.objects.find((o) => o.text?.includes('دانشگاه نمونه'));
    const paragraph = L.body.find((b) => b.kind === 'p' && b.runs?.some((r) => r.text.includes('این')));
    return {
      docx: bytesToBase64(made.bytes),
      many: find('اخلاق').runs.map(lookOf),
      single: find('سیستم‌عامل').runs.map(lookOf),
      frame: frame?.lines,
      frameStyle: frame?.style,
      paragraph: paragraph?.runs,
    };
  `);
  writeFileSync(join(out, 'look-export.docx'), Buffer.from(word.docx, 'base64'));
  const wordOwn = word.many.find((r) => r.text === 'اسلامی');
  check('in Word too that word alone has the look', wordOwn?.font === 'B Titr' && wordOwn?.size === own.size && word.many.filter((r) => r.text !== 'اسلامی').every((r) => r.font !== 'B Titr' && r.size < own.size), word.many);
  const singleRun = word.single[0];
  check('and that cell alone', singleRun.font === 'B Nazanin' && singleRun.size > 6, word.single);
  const frameInWord = word.frame?.[0]?.find((r) => r.text === 'نمونه');
  check('and that word of the frame', frameInWord?.font === 'B Lotus', { lines: word.frame, style: word.frameStyle });
  check('and that word of the paragraph', word.paragraph?.some((r) => r.text === 'کارنامه' && r.size > 0), word.paragraph);

  /* ---------- Saved, closed, opened again ---------- */
  const reopened = await page.evaluate(`
    for (let i = 0; i < 4 && window.__app.stack.at(-1) !== 'home'; i++) {
      window.__onBack();
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 900));
    document.querySelector('#home .letter-row').click();
    await new Promise((r) => setTimeout(r, 900));
    const spans = [...(${many}).querySelectorAll('span')].map((s) => [s.textContent, parseFloat(getComputedStyle(s).fontSize)]);
    const frameEl = [...document.querySelectorAll('#page .obj-text')].find((f) => f.textContent.includes('دانشگاه نمونه'));
    return { screen: window.__app.stack.at(-1), spans, frameSpans: [...frameEl.querySelectorAll('span')].map((s) => s.textContent) };
  `);
  check('saved and opened again, every look comes back', reopened.screen === 'page' && reopened.spans.length === 3 && reopened.frameSpans.includes('نمونه'), reopened);

  /* ---------- A table of an ordinary letter works the same ---------- */
  const letter = await page.evaluate(`
    const { sampleLetter } = await import('/tools/sample-letter.js');
    const { showScreen, backToHome } = await import('${WEB}/app.js');
    backToHome();
    const L = sampleLetter({});
    const table = L.body.find((b) => b.kind === 'table');
    window.__app.letter = L;
    showScreen('compose', { fresh: false });
    showScreen('page');
    await new Promise((r) => setTimeout(r, 900));
    return { text: table.rows[1][0].paras[0].runs[0].text, rows: table.rows.length };
  `);
  await page.sleep(300);
  const ordinary = await page.evaluate(`
    const td = [...document.querySelectorAll('#page .page td')].find((c) => c.dataset.r === '1' && c.dataset.c === '0');
    td.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 200));
    const r = td.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  const beforeOrdinary = await looks();
  await page.tap(ordinary.x, ordinary.y);
  await pause();
  await pressTool('بزرگ‌تر');
  changed = changedCells(beforeOrdinary, await looks());
  check('in an ordinary letter too a tap on a table reaches one cell', changed.length === 1 && changed[0] === '0:1:0', changed);

  /* ---------- A table cut over two pages still knows its cells ---------- */
  const cut = await page.evaluate(`
    const { layoutLetter } = await import('${WEB}/render.js');
    const { sampleLetter } = await import('/tools/sample-letter.js');
    const L = sampleLetter({});
    const cell = (text) => ({ paras: [{ runs: [{ text }] }] });
    L.body = [{ kind: 'table', header: true, rows: Array.from({ length: 90 }, (_, r) => [cell('ردیف ' + r), cell('متن ' + r)]) }];
    const info = layoutLetter(L, { preview: true });
    const second = info.pages[1];
    const rows = [...second.querySelectorAll('tr')].map((tr) => tr.cells[0]);
    return { pages: info.pages.length, first: rows[0].textContent, firstR: rows[0].dataset.r, next: rows[1].textContent, nextR: rows[1].dataset.r };
  `);
  const persian = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  check('a table cut over two pages still knows which row is which', cut.pages >= 2 && cut.firstR === '0' && cut.next === `ردیف ${persian(cut.nextR)}` && Number(cut.nextR) > 5, cut);

  if (page.errors.length) console.log('script errors:', page.errors);
  check('no script errors', page.errors.length === 0);
} catch (err) {
  console.log('FAIL the run stopped:', err.message);
  failed++;
} finally {
  await page.close();
}

console.log(failed ? `${failed} checks failed` : 'all look checks passed');
process.exit(failed ? 1 : 0);
