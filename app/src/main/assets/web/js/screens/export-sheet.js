import { h, toast } from '../util.js';
import { icon } from '../icons.js';
import { app, openSheet, saveLetterNow, saveRecipient, withBusy } from '../app.js';
import { makePdf, makeDocx, shareFile, saveFile, canShare, MIME } from '../export.js';
import { countBlanks } from '../model.js';
import { isPlaced, parsePages } from '../placed.js';
import { fillBlanks } from '../restyle.js';
import { blocksToHtml } from '../editor.js';
import { openFillSheet } from './fill-sheet.js';
import { formatSeconds, toFaDigits } from '../text.js';

function markDone(L) {
  if (L.durationSec == null) L.durationSec = L.activeSec || 1;
  if (L.status !== 'done') {
    L.status = 'done';
    const rec = app.recipients.find((r) => r.id === L.recipientId);
    if (rec) saveRecipient({ ...rec, uses: (rec.uses || 0) + 1, lastUsed: Date.now() });
  }
  saveLetterNow(L);
}

export function openExportSheet(L, { onBlank, onDone, onFilled } = {}) {
  const banner = h('div');
  const blanks = countBlanks(L);
  const totalPages = isPlaced(L) ? L.body.length : 0;
  const pagesInput = totalPages > 1 ? h('input', { class: 'input', inputmode: 'text', placeholder: 'همه؛ یا مثلاً ۲ یا ۱-۳' }) : null;

  const paintBanner = () => {
    banner.textContent = '';
    if (L.durationSec == null) return;
    const fast = L.durationSec <= 60;
    banner.append(h('div', { class: 'done-time' }, `این نامه در ${formatSeconds(L.durationSec)} دقیقه آماده شد${fast ? '؛ زیر یک دقیقه!' : '.'}`));
  };

  const run = (kind, mode) => {
    const pages = pagesInput ? parsePages(pagesInput.value, totalPages) : [];
    if (pages === null) {
      toast(`شمارهٔ صفحه‌ها را درست بنویس؛ این فایل ${toFaDigits(String(totalPages))} صفحه دارد.`);
      return null;
    }
    return withBusy('در حال ساخت فایل...', async () => {
      try {
        const made = kind === 'pdf' ? await makePdf(L, { pages }) : await makeDocx(L, { pages });
        markDone(L);
        paintBanner();
        onDone?.();
        if (made.system || !canShare) return;
        if (mode === 'share') shareFile(made.name, MIME[kind]);
        else {
          const where = await saveFile(made.name, MIME[kind]);
          if (where) toast(`ذخیره شد: ${where}`, 3600);
        }
      } catch (err) {
        console.error(err);
        toast('ساخت فایل انجام نشد. دوباره امتحان کنید.');
      }
    });
  };

  const row = (kind, iconName, label) =>
    h(
      'div',
      { class: 'export-group' },
      h('b', null, icon(iconName), label),
      canShare && h('button', { class: 'btn small primary', onClick: () => run(kind, 'share') }, icon('share'), 'ارسال'),
      h('button', { class: 'btn small', onClick: () => run(kind, 'save') }, icon('save'), 'ذخیره'),
    );

  const close = openSheet(
    'خروجی نامه',
    h(
      'div',
      null,
      blanks > 0 &&
        h(
          'div',
          { class: 'warn' },
          `${toFaDigits(blanks)} جای خالی هنوز پر نشده است. `,
          h('button', {
            class: 'btn small primary',
            onClick: () => {
              close();
              openFillSheet(L, {
                onFill: (values) => {
                  fillBlanks(L, values);
                  L.bodyHtml = blocksToHtml(L.body);
                  saveLetterNow(L);
                  onFilled?.();
                  openExportSheet(L, { onBlank, onDone, onFilled });
                },
              });
            },
          }, 'پر کردن یک‌جا'),
          onBlank && h('button', {
            class: 'btn small',
            onClick: () => {
              close();
              onBlank();
            },
          }, 'رفتن به جای خالی'),
        ),
      banner,
      h('div', { class: 'export-size' }, `اندازهٔ صفحهٔ خروجی: ${toFaDigits(String((L.page || { w: 210 }).w))} در ${toFaDigits(String((L.page || { h: 297 }).h))} میلی‌متر${L.imported ? '؛ همان اندازهٔ فایلی که وارد کردی' : ''}`),
      pagesInput && h('label', { class: 'export-pages' }, 'صفحه‌ها:', pagesInput),
      row('pdf', 'pdf', 'فایل PDF'),
      row('docx', 'word', 'فایل Word'),
    ),
  );
  paintBanner();
}
