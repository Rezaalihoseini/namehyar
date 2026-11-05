import { h, toast, dataUrlToBytes } from '../util.js';
import { icon } from '../icons.js';
import { app, backToHome, confirmSheet, deleteLetter, isDark, openSheet, saveLetterNow, setTheme, showScreen, withBusy } from '../app.js';
import { copyOfLetter, newLetter, plainTextOf } from '../model.js';
import { searchKey, formatSeconds, jalaliLongDate, jalaliMonth, toFaDigits } from '../text.js';
import { importDocx } from '../import-docx.js';
import { LETTER_FILE_ACCEPT, pickFile } from '../files.js';
import { TEMPLATES } from '../data/templates.js';
import { startFromForm } from './fill-sheet.js';
import { offerReading } from './read-flow.js';

// The two numbers the app exists for: a letter used to take about ten minutes and should take under one.
const OLD_WAY_SEC = 600;
const GOAL_SEC = 60;
const QUICK_TILES = 6;

const TEMPLATE_ICONS = {
  request: 'send',
  report: 'clipboard',
  inform: 'bell',
  order: 'flag',
  invite: 'mail',
  introduce: 'user',
  reply: 'reply',
  thanks: 'heart',
  followup: 'reset',
  'meeting-request': 'calendar',
  inquiry: 'search',
  'send-documents': 'folder',
  apology: 'phrases',
  employment: 'badge',
  'center-residence': 'building',
  'center-introduce': 'building',
  'center-extend': 'calendar',
  'center-units': 'table',
  minutes: 'clipboard',
  list: 'table',
  purchase: 'cart',
  payment: 'money',
  leave: 'calendar',
  mission: 'pin',
  notice: 'bell',
};

/* ---------- Drawings. They are inline so nothing is fetched; the paper stays white in both themes, like the real page. ---------- */

const LOGO = `<svg class="logo" viewBox="0 0 36 36" aria-hidden="true">
  <rect class="logo-fill" width="36" height="36" rx="10"/>
  <path fill="#fff" d="M11.5 7.5H20l5.5 5.5v14.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-19a1 1 0 0 1 1-1z"/>
  <path fill="#b9d0f0" d="M20 7.5l5.5 5.5H21a1 1 0 0 1-1-1z"/>
  <path class="logo-fill" d="M13.5 16.5h9V18h-9zM13.5 20h9v1.5h-9zM17.5 23.5h5V25h-5z"/>
</svg>`;

// A small Iranian office letter: logo, invocation, number and date, a rule, recipient, subject, body, signature and stamp.
const HERO_SHEET = `<svg class="hero-art" viewBox="0 0 130 168" aria-hidden="true">
  <rect x="26" y="18" width="96" height="136" rx="5" fill="#fff" opacity=".16" transform="rotate(8 74 86)"/>
  <g transform="rotate(-5 65 84)">
    <path fill="#fff" d="M17 14h80l18 18v120a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3V17a3 3 0 0 1 3-3z"/>
    <path fill="#b9d0f0" d="M97 14l18 18h-15a3 3 0 0 1-3-3z"/>
    <circle cx="101" cy="41" r="5.5" fill="#185abd"/>
    <path fill="#8ea7cc" d="M56 20h18v2.6H56z"/>
    <path fill="#185abd" d="M50 26.5h30v3H50z"/>
    <path fill="#c3cede" d="M22 22h16v2.2H22zM22 28h16v2.2H22zM22 34h12v2.2H22z"/>
    <path fill="#185abd" opacity=".55" d="M22 50h85v1H22z"/>
    <path fill="#27364b" d="M66 58h41v3H66z"/>
    <path fill="#185abd" d="M54 66h53v3H54z"/>
    <path fill="#c9d3e1" d="M22 76h85v2.4H22zM22 83h85v2.4H22zM22 90h85v2.4H22zM22 97h85v2.4H22zM50 104h57v2.4H50z"/>
    <circle cx="42" cy="127" r="11" fill="none" stroke="#41a5ee" stroke-width="1.4" opacity=".7"/>
    <path fill="none" stroke="#185abd" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M27 131c5 0 6-10 9-10s1 8 4 8 3-4 6-4 1 3 9 2"/>
  </g>
</svg>`;

const EMPTY_SHEETS = `<svg class="empty-art" viewBox="0 0 120 92" aria-hidden="true">
  <rect class="sheet-back" x="22" y="14" width="56" height="70" rx="4" transform="rotate(-8 50 49)"/>
  <rect class="sheet-back" x="42" y="14" width="56" height="70" rx="4" transform="rotate(8 70 49)"/>
  <path class="sheet-front" d="M36 8h36l12 12v62a3 3 0 0 1-3 3H36a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3z"/>
  <path class="sheet-fold" d="M72 8l12 12H75a3 3 0 0 1-3-3z"/>
  <path class="sheet-lines" d="M42 34h34M42 44h34M42 54h34M56 64h20"/>
</svg>`;

function drawing(svg) {
  const holder = document.createElement('span');
  holder.innerHTML = svg;
  return holder.firstChild;
}

/* ---------- The screen ---------- */

const root = h('section', { class: 'screen', id: 'home', hidden: true });
const scrollBox = h('div', { class: 'scroll' });
const heroDate = h('div', { class: 'hero-date' });
const setupBox = h('div');
const allTemplatesBtn = h('button', { class: 'section-link', onClick: () => startLetter({ allTemplates: true }) });
const quickRow = h('div', { class: 'quick-row' });
const goalBox = h('div');
const search = h('input', {
  type: 'search',
  placeholder: 'جستجو: نام، شماره یا هر کلمه از متن',
  'aria-label': 'جستجو در نامه‌ها',
  enterkeyhint: 'search',
  onInput: paintList,
  // The results are already on screen, so the keyboard's search key only has to get out of their way.
  onKeydown: (e) => {
    if (e.key === 'Enter') search.blur();
  },
});
const clearSearch = h('button', {
  class: 'search-clear',
  'aria-label': 'پاک کردن جستجو',
  hidden: true,
  onClick: (e) => {
    e.preventDefault();
    search.value = '';
    paintList();
    search.focus();
  },
}, icon('close'));
const searchBox = h('label', { class: 'search-box' }, icon('search'), search, clearSearch);
const archiveTitle = h('h2');
const filterBox = h('div', { class: 'filters' });
const list = h('div');
const themeBtn = h('button', { class: 'icon-btn', 'aria-label': 'حالت تیره یا روشن', title: 'حالت تیره یا روشن', onClick: toggleTheme });

let filter = 'all';
let firstShow = true;

scrollBox.append(
  h(
    'div',
    { class: 'home-body' },
    h(
      'div',
      { class: 'home-start' },
      h(
        'section',
        { class: 'hero' },
        drawing(HERO_SHEET),
        heroDate,
        h('h2', { class: 'hero-title' }, 'امروز چه نامه‌ای می‌نویسی؟'),
        h('button', { class: 'hero-cta', onClick: () => startLetter() }, icon('plus'), 'نامهٔ جدید'),
      ),
      setupBox,
      h('div', { class: 'section-head' }, h('h2', null, 'شروع سریع'), allTemplatesBtn),
      quickRow,
      goalBox,
    ),
    searchBox,
    h('div', { class: 'section-head archive-head' }, archiveTitle, filterBox),
    list,
  ),
);

root.append(
  h(
    'header',
    { class: 'topbar' },
    drawing(LOGO),
    h('div', { class: 'home-brand' }, h('h1', { class: 'brand' }, 'نامه‌یار'), h('small', null, 'نامه‌نگاری اداری، زیر یک دقیقه')),
    themeBtn,
    h('button', { class: 'icon-btn', 'aria-label': 'تنظیمات', title: 'تنظیمات', onClick: () => showScreen('settings') }, icon('gear')),
  ),
  scrollBox,
);

function paintThemeButton() {
  themeBtn.replaceChildren(icon(isDark() ? 'sun' : 'moon'));
}

function toggleTheme() {
  setTheme(isDark() ? 'light' : 'dark');
  paintThemeButton();
}

/** Starts a letter; a template, or the list of all templates, can open with it so the letter type costs only that one tap. */
function startLetter(how = {}) {
  if (how.template?.whole) {
    startFromForm(how.template);
    return;
  }
  app.letter = newLetter(app.settings);
  showScreen('compose', { fresh: true, ...how });
}

/* ---------- Opening a Word or PDF file ---------- */

async function chooseLetterFile() {
  const file = await pickFile(LETTER_FILE_ACCEPT);
  if (file) openLetterFile(new Uint8Array(await file.arrayBuffer()), file.name);
}

function openedMessage(letter, isPdf) {
  if (letter.importInfo?.exact) return 'صفحه‌ها با همان شکل و اندازهٔ PDF باز شد. هر سطر و هر عکس جداگانه قابل ویرایش است.';
  if (letter.importInfo?.warnings.includes('picture')) return 'نامه وارد شد؛ یک یا چند عکس خوانده نشد.';
  if (isPdf) return 'PDF به نامهٔ قابل ویرایش تبدیل شد. از «خروجی» می‌توانی فایل Word بگیری.';
  return 'نامه وارد شد. هر بخش را می‌توانی ویرایش یا جابه‌جا کنی.';
}

/** Opens a Word or PDF file, from the picker or from another app's "open with", on the real page. */
export async function openLetterFile(bytes, name) {
  if (/\.doc$/i.test(name || '')) {
    toast('فایل‌های قدیمی .doc را در Word با «Save As» به .docx تبدیل کنید، بعد وارد کنید.', 5000);
    return;
  }
  await withBusy('در حال خواندن فایل...', async (say) => {
    try {
      const { imageTypeOf, importPdf, isPdfBytes, letterFromPhoto } = await import('../import-pdf.js');
      const isPdf = isPdfBytes(bytes);
      const photo = imageTypeOf(bytes);
      const onProgress = (done, total) => say(`در حال آماده کردن صفحهٔ ${toFaDigits(String(done))} از ${toFaDigits(String(total))}...`);
      const letter = photo ? await letterFromPhoto(bytes, app.settings, photo) : isPdf ? await importPdf(bytes, app.settings, { onProgress }) : await importDocx(bytes, app.settings);
      letter.sourceName = (name || '').replace(/\.(docx|pdf|jpe?g|png|webp)$/i, '');
      backToHome();
      app.letter = letter;
      saveLetterNow(letter);
      showScreen('compose', { fresh: false });
      showScreen('page');
      if (letter.importInfo?.scanned) offerReading(letter);
      else toast(openedMessage(letter, isPdf), 4000);
    } catch (err) {
      console.error(err);
      toast('این فایل خوانده نشد. فقط فایل‌های .docx، PDF و عکس پشتیبانی می‌شوند.', 4000);
    }
  });
}

/* A file sent from another app arrives through Android while this page is already running or still starting. */
window.__fileArrived = () => {
  const N = window.NamehyarNative;
  // While the app is still starting the file waits; the end of the start-up asks for it again.
  if (!N?.takePendingFile || !app.stack.length) return;
  const dataUrl = N.takePendingFile();
  if (!dataUrl) return;
  openLetterFile(dataUrlToBytes(`data:application/octet-stream;base64,${dataUrl}`).bytes, N.pendingFileName());
};

/* ---------- Above the archive ---------- */

function paintSetup() {
  const s = app.settings;
  setupBox.textContent = '';
  if (s.signer.name && (s.letterhead.logo || s.letterhead.org.some((line) => line && line !== 'مرکز رشد'))) return;
  setupBox.append(
    h(
      'button',
      { class: 'home-tile setup', onClick: () => showScreen('settings') },
      h('span', { class: 'tile-icon' }, icon('sign')),
      h('span', { class: 'tile-text' }, h('b', null, 'سربرگ و امضای خودت را وارد کن'), h('small', null, 'فقط یک بار؛ بعد هر نامه خودکار پر می‌شود')),
      icon('chevron'),
    ),
  );
}

function paintQuick() {
  const uses = app.settings.templateUses || {};
  const all = [...app.templates, ...TEMPLATES];
  // «نامهٔ آزاد» is the same as the big button, so it does not need a tile of its own.
  const shown = all.filter((t) => t.id !== 'blank').sort((a, b) => (uses[b.id] || 0) - (uses[a.id] || 0)).slice(0, QUICK_TILES);
  allTemplatesBtn.replaceChildren(`همهٔ قالب‌ها (${toFaDigits(all.length)})`, icon('chevron'));
  quickRow.replaceChildren(
    h(
      'button',
      { class: 'quick-tile import', onClick: chooseLetterFile },
      h('span', { class: 'tile-icon' }, icon('word')),
      h('span', { class: 'quick-title' }, 'از Word، PDF یا عکس'),
    ),
    ...shown.map((t) => h(
      'button',
      { class: 'quick-tile', onClick: () => startLetter({ template: t }) },
      h('span', { class: 'tile-icon' }, icon(TEMPLATE_ICONS[t.id] || 'page')),
      h('span', { class: 'quick-title' }, t.title),
    )),
  );
}

function savedTimeText(seconds) {
  const minutes = seconds / 60;
  if (minutes < 60) return `${toFaDigits(Math.round(minutes))} دقیقه`;
  const rounded = Math.round(minutes / 5) * 5;
  const rest = rounded % 60;
  return toFaDigits(`${Math.floor(rounded / 60)} ساعت${rest ? ` و ${rest} دقیقه` : ''}`);
}

/** The goal the app exists for, measured on the user's own letters. */
function paintGoal() {
  goalBox.textContent = '';
  const timed = app.letters.filter((l) => l.durationSec);
  if (!timed.length) return;
  const average = timed.reduce((sum, l) => sum + l.durationSec, 0) / timed.length;
  const under = timed.filter((l) => l.durationSec <= GOAL_SEC).length;
  const saved = timed.reduce((sum, l) => sum + Math.max(0, OLD_WAY_SEC - l.durationSec), 0);
  goalBox.append(
    h(
      'section',
      { class: 'goal' },
      h('div', { class: 'goal-head' }, h('b', null, `${toFaDigits(under)} از ${toFaDigits(timed.length)} نامه زیر یک دقیقه`), h('span', null, `میانگین ${formatSeconds(average)}`)),
      h('div', { class: 'goal-meter', 'aria-hidden': 'true' }, h('span', { style: { width: `${(under / timed.length) * 100}%` } })),
      saved >= 60 && h('small', null, `حدود ${savedTimeText(saved)} کمتر از روش قبل (۱۰ دقیقه برای هر نامه)`),
    ),
  );
}

/* ---------- The archive ---------- */

function paintFilters() {
  const drafts = app.letters.filter((l) => l.status === 'draft').length;
  const options = [
    { id: 'all', label: 'همه', count: app.letters.length },
    { id: 'draft', label: 'پیش‌نویس', count: drafts },
    { id: 'done', label: 'آماده', count: app.letters.length - drafts },
  ];
  filterBox.textContent = '';
  if (!app.letters.length) return;
  filterBox.append(
    ...options.map((opt) => h('button', {
      class: `chip${filter === opt.id ? ' on' : ''}`,
      onClick: () => {
        filter = opt.id;
        paintFilters();
        paintList();
      },
    }, opt.label, h('span', null, toFaDigits(opt.count)))),
  );
}

function highlight(snippet, query) {
  // The key folds spelling, so the match is shown by locating the raw words when possible.
  const i = snippet.indexOf(query);
  if (i < 0) return [snippet];
  return [snippet.slice(0, i), h('mark', null, snippet.slice(i, i + query.length)), snippet.slice(i + query.length)];
}

function letterMatches(letter, key) {
  return searchKey(`${letter.subject}\n${letter.recipient?.title || ''}\n${plainTextOf(letter)}`).includes(key);
}

function snippetFor(letter, query, key) {
  const lines = plainTextOf(letter).split('\n');
  const hit = lines.find((line) => searchKey(line).includes(key)) || '';
  if (hit.length <= 70) return hit;
  const at = Math.max(0, hit.indexOf(query) - 25);
  return `…${hit.slice(at, at + 70)}…`;
}

/** The heading a letter falls under, by when it was last worked on. */
function whenLabel(letter, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = letter.updatedAt || letter.createdAt || 0;
  const day = 24 * 60 * 60 * 1000;
  if (at >= today) return 'امروز';
  if (at >= today - day) return 'دیروز';
  if (at >= today - 6 * day) return 'هفتهٔ اخیر';
  return jalaliMonth(new Date(at));
}

function letterLine(letter, query = '', key = '') {
  const draft = letter.status === 'draft';
  const title = letter.subject || letter.sourceName;
  const snippet = key ? snippetFor(letter, query, key) : '';
  return h(
    'div',
    { class: 'letter-line' },
    h(
      'button',
      { class: 'letter-row', onClick: () => openLetter(letter) },
      h('span', { class: `letter-mark${draft ? ' draft' : ''}` }, icon(draft ? 'pencil' : 'pageDone')),
      h(
        'span',
        { class: 'letter-text' },
        h('b', { class: title ? null : 'untitled' }, title || 'بدون موضوع'),
        h(
          'small',
          { class: 'letter-meta' },
          // The subject needs the room, so a draft says what it is in place of its date.
          draft && h('em', null, 'پیش‌نویس'),
          h('span', null, letter.recipient?.name || letter.recipient?.title || 'بدون گیرنده'),
          !draft && h('i', null, letter.date),
        ),
        snippet && h('small', { class: 'letter-snippet' }, highlight(snippet, query)),
      ),
    ),
    h('button', { class: 'icon-btn', 'aria-label': 'گزینه‌های نامه', onClick: () => openLetterMenu(letter) }, icon('dots')),
  );
}

function emptyState(query) {
  if (query) return h('div', { class: 'empty' }, icon('search'), h('b', null, 'نامه‌ای با این عبارت پیدا نشد'), h('small', null, 'بخشی از کلمه یا شماره را امتحان کن.'));
  if (!app.letters.length) {
    return h(
      'div',
      { class: 'empty' },
      drawing(EMPTY_SHEETS),
      h('b', null, 'هنوز نامه‌ای نساخته‌ای'),
      h('small', null, 'هر نامه اینجا می‌ماند و با نام، شماره یا هر کلمه از متنش پیدا می‌شود.'),
    );
  }
  return h('div', { class: 'empty' }, h('b', null, filter === 'draft' ? 'پیش‌نویسی نداری' : 'هنوز نامه‌ای آماده نشده'));
}

function paintList() {
  const query = search.value.trim();
  const key = searchKey(query);
  // While searching only the results matter: with the keyboard open there is little room for anything else.
  if (root.classList.contains('searching') !== !!key) {
    root.classList.toggle('searching', !!key);
    scrollBox.scrollTop = 0;
  }
  clearSearch.hidden = !search.value;
  searchBox.hidden = !app.letters.length && !query;
  let letters = key ? app.letters.filter((l) => letterMatches(l, key)) : app.letters;
  if (filter !== 'all') letters = letters.filter((l) => (l.status === 'draft') === (filter === 'draft'));
  archiveTitle.textContent = !key ? 'بایگانی نامه‌ها' : letters.length ? `${toFaDigits(letters.length)} نامه پیدا شد` : 'نتیجهٔ جستجو';
  list.textContent = '';
  if (!letters.length) {
    list.append(emptyState(query));
    return;
  }
  if (key) {
    list.append(h('div', { class: 'letter-group found' }, letters.map((letter) => letterLine(letter, query, key))));
    return;
  }
  let label = null;
  let group = null;
  for (const letter of [...letters].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    const when = whenLabel(letter);
    if (when !== label) {
      label = when;
      group = h('div', { class: 'letter-group' });
      list.append(h('h3', { class: 'letter-when' }, label), group);
    }
    group.append(letterLine(letter));
  }
}

function openLetter(letter) {
  app.letter = letter;
  showScreen('compose', { fresh: false });
  // A form is worked on where it stands, on its page.
  if (letter.importInfo?.form) showScreen('page');
}

/**
 * A new letter that answers one: to whoever signed it when it came from outside, or a follow-up to the same person when it was written here.
 * What the template asks about the first letter is taken from it, so only the answer itself is left to write.
 */
function replyTo(source) {
  const incoming = !!source.imported;
  const who = (incoming ? source.signer : source.recipient) || {};
  const saved = app.recipients.find((r) => who.name && r.name === who.name);
  const letter = newLetter(app.settings);
  letter.recipient = { name: who.name || '', title: who.title || '' };
  if (saved) {
    letter.recipientId = saved.id;
    letter.rank = saved.rank;
  } else if (!incoming && source.rank) letter.rank = source.rank;
  letter.subject = source.subject || '';
  app.letter = letter;
  showScreen('compose', {
    fresh: true,
    template: TEMPLATES.find((t) => t.id === (incoming ? 'reply' : 'followup')),
    fillIn: { شماره: source.number, تاریخ: source.date },
  });
}

function openLetterMenu(letter) {
  const close = openSheet(
    letter.subject || letter.sourceName || 'نامه',
    h(
      'div',
      null,
      h('button', {
        class: 'sheet-action',
        onClick: () => {
          close();
          openLetter(letter);
        },
      }, icon('pencil'), 'باز کردن'),
      h('button', {
        class: 'sheet-action',
        onClick: () => {
          close();
          app.letter = copyOfLetter(letter);
          saveLetterNow(app.letter);
          showScreen('compose', { fresh: false });
          toast('یک نامهٔ تازه از روی این نامه ساخته شد');
        },
      }, icon('copy'), 'نامهٔ مشابه: ساخت نامهٔ تازه از روی این نامه'),
      !letter.importInfo?.form && h('button', {
        class: 'sheet-action',
        onClick: () => {
          close();
          replyTo(letter);
        },
      }, icon('reply'), letter.imported ? 'پاسخ به این نامه' : 'پیگیری این نامه'),
      h('button', {
        class: 'sheet-action danger',
        onClick: () => {
          close();
          confirmSheet('حذف نامه', `نامهٔ «${letter.subject || 'بدون موضوع'}» برای همیشه حذف می‌شود.`, 'حذف شود', async () => {
            await deleteLetter(letter.id);
            homeScreen.show();
          });
        },
      }, icon('trash'), 'حذف'),
    ),
  );
}

export const homeScreen = {
  root,
  show() {
    heroDate.textContent = jalaliLongDate();
    paintThemeButton();
    paintSetup();
    paintQuick();
    paintGoal();
    paintFilters();
    paintList();
    // The sheet rises only when the app opens, not on every return to this screen.
    if (firstShow) {
      firstShow = false;
      root.classList.add('arriving');
      setTimeout(() => root.classList.remove('arriving'), 800);
    }
  },
  /** Android back leaves a search before it leaves the app. */
  onBack() {
    if (!search.value) return false;
    search.value = '';
    search.blur();
    paintList();
    return true;
  },
};
