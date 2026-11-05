// Opens a .docx made anywhere (Word on a computer, a colleague, this app) as an editable letter.
// It recognises the usual parts of an Iranian letter and keeps everything else as body text, so nothing is lost:
// whatever is misread can still be moved or fixed on the page.

import { readZip } from './unzip.js';
import { bytesToBase64, loadImage, uid } from './util.js';
import { DEFAULT_STYLES, MM_PER_PT, PAGE, SIGN, baseBefore, blockStyle, buildFlow, geomOf, hashOf, headerParts, lineRatio, newLetter, pageSizeToKeep, usePageSize } from './model.js';
import { blankPlacedLetter, setPlacedPages } from './import-pdf-exact.js';
import { applyLook, runsText } from './runs.js';
import { blocksToHtml, serializeEditor } from './editor.js';
import { putMedia } from './store.js';
import { layoutLetter } from './render.js';

const MM_PER_TWIP = 1 / 56.6929;
const MM_PER_EMU = 1 / 36000;
const MAX_IMAGE_SIDE = 1600;

const decoder = new TextDecoder();
const parseXml = (bytes) => new DOMParser().parseFromString(decoder.decode(bytes), 'application/xml');
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
const firstDeep = (el, name) => {
  if (!el) return null;
  for (const c of el.children) {
    if (c.localName === name) return c;
    const hit = firstDeep(c, name);
    if (hit) return hit;
  }
  return null;
};
const attr = (el, name) => {
  if (!el) return null;
  for (const a of el.attributes) if (a.localName === name) return a.value;
  return null;
};
const isOn = (el) => !!el && !['0', 'false', 'off'].includes(attr(el, 'val'));
const num = (v) => (v === null || v === undefined || v === '' ? undefined : Number(v));

const FONT_ALIASES = { bnazanin: 'B Nazanin', nazanin: 'B Nazanin', btitr: 'B Titr', titr: 'B Titr', blotus: 'B Lotus', lotus: 'B Lotus', bzar: 'B Zar', zar: 'B Zar', vazirmatn: 'Vazirmatn', vazir: 'Vazirmatn' };
const canonicalFont = (name) => (name ? FONT_ALIASES[name.toLowerCase().replace(/[\s_-]+/g, '')] || name : name);

const RTL_TEXT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

/* ---------- Styles ---------- */

function readRunProps(rPr, theme) {
  if (!rPr) return {};
  const p = {};
  const fonts = kid(rPr, 'rFonts');
  if (fonts) {
    const cs = attr(fonts, 'cs') || theme[attr(fonts, 'cstheme')];
    if (cs) p.fontCs = canonicalFont(cs);
  }
  for (const [tag, key] of [['b', 'b'], ['bCs', 'bCs'], ['i', 'i'], ['iCs', 'iCs'], ['rtl', 'rtl'], ['vanish', 'vanish']]) {
    const el = kid(rPr, tag);
    if (el) p[key] = isOn(el);
  }
  const sz = num(attr(kid(rPr, 'sz'), 'val'));
  const szCs = num(attr(kid(rPr, 'szCs'), 'val'));
  if (sz) p.size = sz / 2;
  if (szCs) p.sizeCs = szCs / 2;
  const u = kid(rPr, 'u');
  if (u) p.u = attr(u, 'val') !== 'none';
  const color = attr(kid(rPr, 'color'), 'val');
  if (color) p.color = color;
  const spacing = num(attr(kid(rPr, 'spacing'), 'val'));
  if (spacing !== undefined) p.sp = spacing / 20;
  return p;
}

function readParaProps(pPr) {
  if (!pPr) return {};
  const p = {};
  const pStyle = attr(kid(pPr, 'pStyle'), 'val');
  if (pStyle) p.style = pStyle;
  if (isOn(kid(pPr, 'pageBreakBefore'))) p.pageBreak = true;
  const jc = attr(kid(pPr, 'jc'), 'val');
  if (jc) p.jc = jc;
  const bidi = kid(pPr, 'bidi');
  if (bidi) p.bidi = isOn(bidi);
  const spacing = kid(pPr, 'spacing');
  if (spacing) {
    for (const key of ['before', 'after', 'line']) {
      const v = num(attr(spacing, key));
      if (v !== undefined) p[key] = v;
    }
    const rule = attr(spacing, 'lineRule');
    if (rule) p.lineRule = rule;
  }
  const ind = kid(pPr, 'ind');
  if (ind) {
    const start = num(attr(ind, 'start') ?? attr(ind, 'left'));
    const end = num(attr(ind, 'end') ?? attr(ind, 'right'));
    const first = num(attr(ind, 'firstLine'));
    const hanging = num(attr(ind, 'hanging'));
    if (start !== undefined) p.indStart = start;
    if (end !== undefined) p.indEnd = end;
    if (first !== undefined) p.indFirst = first;
    if (hanging !== undefined) p.indFirst = -hanging;
  }
  const numPr = kid(pPr, 'numPr');
  if (numPr) {
    p.numId = attr(kid(numPr, 'numId'), 'val');
    p.ilvl = num(attr(kid(numPr, 'ilvl'), 'val')) || 0;
  }
  const borders = kid(pPr, 'pBdr');
  if (borders && kid(borders, 'bottom')) p.bottomBorder = true;
  if (borders && kid(borders, 'top')) p.topBorder = true;
  return p;
}

function readTheme(xml) {
  const theme = {};
  if (!xml) return theme;
  const scheme = firstDeep(xml.documentElement, 'fontScheme');
  const fontsOf = (el) => {
    const arab = kids(el, 'font').find((f) => attr(f, 'script') === 'Arab');
    return attr(arab, 'typeface') || attr(kid(el, 'cs'), 'typeface') || '';
  };
  const major = kid(scheme, 'majorFont');
  const minor = kid(scheme, 'minorFont');
  theme.majorBidi = fontsOf(major);
  theme.minorBidi = fontsOf(minor);
  return theme;
}

function readStyles(xml, theme) {
  const styles = new Map();
  let defaults = { r: {}, p: {} };
  let defaultPara = null;
  if (xml) {
    const dd = kid(xml.documentElement, 'docDefaults');
    defaults = { r: readRunProps(kid(kid(dd, 'rPrDefault'), 'rPr'), theme), p: readParaProps(kid(kid(dd, 'pPrDefault'), 'pPr')) };
    for (const s of kids(xml.documentElement, 'style')) {
      const id = attr(s, 'styleId');
      const type = attr(s, 'type');
      styles.set(id, { type, basedOn: attr(kid(s, 'basedOn'), 'val'), r: readRunProps(kid(s, 'rPr'), theme), p: readParaProps(kid(s, 'pPr')), tblPr: kid(s, 'tblPr') });
      if (type === 'paragraph' && attr(s, 'default') === '1') defaultPara = id;
    }
  }
  const chain = (id) => {
    const out = [];
    for (let s = styles.get(id), guard = 0; s && guard < 20; s = styles.get(s.basedOn), guard++) out.unshift(s);
    return out;
  };
  return {
    para: (id) => Object.assign({}, defaults.p, ...chain(id || defaultPara).map((s) => s.p)),
    paraRun: (id) => Object.assign({}, defaults.r, ...chain(id || defaultPara).map((s) => s.r)),
    run: (id) => Object.assign({}, ...chain(id).map((s) => s.r)),
    tableHasBorders: (id) => chain(id).some((s) => kid(s.tblPr, 'tblBorders')),
  };
}

/* ---------- Numbered lists ---------- */

function readNumbering(xml) {
  const abstract = new Map();
  const nums = new Map();
  if (xml) {
    for (const a of kids(xml.documentElement, 'abstractNum')) {
      const levels = new Map();
      for (const l of kids(a, 'lvl')) {
        levels.set(num(attr(l, 'ilvl')), { fmt: attr(kid(l, 'numFmt'), 'val') || 'decimal', text: attr(kid(l, 'lvlText'), 'val') || '', start: num(attr(kid(l, 'start'), 'val')) ?? 1, p: readParaProps(kid(l, 'pPr')) });
      }
      abstract.set(attr(a, 'abstractNumId'), levels);
    }
    for (const n of kids(xml.documentElement, 'num')) nums.set(attr(n, 'numId'), abstract.get(attr(kid(n, 'abstractNumId'), 'val')));
  }
  const counters = new Map();
  const ALPHA = 'ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی';
  const format = (fmt, n) => {
    if (fmt === 'arabicAlpha' || fmt === 'arabicAbjad') return ALPHA[(n - 1) % ALPHA.length];
    if (fmt === 'lowerLetter') return String.fromCharCode(96 + ((n - 1) % 26) + 1);
    if (fmt === 'upperLetter') return String.fromCharCode(64 + ((n - 1) % 26) + 1);
    return String(n);
  };
  return {
    level: (numId, ilvl) => nums.get(numId)?.get(ilvl) || null,
    /** The list's label for the next item, such as «۱-» or a bullet. */
    label(numId, ilvl) {
      const levels = nums.get(numId);
      const lvl = levels?.get(ilvl);
      if (!lvl) return '';
      if (lvl.fmt === 'bullet') return '•';
      if (lvl.fmt === 'none') return '';
      const key = `${numId}:${ilvl}`;
      const n = (counters.get(key) ?? lvl.start - 1) + 1;
      counters.set(key, n);
      for (const k of counters.keys()) {
        const [id, depth] = k.split(':');
        if (id === numId && Number(depth) > ilvl) counters.delete(k);
      }
      return lvl.text.replace(/%(\d)/g, (m, d) => {
        const depth = Number(d) - 1;
        if (depth === ilvl) return format(lvl.fmt, n);
        return format(levels.get(depth)?.fmt || 'decimal', counters.get(`${numId}:${depth}`) ?? 1);
      });
    },
  };
}

/** A border's width in points, negative for a double line, 0 for none. */
function edgeWidth(el) {
  const kind = attr(el, 'val');
  if (!el || !kind || kind === 'nil' || kind === 'none') return 0;
  const width = (num(attr(el, 'sz')) || 4) / 8;
  return kind === 'double' ? -Math.round(width * 3 * 100) / 100 : Math.round(width * 100) / 100;
}

/* ---------- Reading a document part ---------- */

class PartReader {
  constructor(doc, partName) {
    this.doc = doc;
    this.partName = partName;
    this.rels = doc.relsOf(partName);
    this.floats = [];
  }

  /** Block-level content of a body, header, cell or text box. */
  blocks(container) {
    const out = [];
    for (const el of container.children) {
      const name = el.localName;
      if (name === 'p') out.push(this.paragraph(el));
      else if (name === 'tbl') out.push(this.table(el));
      else if (name === 'sdt') out.push(...this.blocks(kid(el, 'sdtContent') || el));
      else if (name === 'customXml' || name === 'smartTag') out.push(...this.blocks(el));
      else if (name === 'AlternateContent') out.push(...this.blocks(kid(el, 'Choice') || kid(el, 'Fallback') || el));
    }
    return out;
  }

  paragraph(el) {
    const { styles, numbering } = this.doc;
    const direct = readParaProps(kid(el, 'pPr'));
    const styleProps = styles.para(direct.style);
    const lvl = direct.numId || styleProps.numId ? numbering.level(direct.numId ?? styleProps.numId, direct.ilvl ?? styleProps.ilvl ?? 0) : null;
    const props = { ...styleProps, ...lvl?.p, ...direct };
    const block = { kind: 'p', props, runs: [], floats: [], boxes: [], lines: [], hasPageField: false };
    const base = { ...styles.paraRun(direct.style), ...readRunProps(kid(kid(el, 'pPr'), 'rPr'), this.doc.theme) };
    const state = { inInstr: false };
    this.inline(el, base, block, state);
    if (props.numId && props.numId !== '0') {
      const label = numbering.label(props.numId, props.ilvl || 0);
      const firstText = block.runs.find((r) => r.text);
      if (label && firstText) block.runs.unshift({ ...firstText, text: `${label} ` });
    }
    block.bidi = !!props.bidi;
    block.jc = props.jc;
    block.markSize = base.sizeCs || base.size || 11;
    block.markFont = base.fontCs;
    return block;
  }

  inline(node, base, block, state) {
    for (const el of node.children) {
      const name = el.localName;
      if (name === 'r') this.run(el, base, block, state);
      else if (['hyperlink', 'smartTag', 'ins', 'sdt', 'sdtContent', 'fldSimple', 'customXml', 'moveTo', 'dir', 'bdo'].includes(name)) {
        if (name === 'fldSimple' && /\bN?U?M?PAGES?\b/.test(attr(el, 'instr') || '')) block.hasPageField = true;
        this.inline(el, base, block, state);
      }
    }
  }

  run(el, base, block, state) {
    const { styles, theme } = this.doc;
    const rPr = kid(el, 'rPr');
    const rs = attr(kid(rPr, 'rStyle'), 'val');
    const props = { ...base, ...(rs ? styles.run(rs) : null), ...readRunProps(rPr, theme) };
    if (props.vanish) return;
    let text = '';
    const flush = () => {
      if (!text) return;
      const rtl = props.rtl || RTL_TEXT.test(text);
      block.runs.push({
        text,
        rtl,
        font: rtl ? props.fontCs : undefined,
        size: (rtl ? props.sizeCs : props.size) || props.sizeCs || props.size,
        b: !!(rtl ? props.bCs ?? props.b : props.b),
        i: !!(rtl ? props.iCs ?? props.i : props.i),
        u: !!props.u,
        ...(props.sp && { sp: props.sp }),
        color: props.color && props.color.toLowerCase() !== 'auto' && props.color !== '000000' ? props.color.toUpperCase() : undefined,
      });
      text = '';
    };
    const visit = (parent) => {
      for (const c of parent.children) {
        const name = c.localName;
        if (name === 'fldChar') {
          const type = attr(c, 'fldCharType');
          if (type === 'begin') state.inInstr = true;
          else if (type === 'separate' || type === 'end') state.inInstr = false;
        } else if (name === 'instrText') {
          if (/\bN?U?M?PAGES?\b/.test(c.textContent)) block.hasPageField = true;
        } else if (state.inInstr) {
          continue;
        } else if (name === 't') text += c.textContent;
        else if (name === 'tab' || name === 'ptab') text += '\t';
        else if (name === 'br' || name === 'cr') {
          if (attr(c, 'type') !== 'page') text += '\n';
        } else if (name === 'noBreakHyphen') text += '-';
        else if (name === 'drawing') {
          flush();
          this.drawing(c, block);
        } else if (name === 'pict' || name === 'object') {
          flush();
          this.vml(c, block);
        } else if (name === 'AlternateContent') {
          const choice = kid(c, 'Choice');
          visit(choice && firstDeep(choice, 'drawing') ? choice : kid(c, 'Fallback') || c);
        }
      }
    };
    visit(el);
    flush();
  }

  drawing(el, block) {
    const holder = kid(el, 'inline') || kid(el, 'anchor');
    if (!holder) return;
    const size = this.extent(holder);
    if (holder.localName === 'inline') {
      const image = this.imageRef(holder, size);
      if (image) block.runs.push({ image });
      return;
    }
    const place = this.anchorPlace(holder, size);
    this.collectShapes(holder, size, place, block);
  }

  collectShapes(holder, size, place, block) {
    const group = firstDeep(holder, 'wgp');
    if (group) {
      const xfrm = kid(kid(group, 'grpSpPr'), 'xfrm');
      const chOff = kid(xfrm, 'chOff');
      const chExt = kid(xfrm, 'chExt');
      const sx = size.w / (num(attr(chExt, 'cx')) || 1);
      const sy = size.h / (num(attr(chExt, 'cy')) || 1);
      for (const child of group.children) {
        if (!['wsp', 'pic'].includes(child.localName)) continue;
        const own = firstDeep(child, 'xfrm');
        const off = kid(own, 'off');
        const ext = kid(own, 'ext');
        const childPlace = { ...place, x: place.x + ((num(attr(off, 'x')) || 0) - (num(attr(chOff, 'x')) || 0)) * sx, y: place.y + ((num(attr(off, 'y')) || 0) - (num(attr(chOff, 'y')) || 0)) * sy };
        this.collectShapes(child, { w: (num(attr(ext, 'cx')) || 0) * sx, h: (num(attr(ext, 'cy')) || 0) * sy }, childPlace, block);
      }
      return;
    }
    const text = firstDeep(holder, 'txbxContent');
    if (text) {
      const line = firstDeep(holder, 'spPr');
      const hasLine = line && kid(line, 'ln') && !kid(kid(line, 'ln'), 'noFill');
      const fill = attr(kid(kid(line, 'solidFill'), 'srgbClr'), 'val');
      block.boxes.push({ ...place, ...size, border: !!hasLine, ...(fill && { fill }), blocks: this.blocks(text) });
      return;
    }
    const geom = attr(firstDeep(holder, 'prstGeom'), 'prst');
    if (geom === 'line' || firstDeep(holder, 'cNvCnPr')) {
      block.lines.push({ ...place, ...size });
      return;
    }
    const image = this.imageRef(holder, size);
    if (image) block.floats.push({ ...place, image });
  }

  extent(holder) {
    const e = kid(holder, 'extent');
    return { w: (num(attr(e, 'cx')) || 0) * MM_PER_EMU, h: (num(attr(e, 'cy')) || 0) * MM_PER_EMU };
  }

  anchorPlace(holder, size) {
    const g = this.doc.geom;
    const H = kid(holder, 'positionH');
    const V = kid(holder, 'positionV');
    const relH = attr(H, 'relativeFrom');
    const relV = attr(V, 'relativeFrom');
    const alignH = kid(H, 'align')?.textContent;
    const offH = num(kid(H, 'posOffset')?.textContent);
    const offV = num(kid(V, 'posOffset')?.textContent);
    const fromPage = relH === 'page';
    const areaLeft = fromPage ? 0 : g.left;
    const areaW = fromPage ? PAGE.w : PAGE.w - g.left - g.right;
    let x;
    if (alignH === 'center') x = areaLeft + (areaW - size.w) / 2;
    else if (alignH === 'right' || alignH === 'outside') x = areaLeft + areaW - size.w;
    else if (alignH === 'left' || alignH === 'inside') x = areaLeft;
    else x = (offH || 0) * MM_PER_EMU + (relH === 'rightMargin' ? PAGE.w - g.right : areaLeft);

    const fromFlow = relV === 'paragraph' || relV === 'line';
    let y = (offV || 0) * MM_PER_EMU;
    if (relV === 'margin' || relV === 'topMargin') y += g.top;
    else if (relV === 'bottomMargin') y += PAGE.h - g.bottom;
    return { x, y, fromFlow, behind: attr(holder, 'behindDoc') === '1' };
  }

  imageRef(holder, size) {
    const blip = firstDeep(holder, 'blip');
    const rid = attr(blip, 'embed');
    if (!rid) return null;
    const crop = firstDeep(holder, 'srcRect');
    // Word counts a picture's turn forwards, in 60000ths of a degree.
    const turned = (num(attr(firstDeep(holder, 'xfrm'), 'rot')) || 0) / 60000;
    const rotate = turned > 180 ? turned - 360 : turned;
    return { target: this.rels.get(rid), w: size.w, h: size.h, crop: crop ? ['l', 't', 'r', 'b'].map((k) => (num(attr(crop, k)) || 0) / 100000) : null, ...(rotate && { rotate }) };
  }

  /** Old-style pictures and text boxes. Word still writes these for some files. */
  vml(el, block) {
    const text = firstDeep(el, 'txbxContent');
    const shape = firstDeep(el, 'shape') || firstDeep(el, 'rect');
    const style = attr(shape, 'style') || '';
    const pt = (name) => {
      const m = new RegExp(`(?:^|;)\\s*${name}:\\s*(-?[\\d.]+)pt`).exec(style);
      return m ? Number(m[1]) * (25.4 / 72) : undefined;
    };
    const size = { w: pt('width') || 40, h: pt('height') || 15 };
    if (text) {
      const fromPage = /mso-position-horizontal-relative:page/.test(style);
      const x = (pt('margin-left') || 0) + (fromPage ? 0 : this.doc.geom.left);
      const fromFlow = !/mso-position-vertical-relative:(page|margin)/.test(style);
      block.boxes.push({ x, y: pt('margin-top') || 0, fromFlow, ...size, border: attr(shape, 'stroked') !== 'f', blocks: this.blocks(text) });
      return;
    }
    const rid = attr(firstDeep(el, 'imagedata'), 'id');
    if (!rid) return;
    const image = { target: this.rels.get(rid), ...size, crop: null };
    if (/position:absolute/.test(style)) block.floats.push({ x: pt('margin-left') || 0, y: pt('margin-top') || 0, fromFlow: true, image });
    else block.runs.push({ image });
  }

  table(el) {
    const tblPr = kid(el, 'tblPr');
    const grid = kids(kid(el, 'tblGrid'), 'gridCol').map((c) => num(attr(c, 'w')) || 0);
    const rtl = isOn(kid(tblPr, 'bidiVisual'));
    const borders = kid(tblPr, 'tblBorders');
    const styleId = attr(kid(tblPr, 'tblStyle'), 'val');
    const visibleBorders = borders
      ? [...borders.children].some((b) => !['nil', 'none'].includes(attr(b, 'val')))
      : this.doc.styles.tableHasBorders(styleId);
    const hasBottom = borders && kid(borders, 'bottom') && !['nil', 'none'].includes(attr(kid(borders, 'bottom'), 'val'));
    const margins = kid(tblPr, 'tblCellMar');
    const marginOf = (name) => num(attr(kid(margins, name), 'w'));
    const sideMargin = Math.max(marginOf('left') ?? marginOf('start') ?? 200, marginOf('right') ?? marginOf('end') ?? 200);

    const merged = [];
    let header = false;
    let ownBorders = false;
    const rows = kids(el, 'tr').map((tr, r) => {
      const trPr = kid(tr, 'trPr');
      if (r === 0 && isOn(kid(trPr, 'tblHeader'))) header = true;
      let col = num(attr(kid(trPr, 'gridBefore'), 'val')) || 0;
      const rowH = (num(attr(kid(trPr, 'trHeight'), 'val')) || 0) * MM_PER_TWIP;
      const cells = [];
      for (const tc of kids(tr, 'tc')) {
        const tcPr = kid(tc, 'tcPr');
        const span = num(attr(kid(tcPr, 'gridSpan'), 'val')) || 1;
        const vm = kid(tcPr, 'vMerge');
        const own = kid(tcPr, 'tcBorders');
        if (vm && attr(vm, 'val') !== 'restart') {
          const above = merged[col];
          if (above) {
            above.rowSpan = (above.rowSpan || 1) + 1;
            // The bottom of a merged cell is drawn by its last row.
            if (own && above.ownBorders) above.ownBorders.bottom = own;
          }
          col += span;
          continue;
        }
        const cell = { paras: this.blocks(tc), span, vAlign: attr(kid(tcPr, 'vAlign'), 'val') || 'top', rowH };
        const fill = attr(kid(tcPr, 'shd'), 'fill');
        if (fill && !['auto', 'FFFFFF', 'ffffff'].includes(fill)) cell.bg = fill.toUpperCase();
        if (own) {
          ownBorders = true;
          cell.ownBorders = { cell: own, bottom: own };
        }
        merged[col] = vm ? cell : null;
        cells.push(cell);
        col += span;
      }
      return cells;
    });
    // Borders set cell by cell, as a form has them: each cell keeps what it draws, on the side of the page it draws it.
    if (ownBorders) {
      const fromTable = (name) => (borders ? edgeWidth(kid(borders, name)) : visibleBorders ? 0.5 : 0);
      const sideOf = (from, ...names) => {
        for (const name of names) {
          const el = kid(from, name);
          if (el) return edgeWidth(el);
        }
        return undefined;
      };
      rows.forEach((row, r) => {
        row.forEach((cell, c) => {
          const { cell: own, bottom } = cell.ownBorders || {};
          const lastRow = r + (cell.rowSpan || 1) >= rows.length;
          const start = sideOf(own, 'left', 'start') ?? fromTable(c === 0 ? 'left' : 'insideV');
          const end = sideOf(own, 'right', 'end') ?? fromTable(c === row.length - 1 ? 'right' : 'insideV');
          cell.borders = [sideOf(own, 'top') ?? fromTable(r === 0 ? 'top' : 'insideH'), rtl ? start : end, sideOf(bottom, 'bottom') ?? fromTable(lastRow ? 'bottom' : 'insideH'), rtl ? end : start];
          delete cell.ownBorders;
        });
      });
    }
    const jc = attr(kid(tblPr, 'jc'), 'val');
    // A table kept to the millimetre: what its rows lost to Word's way of counting lines comes back here.
    if (sideMargin <= 30 && ownBorders) {
      const widest = (row, side) => Math.max(0, ...(row || []).map((c) => Math.abs(c.borders?.[side] || 0)));
      rows.forEach((row, r) => {
        const above = r === 0 ? widest(rows[0], 0) / 2 : Math.max(widest(row, 0), widest(rows[r - 1], 2));
        const below = r === rows.length - 1 ? widest(row, 2) / 2 : 0;
        for (const cell of row) if (cell.rowH) cell.rowH += (above + below) * MM_PER_PT;
      });
    }
    return { kind: 'table', rows, grid, rtl, borderless: ownBorders || !visibleBorders, header, hasBottom, jc, ...(sideMargin <= 30 && { pad: (sideMargin * MM_PER_TWIP) }) };
  }
}

/* ---------- Pictures ---------- */

async function imageToMedia(doc, image) {
  const cacheKey = `${image.target}|${(image.crop || []).join(',')}`;
  if (doc.media.has(cacheKey)) return doc.media.get(cacheKey);
  const read = image.target && doc.file(image.target);
  const ext = (image.target || '').split('.').pop().toLowerCase();
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }[ext];
  if (!read || !mime) {
    doc.warnings.add('picture');
    doc.media.set(cacheKey, null);
    return null;
  }
  let dataUrl = `data:${mime};base64,${bytesToBase64(read)}`;
  const big = read.length > 1500000;
  if (mime === 'image/gif' || mime === 'image/bmp' || mime === 'image/webp' || image.crop || big) {
    const img = await loadImage(dataUrl);
    const [l, t, r, b] = image.crop || [0, 0, 0, 0];
    const sw = img.naturalWidth * (1 - l - r);
    const sh = img.naturalHeight * (1 - t - b);
    const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * k));
    canvas.height = Math.max(1, Math.round(sh * k));
    canvas.getContext('2d').drawImage(img, img.naturalWidth * l, img.naturalHeight * t, sw, sh, 0, 0, canvas.width, canvas.height);
    dataUrl = mime === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.92) : canvas.toDataURL('image/png');
  }
  const id = uid();
  await putMedia(id, dataUrl);
  doc.media.set(cacheKey, id);
  return id;
}

/* ---------- Recognising the parts of a letter ---------- */

// For recognising words: spelling variants and half-spaces do not matter here.
const plain = (s) => s.replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[‌‏‎]/g, ' ').replace(/\s+/g, ' ').trim();
// For keeping text: only invisible direction marks and repeated spaces go, the half-spaces stay.
const clean = (s) => s.replace(/[‏‎]/g, '').replace(/\s+/g, ' ').trim();
const textOf = (block) => block.runs.map((r) => r.text || '').join('');
const isEmpty = (block) => block.kind === 'p' && !plain(textOf(block)) && !block.runs.some((r) => r.image) && !block.floats.length && !block.boxes.length;

const INVOCATION = /^[«"(]?\s*(باسمه?\s*تعالی|بسمه?\s*تعالی|بسم\s*الله.*|به\s*نام\s*خدا.*|هو\s*ال.*|هو)\s*[»")]?$/;
const META_LABEL = /(شماره(?:[\s‌]*نامه)?|تاریخ(?:[\s‌]*نامه)?|پیوست(?:[\s‌]*ها)?)\s*[:：]/g;
const SUBJECT = /^موضوع\s*[:：]\s*(.*)$/;
const GREETING = /^(با\s*سلام|سلام|با\s*درود|با\s*عرض|با\s*تقدیم|احتراما)/;
const CLOSING = /(با\s*تشکر|با\s*سپاس|با\s*احترام|پیشاپیش|سپاسگزار|ممنون|متشکر)/;
const CC = /^رونوشت\s*[:：]?\s*(.*)$/;

/** Splits «شماره: ۱۲ تاریخ: ۱۴۰۵/۰۱/۰۱» into its fields. Returns null when the line is not letterhead information. */
export function parseMeta(text) {
  const line = clean(text).replace(/[يى]/g, 'ی');
  if (line.length > 90) return null;
  const hits = [...line.matchAll(META_LABEL)];
  if (!hits.length || hits[0].index > 2) return null;
  const out = {};
  hits.forEach((m, i) => {
    const value = line.slice(m.index + m[0].length, hits[i + 1]?.index ?? line.length).replace(/^[.\-_…\s]+$/, '').trim();
    if (m[1].startsWith('شماره')) out.number = value;
    else if (m[1].startsWith('تاریخ')) out.date = value;
    else out.attachment = value;
  });
  return out;
}

export const isInvocation = (text) => INVOCATION.test(plain(text));

export function flatten(blocks, out = []) {
  for (const b of blocks) {
    if (b.kind === 'table') b.rows.forEach((row) => row.forEach((cell) => flatten(cell.paras, out)));
    else out.push(b);
  }
  return out;
}

function mostCommon(values, fallback) {
  const counts = new Map();
  for (const [value, weight] of values) {
    if (value === undefined || value === null) continue;
    counts.set(value, (counts.get(value) || 0) + weight);
  }
  let best = fallback;
  let max = 0;
  for (const [value, count] of counts) {
    if (count > max) {
      best = value;
      max = count;
    }
  }
  return best;
}

function visualAlign(block) {
  const text = textOf(block);
  const { jc } = block;
  if (jc === 'center') return 'center';
  if (['both', 'distribute', 'thaiDistribute', 'lowKashida', 'mediumKashida', 'highKashida'].includes(jc)) return 'justify';
  if (jc === 'left' || jc === 'start') return block.bidi ? 'right' : 'left';
  if (jc === 'right' || jc === 'end') return block.bidi ? 'left' : 'right';
  // Persian typed in a left-to-right paragraph, with nothing set, is still meant to start on the right.
  return block.bidi || RTL_TEXT.test(text) ? 'right' : 'left';
}

function lineSpacing(props, size, ratio = 1.5) {
  if (props.line === undefined) return undefined;
  if (props.lineRule === 'exact' || props.lineRule === 'atLeast') return Math.round((props.line / 20 / (size * ratio)) * 100) / 100;
  return Math.round((props.line / 240) * 100) / 100;
}

/** The look most of a group of paragraphs share, used as that part's style. */
export function dominantStyle(blocks, base) {
  const weigh = (fn) => blocks.flatMap((b) => b.runs.filter((r) => r.text).map((r) => [fn(r), r.text.length]));
  const size = mostCommon(weigh((r) => r.size), base.size);
  const font = mostCommon(weigh((r) => r.font), base.font);
  const bold = mostCommon(weigh((r) => r.b), base.bold);
  const align = mostCommon(blocks.map((b) => [visualAlign(b), Math.max(1, textOf(b).length)]), base.align);
  const props = blocks.map((b) => [b.props, Math.max(1, textOf(b).length)]);
  const pick = (fn, fallback) => mostCommon(props.map(([p, w]) => [fn(p), w]), fallback);
  const before = pick((p) => (p.before !== undefined ? p.before / 20 : undefined), 0);
  const after = pick((p) => (p.after !== undefined ? p.after / 20 : undefined), 0);
  const spacing = pick((p) => lineSpacing(p, size), 1);
  return { font: font || base.font, size, bold, align, before: Math.min(before, 36), after: Math.min(after, 36), spacing: Math.max(0.8, Math.min(spacing, 3)) };
}

function runsAgainst(block, st, boldBase = st.bold) {
  const out = [];
  for (const r of block.runs) {
    if (r.imageId) {
      out.push({ img: { id: r.imageId, w: r.image.w, aspect: r.image.w / (r.image.h || r.image.w) || 1 } });
      continue;
    }
    if (!r.text) continue;
    const run = { text: r.text };
    if (r.b !== !!boldBase) run.b = r.b;
    if (r.u) run.u = true;
    if (r.i) run.i = true;
    if (r.font && r.font !== st.font) run.font = r.font;
    if (r.size && r.size !== st.size) run.size = r.size;
    if (r.color) run.color = r.color;
    out.push(run);
  }
  return out;
}

function indentOf(block) {
  const { indStart, indEnd, indFirst } = block.props;
  const toMm = (v) => Math.round((v || 0) * MM_PER_TWIP * 100) / 100;
  // In a right-to-left paragraph the start is the right side; a left-to-right one mirrors it.
  const rightSide = block.bidi || RTL_TEXT.test(textOf(block)) ? indStart : indEnd;
  const leftSide = block.bidi || RTL_TEXT.test(textOf(block)) ? indEnd : indStart;
  const start = toMm(rightSide);
  const end = toMm(leftSide);
  const first = toMm(indFirst);
  return start || end || first ? { ...(start && { start }), ...(end && { end }), ...(first && { first }) } : undefined;
}

/** The spacing a paragraph has in the file, where it differs from its part's usual look. */
function spacingOver(block, st, { exactLines = false } = {}) {
  const { before, after, line, lineRule } = block.props;
  const size = block.runs.find((r) => r.size)?.size || st.size;
  const exact = exactLines && lineRule === 'exact' && line;
  const own = { before: (before || 0) / 20, after: (after || 0) / 20, spacing: exact ? st.spacing : lineSpacing(block.props, size) ?? 1 };
  const over = {};
  for (const key of ['before', 'after', 'spacing']) if (Math.abs(own[key] - st[key]) > 0.01) over[key] = own[key];
  if (exact) over.line = line / 20;
  return Object.keys(over).length ? over : undefined;
}

export function bodyParagraph(block, st) {
  const align = visualAlign(block);
  const indent = indentOf(block);
  const over = spacingOver(block, st);
  return { kind: 'p', ...(align !== st.align && { align }), ...(indent && { indent }), ...(over && { over }), runs: runsAgainst(block, st) };
}

export function bodyTable(table, st, textWidthTw) {
  const cols = table.grid.length || Math.max(...table.rows.map((r) => r.reduce((n, c) => n + c.span, 0)));
  const total = table.grid.reduce((a, b) => a + b, 0);
  let widths = total ? table.grid.map((w) => Math.round((w / total) * 10000) / 100) : null;
  // This app's tables always run right to left, so a left-to-right table is mirrored to look the same.
  const order = (list) => (table.rtl ? list : [...list].reverse());
  if (widths) widths = order(widths);
  const cellStyle = { ...st, before: 0, after: 0 };
  const rows = table.rows.map((row, r) =>
    order(row).map((cell) => ({
      ...(cell.span > 1 && { colSpan: cell.span }),
      ...(cell.rowSpan > 1 && { rowSpan: cell.rowSpan }),
      ...(cell.bg && { bg: cell.bg }),
      vAlign: cell.vAlign,
      ...(cell.rowH && { rowH: Math.round(cell.rowH * 100) / 100 }),
      ...(cell.borders && { borders: table.rtl ? cell.borders : [cell.borders[0], cell.borders[3], cell.borders[2], cell.borders[1]] }),
      paras: flatten(cell.paras).map((p) => {
        const align = visualAlign(p);
        const over = spacingOver(p, cellStyle, { exactLines: true });
        const indent = indentOf(p);
        return { ...(align !== st.align && { align }), ...(over && { over }), ...(indent && { indent }), runs: runsAgainst(p, st, st.bold || (table.header && r === 0)) };
      }),
    })),
  );
  const pct = total && textWidthTw ? (total / textWidthTw) * 100 : 100;
  // In a right-to-left table "left" is its start, the right side of the page.
  const tableAlign = table.jc === 'center' ? 'center' : table.jc === 'right' || table.jc === 'end' ? (table.rtl ? 'left' : 'right') : table.rtl ? 'right' : 'left';
  return {
    kind: 'table',
    header: table.header,
    ...(table.borderless && { borderless: true }),
    ...(widths && widths.length === cols && { widths }),
    ...(pct < 98 && { widthPct: Math.round(pct * 10) / 10, tableAlign }),
    ...(table.pad !== undefined && { pad: Math.round(table.pad * 100) / 100 }),
    rows,
  };
}

/* ---------- The whole document ---------- */

function openDocument(bytes) {
  const zip = readZip(bytes);
  const file = (name) => zip.get(name)?.();
  const xmlOf = (name) => {
    const data = file(name);
    return data ? parseXml(data) : null;
  };
  const main = xmlOf('word/document.xml');
  if (!main) throw new Error('not a Word document');

  const doc = {
    file,
    warnings: new Set(),
    media: new Map(),
    theme: readTheme(xmlOf('word/theme/theme1.xml')),
    relsOf(partName) {
      const dir = partName.slice(0, partName.lastIndexOf('/'));
      const name = partName.slice(partName.lastIndexOf('/') + 1);
      const rels = new Map();
      const xml = xmlOf(`${dir}/_rels/${name}.rels`);
      for (const r of kids(xml?.documentElement, 'Relationship')) {
        const target = attr(r, 'Target');
        if (attr(r, 'TargetMode') === 'External') continue;
        rels.set(attr(r, 'Id'), target.startsWith('/') ? target.slice(1) : `${dir}/${target}`.replace(/[^/]+\/\.\.\//g, ''));
      }
      return rels;
    },
  };
  doc.styles = readStyles(xmlOf('word/styles.xml'), doc.theme);
  doc.numbering = readNumbering(xmlOf('word/numbering.xml'));

  const bodyEl = kid(main.documentElement, 'body');
  const sect = kid(bodyEl, 'sectPr');
  const margin = kid(sect, 'pgMar');
  const mm = (name, fallback) => {
    const v = num(attr(margin, name));
    return v === undefined ? fallback : v * MM_PER_TWIP;
  };
  doc.geom = { top: mm('top', 25), right: mm('right', 25), bottom: mm('bottom', 25), left: mm('left', 25), header: mm('header', 12) };
  // A file with pages of another size keeps them.
  const paper = kid(sect, 'pgSz');
  const paperW = num(attr(paper, 'w'));
  const paperH = num(attr(paper, 'h'));
  doc.page = paperW && paperH ? pageSizeToKeep(paperW * MM_PER_TWIP, paperH * MM_PER_TWIP) : null;
  usePageSize(doc);

  const mainRels = doc.relsOf('word/document.xml');
  // A letter with a different first page keeps its letterhead on that first page.
  const preferred = kid(sect, 'titlePg') ? ['first', 'default'] : ['default', 'first'];
  const partFor = (tag) => {
    const own = kids(sect, tag);
    const refs = own.length ? own : [...main.getElementsByTagNameNS('*', tag)];
    const ref = preferred.map((type) => refs.find((r) => attr(r, 'type') === type)).find(Boolean) || refs[0];
    return mainRels.get(attr(ref, 'id')) || null;
  };

  doc.bodyReader = new PartReader(doc, 'word/document.xml');
  doc.body = doc.bodyReader.blocks(bodyEl);
  const readPart = (target) => {
    if (!target) return [];
    const xml = xmlOf(target);
    return xml ? new PartReader(doc, target).blocks(xml.documentElement) : [];
  };
  doc.header = readPart(partFor('headerReference'));
  doc.footer = readPart(partFor('footerReference'));
  return doc;
}

async function resolveRunImages(doc, blocks) {
  for (const b of flatten(blocks)) {
    for (const r of b.runs) if (r.image) r.imageId = await imageToMedia(doc, r.image);
    b.runs = b.runs.filter((r) => !r.image || r.imageId);
    for (const box of b.boxes) await resolveRunImages(doc, box.blocks);
    for (const f of b.floats) f.id = await imageToMedia(doc, f.image);
  }
}

/** Turns a Word file's bytes into a letter object. Pictures are saved along the way. */
export async function importDocx(bytes, settings) {
  const doc = openDocument(bytes);
  await resolveRunImages(doc, [...doc.body, ...doc.header, ...doc.footer]);
  return letterFromDocument(doc, settings);
}

/** Recognises the parts of a letter in a document that has been read into blocks, from Word or from a PDF. */
/* ---------- A page taken exactly from a PDF, saved as Word and opened again ---------- */

const EXACT_STYLE = /^(Nh\d+|Namehyar\s*\d*)$/;

const isExactWord = (doc) => doc.body.some((b) => b.kind === 'p' && b.boxes.some((box) => flatten(box.blocks).some((p) => EXACT_STYLE.test(p.props.style || ''))));

/** What was added to keep each word of a line in place, read back from the runs that carry it. */
function gapsOfLine(block, text) {
  const gaps = { of: hashOf(text), sp: [], ws: [] };
  let at = 0;
  for (const run of block.runs) {
    if (!run.text) continue;
    const blank = run.text === ' ' || run.text === '\u00a0';
    if (run.sp && !blank) gaps.ws.push(at, at + run.text.length, run.sp);
    for (const ch of run.text) if (ch === ' ' || ch === '\u00a0') gaps.sp.push(blank ? run.sp || 0 : 0);
    at += run.text.length;
  }
  return gaps;
}

function letterFromExactWord(doc, settings) {
  const L = blankPlacedLetter(settings);
  if (doc.page) L.page = doc.page;
  usePageSize(L);
  const pictures = [];
  const frames = [];
  let page = 0;
  doc.body.forEach((block, index) => {
    if (block.kind !== 'p') return;
    if (index > 0 && block.props.pageBreak) page++;
    for (const f of block.floats) {
      if (!f.id) continue;
      pictures.push({ id: uid(), kind: 'image', anchor: 'page', page, mediaId: f.id, aspect: f.image.w / (f.image.h || f.image.w) || 1, x: f.x, y: f.fromFlow ? doc.geom.top + f.y : f.y, w: f.image.w, exact: true, ...(f.behind && { behind: true }), ...(f.image.rotate && { rotate: f.image.rotate }) });
    }
    for (const box of block.boxes) {
      const lines = flatten(box.blocks);
      if (!lines.length) continue;
      const st = dominantStyle(lines, { ...DEFAULT_STYLES.greeting, spacing: 1 });
      const own = lines.map((b) => applyLook(runsAgainst(b, st).filter((run) => run.text), {}));
      const text = own.map(runsText).join('\n');
      if (!text.trim()) continue;
      const first = lines[0];
      const line = first.props.lineRule === 'exact' && first.props.line ? first.props.line / 20 : Math.round(st.size * 3) / 2;
      const ltr = !first.bidi;
      const plain = own.length === 1 && own[0].length === 1 && Object.keys(own[0][0]).length === 1;
      const wraps = lines.length > 1 || first.jc === 'both' || first.jc === 'center';
      frames.push({
        id: uid(),
        kind: 'text',
        anchor: 'page',
        page,
        exact: true,
        x: box.x,
        y: box.fromFlow ? doc.geom.top + box.y : box.y,
        w: box.w,
        h: (line * lines.length) * MM_PER_PT,
        text,
        ...(wraps && { flow: true }),
        style: { font: st.font, size: st.size, bold: st.bold, line, ...(wraps ? { align: visualAlign(first) } : ltr && { align: 'left' }), ...(ltr && { dir: 'ltr' }) },
        ...(plain ? null : { lines: own }),
        ...(lines.length === 1 && { gaps: gapsOfLine(first, text) }),
        ...(box.fill && { fill: box.fill }),
      });
    }
  });
  L.objects = [...pictures, ...frames];
  setPlacedPages(L, page + 1);
  L.importInfo.warnings = [...doc.warnings];
  return L;
}

export function letterFromDocument(doc, settings) {
  if (isExactWord(doc)) return letterFromExactWord(doc, settings);
  const L = newLetter(settings);
  if (doc.page) L.page = doc.page;
  usePageSize(L);
  L.styles = {};
  L.offsets = {};
  L.objects = [];
  L.signer = { name: '', title: '' };
  L.recipient = { name: '', title: '' };
  L.imported = true;
  L.greetingEdited = true;
  L.closingEdited = true;
  L.attachmentManual = true;
  L.bodyDirty = true;

  const lh = { logo: null, logoAspect: 1, logoH: 18, org: [], invocation: '', footer: '', parts: {} };
  L.letterhead = lh;
  const found = { meta: new Set(), rule: false };
  const placed = lh.parts;
  const textBoxes = [];
  const extraFloats = [];
  const headGroups = { org: [], invocation: [], meta: [] };
  let waitingMeta = null;

  const setMeta = (meta, box) => {
    for (const [key, value] of Object.entries(meta)) {
      found.meta.add(key);
      if (key === 'date') {
        if (value) L.date = value;
      } else L[key] = value || (key === 'attachment' ? 'ندارد' : '');
      if (box) placed[key] = { x: box.x, y: box.y, w: box.w };
    }
  };

  const takeLogo = (image, id, box) => {
    if (lh.logo) return false;
    lh.logo = id;
    lh.logoAspect = image.w / (image.h || image.w) || 1;
    lh.logoH = image.h || 18;
    if (box) placed.logo = { x: box.x, y: box.y, w: image.w };
    return true;
  };

  /** One line from the letterhead area: it goes to the matching part, or counts as the organisation's name. */
  const takeHeadLine = (block, box, inHeader = false) => {
    for (const r of block.runs) if (r.imageId && !takeLogo(r.image, r.imageId, box)) extraFloats.push({ id: r.imageId, image: r.image, x: PAGE.left, y: PAGE.headerTop });
    for (const f of block.floats) {
      if (!f.id) continue;
      // Inside a header, "from the paragraph" means from the top of the header.
      const place = { x: f.x, y: f.fromFlow ? doc.geom.header + f.y : f.y };
      if (!takeLogo(f.image, f.id, place)) extraFloats.push({ ...f, ...place });
    }
    for (const line of block.lines) {
      found.rule = true;
      placed.rule = { x: line.x, y: line.fromFlow ? doc.geom.header + line.y : line.y, w: line.w };
    }
    if (block.props.bottomBorder) found.rule = true;
    for (const inner of block.boxes) readBox(inner, inHeader);
    const text = clean(textOf(block));
    if (!text || block.hasPageField) return;
    const meta = parseMeta(textOf(block));
    if (meta) {
      headGroups.meta.push(block);
      setMeta(meta, box);
      // A table may hold the label in one cell and its value in the next.
      const keys = Object.keys(meta);
      waitingMeta = keys.length === 1 && !meta[keys[0]] ? keys[0] : null;
    } else if (isInvocation(text)) {
      headGroups.invocation.push(block);
      lh.invocation = text;
      waitingMeta = null;
      if (box) placed.invocation = { x: box.x, y: box.y, w: box.w };
    } else if (waitingMeta && text.length < 30 && (/[0-9۰-۹]/.test(text) || /^(دارد|ندارد)/.test(text))) {
      if (waitingMeta === 'date') L.date = text;
      else L[waitingMeta] = text;
      waitingMeta = null;
    } else {
      headGroups.org.push(block);
      lh.org.push(text);
      waitingMeta = null;
      if (box && !placed.org) placed.org = { x: box.x, y: box.y, w: box.w };
    }
  };

  function readBox(box, inHeader) {
    const lines = flatten(box.blocks);
    // "From the paragraph" is measured from wherever its paragraph lands; these boxes sit at the top of the page.
    const y0 = box.fromFlow ? (inHeader ? doc.geom.header : doc.geom.top) + box.y : box.y;
    const known = lines.some((b) => parseMeta(textOf(b)) || isInvocation(textOf(b)));
    if (known || inHeader) {
      lines.forEach((b, i) => takeHeadLine(b, { x: box.x, y: y0 + i * ((box.h || 0) / lines.length), w: box.w }, inHeader));
    } else textBoxes.push(box);
  }

  /* Letterhead: the Word header, then anything at the very top of the page that clearly belongs to it. */
  for (const b of flatten(doc.header)) takeHeadLine(b, undefined, true);
  for (const t of doc.header) if (t.kind === 'table' && t.hasBottom) found.rule = true;
  const addFooter = (text) => {
    lh.footer = lh.footer ? `${lh.footer} - ${text}` : text;
  };
  const footerLines = flatten(doc.footer).flatMap((b) => [b, ...b.boxes.flatMap((box) => flatten(box.blocks))]);
  for (const b of footerLines) if (clean(textOf(b)) && !b.hasPageField) addFooter(clean(textOf(b)));
  lh.footerLine = footerLines.some((b) => b.props.topBorder || b.lines.length);
  lh.pageNumbers = [...footerLines, ...flatten(doc.header)].some((b) => b.hasPageField);

  const blocks = [...doc.body];
  let start = 0;
  const looksHead = (b) => {
    if (b.kind === 'table') return flatten([b]).some((p) => parseMeta(textOf(p)) || isInvocation(textOf(p)));
    return !!parseMeta(textOf(b)) || isInvocation(textOf(b));
  };
  while (start < blocks.length) {
    const b = blocks[start];
    if (isEmpty(b)) {
      start++;
      continue;
    }
    const headAhead = blocks.slice(start, start + 5).some(looksHead);
    if (!looksHead(b) && !(headAhead && b.kind === 'p' && textOf(b).length < 70)) break;
    if (b.kind === 'table' && b.hasBottom) found.rule = true;
    for (const p of flatten([b])) takeHeadLine(p);
    start++;
  }
  // Boxes and floating pictures anywhere on the first page may hold letterhead too.
  const rest = blocks.slice(start);
  for (const b of flatten(rest)) {
    for (const box of b.boxes) readBox(box, false);
    b.boxes = [];
  }

  /* Recipient, subject and greeting at the top of the text. */
  const isP = (b) => b.kind === 'p';
  const hasText = (b) => isP(b) && !!plain(textOf(b));
  const texts = rest.map((b) => (isP(b) ? clean(textOf(b)) : ''));
  const keys = texts.map(plain);
  const opening = rest.slice(0, 16);
  const subjectAt = opening.findIndex((b, i) => isP(b) && SUBJECT.test(keys[i]));
  const greetingAt = opening.findIndex((b, i) => isP(b) && GREETING.test(keys[i]) && texts[i].length < 70);
  let cursor = 0;
  const recipientLines = [];
  const stop = [subjectAt, greetingAt].filter((i) => i >= 0);
  const addressLines = (from, to) => {
    const zone = rest.slice(from, to).filter(hasText);
    return zone.length <= 5 && rest.slice(from, to).every((b) => isP(b)) && zone.every((b) => textOf(b).length < 110) ? zone : null;
  };
  if (stop.length) {
    const end = Math.min(...stop);
    const zone = addressLines(0, end);
    if (zone) {
      recipientLines.push(...zone);
      cursor = end;
    }
  }
  const consumed = new Map();
  const takeAt = (i) => {
    cursor = Math.max(cursor, i + 1);
  };
  if (subjectAt >= cursor) {
    L.subject = texts[subjectAt].replace(/^موضوع\s*[:：]\s*/, '');
    consumed.set(rest[subjectAt], 'subject');
    takeAt(subjectAt);
  }
  // A recipient can also sit between the subject and the greeting.
  if (!recipientLines.length && subjectAt >= 0 && greetingAt > subjectAt) {
    const zone = addressLines(subjectAt + 1, greetingAt);
    if (zone?.length) {
      recipientLines.push(...zone);
      takeAt(greetingAt - 1);
    }
  }
  if (greetingAt >= cursor) {
    L.greeting = texts[greetingAt];
    consumed.set(rest[greetingAt], 'greeting');
    takeAt(greetingAt);
  }
  if (recipientLines.length) {
    const lines = recipientLines.map((b) => clean(textOf(b)));
    L.recipient = { name: lines[0], title: lines.slice(1).join(' ') };
    recipientLines.forEach((b) => consumed.set(b, 'recipient'));
  }

  /* The end of the letter: copies, the signature block and the closing line. */
  let tail = rest.length;
  const firstCc = rest.findIndex((b, i) => i >= cursor && isP(b) && CC.test(keys[i]));
  const ccLines = [];
  const ccBlocks = [];
  if (firstCc >= 0) {
    for (let i = firstCc; i < rest.length; i++) {
      if (!isP(rest[i]) || !texts[i]) continue;
      ccLines.push(i === firstCc ? texts[i].replace(/^رونوشت\s*[:：]?\s*/, '') : texts[i]);
      ccBlocks.push(rest[i]);
      consumed.set(rest[i], 'cc');
    }
    tail = firstCc;
  }
  L.cc = ccLines.filter(Boolean).join('\n');

  const signBlocks = [];
  let i = tail - 1;
  for (; i >= cursor; i--) {
    const b = rest[i];
    if (isEmpty(b)) continue;
    if (!isP(b)) break;
    const raw = textOf(b);
    const t = texts[i];
    const pushedAside = /^[\t ]{2,}/.test(raw) || (b.props.indStart || 0) > 1500 || (b.props.indEnd || 0) > 1500;
    const align = visualAlign(b);
    const looksSign = t.length <= 60 && !/[.؟:،؛]$/.test(t) && !CLOSING.test(keys[i]) && (align === 'center' || align === 'left' || pushedAside);
    const picture = !t && (b.runs.some((r) => r.imageId) || b.floats.length);
    if (signBlocks.length >= 3 || (!looksSign && !picture)) break;
    signBlocks.unshift(b);
  }
  const signFrom = i + 1;
  const texted = signBlocks.filter(hasText);
  const signTexts = texted.map((b) => clean(textOf(b)));
  if (signTexts.length) L.signer = { name: signTexts[0], title: signTexts.slice(1).join(' ') };

  const hasSignPicture = signBlocks.some((b) => b.runs.some((r) => r.imageId) || b.floats.some((f) => f.id));
  let bodyEnd = signTexts.length || hasSignPicture ? signFrom : tail;
  for (let j = bodyEnd - 1; j >= cursor; j--) {
    if (isEmpty(rest[j])) continue;
    if (isP(rest[j]) && texts[j].length <= 110 && CLOSING.test(keys[j])) {
      L.closing = texts[j];
      consumed.set(rest[j], 'closing');
      bodyEnd = j;
    }
    break;
  }

  const bodySource = rest.slice(cursor, bodyEnd);
  while (bodySource.length && isEmpty(bodySource[0])) bodySource.shift();
  while (bodySource.length && isEmpty(bodySource[bodySource.length - 1])) bodySource.pop();

  /* Styles: each part takes the look it had in the file. */
  const blocksOf = (section) => [...consumed].filter(([, s]) => s === section).map(([b]) => b);
  const styleFor = (role, group) => {
    if (group?.length) L.styles[role] = dominantStyle(group, { ...DEFAULT_STYLES[role] });
  };
  for (const section of ['recipient', 'subject', 'greeting', 'closing', 'cc']) styleFor(section, blocksOf(section));
  styleFor('org', headGroups.org);
  styleFor('invocation', headGroups.invocation);
  styleFor('meta', headGroups.meta);
  // The letterhead's own spacing belongs to the Word layout it came from, not to separate frames.
  for (const role of ['org', 'invocation', 'meta']) if (L.styles[role]) Object.assign(L.styles[role], { before: 0, after: 0, spacing: 1 });
  if (texted.length) {
    styleFor('signName', texted.slice(0, 1));
    styleFor('signTitle', texted.slice(1));
    // The signature column keeps the place its text had on the page.
    const first = texted[0];
    const align = visualAlign(first);
    if (align === 'center') {
      const toMm = (v) => (v || 0) * MM_PER_TWIP;
      const width = PAGE.w - doc.geom.left - doc.geom.right;
      const centre = doc.geom.left + toMm(first.props.indEnd) + (width - toMm(first.props.indStart) - toMm(first.props.indEnd)) / 2;
      L.offsets.sign = { dx: centre - (doc.geom.left + SIGN.col / 2), dy: 0 };
    }
    for (const role of ['signName', 'signTitle']) {
      if (L.styles[role]) Object.assign(L.styles[role], { align: align === 'left' ? 'left' : 'center', before: 0, after: 0 });
    }
  }
  const bodyParas = bodySource.filter(isP);
  styleFor('body', bodyParas.length ? bodyParas : null);
  const tables = bodySource.filter((b) => !isP(b));
  styleFor('table', tables.length ? tables.flatMap((t) => flatten([t])) : null);
  // Word tables have no space of their own around them; their cells hold their spacing.
  if (L.styles.table) Object.assign(L.styles.table, { before: 0, after: 0 });
  const bodySt = { ...DEFAULT_STYLES.body, ...L.styles.body };
  const tableSt = { ...DEFAULT_STYLES.table, ...L.styles.table };

  const textWidthTw = (PAGE.w - doc.geom.left - doc.geom.right) / MM_PER_TWIP;
  const bodyBlocks = bodySource.map((b) => (isP(b) ? bodyParagraph(b, bodySt) : bodyTable(b, tableSt, textWidthTw)));
  L.bodyHtml = blocksToHtml(bodyBlocks);
  const holder = document.createElement('div');
  holder.innerHTML = L.bodyHtml;
  L.body = serializeEditor(holder);

  /* Letterhead parts that the file does not have stay hidden, so the letter looks as it did. */
  for (const id of ['number', 'date', 'attachment']) {
    if (!found.meta.has(id)) placed[id] = { hidden: true };
  }
  if (!found.rule) placed.rule = { ...placed.rule, hidden: true };
  const hasHead = !!(lh.logo || lh.org.length || lh.invocation || found.meta.size);

  /* Page margins. Text must clear any letterhead part left in its default place. */
  const present = { logo: !!lh.logo, org: !!lh.org.length, invocation: !!lh.invocation, number: true, date: true, attachment: true, rule: found.rule };
  const headInDefaultPlace = Object.keys(present).some((id) => present[id] && !(placed[id]?.hidden || placed[id]?.y !== undefined));
  const ruleY = headerParts(L).find((p) => p.id === 'rule').y;
  L.geom = {
    top: headInDefaultPlace ? Math.max(doc.geom.top, ruleY + 3) : doc.geom.top,
    right: doc.geom.right,
    bottom: doc.geom.bottom,
    left: doc.geom.left,
  };

  /* The blank space between the parts of the letter, so they sit as far apart as they did in the file. */
  const blankHeight = (b) => (b.markSize || 11) * lineRatio(b.markFont, false) * (lineSpacing(b.props, b.markSize || 11) ?? 1) + (b.props.before || 0) / 20 + (b.props.after || 0) / 20;
  const isSignPicture = (b) => signBlocks.includes(b) && !hasText(b);
  const gapAbove = (block) => {
    let gap = (block.props?.before || 0) / 20;
    let j = rest.indexOf(block) - 1;
    for (; j >= 0 && (isEmpty(rest[j]) || isSignPicture(rest[j])); j--) {
      const picture = rest[j].runs.find((r) => r.imageId);
      gap += picture ? picture.image.h / MM_PER_PT : blankHeight(rest[j]);
    }
    if (j >= 0 && isP(rest[j])) gap += (rest[j].props.after || 0) / 20;
    return gap;
  };
  const flowBefore = buildFlow(L);
  const firsts = [
    ['recipient', recipientLines[0]],
    ['subject', blocksOf('subject')[0]],
    ['greeting', blocksOf('greeting')[0]],
    ['body', bodySource[0]],
    ['closing', blocksOf('closing')[0]],
    ['sign', texted[0]],
    ['cc', ccBlocks[0]],
  ];
  for (const [section, block] of firsts) {
    if (!block) continue;
    const k = flowBefore.findIndex((b) => (b.group || b.section) === section);
    if (k < 0) continue;
    const previous = flowBefore[k - 1];
    const prevAfter = previous && previous.kind !== 'sign' ? blockStyle(L, previous).after : 0;
    const dyPt = gapAbove(block) - prevAfter - baseBefore(L, flowBefore[k]);
    if (Math.abs(dyPt) > 0.5) L.offsets[section] = { ...L.offsets[section], dx: L.offsets[section]?.dx || 0, dy: dyPt * MM_PER_PT };
  }

  /* Pictures and frames that float go where the file put them, once the text's layout is known. */
  const signDx = L.offsets.sign?.dx || 0;
  const signPictures = [];
  for (const b of signBlocks) {
    for (const r of b.runs) {
      if (!r.imageId) continue;
      const aspect = r.image.w / (r.image.h || r.image.w) || 1;
      signPictures.push({ id: uid(), kind: 'signature', anchor: 'sign', mediaId: r.imageId, aspect, x: PAGE.left + signDx + (SIGN.col - r.image.w) / 2, dy: SIGN.gap - r.image.h, w: r.image.w });
    }
    for (const f of b.floats) {
      if (!f.id) continue;
      const aspect = f.image.w / (f.image.h || f.image.w) || 1;
      signPictures.push({ id: uid(), kind: 'signature', anchor: 'sign', mediaId: f.id, aspect, x: f.x, dy: 0, w: f.image.w, ...(f.image.rotate && { rotate: f.image.rotate }), source: f, from: b });
    }
  }
  L.objects.push(...signPictures);

  const info = layoutLetter(L);
  const geom = geomOf(L);
  const flow = buildFlow(L);
  const firstBodyFlow = flow.findIndex((b) => b.group === 'body');
  const flowOf = (block) => {
    const section = consumed.get(block);
    if (section) return flow.findIndex((b) => b.section === section);
    const k = bodySource.indexOf(block);
    return k >= 0 && firstBodyFlow >= 0 ? firstBodyFlow + k : -1;
  };
  const placeOf = (block, item) => {
    const pos = info.flowPos[flowOf(block)];
    return { page: pos?.page || 0, y: item.fromFlow ? geom.top + (pos?.y || 0) + item.y : item.y };
  };
  const addPicture = (block, f) => {
    const { page, y } = placeOf(block, f);
    L.objects.push({ id: uid(), kind: 'image', anchor: 'page', page, mediaId: f.id, aspect: f.image.w / (f.image.h || f.image.w) || 1, x: f.x, y, w: f.image.w, ...(f.behind && { behind: true }), ...(f.image.rotate && { rotate: f.image.rotate }) });
  };
  for (const b of rest) {
    if (signBlocks.includes(b)) continue;
    for (const p of flatten([b])) {
      for (const f of p.floats) if (f.id) addPicture(b, f);
      // A picture inside a line whose text became a field (recipient, subject...) is kept as a floating one.
      if (consumed.has(b)) for (const r of p.runs) if (r.imageId) addPicture(b, { id: r.imageId, image: r.image, x: doc.geom.left, y: 0, fromFlow: true });
    }
  }
  for (const f of extraFloats) {
    L.objects.push({ id: uid(), kind: 'image', anchor: 'page', page: 0, mediaId: f.id, aspect: f.image.w / (f.image.h || f.image.w) || 1, x: f.x, y: f.y, w: f.image.w, ...(f.image.rotate && { rotate: f.image.rotate }) });
  }
  for (const box of textBoxes) {
    const lines = flatten(box.blocks);
    const text = lines.map((b) => textOf(b).trim()).join('\n').trim();
    if (!text) continue;
    const st = dominantStyle(lines, { ...DEFAULT_STYLES.greeting, spacing: 1 });
    // Words with a look of their own keep it.
    const own = lines.map((b) => runsAgainst(b, st).filter((run) => run.text));
    const hasOwn = own.some((runs) => runs.some((run) => run.font || run.size || run.b !== undefined || run.color || run.u));
    const sameText = own.map((runs) => runs.map((run) => run.text).join('')).join('\n') === text;
    L.objects.push({ id: uid(), kind: 'text', anchor: 'page', page: 0, x: box.x, y: box.fromFlow ? geom.top + box.y : box.y, w: Math.max(box.w, 20), text, ...(hasOwn && sameText && { lines: own }), ...(box.fill && { fill: box.fill }), border: !!box.border, style: { font: st.font, size: st.size, bold: st.bold, align: st.align, spacing: st.spacing } });
  }
  // A floating signature stays beside the name it was anchored to, wherever the name lands.
  const signY = geom.top + info.signTop + info.signDy;
  for (const o of signPictures) {
    if (!o.source) continue;
    const { source, from } = o;
    const fromText = (from.props.before || 0) / 20;
    o.dy = source.fromFlow ? SIGN.gap + source.y - fromText * MM_PER_PT : source.y - signY;
    delete o.source;
    delete o.from;
  }

  L.importInfo = {
    warnings: [...doc.warnings],
    recognized: { recipient: !!recipientLines.length, subject: !!L.subject, greeting: !!L.greeting, closing: !!L.closing, signer: !!signTexts.length, cc: !!L.cc, head: hasHead },
  };
  // A form saved as Word and opened again is still a form, and its words stay as they are.
  const isForm = L.body.some((b) => b.kind === 'table' && b.pad !== undefined) && !Object.values(L.importInfo.recognized).some(Boolean);
  if (isForm) {
    L.autoFix = false;
    L.importInfo.form = true;
  }
  return L;
}
