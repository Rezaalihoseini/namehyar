// Fonts the user uploads. The family name and line height are read from the file itself,
// so the page engine measures the font the way Word will, and Word finds it by the same name.

import { uid, readFileAsDataUrl, dataUrlToBytes } from './util.js';
import { allFonts, registerFont, unregisterFont } from './model.js';
import { ensureMedia, mediaUrl, putMedia } from './store.js';

const faces = new Map();

function utf16be(bytes) {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

/** Reads a .ttf or .otf file's family name and its single line height relative to the font size. */
export function readFontInfo(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (!['\x00\x01\x00\x00', 'OTTO', 'true'].includes(tag(0))) throw new Error('not a TrueType or OpenType font');
  const tables = {};
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    tables[tag(at)] = view.getUint32(at + 8);
  }
  if (tables.head === undefined || tables.name === undefined) throw new Error('font tables missing');

  const unitsPerEm = view.getUint16(tables.head + 18);
  let ratio = 1.5;
  if (tables['OS/2'] !== undefined) ratio = (view.getUint16(tables['OS/2'] + 74) + view.getUint16(tables['OS/2'] + 76)) / unitsPerEm;
  else if (tables.hhea !== undefined) ratio = (view.getInt16(tables.hhea + 4) - view.getInt16(tables.hhea + 6)) / unitsPerEm;

  const nameCount = view.getUint16(tables.name + 2);
  const strings = tables.name + view.getUint16(tables.name + 4);
  let family = '';
  for (let i = 0; i < nameCount; i++) {
    const at = tables.name + 6 + i * 12;
    if (view.getUint16(at + 6) !== 1) continue;
    const platform = view.getUint16(at);
    const data = bytes.subarray(strings + view.getUint16(at + 10), strings + view.getUint16(at + 10) + view.getUint16(at + 8));
    if (platform === 3) {
      family = utf16be(data);
      break;
    }
    if (!family) family = String.fromCharCode(...data);
  }
  if (!family) throw new Error('font has no name');
  return { family: family.trim(), ratio: Math.round(ratio * 1000) / 1000 };
}

async function activate(font) {
  await ensureMedia([font.mediaId]);
  const url = mediaUrl(font.mediaId);
  if (!url) return;
  const face = new FontFace(font.family, `url(${url})`, { weight: '400 700' });
  await face.load();
  document.fonts.add(face);
  faces.set(font.family, face);
  registerFont(font.family, font.ratio);
}

export async function loadCustomFonts(settings) {
  await Promise.all((settings.fonts || []).map((font) => activate(font).catch((err) => console.error('font failed', font.family, err))));
}

/** Adds an uploaded font file to the app. Returns its family name. */
export async function installFont(file, settings) {
  const dataUrl = await readFileAsDataUrl(file);
  const { family, ratio } = readFontInfo(dataUrlToBytes(dataUrl).bytes);
  const mediaId = uid();
  await putMedia(mediaId, dataUrl);
  const font = { family, ratio, mediaId };
  await activate(font);
  settings.fonts = [...(settings.fonts || []).filter((f) => f.family !== family), font];
  return family;
}

let ruler = null;
const found = new Map();

/** Whether this device can really show a font, or only something in its place. */
export function fontIsHere(family) {
  if (allFonts().includes(family)) return true;
  if (found.has(family)) return found.get(family);
  ruler = ruler || document.createElement('canvas').getContext('2d');
  const widthIn = (stack) => {
    ruler.font = `40px ${stack}`;
    return ruler.measureText('ابجد هوز 123 abc').width;
  };
  const here = widthIn(`"${family}", monospace`) !== widthIn('monospace') || widthIn(`"${family}", serif`) !== widthIn('serif');
  found.set(family, here);
  return here;
}

export function removeFont(family, settings) {
  const face = faces.get(family);
  if (face) document.fonts.delete(face);
  faces.delete(family);
  unregisterFont(family);
  settings.fonts = (settings.fonts || []).filter((f) => f.family !== family);
}
