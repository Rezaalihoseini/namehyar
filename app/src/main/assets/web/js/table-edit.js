// What can be done to a table's shape and its data, on the letter's own model. There is no screen here, so tools/ can run it in Node.
//
// Merged cells are followed everywhere. A cell taken out without its row or column leaves a hole: an empty cell with no lines of
// its own. The table stays a rectangle, so the page, Word and the form all understand it without being told anything new.

import { applyLook, runsText } from './runs.js';
import { cellGrid, restyleCell } from './restyle.js';
import { toEnDigits, toFaDigits } from './text.js';

const round2 = (v) => Math.round(v * 100) / 100;
const sum = (list) => list.reduce((a, b) => a + b, 0);

const paraHasContent = (p) => (p.runs || []).some((run) => run.img || (run.text || '').trim());

export const cellHasContent = (cell) => cell.paras.some(paraHasContent);
export const cellWords = (cell) => cell.paras.map((p) => runsText(p.runs)).join(' ').trim();
export const isMerged = (cell) => (cell.colSpan || 1) > 1 || (cell.rowSpan || 1) > 1;

/** What is left where a cell was taken out: nothing in it and no lines of its own. The lines beside it belong to its neighbours. */
export const isHole = (cell) => !!cell.borders && cell.borders.every((w) => !w) && !cell.bg && !cellHasContent(cell);

export const columnCount = (table) => Math.max(0, table.widths?.length || 0, ...cellGrid(table).map((o) => o.col + o.span));

export const placeOfCell = (table, cell) => cellGrid(table).find((o) => o.cell === cell) || null;

/** The rows that some cells stand in, a merged cell standing in all of its rows. */
export function rowsOf(table, cells) {
  const rows = new Set();
  for (const o of cellGrid(table)) {
    if (!cells.includes(o.cell)) continue;
    for (let y = o.r; y < Math.min(o.r + o.rowSpan, table.rows.length); y++) rows.add(y);
  }
  return rows;
}

/** The columns that some cells stand in. Column 0 is the rightmost. */
export function columnsOf(table, cells) {
  const cols = new Set();
  for (const o of cellGrid(table)) {
    if (!cells.includes(o.cell)) continue;
    for (let x = o.col; x < o.col + o.span; x++) cols.add(x);
  }
  return cols;
}

const coversRow = (o, r) => o.r <= r && o.r + o.rowSpan > r;
const coversColumn = (o, col) => o.col <= col && o.col + o.span > col;

export const cellsInRows = (table, rows) => cellGrid(table).filter((o) => [...rows].some((r) => coversRow(o, r))).map((o) => o.cell);
export const cellsInColumns = (table, cols) => cellGrid(table).filter((o) => [...cols].some((c) => coversColumn(o, c))).map((o) => o.cell);

/* ---------- Putting a table back together ---------- */

function setSpans(cell, span, rowSpan) {
  if (span > 1) cell.colSpan = span;
  else delete cell.colSpan;
  if (rowSpan > 1) cell.rowSpan = rowSpan;
  else delete cell.rowSpan;
}

/** The table's rows from where each cell now stands. */
function rebuild(table, placed, rowCount) {
  const rows = Array.from({ length: rowCount }, () => []);
  for (const o of [...placed].sort((a, b) => a.col - b.col)) {
    setSpans(o.cell, o.span, o.rowSpan);
    rows[o.r].push(o.cell);
  }
  table.rows = rows;
}

function dropRows(table, gone) {
  const count = table.rows.length;
  const newRow = [];
  let next = 0;
  for (let r = 0; r < count; r++) newRow[r] = gone.has(r) ? -1 : next++;
  const placed = [];
  for (const o of cellGrid(table)) {
    // A merged cell that begins in a row going away moves down to its next row, with its words.
    const kept = [];
    for (let y = o.r; y < Math.min(o.r + o.rowSpan, count); y++) if (newRow[y] >= 0) kept.push(newRow[y]);
    if (kept.length) placed.push({ ...o, r: kept[0], rowSpan: kept.length });
  }
  rebuild(table, placed, next);
}

/** A row with no cell of its own, all of it covered from above, has no height on the page but would have one in Word. */
function tidyRows(table) {
  const empty = new Set();
  table.rows.forEach((row, r) => {
    if (!row.length) empty.add(r);
  });
  if (empty.size) dropRows(table, empty);
}

/* ---------- Widths ---------- */

/** A form keeps each column as wide as it is in its file, so taking one out makes the table narrower. Others stay as wide as the text. */
const keepsOwnWidths = (table) => table.pad !== undefined;

/** Parts of a hundred, adding up to exactly a hundred. */
function fractions(list) {
  const total = sum(list);
  const out = list.map((w) => round2((w * 100) / total));
  if (out.length) out[out.length - 1] = round2(out[out.length - 1] + 100 - sum(out));
  return out;
}

function setWidths(table, raw) {
  if (!raw.length) {
    delete table.widths;
    return;
  }
  if (keepsOwnWidths(table)) {
    const pct = round2(((table.widthPct || 100) * sum(raw)) / 100);
    if (pct < 99.5) table.widthPct = pct;
    else delete table.widthPct;
  }
  table.widths = fractions(raw);
}

/** Each column's share of the table's width, from the table's own widths or equal. */
export function widthsOf(table) {
  const cols = columnCount(table);
  return table.widths?.length === cols ? [...table.widths] : Array(cols).fill(cols ? 100 / cols : 0);
}

const MIN_WIDTH = 3;

/** Makes some columns wider or narrower, the others giving or taking the difference in proportion. Returns false when there is no room. */
export function resizeColumns(table, cols, delta) {
  const widths = widthsOf(table);
  const others = widths.map((_, i) => i).filter((i) => !cols.has(i));
  if (!others.length) return false;
  const wanted = new Map([...cols].map((i) => [i, Math.max(MIN_WIDTH, widths[i] + delta)]));
  let room = 100 - sum([...wanted.values()]);
  if (room < others.length * MIN_WIDTH) return false;
  // Those that would fall under the least a column can be stay there, and the rest share what is left.
  let open = others;
  const share = new Map();
  for (let pass = 0; pass <= others.length && open.length; pass++) {
    const total = sum(open.map((i) => widths[i])) || 1;
    const tooSmall = open.filter((i) => (widths[i] * room) / total < MIN_WIDTH);
    if (!tooSmall.length) {
      for (const i of open) share.set(i, (widths[i] * room) / total);
      break;
    }
    for (const i of tooSmall) share.set(i, MIN_WIDTH);
    room -= tooSmall.length * MIN_WIDTH;
    open = open.filter((i) => !tooSmall.includes(i));
  }
  table.widths = fractions(widths.map((w, i) => wanted.get(i) ?? share.get(i) ?? w));
  return true;
}

export function equalColumns(table) {
  const cols = columnCount(table);
  if (cols) table.widths = fractions(Array(cols).fill(1));
}

/**
 * Each column as wide as its words want, as far as the table's width allows.
 * @param measure how wide some words are, in millimetres
 * @param widthMm how wide the table is
 */
export function fitColumns(table, { measure, widthMm }) {
  const cols = columnCount(table);
  if (!cols) return;
  const padding = 2 * (table.pad ?? 1.5) + 1;
  const most = Array(cols).fill(0);
  const least = Array(cols).fill(0);
  for (const o of cellGrid(table)) {
    if (o.span > 1) continue;
    for (const p of o.cell.paras) {
      const text = runsText(p.runs).trim();
      if (!text) continue;
      most[o.col] = Math.max(most[o.col], measure(text));
      for (const word of text.split(/\s+/)) least[o.col] = Math.max(least[o.col], measure(word));
    }
  }
  const wants = most.map((w) => (w || 12) + padding);
  const needs = least.map((w) => (w || 8) + padding);
  const sumWants = sum(wants);
  const sumNeeds = sum(needs);
  let widths;
  if (sumWants <= widthMm) widths = wants;
  else if (sumNeeds >= widthMm) widths = needs;
  else widths = needs.map((w, i) => w + ((widthMm - sumNeeds) * (wants[i] - w)) / (sumWants - sumNeeds));
  table.widths = fractions(widths);
}

/**
 * Makes some rows taller or shorter. A row's height is the least it has: words can always push it taller.
 * @param shownMm how tall a row is on the page now, for a row with no height of its own
 */
export function resizeRows(table, rows, delta, shownMm = () => 0) {
  for (const r of rows) {
    const cells = (table.rows[r] || []).filter((cell) => (cell.rowSpan || 1) === 1);
    if (!cells.length) continue;
    const own = Math.max(0, ...cells.map((cell) => cell.rowH || 0));
    const next = round2(Math.max(own, shownMm(r)) + delta);
    for (const cell of cells) {
      if (next >= 2) cell.rowH = next;
      else delete cell.rowH;
    }
  }
}

/** A row's own height back to what its words need. */
export function autoRowHeight(table, rows) {
  for (const r of rows) for (const cell of table.rows[r] || []) delete cell.rowH;
}

/* ---------- A new, empty cell that looks like the one beside it ---------- */

function blankLike(cell, { keepFill = true } = {}) {
  const { indent, runs, ...para } = cell.paras[0] || {};
  return {
    ...(cell.vAlign && { vAlign: cell.vAlign }),
    ...(cell.rowH && (cell.rowSpan || 1) === 1 && { rowH: cell.rowH }),
    ...(cell.bg && keepFill && { bg: cell.bg }),
    // Beside a hole, the new cell is a whole one with lines of its own.
    ...(cell.borders && !isHole(cell) && { borders: [...cell.borders] }),
    paras: [{ ...para, runs: [] }],
  };
}

function copyOfCell(cell) {
  const { orig, colSpan, rowSpan, ...rest } = JSON.parse(JSON.stringify(cell));
  return rest;
}

/** A row's words as they first looked, when a row put above it takes over as the title row and the first row's thick letters with it. */
function keepTitleThick(table) {
  for (const cell of table.rows[0] || []) {
    cell.paras = cell.paras.map((p) => ({ ...p, runs: applyLook(p.runs, { b: true }) }));
  }
}

function addRow(table, at, { from, copy = false } = {}) {
  const count = table.rows.length;
  const model = Math.min(Math.max(from ?? (at > 0 ? at - 1 : 0), 0), count - 1);
  const titleModel = model === 0 && table.header !== false;
  const grid = cellGrid(table);
  const fresh = [];
  for (const o of grid) {
    if (!coversRow(o, model)) continue;
    // A merged cell crossing the place just grows by a row.
    if (o.r < at && o.r + o.rowSpan > at) continue;
    fresh.push({ r: at, col: o.col, span: o.span, rowSpan: 1, cell: copy ? copyOfCell(o.cell) : blankLike(o.cell, { keepFill: !titleModel }) });
  }
  if (at === 0 && table.header !== false) keepTitleThick(table);
  const placed = grid.map((o) => ({ ...o, r: o.r >= at ? o.r + 1 : o.r, rowSpan: o.r < at && o.r + o.rowSpan > at ? o.rowSpan + 1 : o.rowSpan }));
  rebuild(table, [...placed, ...fresh], count + 1);
}

/* ---------- The column that counts the rows ---------- */

const plainNumber = (text) => {
  const digits = toEnDigits(text.trim());
  return /^\d{1,5}$/.test(digits) ? Number(digits) : null;
};

const COUNT_TITLE = /^(ردیف|شماره|شماره ردیف|ش|#|no\.?|row)$/i;
const isCountTitle = (text) => COUNT_TITLE.test(text.trim().replace(/ي/g, 'ی').replace(/‌/g, ''));
const TOTAL_WORD = /^(جمع|مجموع)/;
const isTotalRow = (row) => (row || []).some((cell) => TOTAL_WORD.test(cellWords(cell)));

/** The cell of each row in a column, where that cell stands alone there. Nothing where it is merged. */
function columnCells(table, col) {
  const out = Array(table.rows.length).fill(null);
  for (const o of cellGrid(table)) {
    if (o.col === col && o.span === 1 && o.rowSpan === 1) out[o.r] = o.cell;
  }
  return out;
}

const hasTitleRow = (table) => table.header !== false;

/** The look of the words of a row, for a new word put in it. */
function lookInRow(row) {
  const run = (row || []).flatMap((cell) => cell.paras.flatMap((p) => p.runs || [])).find((r) => r.text);
  if (!run) return {};
  const { text, ...look } = run;
  return look;
}

function setCellText(cell, text, look = {}) {
  const para = cell.paras[0] || {};
  const own = (para.runs || []).find((run) => run.text);
  const { text: oldText, ...ownLook } = own || {};
  cell.paras = [{ ...para, runs: text ? [{ ...(own ? ownLook : look), text }] : [] }];
}

/**
 * Finds a column that counts the rows, so it can be kept in order when rows change. Under a title such as «ردیف» it may be out of
 * order or have gaps, since it can only be meant to count. With no title, only a first column reading 1, 2, 3 in order is taken for one:
 * a column of amounts that happens to read 1, 2 must never be rewritten.
 */
export function countingColumn(table) {
  const rows = table.rows.length;
  const cols = columnCount(table);
  for (let col = 0; col < cols; col++) {
    const cells = columnCells(table, col);
    const titled = hasTitleRow(table) && !!cells[0] && isCountTitle(cellWords(cells[0]));
    let from;
    if (titled) from = 1;
    else if (col === 0 && (!hasTitleRow(table) || plainNumber(cellWords(cells[0] || { paras: [] })) === 1)) from = 0;
    else continue;
    let numbers = 0;
    let r = from;
    if (titled) {
      for (; r < rows && cells[r] && !isTotalRow(table.rows[r]); r++) {
        const words = cellWords(cells[r]);
        if (words && plainNumber(words) === null) break;
        if (words) numbers++;
      }
      if (!numbers) continue;
    } else {
      while (r < rows && cells[r] && plainNumber(cellWords(cells[r])) === numbers + 1) {
        numbers++;
        r++;
      }
      if (numbers < 3) continue;
    }
    if (cells.slice(r).some((cell) => cell && plainNumber(cellWords(cell)) !== null)) continue;
    const sample = cells.slice(from, r).find((cell) => cell && cellWords(cell));
    return {
      col,
      title: titled ? table.rows[0][0] : null,
      tail: table.rows.slice(r).map((row) => row[0]).filter(Boolean),
      look: lookInRow([sample]),
      latin: /[0-9]/.test(cellWords(sample)),
    };
  }
  return null;
}

/** Writes the running numbers again. Says whether any number changed. */
function writeCounts(table, info) {
  const cells = columnCells(table, info.col);
  const titleAt = info.title ? table.rows.findIndex((row) => row.includes(info.title)) : -1;
  let k = 0;
  let changed = false;
  table.rows.forEach((row, r) => {
    if (r <= titleAt || info.tail.some((cell) => row.includes(cell))) return;
    const cell = cells[r];
    if (!cell) return;
    k++;
    const text = info.latin ? String(k) : toFaDigits(k);
    if (cellWords(cell) === text) return;
    setCellText(cell, text, info.look);
    changed = true;
  });
  return changed;
}

/** Makes a change to the table's rows and keeps its row numbers in order. Says whether any number had to change. */
function keepingCount(table, change) {
  const info = countingColumn(table);
  change();
  return info ? writeCounts(table, info) : false;
}

/** The numbers of a column written afresh, from under its title down. */
export function numberColumn(table, col) {
  const cells = columnCells(table, col);
  const from = hasTitleRow(table) ? 1 : 0;
  let k = 0;
  cells.forEach((cell, r) => {
    if (r < from || !cell || isTotalRow(table.rows[r])) return;
    k++;
    setCellText(cell, toFaDigits(k), lookInRow(table.rows[r]));
  });
  return k;
}

/** A narrow new first column titled «ردیف», already numbered. */
export function addCountingColumn(table) {
  insertColumn(table, 0);
  const widths = widthsOf(table);
  const others = sum(widths.slice(1)) || 1;
  const narrow = Math.min(9, 100 / columnCount(table));
  table.widths = fractions(widths.map((w, i) => (i === 0 ? narrow : (w * (100 - narrow)) / others)));
  if (hasTitleRow(table)) {
    const title = columnCells(table, 0)[0];
    if (title) setCellText(title, 'ردیف', lookInRow(table.rows[0]));
  }
  numberColumn(table, 0);
}

/* ---------- Taking out rows, columns and cells ---------- */

/** Says whether row numbers had to change. */
export function deleteRows(table, rows) {
  return keepingCount(table, () => {
    // The first row was the title. The one that takes its place was not written as one.
    if (rows.has(0) && table.header !== false) table.header = false;
    dropRows(table, rows);
    tidyRows(table);
  });
}

export function deleteColumns(table, cols) {
  const count = columnCount(table);
  const newCol = [];
  let next = 0;
  for (let x = 0; x < count; x++) newCol[x] = cols.has(x) ? -1 : next++;
  const placed = [];
  for (const o of cellGrid(table)) {
    const kept = [];
    for (let x = o.col; x < o.col + o.span; x++) if (newCol[x] >= 0) kept.push(newCol[x]);
    if (kept.length) placed.push({ ...o, col: kept[0], span: kept.length });
  }
  const widths = table.widths?.length === count ? table.widths : null;
  if (widths) setWidths(table, widths.filter((_, i) => !cols.has(i)));
  else delete table.widths;
  rebuild(table, placed, table.rows.length);
  tidyRows(table);
}

function punch(cell) {
  const { indent, runs, ...para } = cell.paras[0] || {};
  cell.paras = [{ ...para, runs: [] }];
  delete cell.bg;
  delete cell.orig;
  cell.borders = [0, 0, 0, 0];
}

function clearCell(cell) {
  const { runs, ...para } = cell.paras[0] || {};
  cell.paras = [{ ...para, runs: [] }];
}

const CONTENT = ['paras', 'bg', 'borders', 'vAlign', 'orig'];
const contentOf = (cell) => Object.fromEntries(CONTENT.filter((key) => cell[key] !== undefined).map((key) => [key, cell[key]]));

function putContent(slot, content) {
  for (const key of CONTENT) {
    if (content[key] !== undefined) slot[key] = content[key];
    else delete slot[key];
  }
}

/** What stands after the cells taken out moves up the row, a merged cell keeping its place and taking new words. The row's end is left empty. */
function closeUp(table, doomed) {
  for (const row of table.rows) {
    const first = row.findIndex((cell) => doomed.has(cell));
    if (first < 0) continue;
    const slots = row.slice(first);
    const contents = slots.filter((cell) => !doomed.has(cell) && !isHole(cell)).map(contentOf);
    slots.forEach((slot, i) => {
      if (contents[i]) putContent(slot, contents[i]);
      else punch(slot);
    });
  }
}

/** The cell beside each one taken out grows over its place. Where none can, because it is merged differently, a hole is left. Says how many. */
function widenNeighbours(table, doomed) {
  let unfilled = 0;
  for (const cell of doomed) {
    const grid = cellGrid(table);
    const me = grid.find((o) => o.cell === cell);
    if (!me) continue;
    const beside = [grid.find((o) => o.r === me.r && o.col === me.col + me.span), grid.find((o) => o.r === me.r && o.col + o.span === me.col)]
      .filter((o) => o && o.rowSpan === me.rowSpan);
    const heir = beside.find((o) => !doomed.has(o.cell) && !isHole(o.cell)) || beside.find((o) => !isHole(o.cell)) || beside[0];
    if (!heir) {
      punch(cell);
      unfilled++;
      continue;
    }
    setSpans(heir.cell, heir.span + me.span, heir.rowSpan);
    const row = table.rows[me.r];
    row.splice(row.indexOf(cell), 1);
  }
  return unfilled;
}

/**
 * Takes cells out, near each other or far apart.
 * @param how 'close': the rest of the row moves up. 'widen': the cell beside it grows over it. 'hole': its place stays empty. 'clear': only its words go.
 * @returns renumbered: whether row numbers changed. unfilled: how many left a hole where 'widen' was asked for.
 */
export function removeCells(table, cells, how) {
  const note = { renumbered: false, unfilled: 0 };
  if (how === 'clear') {
    cells.forEach(clearCell);
    return note;
  }
  const doomed = new Set(cells);
  const grid = cellGrid(table);
  const gone = (o) => doomed.has(o.cell) || isHole(o.cell);
  const whole = (list) => list.length > 0 && list.every(gone) && list.some((o) => doomed.has(o.cell));
  const allOfIt = grid.every((o) => doomed.has(o.cell));
  // A row or a column with nothing left in it goes altogether, unless its place was asked to stay.
  if (how !== 'hole' || allOfIt) {
    const rows = new Set();
    const cols = new Set();
    table.rows.forEach((_, r) => {
      if (whole(grid.filter((o) => coversRow(o, r)))) rows.add(r);
    });
    for (let x = 0; x < columnCount(table); x++) {
      if (whole(grid.filter((o) => coversColumn(o, x)))) cols.add(x);
    }
    if (rows.size) note.renumbered = deleteRows(table, rows);
    if (cols.size) deleteColumns(table, cols);
  }
  const left = new Set(cellGrid(table).filter((o) => doomed.has(o.cell)).map((o) => o.cell));
  if (how === 'hole') left.forEach(punch);
  else if (how === 'close') closeUp(table, left);
  else note.unfilled = widenNeighbours(table, left);
  tidyRows(table);
  return note;
}

/** One way of taking something out, as the delete sheet names it. */
export function deleteFrom(table, cells, how) {
  if (how === 'rows') return { renumbered: deleteRows(table, rowsOf(table, cells)), unfilled: 0 };
  if (how === 'columns') {
    deleteColumns(table, columnsOf(table, cells));
    return { renumbered: false, unfilled: 0 };
  }
  return removeCells(table, cells, how);
}

/** Rows and columns with nothing in them. A row holding only its running number counts as empty. Says how many of each went. */
export function removeEmptyLines(table) {
  const grid = cellGrid(table);
  const blank = (cell) => !cellHasContent(cell) && !cell.bg;
  const counting = countingColumn(table)?.col;
  const rows = new Set();
  table.rows.forEach((_, r) => {
    if (grid.filter((o) => coversRow(o, r)).every((o) => blank(o.cell) || (o.col === counting && o.span === 1))) rows.add(r);
  });
  const cols = new Set();
  for (let x = 0; x < columnCount(table); x++) {
    if (grid.filter((o) => coversColumn(o, x)).every((o) => blank(o.cell))) cols.add(x);
  }
  // A table with nothing in it yet is about to be filled.
  if (rows.size === table.rows.length || cols.size === columnCount(table)) return { rows: 0, cols: 0 };
  if (rows.size) deleteRows(table, rows);
  if (cols.size) deleteColumns(table, cols);
  return { rows: rows.size, cols: cols.size };
}

/* ---------- Adding rows and columns ---------- */

/** A new row at a place in the table, shaped like the row beside it. Says whether row numbers had to change. */
export function insertRow(table, at, options) {
  return keepingCount(table, () => addRow(table, at, options));
}

/** A copy of a row, right under it. */
export function duplicateRow(table, r) {
  return keepingCount(table, () => addRow(table, r + 1, { from: r, copy: true }));
}

/** A new column at a place in the table. Column 0 is the rightmost. */
export function insertColumn(table, at) {
  const cols = columnCount(table);
  const count = table.rows.length;
  const model = at > 0 ? at - 1 : 0;
  const grid = cellGrid(table);
  const widths = table.widths?.length === cols ? table.widths : null;
  const fresh = [];
  for (let r = 0; r < count; r++) {
    const covering = grid.filter((o) => coversRow(o, r));
    // A merged cell crossing the place just grows by a column.
    if (covering.some((o) => o.col < at && o.col + o.span > at)) continue;
    const beside = covering.find((o) => coversColumn(o, model));
    fresh.push({ r, col: at, span: 1, rowSpan: 1, cell: beside ? blankLike(beside.cell) : { paras: [{ runs: [] }] } });
  }
  const placed = grid.map((o) => (o.col >= at ? { ...o, col: o.col + 1 } : o.col + o.span > at ? { ...o, span: o.span + 1 } : { ...o }));
  rebuild(table, [...placed, ...fresh], count);
  if (widths) {
    const next = [...widths];
    next.splice(at, 0, widths[model] ?? 100 / cols);
    setWidths(table, next);
  }
}

/* ---------- Merging ---------- */

/** Makes one cell of several, and of everything between them. The words stay, in reading order. Says how many cells became one. */
export function mergeCells(table, cells) {
  const grid = cellGrid(table);
  const picked = grid.filter((o) => cells.includes(o.cell));
  if (picked.length < 2) return 0;
  let top = Math.min(...picked.map((o) => o.r));
  let bottom = Math.max(...picked.map((o) => o.r + o.rowSpan));
  let start = Math.min(...picked.map((o) => o.col));
  let end = Math.max(...picked.map((o) => o.col + o.span));
  // A merged cell half inside comes in whole.
  for (let grew = true; grew;) {
    grew = false;
    for (const o of grid) {
      const inside = o.r < bottom && o.r + o.rowSpan > top && o.col < end && o.col + o.span > start;
      if (!inside) continue;
      if (o.r < top || o.r + o.rowSpan > bottom || o.col < start || o.col + o.span > end) {
        top = Math.min(top, o.r);
        bottom = Math.max(bottom, o.r + o.rowSpan);
        start = Math.min(start, o.col);
        end = Math.max(end, o.col + o.span);
        grew = true;
      }
    }
  }
  const inside = grid.filter((o) => o.r >= top && o.r + o.rowSpan <= bottom && o.col >= start && o.col + o.span <= end).sort((a, b) => a.r - b.r || a.col - b.col);
  const keeper = inside[0].cell;
  const heights = [];
  for (const o of inside) if ((o.rowSpan === 1) && o.cell.rowH) heights[o.r] = Math.max(heights[o.r] || 0, o.cell.rowH);
  const height = sum(heights.filter(Boolean));
  const words = inside.flatMap((o) => o.cell.paras).filter(paraHasContent);
  if (words.length) keeper.paras = words;
  else keeper.paras = [keeper.paras[0]];
  keeper.bg = keeper.bg || inside.map((o) => o.cell.bg).find(Boolean);
  if (!keeper.bg) delete keeper.bg;
  if (keeper.borders?.every((w) => !w)) delete keeper.borders;
  const others = new Set(inside.slice(1).map((o) => o.cell));
  table.rows = table.rows.map((row) => row.filter((cell) => !others.has(cell)));
  setSpans(keeper, end - start, bottom - top);
  tidyRows(table);
  if ((keeper.rowSpan || 1) === 1 && height) keeper.rowH = round2(height);
  else delete keeper.rowH;
  return inside.length;
}

/** A merged cell back into single cells. Its words stay in the first of them. */
export function unmergeCell(table, cell) {
  const grid = cellGrid(table);
  const me = grid.find((o) => o.cell === cell);
  if (!me || !isMerged(cell)) return false;
  const fresh = [];
  for (let y = me.r; y < Math.min(me.r + me.rowSpan, table.rows.length); y++) {
    for (let x = me.col; x < me.col + me.span; x++) {
      if (y === me.r && x === me.col) continue;
      fresh.push({ r: y, col: x, span: 1, rowSpan: 1, cell: blankLike({ ...cell, rowSpan: 1 }) });
    }
  }
  const placed = grid.map((o) => (o.cell === cell ? { ...o, span: 1, rowSpan: 1 } : { ...o }));
  rebuild(table, [...placed, ...fresh], table.rows.length);
  return true;
}

/* ---------- Numbers in the cells ---------- */

const NUMBER = /^([-−]?)\s*(\d{1,3}(?:[,٬]\d{3})+|\d+)(?:([.٫/])(\d+))?\s*(ریال|تومان|درصد|٪|%)?$/;

/** A number as people write it: Persian or Latin digits, thousands marked or not, «۱۷/۵» for seventeen and a half. Dates are not numbers. */
export function readNumber(words) {
  const text = String(words).trim();
  const m = NUMBER.exec(toEnDigits(text));
  if (!m) return null;
  const [, minus, whole, mark, part = '', unit = ''] = m;
  const digits = whole.replace(/[,٬]/g, '');
  // A slash is a decimal point only in something like a grade, or «۱۴۰۵/۰۱» would be a number.
  if (mark === '/' && (digits.length > 2 || part.length > 2)) return null;
  const value = Number(`${digits}.${part || 0}`) * (minus ? -1 : 1);
  return { value, decimals: part.length, mark: mark || '', grouped: digits !== whole, unit, latin: /[0-9]/.test(text) };
}

function formatTotal(numbers) {
  const decimals = Math.max(...numbers.map((n) => n.decimals));
  const [whole, part] = sum(numbers.map((n) => n.value)).toFixed(decimals).split('.');
  const shown = numbers.some((n) => n.grouped) ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, '٬') : whole;
  const mark = numbers.find((n) => n.mark)?.mark || '٫';
  const sameUnit = numbers.every((n) => n.unit === numbers[0].unit) ? numbers[0].unit : '';
  const unit = sameUnit && !/[٪%]/.test(sameUnit) ? ` ${sameUnit}` : sameUnit;
  const text = `${shown}${part ? `${mark}${part}` : ''}${unit}`;
  return numbers.every((n) => n.latin) ? text : toFaDigits(text);
}

const BOLD = { b: true };

/**
 * The sum of each of some columns, in a row of totals at the table's foot, made if there is none yet. Asking again brings the sums up to date.
 * Says how many columns had numbers.
 */
export function sumColumns(table, cols) {
  const hadTotal = isTotalRow(table.rows[table.rows.length - 1]);
  const end = table.rows.length - (hadTotal ? 1 : 0);
  const from = hasTitleRow(table) ? 1 : 0;
  const totals = new Map();
  for (const col of [...cols].sort((a, b) => a - b)) {
    const numbers = columnCells(table, col).slice(from, end).map((cell) => (cell ? readNumber(cellWords(cell)) : null)).filter(Boolean);
    if (numbers.length) totals.set(col, formatTotal(numbers));
  }
  if (!totals.size) return 0;
  if (!hadTotal) {
    const last = table.rows.length;
    addRow(table, last, { from: last - 1 });
    for (const cell of table.rows[last]) delete cell.bg;
    const first = Math.min(...totals.keys());
    // The word stands in the columns before the first sum, as one cell, or failing that in the first column with no sum.
    const row = cellGrid(table).filter((o) => o.r === last);
    const before = row.filter((o) => o.col + o.span <= first);
    if (before.length > 1) mergeCells(table, before.map((o) => o.cell));
    const label = before[0] || row.find((o) => ![...totals.keys()].some((col) => coversColumn(o, col)));
    if (label) setCellText(label.cell, 'جمع', { ...lookInRow(table.rows[last - 1]), ...BOLD });
  }
  const totalRow = table.rows.length - 1;
  for (const [col, text] of totals) {
    const cell = columnCells(table, col)[totalRow];
    if (cell) setCellText(cell, text, { ...lookInRow(table.rows[totalRow - 1]), ...BOLD });
  }
  return totals.size;
}

const foldLetters = (s) => s.replace(/ي/g, 'ی').replace(/ك/g, 'ک');

/**
 * Puts the rows in order by one column, the title and the totals staying where they are. Numbers go by size and words by Persian order;
 * empty cells stay last. Rows joined by a merged cell cannot be told apart, so a table with one is left as it is, and false comes back.
 */
export function sortRows(table, col, descending = false) {
  if (table.rows.some((row) => row.some((cell) => (cell.rowSpan || 1) > 1))) return false;
  keepingCount(table, () => {
    const from = hasTitleRow(table) ? 1 : 0;
    const end = table.rows.length - (isTotalRow(table.rows[table.rows.length - 1]) ? 1 : 0);
    const keyOf = (row) => {
      let x = 0;
      for (const cell of row) {
        const span = cell.colSpan || 1;
        if (col < x + span) {
          const text = cellWords(cell);
          return { text: foldLetters(text), number: readNumber(text)?.value ?? null };
        }
        x += span;
      }
      return { text: '', number: null };
    };
    const keyed = table.rows.slice(from, end).map((row) => ({ row, key: keyOf(row) }));
    const sign = descending ? -1 : 1;
    keyed.sort((a, b) => {
      if (!a.key.text || !b.key.text) return (a.key.text ? 0 : 1) - (b.key.text ? 0 : 1);
      if (a.key.number !== null && b.key.number !== null) return sign * (a.key.number - b.key.number);
      if (a.key.number !== null || b.key.number !== null) return sign * (a.key.number !== null ? -1 : 1);
      return sign * a.key.text.localeCompare(b.key.text, 'fa');
    });
    table.rows.splice(from, keyed.length, ...keyed.map((item) => item.row));
  });
  return true;
}

/* ---------- The table's whole look ---------- */

const TITLE_FILL = 'D9D9D9';
const STRIPE_FILL = 'F2F2F2';

/**
 * One tap for the whole table.
 * @param kind 'plain' | 'title' (a grey title row) | 'stripes' (and every other row lightly grey) | 'rules' (lines across only) | 'none' (no lines)
 * @param size the table's usual size of letters, which a cell's memory of itself needs
 */
export function dressTable(table, kind, size) {
  const titled = hasTitleRow(table);
  const from = titled ? 1 : 0;
  table.rows.forEach((row, r) => {
    row.forEach((cell) => {
      if (isHole(cell)) return;
      const stripe = kind === 'stripes' && r >= from && (r - from) % 2 === 1;
      const title = (kind === 'title' || kind === 'stripes') && titled && r === 0;
      restyleCell(cell, { bg: title ? TITLE_FILL : stripe ? STRIPE_FILL : null }, size);
      if (kind === 'rules') cell.borders = [0.5, 0, 0.5, 0];
      else delete cell.borders;
    });
  });
  if (kind === 'none') table.borderless = true;
  else delete table.borderless;
}

/* ---------- A table from words ---------- */

const SEPARATORS = [/\t/, /\s*\|\s*/, /\s*[;؛]\s*/, /\s*[,،]\s*/, / {2,}/];

/** Rows and columns from pasted words, such as a copy from a spreadsheet. Whatever stands between the words most evenly is what parts them. */
export function rowsFromText(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  // A line wrapped in bars, as a table is often typed, has nothing beyond its outer bars.
  const unbar = (line) => line.replace(/^\|\s*/, '').replace(/\s*\|$/, '');
  let rows = null;
  for (const separator of SEPARATORS) {
    const split = lines.map((line) => (separator.source.includes('|') ? unbar(line) : line).split(separator).map((word) => word.trim()));
    const counts = split.map((row) => row.length);
    const usual = counts.slice().sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    if (usual >= 2 && counts.filter((n) => n === usual).length >= Math.ceil(lines.length * 0.6)) {
      rows = split;
      break;
    }
  }
  rows = rows || lines.map((line) => [line]);
  const cols = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => [...row, ...Array(cols - row.length).fill('')]);
}

/* ---------- A table leaving the letter ---------- */

/** Tables are known by their order among tables, so those after one that leaves keep what was set for them under a new number. */
function shiftTableKeys(letter, gone) {
  if (!letter.offsets) return;
  const next = {};
  for (const [key, value] of Object.entries(letter.offsets)) {
    const m = /^table:(\d+)$/.exec(key);
    if (!m || Number(m[1]) < gone) next[key] = value;
    else if (Number(m[1]) > gone) next[`table:${Number(m[1]) - 1}`] = value;
  }
  letter.offsets = next;
}

export function dropTable(letter, table) {
  const gone = letter.body.filter((b) => b.kind === 'table').indexOf(table);
  if (gone < 0) return;
  letter.body = letter.body.filter((b) => b !== table);
  shiftTableKeys(letter, gone);
}

/** Takes out any table with no rows left. */
export function dropEmptyTables(letter) {
  for (const table of letter.body.filter((b) => b.kind === 'table' && !b.rows.length)) dropTable(letter, table);
}
