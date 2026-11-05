// The body text editor. It is a plain contenteditable that we never rewrite while the user is
// composing a word: keyboards on Android break when the DOM changes under an active composition.

import { escapeHtml, uid } from './util.js';
import { mediaUrl } from './store.js';

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE']);

// Font, size and colour count only when an opened Word file set them as data attributes.
// Chromium writes its own inline styles while editing, and those would leak the app's theme into the letter.
function contextOf(el, ctx) {
  const next = { ...ctx };
  const weight = el.style?.fontWeight;
  if (el.tagName === 'B' || el.tagName === 'STRONG' || weight === 'bold' || Number(weight) >= 600) next.b = true;
  if (el.dataset?.b === '0') next.b = false;
  if (el.tagName === 'U' || /underline/.test(el.style?.textDecoration || '')) next.u = true;
  if (el.tagName === 'I' || el.tagName === 'EM') next.i = true;
  if (el.dataset?.font) next.font = el.dataset.font;
  if (el.dataset?.size) next.size = Number(el.dataset.size);
  if (el.dataset?.color) next.color = el.dataset.color;
  return next;
}

function inlineRuns(node, ctx, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent) out.push({ text: child.textContent, ...ctx });
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (child.tagName === 'BR') {
        out.push({ text: '\n', ...ctx });
      } else if (child.tagName === 'IMG') {
        if (child.dataset.media) out.push({ img: { id: child.dataset.media, w: Number(child.dataset.w), aspect: Number(child.dataset.aspect) || 1 } });
      } else {
        inlineRuns(child, contextOf(child, ctx), out);
      }
    }
  }
}

const sameLook = (a, b) => ['b', 'u', 'i', 'font', 'size', 'color'].every((k) => a[k] === b[k]);

function mergeRuns(runs) {
  const out = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && !last.img && !run.img && sameLook(last, run)) last.text += run.text;
    else out.push({ ...run });
  }
  const last = out[out.length - 1];
  if (last && !last.img && last.text.endsWith('\n')) {
    last.text = last.text.slice(0, -1);
    if (!last.text) out.pop();
  }
  return out;
}

function alignOf(el) {
  const a = el.style?.textAlign || el.getAttribute?.('align') || '';
  return ['right', 'left', 'center', 'justify'].includes(a) ? a : undefined;
}

function indentOf(el) {
  const { start, end, first } = el.dataset || {};
  if (!start && !end && !first) return undefined;
  return { start: Number(start) || 0, end: Number(end) || 0, first: Number(first) || 0 };
}

function overOf(el) {
  const over = {};
  for (const key of ['before', 'after', 'spacing', 'line']) if (el.dataset?.[key] !== undefined) over[key] = Number(el.dataset[key]);
  if (el.dataset?.pfont) over.font = el.dataset.pfont;
  if (el.dataset?.psize) over.size = Number(el.dataset.psize);
  if (el.dataset?.pbold) over.bold = el.dataset.pbold === '1';
  return Object.keys(over).length ? over : undefined;
}

/** Where the user put this paragraph on the page. It travels with the paragraph when the text around it changes. */
function moveOf(el) {
  const { dx, dy, fy } = el.dataset || {};
  if (dx === undefined && dy === undefined && fy === undefined) return undefined;
  return { dx: Number(dx) || 0, dy: Number(dy) || 0, fy: Number(fy) || 0 };
}

function paragraphOf(el) {
  const raw = [];
  inlineRuns(el, {}, raw);
  const align = alignOf(el);
  const indent = indentOf(el);
  const over = overOf(el);
  const move = moveOf(el);
  return {
    kind: 'p',
    ...(align && { align }),
    ...(indent && { indent }),
    ...(over && { over }),
    ...(move && { move }),
    ...(el.dataset?.pagebreak && { pageBreak: true }),
    ...(el.dataset?.orig && { orig: el.dataset.orig }),
    runs: mergeRuns(raw),
  };
}

function tableOf(table) {
  const rows = [...table.rows].map((tr) =>
    [...tr.cells].map((td) => {
      const blocks = [...td.children].filter((c) => BLOCK_TAGS.has(c.tagName));
      const paras = blocks.length ? blocks.map(paragraphOf) : [paragraphOf(td)];
      return {
        ...(td.colSpan > 1 && { colSpan: td.colSpan }),
        ...(td.rowSpan > 1 && { rowSpan: td.rowSpan }),
        ...(td.dataset.bg && { bg: td.dataset.bg }),
        ...(td.dataset.valign && { vAlign: td.dataset.valign }),
        ...(td.dataset.rowh && { rowH: Number(td.dataset.rowh) }),
        ...(td.dataset.borders && { borders: td.dataset.borders.split(',').map(Number) }),
        ...(td.dataset.orig && { orig: td.dataset.orig }),
        paras: paras.map(({ align, over, indent, runs }) => ({ ...(align && { align }), ...(over && { over }), ...(indent && { indent }), runs })),
      };
    }),
  );
  const widths = table.dataset.widths ? table.dataset.widths.split(',').map(Number) : null;
  // Rows or columns added in the editor change the column count, so the saved widths no longer apply.
  const cols = Math.max(...rows.map((row) => row.reduce((n, c) => n + (c.colSpan || 1), 0)));
  return {
    kind: 'table',
    header: table.dataset.header !== '0',
    ...(table.dataset.borderless && { borderless: true }),
    ...(table.dataset.widthpct && { widthPct: Number(table.dataset.widthpct) }),
    ...(table.dataset.tablealign && { tableAlign: table.dataset.tablealign }),
    ...(table.dataset.pad !== undefined && { pad: Number(table.dataset.pad) }),
    ...(widths && widths.length === cols && { widths }),
    rows,
  };
}

/** Reads the editor into body blocks. It only reads, so it is safe to call during composition. */
export function serializeEditor(root) {
  const blocks = [];
  const placed = new Set();
  let loose = null;
  const flushLoose = () => {
    if (loose) blocks.push(paragraphOf(loose));
    loose = null;
  };
  for (const node of root.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'TABLE') {
      flushLoose();
      blocks.push(tableOf(node));
    } else if (node.nodeType === Node.ELEMENT_NODE && (BLOCK_TAGS.has(node.tagName) || node.tagName === 'UL' || node.tagName === 'OL')) {
      flushLoose();
      if (node.tagName === 'UL' || node.tagName === 'OL') [...node.children].forEach((li) => blocks.push(paragraphOf(li)));
      else {
        const block = paragraphOf(node);
        // Pressing Enter copies the paragraph's attributes; only the first of the two keeps its place on the page.
        const { pid } = node.dataset;
        if (pid && placed.has(pid)) {
          delete block.move;
          delete block.pageBreak;
        }
        if (pid) placed.add(pid);
        blocks.push(block);
      }
    } else if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
      if (!loose) loose = document.createElement('div');
      loose.append(node.cloneNode(true));
    }
  }
  flushLoose();
  while (blocks.length && blocks[blocks.length - 1].kind === 'p' && !blocks[blocks.length - 1].runs.length) blocks.pop();
  return blocks;
}

/** Removes the copied place from a paragraph just split by Enter. Call only when not composing. */
export function cleanupCopies(root) {
  const seen = new Set();
  for (const el of root.children) {
    const { pid } = el.dataset;
    if (!pid) continue;
    if (seen.has(pid)) for (const key of ['pid', 'dx', 'dy', 'fy', 'pagebreak']) delete el.dataset[key];
    else seen.add(pid);
  }
}

/** Text with [blanks] and newlines into editor HTML. Lines starting with | are the rows of a table. */
export function textToEditorHtml(text) {
  if (!text) return '';
  const out = [];
  let rows = null;
  const flushTable = () => {
    if (!rows) return;
    const cells = rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell) || '<br>'}</td>`).join('')}</tr>`);
    out.push(`<table><tbody>${cells.join('')}</tbody></table>`);
    rows = null;
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('|')) {
      rows = rows || [];
      rows.push(line.slice(1).split('|'));
    } else {
      flushTable();
      out.push(`<p>${inlineHtml(line) || '<br>'}</p>`);
    }
  }
  if (rows) {
    flushTable();
    out.push('<p><br></p>');
  }
  return out.join('');
}

export function inlineHtml(text) {
  return escapeHtml(text).replace(/\[[^\]\n]+\]/g, (m) => `<span class="ph">${m}</span>`);
}

function runToHtml(run) {
  if (run.img) {
    const { id, w, aspect } = run.img;
    return `<img data-media="${escapeHtml(id)}" data-w="${w}" data-aspect="${aspect}" style="width:${w}mm;height:${w / (aspect || 1)}mm" alt="">`;
  }
  let html = inlineHtml(run.text || '').replace(/\n/g, '<br>');
  if (!html) return '';
  if (run.b === true) html = `<b>${html}</b>`;
  if (run.u) html = `<u>${html}</u>`;
  if (run.i) html = `<i>${html}</i>`;
  const data = [];
  const style = [];
  if (run.b === false) {
    data.push('data-b="0"');
    style.push('font-weight:400');
  }
  if (run.font) {
    data.push(`data-font="${escapeHtml(run.font)}"`);
    style.push(`font-family:'${escapeHtml(run.font)}','B Nazanin','Tinos','Vazirmatn',serif`);
  }
  if (run.size) {
    data.push(`data-size="${run.size}"`);
    style.push(`font-size:${run.size}pt`);
  }
  if (run.color) {
    data.push(`data-color="${escapeHtml(run.color)}"`);
    style.push(`color:#${escapeHtml(run.color)}`);
  }
  return data.length ? `<span ${data.join(' ')} style="${style.join(';')}">${html}</span>` : html;
}

function paragraphHtml(p) {
  const data = [];
  const style = [];
  if (p.align) style.push(`text-align:${p.align}`);
  const { start, end, first } = p.indent || {};
  if (start) {
    data.push(`data-start="${start}"`);
    style.push(`margin-right:${start}mm`);
  }
  if (end) {
    data.push(`data-end="${end}"`);
    style.push(`margin-left:${end}mm`);
  }
  if (first) {
    data.push(`data-first="${first}"`);
    style.push(`text-indent:${first}mm`);
  }
  const { font, size, bold, ...spacing } = p.over || {};
  for (const [key, value] of Object.entries(spacing)) data.push(`data-${key}="${value}"`);
  if (font) {
    data.push(`data-pfont="${escapeHtml(font)}"`);
    style.push(`font-family:'${escapeHtml(font)}','B Nazanin','Tinos','Vazirmatn',serif`);
  }
  if (size) {
    data.push(`data-psize="${size}"`);
    style.push(`font-size:${size}pt`);
  }
  if (bold !== undefined) {
    data.push(`data-pbold="${bold ? 1 : 0}"`);
    style.push(`font-weight:${bold ? 700 : 400}`);
  }
  if (p.move || p.pageBreak) data.push(`data-pid="${uid()}"`);
  if (p.move) data.push(`data-dx="${p.move.dx || 0}"`, `data-dy="${p.move.dy || 0}"`, `data-fy="${p.move.fy || 0}"`);
  if (p.pageBreak) data.push('data-pagebreak="1"');
  if (p.orig) data.push(`data-orig="${escapeHtml(p.orig)}"`);
  const attrs =`${data.length ? ` ${data.join(' ')}` : ''}${style.length ? ` style="${style.join(';')}"` : ''}`;
  return `<p${attrs}>${(p.runs || []).map(runToHtml).join('') || '<br>'}</p>`;
}

function tableBlockHtml(t) {
  const attrs = [`data-header="${t.header === false ? 0 : 1}"`];
  if (t.borderless) attrs.push('data-borderless="1"', 'class="no-border"');
  if (t.widths) attrs.push(`data-widths="${t.widths.join(',')}"`);
  if (t.widthPct) attrs.push(`data-widthpct="${t.widthPct}"`);
  if (t.tableAlign) attrs.push(`data-tablealign="${t.tableAlign}"`);
  if (t.pad !== undefined) attrs.push(`data-pad="${t.pad}"`);
  // A table kept to the millimetre is far too fine to type in at phone width; in the form its columns follow their words.
  const cols = t.widths && t.pad === undefined ? `<colgroup>${t.widths.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>` : '';
  const rows = t.rows
    .map((row) => {
      const cells = row.map((cell) => {
        const span = `${cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ''}${cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''}`;
        const bg = cell.bg ? ` data-bg="${escapeHtml(cell.bg)}" style="background:#${escapeHtml(cell.bg)}"` : '';
        const place = `${cell.vAlign ? ` data-valign="${cell.vAlign}"` : ''}${cell.rowH ? ` data-rowh="${cell.rowH}"` : ''}${cell.borders ? ` data-borders="${cell.borders.join(',')}"` : ''}${cell.orig ? ` data-orig="${escapeHtml(cell.orig)}"` : ''}`;
        return `<td${span}${bg}${place}>${cell.paras.map(paragraphHtml).join('')}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');
  return `<table ${attrs.join(' ')}>${cols}<tbody>${rows}</tbody></table>`;
}

/** Body blocks into editor HTML, the reverse of serializeEditor. */
export function blocksToHtml(blocks) {
  return blocks.map((b) => (b.kind === 'table' ? tableBlockHtml(b) : paragraphHtml(b))).join('');
}

/** The editor's content for saving. Pictures are saved by id, not with their bytes. */
export function editorHtml(root) {
  if (!root.querySelector('img')) return root.innerHTML;
  const copy = root.cloneNode(true);
  copy.querySelectorAll('img').forEach((img) => img.removeAttribute('src'));
  return copy.innerHTML;
}

export function setEditorHtml(root, html) {
  root.innerHTML = html;
  root.querySelectorAll('img[data-media]').forEach((img) => {
    img.src = mediaUrl(img.dataset.media);
  });
}

export const isBlank = (el) => /^\[[^\]\n]+\]$/.test(el.textContent);

/** Tidies leftovers once the user has typed over a blank. Call only when not composing. */
export function cleanupBlanks(root) {
  root.querySelectorAll('.ph').forEach((el) => {
    if (!isBlank(el)) el.classList.remove('ph');
  });
  // Chromium can copy the blank's highlight onto new text as an inline style.
  root.querySelectorAll('span[style*="background"], font[style*="background"]').forEach((el) => {
    el.style.removeProperty('background-color');
    if (!el.getAttribute('style')) el.removeAttribute('style');
  });
}

export function blanksIn(root) {
  return [...root.querySelectorAll('.ph')].filter(isBlank);
}

/** Turns [text in brackets] typed by hand into real blanks, for saving a letter as a template. */
export function markBlanks(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest('.ph') || !/\[[^\]\n]+\]/.test(node.textContent)) continue;
    const holder = document.createElement('span');
    holder.innerHTML = inlineHtml(node.textContent);
    node.replaceWith(...holder.childNodes);
  }
}

export function selectElement(el) {
  const sel = getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** Selects the next blank after the caret, wrapping to the first. Returns false if none are left. */
export function selectNextBlank(root) {
  const blanks = blanksIn(root);
  if (!blanks.length) return false;
  const sel = getSelection();
  let target = blanks[0];
  if (sel.rangeCount && root.contains(sel.anchorNode)) {
    const caret = sel.getRangeAt(0);
    const after = blanks.find((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.compareBoundaryPoints(Range.START_TO_START, caret) > 0;
    });
    if (after) target = after;
  }
  selectElement(target);
  return true;
}

export function tableHtml(rows, cols) {
  const cell = '<td><br></td>';
  const row = `<tr>${cell.repeat(cols)}</tr>`;
  return `<table><tbody>${row.repeat(rows)}</tbody></table><p><br></p>`;
}

/** A table already holding its words, row by row. */
export function tableHtmlOf(rows) {
  const cells = rows.map((row) => `<tr>${row.map((word) => `<td>${inlineHtml(word) || '<br>'}</td>`).join('')}</tr>`);
  return `<table><tbody>${cells.join('')}</tbody></table><p><br></p>`;
}
