// Pictures of the home screen in each of its states, to judge the design by eye.
//   node tools/home-shots.js <out-folder> [name-prefix]      (needs the preview server on port 8770)
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openPhone } from './cdp.js';

const out = resolve(process.argv[2] || 'home-shots');
const prefix = process.argv[3] || '';
mkdirSync(out, { recursive: true });
const URL_APP = 'http://127.0.0.1:8770/app/src/main/assets/web/index.html';
const WEB = '/app/src/main/assets/web/js';

// Puts the app in a known state: which letters exist, which theme, and whether the letterhead was set up.
const scene = ({ letters, theme, setup = true, query = '', scroll = 0, filter = null, textSize = 100 }) => `
  document.documentElement.style.webkitTextSizeAdjust = '${textSize}%';
  const { app, setTheme } = await import('${WEB}/app.js');
  const { homeScreen } = await import('${WEB}/screens/home.js');
  const { newLetter } = await import('${WEB}/model.js');
  const now = Date.now();
  const day = 864e5;
  const make = (subject, name, ago, status, durationSec, words = '') => {
    const letter = newLetter(app.settings);
    const when = now - ago * day - 60000;
    return Object.assign(letter, {
      subject, status, durationSec,
      recipient: { name, title: '' },
      updatedAt: when, createdAt: when,
      body: [{ kind: 'p', role: 'body', runs: [{ text: words || 'با سلام و احترام، به استحضار می‌رساند ' + subject + ' طبق برنامه انجام شد.' }] }],
    });
  };
  const seed = [
    make('درخواست تمدید قرارداد استقرار واحد فناور', 'جناب آقای احمد کرمی', 0, 'draft', null),
    make('گزارش عملکرد ماهانهٔ واحدهای فناور', 'ریاست محترم پارک علم و فناوری', 0, 'done', 48),
    make('معرفی نمایندهٔ واحد فناور', 'مدیر محترم امور مالی', 1, 'done', 52),
    make('دعوت به جلسهٔ شورای مرکز رشد', 'اعضای محترم شورا', 3, 'done', 37),
    make('استعلام وضعیت بیمهٔ کارکنان', 'ادارهٔ کل تأمین اجتماعی', 5, 'draft', null),
    make('گواهی اشتغال به کار', 'جناب آقای علی رضایی', 20, 'done', 95),
    make('درخواست خرید تجهیزات آزمایشگاهی', 'معاونت محترم اداری و مالی', 41, 'done', 58),
    make('', '', 75, 'draft', null),
  ];
  app.letters = ${letters ? 'seed' : '[]'};
  app.settings.signer.name = ${setup ? "'رضا علی‌محمدی'" : "''"};
  app.settings.letterhead.org = ${setup ? "['مرکز نمونه']" : "['مرکز رشد']"};
  setTheme('${theme}');
  const searchBox = document.querySelector('#home input[type="search"]');
  searchBox.value = ${JSON.stringify(query)};
  homeScreen.show();
  ${filter ? `[...document.querySelectorAll('#home .filters .chip')].find((c) => c.textContent.includes(${JSON.stringify(filter)})).click();` : ''}
  document.querySelector('#home .scroll').scrollTop = ${scroll};
  await new Promise((r) => setTimeout(r, 900));
`;

const SHOTS = [
  { size: [360, 800], name: 'full-light', letters: true, theme: 'light' },
  { size: [360, 800], name: 'full-light-lower', letters: true, theme: 'light', scroll: 520 },
  { size: [360, 800], name: 'full-dark', letters: true, theme: 'dark' },
  { size: [360, 800], name: 'full-dark-lower', letters: true, theme: 'dark', scroll: 520 },
  { size: [360, 800], name: 'first-run-light', letters: false, theme: 'light', setup: false },
  { size: [360, 800], name: 'first-run-dark', letters: false, theme: 'dark', setup: false },
  { size: [360, 800], name: 'search-light', letters: true, theme: 'light', query: 'واحد فناور' },
  { size: [360, 800], name: 'search-none-dark', letters: true, theme: 'dark', query: 'کلمهٔ نایاب' },
  { size: [320, 640], name: 'small-light', letters: true, theme: 'light' },
  { size: [412, 915], name: 'big-light', letters: true, theme: 'light' },
  { size: [800, 1100], name: 'tablet-light', letters: true, theme: 'light' },
  { size: [360, 800], name: 'big-text-light', letters: true, theme: 'light', textSize: 130 },
];

let port = 9350;
for (const shot of SHOTS) {
  const page = await openPhone({ width: shot.size[0], height: shot.size[1], port: port++ });
  try {
    await page.goto(URL_APP);
    await page.sleep(1000);
    await page.evaluate(scene(shot));
    await page.screenshot(join(out, `${prefix}${shot.name}.png`));
    if (page.errors.length) console.log(`${shot.name}: script errors`, page.errors);
    const overflow = await page.evaluate(`const s = document.querySelector('#home .scroll'); return s.scrollWidth - s.clientWidth;`);
    if (overflow > 0) console.log(`${shot.name}: wider than the screen by ${overflow}px`);
  } finally {
    await page.close();
  }
}
console.log('written to', out);
