// Working on pages whose pieces all stand where a file had them (a PDF opened exactly, or a scan): which lines belong together,
// turning lines into one paragraph that wraps by itself, and taking, copying or moving whole pages.

import { MM_PER_PT, PAGE, TEXT_STYLE, usePageSize } from './model.js';
import { blocksToHtml } from './editor.js';
import { clone, uid } from './util.js';

const styleOf = (o) => ({ ...TEXT_STYLE, ...o.style });
const isLine = (o) => o.kind === 'text' && o.exact && !o.flow && !String(o.text || '').includes('\n');
const baselineOf = (o) => o.y + styleOf(o).line * 0.8 * MM_PER_PT;
const rightOf = (o) => o.x + o.w;
const centreOf = (o) => o.x + o.w / 2;
const sameLook = (a, b) => {
  const [p, q] = [styleOf(a), styleOf(b)];
  return p.font === q.font && p.size === q.size && !!p.bold === !!q.bold;
};

export const isPlaced = (L) => !!(L.importInfo?.exact || L.importInfo?.scanned);

/* ---------- Which lines belong together ---------- */

/** Every text frame in the letter with the same font, size and thickness. */
export const sameLookAs = (L, o) => (L.objects || []).filter((x) => x.kind === 'text' && sameLook(x, o));

/** The lines of a page that stand in the same column as this one: they start from the same edge and are no wider than the column. */
export function columnOf(L, o) {
  const ltr = styleOf(o).dir === 'ltr';
  const edge = ltr ? (x) => x.x : rightOf;
  const mates = (L.objects || []).filter((x) => x.kind === 'text' && x.page === o.page && Math.abs(edge(x) - edge(o)) <= 1.5);
  const widths = mates.map((x) => x.w).sort((a, b) => a - b);
  const usual = widths[widths.length >> 1] || o.w;
  const inColumn = mates.filter((x) => x.w <= usual * 1.15 || x === o);
  return inColumn.sort((a, b) => a.y - b.y);
}

const overlapShare = (a, b) => (Math.min(rightOf(a), rightOf(b)) - Math.max(a.x, b.x)) / Math.min(a.w, b.w);

/** The usual distance between lines of this size near a line. */
function pitchNear(lines, o) {
  const gaps = lines.map((x) => Math.abs(baselineOf(x) - baselineOf(o))).filter((d) => d > 0.5).sort((a, b) => a - b);
  const size = styleOf(o).size * MM_PER_PT;
  return gaps[0] && gaps[0] < size * 2.2 ? gaps[0] : size * 1.35;
}

/**
 * The lines of the paragraph around a line. A line that reaches the far side of its column goes on in the next one;
 * one that stops short ends its paragraph. Short lines on one centre, such as a two-line title, also belong together.
 */
export function paragraphAround(L, o) {
  if (!isLine(o)) return [o];
  const lines = (L.objects || [])
    .filter((x) => isLine(x) && x.page === o.page && sameLook(x, o) && overlapShare(x, o) > 0.5)
    .sort((a, b) => baselineOf(a) - baselineOf(b));
  const at = lines.indexOf(o);
  const pitch = pitchNear(lines, o);
  const ltr = styleOf(o).dir === 'ltr';
  const farEdge = (x) => (ltr ? rightOf(x) : x.x);
  const far = ltr ? Math.max(...lines.map(farEdge)) : Math.min(...lines.map(farEdge));
  const reachesFar = (x) => Math.abs(farEdge(x) - far) <= 1.2;
  const near = (a, b) => baselineOf(b) - baselineOf(a) <= pitch * 1.3;
  const onOneCentre = (a, b) => Math.abs(centreOf(a) - centreOf(b)) <= 1 && Math.abs(rightOf(a) - rightOf(b)) > 1;
  const follows = (a, b) => near(a, b) && (reachesFar(a) || onOneCentre(a, b));
  let from = at;
  let to = at;
  while (from > 0 && follows(lines[from - 1], lines[from])) from--;
  while (to + 1 < lines.length && follows(lines[to], lines[to + 1])) to++;
  return lines.slice(from, to + 1);
}

/* ---------- Lines into one paragraph ---------- */

/** The words of some lines as one text. A stretching line drawn into a word was only there to fill its line. A gap between lines is a new paragraph. */
export function textOfLines(lines) {
  const sorted = [...lines].sort((a, b) => baselineOf(a) - baselineOf(b) || b.x - a.x);
  const pitch = sorted.length > 1 ? pitchNear(sorted, sorted[0]) : 0;
  let text = '';
  sorted.forEach((line, i) => {
    const words = String(line.text || '').replace(/ـ+/g, '').trim();
    if (i > 0) {
      const steps = Math.round((baselineOf(line) - baselineOf(sorted[i - 1])) / pitch);
      text += steps > 1 ? '\n'.repeat(Math.min(3, steps)) : ' ';
    }
    text += words;
  });
  return text;
}

/**
 * Puts one frame in place of some lines: it wraps its words inside their column at their line spacing, with its first line where theirs was.
 * Returns the frame and where the lines used to end, for moving what stands below.
 */
export function mergeIntoFlow(L, lines, text) {
  const sorted = [...lines].sort((a, b) => baselineOf(a) - baselineOf(b) || b.x - a.x);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const st = styleOf(first);
  const ltr = st.dir === 'ltr';
  const pitchMm = sorted.length > 1 ? pitchNear(sorted, first) : st.line * MM_PER_PT * 0.85;
  const line = Math.round((pitchMm / MM_PER_PT) * 20) / 20;
  // A paragraph of one line keeps the width of the column it stands in.
  const column = sorted.length > 1 ? sorted : columnOf(L, first);
  const left = Math.min(...column.map((x) => x.x));
  const right = Math.max(...column.map(rightOf));
  const centred = sorted.length > 1 && sorted.every((x) => Math.abs(centreOf(x) - centreOf(first)) <= 1) && !sorted.every((x) => Math.abs(rightOf(x) - rightOf(first)) <= 1);
  const frame = {
    id: uid(),
    kind: 'text',
    anchor: 'page',
    page: first.page,
    exact: true,
    flow: true,
    x: left,
    y: baselineOf(first) - line * 0.8 * MM_PER_PT,
    w: right - left,
    h: sorted.length * pitchMm,
    text,
    style: { font: st.font, size: st.size, bold: st.bold, line, align: centred ? 'center' : ltr ? 'left' : 'justify', ...(st.color && { color: st.color }), ...(st.dir && { dir: st.dir }) },
  };
  const bottom = baselineOf(last) + pitchMm * 0.25;
  const gone = new Set(sorted.map((x) => x.id));
  const at = (L.objects || []).findIndex((x) => gone.has(x.id));
  L.objects = L.objects.filter((x) => !gone.has(x.id));
  L.objects.splice(at, 0, frame);
  return { frame, bottom };
}

/** Moves what stands below a paragraph in its column, by as much as the paragraph grew or shrank. Says whether anything now runs off the page. */
export function shiftBelow(L, frame, bottom, dy) {
  usePageSize(L);
  let overflow = frame.y + (frame.h || 0) > PAGE.h - 2;
  for (const o of L.objects || []) {
    if (o === frame || o.page !== frame.page || o.behind || !o.exact) continue;
    if (o.y < bottom - 0.6 || o.w > frame.w * 1.1 || overlapShare(o, frame) < 0.5) continue;
    o.y += dy;
    const height = o.kind === 'text' ? o.h || 0 : o.w / (o.aspect || 1);
    if (o.y + height > PAGE.h - 2) overflow = true;
  }
  return overflow;
}

/* ---------- Whole pages ---------- */

function setPageCount(L, count) {
  const empty = L.body[0] || { kind: 'p', runs: [] };
  const { pageBreak, ...line } = empty;
  L.body = Array.from({ length: count }, (_, i) => ({ ...line, ...(i > 0 && { pageBreak: true }) }));
  L.bodyHtml = blocksToHtml(L.body);
}

export function deletePage(L, page) {
  const count = L.body.length;
  if (count < 2) return false;
  L.objects = (L.objects || []).filter((o) => o.page !== page).map((o) => (o.page > page ? { ...o, page: o.page - 1 } : o));
  setPageCount(L, count - 1);
  return true;
}

export function duplicatePage(L, page) {
  const copies = (L.objects || []).filter((o) => o.page === page).map((o) => ({ ...clone(o), id: uid(), page: page + 1 }));
  const moved = (L.objects || []).map((o) => (o.page > page ? { ...o, page: o.page + 1 } : o));
  L.objects = [...moved, ...copies];
  setPageCount(L, L.body.length + 1);
}

export function movePage(L, page, step) {
  const other = page + step;
  if (other < 0 || other >= L.body.length) return false;
  L.objects = (L.objects || []).map((o) => (o.page === page ? { ...o, page: other } : o.page === other ? { ...o, page } : o));
  return true;
}

/** A copy of the letter with only these pages, for a file of just those. */
export function letterWithPages(L, pages) {
  const copy = { ...L, objects: (L.objects || []).filter((o) => pages.includes(o.page)).map((o) => ({ ...o, page: pages.indexOf(o.page) })) };
  setPageCount(copy, pages.length);
  return copy;
}

/** Reads «۲» or «۱-۳، ۵» into page indexes. Nothing written means all of them; null means it could not be read. */
export function parsePages(text, total) {
  const plain = String(text || '').replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).trim();
  if (!plain) return [];
  const pages = new Set();
  for (const piece of plain.split(/[,،\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(piece);
    if (!m) return null;
    const from = Number(m[1]);
    const to = Number(m[2] || m[1]);
    if (from < 1 || to > total || from > to) return null;
    for (let n = from; n <= to; n++) pages.add(n - 1);
  }
  return [...pages].sort((a, b) => a - b);
}
