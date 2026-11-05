// Opens a PDF laid out by hand (a weekly, a brochure, anything with columns and pictures) so that it stays exactly as it is.
// Nothing is guessed about paragraphs or columns: every line of text stays where the file has it, each word in its place, and
// remains editable. Lines that cannot be written as text (turned, see-through, stretched letter by letter, covered by something
// drawn later) stay part of the picture with everything else that is drawn: rules, panels, shadows. Photos and logos are cut out
// of that picture, so each can be moved or removed on its own.

import { uid, bytesToBase64 } from './util.js';
import { MM_PER_PT, hashOf, newLetter } from './model.js';
import { blocksToHtml } from './editor.js';
import { putMedia } from './store.js';
import { frameSignature, inkToMedia, loadInkFonts } from './ink.js';

const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const LATIN_LETTER = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
const DIGIT = /[0-9۰-۹٠-٩]/;
const JOINS_NUMBERS = /^[/.,:٫٬+\-]$/;
const TOUCHES_NUMBERS = /^[%٪#$]$/;
const MIRRORED = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '«': '»', '»': '«', '<': '>', '>': '<' };
const ZWNJ = '‌';
const UNREADABLE = /[-�\u0000-\u0008\u000e-\u001f]/g;

/** A line of fixed height, as a multiple of its letters' size: Word cuts off what rises above the top of such a line. */
export const LINE_FACTOR = 1.5;
/** In a line of fixed height, Word sets the baseline this far down. */
export const BASELINE_SHARE = 0.8;

/* ---------- The font's family, from the name inside the PDF ---------- */

export function familyOfFont(name) {
  const raw = String(name || '').replace(/^[A-Z]{6}\+/, '').replace(/[,_]/g, '-');
  const bold = /bold|black|heavy|demi/i.test(raw);
  const italic = /italic|oblique/i.test(raw);
  let base = raw;
  for (let before = ''; before !== base;) {
    before = base;
    base = base.replace(/[-\s]?(bold|italic|oblique|regular|roman|normal|book|medium|black|heavy|demi)$/i, '').replace(/(PSMT|MT|PS)$/, '').replace(/-$/, '');
  }
  const family = base
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^(B|2)(?=[A-Z])/, '$1 ')
    .trim();
  return { family: family || raw || 'B Nazanin', bold, italic };
}

const hex = (rgb) => [...rgb].slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

/* ---------- Boxes, in points from the top left of the page ---------- */

const makeBox = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
const intersect = (a, b) => (b ? makeBox(Math.max(a.x0, b.x0), Math.max(a.y0, b.y0), Math.min(a.x1, b.x1), Math.min(a.y1, b.y1)) : a);
const areaOf = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

function boxOfPoints(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return makeBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

/* ---------- Going through everything a page draws, in order ---------- */

function walkPage(pdfjs, page, ops, viewport, visibility) {
  const { OPS, Util } = pdfjs;
  const runs = [];
  const paints = [];
  const pictures = [];
  const stack = [];
  const marks = [];
  let order = 0;
  let shows = 0;
  let textBlocks = 0;
  let ctm = viewport.transform;
  let path = null;
  let gs = {
    fill: [0, 0, 0], pattern: false, alpha: 1, groupAlpha: 1, smask: false, blend: 'source-over', outerFx: false, clip: null,
    fontName: null, size: 0, tc: 0, tw: 0, th: 1, rise: 0, leading: 0, mode: 0, stroke: [0, 0, 0], lineWidth: 1, clipPath: null,
    tm: [1, 0, 0, 1, 0, 0], lineX: 0, lineY: 0, x: 0, y: 0,
  };
  const fxNow = () => gs.outerFx || gs.alpha < 0.999 || gs.smask || gs.blend !== 'source-over';
  // What is drawn into a soft mask is never seen on the page: it only says how see-through something else is.
  const groups = [];
  const inMask = () => groups.includes(true);
  const hiddenNow = () => inMask() || marks.some((m) => m.hidden);
  const maskShows = [];
  const save = () => {
    stack.push({ ctm, gs });
    gs = { ...gs };
  };
  const restore = () => {
    const saved = stack.pop();
    if (saved) ({ ctm, gs } = saved);
  };
  const toPage = (x, y) => Util.applyTransform([x, y], ctm);
  const paintOf = (box, withColor) => ({ order: order++, box, alpha: gs.groupAlpha * gs.alpha, blend: gs.blend, soft: gs.smask || gs.pattern, ...(withColor && { color: gs.fill }) });
  const STROKES = new Set([OPS.stroke, OPS.closeStroke]);
  const PAINTS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const IMAGES = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintSolidColorImageMask, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat]);

  /** A path's box on the page, and the path itself as SVG words, for drawing a picture's frame again later. */
  const readPath = (pathOps, coords) => {
    const points = [];
    const words = [];
    const at = (p) => `${Math.round(p[0] * 100) / 100} ${Math.round(p[1] * 100) / 100}`;
    let c = 0;
    let curved = false;
    let pen = null;
    for (const op of pathOps) {
      if (op === OPS.rectangle) {
        const [x, y, w, hgt] = coords.slice(c, c + 4);
        c += 4;
        const corners = [toPage(x, y), toPage(x + w, y), toPage(x + w, y + hgt), toPage(x, y + hgt)];
        points.push(...corners);
        words.push(`M${at(corners[0])}L${at(corners[1])}L${at(corners[2])}L${at(corners[3])}Z`);
      } else if (op === OPS.moveTo || op === OPS.lineTo) {
        pen = toPage(coords[c], coords[c + 1]);
        points.push(pen);
        words.push(`${op === OPS.moveTo ? 'M' : 'L'}${at(pen)}`);
        c += 2;
      } else if (op === OPS.curveTo) {
        const three = [0, 1, 2].map((k) => toPage(coords[c + k * 2], coords[c + k * 2 + 1]));
        points.push(...three);
        words.push(`C${three.map(at).join(' ')}`);
        pen = three[2];
        curved = true;
        c += 6;
      } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
        const two = [0, 1].map((k) => toPage(coords[c + k * 2], coords[c + k * 2 + 1]));
        points.push(...two);
        const control = op === OPS.curveTo2 ? [pen || two[0], two[0], two[1]] : [two[0], two[1], two[1]];
        words.push(`C${control.map(at).join(' ')}`);
        pen = two[1];
        curved = true;
        c += 4;
      } else if (op === OPS.closePath) words.push('Z');
    }
    return points.length ? { box: boxOfPoints(points), d: words.join(''), curved } : null;
  };
  const closeBoxes = (a, b) => Math.abs(a.x0 - b.x0) < 2 && Math.abs(a.y0 - b.y0) < 2 && Math.abs(a.x1 - b.x1) < 2 && Math.abs(a.y1 - b.y1) < 2;
  // The picture just drawn, whose frame may be stroked right after it.
  let lastPicture = null;

  const showText = (glyphs) => {
    const index = shows++;
    if (inMask()) maskShows.push(index);
    if (hiddenNow() || !gs.fontName) return;
    const font = page.commonObjs.has(gs.fontName) ? page.commonObjs.get(gs.fontName) : null;
    if (!font) return;
    const direction = gs.size < 0 ? -1 : 1;
    const size = Math.abs(gs.size);
    const unit = size * (font.fontMatrix?.[0] ?? 0.001);
    const m = Util.transform(ctm, gs.tm);
    const actual = [...marks].reverse().find((mark) => mark.actual !== undefined) || null;
    const run = {
      index, order: order++, block: textBlocks, font, fontName: gs.fontName, mode: gs.mode, fill: gs.fill, pattern: gs.pattern, fx: fxNow(), clip: gs.clip,
      turned: Math.abs(m[1]) > 1e-3 || Math.abs(m[2]) > 1e-3 || m[0] <= 0 || m[3] >= 0 || !!font.vertical,
      size: size * Math.abs(m[3]),
      hs: Math.abs(gs.th * m[0] / (m[3] || 1)),
      glyphs: [],
    };
    let x = 0;
    for (const glyph of glyphs) {
      if (typeof glyph === 'number') {
        x -= (glyph * size) / 1000;
        continue;
      }
      const width = glyph.width * unit;
      const spacing = (glyph.isSpace ? gs.tw : 0) + gs.tc;
      const at = Util.applyTransform([gs.x + x * gs.th, gs.y + gs.rise], m);
      const advance = width * gs.th * Math.abs(m[0]);
      if (actual) actual.count = (actual.count || 0) + 1;
      run.glyphs.push({ x0: at[0], x1: at[0] + advance, y: at[1], natural: advance, char: glyph.fontChar, text: glyph.unicode ?? '', inFont: glyph.isInFont !== false, actual });
      x += width + spacing * direction;
    }
    gs.x += x * gs.th;
    if (run.glyphs.length) runs.push(run);
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    switch (fn) {
      case OPS.save: save(); break;
      case OPS.restore: restore(); break;
      case OPS.transform: ctm = Util.transform(ctm, args); break;
      case OPS.beginAnnotation:
        save();
        ctm = Util.transform(Util.transform(ctm, args[2]), args[3]);
        break;
      case OPS.endAnnotation: restore(); break;
      case OPS.paintFormXObjectBegin: {
        save();
        if (args[0]) ctm = Util.transform(ctm, args[0]);
        if (args[1]) {
          const [x0, y0, x1, y1] = args[1];
          gs.clip = intersect(boxOfPoints([toPage(x0, y0), toPage(x1, y1), toPage(x0, y1), toPage(x1, y0)]), gs.clip);
        }
        break;
      }
      case OPS.paintFormXObjectEnd: restore(); break;
      case OPS.beginGroup:
        groups.push(!!args[0]?.smask);
        save();
        gs.outerFx = fxNow();
        gs.groupAlpha *= gs.alpha;
        gs.alpha = 1;
        gs.smask = false;
        gs.blend = 'source-over';
        break;
      case OPS.endGroup:
        groups.pop();
        restore();
        break;
      case OPS.setGState:
        for (const [key, value] of args[0]) {
          if (key === 'ca') gs.alpha = value;
          else if (key === 'BM') gs.blend = value;
          else if (key === 'SMask') gs.smask = !!value;
          else if (key === 'LW') gs.lineWidth = value;
          else if (key === 'Font') {
            gs.fontName = value[0];
            gs.size = value[1];
          }
        }
        break;
      case OPS.setFillRGBColor:
        gs.fill = [...args];
        gs.pattern = false;
        break;
      case OPS.setStrokeRGBColor: gs.stroke = [...args]; break;
      case OPS.setLineWidth: gs.lineWidth = args[0]; break;
      case OPS.setFillTransparent:
      case OPS.setFillColorN:
      case OPS.setFillShadingPattern:
      case OPS.setFillTilingPattern:
        gs.pattern = true;
        break;
      case OPS.beginText:
        textBlocks++;
        gs.tm = [1, 0, 0, 1, 0, 0];
        gs.x = gs.lineX = 0;
        gs.y = gs.lineY = 0;
        break;
      case OPS.setFont:
        [gs.fontName, gs.size] = args;
        break;
      case OPS.setTextMatrix:
        gs.tm = [...args];
        gs.x = gs.lineX = 0;
        gs.y = gs.lineY = 0;
        break;
      case OPS.setLeadingMoveText:
        gs.leading = -args[1];
        gs.x = gs.lineX += args[0];
        gs.y = gs.lineY += args[1];
        break;
      case OPS.moveText:
        gs.x = gs.lineX += args[0];
        gs.y = gs.lineY += args[1];
        break;
      case OPS.nextLine:
        gs.x = gs.lineX;
        gs.y = gs.lineY += gs.leading;
        break;
      case OPS.setLeading: gs.leading = args[0]; break;
      case OPS.setCharSpacing: gs.tc = args[0]; break;
      case OPS.setWordSpacing: gs.tw = args[0]; break;
      case OPS.setHScale: gs.th = args[0] / 100; break;
      case OPS.setTextRise: gs.rise = args[0]; break;
      case OPS.setTextRenderingMode: gs.mode = args[0]; break;
      case OPS.showText: showText(args[0]); break;
      case OPS.beginMarkedContent: marks.push({}); break;
      case OPS.beginMarkedContentProps: {
        const hidden = args[0] === 'OC' && args[1] && visibility ? !visibility.isVisible(args[1]) : false;
        marks.push({ hidden, ...(typeof args[2] === 'string' && { actual: args[2] }) });
        break;
      }
      case OPS.endMarkedContent: marks.pop(); break;
      case OPS.constructPath: path = readPath(args[0], args[1]); break;
      case OPS.clip:
      case OPS.eoClip:
        if (path) {
          gs.clip = intersect(path.box, gs.clip);
          if (path.curved) gs.clipPath = path.d;
        }
        break;
      case OPS.shadingFill:
        if (!hiddenNow()) paints.push(paintOf(gs.clip || makeBox(0, 0, viewport.width, viewport.height), false));
        break;
      default:
        if (hiddenNow()) break;
        if (PAINTS.has(fn) && path) {
          paints.push(paintOf(intersect(path.box, gs.clip), true));
          lastPicture = null;
        } else if (STROKES.has(fn)) {
          order++;
          if (lastPicture && path && closeBoxes(path.box, lastPicture.box)) {
            lastPicture.frame = { d: path.d, w: Math.round(gs.lineWidth * Math.hypot(ctm[0], ctm[1]) * 100) / 100, color: `#${hex(gs.stroke)}` };
          }
          lastPicture = null;
        } else if (IMAGES.has(fn)) {
          const box = intersect(boxOfPoints([toPage(0, 0), toPage(1, 1), toPage(0, 1), toPage(1, 0)]), gs.clip);
          paints.push(paintOf(box, false));
          lastPicture = null;
          if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
            lastPicture = { box, fx: fxNow(), clipPath: gs.clipPath };
            pictures.push(lastPicture);
          }
        }
    }
  }
  return { runs, paints, pictures, shows, maskShows };
}

/* ---------- From what was drawn to lines ---------- */

/** Letters in a PDF may be named in their joined shapes; the letter itself is what can be written and edited. */
const plainForm = (text) => text.replace(/[ﭐ-﷿ﹰ-ﻼ]+/g, (shapes) => shapes.normalize('NFKC'));

/**
 * What one glyph inside an /ActualText says. A maker can name only part of a ligature (the alef of a lam-alef), where the glyph's
 * own name has it whole; can write digits as typed while the glyph is the Persian one, which is what must be drawn again; and when
 * each glyph has its own letter in the text, they stand in the order drawn.
 */
function saidBy(glyph, mark, seen) {
  const said = mark.actual;
  const chars = [...said];
  if (mark.count > 1 && chars.length === mark.count) {
    mark.used = (mark.used || 0) + 1;
    const own = chars[mark.used - 1];
    return /^[0-9]$/.test(own) && /^[۰-۹]$/.test(glyph.text) ? glyph.text : own;
  }
  if (seen) return '';
  if (said.trim() && glyph.text.length > said.length && plainForm(glyph.text).includes(said)) return glyph.text;
  if (/^[0-9]+$/.test(said) && /^[۰-۹]+$/.test(glyph.text)) return said.replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
  return said;
}

/** The glyphs of a stretch, with what each one says. Everything inside one /ActualText says that one text together. */
function unitsOf(run, seenActual) {
  const units = [];
  for (const glyph of run.glyphs) {
    let text = glyph.text;
    if (glyph.actual) {
      text = saidBy(glyph, glyph.actual, seenActual.has(glyph.actual));
      seenActual.add(glyph.actual);
    }
    units.push({ ...glyph, text: plainForm(text), run });
  }
  return units;
}

const SAME_BASELINE = 0.03;
const SHIFTED_BASELINE = 0.6;
const NEAR = 2.5;

/** Stretches drawn one after another on one baseline, without a real distance between them, are one line. */
function linesOf(runs) {
  const lines = [];
  const seenActual = new Set();
  let line = null;
  for (const run of runs) {
    const units = unitsOf(run, seenActual);
    const first = units[0];
    const left = Math.min(...units.map((u) => u.x0));
    const right = Math.max(...units.map((u) => u.x1));
    if (run.turned) {
      lines.push({ units, runs: [run], art: true, turned: true });
      line = null;
      continue;
    }
    let joined = false;
    if (line && !line.turned) {
      const em = Math.max(line.size, run.size);
      const dy = Math.abs(first.y - line.y);
      const gap = Math.max(left - line.x1, line.x0 - right);
      const overlap = Math.min(right, line.x1) - Math.max(left, line.x0);
      const covers = overlap > Math.min(right - left, line.x1 - line.x0) * 0.5 && overlap > em * 0.2;
      if (dy <= em * SAME_BASELINE && gap <= em * NEAR && !covers) joined = true;
      // Letters of one word, each raised or lowered a little by hand, can only be kept as they are drawn.
      else if (dy < em * SHIFTED_BASELINE && gap < em * 0.15 && !covers) {
        joined = true;
        line.art = true;
      }
    }
    if (joined) {
      line.units.push(...units);
      line.runs.push(run);
      line.x0 = Math.min(line.x0, left);
      line.x1 = Math.max(line.x1, right);
      line.size = Math.max(line.size, run.size);
    } else {
      line = { units: [...units], runs: [run], x0: left, x1: right, y: first.y, size: run.size, art: false };
      lines.push(line);
    }
  }
  return joinedLines(lines);
}

/** A browser draws a line in stretches, each from its own left end, so a stretch only comes to touch the one before when it is done. */
function joinedLines(lines) {
  const out = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && !last.turned && !line.turned) {
      const em = Math.max(last.size, line.size);
      const gap = Math.max(line.x0 - last.x1, last.x0 - line.x1);
      if (Math.abs(line.y - last.y) <= em * SAME_BASELINE && gap <= em * NEAR && gap > -em * 0.2) {
        last.units.push(...line.units);
        last.runs.push(...line.runs);
        last.x0 = Math.min(last.x0, line.x0);
        last.x1 = Math.max(last.x1, line.x1);
        last.size = em;
        last.art = last.art || line.art;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

/** Whether something drawn over letters changes how they look. Black at a few percent over dark letters leaves them as they were. */
function changesLetters(paint, run) {
  if (paint.alpha >= 0.999 || paint.soft) return true;
  if (!paint.color) return paint.alpha > 0.1;
  const change = Math.max(...[0, 1, 2].map((k) => {
    const under = run.fill[k];
    const over = paint.blend === 'multiply' ? (under * paint.color[k]) / 255 : paint.color[k];
    return Math.abs(over - under) * paint.alpha;
  }));
  return change > 24;
}

/** Things that cannot be written as a line of text in a word processor. */
function mustStayDrawn(line, paints, viewport) {
  if (line.art) return true;
  const lineBox = makeBox(line.x0, line.y - line.size * 0.8, line.x1, line.y + line.size * 0.25);
  if (lineBox.x1 < 0 || lineBox.y1 < 0 || lineBox.x0 > viewport.width || lineBox.y0 > viewport.height) return true;
  for (const run of line.runs) {
    if (run.mode !== 0 || run.pattern || run.fx || run.font.isType3Font) return true;
    // Word cannot be trusted with narrowed letters: in some fonts it breaks them to pieces.
    if (Math.abs(run.hs - 1) > 0.03) return true;
    if (run.clip && (run.clip.x0 > line.x0 + 0.6 || run.clip.x1 < line.x1 - 0.6 || run.clip.y0 > lineBox.y0 + run.size * 0.25 || run.clip.y1 < line.y)) return true;
  }
  // Letters that are not really letters would come out as nonsense.
  const text = line.units.map((u) => u.text).join('');
  const bad = (text.match(UNREADABLE) || []).length;
  if (bad > 0 && bad >= text.replace(/\s/g, '').length * 0.1) return true;
  if (!text.trim()) return true;
  // Whatever is drawn after a line and covers it stays over it.
  const last = Math.max(...line.runs.map((run) => run.order));
  const area = areaOf(lineBox);
  for (const paint of paints) {
    if (paint.order > last && areaOf(intersect(lineBox, paint.box)) > area * 0.35 && line.runs.some((run) => changesLetters(paint, run))) return true;
  }
  return false;
}

const ALEF = 'ا';
const LAM_ALEF = 'لا';

function fixLigatureNames(runs) {
  const told = new Map();
  const widths = new Map();
  for (const run of runs) {
    for (const glyph of run.glyphs) {
      if (glyph.text !== ALEF) continue;
      const key = `${run.fontName}:${glyph.char}`;
      if (glyph.actual?.actual === LAM_ALEF) told.set(key, true);
      if (!widths.has(run.fontName)) widths.set(run.fontName, new Map());
      widths.get(run.fontName).set(glyph.char, glyph.natural / run.size);
    }
  }
  for (const [fontName, forms] of widths) {
    // An alef is a narrow letter. A form of it at least half as wide again as the others is not an alef alone.
    const narrowest = Math.min(...forms.values());
    for (const [char, width] of forms) if (forms.size > 1 && width > narrowest * 1.9) told.set(`${fontName}:${char}`, true);
  }
  if (!told.size) return;
  for (const run of runs) {
    for (const glyph of run.glyphs) {
      if (glyph.text === ALEF && !glyph.actual && told.has(`${run.fontName}:${glyph.char}`)) glyph.text = LAM_ALEF;
    }
  }
}

/* ---------- From the order things are drawn in to the order they are read in ---------- */

const classOf = (text) => {
  if (DIGIT.test(text)) return 'N';
  if (RTL_LETTER.test(text)) return 'R';
  if (LATIN_LETTER.test(text)) return 'L';
  if (JOINS_NUMBERS.test(text)) return 'J';
  if (TOUCHES_NUMBERS.test(text)) return 'T';
  return 'O';
};

/** Left to right as drawn. Most files draw a line that way; those that do not are put in place by where things are. */
function inDrawnOrder(units) {
  let steady = true;
  for (let i = 1; i < units.length && steady; i++) {
    if (units[i].x0 < units[i - 1].x0 - units[i].run.size * 0.9) steady = false;
  }
  return steady ? units : [...units].sort((a, b) => a.x0 + a.x1 - b.x0 - b.x1);
}

/** A space that was never written down, only left open between two words. */
function withOpenSpaces(units) {
  const out = [];
  units.forEach((unit, i) => {
    out.push(unit);
    const next = units[i + 1];
    if (!next || !unit.text.trim() || !next.text.trim()) return;
    const gap = next.x0 - unit.x1;
    if (gap > Math.max(unit.run.size, next.run.size) * 0.16) out.push({ x0: unit.x1, x1: next.x0, y: unit.y, natural: 0, char: ' ', text: ' ', inFont: false, actual: null, run: unit.run, open: true });
  });
  return out;
}

/** Puts a line in the order it is read, for a page that runs right to left. Numbers and Latin words keep their own direction. */
function readingOrder(units, namesShapes) {
  const kinds = units.map((u) => classOf(u.text));
  if (!kinds.includes('R')) return { order: units, rtl: false };
  const out = [];
  const take = (u, mirrored) => {
    if (mirrored && MIRRORED[u.text]) u.text = MIRRORED[u.text];
    out.push(u);
  };
  let i = units.length - 1;
  while (i >= 0) {
    const kind = kinds[i];
    if (kind === 'L') {
      let j = i;
      for (let k = i - 1; k >= 0 && kinds[k] !== 'R'; k--) if (kinds[k] === 'L' || kinds[k] === 'N') j = k;
      for (let k = j; k <= i; k++) take(units[k], false);
      i = j - 1;
    } else if (kind === 'N' || (kind === 'T' && kinds[i - 1] === 'N')) {
      let j = i;
      while (j > 0 && (kinds[j - 1] === 'N' || (kinds[j - 1] === 'J' && kinds[j - 2] === 'N') || (kinds[j - 1] === 'T' && j === i))) j--;
      if (j > 0 && kinds[j - 1] === 'T' && kinds[j] === 'N') j--;
      for (let k = j; k <= i; k++) take(units[k], false);
      i = j - 1;
    } else {
      take(units[i], namesShapes);
      i--;
    }
  }
  return { order: out, rtl: true };
}

/** Some files name the shape a bracket is drawn in, others the bracket itself. Lines with a pair in them show which. */
function bracketsNameShapes(lines) {
  let shapes = 0;
  let letters = 0;
  for (const line of lines) {
    const units = inDrawnOrder(line.units);
    const brackets = [...units].reverse().map((u) => u.text).filter((t) => '()[]«»'.includes(t) && t);
    if (brackets.length < 2 || !units.some((u) => RTL_LETTER.test(u.text))) continue;
    if (')]»'.includes(brackets[0])) shapes++;
    else letters++;
  }
  return shapes > letters;
}

/* ---------- Writing a line as a frame ---------- */

const round2 = (v) => Math.round(v * 100) / 100;

const KASHIDA = '\u0640';
const halfPoints = (size) => Math.max(1, Math.round(size * 2) / 2);
const isBlank = (piece) => !piece.text.trim();
const isMark = (text) => /^\p{M}+$/u.test(text);

/**
 * What a word processor can write: a glyph that says nothing of its own belongs to the one before it, and a stretching line drawn
 * as kashidas laid over each other becomes as many whole kashidas as come closest to its length.
 */
function piecesOf(visual) {
  const pieces = [];
  for (const u of visual) {
    const last = pieces[pieces.length - 1];
    // What a word processor will really make of it: letters at their natural width, in a size of whole half points.
    const natural = (u.natural / (u.run.hs || 1)) * (halfPoints(u.run.size) / u.run.size);
    if (u.text === '' && last) {
      last.members.push(u);
      last.x0 = Math.min(last.x0, u.x0);
      last.x1 = Math.max(last.x1, u.x1);
      last.natural += natural;
    } else if (u.text === KASHIDA && last?.kashida && last.run.size === u.run.size) {
      last.members.push(u);
      last.x0 = Math.min(last.x0, u.x0);
      last.x1 = Math.max(last.x1, u.x1);
    } else if (u.text !== '') {
      pieces.push({ text: u.text, x0: u.x0, x1: u.x1, natural: isMark(u.text) || u.text === ZWNJ ? 0 : natural, one: natural, run: u.run, members: [u], kashida: u.text === KASHIDA, open: !!u.open });
    }
  }
  for (const p of pieces) {
    if (!p.kashida || !p.one) continue;
    const count = Math.max(1, Math.round((p.x1 - p.x0) / p.one));
    p.text = KASHIDA.repeat(count);
    p.natural = count * p.one;
  }
  return pieces;
}

function frameOfLine(line, page, fontsOf, namesShapes, spaceWidths) {
  const visual = withOpenSpaces(inDrawnOrder(line.units));
  const pieces = piecesOf(visual);
  // Spaces at either end hold nothing in place, and a word processor treats them in its own way.
  while (pieces.length && !pieces[0].text.trim()) pieces.shift();
  while (pieces.length && !pieces[pieces.length - 1].text.trim()) pieces.pop();
  if (!pieces.length) return null;
  const { order, rtl } = readingOrder(pieces, namesShapes);

  /* The look of each piece. A blank takes the look of the words before it. */
  const lookOf = (p) => {
    const { family, bold } = fontsOf(p.run);
    return { font: family, size: round2(p.run.size), bold, color: hex(p.run.fill) };
  };
  const sameLook = (a, b) => a.font === b.font && a.size === b.size && a.bold === b.bold && a.color === b.color;
  let lastLook = null;
  for (const p of order) {
    if (!isBlank(p) && p.text !== ZWNJ) lastLook = lookOf(p);
    p.look = lastLook;
  }
  const firstLook = order.find((p) => p.look)?.look;
  if (!firstLook) return null;
  const weight = new Map();
  for (const p of order) {
    if (!p.look) p.look = firstLook;
    if (isBlank(p) || p.text === ZWNJ) continue;
    const key = JSON.stringify(p.look);
    weight.set(key, (weight.get(key) || 0) + p.text.length);
  }
  const main = JSON.parse([...weight.entries()].sort((a, b) => b[1] - a[1])[0][0]);

  /* The words, in the order they are read. */
  let text = '';
  const runs = [];
  for (const p of order) {
    p.at = text.length;
    text += p.text;
    const last = runs[runs.length - 1];
    if (last && sameLook(last.look, p.look)) last.text += p.text;
    else runs.push({ text: p.text, look: p.look });
  }
  if (!text.trim()) return null;

  /*
   * Where each word must stand, and what it takes for a word processor to put it there. It writes a word at the word's natural width,
   * so the pen is followed through its widths, and each blank gets what is left from there to the next word's edge.
   */
  const rightEdge = Math.max(...pieces.map((p) => p.x1));
  const leftEdge = Math.min(...pieces.map((p) => p.x0));
  const walk = rtl ? [...pieces].reverse() : pieces;
  const direction = rtl ? -1 : 1;
  const blankWidth = (p) => spaceWidths(p.run, { ...p.look, size: halfPoints(p.look.size) }) * [...p.text].length;
  const extras = new Map();
  const spread = [];
  let pen = rtl ? rightEdge : leftEdge;
  for (let i = 0; i < walk.length;) {
    if (isBlank(walk[i])) {
      const first = walk[i];
      for (; i < walk.length && isBlank(walk[i]); i++) pen += direction * blankWidth(walk[i]);
      const next = walk[i];
      if (next) {
        const wanted = rtl ? next.x1 : next.x0;
        extras.set(first, (wanted - pen) * direction);
        pen = wanted;
      }
      continue;
    }
    const word = [];
    for (; i < walk.length && !isBlank(walk[i]); i++) word.push(walk[i]);
    const solid = word.filter((p) => p.natural > 0);
    const natural = solid.reduce((sum, p) => sum + p.natural, 0);
    const start = rtl ? Math.max(...word.map((p) => p.x1)) : Math.min(...word.map((p) => p.x0));
    const end = rtl ? Math.min(...solid.map((p) => p.x0)) : Math.max(...solid.map((p) => p.x1));
    const actual = solid.length ? Math.abs(end - start) : 0;
    // A word set wider or tighter as a whole, by hand, across a half-space, or by a kashida that could only come close, has that spread
    // over its letters. Word adds it after every letter (a ligature being one, a half-space none), in twentieths of a point,
    // and after the last one too, where it only moves what follows.
    const letters = solid.reduce((sum, p) => sum + (p.kashida ? p.text.length : 1), 0);
    let each = 0;
    if (letters > 1 && Math.abs(actual - natural) >= 0.2) each = Math.round(((actual - natural) / (letters - 1)) * 20) / 20;
    if (Math.abs(each) > 1.5) each = 0;
    if (each) spread.push(Math.min(...word.map((p) => p.at)), Math.max(...word.map((p) => p.at + p.text.length)), each);
    pen = start + direction * (natural + letters * each);
  }
  const spaces = [];
  for (const p of order) {
    if (isBlank(p)) [...p.text].forEach((_, k) => spaces.push(k === 0 ? round2(extras.get(p) ?? 0) : 0));
  }

  /* The frame: exactly as wide as the line. */
  const biggest = Math.max(...line.runs.map((r) => r.size));
  const linePt = Math.round(Math.max(main.size, biggest) * LINE_FACTOR * 2) / 2;
  const baselineY = line.units.reduce((sum, u) => sum + u.y, 0) / line.units.length;
  const topPt = baselineY - linePt * BASELINE_SHARE;
  const style = { font: main.font, size: main.size, bold: main.bold, line: linePt, ...(main.color !== '000000' && { color: main.color }), ...(!rtl && { align: 'left', dir: 'ltr' }) };
  const ownRuns = runs.map(({ text: t, look }) => ({
    text: t,
    ...(look.font !== main.font && { font: look.font }),
    ...(look.size !== main.size && { size: look.size }),
    ...(look.bold !== main.bold && { b: look.bold }),
    ...(look.color !== main.color && { color: look.color }),
  }));
  const plainRun = ownRuns.length === 1 && Object.keys(ownRuns[0]).length === 1;
  const frame = {
    id: uid(),
    kind: 'text',
    anchor: 'page',
    page,
    exact: true,
    // The frame's own edges, to the thousandth of a millimetre, are where the drawing and the text both start from.
    x: Math.round(leftEdge * MM_PER_PT * 1000) / 1000,
    y: Math.round(topPt * MM_PER_PT * 1000) / 1000,
    w: Math.round((rightEdge - leftEdge) * MM_PER_PT * 1000) / 1000,
    h: round2(linePt * MM_PER_PT),
    text,
    style,
    ...(plainRun ? null : { lines: [ownRuns] }),
    gaps: { of: hashOf(text), sp: spaces, ws: spread },
  };
  return { frame, order, visual, pieces, leftEdge, topPt, widthPt: rightEdge - leftEdge };
}

/** A line's drawing: its letters by font and size, in points from the top left of its frame. */
function inkOfLine(built, line, fontKeyOf) {
  const { frame, pieces, visual, leftEdge, topPt, widthPt } = built;
  const offsetOf = new Map();
  for (const p of pieces) for (const u of p.members) offsetOf.set(u, p.at);
  const parts = [];
  let part = null;
  for (const u of visual) {
    if (u.open || !u.inFont || !u.char || !u.char.trim()) continue;
    const key = fontKeyOf(u.run);
    if (key === null) return null;
    const size = round2(u.run.size);
    const y = round2(u.y - topPt);
    const hs = Math.abs(u.run.hs - 1) < 0.001 ? 1 : Math.round(u.run.hs * 1000) / 1000;
    if (!part || part.f !== key || part.s !== size || part.y !== y || part.hs !== hs) {
      part = { f: key, s: size, y, hs, chars: '', xs: [], offs: [] };
      parts.push(part);
    }
    part.chars += u.char;
    part.xs.push(round2(u.x0 - leftEdge));
    part.offs.push(offsetOf.get(u) ?? 0);
  }
  if (!parts.length) return null;
  for (const p of parts) if (p.hs === 1) delete p.hs;

  /* Where each word stands, for picking one on the page. */
  const words = [];
  for (const m of frame.text.matchAll(/\S+/g)) {
    const start = m.index;
    const end = start + m[0].length;
    const inWord = pieces.filter((p) => p.at >= start && p.at < end && p.text !== ZWNJ);
    if (!inWord.length) continue;
    words.push([start, end, round2(Math.min(...inWord.map((p) => p.x0)) - leftEdge), round2(Math.max(...inWord.map((p) => p.x1)) - leftEdge)]);
  }
  return { sig: frameSignature(frame), w: round2(widthPt), parts, words };
}

/* ---------- What stays a picture ---------- */

const MAX_DPI = 300;
const MAX_SIDE = 8000;
const SMALLEST_CUT_MM = 6;
const JPEG_QUALITY = 0.94;

/** A cut must stay whole, so photos that touch are cut as one. */
function cutsOf(pictures, viewport) {
  const smallest = SMALLEST_CUT_MM / MM_PER_PT;
  const pageBox = makeBox(0, 0, viewport.width, viewport.height);
  const pageArea = areaOf(pageBox);
  let boxes = pictures
    .filter((p) => !p.fx)
    .map((p) => ({ ...intersect(p.box, pageBox), picture: p }))
    .filter((b) => b.x1 - b.x0 >= smallest && b.y1 - b.y0 >= smallest && areaOf(b) < pageArea * 0.7);
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (areaOf(intersect(boxes[i], boxes[j])) > 1) {
          const a = boxes[i];
          const b = boxes[j];
          boxes[i] = makeBox(Math.min(a.x0, b.x0), Math.min(a.y0, b.y0), Math.max(a.x1, b.x1), Math.max(a.y1, b.y1));
          boxes.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return boxes;
}

/** A photo as JPEG. Something with few colours, such as a logo, stays sharper and often smaller as PNG. */
function encoded(canvas) {
  const jpeg = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  if (canvas.width * canvas.height > 1600000) return jpeg;
  const png = canvas.toDataURL('image/png');
  return png.length <= jpeg.length * 1.4 ? png : jpeg;
}

/** A picture's frame as words the app can draw again, measured from the corner of its cut. */
function outlineOf(box, x0, y0, width, k) {
  const { picture } = box;
  if (!picture || (!picture.clipPath && !picture.frame)) return null;
  return {
    ox: Math.round((x0 / k) * 100) / 100,
    oy: Math.round((y0 / k) * 100) / 100,
    pw: Math.round((width / k) * 100) / 100,
    ...(picture.clipPath && { clip: picture.clipPath }),
    ...(picture.frame && { stroke: picture.frame.d, w: picture.frame.w, color: picture.frame.color }),
  };
}

function cutOut(canvas, ctx, box, k) {
  const x0 = Math.floor(box.x0 * k);
  const y0 = Math.floor(box.y0 * k);
  const x1 = Math.min(canvas.width, Math.ceil(box.x1 * k));
  const y1 = Math.min(canvas.height, Math.ceil(box.y1 * k));
  const piece = document.createElement('canvas');
  piece.width = x1 - x0;
  piece.height = y1 - y0;
  piece.getContext('2d').drawImage(canvas, x0, y0, piece.width, piece.height, 0, 0, piece.width, piece.height);
  const url = encoded(piece);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x0, y0, piece.width, piece.height);
  const mm = MM_PER_PT / k;
  return { url, x: x0 * mm, y: y0 * mm, w: piece.width * mm, aspect: piece.width / piece.height, outline: outlineOf(box, x0, y0, piece.width, k) };
}

/** Whatever is not written as text: rules, panels, shadows, lines kept as drawn. Photos are cut out of it. */
async function pictureLayers(page, viewport, walked, drawnShows) {
  const k = Math.min(MAX_DPI / 72, MAX_SIDE / Math.max(viewport.width, viewport.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width * k);
  canvas.height = Math.ceil(viewport.height * k);
  const ctx = canvas.getContext('2d');
  let shown = 0;
  globalThis.__pdfTextPaint = () => drawnShows.has(shown++);
  try {
    await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: k }) }).promise;
  } finally {
    delete globalThis.__pdfTextPaint;
  }
  const cuts = cutsOf(walked.pictures, viewport).map((box) => cutOut(canvas, ctx, box, k));
  const png = canvas.toDataURL('image/png');
  // A page that is mostly a picture would be far too large this way.
  const base = png.length > 3000000 ? canvas.toDataURL('image/jpeg', JPEG_QUALITY) : png;
  const mm = MM_PER_PT / k;
  const layer = { url: base, w: canvas.width * mm, aspect: canvas.width / canvas.height };
  canvas.width = 0;
  canvas.height = 0;
  return { layer, cuts };
}

/* ---------- The whole document ---------- */

/** A letter with none of an ordinary letter's parts: everything on its pages stands where a file had it. */
export function blankPlacedLetter(settings) {
  const L = newLetter(settings);
  const hidden = { hidden: true };
  L.letterhead = { logo: null, logoAspect: 1, logoH: 18, org: [], invocation: '', footer: '', footerLine: false, pageNumbers: false, parts: { number: hidden, date: hidden, attachment: hidden, rule: hidden } };
  L.styles = {};
  L.offsets = {};
  L.signer = { name: '', title: '' };
  L.recipient = { name: '', title: '' };
  L.imported = true;
  L.greetingEdited = true;
  L.closingEdited = true;
  L.attachmentManual = true;
  L.bodyDirty = true;
  L.autoFix = false;
  // A whole page belongs to the frames: the flowing text holds nothing but the pages themselves.
  L.geom = { top: 2, right: 2, bottom: 2, left: 2 };
  L.objects = [];
  return L;
}

/** The pages themselves: one empty line on each. */
export function setPlacedPages(L, count) {
  L.body = Array.from({ length: count }, (_, i) => ({ kind: 'p', ...(i > 0 && { pageBreak: true }), over: { line: 1 }, runs: [] }));
  L.bodyHtml = blocksToHtml(L.body);
  L.importInfo = { warnings: [], recognized: {}, form: true, exact: true };
}

export async function letterFromExactPdf(pdf, pages, settings, onProgress) {
  const pdfjs = await import('../vendor/pdfjs/pdf.min.js');
  const visibility = await pdf.getOptionalContentConfig().catch(() => null);
  const L = blankPlacedLetter(settings);

  /* First everything is read, since how a file names its brackets shows over all its pages. */
  const read = [];
  for (const { page } of pages) {
    const viewport = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const walked = walkPage(pdfjs, page, ops, viewport, visibility);
    read.push({ page, viewport, walked });
  }

  /* Some fonts name their lam-alef as a mere alef, in a way that only the file's own marks or the glyph's width give away. */
  fixLigatureNames(read.flatMap((p) => p.walked.runs));
  for (const p of read) p.lines = linesOf(p.walked.runs);
  const namesShapes = bracketsNameShapes(read.flatMap((p) => p.lines.filter((l) => !l.turned)));

  /* A space keeps the width it has in its font; for a font that never writes one, its own idea of a space. */
  const spaceSizes = new Map();
  for (const { walked } of read) {
    for (const run of walked.runs) {
      for (const glyph of run.glyphs) {
        if (glyph.text === ' ' && glyph.natural > 0 && !spaceSizes.has(familyOfFont(run.font.name).family)) spaceSizes.set(familyOfFont(run.font.name).family, glyph.natural / run.size);
      }
    }
  }
  const spaceWidths = (run, look) => {
    const known = spaceSizes.get(look.font);
    return (known ?? 0.25) * look.size;
  };

  const fontNames = new Map();
  const fontsOf = (run) => {
    if (!fontNames.has(run.fontName)) fontNames.set(run.fontName, familyOfFont(run.font.name));
    return fontNames.get(run.fontName);
  };
  const fontData = new Map();
  const fontKeyOf = (run) => {
    if (!run.font.data) return null;
    fontData.set(run.fontName, run.font.data);
    return run.fontName;
  };

  const objects = [];
  const inkFrames = {};
  const frames = [];
  let inkNumber = 0;
  for (let index = 0; index < read.length; index++) {
    const { page, viewport, walked, lines } = read[index];
    const drawn = new Set(walked.maskShows);
    for (const line of lines) {
      let built = null;
      if (!line.turned && !mustStayDrawn(line, walked.paints, viewport)) built = frameOfLine(line, index, fontsOf, namesShapes, spaceWidths);
      if (!built) {
        for (const run of line.runs) drawn.add(run.index);
        continue;
      }
      const ink = inkOfLine(built, line, fontKeyOf);
      if (ink) {
        const key = (inkNumber++).toString(36);
        built.frame.ink = key;
        inkFrames[key] = ink;
      }
      frames.push(built.frame);
    }
    const { layer, cuts } = await pictureLayers(page, viewport, walked, drawn);
    const baseId = uid();
    await putMedia(baseId, layer.url);
    objects.push({ id: uid(), kind: 'image', anchor: 'page', page: index, mediaId: baseId, aspect: layer.aspect, x: 0, y: 0, w: layer.w, behind: true, exact: true });
    for (const cut of cuts) {
      const id = uid();
      await putMedia(id, cut.url);
      objects.push({ id: uid(), kind: 'image', anchor: 'page', page: index, mediaId: id, aspect: cut.aspect, x: cut.x, y: cut.y, w: cut.w, exact: true, ...(cut.outline && { outline: cut.outline }) });
    }
    onProgress?.(index + 1, read.length);
    // Lets the screen show how far it has come.
    await new Promise((done) => setTimeout(done));
    page.cleanup();
  }
  L.objects = [...objects, ...frames];

  /* The PDF's own fonts, for drawing its lines exactly. */
  const fonts = {};
  for (const [key, data] of fontData) {
    const mediaId = uid();
    await putMedia(mediaId, `data:font/otf;base64,${bytesToBase64(data)}`);
    fonts[key] = mediaId;
  }
  const inkId = uid();
  await putMedia(inkId, inkToMedia({ frames: inkFrames }));
  L.ink = { id: inkId, fonts };
  const failed = await loadInkFonts(L);
  for (const key of failed) delete L.ink.fonts[key];

  setPlacedPages(L, read.length);
  return L;
}
