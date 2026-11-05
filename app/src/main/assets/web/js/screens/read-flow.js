// Asking whether to read a scan, reading it, and going through the words worth a second look: each beside its own picture from the scan,
// which is far quicker than proofreading the whole page against the paper.

import { h, loadImage, toast } from '../util.js';
import { app, backToHome, deleteLetter, openSheet, saveLetterNow, showScreen, withBusy } from '../app.js';
import { blocksToHtml } from '../editor.js';
import { replaceEverywhere } from '../restyle.js';
import { ensureMedia, mediaUrl } from '../store.js';
import { toFaDigits } from '../text.js';

const fa = (n) => toFaDigits(String(n));

/** The file is a scan or a photo: its words can be read, or it can stay a picture. */
export function offerReading(scan) {
  const close = openSheet(
    'این فایل اسکن است',
    h(
      'div',
      { class: 'form-grid' },
      h('p', { style: { margin: 0 } }, 'متنش را بخوانم تا مثل یک نامهٔ معمولی قابل ویرایش شود؟ این کار بدون اینترنت انجام می‌شود؛ هر صفحه روی گوشی ممکن است تا حدود نیم دقیقه طول بکشد.'),
      h('button', {
        class: 'btn primary',
        onClick: () => {
          close();
          startReading(scan);
        },
      }, 'بخوان'),
      h('button', { class: 'btn', onClick: () => close() }, 'فعلاً به‌صورت عکس بماند'),
    ),
  );
}

export function startReading(scan) {
  return withBusy('در حال آماده شدن برای خواندن متن...', async (say) => {
    let noWords = null;
    try {
      const reading = await import('../read-scan.js');
      noWords = reading.NoWords;
      const letter = await reading.readScannedLetter(scan, app.settings, {
        onProgress: (page, total) => say(total > 1 ? `در حال خواندن متن صفحهٔ ${fa(page)} از ${fa(total)}...` : 'در حال خواندن متن...'),
      });
      await deleteLetter(scan.id);
      backToHome();
      app.letter = letter;
      saveLetterNow(letter);
      showScreen('compose', { fresh: false });
      showScreen('page');
      if (letter.ocr.words.length) openReviewSheet(letter, { onDone: () => app.screens.page.refresh() });
      else toast('متن خوانده شد');
    } catch (err) {
      if (noWords && err instanceof noWords) {
        toast('متنی در این تصویر پیدا نشد. عکس سر جایش هست.', 4200);
      } else {
        console.error(err);
        toast('خواندن متن انجام نشد. عکس سر جایش هست؛ دوباره امتحان کن.', 4200);
      }
    }
  });
}

/** A small picture of one word from the scan, with some of what stands around it. */
function wordPicture(pageImage, [x0, y0, x1, y1]) {
  const w = pageImage.naturalWidth;
  const ht = pageImage.naturalHeight;
  const padX = (x1 - x0) * w * 0.5 + 12;
  const padY = (y1 - y0) * ht * 0.45 + 6;
  const sx = Math.max(0, x0 * w - padX);
  const sy = Math.max(0, y0 * ht - padY);
  const sw = Math.min(w - sx, (x1 - x0) * w + padX * 2);
  const sh = Math.min(ht - sy, (y1 - y0) * ht + padY * 2);
  const canvas = document.createElement('canvas');
  const k = Math.min(1.5, 480 / sw);
  canvas.width = Math.max(1, Math.round(sw * k));
  canvas.height = Math.max(1, Math.round(sh * k));
  canvas.getContext('2d').drawImage(pageImage, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return h('img', { class: 'review-picture', src: canvas.toDataURL('image/jpeg', 0.8), alt: '' });
}

/** What the engine read and is not sure of, each to be looked at once. */
export async function openReviewSheet(L, { onDone } = {}) {
  await ensureMedia(L.ocr?.pages || []);
  const words = (L.ocr?.words || []).filter((word) => replaceEverywhere(L, word.t, undefined, { whole: true }) > 0);
  if (!words.length) {
    L.ocr.words = [];
    onDone?.();
    return;
  }
  const pictures = new Map();
  const pageImage = async (p) => {
    if (!pictures.has(p)) pictures.set(p, await loadImage(mediaUrl(L.ocr.pages[p])));
    return pictures.get(p);
  };
  const inputs = words.map((word) => h('input', { class: 'input', value: word.s || word.t, autocomplete: 'off', 'aria-label': word.t }));
  const rows = await Promise.all(words.map(async (word, i) => h(
    'div',
    { class: 'review-row' },
    wordPicture(await pageImage(word.p), word.b),
    inputs[i],
    word.s && h('button', {
      class: 'chip',
      onClick: () => {
        inputs[i].value = word.t;
      },
    }, `خوانده‌شده: ${word.t}`),
  )));
  const close = openSheet(
    `بازبینی ${fa(words.length)} کلمهٔ مشکوک`,
    h(
      'div',
      { class: 'form-grid review-sheet' },
      h('p', { class: 'note', style: { margin: 0 } }, 'هر کلمه زیر تصویرش در اسکن آمده است. فقط اشتباه‌ها را درست کن؛ برای حذف یک کلمه خالی‌اش کن.'),
      rows,
      h('button', {
        class: 'btn primary',
        onClick: () => {
          let changed = 0;
          words.forEach((word, i) => {
            const value = inputs[i].value.trim();
            if (value !== word.t) changed += replaceEverywhere(L, word.t, value, { whole: true });
          });
          L.ocr.words = [];
          L.bodyHtml = blocksToHtml(L.body);
          saveLetterNow(L);
          close();
          onDone?.();
          toast(changed ? `${fa(changed)} جا درست شد` : 'همه درست بود');
        },
      }, 'تأیید'),
      h('button', { class: 'btn', onClick: () => openScanSheet(L) }, 'دیدن اسکن اصلی'),
    ),
  );
}

/** The scan the letter was read from, to compare with, and the way back to it when the reading is no use. */
export async function openScanSheet(L) {
  await ensureMedia(L.ocr?.pages || []);
  const close = openSheet('اسکن اصلی', h(
    'div',
    { class: 'form-grid' },
    h('div', { class: 'scan-pages' }, (L.ocr?.pages || []).map((id) => h('img', { src: mediaUrl(id), alt: '' }))),
    h('button', {
      class: 'btn',
      onClick: async () => {
        close();
        const { letterFromPages } = await import('../import-pdf.js');
        const scan = await letterFromPages(L.ocr.pages, L.page || null, app.settings);
        scan.sourceName = L.sourceName;
        await deleteLetter(L.id);
        backToHome();
        app.letter = scan;
        saveLetterNow(scan);
        showScreen('compose', { fresh: false });
        showScreen('page');
        toast('متن خوانده‌شده کنار رفت و نامه به صورت عکس برگشت.');
      },
    }, 'برگشتن به حالت عکس'),
  ));
}
