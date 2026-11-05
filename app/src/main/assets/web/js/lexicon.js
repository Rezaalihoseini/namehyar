// Words the app has seen: its own templates and phrases, the user's recipients and letters, what was read clearly on the same page, and the
// 14,000 everyday words inside the engine's own Persian model. Most reading mistakes in Persian only move a dot, so a word nobody has seen,
// with the shape of one they have, deserves a second look.

import { CLOSINGS, GREETINGS, PHRASES } from './data/phrases.js';
import { TEMPLATES } from './data/templates.js';
import { OFFICE_WORDS } from './data/office-words.js';
import { fetchBytes } from './util.js';

const SAME_SHAPE = {
  پ: 'ب', ت: 'ب', ث: 'ب', ن: 'ب', ی: 'ب', ئ: 'ب', ي: 'ب',
  ج: 'ح', چ: 'ح', خ: 'ح',
  ذ: 'د',
  ز: 'ر', ژ: 'ر',
  ش: 'س',
  ض: 'ص',
  ظ: 'ط',
  غ: 'ع',
  ق: 'ف',
  گ: 'ک', ك: 'ک',
  ة: 'ه',
  آ: 'ا', أ: 'ا', إ: 'ا',
  ؤ: 'و',
};

/** Below this, the engine doubts a word nobody has seen, such as a name. */
const UNKNOWN_BELOW = 80;
/** A word from the list is usually right, even when the engine hesitates over it. */
const KNOWN_BELOW = 40;
/** A form of a word from the list, such as «شمارم» of «شمار», is less sure: a misread ending often makes one. */
const FORM_BELOW = 70;
/** A number read wrongly is the worst kind of mistake, and no list gives it away. */
const NUMBER_BELOW = 90;
/** A word this clear is only doubted against the user's own words, not the general list. */
const CLEAR_ABOVE = 94;
/** Above this, a word with one dot out is worth a look; two dots out, it is more likely a word the list lacks. */
const ONE_LETTER_ABOVE = 70;
/** Words so common and so often doubted by the engine that a doubt about them means little. */
const COMMON = new Set(['این', 'آن', 'از', 'به', 'در', 'با', 'و', 'که', 'را', 'تا', 'بر', 'هم', 'یا', 'اگر', 'است', 'شد', 'شده']);

const HAS_DIGIT = /[0-9\u06f0-\u06f9]/;
const SUFFIXES = ['هایی', 'های', 'ها', 'ترین', 'تر', 'ای', 'ی', 'ان', 'ات', 'ین', 'مان', 'تان', 'شان', 'ش', 'م', 'ت', 'گی'];
const PREFIXES = ['نمی', 'می', 'بی', 'نا', 'هم', 'ب', 'ن'];

const letters = (word) => word.replace(/[\u200c\u0654\u0640\u064b]/g, '').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
const shapeOf = (word) => [...letters(word)].map((ch) => SAME_SHAPE[ch] || ch).join('');
/** A word without what stands around it: «(مبانی،» is «مبانی». */
const coreOf = (word) => word.replace(/^[^\u0621-\u06d3]+|[^\u0621-\u06d3]+$/g, '');

const WORD = /[\u0621-\u06d3\u200c\u0654]{2,}/g;
const OWN = 10;

/**
 * @param texts everything to learn from
 * @param general words known without having been seen here
 */
export function buildLexicon(texts, general = []) {
  const counts = new Map();
  const shown = new Map();
  const byShape = new Map();
  const add = (found, weight) => {
    const key = letters(found);
    if (key.length < 2) return;
    counts.set(key, (counts.get(key) || 0) + weight);
    if (!shown.has(key) || weight === OWN) shown.set(key, found);
    const shape = shapeOf(key);
    if (!byShape.has(shape)) byShape.set(shape, new Set());
    byShape.get(shape).add(key);
  };
  for (const word of general) add(word, 1);
  for (const text of texts) for (const found of String(text || '').match(WORD) || []) add(found, OWN);
  return { counts, shown, byShape };
}

/** Everything the app itself knows how to write. */
export function appWords() {
  const strings = (value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []);
  return strings([TEMPLATES, PHRASES, GREETINGS, CLOSINGS, OFFICE_WORDS]);
}

/** Words read clearly more than once on these pages: a name that recurs is known by its second clear reading. */
export function clearWords(words) {
  const seen = new Map();
  for (const word of words) if (word.conf >= 93) seen.set(word.text, (seen.get(word.text) || 0) + 1);
  return [...seen].filter(([, count]) => count > 1).map(([text]) => text);
}

/** The word list inside the model file, which holds it as a compact tree. */
export async function modelWords() {
  const buffer = await fetchBytes(new URL('../vendor/tesseract/fas.traineddata', import.meta.url).href);
  const view = new DataView(buffer);
  const partAt = (index) => view.getUint32(4 + index * 8, true) + view.getUint32(8 + index * 8, true) * 2 ** 32;
  const WORD_LIST = 19;
  const LETTERS = 21;
  const names = new TextDecoder().decode(new Uint8Array(buffer, partAt(LETTERS), partAt(LETTERS + 1) - partAt(LETTERS))).split('\n');
  const alphabet = names.slice(1, parseInt(names[0], 10) + 1).map((line) => line.split(' ')[0]);
  const start = partAt(WORD_LIST);
  const size = view.getInt32(start + 2, true);
  const edges = view.getInt32(start + 6, true);
  const flagBit = Math.ceil(Math.log2(size + 1));
  const words = [];
  const walk = (node, prefix) => {
    for (let i = node; i < edges; i++) {
      const low = view.getUint32(start + 10 + i * 8, true);
      const high = view.getUint32(start + 14 + i * 8, true);
      const flags = (low >>> flagBit) & 7;
      if (!(flags & 2)) {
        const word = prefix + (alphabet[low & (2 ** flagBit - 1)] || '');
        if (flags & 4) words.push(word);
        const next = (low >>> (flagBit + 3)) + high * 2 ** (32 - flagBit - 3);
        if (next) walk(next, word);
      }
      if (flags & 1) break;
    }
  };
  walk(0, '');
  return words;
}

const isForm = (key, { counts }) => SUFFIXES.some((end) => key.endsWith(end) && key.length - end.length >= 3 && counts.has(key.slice(0, -end.length))) || PREFIXES.some((begin) => key.startsWith(begin) && key.length - begin.length >= 3 && counts.has(key.slice(begin.length)));

function oneApart(a, b) {
  if (a === b) return false;
  if (a.length === b.length) {
    let differ = 0;
    for (let i = 0; i < a.length && differ < 2; i++) if (a[i] !== b[i]) differ++;
    return differ === 1;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}

const lettersApart = (a, b) => {
  let differ = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) differ++;
  return differ;
};

/**
 * The word it is probably meant to be, when it is one nobody has seen.
 * @param near also look one letter away, for words the engine doubts anyway
 * @param ownOnly only among the user's own words, not the general list
 * @param oneLetter only words with a single letter different
 */
export function suggestion(word, lexicon, { near = false, ownOnly = false, oneLetter = false } = {}) {
  const core = coreOf(word);
  const key = letters(core);
  if (key.length < 3 || lexicon.counts.has(key)) return null;
  const value = (other) => lexicon.counts.get(other);
  const usable = (other) => (!ownOnly || value(other) >= OWN) && (!oneLetter || lettersApart(other, key) <= 1);
  // The small hamza on a final he reads as a mim or a lam: «ماده» for «مادم».
  const lastIsHe = (other) => /[مل]$/.test(key) && other.length === key.length && other.endsWith('ه') && other.slice(0, -1) === key.slice(0, -1);
  const shape = shapeOf(key);
  const rank = (a, b) => Number(lastIsHe(b)) - Number(lastIsHe(a)) || lettersApart(a, key) - lettersApart(b, key) || Number(shapeOf(b) === shape) - Number(shapeOf(a) === shape) || Math.min(value(b), OWN) - Math.min(value(a), OWN) || value(b) - value(a);
  const found = [...(lexicon.byShape.get(shape) || [])].filter(usable);
  if (near && key.length >= 4) found.push(...[...lexicon.counts.keys()].filter((other) => (!ownOnly || value(other) >= OWN) && Math.abs(other.length - key.length) <= 1 && oneApart(other, key)));
  if (!found.length) return null;
  const pick = found.sort(rank)[0];
  return word.replace(core, lexicon.shown.get(pick));
}

/**
 * Whether a word read from a scan deserves a look, and what it may be meant to be.
 * @param fixed the engine's doubt came from a mark that has been put right
 */
export function lookAt(text, confidence, lexicon, { fixed = false } = {}) {
  const conf = fixed ? Math.max(confidence, UNKNOWN_BELOW) : confidence;
  if (HAS_DIGIT.test(text)) return { look: conf < NUMBER_BELOW };
  const key = letters(coreOf(text));
  if (key.length < 3) return { look: !COMMON.has(key) && conf < KNOWN_BELOW };
  if (lexicon.counts.has(key)) return { look: !COMMON.has(key) && conf < KNOWN_BELOW };
  const form = isForm(key, lexicon);
  const options = { near: conf < UNKNOWN_BELOW, ownOnly: conf >= CLEAR_ABOVE, oneLetter: conf >= ONE_LETTER_ABOVE };
  if (form) {
    if (conf >= FORM_BELOW) return { look: false };
    const better = suggestion(text, lexicon, options);
    return { look: true, ...(better && { better }) };
  }
  const better = suggestion(text, lexicon, options);
  if (better) return { look: true, better };
  return { look: conf < UNKNOWN_BELOW };
}
