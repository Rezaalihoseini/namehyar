// A PDF laid out by hand, on paper that is not A4. It comes in looking as it did, line by line and word by word, stays editable,
// and goes out at the size it came in, to the page, to PDF and to Word, and back from Word again.
//   node tools/ui-test-exact.js <out-folder>      (needs the preview server on port 8770)
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

const page = await openPhone({ port: 9378 });
try {
  await page.goto('http://127.0.0.1:8770/tools/exact-sample.html');
  await page.sleep(1200);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const printed = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  writeFileSync(join(out, 'exact-sample.pdf'), Buffer.from(printed.data, 'base64'));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });

  await page.goto(APP);
  await page.sleep(1000);
  await page.evaluate(`
    const { openLetterFile } = await import('${WEB}/screens/home.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(printed.data)}), (c) => c.charCodeAt(0));
    await openLetterFile(bytes, 'exact-sample.pdf');
    await new Promise((r) => setTimeout(r, 700));
  `);

  /* ---------- What it read ---------- */
  const shape = await page.evaluate(`
    const L = window.__app.letter;
    const frames = L.objects.filter((o) => o.kind === 'text');
    const pictures = L.objects.filter((o) => o.kind !== 'text');
    const pageEl = document.querySelector('#page .page');
    const r = pageEl.getBoundingClientRect();
    return {
      screen: window.__app.stack.at(-1),
      exact: L.importInfo.exact, form: L.importInfo.form, autoFix: L.autoFix, paper: L.page, bodyPages: L.body.length, shownPages: document.querySelectorAll('#page .page').length,
      cssW: pageEl.style.width, cssH: pageEl.style.height,
      texts: frames.map((o) => o.text), frames: frames.length, inked: frames.filter((o) => o.ink).length, pages: [...new Set(frames.map((o) => o.page))],
      behind: pictures.filter((o) => o.behind).length, cut: pictures.filter((o) => !o.behind).length,
      svgs: document.querySelectorAll('#page .ink').length, fonts: Object.keys(L.ink.fonts).length,
      jsonKb: Math.round(JSON.stringify(L).length / 1024),
    };
  `);
  check('it opens on the page as an exact page', shape.screen === 'page' && shape.exact && shape.form && shape.autoFix === false, shape.screen);
  check('the paper is the size of the PDF, not A4', Math.abs(shape.paper?.w - 240) < 0.6 && Math.abs(shape.paper?.h - 170) < 0.6, shape.paper);
  check('and the page on screen is too', parseFloat(shape.cssW) === shape.paper.w && parseFloat(shape.cssH) === shape.paper.h, [shape.cssW, shape.cssH]);
  check('two pages stay two pages', shape.bodyPages === 2 && shape.shownPages === 2 && shape.pages.length === 2, [shape.bodyPages, shape.shownPages, shape.pages]);
  check('every line is a frame drawn in the file\'s own letters', shape.frames > 5 && shape.inked === shape.frames && shape.svgs === shape.frames, [shape.frames, shape.inked, shape.svgs]);
  check('each page has its picture behind', shape.behind === 2, shape.behind);
  check('the photo is cut out on its own', shape.cut === 1, shape.cut);
  const joined = shape.texts.join('\n');
  check('words read in the right order', joined.includes('عنوان نمونه‌ای برای صفحهٔ دقیق') || joined.includes('عنوان نمونه‌ای برای صفحه'), shape.texts[0]);
  check('half-spaces are kept', /می‌شود|نیم‌فاصله/.test(joined));
  check('a date reads as written', joined.includes('۱۴۰۵/۰۷/۲۱'), joined.match(/[۰-۹/]{6,}/)?.[0]);
  check('brackets read the right way round', /\(داخل/.test(joined) || /پرانتز\)/.test(joined), joined.match(/.{0,6}پرانتز.{0,3}/)?.[0]);
  check('a line of Latin keeps its order', joined.includes('www.example.com - page 1'), shape.texts.find((t) => /example/.test(t)));
  check('Latin inside a Persian column keeps its order', /Latin words|words stay/.test(joined));
  check('the columns are not mixed', !shape.texts.some((t) => /سطرهایش|ستون بلند/.test(t) && /قاطی|انتخاب/.test(t)));
  check('a turned line stays part of the drawing', !joined.includes('کج'));
  check('see-through words stay part of the drawing', !joined.includes('کم‌رنگ'));
  check('words covered by a box stay covered', !joined.includes('پنهان'));
  check('words under a faint veil stay editable', joined.includes('متن زیر پرده'));

  /* ---------- A finger on the page ---------- */
  const frameBox = (needle) => page.evaluate(`
    const L = window.__app.letter;
    const o = L.objects.find((x) => x.kind === 'text' && x.text.includes(${JSON.stringify(needle)}));
    const el = document.querySelector('#page .obj[data-id="' + o.id + '"]');
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { id: o.id, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, inked: el.classList.contains('obj-inked'), ox: o.x, oy: o.y };
  `);
  const selection = () => page.evaluate(`return { box: document.querySelectorAll('#page .sel-box').length, word: document.querySelectorAll('#page .sel-word').length };`);
  await page.sleep(100);

  // Zoomed, so a word is big enough to hit.
  await page.evaluate(`for (let i = 0; i < 6; i++) document.querySelector('#page [aria-label="بزرگ‌نمایی"]').click();`);
  await page.sleep(200);
  let f = await frameBox('پاراگراف');

  // A finger crossing the page scrolls it and moves nothing.
  const before = await page.evaluate(`return document.querySelector('#page .stage').scrollTop;`);
  await page.drag(180, f.y + 60, 180, f.y - 90);
  await page.sleep(250);
  const scrolled = await page.evaluate(`return document.querySelector('#page .stage').scrollTop;`);
  const after = await frameBox('پاراگراف');
  check('a finger crossing a line scrolls the page', scrolled !== before, [before, scrolled]);
  check('and leaves the line where it is', after.ox === f.ox && after.oy === f.oy);
  f = after;

  await page.tap(f.x, f.y);
  await page.sleep(150);
  let s = await selection();
  check('a tap selects the line', s.box === 1, s);
  await page.sleep(450);
  await page.tap(f.x, f.y);
  await page.sleep(150);
  s = await selection();
  check('a second tap picks the word under the finger', s.word >= 1, s);
  const wordRect = await page.evaluate(`
    const w = document.querySelector('#page .sel-word').getBoundingClientRect();
    const o = document.querySelector('#page .obj[data-id="${f.id}"]').getBoundingClientRect();
    return { inside: w.left >= o.left - 2 && w.right <= o.right + 2 && w.width > 2 && w.width < o.width, w: w.width, o: o.width, top: w.top - o.top };
  `);
  check('the word\'s mark stands on the word, inside its line', wordRect.inside, wordRect);

  /* ---------- Changing a word: the file's own drawing gives way to real text, and comes back ---------- */
  const inkState = () => page.evaluate(`
    const L = window.__app.letter;
    const o = L.objects.find((x) => x.id === '${f.id}');
    const el = document.querySelector('#page .obj[data-id="${f.id}"]');
    return { inked: el.classList.contains('obj-inked'), fills: [...new Set([...el.querySelectorAll('.ink text')].map((t) => t.getAttribute('fill')))], text: el.textContent.length, orig: !!o.orig, lines: o.lines?.[0]?.length, y: o.y, line: o.style.line };
  `);
  await page.evaluate(`
    const b = document.querySelector('#page [aria-label="رنگ متن"]');
    b.click();
  `);
  await page.sleep(200);
  await page.evaluate(`
    const swatches = [...document.querySelectorAll('.sheet .swatch, .sheet [data-color]')];
    const red = swatches.find((b) => /C00000|c00000/.test(b.dataset.color || b.title || b.getAttribute('aria-label') || b.style.background)) || swatches[3];
    red.click();
  `);
  await page.sleep(300);
  let ink = await inkState();
  check('a colour keeps the drawing and colours it', ink.inked && ink.fills.length >= 2, ink);
  await page.evaluate(`document.querySelector('#page [aria-label="برگرداندن آخرین تغییر"]').click();`);
  await page.sleep(300);
  ink = await inkState();
  check('undo takes the colour back', ink.inked && ink.fills.length === 1, ink);

  const firstY = ink.y;
  const firstLine = ink.line;
  await page.evaluate(`
    const L = window.__app.letter;
    const o = L.objects.find((x) => x.id === '${f.id}');
    const el = document.querySelector('#page .obj[data-id="${f.id}"]');
    const r = el.getBoundingClientRect();
    return 1;
  `);
  await page.tap(f.x, f.y);
  await page.sleep(500);
  await page.evaluate(`document.querySelector('#page [aria-label="بزرگ‌تر"]').click();`);
  await page.sleep(300);
  ink = await inkState();
  check('a bigger size writes the line as text', !ink.inked && ink.orig, ink);
  await page.evaluate(`document.querySelector('#page [aria-label="کوچک‌تر"]').click();`);
  await page.sleep(300);
  ink = await inkState();
  check('and back at its size the file\'s own drawing returns', ink.inked, ink);
  check('with the line exactly where it was', Math.abs(ink.y - firstY) < 0.001 && ink.line === firstLine, [ink.y, firstY, ink.line, firstLine]);

  /* ---------- A move ---------- */
  const moved = await page.evaluate(`
    const L = window.__app.letter;
    const o = L.objects.find((x) => x.id === '${f.id}');
    const el = document.querySelector('#page .obj[data-id="${f.id}"]');
    const svg = el.querySelector('.ink').getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { dx: svg.left - box.left, dy: svg.top - box.top };
  `);
  check('the drawing starts from its frame, so it moves with it', Math.abs(moved.dy) < 2, moved);

  /* ---------- Between screens ---------- */
  const screens = await page.evaluate(`
    const { goBack, showScreen } = await import('${WEB}/app.js');
    // The first step back only lets go of what is selected.
    for (let i = 0; i < 3 && window.__app.stack.at(-1) !== 'compose'; i++) goBack();
    await new Promise((r) => setTimeout(r, 500));
    const compose = { screen: window.__app.stack.at(-1), form: document.querySelector('#compose')?.classList.contains('is-form'), inked: document.querySelectorAll('#compose .obj-inked').length };
    showScreen('page');
    await new Promise((r) => setTimeout(r, 500));
    return { compose, boxes: document.querySelectorAll('#page .page-box').length, inked: document.querySelectorAll('#page .obj-inked').length, shown: [...document.querySelectorAll('#page .page-box')].every((box) => box.firstChild.classList.contains('page') && box.getBoundingClientRect().width > 100) };
  `);
  check('the writing screen shows the page too', screens.compose.screen === 'compose' && screens.compose.form && screens.compose.inked > 0, screens.compose);
  check('and back on the page everything is there', screens.boxes === 2 && screens.inked === shape.frames && screens.shown, screens);
  await page.sleep(100);

  /* ---------- A small change touches only what changed ---------- */
  const kept = await page.evaluate(`
    const L = window.__app.letter;
    const others = [...document.querySelectorAll('#page .obj-inked')].filter((el) => el.dataset.id !== '${f.id}');
    const pageEl = document.querySelector('#page .page');
    window.__keep = { other: others[0], pageEl };
    return others.length;
  `);
  await page.evaluate(`document.querySelector('#page [aria-label="بزرگ‌نمایی"]').click();`);
  await page.tap(180, 300);
  await page.sleep(100);
  const untouched = await page.evaluate(`
    const { restyleFrame } = await import('${WEB}/restyle.js');
    const L = window.__app.letter;
    const o = L.objects.find((x) => x.id === '${f.id}');
    const before = document.querySelector('#page .obj[data-id="${f.id}"]');
    restyleFrame(o, { size: 14 });
    const { layoutLetter } = await import('${WEB}/render.js');
    layoutLetter(L, { preview: true });
    const after = document.querySelector('#page .obj[data-id="${f.id}"]');
    const same = { other: window.__keep.other.isConnected, page: window.__keep.pageEl.isConnected, changed: before !== after && !after.classList.contains('obj-inked') };
    const { resetFrame } = await import('${WEB}/restyle.js');
    resetFrame(o);
    layoutLetter(L, { preview: true });
    same.back = document.querySelector('#page .obj[data-id="${f.id}"]').classList.contains('obj-inked');
    return same;
  `);
  check('a change leaves the other lines and the page in place', untouched.other && untouched.page && untouched.changed && untouched.back, untouched);

  /* ---------- Editing the words ---------- */
  const edited = await page.evaluate(`
    const { replaceEverywhere } = await import('${WEB}/restyle.js');
    const { layoutLetter } = await import('${WEB}/render.js');
    const L = window.__app.letter;
    const count = replaceEverywhere(L, 'پاراگراف', 'بند');
    const o = L.objects.find((x) => x.id === '${f.id}');
    const { pages } = layoutLetter(L, { preview: true });
    const el = pages.flatMap((p) => [...p.querySelectorAll('.obj[data-id="${f.id}"]')])[0];
    const color = getComputedStyle(document.body).direction;
    return { count, text: o.text, inked: el.classList.contains('obj-inked'), shown: el.textContent, lines: el.children.length };
  `);
  check('find and replace reaches the frames', edited.count >= 1 && edited.text.includes('بند'), edited.count);
  check('a line with new words is written as text', !edited.inked && edited.shown.includes('بند'), edited.shown);
  await page.evaluate(`
    const { replaceEverywhere } = await import('${WEB}/restyle.js');
    replaceEverywhere(window.__app.letter, 'بند', 'پاراگراف');
  `);

  /* ---------- Out: Word ---------- */
  const docx = await page.evaluate(`
    const { makeDocx } = await import('${WEB}/export.js');
    const { readZip } = await import('${WEB}/unzip.js');
    const { bytesToBase64 } = await import('${WEB}/util.js');
    const made = await makeDocx(window.__app.letter, { deliver: false });
    window.__docxBytes = made.bytes;
    const zip = readZip(made.bytes);
    const text = (name) => new TextDecoder().decode(zip.get(name)());
    const xml = text('word/document.xml');
    const styles = text('word/styles.xml');
    const fonts = text('word/fontTable.xml');
    return {
      size: made.bytes.length, pgSz: xml.match(/<w:pgSz[^>]*>/)?.[0], boxes: (xml.match(/<wps:txbx>/g) || []).length, scaled: (xml.match(/<w:w /g) || []).length + (styles.match(/<w:w /g) || []).length,
      spaced: (xml.match(/<w:spacing w:val=/g) || []).length, breaks: (xml.match(/<w:pageBreakBefore\\/>/g) || []).length, behind: (xml.match(/behindDoc="1"/g) || []).length,
      styles: (styles.match(/w:styleId="Nh/g) || []).length, fontsListed: (fonts.match(/<w:font /g) || []).length, altNames: (fonts.match(/<w:altName /g) || []).length, b64: bytesToBase64(made.bytes),
    };
  `);
  writeFileSync(join(out, 'exact-sample.docx'), Buffer.from(docx.b64, 'base64'));
  const w = Number(docx.pgSz?.match(/w:w="(\d+)"/)?.[1]);
  const h = Number(docx.pgSz?.match(/w:h="(\d+)"/)?.[1]);
  check('Word\'s page has the size of the PDF', Math.abs(w / 56.6929 - 240) < 0.7 && Math.abs(h / 56.6929 - 170) < 0.7, docx.pgSz);
  check('and says it lies on its side', /landscape/.test(docx.pgSz), docx.pgSz);
  check('every line is a box of its own in Word', docx.boxes === shape.frames, [docx.boxes, shape.frames]);
  check('no letters are stretched, which breaks some fonts in Word', docx.scaled === 0, docx.scaled);
  check('words are held in place with spacing', docx.spaced > 5, docx.spaced);
  check('the pictures lie behind the text', docx.behind === 2, docx.behind);
  check('pages are kept with a page break', docx.breaks === 1, docx.breaks);
  check('fonts name their other names for Word', docx.fontsListed >= 1, [docx.fontsListed, docx.altNames]);
  check('looks are shared as styles', docx.styles >= 1 && docx.styles < shape.frames, docx.styles);

  /* ---------- Out: PDF, at the size it came in ---------- */
  const paper = await page.evaluate(`
    const { preparePrintRoot } = await import('${WEB}/export.js');
    const n = await preparePrintRoot(window.__app.letter);
    await document.fonts.ready;
    return { n, rule: document.querySelector('#print-paper')?.textContent, height: document.querySelector('#print-root .page').style.height, inked: document.querySelectorAll('#print-root .ink').length };
  `);
  check('the print paper is the PDF\'s size', (paper.rule || '').includes(`size: ${shape.paper.w}mm ${shape.paper.h}mm`), paper.rule);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const reprinted = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
  const again = Buffer.from(reprinted.data, 'base64');
  writeFileSync(join(out, 'exact-out.pdf'), again);
  const boxes = [...again.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const inPt = (mm) => (mm * 72) / 25.4;
  check('the PDF that comes out has as many pages', boxes.length === 2, boxes.length);
  check('at the same size, to within a point', boxes.every(([bw, bh]) => Math.abs(bw - inPt(240)) < 1 && Math.abs(bh - inPt(170)) < 1), boxes[0]);

  /* ---------- A letter of the ordinary kind stays A4 ---------- */
  const ordinary = await page.evaluate(`
    const { newLetter, PAGE, usePageSize } = await import('${WEB}/model.js');
    const L = newLetter(window.__app.settings);
    usePageSize(L);
    const a4 = [PAGE.w, PAGE.h];
    usePageSize(window.__app.letter);
    return { a4, page: L.page ?? null, back: [PAGE.w, PAGE.h] };
  `);
  check('a new letter is A4', ordinary.a4[0] === 210 && ordinary.a4[1] === 297 && ordinary.page === null, ordinary);

  /* ---------- Stored and opened again ---------- */
  const reopened = await page.evaluate(`
    const { getDoc } = await import('${WEB}/store.js');
    const { saveLetterNow } = await import('${WEB}/app.js');
    saveLetterNow(window.__app.letter);
    await new Promise((r) => setTimeout(r, 300));
    return window.__app.letter.id;
  `);
  await page.goto(APP);
  await page.sleep(1000);
  const stored = await page.evaluate(`
    const { getDoc, ensureMedia, mediaIdsOf } = await import('${WEB}/store.js');
    const { showScreen, app } = await import('${WEB}/app.js');
    for (let i = 0; i < 50 && !app.screens.page; i++) await new Promise((r) => setTimeout(r, 200));
    const L = await getDoc('letters', ${JSON.stringify(reopened)});
    const ids = mediaIdsOf(L);
    app.letter = L;
    showScreen('page');
    await new Promise((r) => setTimeout(r, 900));
    return { ids: ids.length, frames: document.querySelectorAll('#page .obj-exact').length, inked: document.querySelectorAll('#page .obj-inked').length, width: document.querySelector('#page .page').style.width, loaded: [...document.fonts].filter((face) => face.family.includes('ink-') && face.status === 'loaded').length };
  `);
  check('after closing the app it comes back drawn the same', stored.inked === shape.frames && stored.loaded === shape.fonts, stored);
  check('at its own size', parseFloat(stored.width) === shape.paper.w, stored.width);

  /* ---------- Its Word file opened again ---------- */
  const back = await page.evaluate(`
    const { importDocx } = await import('${WEB}/import-docx.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(docx.b64)}), (c) => c.charCodeAt(0));
    const L = await importDocx(bytes, window.__app.settings);
    const frames = L.objects.filter((o) => o.kind === 'text');
    return { exact: L.importInfo.exact, paper: L.page, bodyPages: L.body.length, frames: frames.length, pages: [...new Set(frames.map((o) => o.page))], pictures: L.objects.length - frames.length, behind: L.objects.filter((o) => o.behind).length, gaps: frames.filter((o) => o.gaps?.sp?.some(Boolean)).length, title: frames[0]?.text, line: frames[0]?.style.line, texts: frames.map((o) => o.text) };
  `);
  check('its Word file opens as the same pages', back.exact && back.bodyPages === 2 && back.pages.length === 2, [back.exact, back.bodyPages, back.pages]);
  check('at its size', Math.abs(back.paper?.w - 240) < 0.7 && Math.abs(back.paper?.h - 170) < 0.7, back.paper);
  check('with every line and picture', back.frames === shape.frames && back.pictures === shape.behind + shape.cut, [back.frames, back.pictures]);
  check('and the same words', back.texts.join('\n') === shape.texts.join('\n'), back.texts.find((t, i) => t !== shape.texts[i]));
  check('and what holds them in place', back.gaps > 0, back.gaps);

  check('no script errors', page.errors.length === 0, page.errors.slice(0, 5));
  console.log(failed ? `${failed} FAILED` : 'all exact checks passed');
  process.exitCode = failed ? 1 : 0;
} finally {
  await page.close();
}
