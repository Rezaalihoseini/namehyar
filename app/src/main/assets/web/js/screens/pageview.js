// The real page, InDesign style. Everything on it moves with a finger: pictures and letterhead parts go
// anywhere, with smart guides and snap. The letter's sections and each paragraph of the body move too: normally
// the text below follows and nothing runs into the text above; with "free move" on, a block goes anywhere on its own.
// Tapping a part selects it for font, size and alignment; dragging it moves it.

import { h, uid, clamp, clone, toast } from '../util.js';
import { icon } from '../icons.js';
import { app, backButton, confirmSheet, goBack, openSheet, saveLetter, saveSettings, saveTemplate, showScreen, withBusy } from '../app.js';
import { MM, PAGE_PX, frameHeightMm, layoutLetter, objectBox } from '../render.js';
import { DEFAULT_STYLES, MM_PER_PT, PAGE, PART_LABELS, ROLE_LABELS, SIGN, TEXT_STYLE, allFonts, baseBefore, buildFlow, countBlanks, frameLines, geomOf, headerParts, sectionRole, signObjectsFor, styleOf, usePageSize } from '../model.js';
import { blocksToHtml } from '../editor.js';
import { clearLook, runAt, runsText } from '../runs.js';
import { inkRects } from '../ink.js';
import { cellGrid, fillBlanks, lookOfRun, replaceEverywhere, resetBlock, resetBlockWord, resetCell, resetCellWord, resetFrame, resetFrameWord, restyleBlock, restyleBlockWord, restyleCell, restyleCellWord, restyleFrame, restyleFrameWord, setCellLines } from '../restyle.js';
import { deleteNote, openDeleteSheet, openTableSheet, openTableSwapSheet } from '../table-tools.js';
import { deleteFrom, dropEmptyTables, dropTable, insertColumn, insertRow, isHole, isMerged, mergeCells, placeOfCell, unmergeCell } from '../table-edit.js';
import { LAYOUTS, withLayout } from '../data/layouts.js';
import { ensureMedia, mediaIdsOf, mediaUrl, putMedia } from '../store.js';
import { importImage, pickImageFile, pictureForFrame, removePaper } from '../image.js';
import { fontIsHere, installFont } from '../fonts.js';
import { FONT_ACCEPT, pickFile } from '../files.js';
import { columnOf, deletePage, duplicatePage, isPlaced, mergeIntoFlow, movePage, paragraphAround, sameLookAs, shiftBelow, textOfLines } from '../placed.js';
import { openFillSheet } from './fill-sheet.js';
import { openReviewSheet, openScanSheet, startReading } from './read-flow.js';
import { toFaDigits } from '../text.js';
import { openExportSheet } from './export-sheet.js';
import { openColorSheet, openFindSheet, openLinesSheet, openLooksSheet, openMarkSheet, openNameSheet, openSizeSheet } from './page-sheets.js';

const root = h('section', { class: 'screen', id: 'page', hidden: true });
const stageInner = h('div', { class: 'stage-inner' });
const stage = h('div', { class: 'stage' }, stageInner);
const tools = h('div', { class: 'tools' });
const undoBtn = h('button', { class: 'icon-btn', 'aria-label': 'برگرداندن آخرین تغییر', title: 'برگرداندن', onClick: undo }, icon('undo'));
const redoBtn = h('button', { class: 'icon-btn', 'aria-label': 'انجام دوبارهٔ تغییر', title: 'انجام دوباره', onClick: redo }, icon('redo'));

root.append(
  h(
    'header',
    { class: 'topbar' },
    backButton(),
    h('h1', null, 'چیدمان'),
    undoBtn,
    redoBtn,
    h('button', { class: 'icon-btn', 'aria-label': 'کوچک‌نمایی', onClick: () => zoom(0.85) }, icon('minus')),
    h('button', { class: 'icon-btn', 'aria-label': 'بزرگ‌نمایی', onClick: () => zoom(1.18) }, icon('plus')),
    h('button', {
      class: 'btn small primary',
      onClick: () => openExportSheet(L(), {
        onBlank: L().importInfo?.form ? null : () => {
          selection = null;
          goBack();
          app.screens.compose.focusBlank();
        },
        onFilled: render,
      }),
    }, 'خروجی'),
  ),
  stage,
  tools,
);

const L = () => app.letter;

let scale = 1;
let info = null;
// {type:'obj', id} | {type:'part', id} | {type:'section', id, role, cell?: {r, c}}.
// A frame, a paragraph or a cell can narrow down further to one word: word: {p, start, end, text}, p being which of its paragraphs.
let selection = null;
let metaLinked = false; // Number, date and attachment move one by one, or as a block when the user links them.
let freeMode = false; // Off: a block cannot run into the text above it. On: it goes anywhere, and nothing else moves.
let bodyAll = false; // The body's paragraphs are selected one by one, or all together.
let tableAll = false; // A table's cells are selected one by one, or the table as a whole.
let painter = null; // A look that was taken, which a tap gives to whatever it lands on.
let history = [];
let future = [];
let historyFor = null;

const objectById = (id) => (L().objects || []).find((o) => o.id === id);
const partById = (id) => headerParts(L(), info.total).find((p) => p.id === id);

function fitScale() {
  usePageSize(L());
  return Math.min(1.2, (stage.clientWidth - 30) / PAGE_PX.w);
}

function render() {
  const previous = stageInner.childElementCount ? { x: stage.scrollLeft, y: stage.scrollTop } : null;
  info = layoutLetter(L(), { preview: true });
  const boxes = [...stageInner.children];
  info.pages.forEach((page, i) => {
    // A page that is still the same page stays where it is, so nothing in it is laid out again.
    if (boxes[i]?.firstChild === page) return;
    const box = h('div', { class: 'page-box', dataset: { page: page.dataset.page } }, page);
    if (boxes[i]) boxes[i].replaceWith(box);
    else stageInner.append(box);
  });
  boxes.slice(info.pages.length).forEach((box) => box.remove());
  applyScale();
  paintTools();
  if (previous) stage.scrollTo(previous.x, previous.y);
}

function applyScale() {
  stageInner.style.setProperty('--k', scale);
  for (const box of stageInner.children) {
    box.style.width = `${PAGE_PX.w * scale}px`;
    box.style.height = `${PAGE_PX.h * scale}px`;
    box.firstChild.style.transform = `scale(${scale})`;
  }
  drawSelection();
}

function zoom(factor) {
  scale = clamp(scale * factor, 0.25, 3);
  applyScale();
}

/* ---------- Undo: every change on this screen can be taken back ---------- */

const UNDOABLE = ['body', 'bodyHtml', 'fields', 'styles', 'offsets', 'geom', 'objects', 'letterhead', 'recipient', 'subject', 'greeting', 'closing', 'number', 'date', 'attachment', 'attachmentManual', 'signer', 'cc'];

function snapshotNow() {
  const letter = L();
  return JSON.stringify(Object.fromEntries(UNDOABLE.map((k) => [k, letter[k]])));
}

function remember() {
  history.push(snapshotNow());
  if (history.length > 40) history.shift();
  future = [];
  undoBtn.disabled = false;
  redoBtn.disabled = true;
}

function stepThrough(from, to) {
  const snapshot = from.pop();
  if (!snapshot) return;
  to.push(snapshotNow());
  Object.assign(L(), JSON.parse(snapshot));
  undoBtn.disabled = !history.length;
  redoBtn.disabled = !future.length;
  // A group stays chosen, so that another change can be tried on it, less anything that was not there before this step.
  if (selection?.type === 'group') {
    const items = selection.items.filter((item) => (item.kind === 'cell' ? cellOfItem(item) : item.kind === 'block' ? L().body[item.k] : objectById(item.id)));
    selection = { ...selection, items, last: items.includes(selection.last) ? selection.last : items[items.length - 1] || null };
  } else selection = null;
  saveLetter();
  render();
}

function undo() {
  stepThrough(history, future);
}

function redo() {
  stepThrough(future, history);
}

/** Applies a change to the letter so that it can be undone, saved and shown. */
function change(fn) {
  remember();
  fn();
  saveLetter();
  render();
}

/* ---------- Selection ---------- */

function pageBox(index) {
  return stageInner.querySelector(`.page-box[data-page="${index}"]`);
}

function drawHandleBox(pageIndex, b) {
  const k = scale * MM;
  const pb = pageBox(pageIndex);
  if (!pb) return;
  pb.append(
    h(
      'div',
      { class: 'sel-box', style: { left: `${b.x * k}px`, top: `${b.y * k}px`, width: `${b.w * k}px`, height: `${b.h * k}px` } },
      h('div', { class: 'sel-handle', 'aria-label': 'تغییر اندازه' }),
    ),
  );
}

const tableOfId = (id) => L().body.filter((b) => b.kind === 'table')[Number(id.slice(6))] || null;

/** The selected table. */
function selectedTable() {
  return selection?.id?.startsWith('table:') ? tableOfId(selection.id) : null;
}

const selectedCell = () => (selection?.cell ? selectedTable()?.rows[selection.cell.r]?.[selection.cell.c] || null : null);

const cellSelector = ({ r, c }) => `td[data-r="${r}"][data-c="${c}"]`;

/* ---------- One word on the page ---------- */

/** The text nodes of an element, each with where it begins in the element's text. */
function textNodesIn(el) {
  const nodes = [];
  let total = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    nodes.push({ node: walker.currentNode, start: total });
    total += walker.currentNode.length;
  }
  return nodes;
}

/** Where a stretch of an element's text is drawn on the screen. */
function stretchRects(el, from, to) {
  if (el.classList.contains('ink-text')) return inkRects(L(), objectById(el.parentElement.dataset.id), el.parentElement, from, to);
  const nodes = textNodesIn(el);
  const startAt = nodes.find((n) => from < n.start + n.node.length);
  const endAt = nodes.find((n) => to <= n.start + n.node.length);
  if (!startAt || !endAt) return [];
  const range = document.createRange();
  range.setStart(startAt.node, from - startAt.start);
  range.setEnd(endAt.node, to - endAt.start);
  return [...range.getClientRects()].filter((r) => r.width && r.height);
}

/** The elements that show the selected cell, paragraph or frame: which paragraph each one is, and where in its text it begins. */
function textHolders() {
  if (!selection) return [];
  if (selection.cell) {
    const cells = stageInner.querySelectorAll(`${sectionSelector(selection.id)} ${cellSelector(selection.cell)}`);
    return [...cells].flatMap((td) => [...td.querySelectorAll(':scope > .cell-p')].map((el, p) => ({ el, p, base: 0 })));
  }
  if (selection.type === 'section' && blockIndex(selection.id) >= 0) {
    // A paragraph that runs over to the next page continues its text there.
    let base = 0;
    return [...stageInner.querySelectorAll(sectionSelector(selection.id))].map((el) => {
      const holder = { el, p: 0, base };
      base += el.textContent.length;
      return holder;
    });
  }
  if (selection.type === 'obj' && objectById(selection.id)?.kind === 'text') {
    const frame = stageInner.querySelector(`.obj[data-id="${selection.id}"]`);
    return frame ? [...frame.querySelectorAll(':scope > div')].map((el, p) => ({ el, p, base: 0 })) : [];
  }
  return [];
}

const countWords = (text) => (text.match(/\S+/g) || []).length;

/** The words of a text and where each stands, without the brackets and punctuation around them: «(مبانی،» is the word «مبانی». */
function wordsIn(text) {
  const words = [];
  for (const m of text.matchAll(/\S+/g)) {
    const inner = /^[([{«"'‹]*(.*?)[)\]}»"'›،؛:.!؟,;]*$/su.exec(m[0])[1] || m[0];
    const start = m.index + m[0].indexOf(inner);
    words.push({ text: inner, start, end: start + inner.length });
  }
  return words;
}

const selectedWordCount = () => textHolders().reduce((sum, { el }) => sum + countWords(el.textContent), 0);

/** The word under a finger in what is selected. A part of one word needs no choosing, so it has none. */
function wordAt(x, y) {
  if (selectedWordCount() < 2) return null;
  let best = null;
  let bestGap = 14;
  for (const { el, p, base } of textHolders()) {
    for (const word of wordsIn(el.textContent)) {
      for (const r of stretchRects(el, word.start, word.end)) {
        const gap = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
        if (gap < bestGap) {
          bestGap = gap;
          best = { p, start: base + word.start, end: base + word.end, text: word.text };
        }
      }
    }
  }
  return best;
}

function drawWord() {
  const { word } = selection;
  if (!word) return;
  for (const { el, p, base } of textHolders()) {
    const length = el.textContent.length;
    if (p !== word.p || word.start < base || word.start >= base + length) continue;
    const box = el.closest('.page-box');
    const frame = box.getBoundingClientRect();
    for (const r of stretchRects(el, word.start - base, Math.min(word.end - base, length))) {
      box.append(h('div', { class: 'sel-word', style: { left: `${r.left - frame.left}px`, top: `${r.top - frame.top}px`, width: `${r.width}px`, height: `${r.height}px` } }));
    }
  }
}

function drawSelection() {
  stageInner.querySelectorAll('.sel-box, .sel-word').forEach((el) => el.remove());
  stageInner.querySelectorAll('.sel-on').forEach((el) => el.classList.remove('sel-on'));
  stageInner.querySelectorAll('.sel-cell').forEach((el) => el.classList.remove('sel-cell'));
  if (!selection || !info) return;
  if (selection.type === 'group') {
    for (const item of selection.items) {
      if (item.kind === 'cell') stageInner.querySelectorAll(`${sectionSelector(item.t)} ${cellSelector(item)}`).forEach((td) => td.classList.add('sel-cell'));
      else if (item.kind === 'block') stageInner.querySelectorAll(sectionSelector(`body:${item.k}`)).forEach((el) => el.classList.add('sel-on'));
      else stageInner.querySelector(`.obj[data-id="${item.id}"]`)?.classList.add('sel-on');
    }
    return;
  }
  if (selection.type === 'section') {
    const shown = stageInner.querySelectorAll(sectionSelector(selection.id));
    // Only what a change will touch looks selected: the cell, not its whole table.
    if (selection.cell) shown.forEach((el) => el.querySelectorAll(cellSelector(selection.cell)).forEach((td) => td.classList.add('sel-cell')));
    else shown.forEach((el) => el.classList.add('sel-on'));
    drawWord();
    return;
  }
  if (selection.type === 'part') {
    if (selection.id === 'logo') {
      const part = partById('logo');
      if (part) drawHandleBox(0, { x: part.x, y: part.y, w: part.w, h: part.w / (L().letterhead.logoAspect || 1) });
    } else {
      stageInner.querySelectorAll(`[data-part="${selection.id}"]`).forEach((el) => el.classList.add('sel-on'));
    }
    return;
  }
  const o = objectById(selection.id);
  if (!o) return;
  const b = objectBox(o, info);
  drawHandleBox(b.page, b);
  drawWord();
}

function select(next) {
  selection = next;
  drawSelection();
  paintTools();
}

const isSelected = (t) => selection && selection.type === t.type && selection.id === t.id;

/** The same part as what is selected, down to the same cell of a table. */
const isSelectedExactly = (t) => isSelected(t) && selection.cell?.r === t.cell?.r && selection.cell?.c === t.cell?.c;

/* ---------- Finding what the finger is on ---------- */

const gapTo = (el, x, y) => {
  const r = el.getBoundingClientRect();
  return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
};

function nearestCellIn(sec, x, y) {
  let best = null;
  let bestGap = Infinity;
  for (const td of sec.querySelectorAll('td')) {
    const gap = gapTo(td, x, y);
    if (gap < bestGap) {
      best = td;
      bestGap = gap;
    }
  }
  return best;
}

function targetFrom(el, x, y) {
  const obj = el.closest?.('.obj');
  if (obj) return { type: 'obj', id: obj.dataset.id, el: obj };
  const part = el.closest?.('[data-part]');
  if (part) return { type: 'part', id: part.dataset.part, el: part };
  const sec = el.closest?.('[data-section]');
  if (!sec) return null;
  const id = bodyAll && sec.dataset.section.startsWith('body:') ? 'body' : sec.dataset.section;
  const td = id.startsWith('table:') && !tableAll ? el.closest('td') || (x !== undefined && nearestCellIn(sec, x, y)) : null;
  return { type: 'section', id, role: el.closest('[data-role]')?.dataset.role || sectionRole(id), el: sec, ...(td && { cell: { r: Number(td.dataset.r), c: Number(td.dataset.c) } }) };
}

/** On a phone a line of text is only a few pixels tall, so a touch just beside a part still counts. */
function nearestTarget(x, y) {
  let best = null;
  let bestGap = 16;
  for (const el of stageInner.querySelectorAll('[data-part], [data-section]')) {
    const gap = gapTo(el, x, y);
    if (gap < bestGap) {
      best = el;
      bestGap = gap;
    }
  }
  return best && targetFrom(best, x, y);
}

/* ---------- Measuring and snapping, in millimetres on the page ---------- */

function pageBoxOf(el) {
  const page = el.closest('.page');
  return { page, rect: page.getBoundingClientRect(), k: scale * MM };
}

/** The visible text of an element, which is often narrower than the element itself. */
function inkBox(els, frame) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of els) {
    const range = document.createRange();
    range.selectNodeContents(el);
    // A line drawn from a file's own letters fills its frame exactly.
    const rects = el.classList.contains('obj-inked') ? [] : [...range.getClientRects()].filter((r) => r.width > 0);
    for (const r of rects.length ? rects : [el.getBoundingClientRect()]) {
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
    }
  }
  return { x: (left - frame.rect.left) / frame.k, y: (top - frame.rect.top) / frame.k, w: (right - left) / frame.k, h: (bottom - top) / frame.k };
}

function snapLines(frame, exclude) {
  const g = geomOf(L());
  const xs = [g.left, PAGE.w - g.right, PAGE.w / 2];
  const ys = [PAGE.h / 2];
  for (const el of frame.page.querySelectorAll('.hd-part, .obj')) {
    if (exclude.includes(el)) continue;
    const b = inkBox([el], frame);
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { xs, ys };
}

function nearestLine(edges, lines, threshold) {
  let best = null;
  for (const edge of edges) {
    for (const line of lines) {
      const d = line - edge;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: line };
    }
  }
  return best;
}

function clearGuides() {
  stageInner.querySelectorAll('.guide').forEach((el) => el.remove());
}

function showGuide(pageIndex, axis, mm) {
  const pb = pageBox(pageIndex);
  if (!pb) return;
  const at = mm * MM * scale;
  pb.append(h('div', { class: 'guide', style: axis === 'x' ? { left: `${at}px`, top: 0, bottom: 0, width: '1px' } : { top: `${at}px`, left: 0, right: 0, height: '1px' } }));
}

/* ---------- Drags. Each returns {move(event), end()} and changes the letter only on end. ---------- */

function freeDrag(startX, startY, el, place, { lines, snapY = true }) {
  const frame = pageBoxOf(el);
  const ink = inkBox([el], frame);
  const start = place.get();
  const threshold = Math.max(1, 7 / frame.k);
  const pageIndex = Number(frame.page.dataset.page);
  let current = start;
  return {
    move(e) {
      const dx = (e.clientX - startX) / frame.k;
      const dy = (e.clientY - startY) / frame.k;
      const x = ink.x + dx;
      const y = ink.y + dy;
      const sx = nearestLine([x, x + ink.w / 2, x + ink.w], lines.xs, threshold);
      const sy = snapY ? nearestLine([y, y + ink.h / 2, y + ink.h], lines.ys, threshold) : null;
      clearGuides();
      if (sx) showGuide(pageIndex, 'x', sx.at);
      if (sy) showGuide(pageIndex, 'y', sy.at);
      current = {
        x: clamp(start.x + dx + (sx ? sx.d : 0), -ink.w / 2, PAGE.w - ink.w / 2),
        y: clamp(start.y + dy + (sy ? sy.d : 0), -ink.h / 2, PAGE.h - ink.h / 2),
      };
      el.style.left = `${current.x}mm`;
      el.style.top = `${current.y}mm`;
    },
    end() {
      clearGuides();
      change(() => place.set(current));
    },
  };
}

function setPart(id, patch) {
  const lh = L().letterhead;
  lh.parts = { ...lh.parts, [id]: { ...lh.parts?.[id], ...patch } };
}

const META_PARTS = ['number', 'date', 'attachment'];

/** The parts that move along with this one. */
function followersOf(id) {
  return metaLinked && META_PARTS.includes(id) ? META_PARTS.filter((other) => other !== id).map(partById).filter(Boolean) : [];
}

function partDrag(t, x, y) {
  const part = partById(t.id);
  const frame = pageBoxOf(t.el);
  const followers = followersOf(t.id).map((p) => ({ part: p, el: frame.page.querySelector(`[data-part="${p.id}"]`) }));
  const drag = freeDrag(x, y, t.el, {
    get: () => ({ x: part.x, y: part.y }),
    set: (p) => {
      setPart(t.id, p);
      for (const f of followers) setPart(f.part.id, { x: f.part.x + p.x - part.x, y: f.part.y + p.y - part.y });
    },
  }, { lines: snapLines(frame, [t.el, ...followers.map((f) => f.el)]) });
  return {
    move(e) {
      drag.move(e);
      for (const f of followers) {
        if (!f.el) continue;
        f.el.style.left = `${f.part.x + parseFloat(t.el.style.left) - part.x}mm`;
        f.el.style.top = `${f.part.y + parseFloat(t.el.style.top) - part.y}mm`;
      }
    },
    end: drag.end,
  };
}

function setObjectBox(o, { x, y, w }) {
  if (w !== undefined) o.w = w;
  if (x !== undefined) o.x = x;
  if (y !== undefined) {
    if (o.anchor === 'sign') o.dy = y - (info.geom.top + info.signTop + info.signDy);
    else o.y = y;
  }
}

function objectDrag(t, x, y) {
  const o = objectById(t.id);
  const frame = pageBoxOf(t.el);
  const b = objectBox(o, info);
  const drag = freeDrag(x, y, t.el, {
    get: () => ({ x: b.x, y: b.y }),
    set: (p) => setObjectBox(o, p),
  }, { lines: snapLines(frame, [t.el]) });
  const sel = () => stageInner.querySelector('.sel-box');
  return {
    move(e) {
      drag.move(e);
      const k = scale * MM;
      const box = sel();
      if (box) Object.assign(box.style, { left: `${parseFloat(t.el.style.left) * k}px`, top: `${parseFloat(t.el.style.top) * k}px` });
    },
    end: drag.end,
  };
}

/* ---------- Where each section's moves are kept ---------- */

const blockIndex = (id) => (id.startsWith('body:') ? Number(id.slice(5)) : -1);
const sectionSelector = (id) => (id === 'body' ? '[data-group="body"]' : `[data-section="${id}"]`);

function moveOf(id) {
  const k = blockIndex(id);
  return (k >= 0 ? L().body[k]?.move : L().offsets?.[id]) || {};
}

function syncBodyHtml() {
  L().bodyHtml = blocksToHtml(L().body);
}

/** Changes one paragraph of the body, keeping the form's text in step with it. */
function changeBlock(k, patch) {
  const letter = L();
  letter.body[k] = { ...letter.body[k], ...patch };
  syncBodyHtml();
}

function setMove(id, patch) {
  const letter = L();
  const k = blockIndex(id);
  // The signature and stamp travel with the name they belong to.
  if (id === 'sign' && patch.dx !== undefined) {
    const shift = patch.dx - (moveOf(id).dx || 0);
    for (const o of letter.objects || []) if (o.anchor === 'sign') o.x += shift;
  }
  if (k >= 0) changeBlock(k, { move: { ...letter.body[k].move, ...patch } });
  else letter.offsets = { ...letter.offsets, [id]: { ...letter.offsets?.[id], ...patch } };
}

function firstBlockOf(id) {
  const flow = buildFlow(L());
  const block = flow.find((b) => (id === 'body' ? b.group === 'body' : b.section === id));
  return { block, isFirst: flow[0] === block };
}

/**
 * Where a section lands for a total vertical move. The section at the top of the text moves the top margin when it
 * goes up, because no other space is left above it; any other section only closes the gap above itself.
 */
function verticalMove(id, wanted) {
  const { block, isFirst } = firstBlockOf(id);
  const g = geomOf(L());
  const beforeMm = baseBefore(L(), block) * MM_PER_PT + (block.dy || 0) - (moveOf(id).dy || 0);
  if (!isFirst) return { dy: Math.max(-beforeMm, wanted), top: g.top, beforeMm };
  const limit = Math.max(PAGE.bodyTop, g.top);
  const y = Math.max(5, g.top + wanted);
  const top = Math.min(limit, y);
  return { dy: y - top, top, beforeMm };
}

function setAlign(id, align) {
  const letter = L();
  const k = blockIndex(id);
  if (k >= 0) changeBlock(k, { align });
  else {
    const role = sectionRole(id);
    letter.styles = { ...letter.styles, [role]: { ...styleOf(letter, role), align } };
  }
}

function commitSection(id, dx, move) {
  const letter = L();
  setMove(id, { dx, dy: move.dy });
  if (move.top !== geomOf(letter).top) letter.geom = { ...letter.geom, top: move.top };
}

const FREE_HINT = 'برای رفتن بالاتر، «حرکت آزاد» را روشن کن';

function sectionDrag(t, startX, startY) {
  const id = t.id;
  const free = freeMode;
  const els = [...stageInner.querySelectorAll(sectionSelector(id))];
  const frame = pageBoxOf(t.el);
  const here = els.filter((el) => el.closest('.page') === frame.page);
  const ink = inkBox(here, frame);
  const start = moveOf(id);
  const startDx = start.dx || 0;
  const startDy = start.dy || 0;
  const startFy = start.fy || 0;
  const lefts = els.map((el) => parseFloat(el.style.left) || 0);
  const tops = els.map((el) => parseFloat(el.style.top) || 0);
  const g = geomOf(L());
  const { isFirst } = firstBlockOf(id);
  const role = sectionRole(id);
  // A short line dropped on a margin or the centre simply becomes aligned that way, so it stays there if its text changes.
  const canAlign = id !== 'body' && !['table', 'signName'].includes(role) && ink.w < g.bodyW * 0.9;
  const threshold = Math.max(1, 7 / frame.k);
  const pageIndex = Number(frame.page.dataset.page);
  const lines = [{ at: g.left, align: 'left' }, { at: PAGE.w - g.right, align: 'right' }, { at: PAGE.w / 2, align: 'center' }];
  const ySnaps = free ? snapLines(frame, els).ys : [];
  const followers = id === 'sign' ? (L().objects || []).filter((o) => o.anchor === 'sign').map((o) => ({ el: stageInner.querySelector(`.obj[data-id="${o.id}"]`), box: objectBox(o, info) })) : [];
  const bodyEl = els[0].closest('.pg-body');
  let hinted = false;
  let result = null;

  return {
    move(e) {
      const rawX = (e.clientX - startX) / frame.k;
      const rawY = (e.clientY - startY) / frame.k;
      const x = ink.x + rawX;
      const edges = { left: x, right: x + ink.w, center: x + ink.w / 2 };
      let snap = null;
      for (const line of lines) {
        const d = line.at - edges[line.align];
        if (Math.abs(d) <= threshold && (!snap || Math.abs(d) < Math.abs(snap.d))) snap = { d, at: line.at, align: line.align };
      }
      const deltaX = rawX + (snap ? snap.d : 0);
      clearGuides();
      if (snap) showGuide(pageIndex, 'x', snap.at);
      els.forEach((el, i) => {
        el.style.left = `${lefts[i] + deltaX}mm`;
      });

      let followY = 0;
      if (free) {
        const y = ink.y + rawY;
        const sy = nearestLine([y, y + ink.h / 2, y + ink.h], ySnaps, threshold);
        if (sy) showGuide(pageIndex, 'y', sy.at);
        const deltaY = clamp(rawY + (sy ? sy.d : 0), -ink.y - ink.h / 2, PAGE.h - ink.y - ink.h / 2);
        els.forEach((el, i) => {
          el.style.top = `${tops[i] + deltaY}mm`;
          el.classList.add('moved');
        });
        followY = deltaY;
        result = { dx: startDx + deltaX, fy: startFy + deltaY, snap };
      } else {
        const move = verticalMove(id, startDy + rawY);
        els[0].style.paddingTop = `${move.beforeMm + move.dy}mm`;
        if (isFirst) bodyEl.style.top = `${move.top}mm`;
        followY = move.dy - startDy;
        result = { dx: startDx + deltaX, move, snap };
        if (!hinted && !isFirst && startDy + rawY < move.dy - 3) {
          hinted = true;
          toast(FREE_HINT);
        }
      }
      for (const f of followers) {
        if (f.el) {
          f.el.style.left = `${f.box.x + deltaX}mm`;
          f.el.style.top = `${f.box.y + followY}mm`;
        }
      }
    },
    end() {
      clearGuides();
      if (!result) return;
      const { dx, move, fy, snap } = result;
      change(() => {
        let finalDx = dx;
        if (snap && canAlign) {
          const shared = blockIndex(id) >= 0 ? L().offsets?.body?.dx || 0 : 0;
          finalDx = (snap.align === 'center' ? PAGE.w / 2 - (g.left + g.bodyW / 2) : 0) - shared;
          setAlign(id, snap.align);
        }
        if (free) setMove(id, { dx: finalDx, fy });
        else commitSection(id, finalDx, move);
      });
    },
  };
}

function resizeDrag(startX) {
  const k = scale * MM;
  if (selection.type === 'part') {
    const part = partById('logo');
    const aspect = L().letterhead.logoAspect || 1;
    let next = null;
    return {
      move(e) {
        const w = clamp(part.w - (e.clientX - startX) / k, 5, PAGE.w);
        next = { w, x: part.x + part.w - w, y: part.y };
        const el = stageInner.querySelector('[data-part="logo"]');
        Object.assign(el.style, { left: `${next.x}mm`, width: `${w}mm`, height: `${w / aspect}mm` });
        const box = stageInner.querySelector('.sel-box');
        if (box) Object.assign(box.style, { left: `${next.x * k}px`, width: `${w * k}px`, height: `${(w / aspect) * k}px` });
      },
      end() {
        if (next) change(() => setPart('logo', next));
      },
    };
  }
  const o = objectById(selection.id);
  const b = objectBox(o, info);
  let next = null;
  return {
    move(e) {
      const w = clamp(b.w - (e.clientX - startX) / k, 8, PAGE.w);
      next = { w, x: b.x + b.w - w };
      const el = stageInner.querySelector(`.obj[data-id="${o.id}"]`);
      el.style.left = `${next.x}mm`;
      el.style.width = `${w}mm`;
      if (o.kind !== 'text') el.style.height = `${w / (o.aspect || 1)}mm`;
      const box = stageInner.querySelector('.sel-box');
      if (box) Object.assign(box.style, { left: `${next.x * k}px`, width: `${w * k}px`, height: o.kind === 'text' ? box.style.height : `${(w / (o.aspect || 1)) * k}px` });
    },
    end() {
      if (next) change(() => setObjectBox(o, next));
    },
  };
}

/* ---------- One finger ----------
   On a selected part, or when the page fits the screen and has nowhere to scroll, a finger drags at once.
   On a longer letter one finger also has to scroll, so an unselected part is picked up by holding it a moment. */

let press = null;
const HOLD_MS = 220;

const stageScrolls = () => stage.scrollHeight > stage.clientHeight + 1 || stage.scrollWidth > stage.clientWidth + 1;

const wholeOf = (target) => (target.type === 'section' ? { type: 'section', id: target.id, role: target.role } : { type: target.type, id: target.id });

function startDragging() {
  const { target, x, y } = press;
  // A finger held on a cell may still only be a slow tap: the whole table is picked up once it really moves.
  if (!isSelected(target) && !target.cell) select(wholeOf(target));
  // Selecting may have redrawn nothing, but the target element itself stays in place.
  press.drag = target.type === 'obj' ? objectDrag(target, x, y) : target.type === 'part' ? partDrag(target, x, y) : sectionDrag(target, x, y);
}

function endPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

stageInner.addEventListener('pointerdown', (e) => {
  if (e.button > 0 || press) return;
  if (e.target.closest('.sel-handle')) {
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, target: null, direct: true, drag: resizeDrag(e.clientX), timer: null };
    return;
  }
  const target = targetFrom(e.target, e.clientX, e.clientY) || nearestTarget(e.clientX, e.clientY);
  // Among a table's cells a finger is choosing, so a shaky tap must not move the whole table: moving it takes a hold.
  const choosing = !!painter || selection?.type === 'group';
  // A page taken exactly from a file is covered in lines and pictures, and a finger crossing them is scrolling it: they move only once selected or held.
  const placed = target?.type === 'obj' && !!objectById(target.id)?.exact;
  const direct = !choosing && !!target && (placed ? isSelected(target) || e.pointerType === 'mouse' : target.type === 'obj' || e.pointerType === 'mouse' || (!target.cell && (isSelected(target) || !stageScrolls())));
  press = { id: e.pointerId, x: e.clientX, y: e.clientY, target, direct, drag: null, timer: null, scrolling: false, moved: false };
  if (target && !direct && !choosing) {
    press.timer = setTimeout(() => {
      if (press?.target) startDragging();
    }, placed ? HOLD_MS * 2 : HOLD_MS);
  }
});

window.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  const far = Math.hypot(e.clientX - press.x, e.clientY - press.y);
  if (press.drag) {
    if (!press.moved && press.target?.cell) {
      if (far <= 6) return;
      select(wholeOf(press.target));
    }
    press.moved = true;
    press.drag.move(e);
    return;
  }
  if (press.direct && press.target) {
    if (far > 5) {
      startDragging();
      if (press.target.cell) select(wholeOf(press.target));
      press.moved = true;
      press.drag.move(e);
    }
  } else if (far > 8) {
    clearTimeout(press.timer);
    press.scrolling = true;
  }
});

let lastTap = { key: null, at: 0 };

function tapOn(target, x, y) {
  if (painter) {
    paintOn(target);
    return;
  }
  if (selection?.type === 'group') {
    if (target) toggleInGroup(target);
    return;
  }
  if (!target) {
    select(null);
    return;
  }
  const key = `${target.type}:${target.id}:${target.cell?.r}:${target.cell?.c}`;
  const already = isSelectedExactly(target);
  const again = already && lastTap.key === key && Date.now() - lastTap.at < 400;
  lastTap = { key, at: Date.now() };
  // A quick second tap on a part opens its text.
  if (again) {
    editSelectionText();
    return;
  }
  // A tap on what is already selected narrows it down to the word under the finger, and on that same word widens it again.
  const word = already ? wordAt(x, y) : null;
  if (word) {
    const same = selection.word?.p === word.p && selection.word.start === word.start;
    select({ ...selection, word: same ? undefined : word });
    return;
  }
  select(target.type === 'section' ? { type: 'section', id: target.id, role: target.role, cell: target.cell } : { type: target.type, id: target.id });
}

window.addEventListener('pointerup', (e) => {
  if (!press || e.pointerId !== press.id) return;
  const { drag, scrolling, target, moved, x, y } = press;
  endPress();
  // A finger held still on a cell and lifted was only a slow tap.
  if (drag && (moved || !target?.cell)) drag.end();
  else if (!scrolling) tapOn(target, x, y);
});

window.addEventListener('pointercancel', (e) => {
  if (!press || e.pointerId !== press.id) return;
  const { drag } = press;
  endPress();
  if (drag) drag.end();
});

// A long press on text must not open Android's text selection in the middle of a drag.
stage.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------- Two fingers zoom ---------- */

let pinch = null;
const touchGap = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
stage.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    pinch = { gap: touchGap(e.touches), scale };
    // The first finger may have started a drag; a second finger means it was a zoom all along.
    const wasDragging = !!press?.drag;
    endPress();
    clearGuides();
    if (wasDragging) render();
  }
}, { passive: true });
stage.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinch) {
    e.preventDefault();
    scale = clamp(pinch.scale * (touchGap(e.touches) / pinch.gap), 0.25, 3);
    applyScale();
    return;
  }
  // Stops the page from scrolling under a part that is being dragged.
  if (press && (press.drag || (press.direct && press.target))) e.preventDefault();
}, { passive: false });
stage.addEventListener('touchend', () => {
  pinch = null;
});

/* ---------- Actions on the selection ---------- */

function nudge(dx, dy) {
  if (selection.type === 'group') {
    change(() => {
      for (const item of selection.items) {
        const o = item.kind === 'frame' ? objectById(item.id) : null;
        if (o) setObjectBox(o, { x: o.x + dx, y: o.y + dy });
      }
    });
    return;
  }
  if (selection.type === 'obj') {
    const o = objectById(selection.id);
    const b = objectBox(o, info);
    change(() => setObjectBox(o, { x: b.x + dx, y: b.y + dy }));
  } else if (selection.type === 'part') {
    const part = partById(selection.id);
    const followers = followersOf(selection.id);
    change(() => {
      setPart(selection.id, { x: part.x + dx, y: part.y + dy });
      for (const f of followers) setPart(f.id, { x: f.x + dx, y: f.y + dy });
    });
  } else {
    const { id } = selection;
    const m = moveOf(id);
    if (freeMode) {
      change(() => setMove(id, { dx: (m.dx || 0) + dx, fy: (m.fy || 0) + dy }));
      return;
    }
    const move = verticalMove(id, (m.dy || 0) + dy);
    if (dy < 0 && Math.abs(move.dy - (m.dy || 0)) < 0.01 && move.top === geomOf(L()).top) {
      toast(FREE_HINT);
      return;
    }
    change(() => commitSection(id, (m.dx || 0) + dx, move));
  }
}

function alignObject(how) {
  const o = objectById(selection.id);
  const b = objectBox(o, info);
  const g = geomOf(L());
  const target = {
    right: { x: PAGE.w - g.right - b.w },
    center: { x: (PAGE.w - b.w) / 2 },
    left: { x: g.left },
    top: { y: g.top },
    middle: { y: (PAGE.h - b.h) / 2 },
    bottom: { y: PAGE.h - g.bottom - b.h },
  }[how];
  change(() => setObjectBox(o, target));
}

function alignPart(how) {
  const part = partById(selection.id);
  const g = geomOf(L());
  const x = { right: PAGE.w - g.right - part.w, center: (PAGE.w - part.w) / 2, left: g.left }[how];
  change(() => setPart(selection.id, part.id === 'logo' || part.id === 'rule' ? { x } : { x, align: how }));
}

function alignSection(how) {
  const { id, role } = selection;
  const letter = L();
  const g = geomOf(letter);
  if (id === 'sign') {
    const dx = { left: 0, center: (g.bodyW - SIGN.col) / 2, right: g.bodyW - SIGN.col }[how] ?? 0;
    change(() => setMove(id, { dx }));
    return;
  }
  change(() => {
    if (selectedTable()) {
      selectedItems().forEach((item) => restyleItem(item, { align: how }));
      syncBodyHtml();
      if (!selection.cell && letter.offsets?.[id]) letter.offsets = { ...letter.offsets, [id]: { ...letter.offsets[id], dx: 0 } };
      return;
    }
    const k = blockIndex(id);
    if (k >= 0) {
      changeBlock(k, { align: how, move: { ...letter.body[k].move, dx: 0 } });
      return;
    }
    letter.styles = { ...letter.styles, [role]: { ...styleOf(letter, role), align: how } };
    // A paragraph aligned on its own keeps that otherwise; for the whole body this button is the stronger request.
    if (id === 'body') {
      letter.body = (letter.body || []).map((b) => {
        if (b.kind !== 'p') return b;
        const { align, ...rest } = b;
        return { ...rest, ...(rest.move && { move: { ...rest.move, dx: 0 } }) };
      });
      syncBodyHtml();
    }
    if (letter.offsets?.[id]) letter.offsets = { ...letter.offsets, [id]: { ...letter.offsets[id], dx: 0 } };
  });
}

function resizeObject(factor) {
  const o = objectById(selection.id);
  const b = objectBox(o, info);
  const w = clamp(b.w * factor, 8, PAGE.w);
  change(() => setObjectBox(o, { w, x: b.x + (b.w - w) / 2, y: o.kind === 'text' ? b.y : b.y + (b.h - w / (o.aspect || 1)) / 2 }));
}

function resizeLogo(factor) {
  const part = partById('logo');
  const aspect = L().letterhead.logoAspect || 1;
  const w = clamp(part.w * factor, 5, PAGE.w);
  change(() => setPart('logo', { w, x: part.x + (part.w - w) / 2, y: part.y + (part.w - w) / aspect / 2 }));
}

async function cleanBackground(mediaId, apply) {
  await withBusy('در حال حذف پس‌زمینه...', async () => {
    const out = await removePaper(mediaUrl(mediaId));
    if (out.empty) {
      toast('چیزی برای جدا کردن از پس‌زمینه پیدا نشد');
      return;
    }
    const id = uid();
    await putMedia(id, out.dataUrl);
    change(() => apply(id, out.aspect));
  });
}

function cleanObjectBackground() {
  const o = objectById(selection.id);
  cleanBackground(o.mediaId, (id, aspect) => {
    o.mediaId = id;
    o.aspect = aspect;
  });
}

function cleanLogoBackground() {
  const lh = L().letterhead;
  cleanBackground(lh.logo, (id, aspect) => {
    lh.logo = id;
    lh.logoAspect = aspect;
  });
}

function removeObject() {
  const { id } = selection;
  selection = null;
  change(() => {
    L().objects = L().objects.filter((o) => o.id !== id);
  });
}

function hidePart() {
  const { id } = selection;
  selection = null;
  change(() => setPart(id, { hidden: true }));
  toast('پنهان شد. از «بخش‌های پنهان» برمی‌گردد.');
}

function resetSelection() {
  if (selection.type === 'part') {
    const { id } = selection;
    change(() => {
      const lh = L().letterhead;
      const parts = { ...lh.parts };
      delete parts[id];
      lh.parts = parts;
    });
    return;
  }
  const { id } = selection;
  change(() => {
    const letter = L();
    const k = blockIndex(id);
    if (k >= 0) {
      const { move, ...rest } = letter.body[k];
      letter.body[k] = rest;
      syncBodyHtml();
      return;
    }
    if (id === 'body') {
      letter.body = (letter.body || []).map(({ move, ...rest }) => rest);
      syncBodyHtml();
    }
    if (id === 'sign') {
      const dx = letter.offsets?.sign?.dx || 0;
      for (const o of letter.objects || []) if (o.anchor === 'sign') o.x -= dx;
    }
    const offsets = { ...letter.offsets };
    delete offsets[id];
    letter.offsets = offsets;
    if (firstBlockOf(id).isFirst && letter.geom) letter.geom = { ...letter.geom, top: Math.max(PAGE.bodyTop, geomOf(letter).top) };
  });
}

function hiddenParts() {
  return headerParts(L(), info.total).filter((p) => p.hidden);
}

function openHiddenParts() {
  const close = openSheet(
    'بخش‌های پنهان',
    h(
      'div',
      { class: 'form-grid' },
      hiddenParts().map((part) => h(
        'button',
        {
          class: 'btn',
          onClick: () => {
            change(() => setPart(part.id, { hidden: false }));
            if (!hiddenParts().length) close();
            else {
              close();
              openHiddenParts();
            }
          },
        },
        `برگرداندن ${PART_LABELS[part.id]}`,
      )),
    ),
  );
}

function resetAllLayout() {
  confirmSheet('بازگشت به چیدمان اولیه', 'جای همهٔ بخش‌های این نامه به حالت اول برمی‌گردد. عکس‌ها و متن‌ها حذف نمی‌شوند.', 'برگرداندن چیدمان', () => {
    change(() => {
      const letter = L();
      const dx = letter.offsets?.sign?.dx || 0;
      for (const o of letter.objects || []) if (o.anchor === 'sign') o.x -= dx;
      letter.offsets = {};
      letter.geom = {};
      letter.letterhead.parts = {};
      letter.styles = clone(DEFAULT_STYLES);
      letter.body = (letter.body || []).map(({ move, over, ...rest }) => rest);
      syncBodyHtml();
    });
  });
}

/**
 * Keeps this letter's letterhead and arrangement for every new letter from now on. After opening one of the
 * office's own Word letters, this single tap sets up the logo, the organisation's name and the signer as well.
 */
function saveAsDefault() {
  const letter = L();
  const s = app.settings;
  const signObjects = {};
  for (const o of letter.objects || []) {
    if (o.anchor !== 'sign' || (o.kind !== 'signature' && o.kind !== 'stamp')) continue;
    signObjects[o.kind] = { x: o.x, dy: o.dy, w: o.w };
    s.signer[o.kind] = o.mediaId;
    s.signer[`${o.kind}Aspect`] = o.aspect;
  }
  s.layout = { styles: clone(letter.styles || {}), offsets: clone(letter.offsets || {}), geom: clone(letter.geom || {}), signObjects };
  s.letterhead = clone(letter.letterhead);
  if (letter.signer?.name) s.signer = { ...s.signer, name: letter.signer.name, title: letter.signer.title };
  saveSettings();
  toast('سربرگ و چیدمان این نامه برای نامه‌های بعدی ذخیره شد');
}

function visiblePage() {
  const stageRect = stage.getBoundingClientRect();
  let best = 0;
  let bestShown = -1;
  for (const box of stageInner.children) {
    const r = box.getBoundingClientRect();
    const shown = Math.min(r.bottom, stageRect.bottom) - Math.max(r.top, stageRect.top);
    if (shown > bestShown) {
      bestShown = shown;
      best = Number(box.dataset.page);
    }
  }
  return best;
}

async function addPicture() {
  const file = await pickImageFile();
  if (!file) return;
  await withBusy('در حال آماده‌سازی عکس...', async () => {
    const img = await importImage(file);
    const id = uid();
    await putMedia(id, img.dataUrl);
    const w = 40;
    const o = { id: uid(), kind: 'image', anchor: 'page', page: visiblePage(), mediaId: id, aspect: img.aspect, x: (PAGE.w - w) / 2, y: geomOf(L()).top + 20, w };
    selection = { type: 'obj', id: o.id };
    change(() => {
      L().objects = [...(L().objects || []), o];
    });
  });
}

function addTextFrame() {
  const w = 70;
  const o = { id: uid(), kind: 'text', anchor: 'page', page: visiblePage(), x: (PAGE.w - w) / 2, y: geomOf(L()).top + 30, w, text: 'متن کادر', border: true, style: { ...TEXT_STYLE, align: 'center' } };
  selection = { type: 'obj', id: o.id };
  change(() => {
    L().objects = [...(L().objects || []), o];
  });
  editSelectionText();
}

function addSigner(kind) {
  const signer = app.settings.signer;
  const wanted = signObjectsFor(signer, app.settings.layout?.signObjects).filter((o) => o.kind === kind);
  if (!wanted.length) {
    toast(kind === 'signature' ? 'اول عکس امضا را در تنظیمات اضافه کنید' : 'اول عکس مهر را در تنظیمات اضافه کنید');
    showScreen('settings');
    return;
  }
  selection = { type: 'obj', id: wanted[0].id };
  remember();
  L().objects = [...(L().objects || []).filter((o) => o.kind !== kind), ...wanted];
  saveLetter();
  ensureMedia(mediaIdsOf(L())).then(render);
}

/* ---------- What a change applies to ---------- */

const cellOfItem = (item) => tableOfId(item.t)?.rows[item.r]?.[item.c] || null;
const tableSize = () => styleOf(L(), 'table').size;

/** Every cell, paragraph and frame that the selection covers. None for a part that changes as a whole, such as the recipient. */
function selectedItems() {
  if (!selection) return [];
  if (selection.type === 'group') return selection.items;
  if (selection.type === 'obj') return objectById(selection.id)?.kind === 'text' ? [{ kind: 'frame', id: selection.id }] : [];
  if (selection.type !== 'section') return [];
  if (selection.cell) return [{ kind: 'cell', t: selection.id, ...selection.cell }];
  if (selection.id.startsWith('table:')) return (tableOfId(selection.id)?.rows || []).flatMap((row, r) => row.map((_, c) => ({ kind: 'cell', t: selection.id, r, c })));
  const k = blockIndex(selection.id);
  return k >= 0 ? [{ kind: 'block', k }] : [];
}

function restyleItem(item, patch) {
  if (item.kind === 'cell') {
    const cell = cellOfItem(item);
    if (cell) restyleCell(cell, patch, tableSize());
  } else if (item.kind === 'block') {
    if (L().body[item.k]) L().body[item.k] = restyleBlock(L().body[item.k], patch);
  } else {
    const o = objectById(item.id);
    if (o) restyleFrame(o, patch);
  }
}

function resetItem(item) {
  if (item.kind === 'cell') {
    const cell = cellOfItem(item);
    if (cell) resetCell(cell);
  } else if (item.kind === 'block') {
    if (L().body[item.k]) L().body[item.k] = resetBlock(L().body[item.k]);
  } else {
    const o = objectById(item.id);
    if (o) resetFrame(o);
  }
}

function restyleWord(patch) {
  const { word, type, id } = selection;
  if (type === 'obj') {
    restyleFrameWord(L(), objectById(id), word, patch);
    return;
  }
  const cell = selectedCell();
  if (cell) restyleCellWord(L(), cell, word, patch, tableSize());
  else L().body[blockIndex(id)] = restyleBlockWord(L(), L().body[blockIndex(id)], word, patch);
  syncBodyHtml();
}

/** A part that has no words of its own to change, such as the recipient, changes through its style. The first style is kept for going back. */
function restylePart(role, patch) {
  const letter = L();
  if (!letter.firstStyles) letter.firstStyles = clone(letter.styles || {});
  letter.styles = { ...letter.styles, [role]: { ...styleOf(letter, role), ...patch } };
}

function changeStyle(patch) {
  const { type, id, role, word } = selection;
  change(() => {
    if (word) {
      restyleWord(patch);
      return;
    }
    const items = selectedItems();
    if (items.length) {
      items.forEach((item) => restyleItem(item, patch));
      syncBodyHtml();
      return;
    }
    restylePart(type === 'part' ? partById(id).role : role, patch);
    // Choosing for the whole body overrides what single paragraphs and words had set for themselves.
    if (id === 'body') {
      const keys = Object.keys(patch).map((key) => ({ font: 'font', size: 'size', bold: 'b', underline: 'u', color: 'color' })[key]).filter(Boolean);
      L().body = L().body.map((b) => {
        if (b.kind !== 'p') return b;
        const runs = clearLook(b.runs, keys);
        if (!b.over) return { ...b, runs };
        const over = { ...b.over };
        for (const key of Object.keys(patch)) delete over[key];
        return { ...b, over, runs };
      });
      syncBodyHtml();
    }
  });
}

const stepOf = (size, direction) => clamp(direction > 0 ? size + (size < 10 ? 0.5 : 1) : size - (size <= 10 ? 0.5 : 1), 4, 96);

/** Bigger or smaller by a step. Things of different sizes each take their own step, and stay different. */
function stepSize(direction) {
  const items = selection.word ? [] : selectedItems();
  if (items.length < 2) {
    changeStyle({ size: stepOf(currentLook().size, direction) });
    return;
  }
  change(() => {
    items.forEach((item) => restyleItem(item, { size: stepOf(itemLook(item).size, direction) }));
    syncBodyHtml();
  });
}

/** Takes what is selected back to how it first looked. */
function resetLook() {
  const { word, type, id, role } = selection;
  change(() => {
    if (word) {
      if (type === 'obj') resetFrameWord(L(), objectById(id), word);
      else if (selectedCell()) resetCellWord(L(), selectedCell(), word, tableSize());
      else L().body[blockIndex(id)] = resetBlockWord(L(), L().body[blockIndex(id)], word);
      syncBodyHtml();
      return;
    }
    const items = selectedItems();
    if (items.length) {
      items.forEach(resetItem);
      syncBodyHtml();
      return;
    }
    const r = type === 'part' ? partById(id).role : role;
    const styles = { ...L().styles };
    const first = L().firstStyles?.[r];
    if (first) styles[r] = first;
    else delete styles[r];
    L().styles = styles;
  });
}

/* ---------- The look something has right now ---------- */

const anyText = (runs) => (runs || []).find((run) => run.text);

/** The look of a table's cell, a header's words being thick unless they say otherwise. */
function cellLook(table, r, cell) {
  const st = styleOf(L(), 'table');
  const base = { ...st, bold: st.bold || (table.header !== false && r === 0) };
  const paragraph = cell?.paras.find((p) => anyText(p.runs)) || cell?.paras[0];
  return { ...lookOfRun(anyText(paragraph?.runs), base), align: paragraph?.align || st.align, bg: cell?.bg, hasText: !!anyText(paragraph?.runs) };
}

function itemLook(item) {
  if (item.kind === 'cell') return cellLook(tableOfId(item.t), item.r, cellOfItem(item));
  if (item.kind === 'block') {
    const b = L().body[item.k];
    return { ...lookOfRun(anyText(b?.runs), { ...styleOf(L(), 'body'), ...b?.over }), ...(b?.align && { align: b.align }), hasText: !!anyText(b?.runs) };
  }
  const o = objectById(item.id);
  return { ...lookOfRun(frameLines(o).flat().find((run) => run.text), { ...TEXT_STYLE, ...o.style }), fill: o.fill, hasText: true };
}

/** The look the selected word has right now. */
function wordLook() {
  const { word, type, id } = selection;
  if (type === 'obj') {
    const o = objectById(id);
    return lookOfRun(runAt(frameLines(o)[word.p], word.start), { ...TEXT_STYLE, ...o.style });
  }
  const cell = selectedCell();
  if (cell) return lookOfRun(runAt(cell.paras[word.p]?.runs, word.start), cellLook(selectedTable(), selection.cell.r, cell));
  const b = L().body[blockIndex(id)];
  return lookOfRun(runAt(b?.runs, word.start), { ...styleOf(L(), 'body'), ...b?.over });
}

/** The look of what is selected. Where several things differ, the first one's, with a note of what differs. */
function currentLook() {
  if (selection.word) return wordLook();
  const items = selectedItems();
  if (!items.length) {
    if (selection.type === 'part') {
      const part = partById(selection.id);
      return { ...styleOf(L(), part.role), ...(part.align && { align: part.align }) };
    }
    return styleOf(L(), selection.role);
  }
  const looks = items.map(itemLook);
  const withText = looks.filter((look) => look.hasText);
  const first = withText[0] || looks[0];
  return { ...first, mixedSize: withText.some((look) => look.size !== first.size), mixedFont: withText.some((look) => look.font !== first.font) };
}

const sectionStyle = () => currentLook();

/* ---------- Colour, fill, lines and exact size ---------- */

function pickColor() {
  openColorSheet({ title: 'رنگ متن', kind: 'text', current: currentLook().color, noneLabel: 'رنگ معمولی (سیاه)', onPick: (color) => changeStyle({ color }) });
}

function pickSize() {
  const st = currentLook();
  openSizeSheet({ current: st.mixedSize ? null : st.size, onPick: (size) => changeStyle({ size }) });
}

function pickFill() {
  const items = selectedItems();
  const look = items.length ? itemLook(items[0]) : {};
  openColorSheet({
    title: 'رنگ زمینه',
    kind: 'fill',
    current: look.bg || look.fill,
    noneLabel: 'بدون رنگ زمینه',
    onPick: (color) => change(() => {
      for (const item of selectedItems()) {
        if (item.kind === 'cell') restyleItem(item, { bg: color });
        else if (item.kind === 'frame') restyleItem(item, { fill: color });
      }
      syncBodyHtml();
    }),
  });
}

function pickLines() {
  openLinesSheet({
    onApply: (sides, width) => change(() => {
      for (const item of selectedItems()) {
        if (item.kind === 'cell') setCellLines(tableOfId(item.t), item.r, item.c, sides, width);
      }
      syncBodyHtml();
    }),
  });
}

/* ---------- Copying a look ---------- */

const lookToKeep = (look) => ({ font: look.font, size: look.size, bold: !!look.bold, underline: !!look.underline, color: look.color || null, ...(look.bg && { bg: look.bg }) });

/** Takes the look of what is selected. From then on a tap gives that look to whatever it lands on, until this is ended. */
function startPainter() {
  painter = lookToKeep(currentLook());
  select(null);
  toast('قالب برداشته شد');
}

function endPainter() {
  painter = null;
  paintTools();
}

function paintOn(target) {
  if (!target) return;
  const item = itemOfTarget(target);
  if (item) {
    change(() => {
      restyleItem(item, painter);
      syncBodyHtml();
    });
    return;
  }
  const role = target.type === 'part' ? partById(target.id)?.role : target.role;
  if (role) {
    const { bg, ...patch } = painter;
    change(() => restylePart(role, patch));
  }
}

function openLooks() {
  const st = currentLook();
  openLooksSheet({
    current: lookToKeep(st),
    describe: `${st.font}، ${toFaDigits(st.size)}`,
    onApply: ({ id, name, ...patch }) => changeStyle(patch),
  });
}

/* ---------- A group of cells, rows, paragraphs and frames, far apart if need be ---------- */

function itemOfTarget(target) {
  if (target.type === 'obj') return objectById(target.id)?.kind === 'text' ? { kind: 'frame', id: target.id } : null;
  if (target.type !== 'section') return null;
  if (target.cell) return { kind: 'cell', t: target.id, ...target.cell };
  const k = blockIndex(target.id);
  return k >= 0 ? { kind: 'block', k } : null;
}

const sameItem = (a, b) => a.kind === b.kind && a.t === b.t && a.r === b.r && a.c === b.c && a.k === b.k && a.id === b.id;

function startGroup() {
  const items = selectedItems();
  tableAll = false;
  bodyAll = false;
  select({ type: 'group', items, last: items[items.length - 1] || null });
}

function toggleInGroup(target) {
  const item = itemOfTarget(target);
  if (!item) return;
  const inGroup = selection.items.some((other) => sameItem(other, item));
  select({ ...selection, items: inGroup ? selection.items.filter((other) => !sameItem(other, item)) : [...selection.items, item], last: item });
}

/** Adds to the group many at once. If they are all in it already, takes them out. */
function addAll(items) {
  const allIn = items.every((item) => selection.items.some((other) => sameItem(other, item)));
  select({
    ...selection,
    items: allIn
      ? selection.items.filter((other) => !items.some((item) => sameItem(other, item)))
      : [...selection.items, ...items.filter((item) => !selection.items.some((other) => sameItem(other, item)))],
  });
}

function addLine(axis) {
  const { last } = selection;
  if (last?.kind !== 'cell') return;
  const grid = cellGrid(tableOfId(last.t));
  const me = grid.find((o) => o.r === last.r && o.c === last.c);
  if (!me) return;
  const line = axis === 'row' ? grid.filter((o) => o.r === me.r) : grid.filter((o) => o.col < me.col + me.span && o.col + o.span > me.col);
  addAll(line.map((o) => ({ kind: 'cell', t: last.t, r: o.r, c: o.c })));
}

const cellWords = (cell) => cell.paras.map((p) => runsText(p.runs)).join('\n').trim();

/** Every cell in the letter that holds the same words as the last one tapped. */
function addSimilar() {
  const { last } = selection;
  if (last?.kind !== 'cell') return;
  const wanted = cellWords(cellOfItem(last));
  if (!wanted) return;
  const similar = [];
  L().body.filter((b) => b.kind === 'table').forEach((table, n) => {
    table.rows.forEach((row, r) => row.forEach((cell, c) => {
      if (cellWords(cell) === wanted) similar.push({ kind: 'cell', t: `table:${n}`, r, c });
    }));
  });
  addAll(similar);
  toast(`${toFaDigits(similar.length)} خانه با همین متن`);
}

/** The same words into every cell of the group. */
function writeInGroup() {
  const cells = selection.items.filter((item) => item.kind === 'cell');
  if (!cells.length) return;
  const field = h('textarea', { class: 'textarea', placeholder: 'برای خالی کردن خانه‌ها، خالی بگذار' });
  const close = openSheet(
    `متن ${toFaDigits(cells.length)} خانه`,
    h(
      'div',
      { class: 'form-grid' },
      field,
      h('button', {
        class: 'btn primary',
        onClick: () => {
          const lines = field.value.split('\n');
          change(() => {
            for (const item of cells) {
              const cell = cellOfItem(item);
              if (cell) fillCell(tableOfId(item.t), item.r, cell, lines);
            }
            syncBodyHtml();
          });
          close();
        },
      }, 'تأیید'),
    ),
  );
  field.focus();
}

/** More lines into the group, going by the last one tapped: its column, its page, or everything set in the same look. */
function addFrames(kind) {
  const o = objectById(selection.last?.id);
  if (!o) return;
  const letter = L();
  const frames = kind === 'column' ? columnOf(letter, o) : kind === 'page' ? letter.objects.filter((x) => x.kind === 'text' && x.page === o.page) : sameLookAs(letter, o);
  addAll(frames.map((x) => ({ kind: 'frame', id: x.id })));
  toast(`${toFaDigits(String(frames.length))} سطر`);
}

const groupFrames = () => selection.items.map((item) => (item.kind === 'frame' ? objectById(item.id) : null)).filter(Boolean);

function removeGroup() {
  const gone = new Set(groupFrames().map((o) => o.id));
  confirmSheet('حذف گروه', `${toFaDigits(String(gone.size))} مورد از صفحه برداشته می‌شود.`, 'حذف شود', () => {
    selection = null;
    change(() => {
      L().objects = L().objects.filter((o) => !gone.has(o.id));
    });
  });
}

/* ---------- Taking out, adding and merging in a table ---------- */

/** The cells the selection holds, table by table. A group may hold cells of several tables. */
function chosenCells() {
  const byTable = new Map();
  for (const item of selectedItems()) {
    if (item.kind !== 'cell') continue;
    const cell = cellOfItem(item);
    if (!cell) continue;
    const table = tableOfId(item.t);
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(cell);
  }
  return [...byTable].map(([table, cells]) => ({ table, cells }));
}

const endSelection = () => {
  selection = null;
  tableAll = false;
};

function removeTable(table) {
  confirmSheet('حذف جدول', 'کل این جدول از نامه برداشته می‌شود.', 'حذف شود', () => {
    endSelection();
    change(() => {
      dropTable(L(), table);
      syncBodyHtml();
    });
    toast('جدول حذف شد');
  });
}

/** Asks how to take out what is selected, then does it. Cells far apart are taken out together, and it all comes back with one undo. */
function deleteInTable() {
  const targets = chosenCells();
  if (!targets.length) return;
  openDeleteSheet(targets, {
    onWholeTable: targets.length === 1 && selection.type !== 'group' ? () => removeTable(targets[0].table) : null,
    onPick: (how) => {
      const notes = [];
      endSelection();
      change(() => {
        for (const { table, cells } of targets) notes.push(deleteFrom(table, cells, how));
        dropEmptyTables(L());
        syncBodyHtml();
      });
      toast(deleteNote(notes));
    },
  });
}

/** One more row right under the selected cell. The selection stays, so another tap adds another. */
function addRowBelow() {
  const table = selectedTable();
  const place = placeOfCell(table, selectedCell());
  if (!place) return;
  let renumbered = false;
  change(() => {
    renumbered = insertRow(table, place.r + place.rowSpan);
    syncBodyHtml();
  });
  if (renumbered) toast('ردیف‌ها دوباره شماره خوردند');
}

/** One more column right beside the selected cell, on its left. */
function addColumnBeside() {
  const table = selectedTable();
  const place = placeOfCell(table, selectedCell());
  if (!place) return;
  change(() => {
    insertColumn(table, place.col + place.span);
    syncBodyHtml();
  });
}

function splitSelectedCell() {
  const table = selectedTable();
  const cell = selectedCell();
  if (!cell) return;
  change(() => {
    unmergeCell(table, cell);
    syncBodyHtml();
  });
}

/** The group's cells of one table as one cell. */
function mergeGroup() {
  const { last } = selection;
  const target = chosenCells().find(({ table }) => table === tableOfId(last?.t)) || chosenCells()[0];
  if (!target || target.cells.length < 2) {
    toast('حداقل دو خانه از یک جدول انتخاب کن');
    return;
  }
  let count = 0;
  endSelection();
  change(() => {
    count = mergeCells(target.table, target.cells);
    syncBodyHtml();
  });
  toast(`${toFaDigits(count)} خانه یکی شد`);
}

/** The sheet with everything for a table, with what is selected already picked in it. */
function openTableTools() {
  const targets = chosenCells();
  const id = selection?.type === 'group' ? selection.last?.t : selection?.id;
  const table = id?.startsWith('table:') ? tableOfId(id) : targets[0]?.table;
  if (!table) return;
  const picked = selection?.cell || selection?.type === 'group' ? targets.find((t) => t.table === table)?.cells || [] : [];
  openTableSheet(table, {
    picked,
    // Rows and columns change under what was selected, so it is chosen again afterwards.
    before: () => {
      if (selection) endSelection();
      remember();
    },
    after: () => {
      syncBodyHtml();
      saveLetter();
      render();
    },
  });
}

/* ---------- Blanks and forms ---------- */

function openFill() {
  openFillSheet(L(), {
    onFill: (values) => change(() => {
      fillBlanks(L(), values);
      syncBodyHtml();
    }),
  });
}

/** The words of whatever is selected. */
function selectedWords() {
  if (selection.word) return selection.word.text;
  if (selection.type === 'obj') return objectById(selection.id)?.text || '';
  if (selection.cell) return (selectedCell()?.paras || []).map((p) => runsText(p.runs)).join(' ');
  const k = blockIndex(selection.id);
  return k >= 0 ? runsText(L().body[k]?.runs) : '';
}

const addField = (name) => {
  L().fields = [...new Set([...(L().fields || []), name])];
};

/** Some words, or an empty cell, become a place to fill in each time. */
function markBlank() {
  const text = selectedWords().trim();
  const cell = selectedCell();
  openMarkSheet({
    text,
    count: (find) => replaceEverywhere(L(), find, undefined, { whole: true }),
    onApply: (find, name) => change(() => {
      if (find) replaceEverywhere(L(), find, `[${name}]`, { whole: true });
      else if (cell) fillCell(selectedTable(), selection.cell.r, cell, [`[${name}]`]);
      addField(name);
      if (selection.word) selection = { ...selection, word: undefined };
      syncBodyHtml();
    }),
  });
}

/** A blank on an empty spot of the page, such as a dotted line in a scanned form. */
function addBlankFrame() {
  openNameSheet({
    title: 'جای خالی تازه',
    label: 'نام جای خالی',
    placeholder: 'مثلاً: نام متقاضی',
    note: 'بعد از تأیید، آن را با انگشت به جای درستش روی صفحه ببر.',
    onDone: (name) => {
      const o = { id: uid(), kind: 'text', anchor: 'page', page: visiblePage(), x: (PAGE.w - 50) / 2, y: PAGE.h / 3, w: 50, text: `[${name}]`, border: false, style: { ...TEXT_STYLE, size: 12 } };
      selection = { type: 'obj', id: o.id };
      change(() => {
        L().objects = [...L().objects, o];
        addField(name);
      });
    },
  });
}

/** Keeps this file, with its blanks, as something to start from: it opens with its blanks asked for, and every time stays as it was. */
function saveAsForm() {
  const letter = L();
  openNameSheet({
    title: 'ذخیره به‌عنوان فرم',
    label: 'نام فرم',
    value: letter.sourceName || '',
    placeholder: 'مثلاً: گواهی اشتغال',
    note: 'از این به بعد در صفحهٔ اول، کنار قالب‌ها هست و با یک لمس فقط جاهای خالی‌اش را می‌پرسد.',
    onDone: async (title) => {
      const { id, createdAt, updatedAt, startedAt, durationSec, activeSec, status, templateId, ...whole } = clone(letter);
      await saveTemplate({ id: uid(), title, bodyHtml: '', body: [], whole });
      toast(`فرم «${title}» ذخیره شد`);
    },
  });
}

/* ---------- Text that wraps by itself, in place of separate lines ---------- */

const hintForFont = (font) => (fontIsHere(font) ? null : h(
  'div',
  { class: 'tool-hint' },
  `فونت «${font}» روی این دستگاه نیست؛ اینجا با فونت مشابه دیده می‌شود، ولی در Word با همان فونت می‌آید. `,
  h('button', { class: 'btn small', onClick: addFontFile }, 'افزودن فایل فونت'),
));

async function addFontFile() {
  const file = await pickFile(FONT_ACCEPT);
  if (!file) return;
  await withBusy('در حال نصب فونت...', async () => {
    try {
      const family = await installFont(file, app.settings);
      await saveSettings();
      toast(`فونت «${family}» اضافه شد`, 3200);
      render();
    } catch (err) {
      console.error(err);
      toast('این فایل فونت TTF یا OTF سالم نیست.', 3600);
    }
  });
}

/**
 * One text for some lines, or for a paragraph made earlier. The words wrap by themselves inside the column at the same spacing,
 * and what stands below in the column moves as far as the text grew or shrank.
 */
function openFlowEditor(lines, existing) {
  const text = existing ? existing.text : textOfLines(lines);
  const st = { ...TEXT_STYLE, ...(existing || lines[0]).style };
  const field = h('textarea', { class: 'textarea flow-text', rows: 9, value: text });
  const close = openSheet(
    existing ? 'متن این پاراگراف' : `متن ${toFaDigits(String(lines.length))} سطر`,
    h(
      'div',
      { class: 'form-grid' },
      field,
      h('p', { class: 'note', style: { margin: 0 } }, 'متن خودش در همان ستون می‌چیند. برای بند تازه، یک خط پایین‌تر برو.'),
      hintForFont(st.font),
      h('button', {
        class: 'btn primary',
        onClick: () => {
          const words = field.value.trim();
          close();
          if (words === text) return;
          let ranOff = false;
          change(() => {
            const letter = L();
            let frame = existing;
            let bottom;
            if (frame) {
              bottom = frame.y + frame.h;
              frame.text = words;
              delete frame.lines;
              delete frame.orig;
            } else ({ frame, bottom } = mergeIntoFlow(letter, lines, words));
            if (!words) {
              letter.objects = letter.objects.filter((o) => o !== frame);
              selection = null;
              return;
            }
            frame.h = frameHeightMm(letter, frame);
            const dy = frame.y + frame.h - bottom;
            if (Math.abs(dy) > frame.style.line * MM_PER_PT * 0.4) ranOff = shiftBelow(letter, frame, bottom, dy);
            selection = { type: 'obj', id: frame.id };
          });
          if (ranOff) toast('متن از پایین صفحه بیرون زده است؛ کمی کوتاهش کن یا بقیهٔ ستون را جابه‌جا کن.', 4200);
        },
      }, 'تأیید'),
    ),
  );
  field.focus();
}

/* ---------- A new picture in an old frame, and whole pages ---------- */

async function replacePicture() {
  const o = objectById(selection.id);
  const file = await pickImageFile();
  if (!file) return;
  await withBusy('در حال آماده‌سازی عکس...', async () => {
    const url = await pictureForFrame(file, { widthMm: o.w, aspect: o.aspect || 1, outline: o.outline });
    const id = uid();
    await putMedia(id, url);
    change(() => {
      o.mediaId = id;
    });
  });
}

function openPagesSheet() {
  const letter = L();
  const page = visiblePage();
  const total = letter.body.length;
  const go = (fn, target) => {
    close();
    selection = null;
    change(fn);
    pageBox(Math.min(target, L().body.length - 1))?.scrollIntoView({ block: 'start' });
  };
  const close = openSheet(
    `صفحهٔ ${toFaDigits(String(page + 1))} از ${toFaDigits(String(total))}`,
    h(
      'div',
      null,
      h('button', { class: 'sheet-action', onClick: () => go(() => duplicatePage(L(), page), page + 1) }, icon('copy'), 'یک کپی از این صفحه'),
      h('button', { class: 'sheet-action', disabled: page === 0, onClick: () => go(() => movePage(L(), page, -1), page - 1) }, icon('up'), 'بردن به یک صفحه جلوتر'),
      h('button', { class: 'sheet-action', disabled: page === total - 1, onClick: () => go(() => movePage(L(), page, 1), page + 1) }, icon('down'), 'بردن به یک صفحه عقب‌تر'),
      h('button', {
        class: 'sheet-action danger',
        disabled: total < 2,
        onClick: () => {
          close();
          confirmSheet('حذف صفحه', `صفحهٔ ${toFaDigits(String(page + 1))} با همهٔ متن و عکس‌هایش حذف می‌شود.`, 'حذف شود', () => {
            selection = null;
            change(() => deletePage(L(), page));
          });
        },
      }, icon('trash'), 'حذف این صفحه'),
    ),
  );
}

/* ---------- Copying a frame or picture, and turning a picture ---------- */

function duplicateObject() {
  const o = objectById(selection.id);
  const copy = { ...clone(o), id: uid(), x: o.x + 6, y: (o.y || 0) + 6 };
  if (o.anchor === 'sign') copy.dy = o.dy + 6;
  delete copy.orig;
  selection = { type: 'obj', id: copy.id };
  change(() => {
    L().objects = [...L().objects, copy];
  });
}

function rotateObject(degrees) {
  const o = objectById(selection.id);
  change(() => {
    const turned = ((o.rotate || 0) + degrees + 540) % 360 - 180;
    if (turned) o.rotate = turned;
    else delete o.rotate;
  });
}

function openFind() {
  openFindSheet({
    count: (find) => replaceEverywhere(L(), find),
    replace: (find, text) => {
      if (!replaceEverywhere(L(), find)) return 0;
      let done = 0;
      change(() => {
        done = replaceEverywhere(L(), find, text);
        syncBodyHtml();
      });
      return done;
    },
  });
}

/* ---------- Editing text in place ---------- */

function textFieldsOf(sel) {
  const letter = L();
  const lh = letter.letterhead;
  if (sel.type === 'obj') {
    const o = objectById(sel.id);
    return o.kind === 'text' ? [{ label: 'متن کادر', value: o.text, multi: true, set: (v) => { o.text = v; } }] : null;
  }
  if (sel.type === 'part') {
    const fields = {
      invocation: [{ label: 'عبارت بالای نامه', value: lh.invocation, set: (v) => { lh.invocation = v; } }],
      org: [{ label: 'نام سازمان (هر خط جدا)', value: (lh.org || []).join('\n'), multi: true, set: (v) => { lh.org = v.split('\n').map((s) => s.trim()).filter(Boolean); } }],
      number: [{ label: 'شماره', value: letter.number, set: (v) => { letter.number = v; } }],
      date: [{ label: 'تاریخ', value: letter.date, set: (v) => { letter.date = v; } }],
      attachment: [{ label: 'پیوست', value: letter.attachment, set: (v) => { letter.attachment = v; letter.attachmentManual = true; } }],
      footer: [{ label: 'پایین صفحه', value: lh.footer, set: (v) => { lh.footer = v; } }],
    };
    return fields[sel.id] || null;
  }
  const fields = {
    recipient: [
      { label: 'نام گیرنده', value: letter.recipient?.name, set: (v) => { letter.recipient = { ...letter.recipient, name: v }; } },
      { label: 'سمت گیرنده', value: letter.recipient?.title, set: (v) => { letter.recipient = { ...letter.recipient, title: v }; } },
    ],
    subject: [{ label: 'موضوع', value: letter.subject, set: (v) => { letter.subject = v; } }],
    greeting: [{ label: 'شروع نامه', value: letter.greeting, set: (v) => { letter.greeting = v; letter.greetingEdited = true; } }],
    closing: [{ label: 'پایان نامه', value: letter.closing, set: (v) => { letter.closing = v; letter.closingEdited = true; } }],
    sign: [
      { label: 'نام امضاکننده', value: letter.signer?.name, set: (v) => { letter.signer = { ...letter.signer, name: v }; } },
      { label: 'سمت امضاکننده', value: letter.signer?.title, set: (v) => { letter.signer = { ...letter.signer, title: v }; } },
    ],
    cc: [{ label: 'رونوشت (هر گیرنده در یک خط)', value: letter.cc, multi: true, set: (v) => { letter.cc = v; } }],
  };
  return fields[sel.id] || null;
}

/** New words for a cell, each line a paragraph, in the look its words had. An empty cell takes the look of the words next to it. */
function cellParasFor(table, r, cell, lines) {
  const lookOf = (p) => {
    const own = (p.runs || []).find((run) => run.text);
    const beside = table.rows[r].flatMap((other) => other.paras.flatMap((q) => q.runs || [])).find((run) => run.text);
    const { text, ...look } = own || beside || {};
    return look;
  };
  return lines.map((text, i) => {
    const old = cell.paras[Math.min(i, cell.paras.length - 1)];
    return { ...old, runs: text ? [{ text, ...lookOf(old) }] : [] };
  });
}

/** New words in a cell. A place that was left empty, once written in, is a cell again and has its lines back. */
function fillCell(table, r, cell, lines) {
  if (isHole(cell) && lines.join('').trim()) delete cell.borders;
  cell.paras = cellParasFor(table, r, cell, lines);
}

/** The next cell in reading order, whichever row it is in. A place left empty on purpose is passed over. */
function cellAfter(table, { r, c }) {
  for (let y = r; y < table.rows.length; y++) {
    const row = table.rows[y];
    for (let x = y === r ? c + 1 : 0; x < row.length; x++) if (!isHole(row[x])) return { r: y, c: x };
  }
  return null;
}

/** A cell edited where it stands, without leaving the page: a form's columns are far too fine to type into at phone width, and going through the cells one by one fills a table fast. */
function openCellEditor(table, { r, c }) {
  const cell = table.rows[r]?.[c];
  if (!cell) return false;
  // A picture in a cell needs the full editor, which keeps it.
  if (table.pad === undefined && cell.paras.some((p) => (p.runs || []).some((run) => run.img))) return false;
  const textOf = (p) => (p.runs || []).map((run) => run.text || '').join('');
  const many = cell.paras.length > 1;
  const value = cell.paras.map(textOf).join('\n');
  const next = cellAfter(table, { r, c });
  const field = many ? h('textarea', { class: 'textarea', value }) : h('input', { class: 'input', value, enterkeyhint: next ? 'next' : 'done' });
  const save = () => {
    const lines = field.value.split('\n');
    // A word set apart keeps its look as long as the words stay as they were.
    if (field.value !== value) {
      change(() => {
        fillCell(table, r, cell, lines);
        if (selection?.word) selection = { ...selection, word: undefined };
        syncBodyHtml();
      });
    }
  };
  const done = () => {
    save();
    close();
  };
  const goNext = () => {
    save();
    close();
    select({ ...selection, cell: next, word: undefined });
    openCellEditor(table, next);
  };
  const close = openSheet(
    'متن این خانه',
    h(
      'div',
      { class: 'form-grid' },
      field,
      h(
        'div',
        { class: 'hex-row' },
        h('button', { class: 'btn primary grow', onClick: done }, 'تأیید'),
        next && h('button', { class: 'btn', onClick: goNext }, 'خانهٔ بعدی'),
      ),
    ),
  );
  if (!many) {
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (next) goNext();
      else done();
    });
  }
  field.focus();
  // A [blank] is there to be written over. Other words are more likely to be corrected, from their end.
  if (/^\[[^\]\n]+\]$/.test(value)) field.select();
  else field.setSelectionRange(value.length, value.length);
  return true;
}

function editSelectionText() {
  if (!selection) return;
  const cellTable = selection.cell ? selectedTable() : null;
  if (cellTable && openCellEditor(cellTable, selection.cell)) return;
  // New words change where every word stands.
  if (selection.word) selection = { ...selection, word: undefined };
  // The body and tables have the full editor, with its phrases and blanks.
  if (selection.type === 'section' && (selection.id.startsWith('body') || selection.id.startsWith('table:'))) {
    const k = blockIndex(selection.id);
    selection = null;
    goBack();
    app.screens.compose.focusBody(k);
    return;
  }
  if (selection.type === 'obj' && objectById(selection.id)?.flow) {
    openFlowEditor(null, objectById(selection.id));
    return;
  }
  const fields = textFieldsOf(selection);
  if (!fields) return;
  const inputs = fields.map((f) => (f.multi
    ? h('textarea', { class: 'textarea', value: f.value || '' })
    : h('input', { class: 'input', value: f.value || '' })));
  const close = openSheet(
    'ویرایش متن',
    h(
      'div',
      { class: 'form-grid' },
      fields.map((f, i) => h('label', null, h('div', { class: 'mini-label' }, f.label), inputs[i])),
      h('button', {
        class: 'btn primary',
        onClick: () => {
          change(() => fields.forEach((f, i) => f.set(inputs[i].value.trim())));
          close();
        },
      }, 'تأیید'),
    ),
  );
  inputs[0].focus();
}

/* ---------- Toolbars ---------- */

function toolBtn(name, label, fn, attrs = {}) {
  return h('button', { class: 'icon-btn', 'aria-label': label, title: label, onClick: fn, ...attrs }, icon(name));
}

const SEP = () => h('span', { class: 'sep' });

function nudgeButtons() {
  return [
    toolBtn('up', 'جابه‌جایی به بالا', () => nudge(0, -1)),
    toolBtn('down', 'جابه‌جایی به پایین', () => nudge(0, 1)),
    toolBtn('right', 'جابه‌جایی به راست', () => nudge(1, 0)),
    toolBtn('left', 'جابه‌جایی به چپ', () => nudge(-1, 0)),
  ];
}

function textStyleRow(st) {
  const fonts = !st.font || allFonts().includes(st.font) ? allFonts() : [st.font, ...allFonts()];
  const options = fonts.map((f) => {
    const opt = h('option', { value: f }, f);
    opt.selected = !st.mixedFont && f === st.font;
    return opt;
  });
  if (st.mixedFont) {
    const blank = h('option', { value: '' }, '—');
    blank.selected = true;
    options.unshift(blank);
  }
  return h(
    'div',
    { class: 'tool-row' },
    h('select', { 'aria-label': 'فونت', onChange: (e) => e.target.value && changeStyle({ font: e.target.value }) }, options),
    toolBtn('minus', 'کوچک‌تر', () => stepSize(-1)),
    h('button', { class: 'size-btn', 'aria-label': 'اندازهٔ قلم', title: 'اندازهٔ قلم', onClick: pickSize }, h('b', null, st.mixedSize ? '—' : toFaDigits(st.size))),
    toolBtn('plus', 'بزرگ‌تر', () => stepSize(1)),
    toolBtn('bold', 'توپر', () => changeStyle({ bold: !st.bold }), { class: `icon-btn${st.bold ? ' on' : ''}` }),
    toolBtn('underline', 'زیرخط', () => changeStyle({ underline: !st.underline }), { class: `icon-btn${st.underline ? ' on' : ''}` }),
    h(
      'button',
      { class: 'icon-btn tool-color', 'aria-label': 'رنگ متن', title: 'رنگ متن', onClick: pickColor },
      icon('color'),
      h('span', { class: 'color-bar', style: { background: st.color ? `#${st.color}` : 'currentColor' } }),
    ),
  );
}

/** Taking a look, saved looks and going back to the first look, which every kind of text has. */
const lookButtons = () => [
  toolBtn('eyedropper', 'برداشتن قالب برای چیزهای دیگر', startPainter),
  toolBtn('styles', 'سبک‌ها', openLooks),
  toolBtn('eraser', 'برگشت به حالت اول', resetLook),
];

const multiButton = () => h('button', { class: 'btn small', onClick: startGroup }, icon('multi'), 'چندتایی');

const WORD_HINT = 'برای تغییر فقط یک کلمه، دوباره روی همان کلمه بزن';

const wordHint = () => (selectedWordCount() > 1 ? h('div', { class: 'tool-hint' }, WORD_HINT) : null);

/** With one word selected, only what can change for one word. */
function paintWordTools() {
  const { word, cell, type } = selection;
  tools.append(
    titleRow(
      `کلمهٔ «${word.text}»`,
      h('button', { class: 'btn small', onClick: () => select({ ...selection, word: undefined }) }, cell ? 'کل این خانه' : type === 'obj' ? 'کل این کادر' : 'کل این بند'),
      toolBtn('form', 'تبدیل به جای خالی', markBlank),
      toolBtn('pencil', 'ویرایش متن', editSelectionText),
    ),
    textStyleRow(wordLook()),
    h('div', { class: 'tool-row' }, lookButtons()),
  );
}

function tableAllButton() {
  return h(
    'button',
    {
      class: `btn small toggle${tableAll ? ' on' : ''}`,
      onClick: () => {
        tableAll = !tableAll;
        const { id, role } = selection;
        select(tableAll ? { type: 'section', id, role } : null);
      },
    },
    'همهٔ جدول',
  );
}

/** With a group chosen, what can change for all of it. */
function paintGroupTools() {
  const { items, last } = selection;
  const onCell = last?.kind === 'cell';
  const onFrame = last?.kind === 'frame';
  const hasCells = items.some((item) => item.kind === 'cell');
  const fillable = items.some((item) => item.kind !== 'block');
  tools.append(
    h(
      'div',
      { class: 'tool-row' },
      h('span', { class: 'hint grow' }, items.length ? `${toFaDigits(items.length)} مورد` : 'انتخاب چندتایی'),
      onFrame
        ? [
          h('button', { class: 'btn small', onClick: () => addFrames('column') }, 'کل ستون'),
          h('button', { class: 'btn small', onClick: () => addFrames('page') }, 'کل صفحه'),
          h('button', { class: 'btn small', onClick: () => addFrames('same') }, 'هم‌شکل‌ها'),
        ]
        : [
          h('button', { class: 'btn small', disabled: !onCell, onClick: () => addLine('row') }, 'کل سطر'),
          h('button', { class: 'btn small', disabled: !onCell, onClick: () => addLine('column') }, 'کل ستون'),
          h('button', { class: 'btn small', disabled: !onCell, onClick: addSimilar }, 'مشابه‌ها'),
        ],
      h('button', { class: 'btn small primary', onClick: () => select(null) }, 'پایان'),
    ),
  );
  if (!items.length) {
    tools.append(h('div', { class: 'tool-hint' }, 'روی هر خانه، بند یا کادر بزن تا به گروه اضافه شود. با لمس دوباره از گروه بیرون می‌رود.'));
    return;
  }
  const st = currentLook();
  tools.append(
    textStyleRow(st),
    h(
      'div',
      { class: 'tool-row' },
      alignButtons(st, (align) => changeStyle({ align })),
      SEP(),
      fillable && toolBtn('fill', 'رنگ زمینه', pickFill),
      hasCells && toolBtn('lines', 'خط‌های خانه', pickLines),
      lookButtons(),
      hasCells && toolBtn('pencil', 'نوشتن در همهٔ خانه‌ها', writeInGroup),
    ),
  );
  if (hasCells) {
    tools.append(
      h(
        'div',
        { class: 'tool-row' },
        h('button', { class: 'btn small', onClick: deleteInTable }, icon('trash'), 'حذف خانه‌ها'),
        h('button', { class: 'btn small', onClick: mergeGroup }, icon('merge'), 'یکی کردن'),
        h('button', { class: 'btn small', onClick: openTableTools }, icon('table'), 'ابزار جدول'),
      ),
    );
  }
  const frames = groupFrames();
  if (frames.length && frames.length === items.length) {
    const lines = frames.every((o) => o.exact && !o.flow && o.page === frames[0].page);
    tools.append(
      h(
        'div',
        { class: 'tool-row' },
        nudgeButtons(),
        SEP(),
        lines && toolBtn('paragraph', 'یکی کردن و نوشتن متن', () => openFlowEditor(frames)),
        toolBtn('trash', 'حذف همه', removeGroup),
      ),
    );
  }
}

function paintPainterBar() {
  tools.append(
    h(
      'div',
      { class: 'tool-row painter-row' },
      icon('eyedropper'),
      h('span', { class: 'grow' }, 'روی هر خانه، بند یا کادر بزن تا همین قالب را بگیرد'),
      h('button', { class: 'btn small primary', onClick: endPainter }, 'پایان'),
    ),
  );
}

/** With one cell of a table selected, what can change for that cell alone. */
function paintCellTools() {
  const { id, cell: { r } } = selection;
  const table = selectedTable();
  const cell = selectedCell();
  const st = cellLook(table, r, cell);
  const hasText = cell?.paras.some((p) => (p.runs || []).some((run) => run.text));
  tools.append(
    titleRow(
      'این خانه',
      multiButton(),
      tableAllButton(),
      toolBtn('swap', 'جابه‌جایی ستون و سطر', () => openTableSwap(id)),
      toolBtn('form', 'تبدیل به جای خالی', markBlank),
      toolBtn('pencil', 'ویرایش متن', editSelectionText),
    ),
    h(
      'div',
      { class: 'tool-row' },
      h('button', { class: 'btn small', onClick: deleteInTable }, icon('trash'), 'حذف'),
      h('button', { class: 'btn small', onClick: addRowBelow }, icon('rowPlus'), 'سطر'),
      h('button', { class: 'btn small', onClick: addColumnBeside }, icon('colPlus'), 'ستون'),
      cell && isMerged(cell) && h('button', { class: 'btn small', onClick: splitSelectedCell }, icon('merge'), 'جدا کردن'),
      h('button', { class: 'btn small', onClick: openTableTools }, icon('table'), 'ابزار جدول'),
    ),
  );
  if (hasText) {
    tools.append(
      textStyleRow(st),
      h('div', { class: 'tool-row' }, alignButtons(st, alignSection), SEP(), toolBtn('fill', 'رنگ زمینه', pickFill), toolBtn('lines', 'خط‌های خانه', pickLines), lookButtons()),
    );
  } else {
    tools.append(
      h('div', { class: 'tool-row' }, toolBtn('fill', 'رنگ زمینه', pickFill), toolBtn('lines', 'خط‌های خانه', pickLines), h('span', { class: 'hint' }, 'این خانه خالی است')),
    );
  }
  const hint = wordHint();
  if (hint) tools.append(hint);
}

/** The top row names what is selected and holds its less frequent actions. */
function titleRow(label, ...actions) {
  return h('div', { class: 'tool-row' }, h('span', { class: 'hint grow' }, label), ...actions);
}

const SPACINGS = [1, 1.15, 1.5, 2];

function nextSpacing(current) {
  const i = SPACINGS.findIndex((s) => s > current + 0.01);
  return SPACINGS[i < 0 ? 0 : i];
}

function alignButtons(st, onAlign, withJustify) {
  const labels = { right: 'راست', center: 'وسط', left: 'چپ', justify: 'تراز دو طرف' };
  return (withJustify ? ['right', 'center', 'left', 'justify'] : ['right', 'center', 'left']).map((value) => {
    const name = `align${value[0].toUpperCase()}${value.slice(1)}`;
    return toolBtn(name, labels[value], () => onAlign(value), { class: `icon-btn${st && st.align === value ? ' on' : ''}` });
  });
}

function freeSwitch() {
  return h(
    'button',
    {
      class: `free-row${freeMode ? ' on' : ''}`,
      role: 'switch',
      'aria-checked': freeMode ? 'true' : 'false',
      onClick: () => {
        freeMode = !freeMode;
        paintTools();
      },
    },
    h('span', { class: 'switch' }, h('span', { class: 'knob' })),
    h('b', null, 'حرکت آزاد'),
    h('span', { class: 'free-note' }, freeMode ? 'روشن: هر جای صفحه، فلش‌ها هم آزادند' : 'خاموش: به متن بالایی نمی‌خورد'),
  );
}

function openTableSwap(id) {
  const n = Number(id.slice(6));
  const table = L().body.filter((b) => b.kind === 'table')[n];
  if (!table) return;
  openTableSwapSheet(table, {
    before: remember,
    after: () => {
      syncBodyHtml();
      saveLetter();
      render();
    },
  });
}

function openLayouts() {
  const letter = L();
  const close = openSheet(
    'چیدمان آماده',
    h(
      'div',
      { class: 'layout-grid' },
      LAYOUTS.map((layout) => {
        const preview = layoutLetter(withLayout(letter, layout), { preview: false }).pages[0];
        return h(
          'button',
          {
            class: 'layout-card',
            onClick: () => {
              const { parts, top } = layout.make(letter);
              close();
              change(() => {
                letter.letterhead = { ...letter.letterhead, parts };
                letter.geom = { ...letter.geom, top };
              });
            },
          },
          h('span', { class: 'layout-thumb' }, preview),
          h('span', null, layout.title),
        );
      }),
    ),
  );
}

function paintObjectTools(o) {
  if (o.kind === 'text') {
    if (selection.word) {
      paintWordTools();
      return;
    }
    const st = { ...TEXT_STYLE, ...o.style };
    tools.append(
      titleRow(
        o.flow ? 'پاراگراف' : o.exact ? 'این سطر' : 'کادر متن',
        o.exact && !o.flow && h('button', { class: 'btn small', onClick: () => openFlowEditor(paragraphAround(L(), o)) }, icon('paragraph'), 'کل پاراگراف'),
        toolBtn('form', 'تبدیل به جای خالی', markBlank),
        toolBtn('pencil', 'ویرایش متن', editSelectionText),
        toolBtn('border', 'خط دور کادر', () => change(() => { o.border = !o.border; }), { class: `icon-btn${o.border ? ' on' : ''}` }),
        toolBtn('copy', 'یک کپی از این کادر', duplicateObject),
        toolBtn('trash', 'حذف', removeObject),
      ),
      textStyleRow(currentLook()),
      h('div', { class: 'tool-row' }, alignButtons(st, (align) => changeStyle({ align })), SEP(), nudgeButtons()),
      h('div', { class: 'tool-row' }, toolBtn('fill', 'رنگ زمینه', pickFill), lookButtons(), multiButton()),
    );
    const hint = wordHint();
    if (hint) tools.append(hint);
    const shownInPlace = o.exact && !stageInner.querySelector(`.obj[data-id="${o.id}"]`)?.classList.contains('obj-inked');
    const fontHint = shownInPlace ? hintForFont(st.font) : null;
    if (fontHint) tools.append(fontHint);
    return;
  }
  tools.append(
    titleRow(
      o.kind === 'signature' ? 'امضا' : o.kind === 'stamp' ? 'مهر' : 'عکس',
      toolBtn('minus', 'کوچک‌تر', () => resizeObject(0.92)),
      toolBtn('plus', 'بزرگ‌تر', () => resizeObject(1.08)),
      toolBtn('layers', 'پشت متن', () => change(() => { o.behind = !o.behind; }), { class: `icon-btn${o.behind ? ' on' : ''}` }),
      toolBtn('image', 'عوض کردن عکس با همین قاب', replacePicture),
      toolBtn('wand', 'حذف پس‌زمینهٔ سفید', cleanObjectBackground),
      toolBtn('copy', 'یک کپی از این عکس', duplicateObject),
      toolBtn('trash', 'حذف', removeObject),
    ),
    h(
      'div',
      { class: 'tool-row' },
      toolBtn('objRight', 'تراز راست', () => alignObject('right')),
      toolBtn('objCenter', 'وسط افقی', () => alignObject('center')),
      toolBtn('objLeft', 'تراز چپ', () => alignObject('left')),
      SEP(),
      toolBtn('objTop', 'تراز بالا', () => alignObject('top')),
      toolBtn('objMiddle', 'وسط عمودی', () => alignObject('middle')),
      toolBtn('objBottom', 'تراز پایین', () => alignObject('bottom')),
    ),
    h(
      'div',
      { class: 'tool-row' },
      nudgeButtons(),
      SEP(),
      toolBtn('rotateBack', 'چرخش به چپ', () => rotateObject(-5)),
      toolBtn('rotate', 'چرخش به راست', () => rotateObject(5)),
    ),
  );
}

function paintPartTools(part) {
  const label = PART_LABELS[part.id];
  const common = [toolBtn('reset', 'بازگشت به جای اول', resetSelection), toolBtn('eyeOff', 'پنهان کردن', hidePart)];
  if (part.id === 'logo') {
    tools.append(
      titleRow(label, toolBtn('minus', 'کوچک‌تر', () => resizeLogo(0.92)), toolBtn('plus', 'بزرگ‌تر', () => resizeLogo(1.08)), toolBtn('wand', 'حذف پس‌زمینهٔ سفید', cleanLogoBackground), ...common),
      h('div', { class: 'tool-row' }, alignButtons(null, alignPart), SEP(), nudgeButtons()),
    );
    return;
  }
  if (part.id === 'rule') {
    tools.append(
      titleRow(label, ...common),
      h('div', { class: 'tool-row' }, nudgeButtons()),
    );
    return;
  }
  const st = { ...styleOf(L(), part.role), ...(part.align && { align: part.align }) };
  const link = META_PARTS.includes(part.id)
    ? toolBtn('link', 'شماره، تاریخ و پیوست با هم جابه‌جا شوند', () => {
      metaLinked = !metaLinked;
      toast(metaLinked ? 'شماره، تاریخ و پیوست با هم جابه‌جا می‌شوند' : 'هر کدام جدا جابه‌جا می‌شود');
      paintTools();
    }, { class: `icon-btn${metaLinked ? ' on' : ''}` })
    : null;
  tools.append(
    titleRow(label, link, toolBtn('eyedropper', 'برداشتن قالب برای چیزهای دیگر', startPainter), toolBtn('styles', 'سبک‌ها', openLooks), toolBtn('pencil', 'ویرایش متن', editSelectionText), ...common),
    textStyleRow(st),
    h('div', { class: 'tool-row' }, alignButtons(st, alignPart), SEP(), nudgeButtons()),
  );
}

function bodyTitle(id) {
  const k = blockIndex(id);
  if (k < 0) return 'همهٔ متن نامه';
  const body = L().body;
  const paragraphs = body.filter((b) => b.kind === 'p' && (b.runs || []).length);
  const n = body.slice(0, k + 1).filter((b) => b.kind === 'p' && (b.runs || []).length).length;
  return `بند ${toFaDigits(Math.max(n, 1))} از ${toFaDigits(Math.max(paragraphs.length, 1))}`;
}

function paintSectionTools() {
  const { id, role } = selection;
  if (selection.word) {
    paintWordTools();
    return;
  }
  if (selection.cell) {
    paintCellTools();
    return;
  }
  const st = sectionStyle();
  const isTable = id.startsWith('table:');
  const isBody = id.startsWith('body');
  const wholeBody = isBody && h(
    'button',
    {
      class: `btn small toggle${bodyAll ? ' on' : ''}`,
      onClick: () => {
        bodyAll = !bodyAll;
        select(bodyAll ? { type: 'section', id: 'body', role: 'body' } : null);
      },
    },
    'همهٔ بندها',
  );
  tools.append(
    freeSwitch(),
    titleRow(
      isBody ? bodyTitle(id) : ROLE_LABELS[role] || '',
      wholeBody,
      isTable && tableAllButton(),
      isTable && toolBtn('swap', 'جابه‌جایی ستون و سطر', () => openTableSwap(id)),
      !isTable && toolBtn('lineHeight', 'فاصلهٔ خطوط', () => changeStyle({ spacing: nextSpacing(st.spacing) })),
      toolBtn('pencil', 'ویرایش متن', editSelectionText),
      toolBtn('reset', 'بازگشت به جای اول', resetSelection),
    ),
    textStyleRow(st),
    h('div', { class: 'tool-row' }, alignButtons(id === 'sign' ? null : st, alignSection, isBody), SEP(), nudgeButtons()),
    h(
      'div',
      { class: 'tool-row' },
      isTable && toolBtn('fill', 'رنگ زمینه', pickFill),
      isTable && toolBtn('lines', 'خط‌های خانه', pickLines),
      lookButtons(),
      isTable && toolBtn('table', 'ابزار جدول', openTableTools),
      isTable && toolBtn('trash', 'حذف جدول', () => removeTable(selectedTable())),
      blockIndex(id) >= 0 && multiButton(),
    ),
  );
  if (blockIndex(id) >= 0) {
    const hint = wordHint();
    if (hint) tools.append(hint);
  }
}

function paintIdleTools() {
  const hidden = hiddenParts().length;
  const letter = L();
  const blanks = countBlanks(letter);
  const formLike = letter.importInfo?.form || letter.importInfo?.scanned;
  if (!isPlaced(letter)) tools.append(freeSwitch());
  if (blanks > 0) tools.append(h('div', { class: 'tool-row' }, h('button', { class: 'btn small primary grow', onClick: openFill }, icon('form'), `پر کردن ${toFaDigits(String(blanks))} جای خالی`)));
  if (letter.importInfo?.scanned) tools.append(h('div', { class: 'tool-row' }, h('button', { class: 'btn small primary grow', onClick: () => startReading(letter) }, icon('search'), 'خواندن متن این اسکن')));
  if (letter.ocr?.pages?.length) {
    const unsure = letter.ocr.words?.length || 0;
    tools.append(h(
      'div',
      { class: 'tool-row' },
      unsure > 0 && h('button', { class: 'btn small primary', onClick: () => openReviewSheet(letter, { onDone: render }) }, icon('search'), `بازبینی ${toFaDigits(String(unsure))} کلمهٔ مشکوک`),
      h('button', { class: 'btn small', onClick: () => openScanSheet(letter) }, icon('image'), 'دیدن اسکن اصلی'),
    ));
  }
  if (formLike) {
    tools.append(h(
      'div',
      { class: 'tool-row' },
      h('button', { class: 'btn small', onClick: addBlankFrame }, icon('plus'), 'جای خالی تازه'),
      h('button', { class: 'btn small', onClick: saveAsForm }, icon('form'), 'ذخیره به‌عنوان فرم'),
      isPlaced(letter) && h('button', { class: 'btn small', onClick: openPagesSheet }, icon('pagesStack'), 'صفحه‌ها'),
    ));
  }
  tools.append(
    h(
      'div',
      { class: 'tool-row' },
      h('button', { class: 'btn small', onClick: addPicture }, icon('image'), 'عکس'),
      h('button', { class: 'btn small', onClick: () => addSigner('signature') }, icon('sign'), 'امضا'),
      h('button', { class: 'btn small', onClick: () => addSigner('stamp') }, icon('stamp'), 'مهر'),
      h('button', { class: 'btn small', onClick: addTextFrame }, icon('textFrame'), 'کادر متن'),
      toolBtn('search', 'جستجو و جایگزینی', openFind),
    ),
    h(
      'div',
      { class: 'tool-row' },
      h('button', { class: 'btn small', onClick: openLayouts }, icon('page'), 'چیدمان آماده'),
      h('button', { class: 'btn small', onClick: saveAsDefault }, 'پیش‌فرض نامه‌ها'),
      hidden > 0 && h('button', { class: 'btn small', onClick: openHiddenParts }, `پنهان‌ها (${toFaDigits(hidden)})`),
      toolBtn('reset', 'بازگشت به چیدمان اولیه', resetAllLayout),
    ),
  );
}

function paintTools() {
  tools.textContent = '';
  if (painter) {
    paintPainterBar();
    return;
  }
  if (selection?.type === 'group') {
    paintGroupTools();
    return;
  }
  if (selection?.type === 'obj' && objectById(selection.id)) {
    paintObjectTools(objectById(selection.id));
    return;
  }
  if (selection?.type === 'part') {
    const part = partById(selection.id);
    if (part && !part.hidden) {
      paintPartTools(part);
      return;
    }
  }
  if (selection?.type === 'section' && stageInner.querySelector(sectionSelector(selection.id))) {
    paintSectionTools();
    return;
  }
  selection = null;
  paintIdleTools();
}

export const pageScreen = {
  root,
  refresh: () => render(),
  async show(opts) {
    selection = null;
    painter = null;
    if (historyFor !== L().id) {
      history = [];
      future = [];
      historyFor = L().id;
      freeMode = false;
      bodyAll = false;
      tableAll = false;
    }
    undoBtn.disabled = !history.length;
    redoBtn.disabled = !future.length;
    await ensureMedia(mediaIdsOf(L()));
    stageInner.textContent = '';
    scale = fitScale();
    render();
    stage.scrollTo(0, 0);
    if (opts?.fill && countBlanks(L())) openFill();
  },
  onBack() {
    if (painter) {
      endPainter();
      return true;
    }
    if (selection) {
      select(null);
      return true;
    }
    return false;
  },
};
