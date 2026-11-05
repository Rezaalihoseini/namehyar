// Produces the PDF and Word files and hands them to Android (share or save), or downloads them in a browser.

import { $, uid, h, dataUrlToBytes, bytesToBase64 } from './util.js';
import { layoutLetter } from './render.js';
import { buildDocx } from './export-docx.js';
import { ensureMedia, mediaIdsOf, mediaUrl } from './store.js';
import { PAGE, fileBaseName, usePageSize } from './model.js';
import { letterWithPages } from './placed.js';
import { toFaDigits } from './text.js';

const N = window.NamehyarNative || null;
const pending = new Map();

window.__nativeDone = (id, ok, data) => {
  const p = pending.get(id);
  pending.delete(id);
  if (!p) return;
  if (ok) p.resolve(data);
  else p.reject(new Error(data || 'native call failed'));
};

function nativeCall(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = uid();
    pending.set(id, { resolve, reject });
    N[method](id, ...args);
  });
}

export const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  json: 'application/json',
};

async function fontsAndImagesReady(root) {
  await document.fonts.ready;
  await Promise.all([...root.querySelectorAll('img')].map((img) => img.decode().catch(() => null)));
}

/** The paper the print stylesheet asks for: this letter's own page size. */
function setPrintPaper() {
  let style = $('#print-paper');
  if (!style) {
    style = h('style', { id: 'print-paper' });
    document.head.append(style);
  }
  style.textContent = `@page { size: ${PAGE.w}mm ${PAGE.h}mm; margin: 0; }`;
}

/** Prepares the real-size pages in #print-root, which the print stylesheet shows on its own. */
export async function preparePrintRoot(L) {
  await ensureMedia(mediaIdsOf(L));
  usePageSize(L);
  const { pages } = layoutLetter(L, { preview: false });
  setPrintPaper();
  // A hair under the paper's height, or rounding in the print engine can spill a blank page after each sheet.
  for (const page of pages) page.style.height = `${PAGE.h - 0.2}mm`;
  const root = $('#print-root');
  root.textContent = '';
  root.append(...pages);
  await fontsAndImagesReady(root);
  return pages.length;
}

/** The letter as a file should hold it: all of it, or only the pages asked for. Pages are counted from zero. */
const partOf = (L, pages) => (pages?.length ? letterWithPages(L, pages) : L);
const pagesLabel = (pages) => (pages?.length ? ` - صفحهٔ ${toFaDigits(pages.map((p) => p + 1).join('، '))}` : '');

export async function makePdf(L, { pages } = {}) {
  await preparePrintRoot(partOf(L, pages));
  const name = `${fileBaseName(L)}${pagesLabel(pages)}.pdf`;
  if (!N) {
    window.print();
    return { name, system: true };
  }
  const mils = (mm) => Math.round((mm / 25.4) * 1000);
  const result = await nativeCall('exportPdf', name, mils(PAGE.w), mils(PAGE.h));
  return { name, system: result === 'system' };
}

function download(name, bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

let vazirmatnFiles = null;

/** Vazirmatn is on few computers, so a letter set in it carries the font inside its Word file. */
async function fontsToCarry(L) {
  if (!JSON.stringify([L.styles, L.body, L.objects]).includes('Vazirmatn')) return null;
  if (!vazirmatnFiles) {
    const read = async (name) => new Uint8Array(await (await fetch(`fonts/${name}`)).arrayBuffer());
    try {
      const [regular, bold] = await Promise.all([read('Vazirmatn-Regular.ttf'), read('Vazirmatn-Bold.ttf')]);
      vazirmatnFiles = { regular, bold };
    } catch (err) {
      console.warn(err);
      return null;
    }
  }
  return vazirmatnFiles;
}

export async function makeDocx(whole, { deliver = true, pages } = {}) {
  const L = partOf(whole, pages);
  await ensureMedia(mediaIdsOf(L));
  const info = layoutLetter(L);
  const embedFonts = await fontsToCarry(L);
  const lookup = (id) => {
    const url = mediaUrl(id);
    return url ? dataUrlToBytes(url) : null;
  };
  const bytes = buildDocx(L, lookup, { pageCount: info.total, pageAnchors: info.pageAnchors, flowPos: info.flowPos, embedFonts });
  const name = `${fileBaseName(L)}${pagesLabel(pages)}.docx`;
  if (N) N.writeExport(name, bytesToBase64(bytes));
  else if (deliver) download(name, bytes, MIME.docx);
  return { name, bytes };
}

export function shareFile(name, mime) {
  if (N) N.share(name, mime);
}

export function saveFile(name, mime) {
  return N ? nativeCall('saveToDownloads', name, mime) : Promise.resolve('');
}

export const canShare = !!N;

/** Hands any file the app made to the user: 'share' opens the send sheet, 'save' puts it in Downloads. */
export async function deliverFile(name, bytes, mime, mode = 'save') {
  if (!N) {
    download(name, bytes, mime);
    return '';
  }
  N.writeExport(name, bytesToBase64(bytes));
  if (mode === 'share') {
    shareFile(name, mime);
    return '';
  }
  return saveFile(name, mime);
}
