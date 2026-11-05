// Opens a PDF as an editable letter, which can then be saved as Word. A PDF only knows where each piece of text sits
// on the page, so paragraphs, tables and the letterhead are worked out from those positions and handed to the same
// recognition as a Word file. A scanned PDF holds only pictures of its pages: it comes in as those pictures, with
// room to put text frames on top, because reading Persian from a picture is not possible offline.

import { bytesToBase64, loadImage, uid } from './util.js';
import { bodyParagraph, bodyTable, dominantStyle, flatten, isInvocation, letterFromDocument, parseMeta } from './import-docx.js';
import { DEFAULT_STYLES, MM_PER_PT, PAGE, ascentShare, lineRatio, newLetter, pageSizeToKeep, usePageSize } from './model.js';
import { letterFromExactPdf } from './import-pdf-exact.js';
import { blocksToHtml, serializeEditor } from './editor.js';
import { mediaUrl, putMedia } from './store.js';
import { toFaDigits } from './text.js';
import { recoverZeroAdvanceSpace } from './pdf-spacing.js';

const MM_PER_TWIP = 1 / 56.6929;
const MAX_IMAGE_SIDE = 1600;
const RTL_TEXT = /[\u0600-\u065f\u066a-\u06ef\u06fa-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/;
const LTR_TEXT = /[A-Za-z0-9۰-۹٠-٩]/;
const NEUTRAL = /^[\s/\\.:,\-–_%+()]*$/;
const ZWNJ = '‌';

/* ---------- Joined letters. A PDF made by a browser draws each letter in its joined shape, which says where a half-space stood ---------- */

// Every shape a letter can take has its own code: alone, last in a word, first in a word, or in the middle.
const SHAPE = new Map();
for (let cp = 0xfe80, base = null, group = []; cp <= 0xfefd; cp++) {
  const letter = cp <= 0xfefc ? String.fromCodePoint(cp).normalize('NFKC') : null;
  if (letter !== base) {
    const order = group.length === 4 ? 'alone last first middle' : 'alone last';
    group.forEach((code, k) => SHAPE.set(code, order.split(' ')[k] || 'alone'));
    group = [];
    base = letter;
  }
  group.push(cp);
}
for (const start of [0xfb56, 0xfb7a, 0xfb8e, 0xfb92, 0xfbfc]) ['alone', 'last', 'first', 'middle'].forEach((shape, k) => SHAPE.set(start + k, shape));
SHAPE.set(0xfb8a, 'alone');
SHAPE.set(0xfb8b, 'last');

const SHAPED_LETTER = /[ﭐ-﷿ﹰ-﻿]/;
const LETTER = /[\u0622-\u064a\u066e-\u06d3\u06d5]/;
const ANY_LETTER = /[\u0622-\u064a\u066e-\u06d3\u06d5ﭐ-﷿ﹰ-﻿]/g;
const NEVER_JOINS_ON = /[اآأإٱدذرزژوؤةۀ]/;
const INVISIBLE_ONLY = /^[\u200c\u200d]+$/;

/** The shape of a letter shows it is joined to the letter beside it, so nothing can stand between them, not even a space. */
function joinedShapes(a, b) {
  const shapeA = SHAPE.get(a?.codePointAt(0));
  const shapeB = SHAPE.get(b?.codePointAt(0));
  return shapeA === 'first' || shapeA === 'middle' || shapeB === 'last' || shapeB === 'middle';
}

/**
 * Whether two letters in a row stand apart though nothing but a half-space could have parted them.
 * This is only for a PDF that does not say what its letters are. Some fonts write certain joined letters in their plain code
 * (plainJoined holds those), so between two such letters a plain code proves nothing.
 */
function partedLetters(a, b, plainJoined) {
  const lastOfA = a.normalize('NFKC').slice(-1);
  const firstOfB = b.normalize('NFKC')[0];
  if (!LETTER.test(lastOfA) || !LETTER.test(firstOfB) || NEVER_JOINS_ON.test(lastOfA)) return false;
  // A ligature comes through as its two letters, side by side.
  if (lastOfA === 'ل' && /[اآأإ]/.test(firstOfB)) return false;
  if (joinedShapes(a, b)) return false;
  if (SHAPE.has(a.codePointAt(0)) || SHAPE.has(b.codePointAt(0))) return true;
  return !plainJoined?.has(a) && !plainJoined?.has(b);
}

/** Going along each line, right to left: the letters each font writes in plain code even when the shape beside them shows they are joined. */
function plainJoinedLetters(pieces) {
  const found = new Map();
  const add = (piece, letter) => {
    if (!found.has(piece.rawFont)) found.set(piece.rawFont, new Set());
    found.get(piece.rawFont).add(letter);
  };
  const shapeOf = (ch) => SHAPE.get(ch.codePointAt(0));
  const inOrder = [...pieces].sort((p, q) => Math.round(p.y) - Math.round(q.y) || q.x - p.x);
  inOrder.forEach((piece, i) => {
    const next = inOrder[i + 1];
    const { drawn } = piece;
    const pairs = drawn.slice(0, -1).map((ch, k) => [ch, drawn[k + 1]]);
    if (next && Math.round(next.y) === Math.round(piece.y) && piece.x - (next.x + next.w) < 0.3) pairs.push([drawn[drawn.length - 1], next.drawn[0]]);
    for (const [a, b] of pairs) {
      if (!shapeOf(a) && (shapeOf(b) === 'last' || shapeOf(b) === 'middle')) add(piece, a);
      if (!shapeOf(b) && (shapeOf(a) === 'first' || shapeOf(a) === 'middle')) add(piece, b);
    }
  });
  return found;
}

/** The plain letters of a piece of text that came in joined shapes, with its half-spaces put back. */
function plainLetters(text, shaped, plainJoined) {
  const chars = [...text];
  let out = '';
  chars.forEach((ch, i) => {
    out += ch;
    if (shaped && chars[i + 1] && partedLetters(ch, chars[i + 1], plainJoined)) out += ZWNJ;
  });
  return out.replace(/[ﬀ-﷿ﹰ-﻿]+/g, (shapes) => shapes.normalize('NFKC')).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
}

let library = null;

async function loadLibrary() {
  if (!library) {
    library = await import('../vendor/pdfjs/pdf.min.js');
    // Runs on the page itself rather than in a worker: Android's WebView does not reliably let this app
    // serve a worker's script when there is no network, and a letter is small enough not to need one.
    globalThis.pdfjsWorker = await import('../vendor/pdfjs/pdf.worker.min.js');
  }
  return library;
}

/* ---------- Reading one page: text, ruled lines and pictures, in millimetres from the top right of the sheet ---------- */

const SANS_FONT = /shabnam|vazir|sahel|samim|tanha|gandom|parastoo|yekan|iransans|dana|estedad|tahoma|arial|segoe|roboto|notosans|helvetica|sans/;

function fontOf(page, fontName, plainFonts) {
  const info = page.commonObjs.has(fontName) ? page.commonObjs.get(fontName) : null;
  const raw = (info?.name || '').replace(/^[A-Z]{6}\+/, '');
  const key = raw.toLowerCase().replace(/[\s_,-]/g, '');
  let family;
  if (/nazanin|naznn/.test(key)) family = 'B Nazanin';
  else if (/titr/.test(key)) family = 'B Titr';
  else if (/lotus/.test(key)) family = 'B Lotus';
  else if (/zar/.test(key)) family = 'B Zar';
  else if (SANS_FONT.test(key)) family = 'Vazirmatn';
  // A browser that thickens a font with no bold of its own writes the thick letters as a separate kind of font.
  const thickened = info?.type === 'Type3' && plainFonts?.has(raw);
  const bold = thickened || !!info?.bold || !!info?.black || /bold|bd$|black|heavy|titr/.test(key);
  // These fonts draw Persian digits for the codes of Latin ones.
  const faDigits = /(fd|fanum|farsidigits)$/.test(key);
  return { font: family, bold, rawFont: raw, faDigits };
}

function readGraphics(pdfjs, page, ops, viewport, kx, ky) {
  const { OPS, Util } = pdfjs;
  const rules = [];
  const fills = [];
  const pictures = [];
  const stack = [];
  let ctm = viewport.transform;
  let state = { lineWidth: 1, fill: null, soft: false };
  // What is drawn into a soft mask is never seen on the page: it only says how see-through something else is.
  const groups = [];
  const toPage = (x, y) => {
    const p = Util.applyTransform([x, y], ctm);
    return [p[0] * kx, p[1] * ky];
  };
  const strokeMm = () => Math.max(0.05, state.lineWidth * Math.hypot(ctm[0], ctm[1]) * kx);
  const addSegment = (a, b) => {
    if (Math.abs(a[1] - b[1]) < 0.4 && Math.abs(a[0] - b[0]) > 2) rules.push({ kind: 'h', y: (a[1] + b[1]) / 2, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), t: strokeMm() });
    else if (Math.abs(a[0] - b[0]) < 0.4 && Math.abs(a[1] - b[1]) > 2) rules.push({ kind: 'v', x: (a[0] + b[0]) / 2, y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]), t: strokeMm() });
  };
  const STROKES = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const FILLS = new Set([OPS.fill, OPS.eoFill]);

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.beginGroup) {
      groups.push(!!args[0]?.smask);
      stack.push({ ctm, state });
      state = { ...state };
    } else if (fn === OPS.endGroup) {
      groups.pop();
      const saved = stack.pop();
      if (saved) ({ ctm, state } = saved);
    } else if (fn === OPS.save) {
      stack.push({ ctm, state });
      state = { ...state };
    } else if (fn === OPS.restore) {
      const saved = stack.pop();
      if (saved) ({ ctm, state } = saved);
    } else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ctm, state });
      state = { ...state };
      if (args[0]) ctm = Util.transform(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) {
      const saved = stack.pop();
      if (saved) ({ ctm, state } = saved);
    } else if (fn === OPS.setGState) {
      // A picture seen through a soft mask or a blend only looks right as the page draws it.
      for (const [key, value] of args[0]) {
        if ((key === 'SMask' && value) || (key === 'ca' && value < 0.999) || (key === 'BM' && value !== 'source-over')) state.soft = true;
      }
    } else if (fn === OPS.setLineWidth) state.lineWidth = args[0];
    else if (fn === OPS.setFillRGBColor) state.fill = args.length === 3 ? [...args] : null;
    else if (fn === OPS.setFillGray) state.fill = [args[0] * 255, args[0] * 255, args[0] * 255];
    else if (groups.includes(true)) continue;
    else if (fn === OPS.constructPath) {
      const next = ops.fnArray[i + 1];
      const stroked = STROKES.has(next);
      const filled = FILLS.has(next);
      if (!stroked && !filled) continue;
      const [pathOps, coords] = args;
      let c = 0;
      let at = null;
      for (const op of pathOps) {
        if (op === OPS.rectangle) {
          const [x, y, w, hgt] = coords.slice(c, c + 4);
          c += 4;
          const p0 = toPage(x, y);
          const p1 = toPage(x + w, y + hgt);
          const left = Math.min(p0[0], p1[0]);
          const right = Math.max(p0[0], p1[0]);
          const top = Math.min(p0[1], p1[1]);
          const bottom = Math.max(p0[1], p1[1]);
          // Word and browsers draw table borders as very thin filled boxes.
          if (bottom - top < 0.9 && right - left > 2) rules.push({ kind: 'h', y: (top + bottom) / 2, x0: left, x1: right, t: bottom - top });
          else if (right - left < 0.9 && bottom - top > 2) rules.push({ kind: 'v', x: (left + right) / 2, y0: top, y1: bottom, t: right - left });
          else if (stroked) {
            addSegment([left, top], [right, top]);
            addSegment([left, bottom], [right, bottom]);
            addSegment([left, top], [left, bottom]);
            addSegment([right, top], [right, bottom]);
          } else if (state.fill && state.fill.some((v) => v < 245) && right - left > 2 && bottom - top > 1) {
            fills.push({ x0: left, x1: right, y0: top, y1: bottom, color: state.fill.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase() });
          }
        } else if (op === OPS.moveTo) {
          at = toPage(coords[c], coords[c + 1]);
          c += 2;
        } else if (op === OPS.lineTo) {
          const to = toPage(coords[c], coords[c + 1]);
          c += 2;
          if (stroked && at) addSegment(at, to);
          at = to;
        } else if (op === OPS.curveTo) {
          c += 6;
        } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
          c += 4;
        }
      }
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const p0 = toPage(0, 0);
      const p1 = toPage(1, 1);
      const box = { x: Math.min(p0[0], p1[0]), y: Math.min(p0[1], p1[1]), w: Math.abs(p1[0] - p0[0]), h: Math.abs(p1[1] - p0[1]) };
      if (box.w > 3 && box.h > 3) pictures.push({ ...box, source: args[0], soft: state.soft, kx, ky });
    }
  }
  return { rules, fills, pictures };
}

function rawImageOf(page, source) {
  if (typeof source !== 'string') return source;
  const store = source.startsWith('g_') ? page.commonObjs : page.objs;
  return store.has(source) ? store.get(source) : null;
}

/** A picture as the page itself draws it, its masks and shadows included, cut out of the page without the page's text. */
async function pictureFromPage(page, picture) {
  const base = page.getViewport({ scale: 1 });
  const k = Math.min(300 / 72, 5000 / Math.max(base.width, base.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(base.width * k);
  canvas.height = Math.ceil(base.height * k);
  globalThis.__pdfTextPaint = () => false;
  try {
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale: k }) }).promise;
  } finally {
    delete globalThis.__pdfTextPaint;
  }
  const x0 = Math.max(0, Math.floor((picture.x / picture.kx) * k));
  const y0 = Math.max(0, Math.floor((picture.y / picture.ky) * k));
  const piece = document.createElement('canvas');
  piece.width = Math.max(1, Math.min(canvas.width - x0, Math.ceil((picture.w / picture.kx) * k)));
  piece.height = Math.max(1, Math.min(canvas.height - y0, Math.ceil((picture.h / picture.ky) * k)));
  piece.getContext('2d').drawImage(canvas, x0, y0, piece.width, piece.height, 0, 0, piece.width, piece.height);
  const id = uid();
  await putMedia(id, piece.toDataURL('image/png'));
  return id;
}

/** Saves a picture from the PDF as an image of the letter. The same logo on every page is saved once. */
async function pictureToMedia(page, picture, known) {
  // A picture found on a scan comes ready cut out.
  if (picture.url) {
    const id = uid();
    await putMedia(id, picture.url);
    return id;
  }
  if (picture.soft) return pictureFromPage(page, picture);
  const key = typeof picture.source === 'string' ? picture.source : null;
  if (key && known.has(key)) return known.get(key);
  const data = rawImageOf(page, picture.source);
  if (!data) return null;
  const width = data.width || data.bitmap?.width;
  const height = data.height || data.bitmap?.height;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * k));
  canvas.height = Math.max(1, Math.round(height * k));
  const ctx = canvas.getContext('2d');
  if (data.bitmap) ctx.drawImage(data.bitmap, 0, 0, canvas.width, canvas.height);
  else {
    const full = document.createElement('canvas');
    full.width = width;
    full.height = height;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const src = data.data;
    if (data.kind === 3) rgba.set(src.subarray(0, rgba.length));
    else if (data.kind === 2) {
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        rgba[i] = src[j];
        rgba[i + 1] = src[j + 1];
        rgba[i + 2] = src[j + 2];
        rgba[i + 3] = 255;
      }
    } else {
      const rowBytes = (width + 7) >> 3;
      for (let y = 0, i = 0; y < height; y++) {
        for (let x = 0; x < width; x++, i += 4) {
          const v = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
          rgba[i] = v;
          rgba[i + 1] = v;
          rgba[i + 2] = v;
          rgba[i + 3] = 255;
        }
      }
    }
    full.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
  }
  const id = uid();
  await putMedia(id, canvas.toDataURL('image/png'));
  if (key) known.set(key, id);
  return id;
}

/**
 * A browser marks most letters it draws with the letter the page really had (a PDF's "actual text"), half-spaces included.
 * This goes through a page's text and its marks, and gives the pieces of text in the file's order, each with those words.
 * A half-space has nothing drawn for it, so it comes as a mark of its own between two pieces.
 */
function markedPieces(contentItems, useActualText) {
  const entries = [];
  const open = [];
  const close = (span) => {
    const oneLine = span.items.every((it) => Math.abs(it.transform[5] - span.items[0].transform[5]) < 1);
    if (INVISIBLE_ONLY.test(span.text)) entries.push({ mark: span.text });
    else if (span.items.length && span.text.trim() && oneLine) entries.push({ items: span.items, actual: span.text });
    else entries.push(...span.items.map((it) => ({ items: [it] })));
  };
  for (const it of contentItems) {
    if (it.type === 'beginMarkedContent' || it.type === 'beginMarkedContentProps') {
      // Marks can sit inside marks, and only the outermost one counts.
      open.push(useActualText && it.actualText && !open.some(Boolean) ? { text: it.actualText, items: [] } : null);
    } else if (it.type === 'endMarkedContent') {
      const span = open.pop();
      if (span) close(span);
    } else if (it.str?.trim()) {
      const span = open.find(Boolean);
      if (span) span.items.push(it);
      else entries.push({ items: [it] });
    }
  }
  open.filter(Boolean).forEach(close);
  return entries;
}

const lettersIn = (text) => (text.match(ANY_LETTER) || []).length;

async function readPage(pdfjs, page, { useActualText = true } = {}) {
  const viewport = page.getViewport({ scale: 1 });
  const kx = PAGE.w / viewport.width;
  const ky = PAGE.h / viewport.height;
  const ops = await page.getOperatorList();
  // Left as they are, the joined shapes of the letters still say where half-spaces stood.
  const content = await page.getTextContent({ disableNormalization: true, includeMarkedContent: true });
  const fontInfo = (it) => (page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null);
  const advancesByFont = new Map();
  let currentFont = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === pdfjs.OPS.setFont) currentFont = ops.argsArray[i][0];
    if (ops.fnArray[i] !== pdfjs.OPS.showText || !currentFont) continue;
    if (!advancesByFont.has(currentFont)) advancesByFont.set(currentFont, new Map());
    const advances = advancesByFont.get(currentFont);
    const matrix = fontInfo({ fontName: currentFont })?.fontMatrix?.[0] || 0.001;
    for (const glyph of ops.argsArray[i][0]) {
      if (glyph && typeof glyph === 'object' && typeof glyph.unicode === 'string' && [...glyph.unicode].length === 1) advances.set(glyph.unicode, Math.abs(matrix) * glyph.width);
    }
  }
  const rawName = (info) => (info?.name || '').replace(/^[A-Z]{6}\+/, '');
  const plainFonts = new Set();
  for (const it of content.items) {
    if (it.type) continue;
    const info = fontInfo(it);
    if (info && info.type !== 'Type3') plainFonts.add(rawName(info));
  }

  const pieces = [];
  let mark = '';
  let marks = 0;
  for (const entry of markedPieces(content.items, useActualText)) {
    if (entry.mark) {
      mark = entry.mark;
      marks++;
      continue;
    }
    const it = entry.items[0];
    const t = pdfjs.Util.transform(viewport.transform, it.transform);
    // Text at an angle is a watermark or a stamp, not part of the letter's lines.
    if (Math.abs(t[1]) > Math.abs(t[0]) * 0.1) continue;
    const spots = entry.items.map((one) => {
      const left = pdfjs.Util.transform(viewport.transform, one.transform)[4] * kx;
      return [left, left + (one.width || 0) * kx];
    });
    const x = Math.min(...spots.map((s) => s[0]));
    const raw = entry.actual ?? recoverZeroAdvanceSpace(it.str, it.width, Math.hypot(it.transform[0], it.transform[1]), advancesByFont.get(it.fontName));
    // The shapes drawn, as the file names them, still show which letters are joined.
    const drawn = [...entry.items.map((one) => one.str).join('')];
    pieces.push({ t, raw, drawn, actual: entry.actual !== undefined, x, y: t[5] * ky, w: Math.max(...spots.map((s) => s[1])) - x, markBefore: mark, ...fontOf(page, it.fontName, plainFonts) });
    mark = '';
  }
  // The file's order runs left to right along a line, so a half-space belongs to the end of the piece on its right.
  pieces.forEach((piece, i) => {
    const before = pieces[i - 1];
    if (piece.markBefore && before && Math.abs(before.y - piece.y) < 1) (piece.x >= before.x ? piece : before).after = piece.markBefore;
  });

  // When the file says what its letters are, there is nothing to work out. Some makers only say it for a few awkward letters.
  const covered = pieces.filter((p) => p.actual).reduce((sum, p) => sum + lettersIn(p.raw), 0);
  const told = marks > 0 || (covered > 0 && covered >= pieces.reduce((sum, p) => sum + lettersIn(p.raw), 0) * 0.5);
  const plainJoined = told ? new Map() : plainJoinedLetters(pieces);

  const items = pieces.map((piece) => {
    const { t, raw, drawn, x, y, w, font, bold, rawFont, faDigits, after = '' } = piece;
    // A font is often split into parts to keep the file small: what one part shows holds for all of them.
    const shaped = !told && pieces.some((p) => p.rawFont === rawFont && SHAPED_LETTER.test(p.raw));
    const joined = plainJoined.get(rawFont);
    // Some PDF makers name each letter by its joined shape (ﺑ for ب); the letter itself is what can be edited.
    const plain = `${plainLetters(raw, shaped, joined)}${after}`;
    const size = Math.round(Math.hypot(t[2], t[3]) * 2) / 2;
    return { text: faDigits ? plain.replace(/[0-9]/g, (d) => toFaDigits(d)) : plain, x, y, w, size, font, bold, rawFont, shaped, told, joined, head: drawn[0], tail: drawn[drawn.length - 1] };
  });
  return { items, ...readGraphics(pdfjs, page, ops, viewport, kx, ky) };
}

/* ---------- From scattered pieces of text to lines ---------- */

const emMm = (size) => size * MM_PER_PT;

function isLtrItem(item) {
  return !RTL_TEXT.test(item.text) && LTR_TEXT.test(item.text);
}

/** Signs written in their drawn order, right after a number or on their own, read the other way in a right-to-left line. */
function signsInReadingOrder(item) {
  const m = /^([\s/\\.:,\-–_+()[\]{}<>«»]*)(.*?)([\s/\\.:,\-–_+()[\]{}<>«»]*)$/su.exec(item.text);
  const [, before, core, after] = m;
  if (RTL_TEXT.test(item.text) || !/\S/.test(`${before}${after}`)) return [item];
  const backwards = (s) => [...s].reverse().join('');
  if (!core) return [{ ...item, text: backwards(item.text) }];
  const room = item.w / item.text.length;
  const pieces = [];
  if (before.trim()) pieces.push({ ...item, text: backwards(before), w: room * before.length });
  pieces.push({ ...item, text: core, x: item.x + room * before.length, w: room * core.length });
  if (after.trim()) pieces.push({ ...item, text: backwards(after), x: item.x + room * (before.length + core.length), w: room * after.length });
  return pieces;
}

/** Puts one line's pieces into reading order. In a right-to-left line, numbers and Latin words keep their own direction. */
function readingOrder(items) {
  const inLine = items.some((i) => RTL_TEXT.test(i.text));
  // A line of numbers can still hold a sign drawn beside them, such as a padlock, which goes where it was seen.
  if (!inLine && items.every((i) => LTR_TEXT.test(i.text) || NEUTRAL.test(i.text))) return items;
  const pieces = inLine ? items.flatMap(signsInReadingOrder) : items;
  const out = [];
  let i = pieces.length - 1;
  while (i >= 0) {
    if (isLtrItem(pieces[i])) {
      let j = i;
      while (j > 0 && (isLtrItem(pieces[j - 1]) || (NEUTRAL.test(pieces[j - 1].text) && j > 1 && isLtrItem(pieces[j - 2])))) j--;
      for (let k = j; k <= i; k++) out.push(pieces[k]);
      i = j - 1;
    } else {
      out.push(pieces[i]);
      i--;
    }
  }
  return out;
}

const BRACKET_PAIR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '«': '»', '»': '«' };

/**
 * A right-to-left line draws "(" as the shape of ")", and most PDF makers name the shape.
 * So brackets that come out closing before they open are the wrong way round, all of them alike.
 */
function brackets(runs, told) {
  const text = runs.map((r) => r.text).join('');
  if (told) return runs;
  if (!RTL_TEXT.test(text)) return runs;
  const first = /[()[\]{}«»]/.exec(text)?.[0];
  if (!first || !')]}»'.includes(first)) return runs;
  return runs.map((r) => ({ ...r, text: r.text.replace(/[()[\]{}«»]/g, (b) => BRACKET_PAIR[b]) }));
}

/**
 * The words of one line, in reading order, split where their look changes.
 * With wideGaps, a clear distance between words stays a distance, for lines where words stand spread out in one cell.
 */
function runsOfItems(items, { wideGaps = false } = {}) {
  const ordered = readingOrder(items);
  const runs = [];
  ordered.forEach((item, n) => {
    const next = ordered[n + 1];
    let text = item.text;
    if (next && !/\s$/.test(text) && !/^\s/.test(next.text)) {
      // Letters can overlap a little, which is no gap at all.
      const gap = item.x >= next.x ? item.x - (next.x + next.w) : next.x - (item.x + item.w);
      const em = emMm(item.size);
      // A browser places letters on whole pixels, which in very small writing looks like a space but is none.
      const wordGap = item.told ? Math.max(em * 0.12, 0.3) : em * 0.12;
      if (text.endsWith(ZWNJ) || joinedShapes(item.tail, next.head)) text += '';
      else if (gap > wordGap) text += wideGaps && gap > em ? ' '.repeat(Math.min(14, Math.round(gap / (em * 0.28)))) : ' ';
      else if (item.shaped && next.shaped && partedLetters(item.tail, next.head, item.joined)) text += ZWNJ;
    }
    const rtl = RTL_TEXT.test(item.text);
    const last = runs[runs.length - 1];
    const look = { font: rtl || !LTR_TEXT.test(item.text) ? item.font : undefined, size: item.size, b: item.bold };
    if (last && last.size === look.size && last.b === look.b && (last.font === look.font || !look.font || !last.font)) {
      last.text += text;
      last.font = last.font || look.font;
    } else runs.push({ text, rtl, ...look, i: false, u: false });
  });
  return brackets(runs, items.some((item) => item.told));
}

const NOT_A_VERB = new Set(['میز', 'میزان', 'میدان', 'میدانی', 'میان', 'میانگین', 'میانه', 'میلیون', 'میلیارد', 'میهمان', 'میزبان', 'میوه', 'میراث', 'میلاد', 'میلادی', 'میکروفون', 'میل', 'میله', 'میخ', 'میش', 'مینا', 'میترا', 'میثم', 'میرزا', 'میر', 'میرود']);
const VERB_AFTER_MI = /^(ن?می)((?:رسان|شو|شد|گرد|گشت|باش|بود|نمای|نمود|کن|کرد|ده|داد|گیر|گرفت|رو|رفت|آی|آمد|تو?ان|خواه|خواست|دار|داشت|گوی|گفت|بین|دید|دان|ساز|ساخت|پذیر|یاب|یافت|بر|آور|فرست|نویس|نوشت|خوان|پرداز|سپار|گذار|گذاشت|شمار|طلب|کوش)[؀-ۿ]*)$/;
const NOT_A_PLURAL = new Set(['تنها', 'تنهایی', 'رها', 'بها', 'آنها', 'آنهایی', 'اینها', 'انتها', 'انتهای', 'انتهایی', 'نهایی', 'بهایی', 'رهایی', 'ماها', 'شماها']);
const PLURAL = /^([؀-ۿ]{2,}?)(ها|های|هایی|هایم|هایت|هایش|هایمان|هایتان|هایشان)$/;
const JOINED = { جنابعالی: 'جناب‌عالی', دانشبنیان: 'دانش‌بنیان', بدینوسیله: 'بدین‌وسیله', تامالاختیار: 'تام‌الاختیار', پیشنویس: 'پیش‌نویس', فوقالذکر: 'فوق‌الذکر', علیالحساب: 'علی‌الحساب', حقالزحمه: 'حق‌الزحمه' };

function restoreHalfSpaces(text) {
  return text
    .replace(/\s*◌?\s*ٔ/g, 'ٔ')
    .replace(/[؀-ۿ]+/g, (word) => {
      if (JOINED[word]) return JOINED[word];
      if (!NOT_A_VERB.has(word)) {
        const verb = VERB_AFTER_MI.exec(word);
        if (verb) return `${verb[1]}‌${verb[2]}`;
      }
      if (!NOT_A_PLURAL.has(word)) {
        const plural = PLURAL.exec(word);
        if (plural) return `${plural[1]}‌${plural[2]}`;
      }
      return word;
    });
}

function chunksOf(items) {
  const chunks = [];
  for (const item of items) {
    const last = chunks[chunks.length - 1];
    if (last && item.x - last.x1 <= Math.max(emMm(item.size) * 2.5, 6)) {
      last.items.push(item);
      last.x1 = Math.max(last.x1, item.x + item.w);
    } else chunks.push({ items: [item], x0: item.x, x1: item.x + item.w });
  }
  for (const chunk of chunks) {
    chunk.runs = plainRuns(chunk.items);
    chunk.text = chunk.runs.map((r) => r.text).join('');
  }
  return chunks;
}

/** A line's runs with its half-spaces: read from the letters' shapes when the PDF has them, otherwise guessed from the words. */
function plainRuns(items, options) {
  const runs = runsOfItems(items, options);
  if (items.some((i) => i.shaped || i.told)) return runs;
  // A font without the small hamza of «نامهٔ» draws it from another font, apart from its letter, which is still one word.
  runs.forEach((run, i) => {
    const hamza = /^\s*◌?\s*ٔ/.exec(run.text);
    if (!hamza || !i) return;
    runs[i - 1].text = `${runs[i - 1].text.replace(/\s+$/, '')}ٔ`;
    run.text = run.text.slice(hamza[0].length);
  });
  return runs.filter((r) => r.text).map((r) => ({ ...r, text: restoreHalfSpaces(r.text) }));
}

function linesOf(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const lines = [];
  for (const item of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - item.y) <= emMm(item.size) * 0.4) line.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.chunks = chunksOf(line.items);
    line.x0 = line.items[0].x;
    line.x1 = Math.max(...line.items.map((i) => i.x + i.w));
    line.size = Math.max(...line.items.map((i) => i.size));
    line.text = line.chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
  }
  return lines;
}

/* ---------- Building the same blocks a Word file gives ---------- */

function makeParagraph(runs, { jc, line, after = 0, indStart, indEnd, indFirst } = {}) {
  const first = runs.find((r) => r.text) || {};
  return {
    kind: 'p',
    props: { before: 0, after: after * 20, ...(line && { line: Math.round(line * 240), lineRule: 'auto' }), indStart, indEnd, indFirst },
    runs,
    floats: [],
    boxes: [],
    lines: [],
    hasPageField: false,
    bidi: true,
    jc,
    markSize: first.size || 11,
    markFont: first.font,
  };
}

const JC = { right: 'left', left: 'right', center: 'center', justify: 'both' };
const twips = (mm) => Math.round(mm / MM_PER_TWIP);
const naturalLine = (size, font, bold) => size * lineRatio(font || 'B Nazanin', bold);

function joinRuns(lines) {
  const runs = [];
  lines.forEach((line, i) => {
    const own = line.chunks.flatMap((c, n) => (n ? [{ ...c.runs[0], text: '\t' }, ...c.runs] : c.runs)).map((r) => ({ ...r }));
    if (i > 0 && runs.length) runs[runs.length - 1].text = `${runs[runs.length - 1].text.replace(/\s+$/, '')} `;
    for (const r of own) {
      const last = runs[runs.length - 1];
      if (last && last.size === r.size && last.b === r.b && last.font === r.font) last.text += r.text;
      else runs.push(r);
    }
  });
  return runs;
}

/** Turns consecutive lines of a page into paragraphs, using where each line starts and ends. */
function paragraphsOf(lines, frame, { exact = false } = {}) {
  const groups = [];
  let group = [];
  const flush = () => {
    if (group.length) groups.push(group);
    group = [];
  };
  const edge = 2.5;
  lines.forEach((line, i) => {
    const prev = group[group.length - 1];
    if (prev) {
      const pitch = line.y - prev.y;
      const reachedEnd = prev.x0 - frame.left < 6;
      const startsAtEdge = frame.right - line.x1 < edge;
      const sameSize = Math.abs(prev.size - line.size) <= 0.5;
      const near = pitch > 0 && pitch < emMm(line.size) * lineRatio('B Nazanin', false) * 2.3;
      const sameAsGroup = group.length < 2 || Math.abs(pitch - (prev.y - group[group.length - 2].y)) < 1.6;
      if (!(reachedEnd && startsAtEdge && sameSize && near && sameAsGroup)) flush();
    }
    group.push(line);
    if (i === lines.length - 1) flush();
  });

  return groups.map((g) => {
    const first = g[0];
    const last = g[g.length - 1];
    const runs = joinRuns(g);
    const mainRun = runs.find((r) => r.text) || {};
    const size = mainRun.size || first.size;
    const pitch = g.length > 1 ? (last.y - first.y) / (g.length - 1) : 0;
    const spacing = pitch ? Math.max(0.8, Math.min(3, Math.round((pitch / MM_PER_PT / naturalLine(size, mainRun.font, mainRun.b)) * 100) / 100)) : undefined;

    const rightGap = frame.right - Math.max(...g.map((l) => l.x1));
    const leftGap = Math.min(...g.map((l) => l.x0)) - frame.left;
    let align = 'right';
    let indStart;
    let indEnd;
    let indFirst;
    if (g.length > 1) {
      align = g.slice(0, -1).every((l) => l.x0 - frame.left < edge) ? 'justify' : 'right';
      const firstIndent = frame.right - first.x1;
      if (firstIndent > edge) indFirst = twips(firstIndent);
    } else if (Math.abs(leftGap - rightGap) < 4 && leftGap > 6) {
      align = 'center';
    } else if (rightGap >= edge && leftGap < edge) {
      align = 'left';
    } else if (rightGap >= edge) {
      // A short line that hugs neither side, such as a signature: centred where it stands.
      const centre = (first.x0 + first.x1) / 2;
      const middle = (frame.left + frame.right) / 2;
      align = 'center';
      if (centre < middle) indStart = twips(2 * (middle - centre));
      else indEnd = twips(2 * (centre - middle));
    }

    if (exact && g.length === 1 && align === 'right' && rightGap > 0.3) indStart = twips(rightGap);
    if (exact && g.length === 1 && align === 'left' && leftGap > 0.3) indEnd = twips(leftGap);
    const block = makeParagraph(runs, { jc: JC[align], line: spacing, indStart, indEnd, indFirst });
    const lineMm = naturalLine(size, mainRun.font, mainRun.b) * (spacing || 1) * MM_PER_PT;
    const share = ascentShare(mainRun.font);
    block.y = first.y;
    block.top = first.y - lineMm * share;
    block.bottom = last.y + lineMm * (1 - share);
    return block;
  });
}

/** The blank space between blocks on a page, kept as paragraph spacing. */
function setSpacing(pieces) {
  pieces.forEach((block, i) => {
    const next = pieces[i + 1];
    if (!next) return;
    const gap = Math.round(Math.max(0, next.top - block.bottom) / MM_PER_PT * 2) / 2;
    if (gap < 1) return;
    if (block.kind === 'p') block.props.after = gap * 20;
    else if (next.kind === 'p') next.props.before = gap * 20;
  });
}

/* ---------- Tables ---------- */

// Lines this close together count as one line of a table: a double border, or the edges of two cells meeting.
// A row or a column so thin could hold no text anyway.
const SAME_RULE = 0.85;

const covers = (spans, a, b) => spans.reduce((sum, [p, q]) => sum + Math.max(0, Math.min(q, b) - Math.max(p, a)), 0) > (b - a) * 0.6;

/** Sorts things by a value and groups those that stand within a small distance of the next. */
function groupsAlong(list, valueOf, gap) {
  const groups = [];
  for (const member of [...list].sort((a, b) => valueOf(a) - valueOf(b))) {
    const value = valueOf(member);
    const last = groups[groups.length - 1];
    if (last && value - last.hi <= gap) {
      last.members.push(member);
      last.hi = value;
    } else groups.push({ members: [member], lo: value, hi: value });
  }
  for (const g of groups) g.at = g.members.reduce((sum, m) => sum + valueOf(m), 0) / g.members.length;
  return groups;
}

const levelFrom = (rules) => ({
  y: rules.reduce((sum, r) => sum + r.y, 0) / rules.length,
  lo: Math.min(...rules.map((r) => r.y)),
  hi: Math.max(...rules.map((r) => r.y)),
  rules,
  spans: rules.map((r) => [r.x0, r.x1]),
});

const levelsOf = (rules) => groupsAlong(rules, (r) => r.y, SAME_RULE).map((g) => levelFrom(g.members));

const columnsOf = (rules) =>
  groupsAlong(rules, (r) => r.x, SAME_RULE).map((g) => ({ x: g.at, lo: g.lo, hi: g.hi, rules: g.members, spans: g.members.map((r) => [r.y0, r.y1]) }));

/** Lines that touch each other, directly or through others, make up one drawing. */
function connectedRules(rules) {
  const parent = rules.map((_, i) => i);
  const find = (i) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) [parent[i], i] = [root, parent[i]];
    return root;
  };
  const reach = 1;
  const touch = (a, b) => {
    if (a.kind === 'h' && b.kind === 'h') return Math.abs(a.y - b.y) <= reach && a.x0 <= b.x1 + reach && b.x0 <= a.x1 + reach;
    if (a.kind === 'v' && b.kind === 'v') return Math.abs(a.x - b.x) <= reach && a.y0 <= b.y1 + reach && b.y0 <= a.y1 + reach;
    const [h, v] = a.kind === 'h' ? [a, b] : [b, a];
    return v.x >= h.x0 - reach && v.x <= h.x1 + reach && h.y >= v.y0 - reach && h.y <= v.y1 + reach;
  };
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (touch(rules[i], rules[j])) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  rules.forEach((rule, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(rule);
  });
  return [...groups.values()];
}

const sameEdges = (a, b) => {
  const [few, many] = a.length <= b.length ? [a, b] : [b, a];
  if (!few.length) return !many.length;
  return few.filter((x) => many.some((y) => Math.abs(x - y) < 1)).length >= few.length * 0.6;
};

/** A double line right across, with different columns on either side of it, is where one table ends and the next begins. */
function splitWhereColumnsChange(levels, cols) {
  const left = Math.min(...levels.flatMap((l) => l.spans.map((s) => s[0])), ...cols.map((c) => c.x));
  const right = Math.max(...levels.flatMap((l) => l.spans.map((s) => s[1])), ...cols.map((c) => c.x));
  const inner = (x) => x > left + 1 && x < right - 1;
  const edgesOf = (rules, top, bottom) => {
    const drawn = cols.filter((c) => inner(c.x) && covers(c.spans, top, bottom)).map((c) => c.x);
    return drawn.length ? drawn : rules.flatMap((r) => [r.x0, r.x1]).filter(inner);
  };
  const parts = [];
  let current = [levels[0]];
  for (let i = 1; i < levels.length; i++) {
    const level = levels[i];
    const next = levels[i + 1];
    if (next && level.hi - level.lo > 0.15 && covers(level.spans, left + 1, right - 1)) {
      const lower = level.rules.filter((r) => r.y >= level.hi - 0.05);
      const upper = level.rules.filter((r) => r.y < level.hi - 0.05);
      if (upper.length && !sameEdges(edgesOf(levels[i - 1].rules, levels[i - 1].y, level.y), edgesOf(lower, level.y, next.y))) {
        current.push(levelFrom(upper));
        parts.push(current);
        current = [levelFrom(lower)];
        continue;
      }
    }
    current.push(level);
  }
  parts.push(current);
  return parts;
}

/** Where text in one row of a band stands in separate groups. */
function clustersOf(items, gap = 1) {
  const out = [];
  for (const it of [...items].sort((a, b) => a.x - b.x)) {
    const last = out[out.length - 1];
    if (last && it.x - last.x1 <= gap) {
      last.items.push(it);
      last.x1 = Math.max(last.x1, it.x + it.w);
    } else out.push({ items: [it], x0: it.x, x1: it.x + it.w });
  }
  return out;
}

const crossed = (items, x) => items.some((it) => it.x < x - 0.4 && it.x + it.w > x + 0.4);

/** The edges of the columns inside a band whose lines were never drawn: where the cells' borders were cut, or else the gaps in its text. */
function columnsInText(band, left, right) {
  const inner = (x) => x > left + 0.5 && x < right - 0.5;
  const fromLine = (level) => {
    const edges = groupsAlong(level.rules.flatMap((r) => [r.x0, r.x1]).filter(inner), (x) => x, SAME_RULE).map((g) => g.at);
    return edges.filter((x) => band.lines.filter((line) => crossed(line.members, x)).length <= band.lines.length * 0.1);
  };
  const upper = fromLine(band.upper);
  if (upper.length) return upper;
  const lower = fromLine(band.lower);
  if (lower.length) return lower;
  const edges = [];
  const covered = clustersOf(band.items, 1.5);
  for (let i = 0; i + 1 < covered.length; i++) edges.push((covered[i].x1 + covered[i + 1].x0) / 2);
  return edges;
}

/** Reads the shape of one table from its lines: its columns, and its rows, including rows that only its text shows. */
function tableShape(levels, allCols, items) {
  const top = levels[0].y;
  const bottom = levels[levels.length - 1].y;
  const cols = allCols.filter((c) => c.spans.some(([a, b]) => Math.min(b, bottom) - Math.max(a, top) > 0.5));
  const left = Math.min(...levels.flatMap((l) => l.spans.map((s) => s[0])), ...cols.map((c) => c.x));
  const right = Math.max(...levels.flatMap((l) => l.spans.map((s) => s[1])), ...cols.map((c) => c.x));
  const inside = items.filter((it) => {
    const cx = it.x + it.w / 2;
    return cx >= left && cx <= right && it.y >= top - 0.3 && it.y <= bottom + 0.3;
  });
  const yOf = (it) => Math.max(top, Math.min(bottom - 0.01, it.y));

  const bands = [];
  for (let i = 0; i + 1 < levels.length; i++) {
    const band = { top: levels[i].y, bottom: levels[i + 1].y, upper: levels[i], lower: levels[i + 1], tabular: false, soft: [] };
    band.items = inside.filter((it) => yOf(it) >= band.top && yOf(it) < band.bottom);
    band.lines = groupsAlong(band.items, (it) => it.y, 0.9);
    band.drawn = cols.filter((c) => covers(c.spans, band.top, band.bottom)).map((c) => c.x);
    if (band.lines.length >= 2) {
      // Rows without any lines between them: at least two lines of text, side by side in the same stretch of the table.
      const stops = [left, ...band.drawn.filter((x) => x > left + 0.5 && x < right - 0.5).sort((a, b) => a - b), right];
      for (let s = 0; s + 1 < stops.length && !band.tabular; s++) {
        const wide = band.lines.filter((line) => clustersOf(line.members.filter((it) => it.x + it.w / 2 >= stops[s] && it.x + it.w / 2 < stops[s + 1])).length >= 2).length;
        if (wide >= 2 && wide >= band.lines.length * 0.5) band.tabular = true;
      }
      if (band.tabular) band.soft = columnsInText(band, left, right);
    }
    bands.push(band);
  }
  const insideLines = cols.some((c) => c.x > left + 1 && c.x < right - 1);
  if (bands.length === 1 && !insideLines && !bands[0].tabular) return null;
  if (!insideLines && bands.every((b) => !b.items.length)) return null;

  let edges = [left, right, ...cols.map((c) => c.x), ...bands.flatMap((b) => b.soft)];
  let xs = groupsAlong(edges, (x) => x, SAME_RULE).map((g) => g.at);
  // Word allows 63 columns; so many are not real ones anyway.
  if (xs.length > 60) {
    edges = [left, right, ...cols.map((c) => c.x)];
    xs = groupsAlong(edges, (x) => x, SAME_RULE).map((g) => g.at);
  }
  if (xs.length < 2) return null;

  const rows = [];
  for (const band of bands) {
    if (!band.tabular) {
      rows.push({ top: band.top, bottom: band.bottom, band, virtual: false });
      continue;
    }
    // A line of text looks centred about a quarter of its size above its baseline.
    const centres = band.lines.map((line) => line.at - emMm(Math.max(...line.members.map((m) => m.size))) * 0.25);
    centres.forEach((centre, i) => {
      const rowTop = i ? (centres[i - 1] + centre) / 2 : band.top;
      const rowBottom = i + 1 < centres.length ? (centre + centres[i + 1]) / 2 : band.bottom;
      rows.push({ top: rowTop, bottom: rowBottom, band, virtual: true });
    });
  }
  return { y: top, top, bottom, left, right, xs, rows, cols, bands, yOf };
}

function findTables(rules, items) {
  const tables = [];
  const lone = [];
  // So many lines are a drawing, not a table.
  if (rules.length > 3000) return { tables, lone };
  for (const group of connectedRules(rules)) {
    const levels = levelsOf(group.filter((r) => r.kind === 'h'));
    const cols = columnsOf(group.filter((r) => r.kind === 'v'));
    if (!cols.length || levels.length < 2) {
      lone.push(...levels);
      continue;
    }
    for (const part of splitWhereColumnsChange(levels, cols)) {
      if (part.length < 2) continue;
      const table = tableShape(part, cols, items);
      if (table) tables.push(table);
    }
  }
  return { tables: tables.sort((a, b) => a.y - b.y), lone: lone.sort((a, b) => a.y - b.y) };
}

const tableAt = (tables, it) =>
  tables.find((t) => {
    const cx = it.x + it.w / 2;
    return cx >= t.left && cx <= t.right && it.y >= t.top - 0.3 && it.y <= t.bottom + 0.3;
  });

/** How a stretch of a line is drawn: its width in points, negative for a double line, 0 where nothing is drawn. */
function drawnWidth(group, a, b, posOf, spanOf) {
  if (!group || !covers(group.spans, a, b)) return 0;
  const here = group.rules.filter((r) => {
    const [p, q] = spanOf(r);
    return Math.min(q, b) - Math.max(p, a) > Math.min(b - a, q - p) * 0.3;
  });
  const places = here.map(posOf).sort((p, q) => p - q);
  const spread = places.length ? places[places.length - 1] - places[0] : 0;
  const thick = here.length ? Math.max(...here.map((r) => r.t || 0.18)) : 0.18;
  const width = Math.round(((spread + thick) / MM_PER_PT) * 4) / 4;
  // Lines that touch make one thicker line; only a clear gap between them makes a double line.
  if (places.some((p, i) => i && p - places[i - 1] > thick + 0.1)) return -Math.min(3, width);
  return Math.max(0.25, width);
}

/** Where to cut one row of a table into cells. Returns the cells as pairs of indexes into the table's column edges. */
function cellsOfRow(table, row, rowItems) {
  const { xs, cols } = table;
  const last = xs.length - 1;
  const stops = [0];
  for (let k = 1; k < last; k++) {
    const col = cols.find((c) => Math.abs(c.x - xs[k]) <= SAME_RULE + 0.1);
    if (col && covers(col.spans, row.band.top, row.band.bottom)) stops.push(k);
  }
  stops.push(last);
  const cuts = new Set(stops);
  for (let s = 0; s + 1 < stops.length; s++) {
    const [a, b] = [stops[s], stops[s + 1]];
    const here = rowItems.filter((it) => it.x + it.w / 2 >= xs[a] && it.x + it.w / 2 <= xs[b]);
    if (row.virtual) {
      for (let k = a + 1; k < b; k++) {
        if (row.band.soft.some((e) => Math.abs(e - xs[k]) <= SAME_RULE + 0.1) && !crossed(here, xs[k])) cuts.add(k);
      }
    } else {
      const groups = clustersOf(here);
      for (let g = 0; g + 1 < groups.length; g++) {
        const gapFrom = groups[g].x1 - 0.2;
        const gapTo = groups[g + 1].x0 + 0.2;
        const middle = (gapFrom + gapTo) / 2;
        let best = -1;
        for (let k = a + 1; k < b; k++) {
          if (xs[k] >= gapFrom && xs[k] <= gapTo && (best < 0 || Math.abs(xs[k] - middle) < Math.abs(xs[best] - middle))) best = k;
        }
        if (best > 0) cuts.add(best);
      }
    }
  }
  const sorted = [...cuts].sort((p, q) => p - q);
  return sorted.slice(0, -1).map((k, i) => [k, sorted[i + 1]]);
}

/**
 * How far below the top of a line of fixed height its baseline falls, in points.
 * A browser centres the letters in the line; Word puts the baseline four fifths of the way down. The middle of the two is off by little in either.
 */
function baselineInLine(linePt, size, font, bold) {
  const ratio = lineRatio(font || 'B Nazanin', bold);
  const ascent = ratio * ascentShare(font);
  const inBrowser = linePt / 2 + ((ascent - (ratio - ascent)) / 2) * size;
  return (inBrowser + linePt * 0.8) / 2;
}

let measuring = null;

function widthOfRuns(runs, font) {
  measuring = measuring || document.createElement('canvas').getContext('2d');
  let px = 0;
  for (const r of runs) {
    measuring.font = `${r.b ? 700 : 400} ${r.size}pt "${r.font || font}"`;
    px += measuring.measureText(r.text).width;
  }
  return px * (25.4 / 96);
}

/** The font here is often wider than the one in the PDF: what no longer fits its cell gets narrower gaps, then smaller letters. */
function fitToWidth(runs, font, room) {
  if (!font || widthOfRuns(runs, font) <= room) return runs;
  let fitted = runs.map((r) => ({ ...r }));
  for (let guard = 0; guard < 14 && widthOfRuns(fitted, font) > room && fitted.some((r) => / {2}/.test(r.text)); guard++) {
    fitted = fitted.map((r) => ({ ...r, text: r.text.replace(/ {2,}/g, (gap) => gap.slice(1)) }));
  }
  const smallest = Math.min(...runs.map((r) => r.size)) * 0.72;
  while (widthOfRuns(fitted, font) > room && Math.min(...fitted.map((r) => r.size)) - 0.5 >= smallest) {
    fitted = fitted.map((r) => ({ ...r, size: r.size - 0.5 }));
  }
  return fitted;
}

/** The lines of a cell, each placed in the cell exactly where it stood on the page, whatever font it ends up in. */
function exactCellParagraphs(lines, box, top, cellPt) {
  let used = 0;
  return lines.map((line) => {
    const font = line.items.find((i) => i.font)?.font;
    const runs = fitToWidth(plainRuns(line.items, { wideGaps: true }), font, box.right - box.left - 0.1);
    const size = Math.max(...runs.map((r) => r.size));
    const bold = runs[0]?.b;
    const height = Math.min(Math.round(size * 2.4) / 2, Math.max(1, cellPt - used));
    const wanted = (line.y - top) / MM_PER_PT - baselineInLine(height, size, font, bold) - used;
    const before = Math.max(0, Math.min(wanted, cellPt - used - height));
    used += before + height;

    const rightGap = box.right - line.x1;
    const leftGap = line.x0 - box.left;
    let align = 'right';
    let indStart;
    let indEnd;
    if (Math.abs(leftGap - rightGap) <= Math.max(0.7, (box.right - box.left) * 0.1)) align = 'center';
    else if (rightGap <= leftGap) {
      if (rightGap > 0.3) indStart = twips(rightGap);
    } else {
      align = 'left';
      if (leftGap > 0.3) indEnd = twips(leftGap);
    }
    const paragraph = makeParagraph(runs, { jc: JC[align], indStart, indEnd });
    paragraph.props.before = Math.round(before * 20);
    paragraph.props.line = Math.round(height * 20);
    paragraph.props.lineRule = 'exact';
    return paragraph;
  });
}

function emptyCellParagraph(rowPt, exact) {
  const paragraph = makeParagraph([], { jc: JC.center });
  if (exact) {
    paragraph.props.line = Math.round(Math.min(rowPt, 6) * 2) * 10;
    paragraph.props.lineRule = 'exact';
  }
  return paragraph;
}

function tableBlock(table, items, frame, { exact = false, fills = [] } = {}) {
  const { xs, cols, yOf } = table;
  // A table's outermost lines are half outside its rows, so its rows take that much less to end where they ended.
  const rows = table.rows.map((row) => ({ ...row }));
  const widest = (level) => Math.max(0, ...level.rules.map((r) => r.t || 0.18)) + level.hi - level.lo;
  rows[0].top += widest(rows[0].band.upper) / 2;
  rows[rows.length - 1].bottom -= widest(rows[rows.length - 1].band.lower) / 2;
  const rowCells = rows.map((row) => cellsOfRow(table, row, items.filter((it) => yOf(it) >= row.top && yOf(it) < row.bottom)));
  const count = xs.length - 1;
  const taken = rows.map(() => new Set());
  const edges = [];
  const out = rows.map((row, r) => {
    const cells = [];
    // Columns are counted from the right, as this app's tables run.
    for (const [a, b] of [...rowCells[r]].reverse()) {
      const key = `${a}:${b}`;
      if (taken[r].has(key)) continue;
      const x0 = xs[a];
      const x1 = xs[b];
      let rowSpan = 1;
      while (r + rowSpan < rows.length) {
        const next = rows[r + rowSpan];
        const here = rows[r + rowSpan - 1];
        if (next.virtual || here.virtual || next.band === here.band) break;
        if (covers(here.band.lower.spans, x0, x1) || !rowCells[r + rowSpan].some(([p, q]) => p === a && q === b)) break;
        taken[r + rowSpan].add(key);
        rowSpan++;
      }
      const lastRow = rows[r + rowSpan - 1];
      const inside = items.filter((it) => {
        const cx = it.x + it.w / 2;
        return cx >= x0 && cx <= x1 && yOf(it) >= row.top && yOf(it) < lastRow.bottom;
      });
      const rowPt = (lastRow.bottom - row.top) / MM_PER_PT;
      const verticalAt = (x) => cols.find((c) => Math.abs(c.x - x) <= SAME_RULE + 0.1);
      const posX = (rule) => rule.x;
      const spanY = (rule) => [rule.y0, rule.y1];
      const posY = (rule) => rule.y;
      const spanX = (rule) => [rule.x0, rule.x1];
      const startsBand = !row.virtual || row === rows[0] || table.rows[r].top === row.band.top;
      const endsBand = !lastRow.virtual || lastRow === rows[rows.length - 1] || table.rows[r + rowSpan - 1].bottom === lastRow.band.bottom;
      const sides = [
        startsBand ? drawnWidth(row.band.upper, x0, x1, posY, spanX) : 0,
        drawnWidth(verticalAt(x1), row.top, lastRow.bottom, posX, spanY),
        endsBand ? drawnWidth(lastRow.band.lower, x0, x1, posY, spanX) : 0,
        drawnWidth(verticalAt(x0), row.top, lastRow.bottom, posX, spanY),
      ];
      const lines = linesOf(inside);
      let paras;
      if (exact) {
        // Half of each line above and below lies inside the cell; a little more room keeps a row from growing by a hair.
        const insetTop = r === 0 ? 0 : Math.abs(sides[0]) / 2;
        const insetBottom = lastRow === rows[rows.length - 1] ? 0 : Math.abs(sides[2]) / 2;
        paras = exactCellParagraphs(lines, { left: x0, right: x1 }, row.top + insetTop * MM_PER_PT, rowPt - insetTop - insetBottom - 0.3);
      } else {
        const inner = { left: x0 + 1, right: x1 - 1 };
        paras = lines.map((line) => {
          const rightGap = inner.right - line.x1;
          const leftGap = line.x0 - inner.left;
          const align = Math.abs(leftGap - rightGap) < 2.5 ? 'center' : rightGap < leftGap ? 'right' : 'left';
          return makeParagraph(joinRuns([line]), { jc: JC[align] });
        });
      }
      const cell = { paras: paras.length ? paras : [emptyCellParagraph(rowPt, exact)], span: b - a, ...(rowSpan > 1 && { rowSpan }), vAlign: exact ? 'top' : 'center', rowH: rowSpan === 1 ? row.bottom - row.top : 0 };
      const fill = fills.find((f) => Math.min(f.x1, x1) - Math.max(f.x0, x0) > (x1 - x0) * 0.8 && Math.min(f.y1, lastRow.bottom) - Math.max(f.y0, row.top) > (lastRow.bottom - row.top) * 0.8);
      if (fill) cell.bg = fill.color;
      edges.push([cell, sides]);
      cells.push(cell);
    }
    return cells;
  });
  // A table with every line of every cell drawn is an ordinary table; anything else keeps each cell's own lines.
  const plain = edges.every(([, sides]) => sides.every((w) => w > 0 && w <= 1));
  if (!plain) for (const [cell, sides] of edges) cell.borders = sides;
  const grid = [];
  for (let c = 0; c < count; c++) grid.push(twips(xs[count - c] - xs[count - c - 1]));
  const block = { kind: 'table', rows: out, grid, rtl: true, borderless: !plain, header: false, hasBottom: false, jc: undefined, y: table.y, top: table.y, bottom: table.bottom, ...(exact && { pad: 0 }) };
  const centre = (table.left + table.right) / 2;
  if (Math.abs(centre - (frame.left + frame.right) / 2) < 2 && table.right - table.left < frame.right - frame.left - 4) block.jc = 'center';
  return block;
}

/** Text in clear columns without any ruled lines is a table too. */
function gapTables(lines, frame) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    const count = lines[i].chunks.length;
    if (count >= 2) {
      while (j + 1 < lines.length && lines[j + 1].chunks.length === count && lines[j + 1].y - lines[j].y < emMm(lines[j].size) * 3.2 && lines[j + 1].chunks.every((c, n) => Math.abs((c.x0 + c.x1) / 2 - (lines[i].chunks[n].x0 + lines[i].chunks[n].x1) / 2) < 25)) j++;
    }
    if (j > i) {
      const rows = lines.slice(i, j + 1);
      const reversed = rows.map((l) => [...l.chunks].reverse());
      const cols = count;
      const edges = [];
      for (let c = 0; c < cols - 1; c++) {
        const leftOfCol = Math.min(...reversed.map((r) => r[c].x0));
        const rightOfNext = Math.max(...reversed.map((r) => r[c + 1].x1));
        edges.push((leftOfCol + rightOfNext) / 2);
      }
      const bounds = [frame.right, ...edges, frame.left];
      const block = {
        kind: 'table',
        rows: reversed.map((cells) => cells.map((chunk) => ({ paras: [makeParagraph(chunk.runs.map((r) => ({ ...r })), { jc: JC.center })], span: 1, vAlign: 'center', rowH: 0 }))),
        grid: bounds.slice(0, -1).map((b, c) => twips(b - bounds[c + 1])),
        rtl: true,
        borderless: true,
        header: false,
        hasBottom: false,
        y: rows[0].y,
        top: rows[0].y - emMm(rows[0].size),
        bottom: rows[rows.length - 1].y + emMm(rows[0].size) * 0.4,
      };
      out.push({ from: i, to: j, block });
      i = j + 1;
    } else i++;
  }
  return out;
}

/* ---------- The whole document ---------- */

const isPageNumber = (text) => /^(صفحه|صفحهٔ|صفحۀ|page)?\s*[0-9۰-۹]+(\s*(از|\/|of)\s*[0-9۰-۹]+)?$/i.test(text.trim());

/** A line's top from its baseline, close enough for placing a letterhead part. */
const lineTop = (y, size, font, bold) => y - naturalLine(size, font, bold) * MM_PER_PT * 0.74;

function headBox(chunk, y) {
  const first = chunk.runs[0] || {};
  const size = first.size || 11;
  const meta = parseMeta(chunk.text);
  const width = chunk.x1 - chunk.x0;
  const room = 18;
  const isRight = !!meta;
  const paragraph = makeParagraph(chunk.runs.map((r) => ({ ...r })), { jc: isRight ? JC.right : JC.center });
  return {
    x: isRight ? chunk.x0 - room : chunk.x0 - room / 2,
    y: lineTop(y, size, first.font, first.b),
    w: width + room,
    h: emMm(size) * 1.6,
    fromFlow: false,
    border: false,
    blocks: [paragraph],
  };
}

async function readableDocument(pdfjs, pdf, options) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    pages.push({ page, ...(await readPage(pdfjs, page, options)) });
  }
  return pages;
}

function isUnreadable(pages) {
  const text = pages.flatMap((p) => p.items.map((i) => i.text)).join('');
  const total = text.replace(/\s/g, '').length;
  if (total < 15 * pages.length) return true;
  const damaged = (text.match(/[-�]/g) || []).length;
  if (damaged / total > 0.2) return true;
  // Persian fonts whose letters came out as anything but Persian have no usable character map.
  const persianFont = pages.some((p) => p.items.some((i) => i.font || /nazanin|lotus|zar|titr|mitra|yagut|traffic|roya/i.test(i.rawFont || '')));
  return persianFont && !RTL_TEXT.test(text);
}

async function letterFromText(pages, settings, analysed) {
  const known = new Map();
  const carrier = makeParagraph([]);
  const footerBlocks = [];
  const body = [];
  const headTexts = new Set();
  let pageNumbers = false;
  let frame = null;
  let firstBodyTop = null;

  // The text's own margins, measured on everything that is not the letterhead.
  const allLines = pages.map((p) => linesOf(p.items));
  const flat = allLines.flat();
  if (flat.length) {
    const lefts = flat.map((l) => l.x0).sort((a, b) => a - b);
    const rights = flat.map((l) => l.x1).sort((a, b) => a - b);
    frame = { left: lefts[0], right: rights[rights.length - 1] };
  } else frame = { left: PAGE.left, right: PAGE.w - PAGE.right };

  for (let index = 0; index < pages.length; index++) {
    const { page, items, fills, pictures } = pages[index];
    const { tables, lone } = analysed[index];
    const inTable = (it) => tableAt(tables, it);
    const freeItems = items.filter((it) => !inTable(it));
    let lines = linesOf(freeItems);
    lines.forEach((l) => {
      l.page = index;
    });

    /* The letterhead: everything down to the last line that clearly belongs to it. */
    let headBottom = 0;
    if (index === 0) {
      let lastHead = -1;
      lines.forEach((line, i) => {
        if (line.y < PAGE.h * 0.38 && line.chunks.some((c) => parseMeta(c.text) || isInvocation(c.text))) lastHead = i;
      });
      // A long line near the top closes the letterhead: whatever stands above it belongs to the letterhead too.
      const after = lastHead >= 0 ? lines[lastHead].y : 0;
      const rule = lone.find((l) => {
        const width = Math.max(...l.spans.map((s) => s[1])) - Math.min(...l.spans.map((s) => s[0]));
        return width > (frame.right - frame.left) * 0.6 && l.y > after && l.y < PAGE.h * (lastHead >= 0 ? 0.4 : 0.25);
      });
      if (rule) {
        const x0 = Math.min(...rule.spans.map((s) => s[0]));
        const x1 = Math.max(...rule.spans.map((s) => s[1]));
        carrier.lines.push({ x: x0, y: rule.y, w: x1 - x0, h: 0, fromFlow: false });
        headBottom = rule.y;
        lastHead = Math.max(lastHead, lines.filter((l) => l.y < rule.y).length - 1);
      }
      if (lastHead >= 0) {
        for (const line of lines.slice(0, lastHead + 1)) {
          for (const chunk of line.chunks) {
            carrier.boxes.push(headBox(chunk, line.y));
            headTexts.add(chunk.text.trim());
          }
        }
        headBottom = Math.max(headBottom, lines[lastHead].y + 3);
        lines = lines.slice(lastHead + 1);
      }
    } else {
      // Later pages repeat the letterhead.
      lines = lines.filter((line) => !(line.y < PAGE.h * 0.38 && line.chunks.every((c) => headTexts.has(c.text.trim()) || parseMeta(c.text))));
    }

    /* The foot of the page: page numbers, and an address set apart from the text. */
    while (lines.length) {
      const last = lines[lines.length - 1];
      const before = lines[lines.length - 2];
      const lowOnPage = last.y > PAGE.h * 0.86;
      const setApart = !before || last.y - before.y > emMm(last.size) * 3.5;
      if (!lowOnPage || !(setApart || isPageNumber(last.text))) break;
      if (isPageNumber(last.text)) pageNumbers = true;
      else if (index === 0) footerBlocks.push(makeParagraph(joinRuns([last]), { jc: JC.center }));
      lines = lines.slice(0, -1);
    }

    if (lines.length && firstBodyTop === null) firstBodyTop = lineTop(lines[0].y, lines[0].size, lines[0].chunks[0]?.runs[0]?.font, lines[0].chunks[0]?.runs[0]?.b);

    /* Columns of text without ruled lines. */
    const columnTables = gapTables(lines, frame);
    const pieces = [];
    let cursor = 0;
    for (const t of columnTables) {
      if (t.from > cursor) pieces.push(...paragraphsOf(lines.slice(cursor, t.from), frame));
      pieces.push(t.block);
      cursor = t.to + 1;
    }
    if (cursor < lines.length) pieces.push(...paragraphsOf(lines.slice(cursor), frame));
    for (const t of tables) pieces.push(tableBlock(t, items.filter((it) => inTable(it) === t), frame, { fills }));
    pieces.sort((a, b) => a.y - b.y);
    setSpacing(pieces);

    // The last paragraph on a page may run on at the top of the next one.
    const previous = body[body.length - 1];
    const opening = pieces[0];
    if (previous?.kind === 'p' && opening?.kind === 'p' && previous.jc === JC.justify && !opening.props.indFirst) {
      previous.runs[previous.runs.length - 1].text = `${previous.runs[previous.runs.length - 1].text.replace(/\s+$/, '')} `;
      previous.runs.push(...opening.runs);
      pieces.shift();
    }
    body.push(...pieces);

    /* Pictures: the letterhead's go with it, the rest hang from the nearest text. */
    for (const picture of pictures) {
      const id = await pictureToMedia(page, picture, known);
      if (!id) {
        pages.warnings.add('picture');
        continue;
      }
      const float = { x: picture.x, y: picture.y, fromFlow: false, image: { w: picture.w, h: picture.h }, id, behind: picture.w > PAGE.w * 0.7 && picture.h > PAGE.h * 0.5 };
      const isRepeat = index > 0 && carrier.floats.some((f) => f.id === id);
      if (isRepeat) continue;
      if (index === 0 && !float.behind && picture.y + picture.h / 2 < Math.max(headBottom, PAGE.h * 0.16)) {
        carrier.floats.push(float);
        continue;
      }
      const centre = picture.y + picture.h / 2;
      const onPage = pieces.filter((b) => b.y !== undefined);
      const nearest = onPage.reduce((best, b) => (Math.abs(b.y - centre) < Math.abs((best?.y ?? Infinity) - centre) ? b : best), null);
      if (nearest?.kind === 'p') nearest.floats.push(float);
      else if (nearest) {
        const holder = makeParagraph([]);
        holder.floats.push(float);
        holder.y = nearest.y;
        body.splice(body.indexOf(nearest), 0, holder);
      } else {
        const holder = makeParagraph([]);
        holder.floats.push(float);
        body.push(holder);
      }
    }
  }

  carrier.hasPageField = false;
  if (pageNumbers) {
    const numbers = makeParagraph([]);
    numbers.hasPageField = true;
    footerBlocks.push(numbers);
  }
  const top = firstBodyTop ?? PAGE.bodyTop;
  const doc = {
    body,
    header: [carrier],
    footer: footerBlocks,
    geom: { top, right: PAGE.w - frame.right, bottom: PAGE.bodyBottom, left: frame.left, header: PAGE.headerTop },
    page: pages.paper,
    warnings: pages.warnings,
    media: new Map(),
  };
  return letterFromDocument(doc, settings);
}

/* ---------- A form, a transcript or anything else that is mostly tables, not a letter ---------- */

const LETTER_WORDS = /^(با\s*سلام|سلام|با\s*درود|احتراما|موضوع\s*[:：])/;

/** Laid out like a letter: its usual words, a few pages, one column of text, a few fonts. Anything else stays exactly as it was laid out. */
function looksLikeLetter(pages) {
  if (pages.length > 6) return false;
  const families = new Set(pages.flatMap(({ items }) => items.map((it) => (it.rawFont || '').toLowerCase().replace(/[-_,\s]?(bold|regular|italic|mt)+$/, ''))));
  if (families.size > 5) return false;
  const lines = pages.flatMap(({ items }) => linesOf(items));
  if (!lines.length) return false;
  const opening = lines.some((line) => LETTER_WORDS.test(line.text));
  const head = linesOf(pages[0].items).slice(0, 12).some((line) => line.chunks.some((c) => parseMeta(c.text)));
  if (!opening && !head) return false;
  return lines.filter((line) => line.chunks.length > 1).length <= lines.length * 0.35;
}

/** Mostly table text and none of a letter's opening words: every piece stays exactly where the file has it. */
function looksLikeForm(pages, analysed) {
  let total = 0;
  let inTables = 0;
  pages.forEach(({ items }, i) => {
    for (const it of items) {
      total += it.text.length;
      if (tableAt(analysed[i].tables, it)) inTables += it.text.length;
    }
  });
  if (!total || inTables < total * 0.5) return false;
  return !pages.some(({ items }, i) => linesOf(items.filter((it) => !tableAt(analysed[i].tables, it))).some((line) => LETTER_WORDS.test(line.text)));
}

/** A short piece of text standing by itself above the tables, as a frame of its own. Which of its edges to hold on to shows from its neighbours. */
function frameOfChunk({ chunk, y }, others, page) {
  const run = chunk.runs.find((r) => r.font) || chunk.runs[0] || {};
  // Numbers take no font of their own in a line of words, but a line of numbers has only that.
  const font = run.font || chunk.items.find((item) => item.font)?.font;
  const size = chunk.runs[0]?.size || 11;
  const width = chunk.x1 - chunk.x0;
  const centre = (chunk.x0 + chunk.x1) / 2;
  const room = Math.max(6, width * 0.35);
  const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
  let align;
  if (others.some((o) => o.chunk !== chunk && near(o.chunk.x0, chunk.x0, 0.5))) align = 'left';
  else if (others.some((o) => o.chunk !== chunk && near(o.chunk.x1, chunk.x1, 0.5))) align = 'right';
  else if (others.some((o) => o.chunk !== chunk && near((o.chunk.x0 + o.chunk.x1) / 2, centre, 2))) align = 'center';
  else if (near(centre, PAGE.w / 2, 15)) align = 'center';
  else align = centre < PAGE.w / 2 ? 'left' : 'right';
  const w = width + room;
  const x = align === 'left' ? chunk.x0 : align === 'right' ? chunk.x1 - w : centre - w / 2;
  const line = Math.round(size * 2.4) / 2;
  return {
    id: uid(),
    kind: 'text',
    anchor: 'page',
    page,
    x,
    y: y - baselineInLine(line, size, font, !!chunk.runs[0]?.b) * MM_PER_PT,
    w,
    text: chunk.text.trim(),
    border: false,
    style: { font: font || 'B Nazanin', size, bold: !!chunk.runs[0]?.b, align, spacing: 1, line },
  };
}

async function letterFromForm(pages, analysed, settings) {
  const families = new Set(pages.flatMap(({ items }) => items.map((it) => it.font).filter(Boolean)));
  await Promise.all([...families].flatMap((family) => [400, 700].map((weight) => document.fonts.load(`${weight} 10pt "${family}"`).catch(() => null))));
  const L = newLetter(settings);
  const hidden = { hidden: true };
  L.letterhead = { logo: null, logoAspect: 1, logoH: 18, org: [], invocation: '', footer: '', footerLine: false, pageNumbers: false, parts: { number: hidden, date: hidden, attachment: hidden, rule: hidden } };
  L.offsets = {};
  L.objects = [];
  L.signer = { name: '', title: '' };
  L.recipient = { name: '', title: '' };
  L.imported = true;
  L.greetingEdited = true;
  L.closingEdited = true;
  L.attachmentManual = true;
  L.bodyDirty = true;
  // The words stay exactly as they are in the file.
  L.autoFix = false;

  /* What stands above the first table on a page floats there; everything else runs down the page in order. */
  const plans = pages.map(({ items }, index) => {
    const { tables } = analysed[index];
    const free = linesOf(items.filter((it) => !tableAt(tables, it)));
    const firstTable = tables[0]?.y ?? Infinity;
    const above = free.filter((line) => line.y < firstTable);
    // Pieces side by side count as one line even when they do not quite stand level, and each keeps its own height on the page.
    const heightOf = (chunk) => chunk.items.reduce((big, item) => (item.size > big.size ? item : big)).y;
    const chunks = above.flatMap((line) => line.chunks.map((chunk) => ({ chunk, y: heightOf(chunk) })));
    const shortEnough = above.length <= 8 && chunks.every(({ chunk }) => chunk.text.length <= 70);
    return { tables, frames: shortEnough ? chunks : [], lines: shortEnough ? free.filter((line) => line.y >= firstTable) : free };
  });
  const widths = plans.flatMap((plan) => [...plan.tables.flatMap((t) => [t.left, t.right]), ...plan.lines.flatMap((line) => [line.x0, line.x1])]);
  const frame = { left: Math.min(...widths), right: Math.max(...widths) };

  const known = new Map();
  const perPage = [];
  for (let index = 0; index < pages.length; index++) {
    const { page, items, fills, pictures } = pages[index];
    const plan = plans[index];
    L.objects.push(...plan.frames.map((entry) => frameOfChunk(entry, plan.frames, index)));
    const pieces = [];
    const columnTables = gapTables(plan.lines, frame);
    let cursor = 0;
    for (const t of columnTables) {
      if (t.from > cursor) pieces.push(...paragraphsOf(plan.lines.slice(cursor, t.from), frame, { exact: true }));
      pieces.push(t.block);
      cursor = t.to + 1;
    }
    if (cursor < plan.lines.length) pieces.push(...paragraphsOf(plan.lines.slice(cursor), frame, { exact: true }));
    for (const t of plan.tables) pieces.push(tableBlock(t, items.filter((it) => tableAt(plan.tables, it) === t), frame, { exact: true, fills }));
    pieces.sort((a, b) => a.y - b.y);
    perPage.push(pieces);
    for (const picture of pictures) {
      const id = await pictureToMedia(page, picture, known);
      if (!id) {
        pages.warnings.add('picture');
        continue;
      }
      L.objects.push({ id: uid(), kind: 'image', anchor: 'page', page: index, mediaId: id, aspect: picture.w / (picture.h || picture.w) || 1, x: picture.x, y: picture.y, w: picture.w, ...(picture.w > PAGE.w * 0.7 && picture.h > PAGE.h * 0.5 && { behind: true }) });
    }
  }

  /* The whole document's look, so most words need no look of their own. */
  const all = perPage.flat();
  const paragraphs = all.filter((b) => b.kind === 'p');
  const tablesInOrder = all.filter((b) => b.kind === 'table');
  const bodySt = paragraphs.length ? dominantStyle(paragraphs, { ...DEFAULT_STYLES.body, before: 0, after: 0, spacing: 1 }) : { ...DEFAULT_STYLES.body };
  Object.assign(bodySt, { before: 0, after: 0, spacing: 1 });
  const tableSt = tablesInOrder.length ? dominantStyle(flatten(tablesInOrder), { ...DEFAULT_STYLES.table }) : { ...DEFAULT_STYLES.table };
  Object.assign(tableSt, { before: 0, after: 0, spacing: 1 });
  L.styles = { body: bodySt, table: tableSt };

  const firsts = perPage.filter((pieces) => pieces.length).map((pieces) => pieces[0].top);
  const top = firsts.length ? Math.min(...firsts) : PAGE.bodyTop;
  const lowest = all.length ? Math.max(...all.map((b) => b.bottom)) : PAGE.h - PAGE.bodyBottom;
  L.geom = { top, right: PAGE.w - frame.right, bottom: Math.max(3, Math.min(PAGE.bodyBottom, PAGE.h - lowest - 3)), left: frame.left };

  /* Blocks in order, each keeping its distance from the one above. */
  const textWidth = (PAGE.w - L.geom.left - L.geom.right) / MM_PER_TWIP;
  const blocks = [];
  let tableNumber = 0;
  perPage.forEach((pieces, index) => {
    let above = top;
    pieces.forEach((piece, i) => {
      const gapPt = Math.max(0, piece.top - above) / MM_PER_PT;
      if (index > 0 && i === 0) blocks.push({ kind: 'p', pageBreak: true, over: { line: Math.max(1, Math.round(gapPt * 2) / 2) }, runs: [] });
      if (piece.kind === 'table') {
        const table = bodyTable(piece, tableSt, textWidth);
        const number = tableNumber++;
        const after = blocks[blocks.length - 1];
        // Word must have a paragraph between two tables, and it can be no thinner than this.
        // The first thing on a later page is already put in place by the empty line that starts the page.
        if (i > 0 || index === 0) L.offsets[`table:${number}`] = { dx: 0, dy: Math.max(after?.kind === 'table' ? 0.75 : 0, gapPt) * MM_PER_PT };
        blocks.push(table);
      } else {
        if (!(index > 0 && i === 0)) piece.props.before = Math.round(gapPt * 2) * 10;
        else piece.props.before = 0;
        piece.props.after = 0;
        blocks.push(bodyParagraph(piece, bodySt));
      }
      above = piece.bottom;
    });
  });

  L.bodyHtml = blocksToHtml(blocks);
  const holder = document.createElement('div');
  holder.innerHTML = L.bodyHtml;
  L.body = serializeEditor(holder);
  L.importInfo = { warnings: [...pages.warnings], recognized: { recipient: false, subject: false, greeting: false, closing: false, signer: false, cc: false, head: false }, form: true };
  return L;
}

/** Pictures of the pages, with the letter's own text frames to be added on top. They stay sharp enough for their words to be read later. */
async function letterFromPictures(pages, settings) {
  const count = pages.length;
  const objects = [];
  for (let i = 0; i < count; i++) {
    const { page } = pages[i];
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(300 / 72, 2600 / base.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const mediaId = uid();
    await putMedia(mediaId, canvas.toDataURL('image/jpeg', 0.88));
    objects.push({ id: uid(), kind: 'image', anchor: 'page', page: i, mediaId, aspect: canvas.width / canvas.height, x: 0, y: 0, w: PAGE.w, behind: true });
  }
  return scanLetter(objects, count, settings);
}

/** A letter holding nothing but pictures of its pages. */
function scanLetter(objects, count, settings) {
  const L = newLetter(settings);
  const hidden = { hidden: true };
  L.letterhead = { logo: null, logoAspect: 1, logoH: 18, org: [], invocation: '', footer: '', footerLine: false, pageNumbers: false, parts: { number: hidden, date: hidden, attachment: hidden, rule: hidden } };
  L.styles = {};
  L.offsets = {};
  L.objects = objects;
  L.signer = { name: '', title: '' };
  L.recipient = { name: '', title: '' };
  L.imported = true;
  L.greetingEdited = true;
  L.closingEdited = true;
  L.attachmentManual = true;
  L.bodyDirty = true;
  const blocks = Array.from({ length: count }, (_, i) => ({ kind: 'p', ...(i > 0 && { pageBreak: true }), runs: [] }));
  L.bodyHtml = blocksToHtml(blocks);
  const holder = document.createElement('div');
  holder.innerHTML = L.bodyHtml;
  L.body = serializeEditor(holder);
  // The last empty paragraph would be dropped as trailing space, and its page with it.
  while (L.body.length < count) L.body.push({ kind: 'p', pageBreak: true, runs: [] });
  L.bodyHtml = blocksToHtml(L.body);
  L.importInfo = { warnings: [], recognized: {}, scanned: true };
  return L;
}

/** A photo of a letter, as a one-page scan. */
export async function letterFromPhoto(bytes, settings, mime = 'image/jpeg') {
  const img = await loadImage(`data:${mime};base64,${bytesToBase64(bytes)}`);
  const k = Math.min(1, 3000 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const mediaId = uid();
  await putMedia(mediaId, canvas.toDataURL('image/jpeg', 0.9));
  usePageSize(null);
  const aspect = canvas.width / canvas.height;
  const w = Math.min(PAGE.w, PAGE.h * aspect);
  return scanLetter([{ id: uid(), kind: 'image', anchor: 'page', page: 0, mediaId, aspect, x: (PAGE.w - w) / 2, y: 0, w, behind: true }], 1, settings);
}

/** Stored pictures of pages, as a letter that holds just them. */
export async function letterFromPages(mediaIds, paper, settings) {
  usePageSize({ page: paper });
  const objects = [];
  for (let i = 0; i < mediaIds.length; i++) {
    const img = await loadImage(mediaUrl(mediaIds[i]));
    const aspect = img.naturalWidth / img.naturalHeight;
    const w = Math.min(PAGE.w, PAGE.h * aspect);
    objects.push({ id: uid(), kind: 'image', anchor: 'page', page: i, mediaId: mediaIds[i], aspect, x: (PAGE.w - w) / 2, y: 0, w, behind: true });
  }
  const L = scanLetter(objects, mediaIds.length, settings);
  if (paper) L.page = paper;
  return L;
}

/** The kind of picture a file's first bytes show, or nothing. */
export function imageTypeOf(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

/** The words read from pictures of pages, as the same letter a PDF with text gives. */
export async function letterFromReadPages(read, paper, settings) {
  usePageSize({ page: paper });
  const pages = read.map(({ items, rules, fills, pictures }) => ({ page: null, items, rules, fills, pictures }));
  pages.warnings = new Set();
  pages.paper = paper;
  const analysed = pages.map((p) => findTables(p.rules, p.items));
  let L;
  if (looksLikeForm(pages, analysed)) L = await letterFromForm(pages, analysed, settings);
  else if (looksLikeLetter(pages)) L = await letterFromText(pages, settings, analysed);
  else L = await letterOfParagraphs(read, settings);
  if (paper) L.page = paper;
  return L;
}

/** Anything else that was read: its paragraphs one after another, in the order the engine read them, which follows columns too. */
async function letterOfParagraphs(read, settings) {
  const body = read.flatMap((page, p) => page.paragraphs.map((text, i) => ({ kind: 'p', ...(p > 0 && i === 0 && { pageBreak: true }), runs: [{ text: restoreHalfSpaces(text) }] })));
  const L = scanLetter([], read.length, settings);
  delete L.importInfo.scanned;
  L.body = body;
  L.bodyHtml = blocksToHtml(body);
  L.styles = { body: { ...DEFAULT_STYLES.body, size: Math.round(read[0]?.size || 14) } };
  const objects = [];
  for (let p = 0; p < read.length; p++) {
    for (const picture of read[p].pictures) {
      const id = uid();
      await putMedia(id, picture.url);
      objects.push({ id: uid(), kind: 'image', anchor: 'page', page: p, mediaId: id, aspect: picture.w / (picture.h || picture.w) || 1, x: picture.x, y: picture.y, w: picture.w });
    }
  }
  L.objects = objects;
  return L;
}

/**
 * Turns a PDF file's bytes into a letter object, with pages of the size the file has.
 * The tests turn off useActualText to check how a PDF that lacks it reads, and can ask for the exact way with layout: 'exact', or against it with 'flow'.
 */
export async function importPdf(bytes, settings, options = {}) {
  const pdfjs = await loadLibrary();
  const pdf = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    useSystemFonts: false,
    verbosity: 0,
    fontExtraProperties: true,
  }).promise;
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  const paper = pageSizeToKeep(first.width * MM_PER_PT, first.height * MM_PER_PT);
  usePageSize({ page: paper });
  const pages = await readableDocument(pdfjs, pdf, options);
  pages.warnings = new Set();
  pages.paper = paper;
  let L;
  if (isUnreadable(pages)) L = await letterFromPictures(pages, settings);
  else {
    const analysed = pages.map((p) => findTables(p.rules, p.items));
    const form = options.layout !== 'exact' && looksLikeForm(pages, analysed);
    if (form) L = await letterFromForm(pages, analysed, settings);
    else if (options.layout === 'exact' || (options.layout !== 'flow' && !looksLikeLetter(pages))) L = await letterFromExactPdf(pdf, pages, settings, options.onProgress);
    else L = await letterFromText(pages, settings, analysed);
  }
  if (paper) L.page = paper;
  await pdf.cleanup();
  return L;
}

export const isPdfBytes = (bytes) => String.fromCharCode(...bytes.subarray(0, 1024)).includes('%PDF-');
