// Everything still blank in a letter on one sheet, each repeated blank asked once, with what was written there before a tap away.
// And starting from a form: a file that was given blanks and saved, which opens ready to be filled in.

import { h, toast } from '../util.js';
import { app, openSheet, saveLetterNow, saveSettings, showScreen } from '../app.js';
import { blanksOf, copyOfLetter } from '../model.js';
import { ensureMedia, mediaIdsOf } from '../store.js';
import { jalaliDate, toFaDigits } from '../text.js';

const REMEMBERED = 5;

/** What may well belong in a blank: what the letter already knows, then what was written under this name before. */
function suggestionsFor(label, L) {
  const out = [];
  if (/تاریخ/.test(label)) out.push(jalaliDate());
  if (/موضوع/.test(label) && L.subject && !L.subject.includes('[')) out.push(L.subject);
  if (/گیرنده/.test(label) && L.recipient?.name) out.push(L.recipient.name);
  out.push(...(app.settings.blankValues?.[label] || []));
  return [...new Set(out)].slice(0, REMEMBERED);
}

function remember(values) {
  const kept = { ...app.settings.blankValues };
  for (const [label, value] of Object.entries(values)) {
    if (!value) continue;
    kept[label] = [value, ...(kept[label] || []).filter((v) => v !== value)].slice(0, REMEMBERED);
  }
  app.settings.blankValues = kept;
  saveSettings();
}

/** @param onFill gets {label: words} for what was written; a blank left empty stays a blank */
export function openFillSheet(L, { onFill }) {
  const blanks = blanksOf(L);
  if (!blanks.length) {
    toast('همهٔ جاهای خالی پر شده است');
    return;
  }
  const inputs = blanks.map(({ label }) => h('input', { class: 'input', autocomplete: 'off', enterkeyhint: 'next', 'aria-label': label }));
  const finish = () => {
    const values = {};
    blanks.forEach(({ label }, i) => {
      const value = inputs[i].value.trim();
      if (value) values[label] = value;
    });
    close();
    if (!Object.keys(values).length) return;
    remember(values);
    onFill(values);
    const left = blanks.length - Object.keys(values).length;
    toast(left ? `${toFaDigits(left)} جای خالی هنوز مانده است` : 'همهٔ جاهای خالی پر شد');
  };
  inputs.forEach((input, i) => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (inputs[i + 1]) inputs[i + 1].focus();
      else finish();
    });
  });
  const close = openSheet(
    `پر کردن ${toFaDigits(blanks.length)} جای خالی`,
    h(
      'div',
      { class: 'form-grid fill-sheet' },
      blanks.map(({ label, count }, i) => {
        const tips = suggestionsFor(label, L);
        return h(
          'div',
          null,
          h('div', { class: 'mini-label' }, label, count > 1 ? ` (${toFaDigits(count)} جا)` : ''),
          inputs[i],
          tips.length > 0 && h('div', { class: 'fill-tips' }, tips.map((tip) => h('button', {
            class: 'chip',
            onClick: () => {
              inputs[i].value = tip;
              (inputs[i + 1] || inputs[i]).focus();
            },
          }, tip))),
        );
      }),
      h('button', { class: 'btn primary', onClick: finish }, 'تأیید'),
    ),
  );
  inputs[0].focus();
}

/** A new letter from a saved form, on its page, with its blanks asked for at once. */
export async function startFromForm(template) {
  const letter = copyOfLetter({ ...template.whole, id: template.id });
  letter.templateId = template.id;
  await ensureMedia(mediaIdsOf(letter));
  app.settings.templateUses = { ...app.settings.templateUses, [template.id]: (app.settings.templateUses?.[template.id] || 0) + 1 };
  saveSettings();
  app.letter = letter;
  saveLetterNow(letter);
  showScreen('compose', { fresh: false });
  showScreen('page', { fill: true });
}
