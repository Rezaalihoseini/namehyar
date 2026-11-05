// Drives the real app in a phone-sized Chrome with touch input and checks what the user asked for.
//   node tools/ui-test.js <out-folder>      (needs the preview server on port 8770)
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openPhone } from './cdp.js';

const out = resolve(process.argv[2] || 'ui-test-out');
mkdirSync(out, { recursive: true });
const URL_APP = 'http://127.0.0.1:8770/app/src/main/assets/web/index.html';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? `: ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed++;
}

const page = await openPhone();
const shot = (name) => page.screenshot(join(out, `${name}.png`));
const L = (path) => page.evaluate(`return window.__app.letter.${path};`);
const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;

try {
  await page.goto(URL_APP);
  await page.sleep(1200);

  /* ---------- Theme and icons ---------- */
  // The first synthetic touch after a page load can be dropped by the emulator.
  await page.tap(180, 700);
  await page.sleep(700);
  // The theme starts from the system's setting, so these checks only look at the change.
  const theme = () => page.evaluate('return document.documentElement.dataset.theme;');
  const startTheme = await theme();
  await shot('01-home-start');
  await page.tapOn('#home [aria-label="حالت تیره یا روشن"]');
  const flipped = await theme();
  check('moon button flips the theme', flipped !== startTheme, { startTheme, flipped });
  check('it stayed on the home screen', (await page.evaluate('return window.__app.stack.length;')) === 1);
  await shot('02-home-flipped');
  await page.tapOn('#home [aria-label="تنظیمات"]');
  check('gear opens settings', (await page.evaluate('return window.__app.stack.at(-1);')) === 'settings');
  await shot('03-settings');
  await page.evaluate('window.__onBack();');
  await page.tapOn('#home [aria-label="حالت تیره یا روشن"]');
  check('tapping again flips it back', (await theme()) === startTheme);

  /* ---------- A new letter and the phrase panel ---------- */
  await page.evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__wait = wait;
    [...document.querySelectorAll('#home button')].find((b) => b.textContent.includes('نامهٔ جدید')).click();
    await wait(300);
    [...document.querySelectorAll('#compose .chip')].find((b) => b.textContent.includes('گیرنده')).click();
    await wait(150);
    const sheet = document.querySelector('.sheet');
    const inputs = sheet.querySelectorAll('input.input');
    inputs[0].value = 'جناب آقای احمد کرمی';
    inputs[1].value = 'مدیرکل محترم ادارهٔ نمونه';
    [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'تأیید').click();
    await wait(200);
    [...document.querySelectorAll('#compose .chip')].find((b) => b.textContent === 'درخواست').click();
    await wait(200);
    const subject = document.querySelector('#compose input[placeholder*="موضوع"]');
    subject.value = 'برگزاری نمایشگاه فناوری';
    subject.dispatchEvent(new Event('input'));
    subject.dispatchEvent(new Event('change'));
    document.querySelector('.editor').focus();
    await wait(200);
    [...document.querySelectorAll('.fmtbar .btn')].find((b) => b.textContent.includes('عبارت')).click();
    await wait(150);
  `);
  const panel = await page.evaluate(`const p = document.querySelector('.panel'); return { text: p.innerText, phrases: p.querySelectorAll('.phrase').length };`);
  check('phrase panel shows no [object ...] text', !panel.text.includes('[object') && !panel.text.includes('null'));
  check('phrase panel lists phrases', panel.phrases > 3, panel.phrases);
  await shot('04-phrases');
  await page.evaluate(`document.querySelector('.editor').blur(); await window.__wait(120);`);

  /* ---------- Page screen: the letterhead moves with a finger ---------- */
  await page.evaluate(`
    [...document.querySelectorAll('#compose .bottombar .btn')].find((b) => b.textContent.includes('چیدمان')).click();
    await window.__wait(500);
  `);
  await shot('05-page');
  const invocation = await page.evaluate(`
    const part = document.querySelector('#page [data-part="invocation"]');
    const pageEl = part.closest('.page');
    const range = document.createRange();
    range.selectNodeContents(part);
    const ink = range.getBoundingClientRect();
    const box = pageEl.getBoundingClientRect();
    return { inkCentre: (ink.left + ink.right) / 2 - box.left, pageCentre: box.width / 2 };
  `);
  check('«بسمه تعالی» sits on the exact centre of the page', near(invocation.inkCentre, invocation.pageCentre), invocation);
  const scrolls = await page.evaluate(`const s = document.querySelector('.stage'); return { h: s.scrollHeight, c: s.clientHeight };`);
  console.log('stage', scrolls);

  const a = await page.centre('#page [data-part="invocation"]');
  await page.drag(a.x, a.y, a.x + 60, a.y + 40);
  let moved = await L('letterhead.parts.invocation');
  check('dragging «بسمه تعالی» moves it', !!moved && moved.x > 75 + 5 && moved.y > 10 + 5, moved);
  await shot('06-invocation-moved');

  for (const part of ['org', 'number', 'date', 'attachment']) {
    const c = await page.centre(`#page [data-part="${part}"]`);
    await page.drag(c.x, c.y, c.x - 12, c.y + 25);
    const p = await L(`letterhead.parts.${part}`);
    check(`dragging ${part} moves it`, !!p && p.y !== undefined, p);
  }

  /* ---------- Undo ---------- */
  const before = await L('letterhead.parts.attachment');
  await page.tapOn('#page [aria-label="برگرداندن آخرین تغییر"]');
  const after = await L('letterhead.parts.attachment');
  check('undo takes the last move back', before && !after, { before, after });

  /* ---------- The letter's own sections ---------- */
  const r = await page.centre('#page [data-section="recipient"]');
  const topBefore = await page.evaluate(`return document.querySelector('#page [data-section="subject"]').getBoundingClientRect().top;`);
  await page.drag(r.x, r.y, r.x - 30, r.y + 30);
  const offset = await L('offsets.recipient');
  check('dragging the recipient moves it', !!offset && offset.dy > 2 && offset.dx < -2, offset);
  const topAfter = await page.evaluate(`return document.querySelector('#page [data-section="subject"]').getBoundingClientRect().top;`);
  check('the text below follows it', topAfter > topBefore + 10, { topBefore, topAfter });

  const s = await page.centre('#page [data-section="subject"]');
  await page.drag(s.x, s.y, s.x, s.y + 12);
  check('dragging the subject moves it', (await L('offsets.subject'))?.dy > 1, await L('offsets.subject'));

  const b = await page.centre('#page [data-section="body:0"]');
  await page.tap(b.x, b.y);
  const selection = await page.evaluate(`return { on: document.querySelectorAll('#page .sel-on').length, title: document.querySelector('.tools .hint.grow')?.textContent };`);
  check('tapping a paragraph selects only that paragraph', selection.on === 1 && selection.title.startsWith('بند ۱'), selection);
  await shot('07-body-selected');

  /* ---------- Each paragraph on its own ---------- */
  // Select before dragging: an unselected touch on a scrollable page scrolls it.
  await page.tapOn('#page [data-section="body:1"]');
  const second = await page.centre('#page [data-section="body:1"]');
  const firstTop = await page.evaluate(`return document.querySelector('#page [data-section="body:0"]').getBoundingClientRect().top;`);
  await page.drag(second.x, second.y, second.x, second.y + 25);
  const secondMove = await L('body[1].move');
  check('dragging one paragraph moves that paragraph', secondMove?.dy > 3, secondMove);
  check('the paragraph above it stays', Math.abs((await page.evaluate(`return document.querySelector('#page [data-section="body:0"]').getBoundingClientRect().top;`)) - firstTop) < 1);
  check('its place is kept in the form text too', /data-dy=/.test(await L('bodyHtml')));
  const split = await page.evaluate(`
    const { serializeEditor, setEditorHtml, cleanupCopies } = await import('/app/src/main/assets/web/js/editor.js');
    const holder = document.createElement('div');
    setEditorHtml(holder, window.__app.letter.bodyHtml);
    const moved = holder.children[1];
    moved.after(moved.cloneNode(true));
    const read = serializeEditor(holder);
    cleanupCopies(holder);
    return { first: read[1].move, copy: read[2].move, cleaned: holder.children[2].dataset.dy };
  `);
  check('pressing Enter in a moved paragraph does not copy its place', split.first?.dy > 3 && !split.copy && split.cleaned === undefined, split);
  await page.evaluate(`window.__onBack(); await window.__wait(100);`);

  /* ---------- Free move ---------- */
  const sub = await page.centre('#page [data-section="greeting"]');
  await page.tap(sub.x, sub.y);
  const beforeArrow = await page.evaluate(`return document.querySelector('#page [data-section="greeting"]').getBoundingClientRect().top;`);
  await page.tapOn('.tools [aria-label="جابه‌جایی به بالا"]');
  const toastText = await page.evaluate(`return document.querySelector('#toast')?.textContent;`);
  check('with free move off, the up arrow says why it cannot go higher', toastText.includes('حرکت آزاد'), toastText);
  await page.tapOn('.tools .free-row');
  check('the switch turns free move on', await page.evaluate(`return document.querySelector('.free-row').classList.contains('on');`));
  await shot('10-free-on');
  await page.tapOn('.tools [aria-label="جابه‌جایی به بالا"]');
  const afterArrow = await page.evaluate(`return document.querySelector('#page [data-section="greeting"]').getBoundingClientRect().top;`);
  check('with free move on, the up arrow moves it', afterArrow < beforeArrow - 1, { beforeArrow, afterArrow });
  await page.tapOn('.tools [aria-label="جابه‌جایی به چپ"]');
  check('and the side arrows too', (await L('offsets.greeting.dx')) < 0, await L('offsets.greeting'));

  const para = await page.centre('#page [data-section="body:0"]');
  const others = () => page.evaluate(`return ['recipient', 'subject', 'closing'].map((id) => Math.round(document.querySelector('#page [data-section="' + id + '"]').getBoundingClientRect().top));`);
  const othersBefore = await others();
  await page.evaluate(`window.__onBack(); await window.__wait(80);`);
  await page.drag(para.x, para.y, para.x, para.y - 90);
  const freeMove = await L('body[0].move');
  check('free move takes a paragraph up over the text above it', freeMove?.fy < -15, freeMove);
  check('and nothing else on the page moves', JSON.stringify(othersBefore) === JSON.stringify(await others()), { othersBefore, now: await others() });
  await shot('11-free-moved');
  await page.evaluate(`window.__onBack(); await window.__wait(80);`);
  await page.tapOn('.tools .free-row');
  const stays = await L('body[0].move');
  check('turning free move off leaves it where it is', stays?.fy === freeMove.fy, stays);
  for (const id of ['greeting', 'body:0']) {
    const c = await page.centre(`#page [data-section="${id}"]`);
    await page.tap(c.x, c.y);
    await page.tapOn('.tools [aria-label="بازگشت به جای اول"]');
    await page.evaluate(`window.__onBack(); await window.__wait(80);`);
  }
  check('«back to its place» undoes a free move', !(await L('body[0].move')));

  /* ---------- All paragraphs together ---------- */
  const third = await page.centre('#page [data-section="body:1"]');
  await page.tap(third.x, third.y);
  await page.evaluate(`[...document.querySelectorAll('.tools .btn')].find((x) => x.textContent === 'همهٔ بندها').click(); await window.__wait(100);`);
  const allOn = await page.evaluate(`return document.querySelectorAll('#page .sel-on').length;`);
  check('«all paragraphs» selects the whole body', allOn >= 2, allOn);
  await page.evaluate(`[...document.querySelectorAll('.tools .btn')].find((x) => x.textContent === 'همهٔ بندها').click(); await window.__wait(100);`);

  /* ---------- Font on a letterhead part ---------- */
  const inv = await page.centre('#page [data-part="invocation"]');
  await page.tap(inv.x, inv.y);
  const hint = await page.evaluate(`return document.querySelector('.tools .hint')?.textContent;`);
  check('tapping a letterhead part selects it', hint === 'عبارت بالای نامه', hint);
  await shot('08-part-selected');
  const size0 = await page.evaluate(`return document.querySelector('#page [data-part="invocation"]').style.fontSize;`);
  await page.tapOn('.tools [aria-label="بزرگ‌تر"]');
  const size1 = await page.evaluate(`return document.querySelector('#page [data-part="invocation"]').style.fontSize;`);
  check('size button changes the part', size0 !== size1, { size0, size1 });

  /* ---------- Hide and bring back ---------- */
  await page.tapOn('.tools [aria-label="پنهان کردن"]');
  check('a part can be hidden', (await page.evaluate(`return !document.querySelector('#page [data-part="invocation"]');`)));
  await page.evaluate(`[...document.querySelectorAll('.tools .btn')].find((x) => x.textContent.includes('پنهان')).click(); await window.__wait(100); document.querySelector('.sheet .btn').click(); await window.__wait(100);`);
  check('and brought back', await page.evaluate(`return !!document.querySelector('#page [data-part="invocation"]');`));

  /* ---------- A free text frame ---------- */
  await page.evaluate(`
    if (document.querySelector('.sheet-wrap')) window.__onBack();
    [...document.querySelectorAll('.tools .btn')].find((x) => x.textContent.includes('کادر متن')).click();
    await window.__wait(150);
    const box = document.querySelector('.sheet textarea');
    box.value = 'کادر آزمایشی';
    [...document.querySelectorAll('.sheet button')].find((x) => x.textContent === 'تأیید').click();
    await window.__wait(150);
  `);
  check('a text frame appears on the page', (await page.evaluate(`return document.querySelector('#page .obj-text')?.textContent;`)) === 'کادر آزمایشی');
  await shot('09-text-frame');

  /* ---------- Export still works ---------- */
  await page.evaluate(`window.__onBack(); await window.__wait(100);`);
  const docx = await page.evaluate(`
    const { makeDocx } = await import('/app/src/main/assets/web/js/export.js');
    const made = await makeDocx(window.__app.letter, { deliver: false });
    return { size: made.bytes.length, name: made.name };
  `);
  check('Word file is built from the moved letter', docx.size > 3000, docx);

  /* ---------- A long letter: one finger scrolls, holding picks a part up ---------- */
  await page.evaluate(`
    const app = window.__app;
    const para = { kind: 'p', runs: [{ text: 'به استحضار می‌رساند '.repeat(60) }] };
    app.letter.body = Array.from({ length: 8 }, () => para);
    app.letter.bodyHtml = app.letter.body.map((p) => '<p>' + p.runs[0].text + '</p>').join('');
    window.__onBack();
    await window.__wait(200);
    [...document.querySelectorAll('#compose .bottombar .btn')].find((b) => b.textContent.includes('چیدمان')).click();
    await window.__wait(500);
  `);
  const pages = await page.evaluate(`return document.querySelectorAll('.page-box').length;`);
  check('long letter runs over more than one page', pages > 1, pages);
  const num0 = await L('letterhead.parts.number');
  const c = await page.centre('#page [data-part="number"]');
  await page.drag(c.x, c.y, c.x, c.y + 30, { hold: 350 });
  const num1 = await L('letterhead.parts.number');
  check('holding a part picks it up on a long letter', JSON.stringify(num0) !== JSON.stringify(num1), { num0, num1 });
  const scrollBefore = await page.evaluate(`return document.querySelector('.stage').scrollTop;`);
  const num2 = await L('letterhead.parts.date');
  const d = await page.centre('#page [data-part="date"]');
  await page.drag(d.x, d.y, d.x, d.y - 120);
  check('a quick swipe on a part does not move it', JSON.stringify(num2) === JSON.stringify(await L('letterhead.parts.date')));
  console.log('stage scrolled by', (await page.evaluate(`return document.querySelector('.stage').scrollTop;`)) - scrollBefore);

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
