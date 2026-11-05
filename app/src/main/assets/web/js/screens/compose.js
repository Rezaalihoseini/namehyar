// The letter form: designed so a letter takes under a minute. Recipient and letter type are one tap,
// everything else fills itself in, and the user only types into the highlighted blanks.

import { h, clone, debounce, toast, keepFocus, uid } from '../util.js';
import { icon } from '../icons.js';
import { app, backButton, confirmSheet, dropWaitingSave, openSheet, saveLetter, saveLetterNow, saveRecipient, saveSettings, saveTemplate, segmented, showScreen } from '../app.js';
import { RANKS, GREETINGS, CLOSINGS, PHRASES, phrasesFor, fillPronoun } from '../data/phrases.js';
import { TEMPLATES, TEMPLATE_GROUPS } from '../data/templates.js';
import { deleteNote, openDeleteSheet, openPasteTableSheet, openTableSheet, openTableSwapSheet } from '../table-tools.js';
import { columnCount, columnsOf, deleteColumns, deleteFrom, deleteRows, dropEmptyTables, dropTable, insertColumn, insertRow, placeOfCell, rowsOf } from '../table-edit.js';
import { serializeEditor, textToEditorHtml, inlineHtml, cleanupBlanks, cleanupCopies, selectNextBlank, blanksIn, isBlank, selectElement, tableHtml, tableHtmlOf, editorHtml, setEditorHtml, markBlanks, blocksToHtml } from '../editor.js';
import { layoutLetter, PAGE_PX } from '../render.js';
import { syncAttachment } from '../model.js';
import { ensureMedia, mediaIdsOf } from '../store.js';
import { formatSeconds, toFaDigits } from '../text.js';
import { openExportSheet } from './export-sheet.js';
import { openFillSheet, startFromForm } from './fill-sheet.js';
import { openReviewSheet } from './read-flow.js';
import { fillBlanks } from '../restyle.js';

const root = h('section', { class: 'screen', id: 'compose', hidden: true });

let bodyDirty = false;
let startedFresh = false;
let templateSubject = '';
let composing = false;
let lastRange = null;
let openPanel = null;

const L = () => app.letter;

/* ---------- Form elements ---------- */

const timerEl = h('div', { class: 'timer', title: 'زمان ساخت این نامه' });
const titleEl = h('h1', null, 'نامهٔ جدید');

const recipientChips = h('div', { class: 'chips' });
const recipientCard = h('div');
const templateChips = h('div', { class: 'chips wrap' });

const subjectInput = h('input', {
  class: 'input',
  placeholder: 'موضوع نامه را بنویسید',
  enterkeyhint: 'next',
  onInput: (e) => {
    L().subject = e.target.value;
    touch();
  },
  onChange: fillSubjectBlanks,
  onKeydown: (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    fillSubjectBlanks();
    focusEditor();
  },
});

const greetingInput = h('input', {
  class: 'input plain',
  'aria-label': 'شروع نامه',
  onInput: (e) => {
    L().greeting = e.target.value;
    L().greetingEdited = true;
    touch();
  },
});

const editor = h('div', { class: 'editor', contenteditable: 'true', dir: 'rtl', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'متن نامه', spellcheck: 'false' });

const closingInput = h('input', {
  class: 'input plain',
  'aria-label': 'پایان نامه',
  placeholder: 'جملهٔ پایانی (اختیاری)',
  onInput: (e) => {
    L().closing = e.target.value;
    L().closingEdited = true;
    touch();
  },
});

const numberInput = h('input', { class: 'input', placeholder: 'اگر اتوماسیون می‌دهد، خالی بگذارید', onInput: (e) => { L().number = e.target.value; touch(); } });
const dateInput = h('input', { class: 'input', onInput: (e) => { L().date = e.target.value; touch(); } });
const attachmentSeg = segmented(
  [{ id: 'ندارد', label: 'ندارد' }, { id: 'دارد', label: 'دارد' }],
  'ندارد',
  (v) => {
    L().attachment = v;
    L().attachmentManual = true;
    touch();
  },
);
const ccInput = h('textarea', { class: 'textarea', placeholder: 'هر گیرندهٔ رونوشت در یک خط', onInput: (e) => { L().cc = e.target.value; touch(); } });

const details = h(
  'details',
  { class: 'more' },
  h('summary', null, 'شماره، تاریخ، پیوست و رونوشت'),
  h(
    'div',
    { class: 'inner' },
    h('div', { class: 'row2' },
      h('label', null, h('div', { class: 'mini-label' }, 'شماره'), numberInput),
      h('label', null, h('div', { class: 'mini-label' }, 'تاریخ'), dateInput)),
    h('div', null, h('div', { class: 'mini-label' }, 'پیوست'), attachmentSeg),
    h('label', null, h('div', { class: 'mini-label' }, 'رونوشت'), ccInput),
  ),
);

const live = h('button', { class: 'live', 'aria-label': 'نمایش صفحه', onClick: () => goToPage() });

const form = h(
  'div',
  { class: 'compose-form' },
  h('div', { class: 'label' }, 'گیرنده'),
  recipientChips,
  recipientCard,
  h('div', { class: 'label' }, 'نوع نامه'),
  templateChips,
  h('div', { class: 'label' }, 'موضوع'),
  h('div', { class: 'pad' }, subjectInput),
  h('div', { class: 'label' }, 'متن نامه'),
  h('div', { class: 'pad', style: { marginBottom: '6px' } }, greetingInput),
  editor,
  h('div', { class: 'pad', style: { marginTop: '6px' } }, closingInput),
  details,
);

/* ---------- Bars ---------- */

const actionBar = h(
  'div',
  { class: 'bottombar' },
  h('button', { class: 'btn', onClick: () => goToPage() }, icon('page'), 'صفحه و چیدمان'),
  h('button', { class: 'btn primary grow', onClick: () => goExport() }, icon('share'), 'خروجی نامه'),
);

const fillAllBtn = h('button', { class: 'btn primary', onClick: () => openFillAll() }, icon('form'), 'پر کردن همهٔ جاهای خالی');
const fillBar = h('div', { class: 'fill-bar', hidden: true }, fillAllBtn);
const reviewBtn = h('button', { class: 'btn', onClick: () => openReview() }, icon('search'), 'بازبینی کلمه‌های مشکوک');
const reviewBar = h('div', { class: 'fill-bar', hidden: true }, reviewBtn);

const nextBlankBtn = keepFocus(h('button', { class: 'btn primary', onClick: () => nextBlank() }, 'جای خالی بعدی', icon('next')));
const fmtButton = (name, label, fn) => keepFocus(h('button', { class: 'icon-btn', 'aria-label': label, dataset: { fmt: name }, onClick: fn }, icon(name)));
const exec = (cmd) => () => {
  document.execCommand(cmd);
  paintFmtState();
};

const fmtBar = h(
  'div',
  { class: 'fmtbar', hidden: true },
  nextBlankBtn,
  keepFocus(h('button', { class: 'btn', onClick: () => togglePanel('phrases') }, icon('phrases'), 'عبارت‌ها')),
  h('span', { class: 'sep' }),
  fmtButton('bold', 'توپر', exec('bold')),
  fmtButton('underline', 'زیرخط', exec('underline')),
  h('span', { class: 'sep' }),
  fmtButton('alignRight', 'راست‌چین', exec('justifyRight')),
  fmtButton('alignCenter', 'وسط‌چین', exec('justifyCenter')),
  fmtButton('alignLeft', 'چپ‌چین', exec('justifyLeft')),
  fmtButton('alignJustify', 'تراز دو طرف', exec('justifyFull')),
  h('span', { class: 'sep' }),
  fmtButton('table', 'جدول', () => togglePanel('table')),
);

const panel = h('div', { class: 'panel', hidden: true });

root.append(
  h('header', { class: 'topbar' }, backButton(), titleEl, timerEl),
  h('div', { class: 'compose-body' }, form, live),
  panel,
  fmtBar,
  fillBar,
  reviewBar,
  actionBar,
);

/* ---------- Saving and the live page ---------- */

function touch() {
  saveLetter();
  scheduleLive();
}

const syncBody = () => {
  if (!L()) return;
  L().body = serializeEditor(editor);
  L().bodyHtml = editorHtml(editor);
  L().bodyDirty = bodyDirty;
  if (!L().attachmentManual) {
    syncAttachment(L());
    attachmentSeg.setValue(L().attachment);
  }
  touch();
  paintNextBlank();
};
// Snapshot the current input synchronously; only painting and the final archive
// write are delayed. This includes the last input of an IME composition.
syncBody.flush = syncBody;
document.addEventListener('namehyar-flush-editor', () => { if (!root.hidden) syncBody(); });

function paintLive() {
  if (root.hidden || !L()) return;
  const { pages } = layoutLetter(L(), { preview: true });
  live.textContent = '';
  const wide = matchMedia('(min-width: 900px)').matches;
  const k = wide ? Math.min(1, (live.clientWidth - 40) / PAGE_PX.w) : live.clientWidth / PAGE_PX.w;
  for (const page of wide ? pages : pages.slice(0, 1)) {
    page.style.transform = `scale(${k})`;
    live.append(h('div', { class: 'live-page', style: { width: `${PAGE_PX.w * k}px`, height: `${PAGE_PX.h * k}px` } }, page));
  }
}
const scheduleLive = debounce(paintLive, 220);

/* ---------- Recipient ---------- */

function sortedRecipients() {
  return [...app.recipients].sort((a, b) => (b.uses || 0) - (a.uses || 0) || (b.lastUsed || 0) - (a.lastUsed || 0));
}

function paintRecipients() {
  recipientChips.textContent = '';
  for (const rec of sortedRecipients()) {
    recipientChips.append(
      h('button', { class: `chip${L().recipientId === rec.id ? ' on' : ''}`, onClick: () => pickRecipient(rec) }, rec.title || rec.name),
    );
  }
  recipientChips.append(h('button', { class: 'chip add', onClick: () => openRecipientSheet() }, '+ گیرندهٔ جدید'));

  recipientCard.textContent = '';
  if (!L().recipient.name && !L().recipient.title) return;
  recipientCard.append(
    h(
      'div',
      { class: 'recipient-card' },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('div', { style: { flex: 1, minWidth: 0 } }, h('b', null, L().recipient.name), h('small', null, L().recipient.title)),
        h('button', { class: 'btn small', onClick: () => openRecipientSheet(L().recipient, true) }, 'ویرایش'),
      ),
      segmented(RANKS, L().rank, (rank) => changeRank(rank)),
    ),
  );
}

function pickRecipient(rec) {
  const previous = L().rank;
  L().recipientId = rec.id;
  L().recipient = { name: rec.name, title: rec.title };
  L().rank = rec.rank || 'superior';
  paintRecipients();
  applyAuto(previous);
  saveLetter();
}

function changeRank(rank) {
  const previous = L().rank;
  L().rank = rank;
  const saved = app.recipients.find((r) => r.id === L().recipientId);
  if (saved && saved.rank !== rank) saveRecipient({ ...saved, rank });
  applyAuto(previous);
  saveLetter();
}

const NAME_PREFIXES = ['جناب آقای', 'جناب آقای دکتر', 'سرکار خانم', 'سرکار خانم دکتر'];

function openRecipientSheet(existing, editingCurrent = false) {
  const nameInput = h('input', { class: 'input', placeholder: 'مثلاً: جناب آقای دکتر احمدی', value: existing?.name || '' });
  const titleInput = h('input', { class: 'input', placeholder: 'مثلاً: رئیس محترم پارک علم و فناوری', value: existing?.title || '' });
  let rank = L().rank;
  const remember = h('input', { type: 'checkbox', checked: true });
  remember.checked = true;
  const close = openSheet(
    editingCurrent ? 'ویرایش گیرنده' : 'گیرندهٔ جدید',
    h(
      'div',
      { class: 'form-grid' },
      h(
        'div',
        null,
        h('div', { class: 'mini-label' }, 'نام'),
        h(
          'div',
          { class: 'chips', style: { padding: '0 0 8px' } },
          NAME_PREFIXES.map((prefix) => h('button', {
            class: 'chip',
            type: 'button',
            onClick: () => {
              nameInput.value = `${prefix} `;
              nameInput.focus();
            },
          }, prefix)),
        ),
        nameInput,
      ),
      h('label', null, h('div', { class: 'mini-label' }, 'سمت'), titleInput),
      h('div', null, h('div', { class: 'mini-label' }, 'جایگاه گیرنده نسبت به شما'), segmented(RANKS, rank, (v) => { rank = v; })),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, remember, 'برای نامه‌های بعدی هم ذخیره شود'),
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          const name = nameInput.value.trim();
          const title = titleInput.value.trim();
          if (!name && !title) {
            toast('نام یا سمت گیرنده را بنویسید');
            return;
          }
          const saved = editingCurrent && app.recipients.find((r) => r.id === L().recipientId);
          const rec = saved ? { ...saved, name, title, rank } : { id: uid(), name, title, rank, uses: 0 };
          if (remember.checked) await saveRecipient(rec);
          close();
          pickRecipient(rec);
          if (!remember.checked) {
            L().recipientId = null;
            paintRecipients();
          }
        },
      }, 'تأیید'),
    ),
  );
}

/* ---------- Letter type and automatic text ---------- */

const VISIBLE_TEMPLATES = 8;

/** The most used letter types come first, so the usual one stays one tap away however many there are. */
function paintTemplates() {
  const uses = app.settings.templateUses || {};
  const all = [...app.templates, ...TEMPLATES];
  const sorted = [...all].sort((a, b) => (uses[b.id] || 0) - (uses[a.id] || 0));
  let shown = sorted.slice(0, VISIBLE_TEMPLATES);
  const current = all.find((t) => t.id === L().templateId);
  if (current && !shown.includes(current)) shown = [current, ...shown.slice(0, VISIBLE_TEMPLATES - 1)];
  templateChips.textContent = '';
  for (const t of shown) {
    templateChips.append(h('button', { class: `chip${L().templateId === t.id ? ' on' : ''}`, onClick: () => pickTemplate(t) }, t.title));
  }
  templateChips.append(h('button', { class: 'chip more', onClick: openAllTemplates }, `همهٔ قالب‌ها (${toFaDigits(all.length)})`));
  templateChips.append(h('button', { class: 'chip add', onClick: openSaveTemplate }, '+ ذخیره به‌عنوان قالب'));
}

function templatePreview(t) {
  const text = t.bodyHtml !== undefined ? (t.body || []).map((b) => (b.runs || []).map((r) => r.text || '').join('')).join(' ') : t.body[L().rank] || t.body.superior || '';
  return fillPronoun(text.split('\n')[0], L().recipient.name, L().rank);
}

function openAllTemplates() {
  const row = (t, close) => h(
    'button',
    {
      class: 'template-row',
      onClick: () => {
        close();
        pickTemplate(t);
      },
    },
    h('b', null, t.title),
    h('small', null, templatePreview(t) || 'برگهٔ خالی'),
  );
  const box = h('div');
  const close = openSheet('همهٔ قالب‌ها', box);
  if (app.templates.length) {
    box.append(h('div', { class: 'template-group' }, 'قالب‌های من'), ...app.templates.map((t) => row(t, close)));
  }
  for (const group of TEMPLATE_GROUPS) {
    box.append(h('div', { class: 'template-group' }, group.title), ...TEMPLATES.filter((t) => t.group === group.id).map((t) => row(t, close)));
  }
}

function setBody(text) {
  editor.innerHTML = textToEditorHtml(text);
  bodyDirty = false;
  L().body = serializeEditor(editor);
  L().bodyHtml = editorHtml(editor);
  paintNextBlank();
}

/** A template the user saved: it brings its own words and, if it was arranged, its own layout. */
async function applySavedTemplate(t) {
  const letter = L();
  await ensureMedia(mediaIdsOf({ body: t.body || [] }));
  setEditorHtml(editor, t.bodyHtml || '');
  letter.body = serializeEditor(editor);
  letter.bodyHtml = editorHtml(editor);
  if (t.subject && !letter.subject) {
    letter.subject = t.subject;
    subjectInput.value = t.subject;
  }
  if (t.greeting) {
    letter.greeting = t.greeting;
    letter.greetingEdited = true;
    greetingInput.value = t.greeting;
  }
  if (t.closing) {
    letter.closing = t.closing;
    letter.closingEdited = true;
    closingInput.value = t.closing;
  }
  if (t.styles) letter.styles = clone(t.styles);
  if (t.offsets) letter.offsets = clone(t.offsets);
  if (t.geom) letter.geom = clone(t.geom);
  if (t.parts) letter.letterhead = { ...letter.letterhead, parts: clone(t.parts) };
  paintNextBlank();
  scheduleLive();
}

function openSaveTemplate() {
  syncBody.flush();
  if (!editor.textContent.trim()) {
    toast('اول متن قالب را بنویس. جاهای خالی را داخل [کروشه] بنویس.', 3600);
    return;
  }
  const nameInput = h('input', { class: 'input', placeholder: 'مثلاً: درخواست مرخصی', value: L().subject || '' });
  const close = openSheet(
    'ذخیره به‌عنوان قالب',
    h(
      'div',
      { class: 'form-grid' },
      h('label', null, h('div', { class: 'mini-label' }, 'نام قالب'), nameInput),
      h('p', { class: 'note', style: { margin: 0 } }, 'متن، شروع و پایان نامه و چیدمان صفحه ذخیره می‌شود. هر چیزی که هر بار فرق می‌کند را داخل [کروشه] بنویس تا جای خالی شود.'),
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          const title = nameInput.value.trim();
          if (!title) {
            toast('برای قالب یک نام بنویس');
            return;
          }
          const letter = L();
          markBlanks(editor);
          syncBody.flush();
          await saveTemplate({
            id: uid(),
            title,
            subject: letter.subject,
            greeting: letter.greeting,
            closing: letter.closing,
            bodyHtml: letter.bodyHtml,
            body: letter.body,
            styles: clone(letter.styles || {}),
            offsets: clone(letter.offsets || {}),
            geom: clone(letter.geom || {}),
            parts: clone(letter.letterhead?.parts || {}),
          });
          close();
          paintTemplates();
          toast(`قالب «${title}» ذخیره شد`);
        },
      }, 'ذخیره'),
    ),
  );
  nameInput.focus();
}

/** A new letter holding nothing but a template as it came is not worth keeping: a tile tapped by mistake must not leave a draft. */
function nothingOfTheirs() {
  const letter = L();
  return startedFresh && !bodyDirty && (letter.subject || '') === templateSubject && !letter.recipient.name && !letter.recipient.title;
}

function pickTemplate(t) {
  if (t.whole) return startFromForm(t);
  const apply = async () => {
    L().templateId = t.id;
    bodyDirty = false;
    app.settings.templateUses = { ...app.settings.templateUses, [t.id]: (app.settings.templateUses?.[t.id] || 0) + 1 };
    saveSettings();
    paintTemplates();
    const subjectBefore = L().subject;
    if (t.bodyHtml !== undefined) await applySavedTemplate(t);
    if (L().subject !== subjectBefore) templateSubject = L().subject;
    applyAuto(L().rank);
    if (!nothingOfTheirs()) saveLetter();
    if (!L().subject) subjectInput.focus();
    else focusEditor();
  };
  if (bodyDirty && editor.textContent.trim()) {
    const close = openSheet(
      'متن فعلی جایگزین شود؟',
      h(
        'div',
        { class: 'form-grid' },
        h('p', { style: { margin: 0 } }, 'متنی که نوشته‌اید با قالب «' + t.title + '» جایگزین می‌شود.'),
        h('button', { class: 'btn primary', onClick: () => { close(); apply(); } }, 'جایگزین کن'),
        h('button', { class: 'btn', onClick: () => close() }, 'متن فعلی بماند'),
      ),
    );
    return null;
  }
  return apply();
}

/** Fills everything that follows from the recipient and the letter type. */
function applyAuto(previousRank) {
  const letter = L();
  const t = TEMPLATES.find((x) => x.id === letter.templateId);
  const { rank } = letter;
  const name = letter.recipient.name;
  if (!letter.greetingEdited) {
    letter.greeting = GREETINGS[rank];
    greetingInput.value = letter.greeting;
  }
  if (!letter.closingEdited) {
    const closing = t?.closing?.[rank] ?? CLOSINGS[rank];
    letter.closing = fillPronoun(closing, name, rank);
    closingInput.value = letter.closing;
  }
  if (t && !bodyDirty) {
    setBody(fillPronoun(t.body[rank], name, rank));
    fillSubjectBlanks();
  } else if (previousRank && previousRank !== rank) swapRankPhrases(previousRank, rank);
  scheduleLive();
}

/** When the recipient's rank changes after typing, the matching phrases follow it. */
function swapRankPhrases(from, to) {
  const pairs = [];
  for (const group of PHRASES.filter((g) => ['inform', 'request', 'closing', 'attachment'].includes(g.id))) {
    (group[from] || []).forEach((phrase, i) => {
      const target = group[to]?.[i];
      if (target && target !== phrase) pairs.push([fillPronoun(phrase, L().recipient.name, from), fillPronoun(target, L().recipient.name, to)]);
    });
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  let changed = false;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    let text = walker.currentNode.textContent;
    for (const [a, b] of pairs) {
      if (text.includes(a)) {
        text = text.split(a).join(b);
        changed = true;
      }
    }
    if (changed) walker.currentNode.textContent = text;
  }
  if (changed) {
    syncBody();
    toast('عبارت‌های متن با جایگاه گیرنده هماهنگ شد');
  }
}

function fillSubjectBlanks() {
  const subject = L().subject.trim();
  if (!subject) return;
  let changed = false;
  for (const el of blanksIn(editor)) {
    if (el.textContent === '[موضوع]' || el.textContent === '[موضوع گزارش]') {
      // The template already says «گزارش» before this blank.
      el.textContent = el.textContent === '[موضوع]' ? subject : subject.replace(/^گزارش\s+/, '');
      el.classList.remove('ph');
      changed = true;
    }
  }
  if (changed) syncBody();
}

/* ---------- Editor behaviour ---------- */

function focusEditor() {
  editor.focus();
  if (!selectNextBlank(editor)) {
    const sel = getSelection();
    sel.selectAllChildren(editor);
    sel.collapseToEnd();
  }
}

function nextBlank() {
  if (!selectNextBlank(editor)) toast('همهٔ جاهای خالی پر شده است');
}

function paintNextBlank() {
  const blanks = blanksIn(editor);
  nextBlankBtn.hidden = !blanks.length;
  const kinds = new Set(blanks.map((el) => el.textContent)).size;
  fillBar.hidden = !kinds;
  fillAllBtn.lastChild.textContent = `پر کردن ${toFaDigits(String(kinds))} جای خالی`;
  const unsure = L()?.ocr?.words?.length || 0;
  reviewBar.hidden = !unsure;
  reviewBtn.lastChild.textContent = `بازبینی ${toFaDigits(String(unsure))} کلمهٔ مشکوک`;
}

/** Words read from a scan that deserve a second look. */
function openReview() {
  syncNow();
  openReviewSheet(L(), {
    onDone: () => {
      refreshFromLetter();
      saveLetter();
    },
  });
}

/** Everything blank at once, instead of one by one in the text. */
function openFillAll() {
  syncNow();
  openFillSheet(L(), {
    onFill: (values) => {
      fillBlanks(L(), values);
      refreshFromLetter();
      saveLetter();
    },
  });
}

/** The form again, after the letter changed from outside it. */
function refreshFromLetter() {
  const letter = L();
  letter.bodyHtml = blocksToHtml(letter.body);
  setEditorHtml(editor, letter.bodyHtml);
  bodyDirty = true;
  fillFields(letter);
  paintRecipients();
  paintNextBlank();
  scheduleLive();
}

/** Blanks a reply can answer from the letter it answers. */
function fillInBlanks(values) {
  for (const el of blanksIn(editor)) {
    const words = values[el.textContent.slice(1, -1)];
    if (!words) continue;
    el.textContent = words;
    el.classList.remove('ph');
  }
  syncBody();
  paintNextBlank();
  focusEditor();
}

function paintFmtState() {
  if (!editorHasSelection()) return;
  for (const [name, cmd] of [['bold', 'bold'], ['underline', 'underline']]) {
    fmtBar.querySelector(`[data-fmt="${name}"]`).classList.toggle('on', document.queryCommandState(cmd));
  }
}

function editorHasSelection() {
  const sel = getSelection();
  return sel.rangeCount > 0 && editor.contains(sel.anchorNode);
}

function restoreCaret() {
  if (editorHasSelection()) return;
  editor.focus();
  if (lastRange) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(lastRange);
  }
}

function charBeforeCaret() {
  const sel = getSelection();
  if (!sel.rangeCount) return '';
  const r = sel.getRangeAt(0);
  return r.startContainer.nodeType === Node.TEXT_NODE ? r.startContainer.textContent[r.startOffset - 1] || '' : '';
}

function insertPhrase(text) {
  restoreCaret();
  const filled = fillPronoun(text, L().recipient.name, L().rank);
  const before = charBeforeCaret();
  const known = new Set(blanksIn(editor));
  document.execCommand('insertHTML', false, `${before && !/\s/.test(before) ? ' ' : ''}${inlineHtml(filled)} `);
  bodyDirty = true;
  closePanel();
  const fresh = blanksIn(editor).find((el) => !known.has(el));
  if (fresh) selectElement(fresh);
  syncBody();
}

function closePanel() {
  panel.hidden = true;
  panel.textContent = '';
  openPanel = null;
}

function togglePanel(kind) {
  if (openPanel === kind) {
    closePanel();
    return;
  }
  openPanel = kind;
  panel.hidden = false;
  if (kind === 'phrases') paintPhrases(lastGroup);
  else paintTablePanel();
}

let lastGroup = 'inform';

function openAddPhrase() {
  const selected = editorHasSelection() ? getSelection().toString().trim() : '';
  const input = h('textarea', { class: 'textarea', placeholder: 'عبارتی که زیاد می‌نویسی. جای خالی را داخل [کروشه] بنویس.', value: selected });
  const close = openSheet(
    'عبارت جدید',
    h(
      'div',
      { class: 'form-grid' },
      input,
      h('button', {
        class: 'btn primary',
        onClick: () => {
          const text = input.value.trim();
          if (!text) return;
          app.settings.phrases = [...(app.settings.phrases || []), text];
          saveSettings();
          close();
          toast('عبارت ذخیره شد');
          if (openPanel === 'phrases') paintPhrases('mine');
        },
      }, 'ذخیره'),
    ),
  );
  input.focus();
}

function myPhraseRows() {
  const mine = app.settings.phrases || [];
  const rows = mine.map((text, i) => h(
    'div',
    { class: 'mine-row' },
    keepFocus(h('button', { class: 'phrase', onClick: () => insertPhrase(text) }, text)),
    keepFocus(h('button', {
      class: 'icon-btn',
      'aria-label': 'حذف عبارت',
      onClick: () => {
        app.settings.phrases = mine.filter((_, k) => k !== i);
        saveSettings();
        paintPhrases('mine');
      },
    }, icon('trash'))),
  ));
  return [
    h('div', { class: 'panel-add' }, keepFocus(h('button', { class: 'btn small', onClick: openAddPhrase }, icon('plus'), 'عبارت جدید'))),
    ...rows,
  ];
}

function paintPhrases(groupId) {
  lastGroup = groupId;
  panel.textContent = '';
  const groups = [{ id: 'mine', title: 'عبارت‌های من' }, ...PHRASES];
  const group = groups.find((g) => g.id === groupId) || PHRASES[0];
  const tabs = h(
    'div',
    { class: 'panel-tabs' },
    h('div', { class: 'chips' }, groups.map((g) => keepFocus(h('button', { class: `chip${g.id === group.id ? ' on' : ''}`, onClick: () => paintPhrases(g.id) }, g.title)))),
  );
  if (group.id === 'mine') {
    panel.append(tabs, ...myPhraseRows());
    return;
  }
  const { main, other } = phrasesFor(group, L().rank);
  const phraseBtn = (text, isOther) => keepFocus(h('button', { class: `phrase${isOther ? ' other' : ''}`, onClick: () => insertPhrase(text) }, fillPronoun(text, L().recipient.name, L().rank)));
  panel.append(
    tabs,
    ...main.map((text) => phraseBtn(text, false)),
    ...(other.length ? [h('div', { class: 'panel-sub' }, 'برای جایگاه‌های دیگر')] : []),
    ...other.map((text) => phraseBtn(text, true)),
  );
}

function currentCell() {
  const sel = getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return null;
  const n = sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentNode : sel.anchorNode;
  return n.closest ? n.closest('td') : null;
}

function placeCaretIn(cell) {
  const sel = getSelection();
  const r = document.createRange();
  r.selectNodeContents(cell);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** The table of the letter behind a table of the form, with the form's latest words in it. */
function letterTableOf(tableEl) {
  syncBody.flush();
  const n = [...editor.querySelectorAll(':scope > table')].indexOf(tableEl);
  return (L().body || []).filter((b) => b.kind === 'table')[n] || null;
}

/** The form's text rebuilt from the letter, once a table has changed there. */
function rebuildEditor() {
  L().bodyHtml = blocksToHtml(L().body);
  setEditorHtml(editor, L().bodyHtml);
  bodyDirty = true;
  saveLetter();
  scheduleLive();
  paintNextBlank();
}

/** Changes a table through the letter, where merged cells and widths are known, and puts the caret back in the cell it was in or the nearest one. */
function changeTableAt(td, fn) {
  const tableEl = td.closest('table');
  const n = [...editor.querySelectorAll(':scope > table')].indexOf(tableEl);
  const r = td.parentNode.rowIndex;
  const c = td.cellIndex;
  const table = letterTableOf(tableEl);
  const cell = table?.rows[r]?.[c];
  if (!cell) return;
  const wanted = fn(table, cell) || cell;
  dropEmptyTables(L());
  rebuildEditor();
  const shown = editor.querySelectorAll(':scope > table')[n];
  if (!shown || !table.rows.length) return;
  const at = table.rows.findIndex((row) => row.includes(wanted));
  const y = at >= 0 ? at : Math.min(r, table.rows.length - 1);
  const x = at >= 0 ? table.rows[y].indexOf(wanted) : Math.min(c, table.rows[y].length - 1);
  const place = shown.rows[y]?.cells[Math.max(x, 0)];
  if (place) placeCaretIn(place);
}

/** Opens one of a table's sheets from the form. A sheet needs the screen, so the keyboard goes down first. */
function leaveEditorFor(tableEl, open) {
  const table = letterTableOf(tableEl);
  if (!table) return;
  editor.blur();
  closePanel();
  open(table);
}

let newRows = 3;
let newCols = 3;
let panelInCell = false; // The table panel offers a new table, or what can be done to the table the caret is in.

function paintTablePanel() {
  panel.textContent = '';
  const stepper = (label, get, set) => {
    const value = h('b', null, get());
    const change = (d) => {
      set(Math.min(12, Math.max(1, get() + d)));
      value.textContent = get();
    };
    return h(
      'span',
      { class: 'stepper' },
      label,
      keepFocus(h('button', { class: 'icon-btn', 'aria-label': `کم کردن ${label}`, onClick: () => change(-1) }, icon('minus'))),
      value,
      keepFocus(h('button', { class: 'icon-btn', 'aria-label': `زیاد کردن ${label}`, onClick: () => change(1) }, icon('plus'))),
    );
  };
  panelInCell = !!currentCell();
  if (panelInCell) {
    const edit = (fn) => () => {
      // The caret may have gone to another cell since the panel opened.
      const cell = currentCell();
      if (cell) changeTableAt(cell, fn);
      if (openPanel === 'table') paintTablePanel();
    };
    /** Opens a sheet for the cell the caret is in, its place being all that lasts once the form's words are read into the letter. */
    const forCell = (open) => () => {
      const cell = currentCell();
      if (!cell) return;
      const r = cell.parentNode.rowIndex;
      const c = cell.cellIndex;
      leaveEditorFor(cell.closest('table'), (table) => open(table, table.rows[r]?.[c]));
    };
    panel.append(
      h(
        'div',
        { class: 'table-tools' },
        keepFocus(h('button', { class: 'btn small', onClick: edit((table, here) => {
          const place = placeOfCell(table, here);
          const at = place.r + place.rowSpan;
          insertRow(table, at);
          return table.rows[at]?.[0];
        }) }, '+ سطر')),
        keepFocus(h('button', { class: 'btn small', onClick: edit((table, here) => {
          const place = placeOfCell(table, here);
          insertColumn(table, place.col + place.span);
        }) }, '+ ستون')),
        // The last row or column goes only with the whole table, which is asked about on its own.
        keepFocus(h('button', { class: 'btn small', onClick: edit((table, here) => {
          const rows = rowsOf(table, [here]);
          if (rows.size < table.rows.length) deleteRows(table, rows);
        }) }, '− سطر')),
        keepFocus(h('button', { class: 'btn small', onClick: edit((table, here) => {
          const cols = columnsOf(table, [here]);
          if (cols.size < columnCount(table)) deleteColumns(table, cols);
        }) }, '− ستون')),
        keepFocus(h('button', {
          class: 'btn small',
          onClick: forCell((table, here) => {
            if (!here) return;
            openDeleteSheet([{ table, cells: [here] }], {
              onPick: (how) => {
                const note = deleteFrom(table, [here], how);
                dropEmptyTables(L());
                rebuildEditor();
                toast(deleteNote([note]));
              },
            });
          }),
        }, icon('trash'), 'حذف خانه…')),
        keepFocus(h('button', {
          class: 'btn small',
          onClick: forCell((table, here) => openTableSheet(table, { picked: here ? [here] : [], after: rebuildEditor })),
        }, icon('table'), 'ابزار جدول')),
        keepFocus(h('button', { class: 'btn small', onClick: forCell((table) => openTableSwapSheet(table, { after: rebuildEditor })) }, icon('swap'), 'جابه‌جایی ستون و سطر')),
        keepFocus(h('button', {
          class: 'btn small danger',
          onClick: forCell((table) => {
            confirmSheet('حذف جدول', 'کل این جدول از نامه برداشته می‌شود.', 'حذف شود', () => {
              dropTable(L(), table);
              rebuildEditor();
              toast('جدول حذف شد');
            });
          }),
        }, 'حذف جدول')),
      ),
    );
    return;
  }
  panel.append(
    h(
      'div',
      { class: 'table-tools' },
      stepper('سطر', () => newRows, (v) => { newRows = v; }),
      stepper('ستون', () => newCols, (v) => { newCols = v; }),
      keepFocus(h('button', {
        class: 'btn small primary',
        onClick: () => {
          restoreCaret();
          document.execCommand('insertHTML', false, tableHtml(newRows, newCols));
          bodyDirty = true;
          closePanel();
          syncBody();
        },
      }, 'درج جدول')),
      keepFocus(h('button', {
        class: 'btn small',
        onClick: () => openPasteTableSheet((rows) => {
          restoreCaret();
          document.execCommand('insertHTML', false, tableHtmlOf(rows));
          bodyDirty = true;
          closePanel();
          syncBody();
        }),
      }, icon('clipboard'), 'از متن یا اکسل')),
    ),
  );
}

editor.addEventListener('compositionstart', () => { composing = true; });
editor.addEventListener('compositionend', () => {
  composing = false;
  cleanupBlanks(editor);
  cleanupCopies(editor);
  syncBody();
});
editor.addEventListener('input', (e) => {
  bodyDirty = true;
  if (!composing && !e.isComposing) {
    cleanupBlanks(editor);
    cleanupCopies(editor);
  }
  syncBody();
});
editor.addEventListener('click', (e) => {
  const blank = e.target.closest && e.target.closest('.ph');
  if (blank && isBlank(blank)) selectElement(blank);
});

document.addEventListener('selectionchange', () => {
  if (root.hidden || !editorHasSelection()) return;
  lastRange = getSelection().getRangeAt(0).cloneRange();
  paintFmtState();
  // The caret went into a table or out of one, with the panel open.
  if (openPanel === 'table' && !!currentCell() !== panelInCell) paintTablePanel();
});

function setEditorMode(on) {
  fmtBar.hidden = !on;
  actionBar.hidden = on;
  fillBar.classList.toggle('in-editor', on);
  reviewBar.classList.toggle('in-editor', on);
  if (!on) closePanel();
}

editor.addEventListener('focus', () => setEditorMode(true));
editor.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement !== editor) setEditorMode(false);
  }, 60);
});

root.addEventListener('focusin', () => root.classList.add('typing'));
root.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!root.contains(document.activeElement) || document.activeElement === document.body) root.classList.remove('typing');
  }, 60);
});

/* ---------- Timer: the goal is under a minute per letter ---------- */

function paintTimer() {
  const letter = L();
  if (!letter) return;
  const sec = letter.durationSec ?? letter.activeSec ?? 0;
  timerEl.replaceChildren(formatSeconds(sec));
  timerEl.classList.toggle('over', sec > 60);
}

setInterval(() => {
  const letter = L();
  if (!letter || letter.durationSec != null || document.hidden) return;
  const top = app.stack[app.stack.length - 1];
  if (top !== 'compose' && top !== 'page') return;
  letter.activeSec = (letter.activeSec || 0) + 1;
  paintTimer();
}, 1000);

/* ---------- Navigation ---------- */

function syncNow() {
  syncBody.flush();
  saveLetterNow();
}

function goToPage() {
  syncNow();
  showScreen('page');
}

function goExport() {
  syncNow();
  openExportSheet(L(), { onBlank: focusEditor, onDone: paintTimer, onFilled: refreshFromLetter });
}

/** Everything else on the form, which the page screen can change too. */
function fillFields(letter) {
  // A form opened from a file has no recipient, subject or greeting: only its own tables and words.
  root.classList.toggle('is-form', !!letter.importInfo?.form);
  subjectInput.value = letter.subject || '';
  numberInput.value = letter.number || '';
  dateInput.value = letter.date || '';
  ccInput.value = letter.cc || '';
  attachmentSeg.setValue(letter.attachment || 'ندارد');
  greetingInput.value = letter.greeting || '';
  closingInput.value = letter.closing || '';
}

async function loadIntoForm(fresh) {
  const letter = L();
  startedFresh = !!fresh;
  templateSubject = '';
  titleEl.textContent = fresh ? 'نامهٔ جدید' : letter.subject || letter.sourceName || 'ویرایش نامه';
  await ensureMedia(mediaIdsOf(letter));
  setEditorHtml(editor, letter.bodyHtml || '');
  bodyDirty = !!letter.bodyHtml && !letter.templateId ? true : !!letter.bodyDirty;
  fillFields(letter);
  details.open = false;
  closePanel();
  setEditorMode(false);
  paintRecipients();
  paintTemplates();
  if (fresh) applyAuto(null);
  greetingInput.value = letter.greeting || '';
  closingInput.value = letter.closing || '';
  paintNextBlank();
  paintTimer();
  paintLive();
}

export const composeScreen = {
  root,
  focusBlank: focusEditor,
  /** Puts the caret in one paragraph of the body, or just in the body when no paragraph is given. */
  focusBody(index = -1) {
    editor.focus();
    const target = index >= 0 ? editor.children[index] : null;
    if (target) {
      const sel = getSelection();
      sel.selectAllChildren(target);
      sel.collapseToEnd();
    }
    (target || editor).scrollIntoView({ block: 'center' });
  },
  show(opts) {
    if (opts) {
      loadIntoForm(opts.fresh).then(async () => {
        if (opts.template) await pickTemplate(opts.template);
        else if (opts.allTemplates) openAllTemplates();
        if (opts.fillIn) fillInBlanks(opts.fillIn);
      });
    } else {
      setEditorHtml(editor, L().bodyHtml || '');
      fillFields(L());
      paintRecipients();
      paintTemplates();
      paintLive();
    }
  },
  onBack() {
    syncBody.flush();
    const letter = L();
    letter.bodyDirty = bodyDirty;
    const empty = !letter.subject && !letter.recipient.name && !letter.recipient.title && !editor.textContent.trim();
    if (empty || nothingOfTheirs()) dropWaitingSave();
    else saveLetterNow();
    return false;
  },
};
