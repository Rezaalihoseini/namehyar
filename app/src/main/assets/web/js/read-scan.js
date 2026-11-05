// From a scan to a letter that can be edited: reads each page, builds the same letter a PDF with text gives, and keeps a list of the
// words worth a second look, each with where it stood on the scan.

import { app } from './app.js';
import { canvasOfImage, readPage, startEngine } from './ocr.js';
import { appWords, buildLexicon, clearWords, lookAt, modelWords } from './lexicon.js';
import { letterFromReadPages } from './import-pdf.js';
import { plainTextOf } from './model.js';
import { removePaper } from './image.js';
import { ensureMedia, mediaUrl, putMedia } from './store.js';
import { uid } from './util.js';

/** The pages were read, and there is nothing on them to make a letter of. */
export class NoWords extends Error {}

async function pictureOfCut(cut) {
  const made = await removePaper(cut.toDataURL('image/png'), { flat: true });
  return made.empty ? null : { url: made.dataUrl, aspect: made.aspect };
}

function picksToCheck(read, lexicon) {
  const picks = [];
  read.forEach((page, p) => {
    for (const word of page.words) {
      const text = word.text.trim();
      if (!text) continue;
      const { look, better } = lookAt(text, word.conf, lexicon, { fixed: word.fixed });
      if (!look) continue;
      const [x0, y0, x1, y1] = word.box;
      picks.push({ t: text, p, b: [x0 / page.width, y0 / page.height, x1 / page.width, y1 / page.height], ...(better && { s: better }) });
    }
  });
  // One row for the same words, which all change together.
  const seen = new Set();
  return picks.filter((pick) => !seen.has(pick.t) && seen.add(pick.t));
}

/**
 * @param scan a letter holding its pages as pictures
 * @returns a new letter with the words of those pictures
 */
export async function readScannedLetter(scan, settings, { onProgress } = {}) {
  const images = (scan.objects || []).filter((o) => o.kind === 'image' && o.behind).sort((a, b) => a.page - b.page);
  await ensureMedia(images.map((o) => o.mediaId));
  const widthMm = scan.page?.w || 210;
  const engine = await startEngine();
  const read = [];
  const stored = [];
  try {
    for (let i = 0; i < images.length; i++) {
      onProgress?.(i + 1, images.length);
      const source = await canvasOfImage(mediaUrl(images[i].mediaId));
      const page = await readPage(engine, source, widthMm, pictureOfCut);
      // A page that had to be turned is kept as it was read, so its words can be pointed at.
      if (page.page === source) stored.push(images[i].mediaId);
      else {
        const id = uid();
        await putMedia(id, page.page.toDataURL('image/jpeg', 0.85));
        stored.push(id);
      }
      page.page.width = 0;
      source.width = 0;
      delete page.page;
      read.push(page);
    }
  } finally {
    engine.stop();
  }
  if (!read.some((page) => page.words.length >= 5)) throw new NoWords();
  const letter = await letterFromReadPages(read, scan.page || null, settings);
  letter.sourceName = scan.sourceName;
  const clearly = clearWords(read.flatMap((page) => page.words));
  const earlier = (app.letters || []).slice(0, 100).map((l) => plainTextOf(l));
  const people = (app.recipients || []).flatMap((r) => [r.name, r.title]);
  const general = await modelWords().catch(() => []);
  const lexicon = buildLexicon([...appWords(), ...earlier, ...people, clearly.join(' ')], general);
  letter.ocr = { pages: stored, words: picksToCheck(read, lexicon), confidence: Math.round(read.reduce((sum, page) => sum + page.confidence, 0) / read.length) };
  return letter;
}
