import { h, uid, toast } from '../util.js';
import { icon } from '../icons.js';
import { app, backButton, confirmSheet, deleteRecipient, deleteTemplate, openSheet, saveRecipient, saveSettings, segmented, setTheme, withBusy } from '../app.js';
import { ensureMedia, mediaUrl, putMedia } from '../store.js';
import { importImage, pickImageFile, removePaper } from '../image.js';
import { FONTS } from '../model.js';
import { RANKS } from '../data/phrases.js';
import { installFont, removeFont } from '../fonts.js';
import { FONT_ACCEPT, JSON_ACCEPT, importAppFile, makeBackup, pickFile, shareTemplate } from '../files.js';
import { canShare } from '../export.js';

const root = h('section', { class: 'screen', id: 'settings', hidden: true });
const content = h('div', { class: 'scroll' });
root.append(h('header', { class: 'topbar' }, backButton(), h('h1', null, 'تنظیمات')), content);

function textField(label, value, onInput, attrs = {}) {
  return h(
    'label',
    null,
    h('div', { class: 'mini-label' }, label),
    h('input', { class: 'input', value: value || '', onInput: (e) => onInput(e.target.value), ...attrs }),
  );
}

function imageField(label, get, set, { cleanPaper = false } = {}) {
  const thumb = h('div', { class: 'thumb' });
  const paint = () => {
    thumb.textContent = '';
    const url = get() && mediaUrl(get());
    thumb.append(url ? h('img', { src: url, alt: '' }) : 'بدون عکس');
  };
  const choose = async () => {
    const file = await pickImageFile();
    if (!file) return;
    await withBusy('در حال آماده‌سازی عکس...', async () => {
      let img = await importImage(file);
      if (cleanPaper) {
        const clean = await removePaper(img.dataUrl);
        if (!clean.empty) img = clean;
      }
      const id = uid();
      await putMedia(id, img.dataUrl);
      set(id, img.aspect);
      await saveSettings();
      paint();
    });
  };
  paint();
  return h(
    'div',
    null,
    h('div', { class: 'mini-label' }, label),
    h(
      'div',
      { class: 'image-field' },
      thumb,
      h('button', { class: 'btn small', onClick: choose }, icon('image'), 'انتخاب عکس'),
      h('button', {
        class: 'icon-btn',
        'aria-label': 'حذف عکس',
        onClick: async () => {
          set(null, 1);
          await saveSettings();
          paint();
        },
      }, icon('trash')),
    ),
  );
}

function group(iconName, title, ...kids) {
  return h('div', { class: 'settings-group' }, h('h2', null, icon(iconName), title), ...kids);
}

function themeGroup() {
  return group(
    'moon',
    'ظاهر برنامه',
    segmented(
      [
        { id: 'system', label: 'مثل گوشی' },
        { id: 'light', label: 'روشن' },
        { id: 'dark', label: 'تیره' },
      ],
      app.settings.theme || 'system',
      setTheme,
    ),
  );
}

function letterheadGroup() {
  const s = app.settings;
  const save = () => saveSettings();
  return group(
    'page',
    'سربرگ',
    h(
      'div',
      { class: 'form-grid' },
      imageField('لوگو', () => s.letterhead.logo, (id, aspect) => {
        s.letterhead.logo = id;
        s.letterhead.logoAspect = aspect;
      }),
      textField('نام سازمان (خط اول)', s.letterhead.org[0], (v) => {
        s.letterhead.org[0] = v;
        save();
      }),
      textField('نام سازمان (خط دوم)', s.letterhead.org[1], (v) => {
        s.letterhead.org[1] = v;
        save();
      }),
      textField('عبارت بالای نامه', s.letterhead.invocation, (v) => {
        s.letterhead.invocation = v;
        save();
      }),
      textField('پایین صفحه: نشانی و تلفن', s.letterhead.footer, (v) => {
        s.letterhead.footer = v;
        save();
      }),
    ),
  );
}

function signerGroup() {
  const s = app.settings;
  const save = () => saveSettings();
  return group(
    'sign',
    'امضاکننده',
    h(
      'div',
      { class: 'form-grid' },
      textField('نام', s.signer.name, (v) => {
        s.signer.name = v;
        save();
      }, { placeholder: 'مثلاً: دکتر رضا محمدی' }),
      textField('سمت', s.signer.title, (v) => {
        s.signer.title = v;
        save();
      }, { placeholder: 'مثلاً: رئیس مرکز رشد' }),
      imageField('عکس امضا (پس‌زمینهٔ سفید خودکار حذف می‌شود)', () => s.signer.signature, (id, aspect) => {
        s.signer.signature = id;
        s.signer.signatureAspect = aspect;
      }, { cleanPaper: true }),
      imageField('عکس مهر (پس‌زمینهٔ سفید خودکار حذف می‌شود)', () => s.signer.stamp, (id, aspect) => {
        s.signer.stamp = id;
        s.signer.stampAspect = aspect;
      }, { cleanPaper: true }),
    ),
  );
}

function openRecipientEditor(rec, onSaved) {
  const nameInput = h('input', { class: 'input', value: rec?.name || '', placeholder: 'مثلاً: جناب آقای دکتر احمدی' });
  const titleInput = h('input', { class: 'input', value: rec?.title || '', placeholder: 'مثلاً: رئیس محترم پارک علم و فناوری' });
  let rank = rec?.rank || 'superior';
  const close = openSheet(
    rec ? 'ویرایش گیرنده' : 'گیرندهٔ جدید',
    h(
      'div',
      { class: 'form-grid' },
      h('label', null, h('div', { class: 'mini-label' }, 'نام'), nameInput),
      h('label', null, h('div', { class: 'mini-label' }, 'سمت'), titleInput),
      h('div', null, h('div', { class: 'mini-label' }, 'جایگاه گیرنده نسبت به شما'), segmented(RANKS, rank, (v) => { rank = v; })),
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          const name = nameInput.value.trim();
          const title = titleInput.value.trim();
          if (!name && !title) {
            toast('نام یا سمت گیرنده را بنویسید');
            return;
          }
          await saveRecipient({ ...(rec || { id: uid(), uses: 0 }), name, title, rank });
          close();
          onSaved();
        },
      }, 'تأیید'),
    ),
  );
}

function recipientsGroup() {
  const rows = h('div');
  const paintRows = () => {
    rows.textContent = '';
    if (!app.recipients.length) rows.append(h('p', { class: 'note' }, 'هنوز گیرنده‌ای تعریف نشده است.'));
    for (const rec of app.recipients) {
      rows.append(
        h(
          'div',
          { class: 'list-row' },
          h('div', { class: 'grow' }, h('b', null, rec.title || rec.name), h('small', null, rec.title ? rec.name : '')),
          h('button', { class: 'icon-btn', 'aria-label': 'ویرایش', onClick: () => openRecipientEditor(rec, paintRows) }, icon('pencil')),
          h('button', {
            class: 'icon-btn',
            'aria-label': 'حذف',
            onClick: () => confirmSheet('حذف گیرنده', `«${rec.title || rec.name}» از فهرست گیرنده‌ها حذف می‌شود. نامه‌های قبلی دست نمی‌خورند.`, 'حذف شود', async () => {
              await deleteRecipient(rec.id);
              paintRows();
            }),
          }, icon('trash')),
        ),
      );
    }
  };
  paintRows();
  return group('user', 'گیرنده‌ها', rows, h('div', { class: 'button-row' }, h('button', { class: 'btn small', onClick: () => openRecipientEditor(null, paintRows) }, icon('plus'), 'گیرندهٔ جدید')));
}

function templatesGroup() {
  const rows = h('div');
  const paintRows = () => {
    rows.textContent = '';
    if (!app.templates.length) rows.append(h('p', { class: 'note' }, 'برای ساخت قالب، در صفحهٔ نامه دکمهٔ «ذخیره به‌عنوان قالب» را بزن. جاهای خالی را داخل [کروشه] بنویس.'));
    for (const t of app.templates) {
      rows.append(
        h(
          'div',
          { class: 'list-row' },
          h('div', { class: 'grow' }, h('b', null, t.title)),
          h('button', {
            class: 'icon-btn',
            'aria-label': 'فرستادن قالب برای همکار',
            onClick: async () => {
              const where = await shareTemplate(t, canShare ? 'share' : 'save');
              if (where) toast(`ذخیره شد: ${where}`, 3600);
            },
          }, icon('share')),
          h('button', {
            class: 'icon-btn',
            'aria-label': 'حذف',
            onClick: () => confirmSheet('حذف قالب', `قالب «${t.title}» حذف می‌شود.`, 'حذف شود', async () => {
              await deleteTemplate(t.id);
              paintRows();
            }),
          }, icon('trash')),
        ),
      );
    }
  };
  paintRows();
  return group(
    'page',
    'قالب‌های من',
    rows,
    h(
      'div',
      { class: 'button-row' },
      h('button', {
        class: 'btn small',
        onClick: async () => {
          const file = await pickFile(JSON_ACCEPT);
          if (!file) return;
          try {
            toast(await importAppFile(file), 4000);
            paint();
          } catch (err) {
            toast(err.message, 4000);
          }
        },
      }, icon('folder'), 'وارد کردن قالب از فایل'),
    ),
  );
}

function fontsGroup() {
  const s = app.settings;
  const rows = h('div');
  const paintRows = () => {
    rows.textContent = '';
    rows.append(h('p', { class: 'note' }, `فونت‌های همراه برنامه: ${FONTS.join('، ')}`));
    for (const font of s.fonts || []) {
      rows.append(
        h(
          'div',
          { class: 'list-row' },
          h('div', { class: 'grow', style: { fontFamily: `"${font.family}","Vazirmatn"` } }, h('b', null, font.family)),
          h('button', {
            class: 'icon-btn',
            'aria-label': 'حذف فونت',
            onClick: () => confirmSheet('حذف فونت', `فونت «${font.family}» از برنامه حذف می‌شود.`, 'حذف شود', async () => {
              removeFont(font.family, s);
              await saveSettings();
              paintRows();
            }),
          }, icon('trash')),
        ),
      );
    }
  };
  paintRows();
  return group(
    'font',
    'فونت‌ها',
    rows,
    h(
      'div',
      { class: 'button-row' },
      h('button', {
        class: 'btn small',
        onClick: async () => {
          const file = await pickFile(FONT_ACCEPT);
          if (!file) return;
          await withBusy('در حال نصب فونت...', async () => {
            try {
              const family = await installFont(file, s);
              await saveSettings();
              paintRows();
              toast(`فونت «${family}» اضافه شد. در صفحهٔ چیدمان قابل انتخاب است.`, 3600);
            } catch (err) {
              console.error(err);
              toast('این فایل فونت TTF یا OTF سالم نیست.', 3600);
            }
          });
        },
      }, icon('plus'), 'افزودن فونت (TTF یا OTF)'),
    ),
    h('p', { class: 'note', style: { margin: '8px 0 0' } }, 'برای اینکه فایل Word هم با همین فونت باز شود، باید روی لپ‌تاپ هم نصب باشد.'),
  );
}

function backupGroup() {
  return group(
    'save',
    'پشتیبان‌گیری',
    h('p', { class: 'note' }, 'همهٔ نامه‌ها، گیرنده‌ها، قالب‌ها و تنظیمات در یک فایل. برای رفتن به گوشی جدید هم همین فایل کافی است.'),
    h(
      'div',
      { class: 'button-row' },
      h('button', {
        class: 'btn small',
        onClick: () => withBusy('در حال ساخت فایل پشتیبان...', async () => {
          const where = await makeBackup('save');
          if (where) toast(`ذخیره شد: ${where}`, 3600);
        }),
      }, icon('save'), 'ساخت فایل پشتیبان'),
      h('button', {
        class: 'btn small',
        onClick: async () => {
          const file = await pickFile(JSON_ACCEPT);
          if (!file) return;
          await withBusy('در حال بازیابی...', async () => {
            try {
              toast(await importAppFile(file), 4000);
              paint();
            } catch (err) {
              toast(err.message, 4000);
            }
          });
        },
      }, icon('folder'), 'بازیابی از فایل'),
    ),
  );
}

function autoFixGroup() {
  const s = app.settings;
  return group(
    'wand',
    'اصلاح خودکار متن',
    h('p', { class: 'note' }, 'اعداد فارسی، «ی» و «ک» فارسی و نیم‌فاصله (می رساند ← می‌رساند) هنگام ساخت صفحه درست می‌شوند.'),
    segmented(
      [
        { id: 'on', label: 'روشن' },
        { id: 'off', label: 'خاموش' },
      ],
      s.autoFix === false ? 'off' : 'on',
      (v) => {
        s.autoFix = v === 'on';
        saveSettings();
        toast('برای نامه‌های جدید اعمال شد');
      },
    ),
  );
}

async function paint() {
  const s = app.settings;
  await ensureMedia([s.letterhead.logo, s.signer.signature, s.signer.stamp]);
  content.textContent = '';
  content.append(themeGroup(), letterheadGroup(), signerGroup(), recipientsGroup(), templatesGroup(), fontsGroup(), backupGroup(), autoFixGroup());
}

export const settingsScreen = { root, show: paint };
