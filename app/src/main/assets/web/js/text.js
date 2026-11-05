// Persian text helpers. normalizeText is applied when a letter is laid out or exported,
// never to what the user is typing, so the editor is not disturbed mid-word.

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export const toFaDigits = (s) =>
  String(s)
    .replace(/[0-9]/g, (d) => FA_DIGITS[+d])
    .replace(/[٠-٩]/g, (d) => FA_DIGITS[d.charCodeAt(0) - 0x660]);

export const toEnDigits = (s) =>
  String(s)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));

// Latin words, addresses and codes such as "ISO9001" or "www.site.ir" stay exactly as typed.
const LATIN_TOKEN = /[0-9]*[A-Za-z][A-Za-z0-9._\-@/:+]*/g;

function mapOutsideLatin(s, fn) {
  let out = '';
  let i = 0;
  for (const m of s.matchAll(LATIN_TOKEN)) {
    out += fn(s.slice(i, m.index)) + m[0];
    i = m.index + m[0].length;
  }
  return out + fn(s.slice(i));
}

const FA = '؀-ۿ';
const ZWNJ = '‌';

function fixPersian(part) {
  let t = toFaDigits(part);
  t = t.replace(/;/g, '؛').replace(/\?/g, '؟');
  t = t.replace(/,/g, (m, i, all) => (/[۰-۹]/.test(all[i - 1] || '') && /[۰-۹]/.test(all[i + 1] || '') ? m : '،'));
  // می رساند -> می‌رساند
  t = t.replace(new RegExp(`(^|[\\s«(${ZWNJ}])(ن?می)[ \\t]+(?=[${FA}])`, 'g'), `$1$2${ZWNJ}`);
  // نامه ها -> نامه‌ها
  t = t.replace(new RegExp(`([${FA}])[ \\t]+(ها|های|هایی|هایم|هایت|هایش|هایمان|هایتان|هایشان)(?=$|[\\s،؛.:!؟)»\\]])`, 'g'), `$1${ZWNJ}$2`);
  t = t.replace(/[ \t]+([،؛؟!.:)»\]])/g, '$1');
  t = t.replace(/([«(\[])[ \t]+/g, '$1');
  t = t.replace(/([،؛])(?=[^\s)»\]])/g, '$1 ');
  return t.replace(/[ \t]{2,}/g, ' ');
}

export function normalizeText(input) {
  if (!input) return '';
  // The B fonts have no combining hamza (U+0654): نامهٔ would show an empty circle in Word, so it uses the letter ۀ.
  const s = input.replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/ /g, ' ').replace(/هٔ/g, 'ۀ');
  return mapOutsideLatin(s, fixPersian);
}

/** Folds spelling differences so a search finds "می رساند", "می‌رساند" and "ميرساند" alike. */
export function searchKey(input) {
  return toEnDigits(String(input || ''))
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/[ۀة]/g, 'ه')
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[\s‌‏‎]+/g, '')
    .toLowerCase();
}

function gregorianToJalali(gy, gm, gd) {
  const monthDays = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) - 80 + gd + monthDays[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  jy += Math.floor((days - 1) / 365);
  if (days > 365) days = (days - 1) % 365;
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

export function jalaliDate(date = new Date()) {
  const [y, m, d] = gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return toFaDigits(`${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`);
}

const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const WEEK_DAYS = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

/** «سه‌شنبه، ۱۲ آبان ۱۴۰۵» */
export function jalaliLongDate(date = new Date()) {
  const [y, m, d] = gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return toFaDigits(`${WEEK_DAYS[date.getDay()]}، ${d} ${MONTHS[m - 1]} ${y}`);
}

/** «آبان ۱۴۰۵» */
export function jalaliMonth(date = new Date()) {
  const [y, m] = gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return toFaDigits(`${MONTHS[m - 1]} ${y}`);
}

export function formatSeconds(sec) {
  const s = Math.max(0, Math.round(sec));
  return toFaDigits(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
}
