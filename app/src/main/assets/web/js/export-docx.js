// Builds a real, editable .docx from the letter. Free of DOM use so tools/ can run it in Node.

import { PAGE, SIGN, TEXT_STYLE, MM_PER_PT, blockStyle, buildFlow, frameLines, geomOf, headerParts, lineHeightMm, partLines, partStyle, runsWithGaps, showsPageNumbers, spaceBefore, styleOf, usePageSize } from './model.js';
import { normalizeText } from './text.js';
import { zipStore } from './zip.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tw = (mm) => Math.round(mm * 56.6929);
const emu = (mm) => Math.round(mm * 36000);
const pt20 = (pt) => Math.round(pt * 20);
const ptOf = (mm) => (mm / MM_PER_PT).toFixed(2);

const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
].join(' ');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const LATIN_FONT = 'Times New Roman';
const SANS_FONT = 'Vazirmatn';

// In a right-to-left Word paragraph "left" means the start of the line, that is the right side of the page.
const JC = { right: 'left', left: 'right', center: 'center', justify: 'both' };

function rPr(st, { bold = st.bold, underline = !!st.underline, italic = false, font, size, color = st.color, kind = 'rtl' } = {}) {
  const family = font || st.font;
  const sz = Math.round((size || st.size) * 2);
  // A left-to-right number would otherwise take its Persian digits from the Latin font.
  // Vazirmatn has Latin letters of its own; the B fonts do not.
  const latinFont = kind === 'number' || family === SANS_FONT ? esc(family) : LATIN_FONT;
  return (
    '<w:rPr>' +
    `<w:rFonts w:ascii="${latinFont}" w:hAnsi="${latinFont}" w:eastAsia="${latinFont}" w:cs="${esc(family)}"/>` +
    (bold ? '<w:b/><w:bCs/>' : '') +
    (italic ? '<w:i/><w:iCs/>' : '') +
    (color ? `<w:color w:val="${esc(color)}"/>` : '') +
    `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` +
    (underline ? '<w:u w:val="single"/>' : '') +
    (kind === 'rtl' ? '<w:rtl/>' : '') +
    '</w:rPr>'
  );
}

function pPr(st, { align, keepNext = false, pageBreak = false, before, after, start = 0, end = 0, first = 0, border = '' } = {}) {
  const lineXml = st.line ? `w:line="${pt20(st.line)}" w:lineRule="exact"` : `w:line="${Math.round(240 * st.spacing)}" w:lineRule="auto"`;
  const firstAttr = first > 0 ? ` w:firstLine="${tw(first)}"` : first < 0 ? ` w:hanging="${tw(-first)}"` : '';
  return (
    '<w:pPr>' +
    (keepNext ? '<w:keepNext/>' : '') +
    (pageBreak ? '<w:pageBreakBefore/>' : '') +
    border +
    '<w:bidi/>' +
    `<w:spacing w:before="${pt20(before ?? st.before)}" w:after="${pt20(after ?? st.after)}" ${lineXml}/>` +
    (start || end || first ? `<w:ind w:left="${tw(start)}" w:right="${tw(end)}"${firstAttr}/>` : '') +
    `<w:jc w:val="${JC[align || st.align] || 'left'}"/>` +
    '</w:pPr>'
  );
}

// These go in their own left-to-right runs, or Word flips them inside a right-to-left line:
// Latin words, and numbers with separators such as the date ۱۴۰۵/۰۸/۱۲ or the phone ۰۸۴-۱۲۳۴.
const LTR_SEGMENT = /[A-Za-z][A-Za-z0-9 ._\-@/:+&]*[A-Za-z0-9][۰-۹]*|[A-Za-z][۰-۹]*|[0-9۰-۹]+(?:[/\-.:][0-9۰-۹]+)+/g;

function segments(text) {
  const out = [];
  let i = 0;
  for (const m of text.matchAll(LTR_SEGMENT)) {
    if (m.index > i) out.push({ text: text.slice(i, m.index), kind: 'rtl' });
    out.push({ text: m[0], kind: /[A-Za-z]/.test(m[0]) ? 'latin' : 'number' });
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push({ text: text.slice(i), kind: 'rtl' });
  return out;
}

function textXml(piece) {
  return piece
    .split('\t')
    .map((part, i) => `${i > 0 ? '<w:tab/>' : ''}${part ? `<w:t xml:space="preserve">${esc(part)}</w:t>` : ''}`)
    .join('');
}

function textRuns(text, st, fmt = {}) {
  return segments(text)
    .map((seg) => {
      const props = rPr(st, { ...fmt, kind: seg.kind });
      const pieces = seg.text.split('\n');
      return pieces.map((piece, i) => `<w:r>${props}${i > 0 ? '<w:br/>' : ''}${textXml(piece)}</w:r>`).join('');
    })
    .join('');
}

function runsXml(runs, st, ctx, base = {}) {
  return (runs || [])
    .map((r) => {
      if (r.img) {
        const rid = ctx.images.rel(ctx.rels, r.img.id);
        return rid ? ctx.images.inline(rid, r.img.w, r.img.w / (r.img.aspect || 1)) : '';
      }
      if (!r.text) return '';
      return textRuns(r.text, st, { ...base, bold: r.b === undefined ? (base.bold ?? st.bold) : r.b, underline: r.u, italic: !!r.i, font: r.font, size: r.size, color: r.color });
    })
    .join('');
}

class Images {
  constructor(lookup, files) {
    this.lookup = lookup;
    this.files = files;
    this.byId = new Map();
    this.nextDrawing = 1;
  }

  /** Registers an image in a part's relationship list and returns its rId. */
  rel(rels, mediaId) {
    const item = this.lookup(mediaId);
    if (!item) return null;
    let name = this.byId.get(mediaId);
    if (!name) {
      name = `image${this.byId.size + 1}.${item.ext}`;
      this.byId.set(mediaId, name);
      this.files.push({ name: `word/media/${name}`, data: item.bytes });
    }
    const existing = rels.find((r) => r.target === `media/${name}`);
    if (existing) return existing.id;
    const id = `rIdImg${rels.length + 1}`;
    rels.push({ id, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: `media/${name}` });
    return id;
  }

  picture(rid, cx, cy, id, rotate = 0) {
    // Word counts rotation in 60000ths of a degree, and only forwards.
    const rot = rotate ? ` rot="${Math.round((((rotate % 360) + 360) % 360) * 60000)}"` : '';
    return (
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm${rot}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic>'
    );
  }

  inline(rid, wMm, hMm) {
    const id = this.nextDrawing++;
    const cx = emu(wMm);
    const cy = emu(hMm);
    return (
      '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>${this.picture(rid, cx, cy, id)}` +
      '</wp:inline></w:drawing></w:r>'
    );
  }

  floating(id, { xMm, yMm, wMm, hMm, fromV = 'page', name = 'Picture', behind = false }, inner) {
    return (
      `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251658240 + id}" behindDoc="${behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1">` +
      '<wp:simplePos x="0" y="0"/>' +
      `<wp:positionH relativeFrom="page"><wp:posOffset>${emu(xMm)}</wp:posOffset></wp:positionH>` +
      `<wp:positionV relativeFrom="${fromV}"><wp:posOffset>${emu(yMm)}</wp:posOffset></wp:positionV>` +
      `<wp:extent cx="${emu(wMm)}" cy="${emu(hMm)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>` +
      `<wp:docPr id="${id}" name="${name} ${id}"/>` +
      inner +
      '</wp:anchor>'
    );
  }

  /** A floating picture: free to move in Word, positioned from the page or from its paragraph. */
  anchor(rid, box) {
    const id = this.nextDrawing++;
    const inner = `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>${this.picture(rid, emu(box.wMm), emu(box.hMm), id, box.rotate)}`;
    return `<w:r><w:drawing>${this.floating(id, box, inner)}</w:drawing></w:r>`;
  }

  shape(id, box, spPr, content) {
    return this.floating(
      id,
      { ...box, name: 'Shape' },
      `<wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp>${spPr}${content}</wps:wsp></a:graphicData></a:graphic>`,
    );
  }

  /** A text frame fixed on the page. In Word it stays a text box that can be clicked and dragged. */
  textBox(paragraphs, { xMm, yMm, wMm, hMm, border = false, fill = null, fromV = 'page', rightRoom = 0 }) {
    const id = this.nextDrawing++;
    const cx = emu(wMm + rightRoom);
    const cy = emu(hMm);
    const line = border ? '<a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>' : '<a:ln><a:noFill/></a:ln>';
    const inset = border ? emu(1.5) : 0;
    const paint = fill ? `<a:solidFill><a:srgbClr val="${esc(fill)}"/></a:solidFill>` : '<a:noFill/>';
    const spPr = `<wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${paint}${line}</wps:spPr>`;
    const content =
      `<wps:txbx><w:txbxContent>${paragraphs}</w:txbxContent></wps:txbx>` +
      `<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="${inset}" tIns="${inset}" rIns="${inset + emu(rightRoom)}" bIns="${inset}" anchor="t" anchorCtr="0"><a:spAutoFit/></wps:bodyPr>`;
    const insetPt = border ? ptOf(1.5) : 0;
    const fallback =
      `<w:pict><v:rect style="position:absolute;margin-left:${ptOf(xMm)}pt;margin-top:${ptOf(yMm)}pt;width:${ptOf(wMm + rightRoom)}pt;height:${ptOf(hMm)}pt;z-index:${id};mso-position-horizontal-relative:page;mso-position-vertical-relative:${fromV === 'paragraph' ? 'text' : fromV}" ${fill ? `filled="t" fillcolor="#${esc(fill)}"` : 'filled="f"'} stroked="${border ? 't' : 'f'}">` +
      `<v:textbox inset="${insetPt}pt,${insetPt}pt,${Number(insetPt) + Number(ptOf(rightRoom))}pt,${insetPt}pt"><w:txbxContent>${paragraphs}</w:txbxContent></v:textbox></v:rect></w:pict>`;
    return (
      '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>' +
      this.shape(id, { xMm, yMm, wMm: wMm + rightRoom, hMm, fromV }, spPr, content) +
      `</w:drawing></mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent></w:r>`
    );
  }

  /** A box that holds one exact line. It has no outline, does not resize itself, and Word draws it the same every time. */
  exactBox(paragraph, { xMm, yMm, wMm, hMm, fill = null, grows = false }) {
    const id = this.nextDrawing++;
    const cx = emu(wMm);
    const cy = emu(hMm);
    const paint = fill ? `<a:solidFill><a:srgbClr val="${esc(fill)}"/></a:solidFill>` : '<a:noFill/>';
    const spPr = `<wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${paint}<a:ln><a:noFill/></a:ln></wps:spPr>`;
    const content = `<wps:txbx><w:txbxContent>${paragraph}</w:txbxContent></wps:txbx><wps:bodyPr rot="0" vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0">${grows ? '<a:spAutoFit/>' : '<a:noAutofit/>'}</wps:bodyPr>`;
    return `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>${this.shape(id, { xMm, yMm, wMm, hMm }, spPr, content)}</w:drawing></mc:Choice></mc:AlternateContent></w:r>`;
  }

  /** A straight line across the page, such as the rule under the letterhead. */
  line({ xMm, yMm, wMm }) {
    const id = this.nextDrawing++;
    const spPr = `<wps:cNvCnPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(wMm)}" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></wps:spPr>`;
    const fallback = `<w:pict><v:line from="${ptOf(xMm)}pt,${ptOf(yMm)}pt" to="${ptOf(xMm + wMm)}pt,${ptOf(yMm)}pt" style="position:absolute;z-index:${id};mso-position-horizontal-relative:page;mso-position-vertical-relative:page" strokeweight=".75pt"/></w:pict>`;
    return (
      '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>' +
      this.shape(id, { xMm, yMm, wMm, hMm: 0 }, spPr, '<wps:bodyPr/>') +
      `</w:drawing></mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent></w:r>`
    );
  }
}

/** A cell's own borders, [top, right, bottom, left] in points on the page; negative is a double line, 0 is none. */
function cellBordersXml(borders) {
  if (!borders) return '';
  const side = (name, w) => {
    if (!w) return `<w:${name} w:val="nil"/>`;
    const sz = Math.max(2, Math.round(w < 0 ? (-w * 8) / 3 : w * 8));
    return `<w:${name} w:val="${w < 0 ? 'double' : 'single'}" w:sz="${sz}" w:space="0" w:color="000000"/>`;
  };
  const [top, right, bottom, left] = borders;
  // In a right-to-left table Word reads "left" as the side the table starts from, the right side of the page.
  return `<w:tcBorders>${side('top', top)}${side('left', right)}${side('bottom', bottom)}${side('right', left)}</w:tcBorders>`;
}

/** How much Word makes a row taller than asked: the line above it, and half of a table's outer lines (the page shows the other half). */
function rowLinesMm(rows, r) {
  const widest = (row, side) => Math.max(0, ...(row || []).map((c) => Math.abs(c.borders?.[side] || 0)));
  const above = r === 0 ? widest(rows[0], 0) / 2 : Math.max(widest(rows[r], 0), widest(rows[r - 1], 2));
  const below = r === rows.length - 1 ? widest(rows[r], 2) / 2 : 0;
  return (above + below) * MM_PER_PT;
}

function tableXml(block, L, ctx, geom) {
  const st = styleOf(L, 'table');
  const cols = block.widths?.length || Math.max(...block.rows.map((r) => r.reduce((n, c) => n + (c.colSpan || 1), 0)));
  const bodyW = Math.round(tw(geom.bodyW) * ((block.widthPct || 100) / 100));
  const grid = block.widths ? block.widths.map((w) => Math.round((bodyW * w) / 100)) : Array(cols).fill(Math.floor(bodyW / cols));
  const totalW = grid.reduce((a, b) => a + b, 0);
  const spanW = (col, span) => grid.slice(col, col + span).reduce((a, b) => a + b, 0);
  const border = (side) => (block.borderless ? `<w:${side} w:val="nil"/>` : `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`);
  const pad = block.pad ?? 1.5;
  // In a table laid out to the millimetre, an empty line must not make a row taller than it was.
  const emptyLine = block.pad === undefined ? st : { ...st, line: 1 };
  // Word lets a cell with no line on a side wipe out the table's line there, even the one its neighbour should draw.
  // So once any cell has lines of its own, all of them say theirs, as the page already draws them.
  const someOwn = !block.borderless && block.rows.some((row) => row.some((c) => c.borders));
  const linesOf = (cell) => cell.borders || (someOwn ? [0.5, 0.5, 0.5, 0.5] : undefined);

  // Cells merged downwards leave no cell in the next rows of the model, but Word wants a placeholder there.
  const below = [];
  const rows = block.rows
    .map((row, r) => {
      const isHeader = block.header && r === 0;
      let rowH = row.find((c) => c.rowH)?.rowH;
      // Word adds each line between rows to the rows' height. Where rows are kept to the millimetre, that is taken back.
      if (rowH && block.pad !== undefined) rowH = Math.max(0.5, rowH - rowLinesMm(block.rows, r));
      let col = 0;
      let next = 0;
      let cells = '';
      while (col < cols) {
        const cover = below[col];
        if (cover?.rows > 0) {
          cover.rows--;
          const edges = cover.borders && [0, cover.borders[1], cover.rows ? 0 : cover.borders[2], cover.borders[3]];
          cells += `<w:tc><w:tcPr><w:tcW w:w="${spanW(col, cover.span)}" w:type="dxa"/>${cover.span > 1 ? `<w:gridSpan w:val="${cover.span}"/>` : ''}<w:vMerge/>${cellBordersXml(edges)}</w:tcPr><w:p>${pPr(emptyLine, { before: 0, after: 0 })}</w:p></w:tc>`;
          col += cover.span;
          continue;
        }
        const cell = row[next++] || { paras: [{ runs: [] }] };
        const span = Math.min(cell.colSpan || 1, cols - col);
        const lines = linesOf(cell);
        if (cell.rowSpan > 1) below[col] = { rows: cell.rowSpan - 1, span, borders: lines };
        const cellStyle = { ...st, bold: st.bold || isHeader };
        const edges = lines && (cell.rowSpan > 1 ? [lines[0], lines[1], 0, lines[3]] : lines);
        const paras = cell.paras.map((p) => `<w:p>${pPr({ ...st, ...p.over }, { align: p.align, before: p.over?.before ?? 0, after: p.over?.after ?? 0, start: p.indent?.start || 0, end: p.indent?.end || 0 })}${runsXml(p.runs, cellStyle, ctx)}</w:p>`).join('');
        cells +=
          `<w:tc><w:tcPr><w:tcW w:w="${spanW(col, span)}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}` +
          `${cell.rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : ''}${cellBordersXml(edges)}${cell.bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${esc(cell.bg)}"/>` : ''}<w:vAlign w:val="${cell.vAlign || 'center'}"/></w:tcPr>${paras}</w:tc>`;
        col += span;
      }
      return `<w:tr><w:trPr><w:cantSplit/>${rowH ? `<w:trHeight w:val="${tw(rowH)}" w:hRule="atLeast"/>` : ''}${isHeader ? '<w:tblHeader/>' : ''}</w:trPr>${cells}</w:tr>`;
    })
    .join('');
  // A bidi table measures its indent from the right edge. Word will not let an indent push it past the
  // left margin, so a table dragged out there floats instead, with wide clearances so text stays below it.
  const dx = block.dx || 0;
  const leftEdge = geom.left + geom.bodyW - totalW / 56.6929 + dx;
  const crossesMargin = dx < 0 && leftEdge < geom.left - 0.05;
  const floating = crossesMargin
    ? `<w:tblpPr w:leftFromText="2800" w:rightFromText="2800" w:vertAnchor="text" w:horzAnchor="page" w:tblpX="${Math.max(1, tw(leftEdge))}" w:tblpY="1"/><w:tblOverlap w:val="never"/>`
    : '';
  return (
    `<w:tbl><w:tblPr>${floating}<w:bidiVisual/>` +
    `<w:tblW w:w="${totalW}" w:type="dxa"/>` +
    (block.tableAlign && block.tableAlign !== 'right' ? `<w:jc w:val="${JC[block.tableAlign]}"/>` : '') +
    (dx && !crossesMargin ? `<w:tblInd w:w="${tw(-dx)}" w:type="dxa"/>` : '') +
    `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>` +
    '<w:tblLayout w:type="fixed"/>' +
    `<w:tblCellMar><w:left w:w="${tw(pad)}" w:type="dxa"/><w:right w:w="${tw(pad)}" w:type="dxa"/></w:tblCellMar>` +
    `</w:tblPr><w:tblGrid>${grid.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`
  );
}

/** A hair-thin paragraph, for where Word requires one but nothing should show. */
function spacerPara(content = '', heightPt = 2) {
  return `<w:p><w:pPr><w:bidi/><w:spacing w:before="0" w:after="0" w:line="${pt20(heightPt)}" w:lineRule="exact"/></w:pPr>${content}</w:p>`;
}

/** Only for tools that have no page layout to ask; in the app the height comes from the real layout. */
function estimatedHeight(L, block, geom) {
  if (block.kind === 'table') return block.rows.length * (lineHeightMm(styleOf(L, 'table')) + 0.5);
  if (block.kind === 'sign') return SIGN.gap + lineHeightMm(styleOf(L, 'signName')) + lineHeightMm(styleOf(L, 'signTitle'));
  const st = blockStyle(L, block);
  const length = block.runs.reduce((n, r) => n + (r.text?.length || 0), 0);
  const lines = Math.max(1, Math.ceil((length * st.size * 0.16) / geom.bodyW));
  return lines * lineHeightMm(st) + (spaceBefore(L, block) + st.after) * MM_PER_PT;
}

function textObjectXml(L, o, ctx) {
  const st = { ...TEXT_STYLE, ...o.style };
  const lines = frameLines(o);
  // A form's words stay exactly as they are in its file.
  const fix = (text) => (L.autoFix === false ? text : normalizeText(text));
  const paragraphs = lines.map((runs) => `<w:p>${pPr(st)}${runsXml(runs.map((run) => (run.text ? { ...run, text: fix(run.text) } : run)), st, ctx)}</w:p>`).join('');
  const hMm = o.h || lines.length * lineHeightMm(st) + (o.border ? 3 : 0);
  return ctx.images.textBox(paragraphs, { xMm: o.x, yMm: o.y, wMm: o.w, hMm, border: o.border, fill: o.fill });
}

/* ---------- Lines taken exactly from a file ---------- */

// A line's own look lives in a paragraph style of its own kind, which keeps a page of a thousand short pieces small.
class FrameStyles {
  constructor() {
    this.byKey = new Map();
    this.xml = '';
  }

  idFor(st) {
    const key = JSON.stringify([st.font, st.size, !!st.bold, st.color || '', st.line, st.dir || '']);
    let id = this.byKey.get(key);
    if (id) return id;
    id = `Nh${this.byKey.size + 1}`;
    this.byKey.set(key, id);
    const sz = wordSize(st.size);
    this.xml +=
      `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${id}"><w:name w:val="Namehyar ${this.byKey.size}"/><w:basedOn w:val="Normal"/>` +
      `<w:pPr>${st.dir === 'ltr' ? '' : '<w:bidi/>'}<w:spacing w:before="0" w:after="0" w:line="${pt20(st.line)}" w:lineRule="exact"/><w:jc w:val="left"/></w:pPr>` +
      `<w:rPr><w:rFonts w:ascii="${esc(st.font)}" w:hAnsi="${esc(st.font)}" w:eastAsia="${esc(st.font)}" w:cs="${esc(st.font)}"/>` +
      `${st.bold ? '<w:b/><w:bCs/>' : ''}${st.color ? `<w:color w:val="${esc(st.color)}"/>` : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`;
    return id;
  }
}

/** Word takes whole half points. What a size between them changes is made up for in the spacing, never in the width of the letters, which some fonts do not survive. */
const wordSize = (size) => Math.max(2, Math.round(size * 2));

/** One line's runs. Which pieces run left to right shows only on the whole line, whatever stretches of it are written apart. */
function exactRunsXml(runs, st) {
  const ltr = st.dir === 'ltr';
  const kinds = segments(runs.map((run) => run.text || '').join(''));
  let segment = 0;
  let segmentEnd = kinds[0]?.text.length || 0;
  let offset = 0;
  const piecesOf = (text) => {
    const pieces = [];
    let from = 0;
    while (from < text.length) {
      while (offset + from >= segmentEnd && segment + 1 < kinds.length) segmentEnd += kinds[++segment].text.length;
      const to = Math.max(from + 1, Math.min(text.length, segmentEnd - offset));
      pieces.push({ text: text.slice(from, to), kind: kinds[segment]?.kind || 'rtl' });
      from = to;
    }
    offset += text.length;
    return pieces;
  };
  // What rounding takes off one space is given to the next.
  let carry = 0;
  return runs.map((run) => {
    if (!run.text) return '';
    let spacing = '';
    if (run.sp) {
      const blank = run.text === ' ' || run.text === '\u00a0';
      const twips = Math.round((run.sp + (blank ? carry : 0)) * 20);
      if (blank) carry += run.sp - twips / 20;
      if (twips) spacing = `<w:spacing w:val="${twips}"/>`;
    }
    const fonts = run.font ? `<w:rFonts w:ascii="${esc(run.font)}" w:hAnsi="${esc(run.font)}" w:eastAsia="${esc(run.font)}" w:cs="${esc(run.font)}"/>` : '';
    const bold = run.b === undefined || run.b === !!st.bold ? '' : run.b ? '<w:b/><w:bCs/>' : '<w:b w:val="0"/><w:bCs w:val="0"/>';
    const italic = run.i ? '<w:i/><w:iCs/>' : '';
    const color = run.color ? `<w:color w:val="${esc(run.color)}"/>` : '';
    const size = run.size ? `<w:sz w:val="${wordSize(run.size)}"/><w:szCs w:val="${wordSize(run.size)}"/>` : '';
    const underline = run.u ?? st.underline ? '<w:u w:val="single"/>' : '';
    return piecesOf(run.text)
      .map((seg) => {
        const rtl = !ltr && seg.kind === 'rtl' ? '<w:rtl/>' : '';
        return `<w:r><w:rPr>${fonts}${bold}${italic}${color}${spacing}${size}${underline}${rtl}</w:rPr><w:t xml:space="preserve">${esc(seg.text)}</w:t></w:r>`;
      })
      .join('');
  }).join('');
}

function exactFrameXml(L, o, ctx) {
  const st = { ...TEXT_STYLE, ...o.style };
  const ltr = st.dir === 'ltr';
  const styleId = ctx.frameStyles.idFor(st);
  const lines = frameLines(o);
  // A paragraph that wraps takes its alignment from the frame; in a right-to-left paragraph Word's "left" is the side the line starts from.
  const jc = o.flow ? `<w:jc w:val="${ltr ? { right: 'right', left: 'left', center: 'center', justify: 'both' }[st.align] || 'left' : JC[st.align] || 'both'}"/>` : '';
  const paragraphs = lines.map((runs) => `<w:p><w:pPr><w:pStyle w:val="${styleId}"/>${jc}</w:pPr>${exactRunsXml(lines.length === 1 ? runsWithGaps(o, runs) : runs, st)}</w:p>`).join('');
  if (o.flow) return ctx.images.exactBox(paragraphs, { xMm: o.x, yMm: o.y, wMm: o.w, hMm: (o.h || st.line * MM_PER_PT) + st.size * 0.5 * MM_PER_PT, fill: o.fill, grows: true });
  // A word that came out wider must not push the line on to a second one, so the box has room on the side the line runs towards.
  const room = Math.max(12, o.w * 0.3);
  const heightMm = lines.length * st.line * MM_PER_PT + st.size * 0.5 * MM_PER_PT;
  return ctx.images.exactBox(paragraphs, { xMm: ltr ? o.x : o.x - room, yMm: o.y, wMm: o.w + room, hMm: heightMm, fill: o.fill });
}

const TOP_SPACER_PT = 1;

function documentXml(L, ctx, opts) {
  const { images, rels } = ctx;
  const flow = buildFlow(L);
  const geom = geomOf(L);
  const pageAnchors = opts.pageAnchors || [0];

  // Page objects are anchored to the first paragraph that starts on their page.
  const pageObjects = new Map();
  for (const o of L.objects || []) {
    if (o.anchor === 'sign') continue;
    const page = Math.min(o.page || 0, pageAnchors.length - 1);
    const at = pageAnchors[page] ?? 0;
    let xml = '';
    if (o.kind === 'text') xml = o.exact ? exactFrameXml(L, o, ctx) : textObjectXml(L, o, ctx);
    else {
      const rid = images.rel(rels, o.mediaId);
      if (!rid) continue;
      xml = images.anchor(rid, { xMm: o.x, yMm: o.y, wMm: o.w, hMm: o.w / (o.aspect || 1), behind: o.behind, rotate: o.rotate });
    }
    pageObjects.set(at, (pageObjects.get(at) || '') + xml);
  }

  const signDy = (L.offsets?.sign?.dy || 0) + (L.offsets?.sign?.fy || 0);
  const signAnchors = (L.objects || [])
    .filter((o) => o.anchor === 'sign')
    .map((o) => {
      const rid = images.rel(rels, o.mediaId);
      return rid ? images.anchor(rid, { xMm: o.x, yMm: o.dy + signDy, wMm: o.w, hMm: o.w / (o.aspect || 1), fromV: 'paragraph', rotate: o.rotate }) : '';
    })
    .join('');

  // Word tables have no spacing of their own, so the paragraphs next to them carry it.
  const tableStyle = styleOf(L, 'table');
  const isTableInFlow = (block) => block?.kind === 'table' && !block.fy;
  const extraAfter = (index) => (isTableInFlow(flow[index + 1]) ? spaceBefore(L, flow[index + 1]) : 0);
  const extraBefore = (index) => (isTableInFlow(flow[index - 1]) ? tableStyle.after : 0);

  const signXml = (block, { before, dx, inner }) => {
    const nameStyle = styleOf(L, 'signName');
    const titleStyle = styleOf(L, 'signTitle');
    const start = geom.bodyW - SIGN.col - dx;
    const nameP = `<w:p>${pPr(nameStyle, { start, end: dx, before, keepNext: !!block.title })}${inner}${block.name ? textRuns(block.name, nameStyle) : ''}</w:p>`;
    const titleP = block.title ? `<w:p>${pPr(titleStyle, { start, end: dx })}${textRuns(block.title, titleStyle)}</w:p>` : '';
    return nameP + titleP;
  };

  const paragraphXml = (block, { before, after, dx, inner }) => {
    const st = blockStyle(L, block);
    const indent = block.indent || {};
    const props = { align: block.align, keepNext: block.keepNext, pageBreak: block.pageBreak, before, after, start: (indent.start || 0) - dx, end: (indent.end || 0) + dx, first: indent.first || 0 };
    return `<w:p>${pPr(st, props)}${inner}${runsXml(block.runs, st, ctx)}</w:p>`;
  };

  // A block placed freely keeps its room in the flow with an empty line of the same height, so nothing else moves,
  // while its content floats in a text box hanging from that line, which can also be dragged in Word.
  const movedXml = (block, index, floats) => {
    const beforeMm = spaceBefore(L, block) * MM_PER_PT;
    const afterMm = block.kind === 'sign' ? 0 : blockStyle(L, block).after * MM_PER_PT;
    const total = opts.flowPos?.[index]?.h ?? estimatedHeight(L, block, geom);
    let content = '';
    if (block.kind === 'table') content = `${tableXml({ ...block, dx: 0 }, L, ctx, geom)}${spacerPara()}`;
    else if (block.kind === 'sign') content = signXml(block, { before: 0, dx: 0, inner: '' });
    else content = paragraphXml(block, { before: 0, after: 0, dx: 0, inner: '' });
    const box = images.textBox(content, { xMm: geom.left + block.dx, yMm: block.fy + beforeMm, wMm: geom.bodyW, hMm: Math.max(1, total - beforeMm - afterMm), fromV: 'paragraph', rightRoom: block.kind === 'table' ? 0.6 : 0 });
    const pictures = block.kind === 'sign' ? signAnchors : '';
    return `<w:p><w:pPr><w:bidi/><w:spacing w:before="0" w:after="0" w:line="${pt20(total / MM_PER_PT)}" w:lineRule="exact"/></w:pPr>${floats}${pictures}${box}</w:p>`;
  };

  // Only a line can hold a first table away from the top of the page.
  const roomAboveFirst = isTableInFlow(flow[0]) && spaceBefore(L, flow[0]) >= 0.75 ? spaceBefore(L, flow[0]) : 0;

  const parts = flow.map((block, index) => {
    const floats = pageObjects.get(index) || '';
    if (block.fy) return movedXml(block, index, floats);
    const dx = block.dx || 0;
    if (block.kind === 'table') {
      // Two tables with nothing between them would become one in Word; the paragraph between them holds their gap.
      const afterTable = isTableInFlow(flow[index - 1]);
      if (index === 0 && roomAboveFirst) return spacerPara(floats, roomAboveFirst) + tableXml(block, L, ctx, geom);
      const gap = afterTable ? Math.max(0.75, spaceBefore(L, block)) : TOP_SPACER_PT;
      return (floats || afterTable ? spacerPara(floats, gap) : '') + tableXml(block, L, ctx, geom);
    }
    const before = spaceBefore(L, block) + extraBefore(index);
    if (block.kind === 'sign') return signXml(block, { before, dx, inner: floats + signAnchors });
    return paragraphXml(block, { before, after: blockStyle(L, block).after + extraAfter(index), dx, inner: floats });
  });

  // Word needs a paragraph after a final table, and a document always holds at least one.
  if (!flow.length || flow[flow.length - 1].kind === 'table') parts.push(spacerPara(flow.length ? '' : pageObjects.get(0) || ''));

  const hasFooter = footerPart(L, opts) !== null;
  // The line that holds the page's frames above a first table must not push that table down.
  const marginTop = geom.top - (flow[0]?.kind === 'table' && !flow[0].fy && !roomAboveFirst && pageObjects.get(0) ? TOP_SPACER_PT * MM_PER_PT : 0);
  const sectPr =
    '<w:sectPr>' +
    '<w:headerReference w:type="default" r:id="rIdHeader"/>' +
    (hasFooter ? '<w:footerReference w:type="default" r:id="rIdFooter"/>' : '') +
    `<w:pgSz w:w="${tw(PAGE.w)}" w:h="${tw(PAGE.h)}"${PAGE.w > PAGE.h ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${tw(marginTop)}" w:right="${tw(geom.right)}" w:bottom="${tw(geom.bottom)}" w:left="${tw(geom.left)}" w:header="${tw(Math.max(0, Math.min(PAGE.headerTop, geom.top - 1)))}" w:footer="${tw(PAGE.footerBottom)}" w:gutter="0"/>` +
    '<w:bidi/></w:sectPr>';

  return `${XML}<w:document ${NS}><w:body>${parts.join('')}${sectPr}</w:body></w:document>`;
}

function partXml(L, part, ctx, opts) {
  const { images, rels } = ctx;
  const box = { xMm: part.x, yMm: part.y, wMm: part.w };
  if (part.id === 'logo') {
    const rid = images.rel(rels, L.letterhead.logo);
    return rid ? images.anchor(rid, { ...box, hMm: part.w / (L.letterhead.logoAspect || 1) }) : '';
  }
  if (part.id === 'rule') return images.line(box);
  const st = partStyle(L, part);
  const lines = partLines(L, part.id);
  const paragraphs = lines.map((runs) => `<w:p>${pPr(st)}${runsXml(runs, st, ctx)}</w:p>`).join('');
  return images.textBox(paragraphs, { ...box, hMm: lines.length * lineHeightMm(st) });
}

function headerXml(L, ctx, opts) {
  const parts = headerParts(L, opts.pageCount || 1).filter((p) => !p.hidden && p.id !== 'footer');
  return `${XML}<w:hdr ${NS}>${spacerPara(parts.map((p) => partXml(L, p, ctx, opts)).join(''))}</w:hdr>`;
}

function footerPart(L, opts) {
  return headerParts(L, opts.pageCount || 1).find((p) => p.id === 'footer' && !p.hidden) || null;
}

function footerXml(L, ctx, opts) {
  const part = footerPart(L, opts);
  const st = partStyle(L, part);
  const border = L.letterhead?.footerLine === false ? '' : '<w:pBdr><w:top w:val="single" w:sz="4" w:space="3" w:color="000000"/></w:pBdr>';
  const text = L.letterhead?.footer ? normalizeText(L.letterhead.footer) : '';
  // Word fills page numbers with Latin digits; in the B fonts those codes draw Persian digits.
  const num = rPr(st, { kind: 'number' });
  const field = (instr) =>
    `<w:r>${num}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${num}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
    `<w:r>${num}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${num}<w:t>1</w:t></w:r><w:r>${num}<w:fldChar w:fldCharType="end"/></w:r>`;
  const multi = showsPageNumbers(L, opts.pageCount || 1);
  const pageLine = `${textRuns(normalizeText('صفحهٔ '), st)}${field('PAGE')}${textRuns(' از ', st)}${field('NUMPAGES')}`;
  const body = text
    ? `<w:p>${pPr(st, { border })}${textRuns(text, st)}</w:p>${multi ? `<w:p>${pPr(st)}${pageLine}</w:p>` : ''}`
    : `<w:p>${pPr(st, { border })}${pageLine}</w:p>`;
  const lines = (text ? 1 : 0) + (multi ? 1 : 0);
  const box = ctx.images.textBox(body, { xMm: part.x, yMm: part.y, wMm: part.w, hMm: lines * lineHeightMm(st) + 1 });
  return `${XML}<w:ftr ${NS}>${spacerPara(box)}</w:ftr>`;
}

const STYLES_XML =
  `${XML}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  `<w:rFonts w:ascii="${LATIN_FONT}" w:hAnsi="${LATIN_FONT}" w:eastAsia="${LATIN_FONT}" w:cs="B Nazanin"/>` +
  '<w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="fa-IR"/>' +
  '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>' +
  '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  '</w:styles>';

const SETTINGS_XML =
  `${XML}<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
  '<w:themeFontLang w:val="en-US" w:bidi="fa-IR"/></w:settings>';

/** The settings. Pictures laid out to the pixel must not be made smaller when Word saves or prints the file. */
function settingsXml(carriesFonts, keepPictures) {
  return SETTINGS_XML.replace('<w:zoom w:percent="100"/>', `<w:zoom w:percent="100"/>${carriesFonts ? '<w:embedTrueTypeFonts/>' : ''}`).replace('<w:compat>', `${keepPictures ? '<w:doNotAutoCompressPictures/>' : ''}<w:compat>`);
}

const usesPlacedPictures = (L) => (L.objects || []).some((o) => o.exact && o.kind !== 'text');

// Vazirmatn is on few computers: the file carries it, and names the closest font for wherever Word will not use a carried one.
const FONT_KEYS = { regular: '{6A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}', bold: '{7B2C3D4E-5F6A-4B7C-9D8E-0F1A2B3C4D5E}' };

const fontTableXml = (embedded, others = []) =>
  `${XML}<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<w:font w:name="${SANS_FONT}"><w:altName w:val="Arial"/><w:charset w:val="B2"/><w:family w:val="swiss"/><w:pitch w:val="variable"/>` +
  (embedded ? `<w:embedRegular r:id="rIdFontRegular" w:fontKey="${FONT_KEYS.regular}"/><w:embedBold r:id="rIdFontBold" w:fontKey="${FONT_KEYS.bold}"/>` : '') +
  '</w:font>' +
  others.map((name) => `<w:font w:name="${esc(name)}"><w:altName w:val="${esc(otherNamesOf(name))}"/><w:charset w:val="B2"/></w:font>`).join('') +
  '</w:fonts>';

/** The same font goes by several names; Word takes one of these when a computer does not have the name in the file. */
function otherNamesOf(name) {
  if (/^minion/i.test(name)) return 'Times New Roman';
  if (/^adobe arabic/i.test(name)) return 'Adobe Arabic SHIN,Arial';
  const bare = name.replace(/^(B|2) /, '');
  return [`B ${bare}`, bare, `2 ${bare}`].filter((other) => other !== name).join(',');
}

/** The fonts that lines taken exactly from a file use. */
function exactFontsOf(L) {
  const names = new Set();
  for (const o of L.objects || []) {
    if (!o.exact || o.kind !== 'text') continue;
    if (o.style?.font) names.add(o.style.font);
    for (const run of (o.lines || []).flat()) if (run.font) names.add(run.font);
  }
  names.delete(SANS_FONT);
  return [...names];
}

/** A font carried in a Word file has its first bytes mixed with its key, as the file format asks. */
function obfuscatedFont(bytes, guid) {
  const hex = guid.replace(/[{}-]/g, '');
  const key = [];
  for (let i = hex.length - 2; i >= 0; i -= 2) key.push(parseInt(hex.slice(i, i + 2), 16));
  const out = bytes.slice();
  for (let i = 0; i < 32; i++) out[i] ^= key[i % 16];
  return out;
}

const relsXml = (rels) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`)
    .join('')}</Relationships>`;

const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * @param L the letter
 * @param lookup media id -> {bytes, ext} or null
 * @param opts {pageCount, pageAnchors} from layoutLetter
 */
export function buildDocx(L, lookup, opts = {}) {
  usePageSize(L);
  const files = [];
  const images = new Images(lookup, files);
  const docRels = [
    { id: 'rIdStyles', type: `${OFFICE_REL}/styles`, target: 'styles.xml' },
    { id: 'rIdSettings', type: `${OFFICE_REL}/settings`, target: 'settings.xml' },
    { id: 'rIdHeader', type: `${OFFICE_REL}/header`, target: 'header1.xml' },
  ];
  const hasFooter = footerPart(L, opts) !== null;
  if (hasFooter) docRels.push({ id: 'rIdFooter', type: `${OFFICE_REL}/footer`, target: 'footer1.xml' });
  const headerRels = [];

  const frameStyles = new FrameStyles();
  const documentPart = documentXml(L, { images, rels: docRels, frameStyles }, opts);
  const headerPart = headerXml(L, { images, rels: headerRels }, opts);
  const usesSans = [documentPart, headerPart, frameStyles.xml].some((part) => part.includes(`"${SANS_FONT}"`));
  if (usesSans) docRels.push({ id: 'rIdFonts', type: `${OFFICE_REL}/fontTable`, target: 'fontTable.xml' });
  const carried = usesSans && opts.embedFonts ? opts.embedFonts : null;
  const exactFonts = exactFontsOf(L);
  const hasFontTable = usesSans || exactFonts.length > 0;
  if (hasFontTable && !usesSans) docRels.push({ id: 'rIdFonts', type: `${OFFICE_REL}/fontTable`, target: 'fontTable.xml' });

  const contentTypes =
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    (carried ? '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>' : '') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
    (hasFooter ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '') +
    (hasFontTable ? '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' : '') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';

  const core =
    `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:title>${esc(L.subject || 'نامه')}</dc:title><dc:creator>${esc(L.signer?.name || '')}</dc:creator></cp:coreProperties>`;

  const out = [
    { name: '[Content_Types].xml', data: contentTypes },
    {
      name: '_rels/.rels',
      data: relsXml([
        { id: 'rId1', type: `${OFFICE_REL}/officeDocument`, target: 'word/document.xml' },
        { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
      ]),
    },
    { name: 'docProps/core.xml', data: core },
    { name: 'word/document.xml', data: documentPart },
    { name: 'word/_rels/document.xml.rels', data: relsXml(docRels) },
    { name: 'word/styles.xml', data: STYLES_XML.replace('</w:styles>', `${frameStyles.xml}</w:styles>`) },
    { name: 'word/settings.xml', data: settingsXml(!!carried, exactFonts.length > 0 || usesPlacedPictures(L)) },
    { name: 'word/header1.xml', data: headerPart },
  ];
  if (hasFontTable) out.push({ name: 'word/fontTable.xml', data: fontTableXml(!!carried, exactFonts) });
  if (carried) {
    const FONT_REL = `${OFFICE_REL}/font`;
    out.push(
      { name: 'word/_rels/fontTable.xml.rels', data: relsXml([{ id: 'rIdFontRegular', type: FONT_REL, target: 'fonts/font1.odttf' }, { id: 'rIdFontBold', type: FONT_REL, target: 'fonts/font2.odttf' }]) },
      { name: 'word/fonts/font1.odttf', data: obfuscatedFont(carried.regular, FONT_KEYS.regular) },
      { name: 'word/fonts/font2.odttf', data: obfuscatedFont(carried.bold, FONT_KEYS.bold) },
    );
  }
  if (headerRels.length) out.push({ name: 'word/_rels/header1.xml.rels', data: relsXml(headerRels) });
  if (hasFooter) out.push({ name: 'word/footer1.xml', data: footerXml(L, { images, rels: [] }, opts) });
  return zipStore([...out, ...files]);
}
