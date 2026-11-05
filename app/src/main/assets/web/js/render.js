// Turns a letter into real A4 page elements. The same elements are shown on screen
// (scaled) and printed to PDF, so the preview is exactly what comes out.

import { MM_PER_PT, PAGE, SIGN, TEXT_STYLE, blockStyle, buildFlow, frameLines, geomOf, headerParts, lineRatio, partLines, partStyle, runsWithGaps, showsPageNumbers, spaceBefore, styleOf, usePageSize } from './model.js';
import { inkMarkup, inkOf, loadInkFonts } from './ink.js';
import { mediaUrl } from './store.js';
import { h } from './util.js';
import { normalizeText } from './text.js';

export const MM = 96 / 25.4;
export const PAGE_PX = {
  get w() {
    return PAGE.w * MM;
  },
  get h() {
    return PAGE.h * MM;
  },
};

// A font this device does not have gives way to the closest one the app carries.
const closestFont = (font) => (/titr|koodak|black|heavy/i.test(font) ? 'B Titr' : /lotus|mitra|roya|badr|yagut/i.test(font) ? 'B Lotus' : /zar/i.test(font) ? 'B Zar' : 'B Nazanin');
const fontStack = (font) => `"${font}","${closestFont(font)}","B Nazanin","Tinos","Vazirmatn",serif`;

function appendText(parent, text, preview) {
  if (!preview || !text.includes('[')) {
    parent.append(text);
    return;
  }
  let i = 0;
  for (const m of text.matchAll(/\[[^\]\n]+\]/g)) {
    if (m.index > i) parent.append(text.slice(i, m.index));
    parent.append(h('mark', { class: 'ph-mark' }, m[0]));
    i = m.index + m[0].length;
  }
  if (i < text.length) parent.append(text.slice(i));
}

function fillRuns(el, runs, st, preview) {
  let any = false;
  for (const run of runs || []) {
    if (run.img) {
      any = true;
      el.append(h('img', { class: 'inline-img', src: mediaUrl(run.img.id), alt: '', draggable: 'false', style: { width: `${run.img.w}mm`, height: `${run.img.w / (run.img.aspect || 1)}mm` } }));
      continue;
    }
    if (!run.text) continue;
    any = true;
    const span = h('span');
    const bold = run.b === undefined ? st.bold : run.b;
    if (bold !== st.bold) span.style.fontWeight = bold ? 700 : 400;
    if (run.font) span.style.fontFamily = fontStack(run.font);
    if (run.size) span.style.fontSize = `${run.size}pt`;
    if (run.sp) span.style.letterSpacing = `${run.sp}pt`;
    // A line of a fixed height stays that height whatever its words are set in.
    if (!st.line && (bold !== st.bold || run.font)) span.style.lineHeight = String(lineRatio(run.font || st.font, bold) * st.spacing);
    if (st.line && (run.font || (run.size || st.size) !== (st.lineSize ?? st.size))) span.style.lineHeight = '0';
    if (run.u ?? st.underline) span.style.textDecoration = 'underline';
    if (run.i) span.style.fontStyle = 'italic';
    const color = run.color || st.color;
    if (color) span.style.color = `#${color}`;
    appendText(span, run.text, preview);
    el.append(span);
  }
  if (!any) el.append(h('br'));
}

/** A line's height: fixed in points when set, otherwise a multiple of what the font itself needs. */
const lineHeightCss = (st) => (st.line ? `${st.line}pt` : String(lineRatio(st.font, st.bold) * st.spacing));

function placeMoved(el, block) {
  if (block.dx) el.style.left = `${block.dx}mm`;
  if (block.fy) {
    el.style.top = `${block.fy}mm`;
    el.classList.add('moved');
  }
}

function paragraphEl(block, L, preview) {
  const st = blockStyle(L, block);
  const align = block.align || st.align;
  const el = h('div', { class: 'blk p', dataset: { role: block.role, ...(block.section && { section: block.section }), ...(block.group && { group: block.group }) } });
  Object.assign(el.style, {
    fontFamily: fontStack(st.font),
    fontSize: `${st.size}pt`,
    fontWeight: st.bold ? 700 : 400,
    textAlign: align,
    lineHeight: lineHeightCss(st),
    paddingTop: `${spaceBefore(L, block)}pt`,
    paddingBottom: `${st.after}pt`,
  });
  placeMoved(el, block);
  if (block.indent) {
    // Margins, not padding: Word indents can be negative and reach into the page margin.
    el.style.marginRight = `${block.indent.start || 0}mm`;
    el.style.marginLeft = `${block.indent.end || 0}mm`;
    if (block.indent.first) el.style.textIndent = `${block.indent.first}mm`;
  }
  if (block.splitHead) {
    el.style.paddingBottom = '0';
    if (align === 'justify') el.style.textAlignLast = 'justify';
  }
  if (block.splitTail) el.style.paddingTop = '0';
  fillRuns(el, block.runs, st, preview);
  return el;
}

const VALIGN = { top: 'top', center: 'middle', bottom: 'bottom' };

/** One side of a cell's border: its width in points, negative for a double line, 0 for none. */
const cellEdge = (w) => (w ? `${Math.abs(w)}pt ${w < 0 ? 'double' : 'solid'} #000` : 'none');

function tableEl(block, L, preview) {
  const st = styleOf(L, 'table');
  const wrap = h('div', { class: `blk tbl-wrap${block.borderless ? ' no-border' : ''}`, dataset: { role: 'table', section: block.section, group: 'body' } });
  Object.assign(wrap.style, {
    fontFamily: fontStack(st.font),
    fontSize: `${st.size}pt`,
    lineHeight: String(lineRatio(st.font, st.bold) * st.spacing),
    paddingTop: `${spaceBefore(L, block)}pt`,
    paddingBottom: `${st.after}pt`,
  });
  placeMoved(wrap, block);
  const table = h('table');
  if (block.widthPct) {
    table.style.width = `${block.widthPct}%`;
    table.style.marginRight = block.tableAlign === 'right' || !block.tableAlign ? '0' : 'auto';
    table.style.marginLeft = block.tableAlign === 'left' ? '0' : 'auto';
  }
  if (block.widths) table.append(h('colgroup', null, block.widths.map((w) => h('col', { style: { width: `${w}%` } }))));
  block.rows.forEach((row, r) => {
    const tr = h('tr');
    row.forEach((cell, c) => {
      // Where this cell is in the letter: a table cut over two pages shows only some of its rows here.
      const td = h('td', { colspan: cell.colSpan > 1 ? cell.colSpan : null, rowspan: cell.rowSpan > 1 ? cell.rowSpan : null, dataset: { r: block.rowMap?.[r] ?? r, c } });
      if (cell.bg) td.style.background = `#${cell.bg}`;
      if (cell.vAlign) td.style.verticalAlign = VALIGN[cell.vAlign] || 'middle';
      if (cell.rowH) td.style.height = `${cell.rowH}mm`;
      if (block.pad !== undefined) td.style.padding = `0 ${block.pad}mm`;
      if (cell.borders) {
        const [top, right, bottom, left] = cell.borders;
        Object.assign(td.style, { borderTop: cellEdge(top), borderRight: cellEdge(right), borderBottom: cellEdge(bottom), borderLeft: cellEdge(left) });
      }
      const cellStyle = { ...st, bold: st.bold || (block.header && r === 0) };
      cell.paras.forEach((p) => {
        const d = h('div', { class: 'cell-p' });
        d.style.textAlign = p.align || st.align;
        if (cellStyle.bold) d.style.fontWeight = 700;
        if (p.over?.before) d.style.paddingTop = `${p.over.before}pt`;
        if (p.over?.after) d.style.paddingBottom = `${p.over.after}pt`;
        if (p.over?.spacing) d.style.lineHeight = String(lineRatio(st.font, st.bold) * p.over.spacing);
        let { runs } = p;
        let lineSize;
        if (p.over?.line) {
          d.style.lineHeight = `${p.over.line}pt`;
          // Letters bigger than their paragraph's own size would push a line of fixed height taller.
          const sizes = (p.runs || []).map((run) => run.size || st.size);
          if (sizes.length) {
            lineSize = Math.max(...sizes);
            d.style.fontSize = `${lineSize}pt`;
            // The other words of the line keep their own size.
            runs = p.runs.map((run) => (run.text && !run.size ? { ...run, size: st.size } : run));
          }
        }
        if (p.indent?.start) d.style.marginRight = `${p.indent.start}mm`;
        if (p.indent?.end) d.style.marginLeft = `${p.indent.end}mm`;
        fillRuns(d, runs, { ...cellStyle, line: p.over?.line, lineSize }, preview);
        td.append(d);
      });
      tr.append(td);
    });
    table.append(tr);
  });
  wrap.append(table);
  return wrap;
}

function signEl(block, L, preview) {
  const col = h('div', { class: 'sign-col', style: { width: `${SIGN.col}mm`, marginRight: `calc(100% - ${SIGN.col}mm)` } });
  if (block.name) col.append(paragraphEl({ role: 'signName', runs: [{ text: block.name }] }, L, preview));
  if (block.title) col.append(paragraphEl({ role: 'signTitle', runs: [{ text: block.title }] }, L, preview));
  const el = h('div', { class: 'blk sign', dataset: { section: 'sign' }, style: { paddingTop: `${spaceBefore(L, block)}pt` } }, col);
  placeMoved(el, block);
  return el;
}

function renderBlock(block, L, preview) {
  if (block.kind === 'table') return tableEl(block, L, preview);
  if (block.kind === 'sign') return signEl(block, L, preview);
  return paragraphEl(block, L, preview);
}

function splitRuns(runs, cut) {
  const head = [];
  const tail = [];
  let pos = 0;
  for (const run of runs) {
    if (run.img) {
      (pos <= cut ? head : tail).push(run);
      continue;
    }
    if (!run.text) continue;
    const end = pos + run.text.length;
    if (end <= cut) head.push(run);
    else if (pos >= cut) tail.push(run);
    else {
      head.push({ ...run, text: run.text.slice(0, cut - pos) });
      tail.push({ ...run, text: run.text.slice(cut - pos) });
    }
    pos = end;
  }
  return [head, tail];
}

/** Splits a paragraph at a line break so at least two lines stay on each side, as Word does. */
function splitParagraph(block, el, avail) {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight);
  const padTop = parseFloat(cs.paddingTop);
  const padBottom = parseFloat(cs.paddingBottom);
  const rect = el.getBoundingClientRect();
  const lines = Math.round((rect.height - padTop - padBottom) / lh);
  if (!lh || lines < 4) return null;
  const headLines = Math.min(Math.floor((avail - padTop) / lh), lines - 2);
  if (headLines < 2) return null;

  const nodes = [];
  let total = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    nodes.push({ node: walker.currentNode, start: total });
    total += walker.currentNode.length;
  }
  const range = document.createRange();
  const nodeAt = (offset) => {
    let found = nodes[0];
    for (const n of nodes) {
      if (n.start > offset) break;
      found = n;
    }
    return found;
  };
  const midY = (offset) => {
    for (let o = offset; o < total; o++) {
      const n = nodeAt(o);
      range.setStart(n.node, o - n.start);
      range.setEnd(n.node, o - n.start + 1);
      const r = range.getClientRects()[0];
      if (r && r.height) return r.top + r.height / 2;
    }
    return Infinity;
  };
  const boundary = rect.top + padTop + headLines * lh;
  let lo = 0;
  let hi = total - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (midY(mid) < boundary) lo = mid;
    else hi = mid;
  }
  const [headRuns, tailRuns] = splitRuns(block.runs, hi);
  if (!headRuns.length || !tailRuns.length) return null;
  return [
    { ...block, runs: headRuns, splitHead: true },
    { ...block, runs: tailRuns, splitTail: true, splitHead: false, dy: 0 },
  ];
}

function splitTable(block, el, avail) {
  const top = el.getBoundingClientRect().top;
  const trs = [...el.querySelectorAll('tr')];
  let fit = 0;
  for (const tr of trs) {
    if (tr.getBoundingClientRect().bottom - top > avail) break;
    fit++;
  }
  const minimum = block.header ? 2 : 1;
  // A merged cell stays in one piece, with the rows it covers on one page. Only one taller than a page has to be cut.
  const crossed = (at) => block.rows.some((row, r) => r < at && row.some((cell) => r + (cell.rowSpan || 1) > at));
  let whole = fit;
  while (whole > 0 && crossed(whole)) whole--;
  if (whole >= minimum) fit = whole;
  if (fit < minimum || fit >= trs.length) return null;
  const headRows = block.rows.slice(0, fit);
  const rest = block.rows.slice(fit);
  const map = block.rowMap || block.rows.map((_, r) => r);
  const restMap = map.slice(fit);
  return [
    { ...block, rows: headRows, rowMap: map.slice(0, fit) },
    { ...block, rows: block.header ? [block.rows[0], ...rest] : rest, rowMap: block.header ? [map[0], ...restMap] : restMap, dy: 0 },
  ];
}

function splitBlock(block, el, avail) {
  // A block placed freely stays in one piece, in one place on one page.
  if (block.fy) return null;
  if (block.kind === 'p') return splitParagraph(block, el, avail);
  if (block.kind === 'table') return splitTable(block, el, avail);
  return null;
}

function linesEl(el, lines, st) {
  for (const runs of lines) {
    const line = h('div');
    fillRuns(line, runs, st, false);
    el.append(line);
  }
}

function partEl(L, part, index, total) {
  const place = { left: `${part.x}mm`, top: `${part.y}mm`, width: `${part.w}mm` };
  if (part.id === 'logo') {
    const lh = L.letterhead;
    return h(
      'div',
      { class: 'hd-part hd-logo', dataset: { part: part.id }, style: { ...place, height: `${part.w / (lh.logoAspect || 1)}mm` } },
      h('img', { src: mediaUrl(lh.logo), alt: '', draggable: 'false' }),
    );
  }
  if (part.id === 'rule') return h('div', { class: 'hd-part hd-rule', dataset: { part: part.id }, style: place });

  const st = partStyle(L, part);
  const isFooter = part.id === 'footer';
  const el = h('div', { class: `hd-part${isFooter ? ` hd-footer${L.letterhead?.footerLine === false ? ' no-line' : ''}` : ''}`, dataset: { part: part.id, role: part.role }, style: place });
  Object.assign(el.style, {
    fontFamily: fontStack(st.font),
    fontSize: `${st.size}pt`,
    fontWeight: st.bold ? 700 : 400,
    textAlign: st.align,
    lineHeight: String(lineRatio(st.font, st.bold) * st.spacing),
  });
  const lines = partLines(L, part.id);
  if (isFooter) {
    if (L.letterhead?.footer) lines.push([{ text: normalizeText(L.letterhead.footer) }]);
    if (showsPageNumbers(L, total)) lines.push([{ text: normalizeText(`صفحهٔ ${index + 1} از ${total}`) }]);
  }
  linesEl(el, lines, st);
  return el;
}

function partsEl(L, index, total) {
  return h('div', { class: 'pg-parts' }, headerParts(L, total).filter((p) => !p.hidden).map((p) => partEl(L, p, index, total)));
}

export function objectBox(o, info) {
  const hgt = o.kind === 'text' ? o.h || 10 : o.w / (o.aspect || 1);
  if (o.anchor === 'sign') return { page: info.signPage, x: o.x, y: info.geom.top + info.signTop + (info.signDy || 0) + o.dy, w: o.w, h: hgt };
  return { page: Math.min(o.page || 0, info.total - 1), x: o.x, y: o.y, w: o.w, h: hgt };
}

let baselineRuler = null;

/** How far below the top of a line of fixed height this browser puts the baseline, in points. */
function baselineInBrowser(st) {
  baselineRuler = baselineRuler || document.createElement('canvas').getContext('2d');
  baselineRuler.font = `${st.bold ? 700 : 400} ${st.size}pt ${fontStack(st.font)}`;
  const m = baselineRuler.measureText('\u0627');
  const ascent = (m.fontBoundingBoxAscent || st.size) * 0.75;
  const descent = (m.fontBoundingBoxDescent || st.size * 0.3) * 0.75;
  return (st.line - (ascent + descent)) / 2 + ascent;
}

// Blanks are marked on the screen, and never in a file.
let markingBlanks = false;

/** A line taken exactly from a file: its own drawing while it is as it came, ordinary text once it has been changed. */
function exactFrameEl(o, place, L, st) {
  const el = h('div', { class: `obj obj-text obj-exact${o.flow ? ' obj-flow' : ''}`, dataset: { id: o.id }, style: o.flow ? place : { ...place, height: `${o.h}mm` } });
  if (o.fill) el.style.background = `#${o.fill}`;
  const rec = inkOf(L, o);
  if (rec) {
    el.classList.add('obj-inked');
    const text = h('div', { class: 'ink-text' });
    text.textContent = o.text;
    el.append(text);
    el.insertAdjacentHTML('beforeend', inkMarkup(L, o, rec));
    return el;
  }
  Object.assign(el.style, {
    fontFamily: fontStack(st.font),
    fontSize: `${st.size}pt`,
    fontWeight: st.bold ? 700 : 400,
    textAlign: st.align,
    lineHeight: `${st.line}pt`,
    ...(st.dir && { direction: st.dir }),
    ...(o.flow && st.align === 'justify' && { textAlignLast: st.dir === 'ltr' ? 'left' : 'right' }),
  });
  const shift = `${st.line * 0.8 - baselineInBrowser(st)}pt`;
  const lines = frameLines(o);
  const marked = markingBlanks && !!L.fields?.length;
  lines.forEach((runs) => {
    const line = h('div', { style: { position: 'relative', top: shift } });
    fillRuns(line, lines.length === 1 ? runsWithGaps(o, runs) : runs, st, marked);
    el.append(line);
  });
  return el;
}

function textObjectEl(o, place, L) {
  const st = { ...TEXT_STYLE, ...o.style };
  if (o.exact) return exactFrameEl(o, place, L, st);
  const el = h('div', { class: `obj obj-text${o.border ? ' framed' : ''}`, dataset: { id: o.id }, style: place });
  Object.assign(el.style, {
    fontFamily: fontStack(st.font),
    fontSize: `${st.size}pt`,
    fontWeight: st.bold ? 700 : 400,
    textAlign: st.align,
    lineHeight: lineHeightCss(st),
  });
  if (o.fill) el.style.background = `#${o.fill}`;
  // A form's words stay exactly as they are in its file.
  const fix = (text) => (L.autoFix === false ? text : normalizeText(text));
  for (const runs of frameLines(o)) {
    const line = h('div');
    fillRuns(line, runs.map((run) => (run.text ? { ...run, text: fix(run.text) } : run)), st, markingBlanks);
    el.append(line);
  }
  return el;
}

function objectEl(o, box, L) {
  const place = { left: `${box.x}mm`, top: `${box.y}mm`, width: `${box.w}mm` };
  if (o.kind === 'text') return textObjectEl(o, place, L);
  return h(
    'div',
    { class: `obj${o.exact ? ' obj-placed' : ''}`, dataset: { id: o.id }, style: { ...place, height: `${box.h}mm`, ...(o.rotate && { transform: `rotate(${o.rotate}deg)` }) } },
    h('img', { src: mediaUrl(o.mediaId), alt: '', draggable: 'false' }),
  );
}

/* ---------- Pages taken exactly from a file hold a thousand pieces, and a small change only touches one ---------- */

/** How tall a frame of wrapping text comes out, in millimetres. */
export function frameHeightMm(L, o) {
  const holder = measureHost();
  const el = objectEl(o, { x: 0, y: 0, w: o.w, h: o.h || 10 }, L);
  holder.append(el);
  const height = el.getBoundingClientRect().height / MM;
  el.remove();
  return height;
}

let placed = null;

const placedKey = (o, box, L) => JSON.stringify([box.x, box.y, box.w, box.h, o.kind, o.mediaId, o.mediaId && mediaUrl(o.mediaId) ? 1 : 0, o.rotate, o.fill, o.border, o.text, o.lines, o.style, o.gaps?.of, L.ink && mediaUrl(L.ink.id) ? 1 : 0]);

/** Puts these elements in this order under a parent, leaving alone those already in place. */
function syncChildren(parent, wanted) {
  let at = parent.firstChild;
  for (const el of wanted) {
    if (el === at) at = at.nextSibling;
    else parent.insertBefore(el, at);
  }
  while (at) {
    const next = at.nextSibling;
    at.remove();
    at = next;
  }
}

function placedPagesOf(L, info, pageBlocks, geom) {
  if (placed?.id !== L.id) placed = { id: L.id, pages: [], items: new Map() };
  const seen = new Set();
  const byPage = pageBlocks.map(() => []);
  for (const o of L.objects || []) {
    const box = objectBox(o, info);
    byPage[box.page]?.push({ o, box });
  }
  const elementOf = ({ o, box }) => {
    seen.add(o.id);
    const key = placedKey(o, box, L);
    let item = placed.items.get(o.id);
    if (!item || item.key !== key) {
      item = { key, el: objectEl(o, box, L) };
      placed.items.set(o.id, item);
    }
    // A drag that was given up may have left it elsewhere.
    item.el.style.left = `${box.x}mm`;
    item.el.style.top = `${box.y}mm`;
    return item.el;
  };
  const pages = pageBlocks.map((blocks, i) => {
    let entry = placed.pages[i];
    if (!entry) {
      entry = { under: h('div', { class: 'pg-under' }), parts: h('div'), body: h('div', { class: 'pg-body' }), objects: h('div', { class: 'pg-objects' }) };
      entry.page = h('div', { class: 'page', dataset: { page: i }, style: L.page ? { width: `${PAGE.w}mm`, height: `${PAGE.h}mm` } : null }, entry.under, entry.parts, entry.body, entry.objects);
      placed.pages[i] = entry;
    }
    const parts = partsEl(L, i, info.total);
    entry.parts.replaceWith(parts);
    entry.parts = parts;
    Object.assign(entry.body.style, { top: `${geom.top}mm`, right: `${geom.right}mm`, bottom: `${geom.bottom}mm`, left: `${geom.left}mm` });
    entry.body.replaceChildren(...blocks);
    syncChildren(entry.under, byPage[i].filter(({ o }) => o.behind).map(elementOf));
    syncChildren(entry.objects, byPage[i].filter(({ o }) => !o.behind).map(elementOf));
    return entry.page;
  });
  placed.pages.length = pageBlocks.length;
  for (const id of placed.items.keys()) if (!seen.has(id)) placed.items.delete(id);
  return pages;
}

let host = null;
function measureHost() {
  if (!host) {
    host = h('div', { class: 'measure-host' });
    document.body.append(h('div', { class: 'measure-clip', 'aria-hidden': 'true' }, host));
  }
  host.textContent = '';
  return host;
}

/** Lays the letter out on pages. Returns the page elements and where things landed. */
export function layoutLetter(L, { preview = false } = {}) {
  usePageSize(L);
  markingBlanks = preview;
  const flow = buildFlow(L);
  const geom = geomOf(L);
  const measure = measureHost();
  measure.style.width = `${geom.bodyW}mm`;
  const H = geom.bodyH * MM;
  const pageBlocks = [[]];
  // The first flow block that starts on each page, used to anchor page objects in the Word export.
  const pageAnchors = [0];
  const flowPos = [];
  let y = 0;
  let signPage = 0;
  let signTop = 0;

  const newPage = () => {
    pageBlocks.push([]);
    pageAnchors.push(null);
    y = 0;
  };

  flow.forEach((source, index) => {
    let block = source;
    let el = renderBlock(block, L, preview);
    measure.append(el);
    let height = el.getBoundingClientRect().height;
    if (block.pageBreak && (y > 0 || pageBlocks[pageBlocks.length - 1].length)) newPage();

    if (block.keepNext && y > 0) {
      let chain = height;
      for (let j = index + 1; j < flow.length; j++) {
        const next = renderBlock(flow[j], L, preview);
        measure.append(next);
        chain += next.getBoundingClientRect().height;
        next.remove();
        if (!flow[j].keepNext) break;
      }
      if (y + chain > H + 0.5 && chain <= H) newPage();
    }

    const place = () => {
      if (pageAnchors[pageAnchors.length - 1] === null && block === source) pageAnchors[pageAnchors.length - 1] = index;
      if (block === source) flowPos[index] = { page: pageBlocks.length - 1, y: y / MM, h: height / MM };
    };

    for (;;) {
      if (y + height <= H + 0.5 || (y === 0 && !splitBlock(block, el, H))) {
        place();
        if (block.kind === 'sign') {
          signPage = pageBlocks.length - 1;
          signTop = y / MM;
        }
        pageBlocks[pageBlocks.length - 1].push(el);
        y += height;
        return;
      }
      const parts = splitBlock(block, el, H - y);
      if (parts) {
        el.remove();
        const headEl = renderBlock(parts[0], L, preview);
        measure.append(headEl);
        place();
        pageBlocks[pageBlocks.length - 1].push(headEl);
        newPage();
        block = parts[1];
        el = renderBlock(block, L, preview);
        measure.append(el);
        height = el.getBoundingClientRect().height;
      } else {
        newPage();
      }
    }
  });

  // The PDF's own fonts may still be on their way; the page draws itself again when they arrive.
  if (L.ink) loadInkFonts(L);

  // A text frame is as tall as its text, which only the browser can tell. A line taken exactly from a file has its height already.
  for (const o of L.objects || []) {
    if (o.kind !== 'text') continue;
    if (o.exact && !o.flow) {
      o.h = String(o.text || '').split('\n').length * { ...TEXT_STYLE, ...o.style }.line * MM_PER_PT;
      continue;
    }
    const el = objectEl(o, { x: 0, y: 0, w: o.w }, L);
    measure.append(el);
    o.h = el.getBoundingClientRect().height / MM;
    el.remove();
  }

  const total = pageBlocks.length;
  const info = { total, signPage, signTop, signDy: (L.offsets?.sign?.dy || 0) + (L.offsets?.sign?.fy || 0), pageAnchors, flowPos, geom };
  // What is shown on the page screen is kept between changes. What goes to a file is always made afresh.
  const pages = preview && L.importInfo?.exact ? placedPagesOf(L, info, pageBlocks, geom) : pageBlocks.map((blocks, i) => {
    const onPage = (L.objects || []).map((o) => ({ o, box: objectBox(o, info) })).filter(({ box }) => box.page === i);
    const objects = onPage.filter(({ o }) => !o.behind).map(({ o, box }) => objectEl(o, box, L));
    const under = onPage.filter(({ o }) => o.behind).map(({ o, box }) => objectEl(o, box, L));
    return h(
      'div',
      { class: 'page', dataset: { page: i }, style: L.page ? { width: `${PAGE.w}mm`, height: `${PAGE.h}mm` } : null },
      h('div', { class: 'pg-under' }, under),
      partsEl(L, i, total),
      h('div', { class: 'pg-body', style: { top: `${geom.top}mm`, right: `${geom.right}mm`, bottom: `${geom.bottom}mm`, left: `${geom.left}mm` } }, blocks),
      h('div', { class: 'pg-objects' }, objects),
    );
  });
  measure.textContent = '';
  return { ...info, pages };
}
