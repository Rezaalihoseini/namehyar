// The letter model and everything derived from it without touching the DOM,
// so the page renderer and the Word export build from exactly the same content.

import { normalizeText, jalaliDate } from './text.js';
import { uid, clone } from './util.js';

export const FONTS = ['B Nazanin', 'B Titr', 'B Lotus', 'B Zar', 'Vazirmatn'];

// Single line height of each font in Word (winAscent + winDescent) as [regular, bold], read from the font files.
const LINE_RATIO = {
  'B Nazanin': [1.482, 1.585],
  'B Titr': [1.76, 1.76],
  'B Lotus': [1.675, 1.776],
  'B Zar': [1.666, 1.579],
  Vazirmatn: [1.5625, 1.5625],
};

/** How much of a font's line lies above its baseline. */
export const ascentShare = (font) => (font === 'Vazirmatn' ? 0.6563 : 0.74);

// Fonts the user uploaded, with the same ratio read from their files.
const customFonts = new Map();

export function registerFont(family, ratio) {
  customFonts.set(family, [ratio, ratio]);
}

export function unregisterFont(family) {
  customFonts.delete(family);
}

export const allFonts = () => [...new Set([...FONTS, ...customFonts.keys()])];

export function lineRatio(font, bold) {
  const r = LINE_RATIO[font] || customFonts.get(font) || [1.5, 1.5];
  return bold ? r[1] : r[0];
}

// Page geometry in millimetres.
export const PAGE = {
  w: 210,
  h: 297,
  right: 20,
  left: 20,
  headerTop: 10,
  headerH: 33,
  bodyTop: 46,
  bodyBottom: 24,
  footerBottom: 8,
};

export const MM_PER_PT = 25.4 / 72;

const A4 = { w: PAGE.w, h: PAGE.h };

/** Pages are A4, unless the letter came from a file with pages of another size, which it then keeps all the way to its output. */
export function usePageSize(L) {
  PAGE.w = L?.page?.w || A4.w;
  PAGE.h = L?.page?.h || A4.h;
}

/** What a letter should remember about a page size. A4, give or take the rounding of whoever made the file, needs nothing. */
export function pageSizeToKeep(w, h) {
  return Math.abs(w - A4.w) < 0.6 && Math.abs(h - A4.h) < 0.6 ? null : { w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100 };
}

/** The text area of this letter's pages. Margins can differ per letter, for example after opening a Word file. */
export function geomOf(L) {
  usePageSize(L);
  const g = { top: PAGE.bodyTop, right: PAGE.right, bottom: PAGE.bodyBottom, left: PAGE.left, ...L.geom };
  return { ...g, bodyW: PAGE.w - g.right - g.left, bodyH: PAGE.h - g.top - g.bottom };
}

// The signature column sits on the left of the page, as in Iranian letters.
export const SIGN = { gap: 16, col: 70 };

export const DEFAULT_STYLES = {
  recipient: { font: 'B Titr', size: 12, bold: true, align: 'right', before: 0, after: 0, spacing: 1 },
  subject: { font: 'B Titr', size: 12, bold: true, align: 'right', before: 8, after: 6, spacing: 1 },
  greeting: { font: 'B Nazanin', size: 14, bold: false, align: 'right', before: 0, after: 4, spacing: 1.15 },
  body: { font: 'B Nazanin', size: 14, bold: false, align: 'justify', before: 0, after: 4, spacing: 1.15 },
  table: { font: 'B Nazanin', size: 12, bold: false, align: 'center', before: 4, after: 6, spacing: 1 },
  closing: { font: 'B Nazanin', size: 14, bold: false, align: 'right', before: 2, after: 0, spacing: 1.15 },
  signName: { font: 'B Titr', size: 12, bold: true, align: 'center', before: 0, after: 0, spacing: 1 },
  signTitle: { font: 'B Nazanin', size: 12, bold: true, align: 'center', before: 0, after: 0, spacing: 1 },
  cc: { font: 'B Nazanin', size: 11, bold: false, align: 'right', before: 0, after: 0, spacing: 1 },
  org: { font: 'B Titr', size: 9, bold: true, align: 'center', before: 0, after: 0, spacing: 1 },
  invocation: { font: 'B Titr', size: 12, bold: true, align: 'center', before: 0, after: 0, spacing: 1 },
  meta: { font: 'B Nazanin', size: 11, bold: false, align: 'right', before: 0, after: 0, spacing: 1 },
  footer: { font: 'B Nazanin', size: 10, bold: false, align: 'center', before: 0, after: 0, spacing: 1 },
};

export const ROLE_LABELS = {
  recipient: 'گیرنده',
  subject: 'موضوع',
  greeting: 'شروع نامه',
  body: 'متن نامه',
  table: 'جدول',
  closing: 'پایان نامه',
  signName: 'نام امضاکننده',
  signTitle: 'سمت امضاکننده',
  cc: 'رونوشت',
};

export const PART_LABELS = {
  logo: 'لوگو',
  org: 'نام سازمان',
  invocation: 'عبارت بالای نامه',
  number: 'شماره',
  date: 'تاریخ',
  attachment: 'پیوست',
  rule: 'خط زیر سربرگ',
  footer: 'پایین صفحه',
};

const PART_ROLE = { org: 'org', invocation: 'invocation', number: 'meta', date: 'meta', attachment: 'meta', footer: 'footer' };

export const TEXT_STYLE = { font: 'B Nazanin', size: 12, bold: false, align: 'right', before: 0, after: 0, spacing: 1 };

export function hashOf(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return hash;
}

/**
 * The runs of a line taken exactly from a file, with what must be added after some of its letters to keep every word in place
 * (run.sp, in points). While the words are as they came, that holds for all of them. After an edit the spaces still keep their
 * widths when their number is the same, so a line set wide stays wide.
 */
export function runsWithGaps(o, runs) {
  const gaps = o.gaps;
  if (!gaps) return runs;
  const text = String(o.text || '');
  const same = gaps.of === hashOf(text);
  const spaces = (text.match(/[ \u00a0]/g) || []).length;
  const spaceExtras = same || spaces === gaps.sp.length ? gaps.sp : [];
  const spread = same ? gaps.ws || [] : [];
  if (!spaceExtras.length && !spread.length) return runs;
  // A cut wherever what must be added changes.
  const spreadAt = (at) => {
    for (let i = 0; i < spread.length; i += 3) if (at >= spread[i] && at < spread[i + 1]) return spread[i + 2];
    return 0;
  };
  const out = [];
  let offset = 0;
  let space = 0;
  for (const run of runs) {
    const piece = run.text || '';
    if (run.img || !piece) {
      out.push(run);
      continue;
    }
    let from = 0;
    let each = spreadAt(offset);
    const flush = (to) => {
      if (to > from) out.push({ ...run, text: piece.slice(from, to), ...(each && { sp: each }) });
      from = to;
    };
    for (let i = 0; i < piece.length; i++) {
      const here = spreadAt(offset + i);
      if (here !== each) {
        flush(i);
        each = here;
      }
      if (piece[i] !== ' ' && piece[i] !== '\u00a0') continue;
      const extra = spaceExtras[space++] || 0;
      if (!extra) continue;
      flush(i);
      out.push({ ...run, text: piece[i], sp: extra });
      from = i + 1;
    }
    flush(piece.length);
    offset += piece.length;
  }
  return out;
}

/** The lines of a text frame, each as its runs. Words with a look of their own are kept in o.lines for as long as the text stays the same. */
export function frameLines(o) {
  const lines = String(o.text || '').split('\n');
  const own = o.lines?.length === lines.length && o.lines.every((runs, i) => runs.map((run) => run.text || '').join('') === lines[i]);
  return own ? o.lines : lines.map((line) => (line ? [{ text: line }] : []));
}

export function defaultSettings() {
  return {
    letterhead: { logo: null, logoAspect: 1, logoH: 18, org: ['نام سازمان'], invocation: 'بسمه تعالی', footer: '' },
    signer: { name: '', title: '', signature: null, signatureAspect: 2, stamp: null, stampAspect: 1 },
    autoFix: true,
    theme: 'system',
    templateUses: {},
    layout: null,
    looks: [],
    recentColors: [],
    fonts: [],
    phrases: [],
  };
}

export function signObjectsFor(signer, placed = {}) {
  const objects = [];
  const colLeft = PAGE.left;
  if (signer.signature) {
    const w = 38;
    const hgt = w / (signer.signatureAspect || 2);
    objects.push({ id: uid(), kind: 'signature', anchor: 'sign', mediaId: signer.signature, aspect: signer.signatureAspect || 2, x: colLeft + (SIGN.col - w) / 2, dy: SIGN.gap + 3 - hgt, w, ...placed.signature });
  }
  if (signer.stamp) {
    const w = 30;
    const hgt = w / (signer.stampAspect || 1);
    objects.push({ id: uid(), kind: 'stamp', anchor: 'sign', mediaId: signer.stamp, aspect: signer.stampAspect || 1, x: colLeft + SIGN.col - w + 8, dy: SIGN.gap + 8 - hgt, w, ...placed.stamp });
  }
  return objects;
}

export function newLetter(settings) {
  const now = Date.now();
  const layout = settings.layout || {};
  return {
    id: uid(),
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    durationSec: null,
    status: 'draft',
    templateId: null,
    rank: 'superior',
    recipientId: null,
    recipient: { name: '', title: '' },
    subject: '',
    greeting: '',
    bodyHtml: '',
    body: [],
    closing: '',
    cc: '',
    number: '',
    date: jalaliDate(),
    attachment: 'ندارد',
    attachmentManual: false,
    autoFix: settings.autoFix !== false,
    styles: clone({ ...DEFAULT_STYLES, ...layout.styles }),
    offsets: clone(layout.offsets || {}),
    geom: clone(layout.geom || {}),
    letterhead: clone(settings.letterhead),
    signer: { name: settings.signer.name, title: settings.signer.title },
    objects: signObjectsFor(settings.signer, layout.signObjects),
  };
}

/** A fresh draft that starts from an earlier letter: same words and layout, today's date, no number. */
export function copyOfLetter(source) {
  const now = Date.now();
  return {
    ...clone(source),
    id: uid(),
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    durationSec: null,
    activeSec: 0,
    status: 'draft',
    number: '',
    date: jalaliDate(),
    bodyDirty: true,
  };
}

export function styleOf(L, role) {
  return { ...DEFAULT_STYLES[role], ...(L.styles && L.styles[role]) };
}

/** A paragraph from an opened Word file can keep its own spacing on top of its role's style. */
export const blockStyle = (L, block) => (block.over ? { ...styleOf(L, block.role), ...block.over } : styleOf(L, block.role));

export const sectionRole = (section) => (section === 'sign' ? 'signName' : section.startsWith('table:') ? 'table' : section.startsWith('body') ? 'body' : section);

export const lineHeightMm = (st, bold = st.bold) => (st.line ? st.line * MM_PER_PT : lineRatio(st.font, bold) * st.spacing * st.size * MM_PER_PT);

/**
 * Where each letterhead part sits on the page, in millimetres: the place the user dragged it to,
 * or the default arrangement, with the invocation on the exact centre of the page.
 */
export function headerParts(L, total = 1) {
  usePageSize(L);
  const lh = L.letterhead || {};
  const saved = lh.parts || {};
  const orgLines = (lh.org || []).filter(Boolean);
  const logoH = lh.logoH || 18;
  const logoGap = lh.logo ? logoH + 0.5 : 0;
  const stack = logoGap + orgLines.length * lineHeightMm(styleOf(L, 'org'));
  // A tall logo makes the letterhead band taller, so the rule stays below everything in it.
  const band = Math.max(PAGE.headerH, stack + 1);
  const stackTop = PAGE.headerTop + Math.max(0, (band - stack) / 2);
  const metaH = lineHeightMm(styleOf(L, 'meta'));
  const metaTop = PAGE.headerTop + (band - 3 * metaH) / 2;

  const out = [];
  const add = (id, box) => {
    const { x, y, w, hidden, align } = saved[id] || {};
    out.push({
      id,
      role: PART_ROLE[id] || null,
      ...box,
      ...(x !== undefined && { x }),
      ...(y !== undefined && { y }),
      ...(w !== undefined && { w }),
      hidden: !!hidden,
      align,
    });
  };

  if (lh.logo) add('logo', { x: 160 - (logoH * (lh.logoAspect || 1)) / 2, y: stackTop, w: logoH * (lh.logoAspect || 1) });
  if (orgLines.length) add('org', { x: 130, y: stackTop + logoGap, w: 60 });
  if (lh.invocation) add('invocation', { x: 75, y: PAGE.headerTop, w: 60 });
  add('number', { x: 20, y: metaTop, w: 40 });
  add('date', { x: 20, y: metaTop + metaH, w: 40 });
  add('attachment', { x: 20, y: metaTop + 2 * metaH, w: 40 });
  add('rule', { x: PAGE.left, y: PAGE.headerTop + band, w: PAGE.w - PAGE.left - PAGE.right });

  const footerLines = (lh.footer ? 1 : 0) + (showsPageNumbers(L, total) ? 1 : 0);
  if (footerLines) {
    const hgt = footerLines * lineHeightMm(styleOf(L, 'footer')) + 1;
    add('footer', { x: PAGE.left, y: PAGE.h - PAGE.footerBottom - hgt, w: PAGE.w - PAGE.left - PAGE.right });
  }
  return out;
}

/** Page numbers appear on letters of several pages, unless a Word file that had none was opened. */
export const showsPageNumbers = (L, total) => total > 1 && L.letterhead?.pageNumbers !== false;

/** The text of a letterhead part as lines of runs. */
export function partLines(L, id) {
  const lh = L.letterhead || {};
  if (id === 'org') return (lh.org || []).filter(Boolean).map((text) => [{ text: normalizeText(text) }]);
  if (id === 'invocation') return lh.invocation ? [[{ text: normalizeText(lh.invocation) }]] : [];
  const meta = (label, value) => [[{ text: `${label}: `, b: true }, { text: value }]];
  if (id === 'number') return meta('شماره', L.number ? normalizeText(L.number) : '............');
  if (id === 'date') return meta('تاریخ', normalizeText(L.date || ''));
  if (id === 'attachment') return meta('پیوست', normalizeText(L.attachment || 'ندارد'));
  return [];
}

/** A part keeps its own alignment when the user set one; font and size are shared with its role. */
export function partStyle(L, part) {
  const st = styleOf(L, part.role);
  return part.align ? { ...st, align: part.align } : st;
}

/**
 * The letter as an ordered list of flow blocks, each belonging to a section the user can drag as one:
 * {kind:'p', role, runs, align?, indent?, keepNext?} | {kind:'table', role, rows, header} | {kind:'sign', ...}
 * Each paragraph of the body is a section of its own, and they also form one group that can move as a whole.
 * dx moves a block sideways; dy opens or closes the space above it, so what follows moves too;
 * fy moves it up or down alone, in "free move", leaving everything else exactly where it is.
 */
export function buildFlow(L) {
  const fix = (t) => (L.autoFix === false ? t || '' : normalizeText(t || ''));
  const fixRuns = (runs) => (runs || []).map((r) => (r.text ? { ...r, text: fix(r.text) } : r));
  const P = (role, text, extra) => ({ kind: 'p', role, section: role, runs: [{ text: fix(text) }], ...extra });
  const flow = [];

  if (L.recipient?.name) flow.push(P('recipient', L.recipient.name));
  if (L.recipient?.title) flow.push(P('recipient', L.recipient.title));
  if (L.subject) flow.push(P('subject', `موضوع: ${L.subject}`));
  if (L.greeting) flow.push(P('greeting', L.greeting));

  let tables = 0;
  (L.body || []).forEach((b, index) => {
    if (b.kind === 'table') {
      flow.push({
        ...b,
        role: 'table',
        section: `table:${tables++}`,
        group: 'body',
        index,
        header: b.header !== false,
        rows: b.rows.map((row) => row.map((cell) => ({ ...cell, paras: cell.paras.map((p) => ({ ...p, runs: fixRuns(p.runs) })) }))),
      });
    } else {
      flow.push({ kind: 'p', role: 'body', section: `body:${index}`, group: 'body', index, align: b.align, indent: b.indent, over: b.over, own: b.move, pageBreak: b.pageBreak, runs: fixRuns(b.runs) });
    }
  });

  if (L.closing) flow.push(P('closing', L.closing, { keepNext: true }));

  const name = fix(L.signer?.name);
  const title = fix(L.signer?.title);
  if (name || title || (L.objects || []).some((o) => o.anchor === 'sign')) flow.push({ kind: 'sign', role: 'sign', section: 'sign', name, title });

  const ccLines = String(L.cc || '').split('\n').map((s) => s.trim()).filter(Boolean);
  ccLines.forEach((line, i) => flow.push(P('cc', i === 0 ? `رونوشت: ${line}` : line, i === 0 ? { firstCc: true } : null)));

  const seen = new Set();
  for (const block of flow) {
    const family = block.group || block.section;
    const first = !seen.has(family);
    seen.add(family);
    const own = block.own || L.offsets?.[block.section] || {};
    const shared = block.group ? L.offsets?.[block.group] || {} : {};
    block.dx = (own.dx || 0) + (shared.dx || 0);
    block.fy = (own.fy || 0) + (shared.fy || 0);
    block.dy = (block.group || first ? own.dy || 0 : 0) + (first ? shared.dy || 0 : 0);
  }
  return flow;
}

/** The blank space above a block in points, before the user moved it. */
export function baseBefore(L, block) {
  if (block.kind === 'sign') return SIGN.gap / MM_PER_PT;
  const st = blockStyle(L, block);
  return block.firstCc ? Math.max(st.before, 10) : st.before;
}

export const spaceBefore = (L, block) => Math.max(0, baseBefore(L, block) + (block.dy || 0) / MM_PER_PT);

const textOfRuns = (runs) => (runs || []).map((r) => r.text || '').join('');

export function plainTextOf(L) {
  const lines = [];
  for (const b of buildFlow(L)) {
    if (b.kind === 'p') lines.push(textOfRuns(b.runs));
    else if (b.kind === 'table') b.rows.forEach((row) => row.forEach((cell) => cell.paras.forEach((p) => lines.push(textOfRuns(p.runs)))));
    else if (b.kind === 'sign') lines.push(b.name, b.title);
  }
  for (const o of L.objects || []) if (o.kind === 'text') lines.push(o.text || '');
  lines.push(L.number || '', L.date || '');
  return lines.join('\n');
}

/**
 * The [blanks] still unfilled, each with how many times it stands in the letter. Brackets in a page taken exactly from a file are
 * only brackets, unless they were made into a blank here, or typed into something added here.
 */
export function blanksOf(L) {
  const found = new Map();
  const add = (text, wanted) => {
    for (const m of String(text || '').matchAll(/\[([^\]\n]+)\]/g)) {
      if (wanted(m[1])) found.set(m[1], (found.get(m[1]) || 0) + 1);
    }
  };
  if (L.importInfo?.exact) {
    for (const o of L.objects || []) {
      if (o.kind === 'text') add(o.text, (label) => !o.exact || !!L.fields?.includes(label));
    }
  } else add(plainTextOf(L), () => true);
  return [...found].map(([label, count]) => ({ label, count }));
}

/** How many [blanks] are still unfilled. */
export const countBlanks = (L) => blanksOf(L).reduce((sum, blank) => sum + blank.count, 0);

/** Attachment says «دارد» as soon as the text mentions an attachment, unless the user chose otherwise. */
export function syncAttachment(L) {
  if (L.attachmentManual) return;
  const text = (L.body || []).map((b) => textOfRuns(b.runs)).join(' ');
  L.attachment = /به پیوست|پیوست\s/.test(text) ? 'دارد' : 'ندارد';
}

/** Pictures that sit inside the text and tables of the body, not floating over the page. */
export function inlineImageIds(L) {
  const ids = [];
  const scan = (runs) => (runs || []).forEach((r) => r.img && ids.push(r.img.id));
  for (const b of L.body || []) {
    if (b.kind === 'table') b.rows.forEach((row) => row.forEach((cell) => cell.paras.forEach((p) => scan(p.runs))));
    else scan(b.runs);
  }
  return ids;
}

export function fileBaseName(L) {
  const subject = (L.subject || L.sourceName || 'نامه').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 50);
  const date = String(L.date || '').replace(/\//g, '-');
  return `${subject} ${date}`.trim();
}
