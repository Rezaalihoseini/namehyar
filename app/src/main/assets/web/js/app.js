// Shared app state, screen navigation, theme and bottom sheets.

import { h, debounce } from './util.js';
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

function writeLetter(letter) {
  letter.updatedAt = Date.now();
  putDoc('letters', letter.id, letter);
  const i = app.letters.findIndex((l) => l.id === letter.id);
  if (i >= 0) app.letters[i] = letter;
  else app.letters.unshift(letter);
}

// Typing saves after a short pause. A pause waiting for one letter must never be lost to the next letter's save.
let waitingLetter = null;
const saveAfterPause = debounce(() => {
  if (waitingLetter) writeLetter(waitingLetter);
  waitingLetter = null;
}, 500);

export function saveLetter(letter = app.letter) {
  if (!letter) return;
  if (waitingLetter && waitingLetter !== letter) writeLetter(waitingLetter);
  waitingLetter = letter;
  saveAfterPause();
}

export function saveLetterNow(letter = app.letter) {
  if (!letter) return;
  if (waitingLetter && waitingLetter !== letter) writeLetter(waitingLetter);
  waitingLetter = null;
  writeLetter(letter);
}

/** Forgets a save still waiting, for a letter that was opened and left empty. */
export function dropWaitingSave() {
  waitingLetter = null;
}

export function deleteLetter(id) {
  app.letters = app.letters.filter((l) => l.id !== id);
  return delDoc('letters', id);
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
  const close = () => {
    wrap.remove();
    const i = app.overlays.indexOf(close);
    if (i >= 0) app.overlays.splice(i, 1);
    onClose?.();
  };
  const wrap = h(
    'div',
    { class: 'sheet-wrap', onClick: (e) => e.target === wrap && close() },
    h(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-head' }, h('span', null, title), h('button', { class: 'icon-btn', 'aria-label': 'بستن', onClick: close }, icon('close'))),
      content,
    ),
  );
  document.body.append(wrap);
  app.overlays.push(close);
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
  const paint = (v) => [...root.children].forEach((b) => b.classList.toggle('on', b.dataset.value === v));
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
