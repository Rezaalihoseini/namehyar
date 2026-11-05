// The sheets of the page screen's tools: colour, exact size, lines of a cell, saved looks, find and replace.
// They only ask; what the answer does stays with the page.

import { h, toast, uid } from '../util.js';
import { icon } from '../icons.js';
import { app, openSheet, saveSettings } from '../app.js';
import { toEnDigits, toFaDigits } from '../text.js';

/* ---------- Making a blank of some words ---------- */

/** @param text the words picked; nothing for an empty cell. @param count how many times some words stand in the letter */
export function openMarkSheet({ text, count, onApply }) {
  const textInput = h('input', { class: 'input', value: text });
  const nameInput = h('input', { class: 'input', placeholder: 'مثلاً: نام دانشجو', autocomplete: 'off' });
  const note = h('p', { class: 'note', style: { margin: 0 } });
  const paint = () => {
    const words = textInput.value.trim();
    const times = words ? count(words) : 0;
    note.textContent = times > 1 ? `این متن در ${toFaDigits(String(times))} جا هست و همه با هم پر می‌شوند.` : words && !times ? 'این متن در نامه پیدا نشد.' : 'هر بار که این فایل را پر کنی، فقط همین‌جا عوض می‌شود.';
  };
  textInput.addEventListener('input', paint);
  const close = openSheet(
    'تبدیل به جای خالی',
    h(
      'div',
      { class: 'form-grid' },
      text && h('label', null, h('div', { class: 'mini-label' }, 'این متن'), textInput),
      h('label', null, h('div', { class: 'mini-label' }, 'نام این جای خالی'), nameInput),
      note,
      h('button', {
        class: 'btn primary',
        onClick: () => {
          const words = textInput.value.trim();
          const name = (nameInput.value.trim() || words).replace(/[[\]\n]/g, '');
          if (!name) {
            toast('برای جای خالی یک نام بنویس');
            return;
          }
          if (text && !count(words)) {
            toast('این متن در نامه پیدا نشد');
            return;
          }
          close();
          onApply(words, name);
        },
      }, 'تأیید'),
    ),
  );
  paint();
  nameInput.focus();
}

/** A name, for a new blank or a form. */
export function openNameSheet({ title, label, value = '', placeholder, note, onDone }) {
  const input = h('input', { class: 'input', value, placeholder, autocomplete: 'off' });
  const close = openSheet(
    title,
    h(
      'div',
      { class: 'form-grid' },
      h('label', null, h('div', { class: 'mini-label' }, label), input),
      note && h('p', { class: 'note', style: { margin: 0 } }, note),
      h('button', {
        class: 'btn primary',
        onClick: () => {
          const name = input.value.trim().replace(/[[\]\n]/g, '');
          if (!name) {
            toast(`${label} را بنویس`);
            return;
          }
          close();
          onDone(name);
        },
      }, 'تأیید'),
    ),
  );
  input.focus();
}

/* ---------- Colour ---------- */

const TEXT_COLORS = ['000000', '404040', '7F7F7F', 'C00000', 'FF0000', 'ED7D31', 'BF8F00', '00B050', '00707C', '0070C0', '185ABD', '002060', '7030A0', 'C2185B', 'FFFFFF'];
const FILL_COLORS = ['F2F2F2', 'D9D9D9', 'BFBFBF', 'FDE9D9', 'F8CBAD', 'FFF2CC', 'FFE699', 'FFFF00', 'E2EFD9', 'C6E0B4', 'DEEAF6', 'BDD7EE', 'D9E2F3', 'E4DFEC', 'FADBD8'];

const hexOf = (value) => {
  const text = toEnDigits(String(value || '')).trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : null;
};

function rememberColor(color) {
  const recent = (app.settings.recentColors || []).filter((c) => c !== color);
  app.settings.recentColors = [color, ...recent].slice(0, 6);
  saveSettings();
}

/** @param kind 'text' or 'fill', which decides the colours offered first */
export function openColorSheet({ title, kind = 'text', current, noneLabel, onPick }) {
  const pick = (color) => {
    close();
    if (color) rememberColor(color);
    onPick(color);
  };
  const swatch = (color) => h('button', {
    class: `swatch${color === current ? ' on' : ''}`,
    'aria-label': `رنگ ${color}`,
    dataset: { color },
    style: { background: `#${color}` },
    onClick: () => pick(color),
  });
  const recent = (app.settings.recentColors || []);
  const field = h('input', { class: 'input hex-input', placeholder: 'مثلاً #185ABD', dir: 'ltr', inputmode: 'text', maxlength: 7 });
  const close = openSheet(
    title,
    h(
      'div',
      { class: 'form-grid' },
      h('button', { class: 'btn', onClick: () => pick(null) }, noneLabel),
      h('div', { class: 'swatches' }, (kind === 'fill' ? [...FILL_COLORS, ...TEXT_COLORS.slice(3, 12)] : [...TEXT_COLORS, ...FILL_COLORS.slice(3, 12)]).map(swatch)),
      recent.length > 0 && h('div', null, h('div', { class: 'mini-label' }, 'رنگ‌های اخیر'), h('div', { class: 'swatches' }, recent.map(swatch))),
      h(
        'div',
        { class: 'hex-row' },
        field,
        h('button', {
          class: 'btn',
          onClick: () => {
            const color = hexOf(field.value);
            if (color) pick(color);
            else toast('کد رنگ باید شش نویسه باشد، مثل 185ABD');
          },
        }, 'این رنگ'),
      ),
    ),
  );
}

/* ---------- Exact size ---------- */

const SIZES = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 36];

export function openSizeSheet({ current, onPick }) {
  const pick = (size) => {
    close();
    onPick(size);
  };
  const field = h('input', { class: 'input size-input', inputmode: 'decimal', value: current ? toFaDigits(current) : '' });
  const take = () => {
    const size = Number(toEnDigits(field.value).replace('٫', '.'));
    if (size >= 2 && size <= 200) pick(Math.round(size * 2) / 2);
    else toast('اندازه باید عددی بین ۲ تا ۲۰۰ باشد');
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') take();
  });
  const close = openSheet(
    'اندازهٔ قلم',
    h(
      'div',
      { class: 'form-grid' },
      h('div', { class: 'size-grid' }, SIZES.map((size) => h('button', {
        class: `btn small${size === current ? ' primary' : ''}`,
        dataset: { size },
        onClick: () => pick(size),
      }, toFaDigits(size)))),
      h('div', { class: 'hex-row' }, field, h('button', { class: 'btn', onClick: take }, 'این اندازه')),
    ),
  );
}

/* ---------- The lines of a cell ---------- */

const SIDES = [
  { id: 'top', label: 'بالا' },
  { id: 'right', label: 'راست' },
  { id: 'bottom', label: 'پایین' },
  { id: 'left', label: 'چپ' },
];
const WIDTHS = [
  { value: 0.25, label: '۰٫۲۵' },
  { value: 0.5, label: '۰٫۵' },
  { value: 0.75, label: '۰٫۷۵' },
  { value: 1, label: '۱' },
  { value: 1.5, label: '۱٫۵' },
  { value: 2.25, label: '۲٫۲۵' },
  { value: -2.25, label: 'دوتایی' },
];

export function openLinesSheet({ onApply }) {
  const sides = new Set(SIDES.map((s) => s.id));
  let width = 0.5;
  const sideButtons = h('div', { class: 'tool-choices' });
  const widthButtons = h('div', { class: 'tool-choices' });
  const paint = () => {
    sideButtons.replaceChildren(...SIDES.map((side) => h('button', {
      class: `btn small toggle${sides.has(side.id) ? ' on' : ''}`,
      dataset: { side: side.id },
      onClick: () => {
        if (sides.has(side.id)) sides.delete(side.id);
        else sides.add(side.id);
        paint();
      },
    }, side.label)));
    widthButtons.replaceChildren(...WIDTHS.map((choice) => h('button', {
      class: `btn small toggle${width === choice.value ? ' on' : ''}`,
      dataset: { width: choice.value },
      onClick: () => {
        width = choice.value;
        paint();
      },
    }, choice.label)));
  };
  paint();
  const finish = (value) => {
    if (!sides.size) {
      toast('دست‌کم یک طرف را انتخاب کن');
      return;
    }
    close();
    onApply([...sides], value);
  };
  const close = openSheet(
    'خط‌های خانه',
    h(
      'div',
      { class: 'form-grid' },
      h('div', null, h('div', { class: 'mini-label' }, 'کدام طرف‌ها'), sideButtons),
      h('div', null, h('div', { class: 'mini-label' }, 'ضخامت خط (پوینت)'), widthButtons),
      h('div', { class: 'hex-row' }, h('button', { class: 'btn primary grow', onClick: () => finish(width) }, 'خط بکش'), h('button', { class: 'btn', onClick: () => finish(0) }, 'خط را بردار')),
    ),
  );
}

/* ---------- Saved looks: a name for a font, size and colour together, one tap away ---------- */

const looks = () => app.settings.looks || [];

export function openLooksSheet({ current, describe, onApply }) {
  const list = h('div', { class: 'look-list' });
  const preview = (look) => {
    const el = h('span', { class: 'look-sample' }, look.name);
    Object.assign(el.style, {
      fontFamily: `"${look.font}","B Nazanin","Vazirmatn",serif`,
      fontWeight: look.bold ? 700 : 400,
      color: look.color ? `#${look.color}` : '',
      textDecoration: look.underline ? 'underline' : '',
      background: look.bg ? `#${look.bg}` : '',
    });
    return el;
  };
  const paint = () => {
    list.replaceChildren(...(looks().length
      ? looks().map((look) => h(
        'div',
        { class: 'look-row' },
        h('button', {
          class: 'look-pick',
          dataset: { look: look.id },
          onClick: () => {
            close();
            onApply(look);
          },
        }, preview(look), h('small', null, `${look.font}، ${toFaDigits(look.size)}`)),
        h('button', {
          class: 'icon-btn',
          'aria-label': `حذف ${look.name}`,
          onClick: () => {
            app.settings.looks = looks().filter((other) => other.id !== look.id);
            saveSettings();
            paint();
          },
        }, icon('trash')),
      ))
      : [h('p', { class: 'note', style: { margin: 0 } }, 'هنوز سبکی نساخته‌ای. ظاهری را که دوست داری انتخاب کن، اینجا نامی برایش بگذار و بعد با یک لمس روی هر چیز دیگری بزن.')]));
  };
  const name = h('input', { class: 'input', placeholder: 'نام این سبک، مثلاً «نمرهٔ مهم»' });
  const close = openSheet(
    'سبک‌ها',
    h(
      'div',
      { class: 'form-grid' },
      list,
      current && h(
        'div',
        null,
        h('div', { class: 'mini-label' }, `ظاهر فعلی: ${describe}`),
        h(
          'div',
          { class: 'hex-row' },
          name,
          h('button', {
            class: 'btn',
            onClick: () => {
              const label = name.value.trim();
              if (!label) {
                toast('یک نام برای این سبک بنویس');
                return;
              }
              app.settings.looks = [...looks(), { id: uid(), name: label, ...current }];
              saveSettings();
              name.value = '';
              paint();
            },
          }, 'ذخیره'),
        ),
      ),
    ),
  );
  paint();
}

/* ---------- Find and replace ---------- */

export function openFindSheet({ count, replace }) {
  const find = h('input', { class: 'input', placeholder: 'چه چیزی را پیدا کنم؟' });
  const to = h('input', { class: 'input', placeholder: 'به چه چیزی عوض شود؟' });
  const result = h('p', { class: 'note', style: { margin: 0 } }, 'در متن نامه، جدول‌ها، کادرها، گیرنده، موضوع و امضا می‌گردد.');
  find.addEventListener('input', () => {
    const n = find.value ? count(find.value) : 0;
    result.textContent = find.value ? (n ? `${toFaDigits(n)} مورد پیدا شد.` : 'چیزی پیدا نشد.') : 'در متن نامه، جدول‌ها، کادرها، گیرنده، موضوع و امضا می‌گردد.';
  });
  const close = openSheet(
    'جستجو و جایگزینی',
    h(
      'div',
      { class: 'form-grid' },
      find,
      to,
      result,
      h('button', {
        class: 'btn primary',
        onClick: () => {
          if (!find.value) {
            toast('اول بنویس چه چیزی را پیدا کنم');
            return;
          }
          const done = replace(find.value, to.value);
          if (!done) {
            result.textContent = 'چیزی پیدا نشد.';
            return;
          }
          close();
          toast(`${toFaDigits(done)} مورد عوض شد. با دکمهٔ برگرداندن برمی‌گردد.`);
        },
      }, 'همه را عوض کن'),
    ),
  );
  find.focus();
}
