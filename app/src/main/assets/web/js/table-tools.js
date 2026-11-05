// The sheets of a table. One swaps columns, rows or single cells: tap one, tap the other, done. It swaps what the cells hold, not the
// cells themselves, so a table with merged cells keeps its shape. Another takes out rows, columns and cells. The largest holds a small
// picture of the table, where any cells can be picked, far apart if need be, and everything that can be done to them.

import { h, toast } from './util.js';
import { icon } from './icons.js';
import { app, confirmSheet, openSheet, segmented } from './app.js';
import { geomOf, lineRatio, styleOf } from './model.js';
import { MM } from './render.js';
import { toFaDigits } from './text.js';
import { addCountingColumn, autoRowHeight, cellWords, cellsInColumns, cellsInRows, columnCount, columnsOf, countingColumn, deleteFrom, dressTable, dropTable, duplicateRow, equalColumns, fitColumns, insertColumn, insertRow, isHole, isMerged, mergeCells, numberColumn, removeEmptyLines, resizeColumns, resizeRows, rowsFromText, rowsOf, sortRows, sumColumns, unmergeCell, widthsOf } from './table-edit.js';
import { cellGrid } from './restyle.js';

const fa = (n) => toFaDigits(String(n));

/** A matrix of the table's real columns and rows, where a merged cell fills every place it covers. */
function gridOf(rows) {
  const grid = rows.map(() => []);
  rows.forEach((row, r) => {
    let c = 0;
    for (const cell of row) {
      while (grid[r][c]) c++;
      for (let i = 0; i < (cell.rowSpan || 1) && r + i < rows.length; i++) {
        for (let j = 0; j < (cell.colSpan || 1); j++) grid[r + i][c + j] = cell;
      }
      c += cell.colSpan || 1;
    }
  });
  return grid;
}

function swapContent(a, b) {
  [a.paras, b.paras] = [b.paras, a.paras];
  const bg = a.bg;
  if (b.bg) a.bg = b.bg;
  else delete a.bg;
  if (bg) b.bg = bg;
  else delete b.bg;
}

export function swapColumns(table, a, b, { keepHeader = false } = {}) {
  const grid = gridOf(table.rows);
  const done = new Set();
  for (let r = keepHeader ? 1 : 0; r < grid.length; r++) {
    const x = grid[r][a];
    const y = grid[r][b];
    if (!x || !y || x === y || done.has(x) || done.has(y)) continue;
    swapContent(x, y);
    done.add(x);
    done.add(y);
  }
  // Whole columns take their widths along; only the data changing places leaves the columns as they are.
  if (!keepHeader && table.widths?.[a] !== undefined && table.widths?.[b] !== undefined) {
    [table.widths[a], table.widths[b]] = [table.widths[b], table.widths[a]];
  }
}

export function swapRows(table, a, b) {
  const grid = gridOf(table.rows);
  const done = new Set();
  const cols = Math.max(grid[a]?.length || 0, grid[b]?.length || 0);
  for (let c = 0; c < cols; c++) {
    const x = grid[a]?.[c];
    const y = grid[b]?.[c];
    if (!x || !y || x === y || done.has(x) || done.has(y)) continue;
    swapContent(x, y);
    done.add(x);
    done.add(y);
  }
}

export function swapCells(table, r1, c1, r2, c2) {
  const grid = gridOf(table.rows);
  const x = grid[r1]?.[c1];
  const y = grid[r2]?.[c2];
  if (x && y && x !== y) swapContent(x, y);
}

const cellText = (cell) => cell.paras.map((p) => (p.runs || []).map((r) => r.text || '').join('')).join(' ').trim();

const HINTS = {
  column: 'روی یک خانه از هر دو ستون بزن تا جایشان عوض شود.',
  row: 'روی یک خانه از هر دو سطر بزن تا جایشان عوض شود.',
  cell: 'روی دو خانه بزن تا محتوایشان عوض شود.',
};

/**
 * @param table a table block of the letter, changed in place
 * @param before called before each change
 * @param after called after each change
 */
export function openTableSwapSheet(table, { before, after }) {
  let mode = 'column';
  let keepHeader = table.rows.length > 1;
  let picked = null;
  const undoStack = [];

  const hint = h('p', { class: 'note', style: { margin: 0 } });
  const gridBox = h('div', { class: 'swap-box' });
  const headerOption = h('label', { class: 'check-row' });
  const undoBtn = h('button', { class: 'btn', onClick: undoSwap }, 'برگرداندن');

  function snapshot() {
    return JSON.stringify({ rows: table.rows, widths: table.widths });
  }

  function apply(change) {
    before?.();
    undoStack.push(snapshot());
    change();
    picked = null;
    after?.();
    paint();
    toast('جابه‌جا شد');
  }

  function undoSwap() {
    const saved = undoStack.pop();
    if (!saved) return;
    before?.();
    const { rows, widths } = JSON.parse(saved);
    table.rows = rows;
    if (widths) table.widths = widths;
    picked = null;
    after?.();
    paint();
  }

  function tap(r, c) {
    if (!picked) {
      picked = { r, c };
      paint();
      return;
    }
    const same = mode === 'column' ? picked.c === c : mode === 'row' ? picked.r === r : picked.r === r && picked.c === c;
    if (same) {
      picked = null;
      paint();
      return;
    }
    const first = picked;
    apply(() => {
      if (mode === 'column') swapColumns(table, first.c, c, { keepHeader });
      else if (mode === 'row') swapRows(table, first.r, r);
      else swapCells(table, first.r, first.c, r, c);
    });
  }

  function isPicked(r, c, span, rowSpan) {
    if (!picked) return false;
    if (mode === 'column') return picked.c >= c && picked.c < c + span && !(keepHeader && r === 0);
    if (mode === 'row') return picked.r >= r && picked.r < r + rowSpan;
    return picked.r === r && picked.c === c;
  }

  function paint() {
    hint.textContent = HINTS[mode];
    undoBtn.disabled = !undoStack.length;
    headerOption.hidden = mode !== 'column' || table.rows.length < 2;
    const grid = gridOf(table.rows);
    const rows = table.rows.map((row, r) => {
      const seenBefore = new Set();
      const cells = [];
      for (let c = 0; c < (grid[r]?.length || 0); c++) {
        const cell = grid[r][c];
        if (seenBefore.has(cell) || !row.includes(cell)) continue;
        seenBefore.add(cell);
        const span = cell.colSpan || 1;
        const rowSpan = cell.rowSpan || 1;
        cells.push(h(
          'td',
          {
            colspan: span > 1 ? span : null,
            rowspan: rowSpan > 1 ? rowSpan : null,
            class: isPicked(r, c, span, rowSpan) ? 'picked' : null,
            onClick: () => tap(r, c),
          },
          cellText(cell) || '—',
        ));
      }
      return h('tr', null, cells);
    });
    gridBox.replaceChildren(h('table', { class: 'swap-grid' }, h('tbody', null, rows)));
  }

  const headerBox = h('input', {
    type: 'checkbox',
    onChange: (e) => {
      keepHeader = e.target.checked;
      picked = null;
      paint();
    },
  });
  headerBox.checked = keepHeader;
  headerOption.append(headerBox, 'سطر عنوان سر جایش بماند (فقط اطلاعات زیر آن جابه‌جا شود)');

  openSheet(
    'جابه‌جایی در جدول',
    h(
      'div',
      { class: 'form-grid' },
      segmented(
        [
          { id: 'column', label: 'ستون' },
          { id: 'row', label: 'سطر' },
          { id: 'cell', label: 'خانه' },
        ],
        mode,
        (value) => {
          mode = value;
          picked = null;
          paint();
        },
      ),
      headerOption,
      hint,
      gridBox,
      undoBtn,
    ),
  );
  paint();
}

/* ---------- Taking things out ---------- */

/* Small pictures of what each way of taking out leaves behind. Three columns and two rows, the first cell on the right. */
const box = (col, row, span = 1, kind = 'pic-cell') => `<rect class="${kind}" x="${col * 16 + 1}" y="${row * 14 + 1}" width="${span * 16}" height="14"/>`;
const bar = (col, row, span = 1) => `<path class="pic-bar" d="M${col * 16 + 5} ${row * 14 + 8}h${span * 16 - 8}"/>`;
const full = (row) => [0, 1, 2].map((col) => box(col, row) + bar(col, row)).join('');
const PICTURES = {
  rows: `${box(0, 0, 3, 'pic-gone')}${full(0)}${full(1)}`,
  columns: `${box(1, 0, 1, 'pic-gone')}${box(1, 1, 1, 'pic-gone')}${full(0)}${full(1)}`,
  close: `${box(0, 0, 1, 'pic-gap')}${box(1, 0)}${bar(1, 0)}${box(2, 0)}${bar(2, 0)}${full(1)}`,
  widen: `${box(0, 0, 2)}${bar(0, 0, 2)}${box(2, 0)}${bar(2, 0)}${full(1)}`,
  hole: `${box(0, 0)}${bar(0, 0)}${box(1, 0, 1, 'pic-gap')}${box(2, 0)}${bar(2, 0)}${full(1)}`,
  clear: `${box(0, 0)}${bar(0, 0)}${box(1, 0)}${box(2, 0)}${bar(2, 0)}${full(1)}`,
  empty: `${box(0, 1, 3, 'pic-gone')}${full(0)}${[0, 1, 2].map((col) => box(col, 1)).join('')}`,
  table: `${box(0, 0, 3, 'pic-gone')}${box(0, 1, 3, 'pic-gone')}${full(0)}${full(1)}`,
};

function picture(kind) {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="del-pic" viewBox="0 0 50 30" aria-hidden="true">${PICTURES[kind]}</svg>`;
  return span.firstChild;
}

function choice(kind, title, note, onPick, { disabled = false, danger = false } = {}) {
  return h(
    'button',
    { class: `sheet-action del-choice${danger ? ' danger' : ''}`, disabled, dataset: { how: kind }, onClick: onPick },
    picture(kind),
    h('span', { class: 'action-text' }, h('b', null, title), note && h('small', null, note)),
  );
}

/** The ways of taking out what is picked. */
function deleteChoices({ cells, rows, cols, onPick, none = false }) {
  const these = cells > 1 ? `این ${fa(cells)} خانه` : 'این خانه';
  return [
    choice('rows', rows > 1 ? `حذف ${fa(rows)} سطر` : 'حذف این سطر', cells > 1 && rows === 1 ? 'سطری که این خانه‌ها در آن هستند' : null, () => onPick('rows'), { disabled: none }),
    choice('columns', cols > 1 ? `حذف ${fa(cols)} ستون` : 'حذف این ستون', cells > 1 && cols === 1 ? 'ستونی که این خانه‌ها در آن هستند' : null, () => onPick('columns'), { disabled: none }),
    h('div', { class: 'del-label' }, `فقط ${these}:`),
    choice('close', 'خانه‌های کناری جمع شوند', 'بقیهٔ سطر جلو می‌آید و ته سطر خالی می‌ماند', () => onPick('close'), { disabled: none }),
    choice('widen', 'خانهٔ کناری پهن شود', 'سطر پر می‌ماند', () => onPick('widen'), { disabled: none }),
    choice('hole', 'جایش خالی بماند', 'خط‌هایش هم می‌رود و چیزی جابه‌جا نمی‌شود', () => onPick('hole'), { disabled: none }),
    choice('clear', 'فقط متنش پاک شود', 'خانه سر جایش می‌ماند', () => onPick('clear'), { disabled: none }),
  ];
}

/** What to tell the user after something was taken out, beyond what can be seen. */
export function deleteNote(notes) {
  if (notes.some((note) => note.unfilled)) return 'کنار بعضی خانه‌ها خانهٔ هم‌اندازه نبود و جایشان خالی ماند';
  if (notes.some((note) => note.renumbered)) return 'ردیف‌ها دوباره شماره خوردند';
  return 'حذف شد';
}

/**
 * Asks how to take out some cells.
 * @param targets [{table, cells}], table by table
 * @param onPick called with the way chosen
 * @param onWholeTable offered when one table is in question
 */
export function openDeleteSheet(targets, { onPick, onWholeTable }) {
  const cells = targets.reduce((n, t) => n + t.cells.length, 0);
  const rows = targets.reduce((n, t) => n + rowsOf(t.table, t.cells).size, 0);
  const cols = targets.reduce((n, t) => n + columnsOf(t.table, t.cells).size, 0);
  const close = openSheet(
    'حذف از جدول',
    h(
      'div',
      { class: 'del-list' },
      deleteChoices({
        cells,
        rows,
        cols,
        onPick: (how) => {
          close();
          onPick(how);
        },
      }),
      onWholeTable && choice('table', 'حذف کل جدول', null, () => {
        close();
        onWholeTable();
      }, { danger: true }),
    ),
  );
  return close;
}

/* ---------- Everything in one sheet ---------- */

const KEPT = ['rows', 'widths', 'widthPct', 'tableAlign', 'header', 'borderless'];

const LOOKS = [
  { id: 'plain', label: 'ساده' },
  { id: 'title', label: 'سرستون خاکستری' },
  { id: 'stripes', label: 'راه‌راه' },
  { id: 'rules', label: 'فقط خط افقی' },
  { id: 'none', label: 'بدون خط' },
];

const TABS = [
  { id: 'delete', label: 'حذف' },
  { id: 'add', label: 'افزودن' },
  { id: 'shape', label: 'شکل' },
  { id: 'data', label: 'داده' },
];

/** How wide some words are on the page, in millimetres. */
function wordMeasure() {
  const st = styleOf(app.letter, 'table');
  const context = document.createElement('canvas').getContext('2d');
  context.font = `${st.size}pt "${st.font}", "B Nazanin", "Tinos", "Vazirmatn", serif`;
  return (text) => context.measureText(text).width / MM;
}

/** How tall a row is on the page now, wherever the page is showing. */
function shownRowHeight(table, r) {
  const n = (app.letter.body || []).filter((b) => b.kind === 'table').indexOf(table);
  const cells = document.querySelectorAll(`[data-section="table:${n}"] td[data-r="${r}"]:not([rowspan])`);
  for (const td of cells) if (td.offsetHeight) return td.offsetHeight / MM;
  const st = styleOf(app.letter, 'table');
  return (lineRatio(st.font, st.bold) * st.spacing * st.size * 96) / 72 / MM;
}

/**
 * @param table a table block of the letter, changed in place
 * @param before called before each change
 * @param after called after each change
 * @param picked cells picked to begin with
 * @param tab the part to show first
 */
export function openTableSheet(table, { before, after, picked = [], tab: firstTab = 'delete' }) {
  let tab = firstTab;
  let picks = new Set(picked);
  const undoStack = [];

  const status = h('p', { class: 'note pick-status' });
  const gridBox = h('div', { class: 'swap-box pick-box' });
  const pickRow = h('div', { class: 'tool-choices' });
  const tabBody = h('div', { class: 'pick-tab' });
  const undoBtn = h('button', { class: 'btn small', onClick: undoStep }, icon('undo'), 'برگرداندن');

  const pickedCells = () => [...picks];
  const snapshot = () => JSON.stringify(Object.fromEntries(KEPT.map((key) => [key, table[key]])));
  let close = () => {};

  function apply(change, message) {
    before?.();
    undoStack.push(snapshot());
    const said = change();
    after?.();
    paint();
    const words = typeof message === 'function' ? message(said) : message;
    if (words) toast(words);
  }

  function undoStep() {
    const saved = undoStack.pop();
    if (!saved) return;
    before?.();
    const back = JSON.parse(saved);
    for (const key of KEPT) {
      if (back[key] === undefined) delete table[key];
      else table[key] = back[key];
    }
    picks = new Set();
    after?.();
    paint();
  }

  /** The table leaves the letter. Taking everything out of it comes to the same, so the same question is asked. */
  function removeWholeTable() {
    confirmSheet('حذف جدول', 'کل این جدول از نامه برداشته می‌شود.', 'حذف شود', () => {
      before?.();
      dropTable(app.letter, table);
      close();
      after?.();
      toast('جدول حذف شد');
    });
  }

  const wouldEmpty = (how) => {
    const cells = pickedCells();
    if (how === 'rows') return rowsOf(table, cells).size >= table.rows.length;
    if (how === 'columns') return columnsOf(table, cells).size >= columnCount(table);
    return (how === 'close' || how === 'widen') && cellGrid(table).every((o) => picks.has(o.cell));
  };

  function deleteBy(how) {
    if (wouldEmpty(how)) {
      removeWholeTable();
      return;
    }
    const cells = pickedCells();
    apply(() => deleteFrom(table, cells, how), (note) => deleteNote([note]));
  }

  function toggle(cell) {
    if (picks.has(cell)) picks.delete(cell);
    else picks.add(cell);
    paint();
  }

  const pickAll = (cells) => {
    cells.forEach((cell) => picks.add(cell));
    paint();
  };

  function paintGrid() {
    const cols = columnCount(table);
    const list = h('table', { class: 'swap-grid pick-grid', style: { width: `max(100%, ${cols * 52}px)` } },
      h('colgroup', null, widthsOf(table).map((w) => h('col', { style: { width: `${w}%` } }))),
      h('tbody', null, table.rows.map((row, r) => h('tr', null, row.map((cell, c) => h(
        'td',
        {
          colspan: cell.colSpan > 1 ? cell.colSpan : null,
          rowspan: cell.rowSpan > 1 ? cell.rowSpan : null,
          class: [picks.has(cell) && 'picked', isHole(cell) && 'hole'].filter(Boolean).join(' ') || null,
          dataset: { r, c },
          onClick: () => toggle(cell),
        },
        h('div', { class: 'pick-text' }, cellWords(cell)),
      ))))),
    );
    gridBox.replaceChildren(list);
  }

  function paintPickRow() {
    const none = !picks.size;
    const button = (label, onClick, disabled) => h('button', { class: 'btn small', disabled, onClick }, label);
    pickRow.replaceChildren(
      button('کل سطر', () => pickAll(cellsInRows(table, rowsOf(table, pickedCells()))), none),
      button('کل ستون', () => pickAll(cellsInColumns(table, columnsOf(table, pickedCells()))), none),
      button('همه', () => pickAll(table.rows.flat()), false),
      button('هیچ‌کدام', () => {
        picks = new Set();
        paint();
      }, none),
    );
  }

  const small = (label, onClick, { disabled = false, on = false, primary = false } = {}) => h('button', { class: `btn small${on ? ' toggle on' : ''}${primary ? ' primary' : ''}`, disabled, onClick }, label);

  /** The first place the picks stand in, and the last, in rows and in columns. */
  function reach() {
    const grid = cellGrid(table).filter((o) => picks.has(o.cell));
    if (!grid.length) return null;
    return {
      top: Math.min(...grid.map((o) => o.r)),
      bottom: Math.max(...grid.map((o) => o.r + o.rowSpan)),
      start: Math.min(...grid.map((o) => o.col)),
      end: Math.max(...grid.map((o) => o.col + o.span)),
    };
  }

  function paintDelete() {
    const cells = pickedCells();
    tabBody.replaceChildren(
      h(
        'div',
        { class: 'del-list' },
        deleteChoices({ cells: cells.length, rows: rowsOf(table, cells).size, cols: columnsOf(table, cells).size, onPick: deleteBy, none: !cells.length }),
        choice('empty', 'حذف سطرها و ستون‌های خالی', null, () => apply(() => removeEmptyLines(table), (gone) => (gone.rows || gone.cols ? `${fa(gone.rows)} سطر و ${fa(gone.cols)} ستون خالی حذف شد` : 'سطر یا ستون خالی‌ای نبود'))),
        choice('table', 'حذف کل جدول', null, removeWholeTable, { danger: true }),
      ),
    );
  }

  function paintAdd() {
    const at = reach();
    const rowCount = table.rows.length;
    const cols = columnCount(table);
    const say = (renumbered) => (renumbered ? 'ردیف‌ها دوباره شماره خوردند' : null);
    tabBody.replaceChildren(
      h(
        'div',
        { class: 'form-grid' },
        h(
          'div',
          { class: 'pick-actions' },
          small('سطر بالا', () => apply(() => insertRow(table, at ? at.top : 0), say)),
          small('سطر پایین', () => apply(() => insertRow(table, at ? at.bottom : rowCount), say)),
          small('ستون راست', () => apply(() => insertColumn(table, at ? at.start : 0))),
          small('ستون چپ', () => apply(() => insertColumn(table, at ? at.end : cols))),
          small('تکرار همین سطر', () => apply(() => duplicateRow(table, at.bottom - 1), say), { disabled: !at }),
          small('ستون ردیف تازه', () => apply(() => addCountingColumn(table), 'ستون ردیف اضافه شد'), { disabled: !!countingColumn(table) }),
        ),
        h('p', { class: 'note', style: { margin: 0 } }, at ? 'جای تازه کنار خانه‌های انتخاب‌شده باز می‌شود.' : 'اگر خانه‌ای انتخاب نکنی، جای تازه در ابتدا یا انتهای جدول باز می‌شود.'),
      ),
    );
  }

  function stepper(label, value, onLess, onMore, disabled) {
    return h(
      'div',
      { class: 'stepper pick-stepper' },
      h('span', { class: 'grow' }, label),
      h('button', { class: 'icon-btn', 'aria-label': `کم کردن ${label}`, disabled, onClick: onLess }, icon('minus')),
      h('b', null, value),
      h('button', { class: 'icon-btn', 'aria-label': `زیاد کردن ${label}`, disabled, onClick: onMore }, icon('plus')),
    );
  }

  function paintShape() {
    const cells = pickedCells();
    const cols = columnsOf(table, cells);
    const rows = rowsOf(table, cells);
    const widths = widthsOf(table);
    const firstCol = [...cols].sort((a, b) => a - b)[0];
    const firstRow = [...rows].sort((a, b) => a - b)[0];
    const merged = cells.filter(isMerged);
    const own = firstRow === undefined ? 0 : Math.max(0, ...(table.rows[firstRow] || []).map((cell) => cell.rowH || 0));
    const width = (delta) => apply(() => resizeColumns(table, cols, delta), (fine) => (fine === false ? 'جای بیشتری نیست' : null));
    const height = (delta) => apply(() => resizeRows(table, rows, delta, (r) => shownRowHeight(table, r)));
    const headerBox = h('input', {
      type: 'checkbox',
      onChange: (e) => apply(() => { table.header = e.target.checked; }),
    });
    headerBox.checked = table.header !== false;
    tabBody.replaceChildren(
      h(
        'div',
        { class: 'form-grid' },
        h(
          'div',
          { class: 'pick-actions' },
          small('یکی کردن خانه‌ها', () => {
            const list = pickedCells();
            apply(() => mergeCells(table, list), (n) => `${fa(n)} خانه یکی شد`);
          }, { disabled: cells.length < 2 }),
          small('جدا کردن خانهٔ ادغام‌شده', () => apply(() => merged.forEach((cell) => unmergeCell(table, cell)), 'خانه جدا شد'), { disabled: !merged.length }),
        ),
        stepper('پهنای ستون', firstCol === undefined ? '—' : `${fa(Math.round(widths[firstCol]))}٪`, () => width(-2), () => width(2), !cells.length),
        stepper('ارتفاع سطر', firstRow === undefined ? '—' : own ? `${fa(Math.round(own))} میلی‌متر` : 'خودکار', () => height(-2), () => height(2), !cells.length),
        h(
          'div',
          { class: 'pick-actions' },
          small('ستون‌ها مساوی', () => apply(() => equalColumns(table))),
          small('پهنا به‌قدر متن', () => apply(() => {
            const g = geomOf(app.letter);
            fitColumns(table, { measure: wordMeasure(), widthMm: (g.bodyW * (table.widthPct || 100)) / 100 });
          })),
          small('ارتفاع خودکار', () => apply(() => autoRowHeight(table, rows)), { disabled: !own }),
        ),
        h('label', { class: 'check-row' }, headerBox, 'سطر اول، عنوان جدول است (پررنگ و تکرار در صفحهٔ بعد)'),
        h('div', { class: 'mini-label' }, 'ظاهر کل جدول'),
        h('div', { class: 'pick-actions' }, LOOKS.map((look) => small(look.label, () => apply(() => dressTable(table, look.id, styleOf(app.letter, 'table').size))))),
      ),
    );
  }

  function paintData() {
    const cells = pickedCells();
    const cols = columnsOf(table, cells);
    const none = !cols.size;
    const firstCol = [...cols].sort((a, b) => a - b)[0];
    const sortBy = (descending) => apply(() => sortRows(table, firstCol, descending), (fine) => (fine ? 'مرتب شد' : 'جدولی که خانه‌های چندسطری دارد مرتب نمی‌شود'));
    tabBody.replaceChildren(
      h(
        'div',
        { class: 'form-grid' },
        h(
          'div',
          { class: 'pick-actions' },
          small('شماره‌گذاری این ستون', () => apply(() => numberColumn(table, firstCol), (n) => `${fa(n)} ردیف شماره خورد`), { disabled: none }),
          small('مرتب از کم به زیاد / الف تا ی', () => sortBy(false), { disabled: none }),
          small('مرتب از زیاد به کم / ی تا الف', () => sortBy(true), { disabled: none }),
          small('جمع این ستون', () => {
            const list = new Set(cols);
            apply(() => sumColumns(table, list), (n) => (n ? 'جمع در سطر آخر نوشته شد' : 'در این ستون عددی پیدا نشد'));
          }, { disabled: none }),
          h('button', {
            class: 'btn small',
            onClick: () => {
              close();
              openTableSwapSheet(table, { before, after });
            },
          }, icon('swap'), 'جابه‌جایی ستون و سطر'),
        ),
        h('p', { class: 'note', style: { margin: 0 } }, none ? 'اول یک خانه از ستون موردنظر را انتخاب کن.' : 'ردیف‌ها بعد از حذف، افزودن و مرتب کردن سطرها خودشان درست می‌شوند.'),
      ),
    );
  }

  function paint() {
    const inTable = new Set(table.rows.flat());
    picks = new Set([...picks].filter((cell) => inTable.has(cell)));
    status.textContent = picks.size ? `${fa(picks.size)} خانه انتخاب شده` : 'روی خانه‌ها بزن تا انتخاب شوند؛ لازم نیست کنار هم باشند.';
    undoBtn.disabled = !undoStack.length;
    paintGrid();
    paintPickRow();
    if (tab === 'delete') paintDelete();
    else if (tab === 'add') paintAdd();
    else if (tab === 'shape') paintShape();
    else paintData();
  }

  close = openSheet(
    'ابزار جدول',
    h(
      'div',
      { class: 'form-grid table-sheet' },
      gridBox,
      h('div', { class: 'pick-head' }, status, undoBtn),
      pickRow,
      segmented(TABS, tab, (value) => {
        tab = value;
        paint();
      }),
      tabBody,
    ),
  );
  paint();
  return close;
}

/* ---------- A table from words pasted ---------- */

/** @param onInsert called with the rows of words */
export function openPasteTableSheet(onInsert) {
  const field = h('textarea', { class: 'textarea', dir: 'rtl', rows: '6', placeholder: 'سطرها را از اکسل، تلگرام یا هر جای دیگر اینجا بچسبان.' });
  const note = h('p', { class: 'note', style: { margin: 0 } });
  const preview = h('div', { class: 'swap-box pick-box' });
  const go = h('button', {
    class: 'btn primary',
    onClick: () => {
      const rows = rowsFromText(field.value);
      if (!rows.length) return;
      close();
      onInsert(rows);
    },
  }, 'درج جدول');
  const paint = () => {
    const rows = rowsFromText(field.value);
    go.disabled = !rows.length;
    note.textContent = rows.length ? `${fa(rows.length)} سطر و ${fa(rows[0].length)} ستون` : 'ستون‌ها می‌توانند با Tab، کاما، نقطه‌ویرگول یا خط عمودی جدا شده باشند.';
    preview.replaceChildren(rows.length ? h('table', { class: 'swap-grid pick-grid' }, h('tbody', null, rows.slice(0, 30).map((row) => h('tr', null, row.map((word) => h('td', null, h('div', { class: 'pick-text' }, word))))))) : '');
  };
  field.addEventListener('input', paint);
  const close = openSheet('جدول از متن', h('div', { class: 'form-grid' }, field, note, preview, go));
  paint();
  field.focus();
  return close;
}
