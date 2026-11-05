// The table's shape and data, on the model alone: taking out rows, columns and cells, far apart and merged, adding, merging,
// widths, row numbers, totals, sorting and tables from pasted words.
//   node tools/table-edit-test.js
import { addCountingColumn, cellWords, columnCount, countingColumn, deleteColumns, deleteFrom, deleteRows, dropEmptyTables, dropTable, duplicateRow, dressTable, equalColumns, fitColumns, insertColumn, insertRow, isHole, mergeCells, numberColumn, placeOfCell, readNumber, removeCells, removeEmptyLines, resizeColumns, resizeRows, rowsFromText, sortRows, sumColumns, unmergeCell } from '../app/src/main/assets/web/js/table-edit.js';
import { cellGrid } from '../app/src/main/assets/web/js/restyle.js';

let failed = 0;
let total = 0;
function check(name, ok, detail = '') {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== '' ? `: ${JSON.stringify(detail)}` : ''}`);
}

const cell = (text, extra) => ({ paras: [{ runs: text ? [{ text }] : [] }], ...extra });
/** A table from rows of words. «A^2» takes two columns, «A_2» two rows, and «A^2_3» both. */
function table(rows, extra) {
  return {
    kind: 'table',
    header: true,
    ...extra,
    rows: rows.map((row) => row.map((word) => {
      const [, text, across, down] = /^([^^_]*)(?:\^(\d+))?(?:_(\d+))?$/.exec(word);
      return cell(text, { ...(across && { colSpan: Number(across) }), ...(down && { rowSpan: Number(down) }) });
    })),
  };
}
const words = (t) => t.rows.map((row) => row.map((c) => `${cellWords(c)}${c.colSpan ? `^${c.colSpan}` : ''}${c.rowSpan ? `_${c.rowSpan}` : ''}${isHole(c) ? '○' : ''}`));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const at = (t, r, c) => t.rows[r][c];
/** Every row of the table must fill the same columns, with no overlaps: what the page and Word both rely on. */
function rectangular(t) {
  const cols = columnCount(t);
  const used = t.rows.map(() => Array(cols).fill(0));
  for (const o of cellGrid(t)) {
    for (let y = o.r; y < o.r + o.rowSpan; y++) {
      for (let x = o.col; x < o.col + o.span; x++) {
        if (y >= t.rows.length || x >= cols) return false;
        used[y][x]++;
      }
    }
  }
  return used.every((row) => row.every((n) => n === 1));
}
const sum100 = (w) => Math.abs(w.reduce((a, b) => a + b, 0) - 100) < 0.011;

/* ---------- Rows ---------- */
{
  const t = table([['ردیف', 'نام'], ['۱', 'علی'], ['۲', 'رضا'], ['۳', 'سارا']]);
  const renumbered = deleteRows(t, new Set([2]));
  check('a row goes, and the rows after it count again', same(words(t), [['ردیف', 'نام'], ['۱', 'علی'], ['۲', 'سارا']]) && renumbered, words(t));
  check('the title row stays the title', t.header === true);
}
{
  const t = table([['نام', 'سن'], ['علی', '۲۰'], ['رضا', '۳۰']]);
  deleteRows(t, new Set([0]));
  check('with the title row gone, the next row is not made a title', t.header === false && same(words(t), [['علی', '۲۰'], ['رضا', '۳۰']]), { header: t.header, w: words(t) });
}
{
  const t = table([['نام', 'سن'], ['علی', '۲۰'], ['رضا', '۳۰'], ['سارا', '۴۰']]);
  deleteRows(t, new Set([1, 3]));
  check('rows far apart go together', same(words(t), [['نام', 'سن'], ['رضا', '۳۰']]), words(t));
}
{
  const t = table([['گروه_3', 'الف'], ['ب'], ['ج'], ['د', 'ه']]);
  deleteRows(t, new Set([0]));
  check('a merged cell that began in a row going away moves down with its words', same(words(t), [['گروه_2', 'ب'], ['ج'], ['د', 'ه']]) && rectangular(t), words(t));
  deleteRows(t, new Set([1]));
  check('a merged cell loses the row it no longer covers', same(words(t), [['گروه', 'ب'], ['د', 'ه']]) && rectangular(t), words(t));
}
{
  const t = table([['x', 'y'], ['z', 'w']]);
  deleteRows(t, new Set([0, 1]));
  const letter = { body: [t], offsets: {} };
  dropEmptyTables(letter);
  check('with no row left the table is gone from the letter', letter.body.length === 0, letter.body.length);
}

/* ---------- Columns ---------- */
{
  const t = table([['a', 'b', 'c'], ['d', 'e', 'f']], { widths: [20, 30, 50] });
  deleteColumns(t, new Set([1]));
  check('a column goes', same(words(t), [['a', 'c'], ['d', 'f']]), words(t));
  check('the table stays as wide as the text, the others sharing its width', same(t.widths, [28.57, 71.43]) && t.widthPct === undefined, t.widths);
}
{
  const t = table([['a', 'b', 'c'], ['d', 'e', 'f']], { widths: [20, 30, 50], pad: 0 });
  deleteColumns(t, new Set([1]));
  check('in a form the others keep their real width and the table gets narrower', same(t.widths, [28.57, 71.43]) && t.widthPct === 70, { w: t.widths, pct: t.widthPct });
}
{
  const t = table([['عنوان^3'], ['a', 'b', 'c'], ['d^2', 'e']]);
  deleteColumns(t, new Set([0]));
  check('merged cells lose only what they covered', same(words(t), [['عنوان^2'], ['b', 'c'], ['d', 'e']]) && rectangular(t), words(t));
  deleteColumns(t, new Set([1]));
  check('and stop being merged when one column is left', same(words(t), [['عنوان'], ['b'], ['d']]) && rectangular(t), words(t));
}
{
  const t = table([['a_2', 'b', 'c'], ['d', 'e']]);
  deleteColumns(t, new Set([0]));
  check('a tall cell goes with its column', same(words(t), [['b', 'c'], ['d', 'e']]) && rectangular(t), words(t));
}
{
  const t = table([['a', 'b'], ['c', 'd']]);
  deleteColumns(t, new Set([0, 1]));
  check('with no column left there is no row either', t.rows.length === 0, t.rows);
}

/* ---------- A cell, or several far apart ---------- */
{
  const t = table([['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h']]);
  removeCells(t, [at(t, 0, 1)], 'close');
  check('closing up: what follows moves up the row and its end is left empty', same(words(t), [['a', 'c', 'd', '○'], ['e', 'f', 'g', 'h']]) && rectangular(t), words(t));
  const hole = at(t, 0, 3);
  check('the empty end has no lines', isHole(hole) && same(hole.borders, [0, 0, 0, 0]), hole);
}
{
  const t = table([['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h']]);
  removeCells(t, [at(t, 0, 0), at(t, 0, 2), at(t, 1, 3)], 'close');
  check('closing up several far apart, in two rows', same(words(t), [['b', 'd', '○', '○'], ['e', 'f', 'g', '○']]) && rectangular(t), words(t));
}
{
  const t = table([['a', 'b', 'c'], ['d', 'e', 'f']]);
  removeCells(t, [at(t, 0, 1)], 'widen');
  check('widening: the next cell grows over its place', same(words(t), [['a', 'c^2'], ['d', 'e', 'f']]) && rectangular(t), words(t));
}
{
  const t = table([['a', 'b', 'c'], ['d', 'e', 'f']]);
  removeCells(t, [at(t, 0, 2)], 'widen');
  check('the last cell of a row is covered by the one before it', same(words(t), [['a', 'b^2'], ['d', 'e', 'f']]) && rectangular(t), words(t));
}
{
  const t = table([['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h']]);
  removeCells(t, [at(t, 0, 1), at(t, 0, 2)], 'widen');
  check('two side by side are covered from both sides', same(words(t), [['a^2', 'd^2'], ['e', 'f', 'g', 'h']]) && rectangular(t), words(t));
}
{
  const t = table([['a_2', 'b', 'c_2'], ['d']]);
  const note = removeCells(t, [at(t, 1, 0)], 'widen');
  check('a cell whose neighbours are merged differently leaves a hole, and says so', isHole(at(t, 1, 0)) && note.unfilled === 1 && rectangular(t), { w: words(t), note });
}
{
  const t = table([['a', 'b', 'c'], ['d', 'e', 'f']]);
  removeCells(t, [at(t, 0, 1), at(t, 1, 2)], 'hole');
  check('a hole: nothing else moves', same(words(t), [['a', '○', 'c'], ['d', 'e', '○']]) && rectangular(t), words(t));
}
{
  const t = table([['a', 'b'], ['c', 'd']]);
  at(t, 0, 0).bg = 'FF0000';
  removeCells(t, [at(t, 0, 0)], 'clear');
  check('only the words: the cell and its fill stay', cellWords(at(t, 0, 0)) === '' && at(t, 0, 0).bg === 'FF0000' && !isHole(at(t, 0, 0)), at(t, 0, 0));
}
{
  const t = table([['ردیف', 'نام'], ['۱', 'علی'], ['۲', 'رضا'], ['۳', 'سارا']]);
  const note = removeCells(t, [at(t, 2, 0), at(t, 2, 1)], 'close');
  check('all the cells of a row taken out: the row is gone, and numbers count again', same(words(t), [['ردیف', 'نام'], ['۱', 'علی'], ['۲', 'سارا']]) && note.renumbered, { w: words(t), note });
}
{
  const t = table([['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]);
  removeCells(t, [at(t, 0, 1), at(t, 1, 1), at(t, 2, 1)], 'widen');
  check('all the cells of a column taken out: the column is gone', same(words(t), [['a', 'c'], ['d', 'f'], ['g', 'i']]) && rectangular(t), words(t));
}
{
  const t = table([['a', 'b'], ['c', 'd']]);
  removeCells(t, [at(t, 0, 0), at(t, 0, 1), at(t, 1, 0), at(t, 1, 1)], 'close');
  check('every cell taken out: nothing is left of the table', t.rows.length === 0, words(t));
}
{
  const t = table([['a', 'b'], ['c', 'd']]);
  removeCells(t, [at(t, 0, 0), at(t, 0, 1)], 'hole');
  check('asked to leave the place empty, a whole row stays as a gap', t.rows.length === 2 && isHole(at(t, 0, 0)) && isHole(at(t, 0, 1)), words(t));
}
{
  const t = table([['a', 'b', 'c']]);
  removeCells(t, [at(t, 0, 0)], 'hole');
  removeCells(t, [at(t, 0, 1), at(t, 0, 2)], 'close');
  check('a row whose other cells are already holes goes too', t.rows.length === 0, words(t));
}
{
  const t = table([['گروه^2', 'a'], ['b', 'c', 'd']]);
  removeCells(t, [at(t, 0, 1)], 'close');
  check('a merged cell keeps its shape when the words beside it move', same(words(t), [['گروه^2', '○'], ['b', 'c', 'd']]) && rectangular(t), words(t));
}
{
  const t = table([['a', 'b'], ['c', 'd']]);
  const [first] = t.rows[0];
  const note = deleteFrom(t, [first], 'rows');
  check('the sheet\'s words reach the right change', same(words(t), [['c', 'd']]) && note.renumbered === false, words(t));
}

/* ---------- Empty rows and columns ---------- */
{
  const t = table([['ردیف', 'نام', ''], ['۱', 'علی', ''], ['۲', '', ''], ['۳', 'سارا', '']]);
  const gone = removeEmptyLines(t);
  check('empty rows and columns go, a row holding only its number counting as empty', same(words(t), [['ردیف', 'نام'], ['۱', 'علی'], ['۲', 'سارا']]) && gone.rows === 1 && gone.cols === 1, { w: words(t), gone });
}
{
  const t = table([['', ''], ['', '']]);
  const gone = removeEmptyLines(t);
  check('a table with nothing in it yet is left alone', t.rows.length === 2 && gone.rows === 0, gone);
}

/* ---------- Adding ---------- */
{
  const t = table([['ردیف', 'نام'], ['۱', 'علی'], ['۲', 'رضا']]);
  insertRow(t, 2);
  check('a row in the middle takes its number and moves the next', same(words(t), [['ردیف', 'نام'], ['۱', 'علی'], ['۲', ''], ['۳', 'رضا']]), words(t));
}
{
  const t = table([['نام', 'سن'], ['علی', '۲۰']]);
  insertRow(t, 0);
  check('a row above the title becomes the title, and the old title stays thick', t.rows.length === 3 && t.header === true && t.rows[1][0].paras[0].runs[0].b === true, t.rows[1][0]);
}
{
  const t = table([['گروه_3', 'الف'], ['ب'], ['ج']]);
  insertRow(t, 1);
  check('a merged cell crossing the new row grows', same(words(t), [['گروه_4', 'الف'], [''], ['ب'], ['ج']]) && rectangular(t), words(t));
  const u = table([['گروه^2'], ['a', 'b']]);
  insertRow(u, 1, { from: 0 });
  check('a new row can take the shape of a merged row', same(words(u), [['گروه^2'], ['^2'], ['a', 'b']]) && rectangular(u), words(u));
}
{
  const t = table([['نام', 'مبلغ'], ['علی', '۲۰']]);
  t.rows[0][0].bg = 'D9D9D9';
  insertRow(t, 1);
  check('a row under a filled title does not take the fill', t.rows[1][0].bg === undefined, t.rows[1][0]);
}
{
  const t = table([['ردیف', 'نام'], ['۱', 'علی'], ['۲', 'رضا']]);
  duplicateRow(t, 1);
  check('a row copied under itself, with its words and its own number', same(words(t), [['ردیف', 'نام'], ['۱', 'علی'], ['۲', 'علی'], ['۳', 'رضا']]), words(t));
  check('a copy is its own: changing one leaves the other', t.rows[1][1] !== t.rows[2][1] && t.rows[1][1].paras !== t.rows[2][1].paras);
}
{
  const t = table([['a', 'b'], ['c', 'd']], { widths: [30, 70] });
  insertColumn(t, 1);
  check('a column between two', same(words(t), [['a', '', 'b'], ['c', '', 'd']]) && rectangular(t), words(t));
  check('as wide as the one beside it, with the widths still whole', sum100(t.widths) && Math.abs(t.widths[0] - t.widths[1]) < 0.02, t.widths);
}
{
  const t = table([['عنوان^2'], ['a', 'b']]);
  insertColumn(t, 1);
  check('a merged cell crossing the new column grows', same(words(t), [['عنوان^3'], ['a', '', 'b']]) && rectangular(t), words(t));
}
{
  const t = table([['a_2', 'b'], ['c']]);
  insertColumn(t, 1);
  check('a new column beside a tall cell has a cell in each row', same(words(t), [['a_2', '', 'b'], ['', 'c']]) && rectangular(t), words(t));
}
{
  const t = table([['a', 'b'], ['c', 'd']]);
  removeCells(t, [at(t, 0, 1)], 'hole');
  insertRow(t, 1);
  check('a new row under a hole is a whole row', !isHole(t.rows[1][1]) && t.rows[1][1].borders === undefined, t.rows[1][1]);
}
{
  const t = table([['نام', 'تاریخ'], ['علی', '۱۴۰۵'], ['رضا', '۱۴۰۶']], { widths: [60, 40] });
  addCountingColumn(t);
  check('a new first column titled and numbered', same(words(t), [['ردیف', 'نام', 'تاریخ'], ['۱', 'علی', '۱۴۰۵'], ['۲', 'رضا', '۱۴۰۶']]), words(t));
  check('and narrow', t.widths[0] === 9 && sum100(t.widths), t.widths);
  check('which then counts by itself', countingColumn(t)?.col === 0);
}

/* ---------- Merging ---------- */
{
  const t = table([['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]);
  const n = mergeCells(t, [at(t, 0, 0), at(t, 1, 1)]);
  check('two corners make one cell of the square between them, with all the words', n === 4 && same(words(t), [['a b d e^2_2', 'c'], ['f'], ['g', 'h', 'i']]) && rectangular(t), { n, w: words(t) });
}
{
  const t = table([['a', 'b', 'c'], ['d', 'e', 'f']]);
  const n = mergeCells(t, [at(t, 0, 0), at(t, 0, 1), at(t, 0, 2), at(t, 1, 0), at(t, 1, 1), at(t, 1, 2)]);
  check('two whole rows make one row, not a row and an empty one', n === 6 && t.rows.length === 1 && at(t, 0, 0).colSpan === 3 && !at(t, 0, 0).rowSpan, words(t));
}
{
  const t = table([['a_2', 'b'], ['c'], ['d', 'e']]);
  mergeCells(t, [at(t, 1, 0), at(t, 2, 0)]);
  check('a merged cell half inside comes in whole, and what that takes in', same(words(t), [['a b c d e^2']]) && rectangular(t), words(t));
}
{
  const t = table([['a', 'b'], ['c', 'd']]);
  check('one cell alone is not merged', mergeCells(t, [at(t, 0, 0)]) === 0 && t.rows[0].length === 2);
}
{
  const t = table([['a^2_2', 'b'], ['c'], ['d', 'e', 'f']]);
  const merged = at(t, 0, 0);
  unmergeCell(t, merged);
  check('a merged cell comes apart, its words in the first of them', same(words(t), [['a', '', 'b'], ['', '', 'c'], ['d', 'e', 'f']]) && rectangular(t), words(t));
  check('a cell that is not merged has nothing to come apart', unmergeCell(t, at(t, 2, 0)) === false);
}
{
  const t = table([['a', 'b'], ['c', 'd']]);
  at(t, 0, 0).rowH = 8;
  at(t, 1, 0).rowH = 9;
  at(t, 0, 1).rowH = 8;
  at(t, 1, 1).rowH = 9;
  mergeCells(t, [at(t, 0, 0), at(t, 0, 1), at(t, 1, 0), at(t, 1, 1)]);
  check('rows of fixed height made into one keep their height together', t.rows.length === 1 && at(t, 0, 0).rowH === 17, at(t, 0, 0));
}

/* ---------- Widths and heights ---------- */
{
  const t = table([['a', 'b', 'c'], ['d', 'e', 'f']]);
  resizeColumns(t, new Set([0]), 10);
  check('a wider column takes from the others', sum100(t.widths) && t.widths[0] > 43 && t.widths[0] < 44 && Math.abs(t.widths[1] - t.widths[2]) < 0.02, t.widths);
  check('there is a limit to how wide', (() => {
    for (let i = 0; i < 40; i++) resizeColumns(t, new Set([0]), 10);
    return t.widths[1] >= 3 && t.widths[2] >= 3 && sum100(t.widths);
  })(), t.widths);
  check('and to how narrow', (() => {
    for (let i = 0; i < 40; i++) resizeColumns(t, new Set([0]), -10);
    return t.widths[0] >= 2.99 && sum100(t.widths);
  })(), t.widths);
  equalColumns(t);
  check('columns made equal', Math.max(...t.widths) - Math.min(...t.widths) < 0.02 && sum100(t.widths), t.widths);
}
{
  const t = table([['ر', 'شرح'], ['۱', 'یک متن بلند که جای زیادی می‌خواهد'], ['۲', 'متن کوتاه']]);
  fitColumns(t, { measure: (s) => s.length * 1.8, widthMm: 160 });
  check('columns as wide as their words want', sum100(t.widths) && t.widths[1] > t.widths[0] * 3, t.widths);
}
{
  const t = table([['a', 'b'], ['c', 'd']]);
  resizeRows(t, new Set([1]), 2, () => 7);
  check('a row taller, from how tall it is shown', at(t, 1, 0).rowH === 9 && at(t, 1, 1).rowH === 9 && !at(t, 0, 0).rowH, at(t, 1, 0));
  resizeRows(t, new Set([1]), 2, () => 7);
  check('and taller again', at(t, 1, 0).rowH === 11);
}

/* ---------- Numbers, totals and order ---------- */
{
  const n = (s) => readNumber(s)?.value;
  check('numbers as people write them', n('۱۲۰٬۰۰۰') === 120000 && n('1,500') === 1500 && n('۱۷/۵') === 17.5 && n('۲۰۰ ریال') === 200 && n('-۵') === -5 && n('٣٤') === 34, [n('۱۲۰٬۰۰۰'), n('1,500'), n('۱۷/۵'), n('۲۰۰ ریال')]);
  check('dates and words are not numbers', readNumber('۱۴۰۵/۰۱/۰۱') === null && readNumber('۱۴۰۵/۰۱') === null && readNumber('علی') === null && readNumber('') === null);
}
{
  const t = table([['شرح', 'مبلغ'], ['الف', '۱٬۰۰۰'], ['ب', '۲٬۵۰۰']]);
  const n = sumColumns(t, new Set([1]));
  check('a row of totals at the foot', n === 1 && same(words(t)[3], ['جمع', '۳٬۵۰۰']), words(t));
  cellWords(at(t, 1, 1));
  at(t, 1, 1).paras = [{ runs: [{ text: '۲٬۰۰۰' }] }];
  sumColumns(t, new Set([1]));
  check('asked again, it brings the same row up to date', t.rows.length === 4 && same(words(t)[3], ['جمع', '۴٬۵۰۰']), words(t));
}
{
  const t = table([['ردیف', 'شرح', 'مبلغ'], ['۱', 'الف', '۱۰۰'], ['۲', 'ب', '۲۰۰']]);
  sumColumns(t, new Set([2]));
  check('the word «جمع» stands across the columns before the sum', same(words(t)[3], ['جمع^2', '۳۰۰']) && rectangular(t), words(t));
  insertRow(t, 2);
  check('and the total row takes no row number', same(words(t).map((r) => r[0]), ['ردیف', '۱', '۲', '۳', 'جمع^2']), words(t));
}
{
  const t = table([['شرح', 'تعداد', 'مبلغ'], ['الف', '۲', '۱۷/۵'], ['ب', '۳', '۲/۵']]);
  sumColumns(t, new Set([1, 2]));
  check('several columns, and a slash as the decimal mark', same(words(t)[3], ['جمع', '۵', '۲۰/۰']), words(t));
  const empty = table([['شرح', 'نام'], ['الف', 'ب']]);
  check('a column with no numbers adds nothing', sumColumns(empty, new Set([1])) === 0 && empty.rows.length === 2);
}
{
  const t = table([['نام', 'مبلغ'], ['علی', '۳۰۰'], ['سارا', '۱۰۰'], ['بهرام', '۲۰۰']]);
  sortRows(t, 1);
  check('by size, the title staying', same(words(t).map((r) => r[1]), ['مبلغ', '۱۰۰', '۲۰۰', '۳۰۰']), words(t));
  sortRows(t, 1, true);
  check('and from the largest', same(words(t).map((r) => r[1]), ['مبلغ', '۳۰۰', '۲۰۰', '۱۰۰']), words(t));
  sortRows(t, 0);
  check('words in Persian order', same(words(t).map((r) => r[0]), ['نام', 'بهرام', 'سارا', 'علی']), words(t));
}
{
  const t = table([['ردیف', 'نام'], ['۱', 'علی'], ['۲', ''], ['۳', 'بهرام'], ['جمع^2']]);
  sortRows(t, 1);
  check('numbers stay in order, empty cells last, totals at the foot', same(words(t), [['ردیف', 'نام'], ['۱', 'بهرام'], ['۲', 'علی'], ['۳', ''], ['جمع^2']]), words(t));
}
{
  const t = table([['a_2', 'b'], ['c']]);
  check('rows joined by a merged cell are not sorted', sortRows(t, 1) === false && same(words(t), [['a_2', 'b'], ['c']]));
}
{
  const t = table([['تعداد', 'نام'], ['۱', 'علی'], ['۲', 'رضا'], ['۳', 'سارا']]);
  deleteRows(t, new Set([1]));
  check('a column of amounts that happens to count is not rewritten', same(words(t).map((r) => r[0]), ['تعداد', '۲', '۳']), words(t));
}
{
  const t = table([['۱', 'علی'], ['۲', 'رضا'], ['۳', 'سارا'], ['۴', 'بهرام']], { header: false });
  deleteRows(t, new Set([0]));
  check('with no title, a first column reading 1, 2, 3 still counts', same(words(t).map((r) => r[0]), ['۱', '۲', '۳']), words(t));
}
{
  const t = table([['ردیف', 'نام'], ['۱', 'علی'], ['', 'رضا'], ['۵', 'سارا']]);
  numberColumn(t, 0);
  check('a column numbered afresh', same(words(t).map((r) => r[0]), ['ردیف', '۱', '۲', '۳']), words(t));
  const u = table([['ردیف', 'نام'], ['۱', 'علی'], ['۳', 'رضا']]);
  insertRow(u, 3);
  check('under a title a broken count is mended too', same(words(u).map((r) => r[0]), ['ردیف', '۱', '۲', '۳']), words(u));
}

/* ---------- Words pasted ---------- */
{
  check('from a spreadsheet: tabs', same(rowsFromText('نام\tسن\nعلی\t۲۰\n'), [['نام', 'سن'], ['علی', '۲۰']]));
  check('bars', same(rowsFromText('|نام|سن|\n|علی|۲۰|'), [['نام', 'سن'], ['علی', '۲۰']]), rowsFromText('|نام|سن|\n|علی|۲۰|'));
  check('commas, Persian ones too', same(rowsFromText('نام، سن\nعلی، ۲۰'), [['نام', 'سن'], ['علی', '۲۰']]));
  check('a line short of words is filled out', same(rowsFromText('a\tb\tc\nd\te\tf\ng\th'), [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', '']]));
  check('lines of plain text make one column', same(rowsFromText('علی رضا\nسارا احمدی'), [['علی رضا'], ['سارا احمدی']]));
  check('nothing makes nothing', rowsFromText(' \n ').length === 0);
  check('thousands inside a number do not part it, where tabs part the columns', same(rowsFromText('الف\t1,000\nب\t2,000'), [['الف', '1,000'], ['ب', '2,000']]));
}

/* ---------- The look of the whole ---------- */
{
  const t = table([['نام', 'سن'], ['علی', '۲۰'], ['رضا', '۳۰'], ['سارا', '۴۰']]);
  dressTable(t, 'stripes', 12);
  check('a grey title and every other row lightly grey', t.rows[0][0].bg === 'D9D9D9' && !t.rows[1][0].bg && t.rows[2][0].bg === 'F2F2F2' && !t.rows[3][0].bg, t.rows.map((r) => r[0].bg));
  dressTable(t, 'plain', 12);
  check('back to plain, with no memory left over', !t.rows[0][0].bg && !t.rows[0][0].orig, t.rows[0][0]);
  dressTable(t, 'rules', 12);
  check('lines across only', same(t.rows[1][1].borders, [0.5, 0, 0.5, 0]));
  dressTable(t, 'none', 12);
  check('no lines at all', t.borderless === true && !t.rows[1][1].borders);
  dressTable(t, 'plain', 12);
  check('and lines again', t.borderless === undefined);
}

/* ---------- Leaving the letter ---------- */
{
  const a = table([['a']]);
  const b = table([['b']]);
  const c = table([['c']]);
  const letter = { body: [a, { kind: 'p', runs: [] }, b, c], offsets: { 'table:0': { dx: 1 }, 'table:1': { dx: 2 }, 'table:2': { dx: 3 }, subject: { dy: 4 } } };
  dropTable(letter, b);
  check('the tables after one that leaves keep what was set for them', letter.body.length === 3 && letter.offsets['table:0'].dx === 1 && letter.offsets['table:1'].dx === 3 && letter.offsets['table:2'] === undefined && letter.offsets.subject.dy === 4, letter.offsets);
}
{
  const t = table([['a', 'b']]);
  check('where a cell stands', placeOfCell(t, t.rows[0][1])?.col === 1);
}

console.log(`\n${total - failed} of ${total} passed`);
process.exit(failed ? 1 : 0);
