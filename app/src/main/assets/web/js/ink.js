// A page taken exactly from a PDF draws each line with the letters of the PDF's own fonts, each at the very place it had there,
// so it looks the same on a phone that has none of those fonts. The drawing is kept apart from the letter (it is large), and is
// used for as long as a line stays as it came. The moment its words or font change, the line is written as ordinary text,
// and when they go back the drawing comes back too.

import { TEXT_STYLE, frameLines } from './model.js';
import { mediaUrl } from './store.js';
import { dataUrlToBytes } from './util.js';
import { runAt } from './runs.js';

const INK_PREFIX = 'ink:';
const parsed = new Map();
const faces = new Map();

export const inkFamily = (mediaId) => `ink-${mediaId}`;

/** What a line must still be for its drawing to be right. Colour is left out: a drawing can take a new colour. */
export function frameSignature(o) {
  const st = { ...TEXT_STYLE, ...o.style };
  // Runs with the same look count as one, however a change of colour has cut them.
  const lines = frameLines(o).map((runs) => {
    const merged = [];
    for (const run of runs) {
      const look = [run.font || st.font, run.size || st.size, run.b ?? !!st.bold, !!(run.u ?? st.underline), !!run.i].join('|');
      const last = merged[merged.length - 1];
      if (last && last[0] === look) last[1] += run.text || '';
      else merged.push([look, run.text || '']);
    }
    return merged;
  });
  return JSON.stringify([st.dir || '', lines]);
}

export const inkToMedia = (data) => `${INK_PREFIX}${JSON.stringify(data)}`;

function inkData(L) {
  const id = L.ink?.id;
  if (!id) return null;
  if (parsed.has(id)) return parsed.get(id);
  const text = mediaUrl(id);
  if (!text) return null;
  const data = JSON.parse(text.slice(INK_PREFIX.length));
  parsed.set(id, data);
  return data;
}

/** A line's drawing, when it is still right for the line. */
export function inkOf(L, o) {
  if (!o.ink || !L.ink) return null;
  const rec = inkData(L)?.frames[o.ink];
  if (!rec || rec.sig !== frameSignature(o)) return null;
  return rec.parts.every((part) => L.ink.fonts[part.f]) ? rec : null;
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One stretch of letters of one font and colour. */
function textTag(family, part, chars, xs, color) {
  const hs = part.hs || 1;
  const scaled = hs === 1 ? xs : xs.map((x) => Math.round((x / hs) * 100) / 100);
  const stretch = hs === 1 ? '' : ` transform="scale(${hs} 1)"`;
  return `<text font-family="${family}" font-size="${part.s}" y="${part.y}" x="${scaled.join(' ')}" fill="#${color}"${stretch}>${escapeXml(chars)}</text>`;
}

/** The drawing of a line as SVG, in points from the top left of its frame. */
export function inkMarkup(L, o, rec) {
  const st = { ...TEXT_STYLE, ...o.style };
  const runs = frameLines(o)[0] || [];
  const single = runs.length < 2;
  const colorAt = (offset) => (single ? runs[0]?.color : runAt(runs, offset)?.color) || st.color || '000000';
  let tags = '';
  for (const part of rec.parts) {
    const family = inkFamily(L.ink.fonts[part.f]);
    const chars = [...part.chars];
    let from = 0;
    for (let i = 1; i <= chars.length; i++) {
      if (i < chars.length && colorAt(part.offs[i]) === colorAt(part.offs[from])) continue;
      tags += textTag(family, part, chars.slice(from, i).join(''), part.xs.slice(from, i), colorAt(part.offs[from]));
      from = i;
    }
  }
  // A line keeps to the edge it starts from, should its frame be made wider or narrower.
  const edge = st.dir === 'ltr' ? '' : ` style="left:calc(100% - ${rec.w}pt)"`;
  return `<svg class="ink" viewBox="0 0 1 1" aria-hidden="true"${edge}>${tags}</svg>`;
}

/** Where a stretch of a line's text is drawn on the screen. */
export function inkRects(L, o, frameEl, from, to) {
  const rec = inkOf(L, o);
  if (!rec) return [];
  const words = rec.words.filter(([start, end]) => start < to && end > from);
  if (!words.length) return [];
  const box = frameEl.getBoundingClientRect();
  // The frame's height on the screen says how large it is drawn at the moment.
  const k = box.height / { ...TEXT_STYLE, ...o.style }.line;
  const origin = { ...TEXT_STYLE, ...o.style }.dir === 'ltr' ? box.left : box.right - rec.w * k;
  const left = Math.min(...words.map((w) => w[2]));
  const right = Math.max(...words.map((w) => w[3]));
  return [{ left: origin + left * k, right: origin + right * k, top: box.top, bottom: box.bottom, width: (right - left) * k, height: box.height }];
}

/** Makes the PDF's own fonts ready for drawing. Fonts that could not be used are reported, so their lines can be written as text. */
export async function loadInkFonts(L) {
  const failed = [];
  await Promise.all(Object.entries(L.ink?.fonts || {}).map(async ([key, mediaId]) => {
    let face = faces.get(mediaId);
    if (!face) {
      const url = mediaUrl(mediaId);
      if (!url) {
        failed.push(key);
        return;
      }
      const made = new FontFace(inkFamily(mediaId), dataUrlToBytes(url).bytes.buffer);
      document.fonts.add(made);
      face = made.load();
      faces.set(mediaId, face);
    }
    try {
      await face;
    } catch (err) {
      console.warn('a font of the PDF could not be used', key, err);
      failed.push(key);
    }
  }));
  return failed;
}
