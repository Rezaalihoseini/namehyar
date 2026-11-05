// The home screen: everything on it goes where it says, with real touch, and its numbers come from the letters.
//   node tools/ui-test-home.js <out-folder>      (needs the preview server on port 8770)
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openPhone } from './cdp.js';

const out = resolve(process.argv[2] || 'ui-test-out');
mkdirSync(out, { recursive: true });
const URL_APP = 'http://127.0.0.1:8770/app/src/main/assets/web/index.html';
const WEB = '/app/src/main/assets/web/js';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? `: ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed++;
}

const page = await openPhone({ port: 9337 });
const shot = (name) => page.screenshot(join(out, `${name}.png`));
const letterCount = () => page.evaluate('return window.__app.letters.length;');
const topScreen = () => page.evaluate('return window.__app.stack.at(-1);');
const textOf = (selector) => page.evaluate(`return document.querySelector(${JSON.stringify(selector)})?.textContent ?? null;`);
const visible = (selector) => page.evaluate(`const el = document.querySelector(${JSON.stringify(selector)}); return !!el && el.getClientRects().length > 0;`);
const howMany = (selector) => page.evaluate(`return document.querySelectorAll(${JSON.stringify(selector)}).length;`);
const back = async () => {
  const handled = await page.evaluate('return window.__onBack();');
  await page.sleep(300);
  return handled;
};
const tapTile = async (title) => {
  const i = await page.evaluate(`return [...document.querySelectorAll('#home .quick-tile')].findIndex((b) => b.textContent.includes(${JSON.stringify(title)}));`);
  await page.tapOn('#home .quick-tile', i);
  await page.sleep(500);
};
const typeSearch = async (words) => {
  await page.evaluate(`const s = document.querySelector('#home input[type="search"]'); s.value = ${JSON.stringify(words)}; s.dispatchEvent(new Event('input'));`);
  await page.sleep(100);
};
// Puts these letters in the archive: [subject, recipient, days ago, status, seconds to make].
const seed = (rows) => page.evaluate(`
  const { app } = await import('${WEB}/app.js');
  const { homeScreen } = await import('${WEB}/screens/home.js');
  const { newLetter } = await import('${WEB}/model.js');
  app.letters = ${JSON.stringify(rows)}.map(([subject, name, ago, status, durationSec]) => {
    const when = Date.now() - ago * 864e5 - 1000;
    return Object.assign(newLetter(app.settings), {
      subject, status, durationSec, recipient: { name, title: '' }, updatedAt: when, createdAt: when,
      body: [{ kind: 'p', role: 'body', runs: [{ text: 'متن نامه دربارهٔ ' + subject }] }],
    });
  });
  homeScreen.show();
`);

try {
  await page.goto(URL_APP);
  await page.sleep(1200);
  // The first synthetic touch after a page load can be dropped by the emulator.
  await page.tap(180, 780);
  await page.sleep(300);

  /* ---------- The first time ---------- */
  const date = await textOf('#home .hero-date');
  check('the date is written out in the Persian calendar', /^(شنبه|یکشنبه|دوشنبه|سه‌شنبه|چهارشنبه|پنجشنبه|جمعه)، [۰-۹]{1,2} (فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند) ۱۴[۰-۹]{2}$/.test(date), date);
  check('a first run asks for the letterhead', await visible('#home .home-tile.setup'));
  check('it has nothing to search or filter yet', !(await visible('#home .search-box')) && !(await visible('#home .filters')));
  check('it says the archive is empty', (await textOf('#home .empty b')) === 'هنوز نامه‌ای نساخته‌ای');
  check('there is no goal card without a timed letter', !(await visible('#home .goal')));
  await shot('01-first-run');

  /* ---------- The ways to start ---------- */
  await page.tapOn('#home .hero-cta');
  await page.sleep(400);
  check('the big button starts a letter', (await topScreen()) === 'compose');
  check('with no template', (await page.evaluate('return window.__app.letter.templateId;')) === null);
  await back();
  check('left empty, it is not kept', (await letterCount()) === 0);

  await tapTile('گزارش');
  check('a tile starts a letter', (await topScreen()) === 'compose');
  check('of that type', (await page.evaluate('return window.__app.letter.templateId;')) === 'report');
  check('with the template text in it', (await page.evaluate(`return document.querySelector('#compose .editor').textContent.length;`)) > 20);
  check('and that chip is on in the form', (await textOf('#compose .chip.on')) === 'گزارش');
  await shot('02-from-a-tile');
  await page.sleep(700);
  await back();
  await page.sleep(700);
  check('a tile tapped by mistake leaves no draft', (await letterCount()) === 0);

  check('the most used type comes first', (await page.evaluate(`return document.querySelectorAll('#home .quick-tile')[1].textContent;`)) === 'گزارش');

  await page.evaluate(`
    const { saveTemplate } = await import('${WEB}/app.js');
    const { homeScreen } = await import('${WEB}/screens/home.js');
    await saveTemplate({ id: 'mine', title: 'قالب خودم', subject: 'موضوع قالب', greeting: '', closing: '', bodyHtml: '<p>متن قالب</p>', body: [{ kind: 'p', role: 'body', runs: [{ text: 'متن قالب' }] }], styles: {}, offsets: {}, geom: {}, parts: {} });
    homeScreen.show();
  `);
  await tapTile('قالب خودم');
  check('a saved template has a tile too', (await page.evaluate('return window.__app.letter.subject;')) === 'موضوع قالب');
  await page.sleep(700);
  await back();
  await page.sleep(700);
  check('and tapped by mistake it leaves no draft either', (await letterCount()) === 0);

  await tapTile('درخواست');
  await page.evaluate(`
    const subject = document.querySelector('#compose input[placeholder*="موضوع"]');
    subject.value = 'درخواست واقعی';
    subject.dispatchEvent(new Event('input'));
  `);
  await back();
  check('a letter with something typed in it is kept', (await letterCount()) === 1);
  check('it shows in the archive as a draft', (await textOf('#home .letter-meta em')) === 'پیش‌نویس');
  check('under today', (await textOf('#home .letter-when')) === 'امروز');

  await page.tapOn('#home .section-link');
  await page.sleep(500);
  check('the link opens the list of all templates', (await howMany('.sheet .template-row')) >= 26, await howMany('.sheet .template-row'));
  await page.evaluate(`[...document.querySelectorAll('.sheet .template-row')].find((b) => b.textContent.includes('دعوت‌نامه')).click();`);
  await page.sleep(400);
  check('choosing one fills the new letter', (await page.evaluate('return window.__app.letter.templateId;')) === 'invite');
  await page.evaluate(`document.activeElement?.blur();`);
  await back();
  check('the draft before it is still there', (await letterCount()) === 1);

  const accept = await page.evaluate(`
    let seen = null;
    const real = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { seen = this.accept; };
    document.querySelector('#home .quick-tile.import').click();
    HTMLInputElement.prototype.click = real;
    return seen;
  `);
  check('the Word and PDF tile opens the file picker', /wordprocessingml/.test(accept) && /pdf/.test(accept), accept);

  await page.tapOn('#home .home-tile.setup');
  await page.sleep(300);
  check('the setup card opens settings', (await topScreen()) === 'settings');
  await back();
  await page.evaluate(`
    const { app } = await import('${WEB}/app.js');
    const { homeScreen } = await import('${WEB}/screens/home.js');
    app.settings.signer.name = 'نام امضاکننده';
    app.settings.letterhead.org = ['مرکز رشد واحدهای فناور'];
    homeScreen.show();
  `);
  check('once the letterhead is set the card goes away', !(await visible('#home .home-tile.setup')));

  /* ---------- The goal, on the user's own numbers ---------- */
  await seed([
    ['درخواست تمدید قرارداد', 'جناب آقای کرمی', 0, 'draft', null],
    ['گزارش ماهانه', 'ریاست پارک', 0, 'done', 30],
    ['معرفی نماینده', 'مدیر مالی', 1, 'done', 50],
    ['دعوت به جلسه', 'اعضای شورا', 3, 'done', 120],
    ['استعلام بیمه', 'تأمین اجتماعی', 40, 'draft', null],
  ]);
  const goal = await textOf('#home .goal');
  check('it counts the letters under a minute', goal.includes('۲ از ۳ نامه زیر یک دقیقه'), goal);
  check('it gives their average', goal.includes('میانگین ۱:۰۷'), goal);
  check('it gives the time saved against ten minutes', goal.includes('حدود ۲۷ دقیقه کمتر از روش قبل'), goal);
  const meter = await page.evaluate(`const m = document.querySelector('#home .goal-meter'); const f = m.firstChild.getBoundingClientRect(); const t = m.getBoundingClientRect(); return { share: f.width / t.width, fromRight: Math.abs(f.right - t.right) };`);
  check('the meter shows the same share and fills from the right', Math.abs(meter.share - 2 / 3) < 0.01 && meter.fromRight < 1, meter);
  await shot('03-archive');

  const heads = await page.evaluate(`return [...document.querySelectorAll('#home .letter-when')].map((e) => e.textContent);`);
  check('letters are grouped by when they were worked on', heads.length === 4 && heads[0] === 'امروز' && heads[1] === 'دیروز' && heads[2] === 'هفتهٔ اخیر' && /^[؀-ۿ]+ ۱۴[۰-۹]{2}$/.test(heads[3]), heads);

  await seed(Array.from({ length: 20 }, (_, i) => [`نامهٔ ${i}`, 'گیرنده', 0, 'done', 30]));
  check('long savings read in hours', (await textOf('#home .goal small')).includes('حدود ۳ ساعت و ۱۰ دقیقه'), await textOf('#home .goal small'));
  await seed([['بدون دقیقه', 'گیرنده', 0, 'done', 590]]);
  check('less than a minute saved is not worth a line', !(await visible('#home .goal small')));

  /* ---------- Search and filters ---------- */
  await seed([
    ['درخواست تمدید قرارداد', 'جناب آقای کرمی', 0, 'draft', null],
    ['گزارش ماهانه', 'ریاست پارک', 0, 'done', 30],
    ['معرفی نماینده', 'مدیر مالی', 1, 'done', 50],
  ]);
  await typeSearch('قرارداد');
  check('searching clears everything else away', !(await visible('#home .hero')) && !(await visible('#home .quick-row')));
  check('and says how many it found', (await textOf('#home .archive-head h2')) === '۱ نامه پیدا شد', await textOf('#home .archive-head h2'));
  check('with the words marked', (await textOf('#home .letter-snippet mark')) === 'قرارداد');
  await shot('04-search');
  const handled = await back();
  check('Android back leaves the search, not the app', handled === true && (await visible('#home .hero')));
  check('and empties the field', (await page.evaluate(`return document.querySelector('#home input[type="search"]').value;`)) === '');
  check('with no search, back is left to Android', (await page.evaluate('return window.__onBack();')) === false);

  await typeSearch('کلمه‌ای که نیست');
  check('no result says so', (await textOf('#home .empty b')) === 'نامه‌ای با این عبارت پیدا نشد');
  await page.tapOn('#home .search-clear');
  await page.sleep(200);
  check('the clear button brings everything back', await visible('#home .hero'));
  await page.evaluate(`document.activeElement?.blur();`);

  await page.tapOn('#home .filters .chip', 1);
  await page.sleep(150);
  check('the draft filter shows only drafts', (await howMany('#home .letter-line')) === 1 && (await howMany('#home .letter-mark.draft')) === 1);
  await page.tapOn('#home .filters .chip', 2);
  await page.sleep(150);
  check('the ready filter shows the rest', (await howMany('#home .letter-line')) === 2 && (await howMany('#home .letter-mark.draft')) === 0);
  await seed([['فقط آماده', 'گیرنده', 0, 'done', 30]]);
  await page.tapOn('#home .filters .chip', 1);
  await page.sleep(150);
  check('an empty filter says so', (await textOf('#home .empty b')) === 'پیش‌نویسی نداری');
  await page.tapOn('#home .filters .chip', 0);
  await page.sleep(150);

  const row = await page.centre('#home .letter-row');
  await page.evaluate(`document.querySelector('#home .letter-row').scrollIntoView({ block: 'center' });`);
  await page.sleep(100);
  const rowNow = await page.centre('#home .letter-row');
  await page.tap(rowNow.x, rowNow.y);
  await page.sleep(400);
  check('a row opens its letter', (await topScreen()) === 'compose' && (await page.evaluate('return window.__app.letter.subject;')) === 'فقط آماده', { row });
  await back();

  /* ---------- Fit ---------- */
  const measure = `
    const size = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const scroll = document.querySelector('#home .scroll');
    return { over: scroll.scrollWidth - scroll.clientWidth, cta: size('#home .hero-cta'), tile: size('#home .quick-tile'), chip: size('#home .filters .chip'), dots: size('#home .letter-line .icon-btn') };
  `;
  const fit = await page.evaluate(measure);
  check('nothing runs off the side at 360', fit.over <= 0, fit);
  check('the main button is easy to hit', fit.cta[1] >= 48, fit.cta);
  check('so are the tiles and the menu button', fit.tile[1] >= 44 && fit.dots[1] >= 42, fit);

  if (page.errors.length) console.log('script errors:', page.errors);
  check('no script errors', page.errors.length === 0);
} catch (err) {
  console.log('FAIL the run stopped:', err.message);
  failed++;
} finally {
  await page.close();
}

console.log(failed ? `${failed} checks failed` : 'all home checks passed');
process.exit(failed ? 1 : 0);
