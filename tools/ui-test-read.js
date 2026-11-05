// A scanned letter and a photo of one become letters that can be edited, offline, with the doubtful words put up for a second look.
//   node tools/ui-test-read.js <out-folder>      (needs the preview server on port 8770)
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

const page = await openPhone({ port: 9393 });
const wait = (ms = 300) => page.sleep(ms);
const waitForLetter = async (seconds = 90) => {
  for (let i = 0; i < seconds * 2; i++) {
    const done = await page.evaluate(`return !document.querySelector('.busy') && !!window.__app.letter?.ocr;`);
    if (done) return true;
    await wait(500);
  }
  return false;
};

const LINES = [
  'به استحضار می‌رساند پیرو نامهٔ شمارهٔ ۱۲۳/۴۵ مورخ ۱۴۰۵/۰۷/۱۰ در خصوص تمدید قرارداد استقرار شرکت دانش‌بنیان آریا در مرکز رشد، این شرکت طی یک سال گذشته فعالیت‌های پژوهشی و فناورانهٔ خود را مطابق برنامهٔ مصوب انجام داده و گزارش پیشرفت کار به دفتر مرکز تحویل شده است.',
  'با توجه به نتایج ارزیابی کمیتهٔ فنی و نظر مثبت داوران، خواهشمند است دستور فرمایید نسبت به تمدید قرارداد برای مدت یک سال دیگر و تخصیص فضای کاری مناسب اقدام لازم معمول گردد. همچنین مقرر شد صورت‌حساب‌های معوق این واحد تا پایان آذرماه تسویه شود.',
  'پیشاپیش از همکاری صمیمانهٔ جناب‌عالی و همکاران محترم در این زمینه سپاسگزاری می‌نماید.',
];

try {
  /* ---------- A letter printed by the app, then made to look scanned ---------- */
  await page.goto(APP);
  await wait(1000);
  const truth = await page.evaluate(`
    const { newLetter, plainTextOf } = await import('${WEB}/model.js');
    const { preparePrintRoot } = await import('${WEB}/export.js');
    const app = window.__app;
    const L = newLetter(app.settings);
    L.recipient = { name: 'جناب آقای دکتر علی محمدی', title: 'ریاست محترم پارک علم و فناوری استان ایلام' };
    L.subject = 'درخواست تمدید قرارداد استقرار واحد فناور';
    L.number = '۱۴۰۵/۲۳۴';
    L.date = '۱۴۰۵/۰۸/۱۲';
    L.greeting = 'با سلام و احترام،';
    L.body = ${JSON.stringify(LINES)}.map((text) => ({ kind: 'p', runs: [{ text }] }));
    L.closing = 'با تشکر و احترام';
    L.signer = { name: 'رضا احمدی', title: 'مدیر مرکز رشد واحدهای فناور' };
    L.autoFix = false;
    await preparePrintRoot(L);
    await document.fonts.ready;
    return plainTextOf(L);
  `);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const printed = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });

  await page.goto(APP);
  await wait(1000);
  const sizes = await page.evaluate(`
    const pdfjs = await import('/app/src/main/assets/web/vendor/pdfjs/pdf.min.js');
    globalThis.pdfjsWorker = await import('/app/src/main/assets/web/vendor/pdfjs/pdf.worker.min.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(printed.data)}), (c) => c.charCodeAt(0));
    const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, isOffscreenCanvasSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
    const pg = await pdf.getPage(1);
    const vp = pg.getViewport({ scale: 300 / 72 });
    const source = document.createElement('canvas');
    source.width = vp.width; source.height = vp.height;
    await pg.render({ canvasContext: source.getContext('2d'), viewport: vp }).promise;
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const scanned = (angle) => {
      const d = document.createElement('canvas');
      d.width = source.width; d.height = source.height;
      const x = d.getContext('2d');
      x.fillStyle = '#eee8dc'; x.fillRect(0, 0, d.width, d.height);
      x.translate(d.width / 2, d.height / 2); x.rotate(angle); x.translate(-d.width / 2, -d.height / 2);
      x.globalCompositeOperation = 'multiply';
      x.filter = 'blur(0.8px)';
      x.drawImage(source, 0, 0);
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.filter = 'none';
      x.globalCompositeOperation = 'source-over';
      const im = x.getImageData(0, 0, d.width, d.height);
      for (let i = 0; i < im.data.length; i += 4) { const n = (rnd() - 0.5) * 24; im.data[i] += n; im.data[i + 1] += n; im.data[i + 2] += n; }
      x.putImageData(im, 0, 0);
      return d;
    };
    const scan = scanned(0.006);
    // A logo at the top and a stamp beside the signature, which are not words.
    const x = scan.getContext('2d');
    x.fillStyle = 'rgb(20,60,160)';
    x.beginPath(); x.arc(scan.width * 0.86, scan.height * 0.055, scan.width * 0.035, 0, 7); x.fill();
    x.strokeStyle = 'rgb(40,70,190)'; x.lineWidth = scan.width / 250;
    x.beginPath(); x.arc(scan.width * 0.14, scan.height * 0.70, scan.width * 0.075, 0, 7); x.stroke();
    x.beginPath(); x.arc(scan.width * 0.14, scan.height * 0.70, scan.width * 0.055, 0, 7); x.stroke();
    const blob = await new Promise((ok) => scan.toBlob(ok, 'image/jpeg', 0.8));
    window.__scanBytes = new Uint8Array(await blob.arrayBuffer());
    // The same page lying on its side, as a photo may.
    const side = document.createElement('canvas');
    const small = scanned(0);
    side.width = small.height; side.height = small.width;
    const s = side.getContext('2d');
    s.translate(side.width / 2, side.height / 2); s.rotate(Math.PI / 2); s.drawImage(small, -small.width / 2, -small.height / 2);
    window.__sideBytes = new Uint8Array(await (await new Promise((ok) => side.toBlob(ok, 'image/jpeg', 0.8))).arrayBuffer());
    return { scan: window.__scanBytes.length, side: window.__sideBytes.length };
  `);
  const scanB64 = await page.evaluate(`const { bytesToBase64 } = await import('${WEB}/util.js'); return bytesToBase64(window.__scanBytes);`);
  writeFileSync(join(out, 'scan.jpg'), Buffer.from(scanB64, 'base64'));

  /* ---------- What the engine confuses, which nothing else can mean ---------- */
  const words = await page.evaluate(`
    const { fixWord } = await import('${WEB}/ocr.js');
    return ['نامة', 'شمارةٌ', 'رشدء', 'علي', 'كتاب', '١٢٣', 'احتراماً', 'سلاَم', 'ابتداء', 'رشد.ء', 'داوران,', '۲۵۰,۰۰۰', 'آامور', 'بیوست:', 'شمارم:', 'شمارم'].map(fixWord);
  `);
  check('the marks of a misreading are put right', words.join('|') === 'نامهٔ|شمارهٔ|رشد،|علی|کتاب|۱۲۳|احتراماً|سلام|ابتداء|رشد،|داوران،|۲۵۰٬۰۰۰|امور|پیوست:|شماره:|شمارم', words);
  const lex = await page.evaluate(`
    const { buildLexicon, suggestion, appWords } = await import('${WEB}/lexicon.js');
    const L = buildLexicon([...appWords(), 'ریاست ایلام اقدام دانش‌بنیان']);
    return {
      size: L.counts.size,
      known: suggestion('ریاست', L),
      dots: suggestion('رباست', L),
      again: suggestion('ابلام،', L),
      half: suggestion('دانش‌پنیان', L),
      strange: suggestion('زردچوبه', L),
      near: suggestion('اقدم', L, { near: true }),
    };
  `);
  check('a word off by a dot finds the word it should be', lex.dots === 'ریاست' && lex.again === 'ایلام،' && lex.half === 'دانش‌بنیان', lex);
  check('a known word and an unknown one are left alone', lex.known === null && lex.strange === null, lex);
  check('the app knows many words of its own', lex.size > 500, lex.size);
  const listed = await page.evaluate(`
    const { appWords, buildLexicon, modelWords, lookAt } = await import('${WEB}/lexicon.js');
    const general = await modelWords();
    const L = buildLexicon(appWords(), general);
    return {
      count: general.length,
      has: ['ریاست', 'ایلام', 'قرارداد'].every((w) => general.includes(w)),
      lacks: ['رباست', 'ابلام'].every((w) => !general.includes(w)),
      known: lookAt('قرارداد', 85, L),
      knownLow: lookAt('قرارداد', 20, L),
      common: lookAt('این', 25, L),
      dots: lookAt('رباست', 91, L),
      name: lookAt('خسروانی', 88, L),
      nameLow: lookAt('خسروانی', 60, L),
      number: lookAt('۱۴۰۵/۰۸/۱۲', 80, L),
      numberClear: lookAt('۱۴۰۵/۰۸/۱۲', 93, L),
      ending: lookAt('مادم', 55, L),
      mark: lookAt('فناورانهٔ', 40, L, { fixed: true }),
    };
  `);
  check('the word list inside the model is read', listed.count > 10000 && listed.has && listed.lacks, listed.count);
  check('a known word needs no look unless the engine truly doubts it', !listed.known.look && listed.knownLow.look && !listed.common.look, [listed.known, listed.knownLow, listed.common]);
  check('a word one dot from a known word gets a look even when clear', listed.dots.look && listed.dots.better === 'ریاست', listed.dots);
  check('a name nobody knows gets a look only when doubted', !listed.name.look && listed.nameLow.look, [listed.name, listed.nameLow]);
  check('a number gets a look unless it is clear', listed.number.look && !listed.numberClear.look, [listed.number, listed.numberClear]);
  check('a misread ending is seen through', listed.ending.look && listed.ending.better === 'ماده', listed.ending);
  check('a mark put right raises no doubt by itself', !listed.mark.look, listed.mark);
  const worker = await page.evaluate(`
    const { startEngine } = await import('${WEB}/ocr.js');
    const engine = await startEngine();
    const inPage = !!engine.inPage;
    engine.stop();
    return inPage;
  `);
  check('the engine runs apart from the page', worker === false);

  /* ---------- A photo through the file picker's way in ---------- */
  await page.evaluate(`
    const { openLetterFile } = await import('${WEB}/screens/home.js');
    window.__pending = openLetterFile(window.__scanBytes, 'نامه.jpg');
    await window.__pending;
    await new Promise((r) => setTimeout(r, 400));
  `);
  const offered = await page.evaluate(`
    const L = window.__app.letter;
    return { scanned: L.importInfo.scanned, title: document.querySelector('.sheet-head')?.textContent, buttons: [...document.querySelectorAll('.sheet .btn')].map((b) => b.textContent), screen: window.__app.stack.at(-1), images: L.objects.length, name: L.sourceName };
  `);
  check('a photo comes in as a scan, on its page', offered.scanned && offered.screen === 'page' && offered.images === 1 && offered.name === 'نامه', offered);
  check('and asks whether to read it', /اسکن/.test(offered.title || '') && offered.buttons.includes('بخوان'), offered.buttons);
  const scanId = await page.evaluate(`return window.__app.letter.id;`);
  const t0 = Date.now();
  await page.evaluate(`[...document.querySelectorAll('.sheet .btn')].find((b) => b.textContent === 'بخوان').click();`);
  const busySeen = await page.evaluate(`
    await new Promise((r) => setTimeout(r, 300));
    return document.querySelector('.busy')?.textContent || '';
  `);
  const ticks = await page.evaluate(`
    // A page kept alive by a worker goes on ticking while it reads.
    let count = 0;
    const timer = setInterval(() => { count++; }, 100);
    for (let i = 0; i < 60 && document.querySelector('.busy'); i++) await new Promise((r) => setTimeout(r, 100));
    clearInterval(timer);
    return count;
  `);
  check('it says what it is doing', /خواندن/.test(busySeen), busySeen);
  check('the screen stays alive while it reads', ticks >= 10, ticks);
  const finished = await waitForLetter();
  const seconds = Math.round((Date.now() - t0) / 1000);
  check('the page is read', finished, `${seconds}s`);
  await wait(500);
  const fold = `(s) => s.normalize('NFKC').replace(/[\\u0640\\u200c\\u200d\\u0654\\u064b-\\u065f]/g, '').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/ة/g, 'ه').replace(/[\\u06f0-\\u06f9]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x6f0 + 48))`;
  const read = await page.evaluate(`
    const { plainTextOf } = await import('${WEB}/model.js');
    const L = window.__app.letter;
    const fold = ${fold};
    const wordsOf = (s) => fold(s).split(/[\\s،؛:.()«»\\[\\]/\\-]+/).filter((w) => w.length > 1);
    const truth = wordsOf(${JSON.stringify(truth)});
    const pool = new Map();
    for (const w of wordsOf(plainTextOf(L))) pool.set(w, (pool.get(w) || 0) + 1);
    let right = 0;
    const missed = [];
    for (const w of truth) { if (pool.get(w) > 0) { pool.set(w, pool.get(w) - 1); right++; } else missed.push(w); }
    return {
      right, of: truth.length, pct: Math.round(1000 * right / truth.length) / 10, missed: missed.slice(0, 15).join(' '),
      recipient: L.recipient, subject: L.subject, number: L.number, date: L.date, greeting: L.greeting, closing: L.closing, signer: L.signer,
      bold: { recipient: L.styles.recipient?.bold, subject: L.styles.subject?.bold, body: L.styles.body?.bold, greeting: L.styles.greeting?.bold }, size: L.styles.body?.size,
      body: L.body.filter((b) => b.kind === 'p').length, bodyText: L.body.map((b) => (b.runs || []).map((r) => r.text).join('')).join('\\n'),
      autoFix: L.autoFix, imported: L.imported, form: !!L.importInfo.form, stillScan: !!L.importInfo.scanned,
      pictures: L.objects.filter((o) => o.kind !== 'text').map((o) => [o.kind, Math.round(o.x), Math.round(o.y), Math.round(o.w)]), logo: !!L.letterhead.logo,
      ocr: { pages: L.ocr?.pages?.length, unsure: L.ocr?.words?.length, conf: L.ocr?.confidence, sample: L.ocr?.words?.slice(0, 12).map((w) => w.t + (w.s ? '→' + w.s : '')) },
      screen: window.__app.stack.at(-1), scanStill: window.__app.letters.some((l) => l.id === ${JSON.stringify(scanId)}), rows: document.querySelectorAll('.review-row').length, pictureRows: document.querySelectorAll('.review-picture').length,
    };
  `);
  console.log(`read ${read.right}/${read.of} = ${read.pct}% | missed: ${read.missed}`);
  console.log(JSON.stringify(read.ocr));
  check('nearly every word is right', read.pct >= 92, read.pct);
  check('the recipient is found', /محمدی/.test(read.recipient?.name || '') && /علم و فناوری/.test(read.recipient?.title || ''), read.recipient);
  check('the subject is found', /تمدید قرارداد/.test(read.subject || ''), read.subject);
  check('the number and date are found', /234|۲۳۴/.test(read.number || '') && /۱۴۰۵\/۰۸\/۱۲|1405\/08\/12/.test(read.date || ''), [read.number, read.date]);
  check('the greeting and closing are found', /سلام/.test(read.greeting || '') && /تشکر/.test(read.closing || ''), [read.greeting, read.closing]);
  check('the signer is found', /احمدی/.test(read.signer?.name || '') && /مدیر/.test(read.signer?.title || ''), read.signer);
  check('half-spaces come back', /می‌رساند/.test(read.bodyText), read.bodyText.slice(0, 50));
  check('the paragraphs are as they were', read.body === 3, read.body);
  check('what was bold is bold', read.bold.recipient && read.bold.subject && !read.bold.body && !read.bold.greeting, read.bold);
  check('the letters are the size they were', Math.abs(read.size - 14) <= 1, read.size);
  check('it is a letter now, no longer a picture', read.imported && !read.form && !read.stillScan, [read.imported, read.form, read.stillScan]);
  check('the scan draft gives way to the letter', !read.scanStill);
  check('what is not words is kept as pictures', read.pictures.length >= 1 || read.logo, [read.pictures, read.logo]);
  const logoInk = await page.evaluate(`
    const { ensureMedia, mediaUrl } = await import('${WEB}/store.js');
    const { loadImage } = await import('${WEB}/util.js');
    const id = window.__app.letter.letterhead.logo;
    if (!id) return null;
    await ensureMedia([id]);
    const img = await loadImage(mediaUrl(id));
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const middle = x.getImageData(Math.round(c.width * 0.3), Math.round(c.height * 0.3), 1, 1).data;
    return { alpha: middle[3], blue: middle[2] > middle[0] + 40 };
  `);
  check('a solid logo stays solid', logoInk && logoInk.alpha > 200 && logoInk.blue, logoInk);
  check('the scan stays at hand', read.ocr.pages === 1);
  check('doubtful words are put up for a look', read.ocr.unsure >= 1 && read.rows >= 1 && read.rows === read.pictureRows, [read.ocr.unsure, read.rows]);
  check('not too many of them', read.ocr.unsure <= read.of * 0.3, [read.ocr.unsure, read.of]);

  const fields = await page.evaluate(`
    const { replaceEverywhere } = await import('${WEB}/restyle.js');
    const copy = JSON.parse(JSON.stringify(window.__app.letter));
    const count = (word) => (word ? replaceEverywhere(copy, word, undefined, { whole: true }) : 0);
    const before = [copy.number, copy.date, copy.letterhead.org?.[0], copy.letterhead.invocation];
    const found = before.map(count);
    replaceEverywhere(copy, copy.number, 'شماره‌تازه', { whole: true });
    replaceEverywhere(copy, copy.date, 'تاریخ‌تازه', { whole: true });
    return { before, found, number: copy.number, date: copy.date, rows: [...document.querySelectorAll('.review-row input')].map((i) => i.getAttribute('aria-label')), words: window.__app.letter.ocr.words.map((w) => w.t) };
  `);
  check('number, date and letterhead can be corrected too', fields.found.every((n, i) => n > 0 || !fields.before[i]) && fields.number === 'شماره‌تازه' && fields.date === 'تاریخ‌تازه', fields);
  check('every doubt gets its row', fields.rows.length === fields.words.length, [fields.rows, fields.words]);

  /* ---------- The ways back to them ---------- */
  await page.evaluate(`document.querySelector('.sheet [aria-label="بستن"]').click();`);
  await wait(400);
  const later = await page.evaluate(`
    const tools = [...document.querySelectorAll('#page .tools button')].map((b) => b.textContent.trim());
    return { tools: tools.slice(0, 3), left: window.__app.letter.ocr.words.length };
  `);
  check('closed for now, the page offers them again', later.tools.some((t) => t.startsWith('بازبینی')) && later.left > 0, later);
  await page.evaluate(`[...document.querySelectorAll('#page .tools button')].find((b) => b.textContent.includes('دیدن اسکن')).click();`);
  await wait(500);
  const scanSeen = await page.evaluate(`
    const img = document.querySelector('.scan-pages img');
    const out = { title: document.querySelector('.sheet-head')?.textContent, width: img?.naturalWidth };
    document.querySelector('.sheet [aria-label="بستن"]').click();
    return out;
  `);
  check('the scan itself can be looked at', scanSeen.width > 1000, scanSeen);
  const pictureAgain = await page.evaluate(`
    const { letterFromPages } = await import('${WEB}/import-pdf.js');
    const L = window.__app.letter;
    const scan = await letterFromPages(L.ocr.pages, L.page || null, window.__app.settings);
    return { scanned: scan.importInfo.scanned, objects: scan.objects.length, media: scan.objects[0].mediaId === L.ocr.pages[0], width: scan.objects[0].w };
  `);
  check('and a reading of no use can go back to the pictures', pictureAgain.scanned && pictureAgain.objects === 1 && pictureAgain.media && pictureAgain.width > 100, pictureAgain);
  await wait(300);
  await page.evaluate(`
    const { goBack } = await import('${WEB}/app.js');
    for (let i = 0; i < 3 && window.__app.stack.at(-1) !== 'compose'; i++) goBack();
  `);
  await wait(600);
  const onForm = await page.evaluate(`
    const bar = [...document.querySelectorAll('.fill-bar')].find((b) => b.textContent.includes('بازبینی'));
    return { screen: window.__app.stack.at(-1), shown: !!bar && !bar.hidden, text: bar?.textContent };
  `);
  check('the form offers them too', onForm.screen === 'compose' && onForm.shown, onForm);
  await page.evaluate(`[...document.querySelectorAll('.fill-bar')].find((b) => b.textContent.includes('بازبینی')).querySelector('button').click();`);
  await wait(900);
  const fromForm = await page.evaluate(`return { rows: document.querySelectorAll('.review-row').length };`);
  check('and opens the same list', fromForm.rows >= 1, fromForm);

  /* ---------- Going through them ---------- */
  const reviewed = await page.evaluate(`
    const { plainTextOf } = await import('${WEB}/model.js');
    const L = window.__app.letter;
    const inputs = [...document.querySelectorAll('.review-row input')];
    const first = inputs[0];
    const old = first.getAttribute('aria-label');
    const looked = { rows: inputs.length, pictures: document.querySelectorAll('.review-picture').length };
    const gone = inputs[inputs.length - 1];
    const goneWord = gone.getAttribute('aria-label');
    const whole = (w) => JSON.stringify([L.recipient, L.subject, L.number, L.date, L.greeting, L.closing, L.signer, L.body, L.attachment]).includes(w);
    const hadIt = whole(goneWord);
    if (inputs.length > 1) gone.value = '';
    const looks = document.querySelector('.review-picture');
    const shape = { w: looks.naturalWidth, h: looks.naturalHeight };
    first.value = 'سرسبز';
    [...document.querySelectorAll('.review-sheet .btn.primary')].pop().click();
    await new Promise((r) => setTimeout(r, 300));
    const { mediaIdsOf } = await import('${WEB}/store.js');
    return { removed: !hadIt || !whole(goneWord), kept: mediaIdsOf(L).includes(L.ocr.pages[0]), old, shape, has: JSON.stringify([L.recipient, L.subject, L.number, L.date, L.greeting, L.closing, L.signer, L.body, L.letterhead?.org, L.letterhead?.invocation, L.attachment]).includes('سرسبز'), left: L.ocr.words.length, sheet: !!document.querySelector('.review-row'), saved: !!window.__app.letters.find((l) => l.id === L.id), toast: document.querySelector('#toast')?.textContent };
  `);
  check('a word shows beside its picture from the scan', reviewed.shape.w > 20 && reviewed.shape.h > 8, reviewed.shape);
  check('a correction reaches the letter', reviewed.has && reviewed.left === 0 && !reviewed.sheet, reviewed);
  check('a word left empty goes away', reviewed.removed);
  check('the scan goes into backups with the letter', reviewed.kept);
  const wordOut = await page.evaluate(`
    const { makeDocx } = await import('${WEB}/export.js');
    const { readZip } = await import('${WEB}/unzip.js');
    const made = await makeDocx(window.__app.letter, { deliver: false });
    const xml = new TextDecoder().decode(readZip(made.bytes).get('word/document.xml')());
    return { size: made.bytes.length, hasWords: xml.includes('استقرار') };
  `);
  check('and it goes to Word like any letter', wordOut.hasWords, wordOut);
  const tools = await page.evaluate(`return [...document.querySelectorAll('#page .tools button')].map((b) => b.textContent.trim()).filter(Boolean);`);
  check('the scan can be looked at again', tools.includes('دیدن اسکن اصلی'), tools.slice(0, 5));

  /* ---------- Looking it up afterwards ---------- */
  const search = await page.evaluate(`
    const { plainTextOf } = await import('${WEB}/model.js');
    return plainTextOf(window.__app.letter).includes('قرارداد');
  `);
  check('its words can be found in the archive', search);

  /* ---------- A page on its side ---------- */
  await page.evaluate(`
    const { letterFromPhoto } = await import('${WEB}/import-pdf.js');
    const { readScannedLetter } = await import('${WEB}/read-scan.js');
    const scan = await letterFromPhoto(window.__sideBytes, window.__app.settings, 'image/jpeg');
    const t = performance.now();
    const L = await readScannedLetter(scan, window.__app.settings);
    window.__side = { L, ms: performance.now() - t };
  `);
  const side = await page.evaluate(`
    const { plainTextOf } = await import('${WEB}/model.js');
    const { L, ms } = window.__side;
    const text = plainTextOf(L);
    return { ms: Math.round(ms), subject: L.subject, has: text.includes('قرارداد') && text.includes('تمدید'), stored: L.ocr.pages.length, conf: L.ocr.confidence };
  `);
  check('a page lying on its side is turned and read', side.has && side.conf > 60 && /تمدید قرار ?داد/.test(side.subject || ''), side);
  await page.evaluate(`
    const { letterFromPhoto } = await import('${WEB}/import-pdf.js');
    const { readScannedLetter } = await import('${WEB}/read-scan.js');
    const img = await createImageBitmap(new Blob([window.__scanBytes], { type: 'image/jpeg' }));
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.translate(c.width / 2, c.height / 2); x.rotate(Math.PI); x.drawImage(img, -c.width / 2, -c.height / 2);
    const bytes = new Uint8Array(await (await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8))).arrayBuffer());
    const scan = await letterFromPhoto(bytes, window.__app.settings, 'image/jpeg');
    window.__upside = await readScannedLetter(scan, window.__app.settings);
  `);
  const upside = await page.evaluate(`
    const { plainTextOf } = await import('${WEB}/model.js');
    const L = window.__upside;
    return { subject: L.subject, has: plainTextOf(L).includes('قرارداد'), conf: L.ocr.confidence };
  `);
  check('a page upside down is turned and read', upside.has && upside.conf > 60, upside);

  const two = await page.evaluate(`
    const { letterFromPhoto } = await import('${WEB}/import-pdf.js');
    const { readScannedLetter } = await import('${WEB}/read-scan.js');
    const { plainTextOf } = await import('${WEB}/model.js');
    const first = await letterFromPhoto(window.__scanBytes, window.__app.settings, 'image/jpeg');
    const second = await letterFromPhoto(window.__sideBytes, window.__app.settings, 'image/jpeg');
    first.objects.push({ ...second.objects[0], page: 1 });
    const steps = [];
    const L = await readScannedLetter(first, window.__app.settings, { onProgress: (page, total) => steps.push(page + '/' + total) });
    return { steps, pages: L.ocr.pages.length, confidence: L.ocr.confidence, count: (plainTextOf(L).match(/خواهشمند/g) || []).length };
  `);
  const desk = await page.evaluate(`
    const { letterFromPhoto } = await import('${WEB}/import-pdf.js');
    const { readScannedLetter } = await import('${WEB}/read-scan.js');
    const { plainTextOf } = await import('${WEB}/model.js');
    const img = await createImageBitmap(new Blob([window.__scanBytes], { type: 'image/jpeg' }));
    const c = document.createElement('canvas');
    // The page takes four fifths of the photo, on a dark desk.
    c.width = Math.round(img.width * 1.25); c.height = Math.round(img.height * 1.2);
    const x = c.getContext('2d');
    x.fillStyle = 'rgb(62,52,44)'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(img, (c.width - img.width) / 2, (c.height - img.height) / 2);
    const bytes = new Uint8Array(await (await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8))).arrayBuffer());
    const scan = await letterFromPhoto(bytes, window.__app.settings, 'image/jpeg');
    const L = await readScannedLetter(scan, window.__app.settings);
    return { size: L.styles.body?.size, subject: L.subject, text: plainTextOf(L).includes('قرارداد'), stored: L.ocr.pages[0] !== scan.objects[0].mediaId };
  `);
  check('a page on a desk is cut to its paper, so its letters keep their size', desk.text && Math.abs(desk.size - 14) <= 1 && desk.stored, desk);
  const shade = await page.evaluate(`
    const { canvasOfImage, readPage, startEngine } = await import('${WEB}/ocr.js');
    const img = await createImageBitmap(new Blob([window.__scanBytes], { type: 'image/jpeg' }));
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    x.globalCompositeOperation = 'multiply';
    const g = x.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(60,50,40,0.7)');
    x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
    const engine = await startEngine();
    const before = c.width;
    const p = await readPage(engine, c, 210, async () => null);
    engine.stop();
    return { same: p.page.width >= before * 0.98, words: p.words.length };
  `);
  check('a shadow across the page cuts nothing away', shade.same && shade.words > 100, shade);
  check('every page of a longer scan is read, in turn', two.steps.join() === '1/2,2/2' && two.pages === 2 && two.count === 2, two);

  /* ---------- A form with tables ---------- */
  await page.goto('http://127.0.0.1:8770/tools/form-sample.html');
  await wait(1500);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const formPdf = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
  await page.goto(APP);
  await wait(1000);
  const form = await page.evaluate(`
    const pdfjs = await import('/app/src/main/assets/web/vendor/pdfjs/pdf.min.js');
    globalThis.pdfjsWorker = await import('/app/src/main/assets/web/vendor/pdfjs/pdf.worker.min.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(formPdf.data)}), (c) => c.charCodeAt(0));
    const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, isOffscreenCanvasSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
    const pg = await pdf.getPage(1);
    const vp = pg.getViewport({ scale: 300 / 72 });
    const source = document.createElement('canvas');
    source.width = vp.width; source.height = vp.height;
    await pg.render({ canvasContext: source.getContext('2d'), viewport: vp }).promise;
    const d = document.createElement('canvas');
    d.width = source.width; d.height = source.height;
    const x = d.getContext('2d');
    x.fillStyle = '#efe9dd'; x.fillRect(0, 0, d.width, d.height);
    x.translate(d.width / 2, d.height / 2); x.rotate(0.005); x.translate(-d.width / 2, -d.height / 2);
    x.globalCompositeOperation = 'multiply';
    x.filter = 'blur(0.7px)';
    x.drawImage(source, 0, 0);
    const scanned = new Uint8Array(await (await new Promise((ok) => d.toBlob(ok, 'image/jpeg', 0.85))).arrayBuffer());
    const { letterFromPhoto } = await import('${WEB}/import-pdf.js');
    const { readScannedLetter } = await import('${WEB}/read-scan.js');
    const scan = await letterFromPhoto(scanned, window.__app.settings, 'image/jpeg');
    const L = await readScannedLetter(scan, window.__app.settings);
    const table = L.body.find((b) => b.kind === 'table');
    return { form: !!L.importInfo.form, rows: table?.rows.length, cols: table?.rows[0].length, cell: table?.rows[1]?.[1]?.paras?.[0]?.runs?.map((r) => r.text).join('') };
  `);
  check('a scanned form comes back with its table', form.form && form.rows >= 8 && form.cols >= 4, form);

  /* ---------- A scanned PDF ---------- */
  writeFileSync(join(resolve('ui-test-out'), 'scan-for-test.jpg'), Buffer.from(scanB64, 'base64'));
  await page.goto('http://127.0.0.1:8770/tools/scan-page.html?image=/ui-test-out/scan-for-test.jpg');
  await wait(1200);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const scanPdf = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
  await page.goto(APP);
  await wait(1000);
  await page.evaluate(`
    const { openLetterFile } = await import('${WEB}/screens/home.js');
    const bytes = Uint8Array.from(atob(${JSON.stringify(scanPdf.data)}), (c) => c.charCodeAt(0));
    await openLetterFile(bytes, 'نامهٔ اسکن.pdf');
    await new Promise((r) => setTimeout(r, 400));
  `);
  const pdfOffer = await page.evaluate(`return { scanned: window.__app.letter.importInfo.scanned, buttons: [...document.querySelectorAll('.sheet .btn')].map((b) => b.textContent) };`);
  check('a scanned PDF asks the same', pdfOffer.scanned && pdfOffer.buttons.includes('بخوان'), pdfOffer);
  // Saying no leaves it a picture, with the way back on the page's tools.
  await page.evaluate(`[...document.querySelectorAll('.sheet .btn')].find((b) => b.textContent.includes('عکس بماند')).click();`);
  await wait(300);
  const stayed = await page.evaluate(`return { scanned: window.__app.letter.importInfo.scanned, tools: [...document.querySelectorAll('#page .tools button')].map((b) => b.textContent.trim()) };`);
  check('saying no leaves it a picture, and it can be read later', stayed.scanned && stayed.tools.includes('خواندن متن این اسکن'), stayed.tools.slice(0, 3));
  await page.evaluate(`[...document.querySelectorAll('#page .tools button')].find((b) => b.textContent.includes('خواندن متن این اسکن')).click();`);
  await wait(500);
  const pdfFinished = await waitForLetter();
  const pdfRead = await page.evaluate(`
    const { plainTextOf } = await import('${WEB}/model.js');
    const L = window.__app.letter;
    return { subject: L.subject, text: plainTextOf(L).includes('قرارداد'), name: L.sourceName };
  `);
  check('and then it is read too', pdfFinished && pdfRead.text && /تمدید/.test(pdfRead.subject || ''), pdfRead);

  /* ---------- A picture with no words ---------- */
  const empty = await page.evaluate(`
    const { letterFromPhoto } = await import('${WEB}/import-pdf.js');
    const { startReading } = await import('${WEB}/screens/read-flow.js');
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 1700;
    const x = c.getContext('2d');
    x.fillStyle = '#f3f0ea'; x.fillRect(0, 0, c.width, c.height);
    const bytes = new Uint8Array(await (await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8))).arrayBuffer());
    const scan = await letterFromPhoto(bytes, window.__app.settings, 'image/jpeg');
    window.__app.letter = scan;
    await startReading(scan);
    return { same: window.__app.letter === scan, toast: document.querySelector('#toast')?.textContent };
  `);
  check('a picture with no words says so and stays as it was', empty.same && /پیدا نشد/.test(empty.toast || ''), empty);

  /* ---------- What is not a letter ---------- */
  const other = await page.evaluate(`
    const { letterFromReadPages } = await import('${WEB}/import-pdf.js');
    const item = (text, x, y) => ({ text: text + ' ', x, y, w: 20, size: 12, bold: false, font: 'B Nazanin', rawFont: 'read', shaped: false, told: false, head: text[0], tail: text.slice(-1) });
    const read = [{ items: [item('گزارش', 150, 30), item('سالانه', 125, 30), item('بند', 150, 60), item('دوم', 125, 60)], rules: [], fills: [], pictures: [], paragraphs: ['گزارش سالانه', 'بند دوم'], size: 12 }];
    const L = await letterFromReadPages(read, null, window.__app.settings);
    return { body: L.body.map((b) => (b.runs || []).map((r) => r.text).join('')), scanned: !!L.importInfo.scanned, imported: L.imported };
  `);
  check('anything else comes in as its paragraphs', other.body.join('|') === 'گزارش سالانه|بند دوم' && !other.scanned, other);

  check('no script errors', page.errors.length === 0, page.errors.slice(0, 5));
  console.log(failed ? `${failed} FAILED` : 'all reading checks passed');
  process.exitCode = failed ? 1 : 0;
} finally {
  await page.close();
}
