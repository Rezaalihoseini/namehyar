// Changing the look of cells, paragraphs and frames. Each of them remembers how it looked before its first change,
// so going back, step by step or all at once, leaves it exactly as it was. What a part remembers is its own, and is left out of files.

import { applyLook, clearLook, runAt, runsText, placeOfWord } from './runs.js';
import { MM_PER_PT, TEXT_STYLE, frameLines } from './model.js';
import { normalizeText, toFaDigits } from './text.js';

// What a part's style calls font, size and so on, a run of text calls these.
const RUN_KEY = { font: 'font', size: 'size', bold: 'b', underline: 'u', color: 'color' };
const ALL_RUN_KEYS = Object.values(RUN_KEY);

export function lookFrom(patch) {
  const look = {};
  for (const [key, value] of Object.entries(patch)) {
    if (RUN_KEY[key]) look[RUN_KEY[key]] = key === 'underline' ? value || undefined : value ?? undefined;
  }
  return look;
}

const runKeysOf = (patch) => Object.keys(patch).map((key) => RUN_KEY[key]).filter(Boolean);
const round2 = (v) => Math.round(v * 100) / 100;
const textOfParas = (paras) => paras.map((p) => runsText(p.runs)).join('\n');

/** The look of a run as a style's words, with what it does not set taken from the part it is in. */
export const lookOfRun = (run, st) => ({ ...st, font: run?.font || st.font, size: run?.size || st.size, bold: run?.b ?? st.bold, underline: run?.u ?? !!st.underline, color: run?.color ?? st.color });

/** A paragraph's text as the page shows it: a word's place on the page must also be its place in the letter. */
export const shownRuns = (L, runs) => (L.autoFix === false ? runs : (runs || []).map((run) => (run.text ? { ...run, text: normalizeText(run.text) } : run)));

/* ---------- Lines of fixed height ---------- */

const largestOf = (runs, size) => Math.max(0, ...(runs || []).filter((run) => run.text).map((run) => run.size || size));

/**
 * A line of fixed height must be tall enough for its largest letters, or Word cuts them off. Above the size it first had,
 * it grows around its middle so the words stay about where they were. At that size or below, it is what it first was.
 */
function fitLine(p, first, size) {
  if (!p.over?.line || !first?.over?.line) return p;
  const was = largestOf(first.runs, size);
  const now = largestOf(p.runs, size);
  if (!now) return p;
  if (now <= was) return { ...p, over: first.over };
  const line = Math.max(first.over.line, Math.round(now * 2.4) / 2);
  return { ...p, over: { ...first.over, line, before: round2(Math.max(0, (first.over.before || 0) - (line - first.over.line) * 0.65)) } };
}

/* ---------- A cell ---------- */

const cellNow = (cell) => ({ paras: cell.paras, ...(cell.bg && { bg: cell.bg }), ...(cell.borders && { borders: cell.borders }) });

function rememberCell(cell) {
  if (!cell.orig) cell.orig = JSON.stringify(cellNow(cell));
  return JSON.parse(cell.orig);
}

function settleCell(cell) {
  if (cell.orig === JSON.stringify(cellNow(cell))) delete cell.orig;
}

export function restyleCell(cell, patch, size) {
  const first = rememberCell(cell);
  const look = lookFrom(patch);
  cell.paras = cell.paras.map((p, i) => {
    let next = { ...p, runs: applyLook(p.runs, look) };
    // Returning to the inherited size must return to inheritance too. Keeping
    // an explicit size changes later table-wide formatting and reset.
    if (patch.size === size && first.paras[i]?.runs.every((run) => run.size === undefined)) {
      next.runs = clearLook(next.runs, ['size']);
    }
    if (patch.align) {
      // Alignment replaces the distance from the edge that kept the words in place.
      const { indent, ...rest } = next;
      next = { ...rest, align: patch.align };
    }
    return patch.size !== undefined ? fitLine(next, first.paras[i], size) : next;
  });
  if ('bg' in patch) {
    if (patch.bg) cell.bg = patch.bg;
    else delete cell.bg;
  }
  settleCell(cell);
}

export function restyleCellWord(L, cell, word, patch, size) {
  const first = rememberCell(cell);
  cell.paras = cell.paras.map((p, i) => {
    if (i !== word.p) return p;
    const next = { ...p, runs: lookOnWord(L, p.runs, word, lookFrom(patch)) };
    return patch.size !== undefined ? fitLine(next, first.paras[i], size) : next;
  });
  settleCell(cell);
}

export function resetCell(cell) {
  if (!cell.orig) return;
  const first = JSON.parse(cell.orig);
  cell.paras = textOfParas(first.paras) === textOfParas(cell.paras) ? first.paras : cell.paras.map((p) => ({ ...p, runs: clearLook(p.runs, ALL_RUN_KEYS) }));
  if (first.bg) cell.bg = first.bg;
  else delete cell.bg;
  if (first.borders) cell.borders = first.borders;
  else delete cell.borders;
  delete cell.orig;
}

export function resetCellWord(L, cell, word, size) {
  if (!cell.orig) return;
  const first = JSON.parse(cell.orig);
  cell.paras = cell.paras.map((p, i) => {
    if (i !== word.p) return p;
    return fitLine({ ...p, runs: wordAsItWas(L, p.runs, first.paras[i]?.runs, word) }, first.paras[i], size);
  });
  settleCell(cell);
}

/* ---------- The lines of a table's cells ---------- */

/** Where each cell of a table stands: its row, its place in the row, and the columns it covers. Column 0 is the rightmost. */
export function cellGrid(table) {
  const taken = [];
  const out = [];
  table.rows.forEach((row, r) => {
    let col = 0;
    row.forEach((cell, c) => {
      while (taken[r]?.[col]) col++;
      const span = cell.colSpan || 1;
      const rowSpan = cell.rowSpan || 1;
      out.push({ r, c, cell, col, span, rowSpan });
      for (let y = r; y < r + rowSpan; y++) {
        taken[y] = taken[y] || [];
        for (let x = col; x < col + span; x++) taken[y][x] = true;
      }
      col += span;
    });
  });
  return out;
}

const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) > Math.max(a0, b0);

/** Sides are named by their place in a cell's list of lines: top, right, bottom, left. */
const SIDE = { top: 0, right: 1, bottom: 2, left: 3 };
const FACING = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };

function neighboursOn(grid, me, side) {
  if (side === 'top') return grid.filter((o) => o.r + o.rowSpan === me.r && overlap(o.col, o.col + o.span, me.col, me.col + me.span));
  if (side === 'bottom') return grid.filter((o) => o.r === me.r + me.rowSpan && overlap(o.col, o.col + o.span, me.col, me.col + me.span));
  if (side === 'right') return grid.filter((o) => o.col + o.span === me.col && overlap(o.r, o.r + o.rowSpan, me.r, me.r + me.rowSpan));
  return grid.filter((o) => o.col === me.col + me.span && overlap(o.r, o.r + o.rowSpan, me.r, me.r + me.rowSpan));
}

function setSide(table, cell, side, width) {
  rememberCell(cell);
  const lines = [...(cell.borders || Array(4).fill(table.borderless ? 0 : 0.5))];
  lines[SIDE[side]] = width;
  cell.borders = lines;
  settleCell(cell);
}

/** Draws or removes lines of a cell. A line is shared with the cell beside it, so that cell's side changes too, or it would stay. */
export function setCellLines(table, r, c, sides, width) {
  const grid = cellGrid(table);
  const me = grid.find((o) => o.r === r && o.c === c);
  if (!me) return;
  for (const side of sides) {
    setSide(table, me.cell, side, width);
    for (const other of neighboursOn(grid, me, side)) setSide(table, other.cell, FACING[side], width);
  }
}

/* ---------- A word in a paragraph ---------- */

/** Gives one word a look. The text is taken as the page shows it, so the word's place is right. */
export function lookOnWord(L, runs, word, look) {
  const fixed = shownRuns(L, runs);
  const place = placeOfWord(runsText(fixed), word);
  return place ? applyLook(fixed, look, place.start, place.end) : fixed;
}

/** One word as it first was, or with no look of its own when the words have changed since. */
export function wordAsItWas(L, runs, firstRuns, word) {
  const fixed = shownRuns(L, runs);
  const place = placeOfWord(runsText(fixed), word);
  if (!place) return fixed;
  const cleared = Object.fromEntries(ALL_RUN_KEYS.map((key) => [key, undefined]));
  const firstText = runsText(shownRuns(L, firstRuns));
  const was = firstText === runsText(fixed) ? runAt(firstRuns, place.start) : null;
  const look = { ...cleared };
  for (const key of ALL_RUN_KEYS) if (was?.[key] !== undefined) look[key] = was[key];
  return applyLook(fixed, look, place.start, place.end);
}

/* ---------- A paragraph of the body ---------- */

const blockNow = (b) => ({ runs: b.runs, ...(b.over && { over: b.over }), ...(b.align && { align: b.align }), ...(b.indent && { indent: b.indent }) });

function settleBlock(b) {
  if (b.orig === JSON.stringify(blockNow(b))) delete b.orig;
  return b;
}

export function restyleBlock(b, patch) {
  const next = { ...b, orig: b.orig || JSON.stringify(blockNow(b)) };
  // Colour and underline live on the words. Font, size and thickness are the paragraph's, over whatever its words had.
  const { color, underline, align, bg, ...over } = patch;
  if (Object.keys(over).length) {
    next.over = { ...b.over, ...over };
    next.runs = clearLook(b.runs, runKeysOf(over));
  }
  const look = lookFrom(Object.fromEntries(Object.entries(patch).filter(([key]) => key === 'color' || key === 'underline')));
  if (Object.keys(look).length) next.runs = applyLook(next.runs, look);
  if (align) next.align = align;
  return settleBlock(next);
}

export function restyleBlockWord(L, b, word, patch) {
  return settleBlock({ ...b, orig: b.orig || JSON.stringify(blockNow(b)), runs: lookOnWord(L, b.runs, word, lookFrom(patch)) });
}

export function resetBlock(b) {
  if (!b.orig) return b;
  const first = JSON.parse(b.orig);
  const { orig, over, align, indent, ...rest } = b;
  if (runsText(first.runs) !== runsText(b.runs)) return { ...rest, ...(first.over && { over: first.over }), ...(first.align && { align: first.align }), ...(first.indent && { indent: first.indent }), runs: clearLook(b.runs, ALL_RUN_KEYS) };
  return { ...rest, ...first };
}

export function resetBlockWord(L, b, word) {
  if (!b.orig) return b;
  return settleBlock({ ...b, runs: wordAsItWas(L, b.runs, JSON.parse(b.orig).runs, word) });
}

/* ---------- A text frame ---------- */

const frameNow = (o) => ({ style: o.style, ...(o.lines && { lines: o.lines }), ...(o.fill && { fill: o.fill }) });

function rememberFrame(o) {
  if (!o.orig) o.orig = JSON.stringify(frameNow(o));
  return JSON.parse(o.orig);
}

function settleFrame(o) {
  if (o.orig === JSON.stringify(frameNow(o))) delete o.orig;
}

/** How much of a line's growth goes above its baseline. A line taken exactly from a file has its baseline four fifths of the way down. */
const lineGrowth = (o) => (o.exact ? 0.8 : 0.65);

/** Sizes in a frame, for its line of fixed height. Its place moves with the line, so its words stay where they were. */
function fitFrameLine(o, first) {
  const st = { ...TEXT_STYLE, ...o.style };
  if (!first.style?.line) return;
  const largest = (style, lines) => Math.max(style.size || TEXT_STYLE.size, ...(lines || []).flat().filter((run) => run.text).map((run) => run.size || style.size || TEXT_STYLE.size));
  const was = largest(first.style, first.lines);
  const now = largest(st, o.lines);
  const line = now <= was ? first.style.line : Math.max(first.style.line, Math.round(now * 2.4) / 2);
  if (line === st.line) return;
  o.y -= (line - st.line) * lineGrowth(o) * MM_PER_PT;
  o.style = { ...o.style, line };
}

export function restyleFrame(o, patch) {
  const first = rememberFrame(o);
  const { bg, ...style } = patch;
  o.style = { ...o.style, ...style };
  if ('fill' in style) {
    delete o.style.fill;
    if (patch.fill) o.fill = patch.fill;
    else delete o.fill;
  }
  if (o.lines) o.lines = frameLines(o).map((runs) => clearLook(runs, runKeysOf(style)));
  fitFrameLine(o, first);
  settleFrame(o);
}

export function restyleFrameWord(L, o, word, patch) {
  const first = rememberFrame(o);
  const lines = frameLines(o).map((runs, i) => (i === word.p ? lookOnWord(L, runs, word, lookFrom(patch)) : shownRuns(L, runs)));
  o.lines = lines;
  o.text = lines.map(runsText).join('\n');
  fitFrameLine(o, first);
  settleFrame(o);
}

export function resetFrame(o) {
  if (!o.orig) return;
  const first = JSON.parse(o.orig);
  const sameText = !first.lines || first.lines.map(runsText).join('\n') === o.text;
  const line = { ...TEXT_STYLE, ...o.style }.line;
  o.style = first.style;
  if (line && first.style?.line) o.y += (line - first.style.line) * lineGrowth(o) * MM_PER_PT;
  if (first.lines && sameText) o.lines = first.lines;
  else delete o.lines;
  if (first.fill) o.fill = first.fill;
  else delete o.fill;
  delete o.orig;
}

export function resetFrameWord(L, o, word) {
  if (!o.orig) return;
  const first = JSON.parse(o.orig);
  const lines = frameLines(o).map((runs, i) => (i === word.p ? wordAsItWas(L, runs, first.lines?.[i] || runsOfText(first, o, i), word) : runs));
  o.lines = lines;
  fitFrameLine(o, first);
  settleFrame(o);
}

const runsOfText = (first, o, i) => {
  const line = String(o.text || '').split('\n')[i];
  return line ? [{ text: line }] : [];
};

/* ---------- Find and replace, the whole letter over ---------- */

// Spellings that look alike count as one: same length, so a place found in one is the place in the other.
const fold = (s) => toFaDigits(s).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');

const WORD_CHAR = /[\p{L}\p{N}\p{M}\u200c]/u;

function placesIn(text, find, whole = false) {
  const places = [];
  const hay = fold(text);
  const needle = fold(find);
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    if (whole && ((at > 0 && WORD_CHAR.test(hay[at - 1])) || (at + needle.length < hay.length && WORD_CHAR.test(hay[at + needle.length])))) continue;
    places.push(at);
  }
  return places;
}

/** Puts new words over a stretch of runs. They take the look of the word they replace. */
function replaceStretch(runs, start, end, text) {
  const out = [];
  let pos = 0;
  let placed = false;
  for (const run of runs) {
    if (run.img) {
      out.push(run);
      continue;
    }
    const length = (run.text || '').length;
    const from = Math.max(start - pos, 0);
    const to = Math.min(end - pos, length);
    if (from >= to) out.push(run);
    else {
      const joined = `${run.text.slice(0, from)}${placed ? '' : text}${run.text.slice(to)}`;
      placed = true;
      if (joined) out.push({ ...run, text: joined });
    }
    pos += length;
  }
  return out;
}

function replaceInRuns(runs, find, text, whole) {
  const places = placesIn(runsText(runs), find, whole);
  let out = runs;
  for (const at of [...places].reverse()) out = replaceStretch(out, at, at + find.length, text);
  return { runs: out, count: places.length };
}

function replaceInString(value, find, text, whole) {
  const places = placesIn(String(value || ''), find, whole);
  let out = String(value || '');
  for (const at of [...places].reverse()) out = `${out.slice(0, at)}${text}${out.slice(at + find.length)}`;
  return { value: out, count: places.length };
}

const PLAIN_FIELDS = [
  [(L) => L.subject, (L, v) => { L.subject = v; }],
  [(L) => L.greeting, (L, v) => { L.greeting = v; }],
  [(L) => L.closing, (L, v) => { L.closing = v; }],
  [(L) => L.cc, (L, v) => { L.cc = v; }],
  [(L) => L.recipient?.name, (L, v) => { L.recipient = { ...L.recipient, name: v }; }],
  [(L) => L.recipient?.title, (L, v) => { L.recipient = { ...L.recipient, title: v }; }],
  [(L) => L.signer?.name, (L, v) => { L.signer = { ...L.signer, name: v }; }],
  [(L) => L.signer?.title, (L, v) => { L.signer = { ...L.signer, title: v }; }],
  [(L) => L.number, (L, v) => { L.number = v; }],
  [(L) => L.date, (L, v) => { L.date = v; }],
  [(L) => L.attachment, (L, v) => { L.attachment = v; }],
  [(L) => L.letterhead?.invocation, (L, v) => { L.letterhead.invocation = v; }],
  ...[0, 1, 2, 3].map((i) => [(L) => L.letterhead?.org?.[i], (L, v) => { L.letterhead.org[i] = v; }]),
];

/** Puts words in place of [blanks], given as {label: words}. Returns how many places were filled. */
export function fillBlanks(L, values) {
  let count = 0;
  for (const [label, words] of Object.entries(values)) {
    if (words) count += replaceEverywhere(L, `[${label}]`, words);
  }
  return count;
}

/** How many times some words occur in the letter, or with text given, replaces them all. Returns how many. */
export function replaceEverywhere(L, find, text, { whole = false } = {}) {
  if (!find) return 0;
  const doing = text !== undefined;
  let count = 0;
  const onRuns = (holder) => {
    const done = replaceInRuns(holder.runs || [], find, doing ? text : find, whole);
    count += done.count;
    if (doing && done.count) holder.runs = done.runs;
  };
  for (const block of L.body || []) {
    if (block.kind === 'table') for (const row of block.rows) for (const cell of row) cell.paras.forEach(onRuns);
    else if (block.kind === 'p') onRuns(block);
  }
  for (const o of L.objects || []) {
    if (o.kind !== 'text') continue;
    if (o.lines) {
      o.lines.forEach((runs, i) => {
        const holder = { runs };
        onRuns(holder);
        if (doing) o.lines[i] = holder.runs;
      });
      if (doing) o.text = o.lines.map(runsText).join('\n');
    } else {
      const done = replaceInString(o.text, find, doing ? text : find, whole);
      count += done.count;
      if (doing) o.text = done.value;
    }
  }
  for (const [read, write] of PLAIN_FIELDS) {
    const done = replaceInString(read(L), find, doing ? text : find, whole);
    count += done.count;
    if (doing && done.count) write(L, done.value);
  }
  return count;
}
