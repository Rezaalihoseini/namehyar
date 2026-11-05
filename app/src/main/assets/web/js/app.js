// Shared app state, screen navigation, theme and bottom sheets.

import { h, debounce, clone, toast } from './util.js';
import { stageDraft, clearDraft, draftToken, recoveryDrafts } from './drafts.js';
import { icon } from './icons.js';
import { delDoc, getDoc, putDoc, listDocs } from './store.js';
import { defaultSettings } from './model.js';

const N = window.NamehyarNative || null;

export const app = {
  settings: null,
  recipients: [],
  letters: [],
  templates: [],
  letter: null,
  screens: {},
  stack: [],
  overlays: [],
};

export async function loadData() {
  const saved = await getDoc('settings', 'main');
  const defaults = defaultSettings();
  app.settings = saved
    ? { ...defaults, ...saved, letterhead: { ...defaults.letterhead, ...saved.letterhead }, signer: { ...defaults.signer, ...saved.signer } }
    : defaults;
  app.recipients = await listDocs('recipients');
  app.letters = (await listDocs('letters')).sort((a, b) => b.updatedAt - a.updatedAt);
  app.templates = await listDocs('templates');
  let recovered = 0;
  for (const draft of recoveryDrafts()) {
    const savedLetter = app.letters.find((letter) => letter.id === draft.id);
    const token = draftToken(draft.id);
    if (!savedLetter || draft.updatedAt >= savedLetter.updatedAt) {
      await putDoc('letters', draft.id, draft);
      app.letters = app.letters.filter((letter) => letter.id !== draft.id);
      app.letters.push(draft);
      recovered++;
    }
    clearDraft(draft.id, token);
  }
  app.letters.sort((a, b) => b.updatedAt - a.updatedAt);
  if (recovered) toast('آخرین تغییرات ذخیره‌نشدهٔ نامه‌ها بازیابی شد.', 4500);
}

export const saveSettings = () => putDoc('settings', 'main', app.settings);

export function saveRecipient(rec) {
  const i = app.recipients.findIndex((r) => r.id === rec.id);
  if (i >= 0) app.recipients[i] = rec;
  else app.recipients.push(rec);
  return putDoc('recipients', rec.id, rec);
}

export function deleteRecipient(id) {
  app.recipients = app.recipients.filter((r) => r.id !== id);
  return delDoc('recipients', id);
}

const letterWrites = new Map();
function writeLetter(letter) {
  const snapshot = clone(letter);
  const token = draftToken(letter.id);
  const write = (letterWrites.get(letter.id) || Promise.resolve()).then(() => putDoc('letters', snapshot.id, snapshot))
    .then(() => { clearDraft(snapshot.id, token); return true; })
    .catch((error) => {
      console.error('Letter save failed', error);
      toast('ذخیرهٔ نامه انجام نشد؛ فضای خالی دستگاه را بررسی کنید. دوباره تلاش کنید.', 6000);
      return false;
    });
  letterWrites.set(letter.id, write);
  write.finally(() => { if (letterWrites.get(letter.id) === write) letterWrites.delete(letter.id); });
  const i = app.letters.findIndex((l) => l.id === letter.id);
  if (i >= 0) app.letters[i] = letter;
  else app.letters.unshift(letter);
  return write;
}

function checkpoint(letter) {
  letter.updatedAt = Date.now();
  try { stageDraft(letter); }
  catch (error) {
    console.error('Recovery checkpoint failed', error);
    toast('ذخیرهٔ بازیابی ممکن نشد؛ فضای خالی دستگاه را بررسی کنید.', 6000);
    return false;
  }
  return true;
}

// Typing saves after a short pause. A pause waiting for one letter must never be lost to the next letter's save.
let waitingLetter = null;
const saveAfterPause = debounce(() => {
  if (waitingLetter) writeLetter(waitingLetter);
  waitingLetter = null;
}, 500);

export function saveLetter(letter = app.letter) {
  if (!letter) return;
  if (!checkpoint(letter)) return writeLetter(letter);
  if (waitingLetter && waitingLetter !== letter) writeLetter(waitingLetter);
  waitingLetter = letter;
  saveAfterPause();
}

export function saveLetterNow(letter = app.letter) {
  if (!letter) return;
  checkpoint(letter);
  if (waitingLetter && waitingLetter !== letter) writeLetter(waitingLetter);
  waitingLetter = null;
  return writeLetter(letter);
}

/** Forgets a save still waiting, for a letter that was opened and left empty. */
export function dropWaitingSave() {
  if (waitingLetter) clearDraft(waitingLetter.id);
  waitingLetter = null;
}

export function deleteLetter(id) {
  if (waitingLetter?.id === id) waitingLetter = null;
  clearDraft(id);
  app.letters = app.letters.filter((l) => l.id !== id);
  return (letterWrites.get(id) || Promise.resolve()).then(() => delDoc('letters', id));
}

export function saveTemplate(template) {
  const i = app.templates.findIndex((t) => t.id === template.id);
  if (i >= 0) app.templates[i] = template;
  else app.templates.push(template);
  return putDoc('templates', template.id, template);
}

export function deleteTemplate(id) {
  app.templates = app.templates.filter((t) => t.id !== id);
  return delDoc('templates', id);
}

/* ---------- Theme. The A4 page itself always stays white, because that is what gets printed. ---------- */

export function isDark() {
  const theme = app.settings?.theme || 'system';
  if (theme !== 'system') return theme === 'dark';
  return N?.systemDark ? N.systemDark() : matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.uiSize = app.settings?.uiSize === 'large' ? 'large' : 'normal';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1a1f27' : '#ffffff');
  try {
    localStorage.setItem('namehyar-dark', dark ? '1' : '0');
  } catch {
    // Only used to avoid a white flash at the next start.
  }
  N?.setDarkBars?.(dark);
}

export function setTheme(theme) {
  app.settings.theme = theme;
  applyTheme();
  saveSettings();
}

window.__onSystemTheme = applyTheme;
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (app.settings && (!app.settings.theme || app.settings.theme === 'system')) applyTheme();
});

export function flushPendingSave() {
  document.dispatchEvent(new Event('namehyar-flush-editor'));
  if (waitingLetter) saveLetterNow(waitingLetter);
}
window.addEventListener('pagehide', flushPendingSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushPendingSave(); });
window.__flushDraft = flushPendingSave;

/* ---------- Screens ---------- */

export function registerScreen(name, screen) {
  app.screens[name] = screen;
  document.getElementById('app').append(screen.root);
}

export function showScreen(name, ...args) {
  const top = app.stack[app.stack.length - 1];
  if (top && top !== name) app.screens[top].root.hidden = true;
  if (top !== name) app.stack.push(name);
  app.screens[name].root.hidden = false;
  app.screens[name].show?.(...args);
}

export function replaceScreen(name, ...args) {
  const top = app.stack.pop();
  if (top) app.screens[top].root.hidden = true;
  showScreen(name, ...args);
}

/** Android back: closes a sheet first, then steps back. Returns false when there is nowhere to go. */
export function goBack() {
  if (app.overlays.length) {
    app.overlays[app.overlays.length - 1]();
    return true;
  }
  const current = app.screens[app.stack[app.stack.length - 1]];
  if (current?.onBack?.()) return true;
  if (app.stack.length <= 1) return false;
  current.root.hidden = true;
  current.hide?.();
  app.stack.pop();
  const prev = app.stack[app.stack.length - 1];
  app.screens[prev].root.hidden = false;
  app.screens[prev].show?.();
  return true;
}

window.__onBack = goBack;

/** Closes everything on top of the home screen, saving what was being edited. */
export function backToHome() {
  while (app.overlays.length) app.overlays[app.overlays.length - 1]();
  while (app.stack.length > 1) {
    const screen = app.screens[app.stack.pop()];
    screen.onBack?.();
    screen.root.hidden = true;
  }
}

export function backButton() {
  return h('button', { class: 'icon-btn', 'aria-label': 'بازگشت', onClick: goBack }, icon('back'));
}

export function openSheet(title, content, { onClose } = {}) {
  const previousFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    const i = app.overlays.indexOf(close);
    if (i >= 0) app.overlays.splice(i, 1);
    onClose?.();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
  const onKey = (event) => {
    if (app.overlays.at(-1) !== close) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const elements = [...wrap.querySelectorAll('button, input, textarea, select, [tabindex="0"], a[href]')]
      .filter((el) => !el.disabled && el.getClientRects().length);
    const first = elements[0];
    const last = elements.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus(); }
  };
  const wrap = h(
    'div',
    { class: 'sheet-wrap', onClick: (e) => e.target === wrap && close() },
    h(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-label': title, 'aria-modal': 'true', tabindex: '-1' },
      h('div', { class: 'sheet-head' }, h('span', null, title), h('button', { class: 'icon-btn', 'aria-label': 'بستن', onClick: close }, icon('close'))),
      content,
    ),
  );
  document.body.append(wrap);
  app.overlays.push(close);
  const dialog = wrap.querySelector('.sheet');
  document.addEventListener('keydown', onKey);
  dialog.focus({ preventScroll: true });
  return close;
}

/** Asks before something that cannot be taken back. */
export function confirmSheet(title, message, actionLabel, onConfirm) {
  const close = openSheet(
    title,
    h(
      'div',
      { class: 'form-grid' },
      h('p', { style: { margin: 0 } }, message),
      h('button', {
        class: 'btn danger',
        onClick: () => {
          close();
          onConfirm();
        },
      }, actionLabel),
      h('button', { class: 'btn', onClick: () => close() }, 'انصراف'),
    ),
  );
  return close;
}

export function segmented(options, value, onChange) {
  const root = h('div', { class: 'seg', role: 'group' });
  const paint = (v) => [...root.children].forEach((b) => {
    b.classList.toggle('on', b.dataset.value === v);
    b.setAttribute('aria-pressed', String(b.dataset.value === v));
  });
  for (const opt of options) {
    root.append(
      h('button', {
        type: 'button',
        dataset: { value: opt.id },
        onClick: () => {
          paint(opt.id);
          onChange(opt.id);
        },
      }, opt.label),
    );
  }
  paint(value);
  root.setValue = paint;
  return root;
}

export function withBusy(message, fn) {
  const el = h('div', { class: 'busy' }, message);
  document.body.append(el);
  return new Promise((resolve) => setTimeout(resolve, 30))
    .then(() => fn((text) => {
      el.textContent = text;
    }))
    .finally(() => el.remove());
}
