// A realistic test letter used to check the Word and PDF output against each other.

export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';

export function sampleLetter({ long = false, images = false, moved = false } = {}) {
  const para = 'به استحضار می رساند پیرو نامهٔ شمارهٔ 123/45 مورخ 1405/08/12 در خصوص فعالیت های واحدهای فناور مستقر در مرکز رشد، جلسه ای با حضور نمایندگان شرکت ها برگزار گردید. در این جلسه موضوع گزارش عملکرد (Technology Report) و برنامه ۶ ماهه بررسی شد.';
  const body = [
    { kind: 'p', runs: [{ text: para }] },
    { kind: 'p', runs: [{ text: 'خواهشمند است در صورت صلاحدید ' }, { text: 'دستور فرمایید', b: true }, { text: ' اقدام لازم معمول گردد.' }] },
    { kind: 'p', align: 'center', runs: [{ text: 'این خط وسط‌چین است', u: true }] },
    { kind: 'p', align: 'left', runs: [{ text: 'این خط چپ‌چین است' }] },
    {
      kind: 'table',
      header: true,
      rows: [
        ['ردیف', 'نام واحد فناور', 'تاریخ پذیرش'],
        ['1', 'شرکت دانش بنیان آریا', '1404/11/03'],
        ['2', 'هسته فناور پژوهش یار', '1405/02/19'],
      ].map((row) => row.map((text) => ({ paras: [{ runs: [{ text }] }] }))),
    },
  ];
  if (long) for (let i = 0; i < 14; i++) body.splice(1, 0, { kind: 'p', runs: [{ text: para + ' ' + para }] });

  const letter = {
    id: 'sample',
    rank: 'superior',
    recipient: { name: 'جناب آقای دکتر احمدی', title: 'رئیس محترم پارک علم و فناوری' },
    subject: 'درخواست همکاری در برگزاری نمایشگاه',
    greeting: 'با سلام و احترام،',
    body,
    closing: 'پیشاپیش از حسن توجه جناب‌عالی سپاسگزارم.',
    cc: 'جناب آقای رضایی، معاون محترم جهت استحضار\nبایگانی',
    number: '1405/123',
    date: '۱۴۰۵/۰۸/۱۲',
    attachment: 'دارد',
    autoFix: true,
    styles: {},
    letterhead: { logo: images ? 'logo' : null, logoAspect: 1, logoH: 18, org: ['مرکز نمونه'], invocation: 'بسمه تعالی', footer: 'نشانی: خیابان نمونه - تلفن: 000-00000000' },
    signer: { name: 'دکتر رضا محمدی', title: 'رئیس مرکز رشد' },
    objects: images
      ? [
          { id: 'o1', anchor: 'sign', mediaId: 'sig', aspect: 2, x: 36, dy: 0, w: 38 },
          { id: 'o2', anchor: 'page', page: 0, mediaId: 'logo', aspect: 1, x: 150, y: 150, w: 30 },
        ]
      : [],
  };

  // Every part the user can drag, somewhere else than its default place.
  if (moved) {
    letter.letterhead.parts = {
      invocation: { x: 20, y: 12 },
      org: { x: 75, y: 22 },
      number: { x: 150, y: 12 },
      date: { x: 150, y: 18, align: 'left' },
      attachment: { hidden: true },
      rule: { y: 37 },
    };
    letter.styles = { invocation: { size: 16 }, meta: { font: 'B Lotus' } };
    letter.geom = { top: 40 };
    letter.offsets = {
      recipient: { dx: -30, dy: 6 },
      subject: { dy: 8 },
      'table:0': { dx: -15, dy: 5 },
      closing: { dx: -40 },
      sign: { dx: 60, dy: -6 },
      cc: { dy: 10 },
    };
    letter.objects.push({ id: 't1', kind: 'text', anchor: 'page', page: 0, x: 25, y: 235, w: 60, text: 'کادر متن آزاد\nبا دو خط', border: true, style: { size: 12, align: 'center' } });
  }
  return letter;
}
