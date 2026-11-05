// Picking files, and the two kinds of file the app reads and writes for itself:
// a template to pass to a colleague, and a full backup. Both are plain JSON, so nothing needs a server.

import { uid } from './util.js';
import { MIME, deliverFile } from './export.js';
import { ensureMedia, mediaIdsOf, mediaUrl, putDoc, putMedia } from './store.js';
import { app, saveRecipient, saveSettings, saveTemplate } from './app.js';
import { inlineImageIds } from './model.js';
import { jalaliDate } from './text.js';

export const LETTER_FILE_ACCEPT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,application/msword,image/jpeg,image/png,image/webp,application/octet-stream';
export const FONT_ACCEPT = 'font/ttf,font/otf,application/x-font-ttf,application/x-font-otf,application/octet-stream';
export const JSON_ACCEPT = 'application/json,text/plain,application/octet-stream';

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

const fileNameSafe = (s) => s.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 50);

function jsonBytes(data) {
  return new TextEncoder().encode(JSON.stringify(data));
}

async function mediaTable(ids) {
  const wanted = [...new Set(ids.filter(Boolean))];
  await ensureMedia(wanted);
  return Object.fromEntries(wanted.map((id) => [id, mediaUrl(id)]).filter(([, url]) => url));
}

async function restoreMedia(table) {
  for (const [id, url] of Object.entries(table || {})) await putMedia(id, url);
}

function templateMediaIds(t) {
  // A form keeps everything of the file it was made from.
  return t.whole ? mediaIdsOf(t.whole) : inlineImageIds({ body: t.body || [] });
}

export async function shareTemplate(template, mode) {
  const data = { kind: 'namehyar-template', version: 1, template, media: await mediaTable(templateMediaIds(template)) };
  return deliverFile(`قالب ${fileNameSafe(template.title)}.json`, jsonBytes(data), MIME.json, mode);
}

export async function makeBackup(mode) {
  const s = app.settings;
  const ids = [s.letterhead.logo, s.signer.signature, s.signer.stamp, ...(s.fonts || []).map((f) => f.mediaId)];
  for (const letter of app.letters) ids.push(...mediaIdsOf(letter));
  for (const t of app.templates) ids.push(...templateMediaIds(t));
  const data = {
    kind: 'namehyar-backup',
    version: 1,
    createdAt: Date.now(),
    settings: s,
    recipients: app.recipients,
    letters: app.letters,
    templates: app.templates,
    media: await mediaTable(ids),
  };
  return deliverFile(`پشتیبان نامه‌یار ${jalaliDate().replace(/\//g, '-')}.json`, jsonBytes(data), MIME.json, mode);
}

/** Reads a template or backup file. Returns a short description of what came in. */
export async function importAppFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('این فایل قالب یا پشتیبان نامه‌یار نیست.');
  }
  if (data?.kind === 'namehyar-template' && data.template) {
    await restoreMedia(data.media);
    await saveTemplate({ ...data.template, id: uid() });
    return `قالب «${data.template.title}» اضافه شد.`;
  }
  if (data?.kind === 'namehyar-backup') {
    await restoreMedia(data.media);
    for (const rec of data.recipients || []) await saveRecipient(rec);
    for (const t of data.templates || []) await saveTemplate(t);
    const known = new Map(app.letters.map((l) => [l.id, l]));
    for (const letter of data.letters || []) {
      known.set(letter.id, letter);
      await putDoc('letters', letter.id, letter);
    }
    app.letters = [...known.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (data.settings) {
      app.settings = { ...app.settings, ...data.settings };
      await saveSettings();
    }
    return 'پشتیبان بازیابی شد. برنامه را یک بار ببندید و باز کنید.';
  }
  throw new Error('این فایل قالب یا پشتیبان نامه‌یار نیست.');
}
