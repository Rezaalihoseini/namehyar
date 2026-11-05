// Ready-made arrangements of the page. Each returns where the letterhead parts go and where the text starts.

import { PAGE, headerParts, lineHeightMm, styleOf } from '../model.js';

const LEFT = PAGE.left;
const RIGHT = PAGE.w - PAGE.right;

function sizes(L) {
  const lh = L.letterhead || {};
  const logoH = lh.logoH || 18;
  const aspect = lh.logoAspect || 1;
  const orgLines = (lh.org || []).filter(Boolean).length;
  return {
    hasLogo: !!lh.logo,
    logoH,
    logoW: logoH * aspect,
    orgH: orgLines * lineHeightMm(styleOf(L, 'org')),
    invH: lh.invocation ? lineHeightMm(styleOf(L, 'invocation')) : 0,
    metaH: lineHeightMm(styleOf(L, 'meta')),
  };
}

/** Number, date and attachment side by side on one line. */
function metaRow(y) {
  return {
    number: { x: 130, y, w: 60, align: 'right' },
    date: { x: 75, y, w: 60, align: 'center' },
    attachment: { x: LEFT, y, w: 50, align: 'left' },
  };
}

export const LAYOUTS = [
  {
    id: 'classic',
    title: 'کلاسیک',
    make: () => ({ parts: {}, top: PAGE.bodyTop }),
  },
  {
    id: 'centered',
    title: 'سربرگ وسط',
    make(L) {
      const s = sizes(L);
      let y = 8;
      const parts = { invocation: { x: 75, y, w: 60, align: 'center' } };
      y += s.invH + 1;
      if (s.hasLogo) {
        parts.logo = { x: (PAGE.w - s.logoW) / 2, y, w: s.logoW };
        y += s.logoH + 1;
      }
      parts.org = { x: 45, y, w: 120, align: 'center' };
      y += s.orgH + 2;
      Object.assign(parts, metaRow(y));
      y += s.metaH + 1;
      parts.rule = { x: LEFT, y, w: RIGHT - LEFT };
      return { parts, top: y + 3 };
    },
  },
  {
    id: 'mirror',
    title: 'شماره راست، سازمان چپ',
    make(L) {
      const s = sizes(L);
      const stack = (s.hasLogo ? s.logoH + 0.5 : 0) + s.orgH;
      const stackTop = PAGE.headerTop + Math.max(0, (PAGE.headerH - stack) / 2);
      const metaTop = PAGE.headerTop + (PAGE.headerH - 3 * s.metaH) / 2;
      const parts = {
        org: { x: LEFT, y: stackTop + (s.hasLogo ? s.logoH + 0.5 : 0), w: 60, align: 'center' },
        number: { x: RIGHT - 40, y: metaTop, w: 40, align: 'right' },
        date: { x: RIGHT - 40, y: metaTop + s.metaH, w: 40, align: 'right' },
        attachment: { x: RIGHT - 40, y: metaTop + 2 * s.metaH, w: 40, align: 'right' },
      };
      if (s.hasLogo) parts.logo = { x: LEFT + 30 - s.logoW / 2, y: stackTop, w: s.logoW };
      return { parts, top: PAGE.bodyTop };
    },
  },
  {
    id: 'compact',
    title: 'فشرده',
    make(L) {
      const s = sizes(L);
      const logoH = s.hasLogo ? 12 : 0;
      const logoW = s.hasLogo ? (s.logoW / s.logoH) * 12 : 0;
      const parts = {
        invocation: { x: 75, y: 8, w: 60, align: 'center' },
        org: { x: RIGHT - logoW - 62, y: 8 + (logoH ? (logoH - s.orgH) / 2 : 0), w: 60, align: 'right' },
      };
      if (s.hasLogo) parts.logo = { x: RIGHT - logoW, y: 8, w: logoW };
      const y = 8 + Math.max(logoH, s.invH, s.orgH) + 1.5;
      Object.assign(parts, metaRow(y));
      parts.rule = { x: LEFT, y: y + s.metaH + 1, w: RIGHT - LEFT };
      return { parts, top: y + s.metaH + 4 };
    },
  },
  {
    id: 'plain',
    title: 'بدون سربرگ',
    make(L) {
      const s = sizes(L);
      return {
        parts: {
          logo: { hidden: true },
          org: { hidden: true },
          invocation: { hidden: true },
          rule: { hidden: true },
          number: { x: LEFT, y: 15, w: 40 },
          date: { x: LEFT, y: 15 + s.metaH, w: 40 },
          attachment: { x: LEFT, y: 15 + 2 * s.metaH, w: 40 },
        },
        top: 15 + 3 * s.metaH + 4,
      };
    },
  },
];

/** The letter as it would look with this arrangement, without changing the letter itself. */
export function withLayout(L, layout) {
  const { parts, top } = layout.make(L);
  return {
    ...L,
    letterhead: { ...L.letterhead, parts },
    geom: { ...L.geom, top },
  };
}

export { headerParts };
