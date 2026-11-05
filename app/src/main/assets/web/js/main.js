import { app, applyTheme, loadData, registerScreen, showScreen } from './app.js';
import { homeScreen } from './screens/home.js';
import { composeScreen } from './screens/compose.js';
import { pageScreen } from './screens/pageview.js';
import { settingsScreen } from './screens/settings.js';
import { loadCustomFonts } from './fonts.js';

// Every font is loaded up front: page layout measures real glyphs, so it must never see a fallback.
const FONT_FACES = [
  '400 14pt "B Nazanin"',
  '700 14pt "B Nazanin"',
  '700 14pt "B Titr"',
  '400 14pt "B Lotus"',
  '700 14pt "B Lotus"',
  '400 14pt "B Zar"',
  '700 14pt "B Zar"',
  '400 14pt "Vazirmatn"',
];

async function loadFonts() {
  await Promise.all(FONT_FACES.map((face) => document.fonts.load(face, 'سلام').catch(() => null)));
  await Promise.all(['400 14pt "Tinos"', '700 14pt "Tinos"'].map((face) => document.fonts.load(face, 'Abc').catch(() => null)));
}

async function boot() {
  await loadFonts();
  await loadData();
  applyTheme();
  await loadCustomFonts(app.settings);
  registerScreen('home', homeScreen);
  registerScreen('compose', composeScreen);
  registerScreen('page', pageScreen);
  registerScreen('settings', settingsScreen);
  document.execCommand('defaultParagraphSeparator', false, 'p');
  showScreen('home');
  window.__fileArrived();
}

window.__app = app;
if (!window.__oldWebView) boot();
