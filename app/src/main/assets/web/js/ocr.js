// Reads the words of a scanned letter or a photo of one, offline. The engine is Tesseract with its Persian model, carried in the app
// and run in a worker made on the spot, so the screen stays alive. A worker from a file needs a network request this app does not
// always get; one made from text does not. If even that fails, the engine runs on the page itself.
// What comes out is what a PDF with text gives: words with their places, lines, and the pictures that are not words.

import { fetchBytes, loadImage } from './util.js';

const BASE = new URL('../vendor/tesseract/', import.meta.url).href;

/* ---------- The engine ---------- */

/** Runs inside the worker too, so it may use nothing from outside itself. */
function makeEngine(Core) {
  let core = null;
  let api = null;
  return {
    async init({ wasm, model }) {
      core = await Core({ wasmBinary: new Uint8Array(wasm) });
      core.FS.writeFile('fas.traineddata', new Uint8Array(model));
      api = new core.TessBaseAPI();
      // 1: the line-reading part of the engine alone.
      if (api.Init(null, 'fas', 1)) throw new Error('the reading engine did not start');
      // Reading each doubtful line again as white on black costs time and gained nothing on letters.
      api.SetVariable('tessedit_do_invert', '0');
      return true;
    },
    /** @param mode 3: find the page's own blocks and columns. 7: all this picture is one line. */
    read({ png, mode = 3 }) {
      api.SetVariable('tessedit_pageseg_mode', String(mode));
      core.FS.writeFile('/input', new Uint8Array(png));
      api.SetImageFile(0, 0);
      api.Recognize(null);
      const { blocks } = JSON.parse(api.GetJSONText());
      const confidence = api.MeanTextConf();
      api.Clear();
      // Only what is needed: the engine also lists every letter of every word.
      const paragraphs = (blocks || []).flatMap((block) => (block.paragraphs || []).map((paragraph) => (paragraph.lines || []).map((line) => ({
        words: (line.words || []).map((word) => ({ text: word.text, conf: word.confidence, box: [word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1] })),
        box: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1],
        base: line.baseline ? (line.baseline.y0 + line.baseline.y1) / 2 : line.bbox.y1,
      }))));
      return { confidence, paragraphs };
    },
  };
}

const WORKER_SHELL = `
let engine = null;
self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    if (!engine) engine = (${makeEngine.toString()})(self.TesseractCore);
    self.postMessage({ id, ok: true, value: await engine[method](args) });
  } catch (err) {
    self.postMessage({ id, ok: false, value: String(err && err.message || err) });
  }
};`;

const simdWorks = () => {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch {
    return false;
  }
};

/** Starts the engine. Returns {call(method, args), stop()}. */
export async function startEngine() {
  const name = simdWorks() ? 'tesseract-core-simd-lstm' : 'tesseract-core-lstm';
  const script = await fetchBytes(`${BASE}${name}.js`);
  const wasm = await fetchBytes(`${BASE}${name}.wasm`);
  const model = await fetchBytes(`${BASE}fas.traineddata`);
  const scriptUrl = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
  try {
    return await startInWorker(script, wasm, model);
  } catch (err) {
    console.warn('no worker for the reading engine, running it on the page', err);
    await new Promise((done, fail) => {
      const tag = document.createElement('script');
      tag.src = scriptUrl;
      tag.onload = done;
      tag.onerror = fail;
      document.head.append(tag);
    });
    const engine = makeEngine(window.TesseractCore);
    await engine.init({ wasm, model });
    return { call: async (method, args) => engine[method](args), stop: () => {}, inPage: true };
  } finally {
    URL.revokeObjectURL(scriptUrl);
  }
}

function startInWorker(script, wasm, model) {
  const url = URL.createObjectURL(new Blob([script, WORKER_SHELL], { type: 'text/javascript' }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  const waiting = new Map();
  let next = 1;
  const fail = (message) => {
    for (const { no } of waiting.values()) no(new Error(message));
    waiting.clear();
  };
  worker.onmessage = ({ data: { id, ok, value } }) => {
    const pending = waiting.get(id);
    waiting.delete(id);
    if (ok) pending?.yes(value);
    else pending?.no(new Error(value));
  };
  worker.onerror = (e) => fail(e.message || 'the reading engine stopped');
  const call = (method, args, moved = []) => new Promise((yes, no) => {
    const id = next++;
    waiting.set(id, { yes, no });
    worker.postMessage({ id, method, args }, moved);
  });
  // Bytes are copied, not moved: if this worker fails, the page still needs them.
  return call('init', { wasm: wasm.slice(0), model: model.slice(0) }).then(() => ({ call, stop: () => worker.terminate() }), (err) => {
    worker.terminate();
    throw err;
  });
}

/* ---------- Pictures ---------- */

/** The page as it should be read: at a good size whatever it came in, black ink kept, coloured ink faded, the paper's own shade and shadows gone. */
export function cleanPage(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const image = canvas.getContext('2d').getImageData(0, 0, w, h);
  const d = image.data;
  const v = new Uint8ClampedArray(w * h);
  let colouredInk = 0;
  let blackInk = 0;
  for (let i = 0, j = 0; j < v.length; i += 4, j++) {
    const hi = Math.max(d[i], d[i + 1], d[i + 2]);
    const lo = Math.min(d[i], d[i + 1], d[i + 2]);
    v[j] = hi;
    if (lo < 130) {
      if (hi - lo > 60) colouredInk++;
      else blackInk++;
    }
  }
  // Stamps, pens and logos fade away and what lies under them shows, unless most of the ink is coloured: then the words themselves are.
  const fadeColour = colouredInk < blackInk * 1.2;
  // The paper: a high share of the brightest in each small cell, not the very top, so speckle does not count as paper.
  const cell = Math.max(8, Math.round(Math.max(w, h) / 64));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const paper = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const bins = new Uint32Array(32);
      let n = 0;
      for (let y = cy * cell; y < Math.min(h, (cy + 1) * cell); y += 2) {
        for (let x = cx * cell; x < Math.min(w, (cx + 1) * cell); x += 2) {
          bins[v[y * w + x] >> 3]++;
          n++;
        }
      }
      let seen = 0;
      let top = 31;
      for (let b = 31; b >= 0; b--) {
        seen += bins[b];
        if (seen >= n * 0.1) {
          top = b;
          break;
        }
      }
      paper[cy * cw + cx] = (top + 0.5) * 8;
    }
  }
  const paperAt = (x, y) => {
    const fx = Math.min(cw - 1, Math.max(0, x / cell - 0.5));
    const fy = Math.min(ch - 1, Math.max(0, y / cell - 0.5));
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const nextX = Math.min(cw - 1, ix + 1);
    const nextY = Math.min(ch - 1, iy + 1);
    const ax = fx - ix;
    const ay = fy - iy;
    return (paper[iy * cw + ix] * (1 - ax) + paper[iy * cw + nextX] * ax) * (1 - ay) + (paper[nextY * cw + ix] * (1 - ax) + paper[nextY * cw + nextX] * ax) * ay;
  };
  for (let y = 0, j = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, j++, i += 4) {
      const value = Math.min(255, (v[j] / Math.max(40, paperAt(x, y))) * 255);
      // The paper goes to pure white; ink stays as dark as it is.
      let shade = value >= 225 ? 255 : Math.max(0, (value - 30) * (255 / 195));
      if (fadeColour) {
        const colour = v[j] - Math.min(d[i], d[i + 1], d[i + 2]);
        if (colour > 30) shade += (255 - shade) * Math.min(1, (colour - 30) / 40);
      }
      d[i] = shade;
      d[i + 1] = shade;
      d[i + 2] = shade;
      d[i + 3] = 255;
    }
  }
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').putImageData(image, 0, 0);
  return out;
}

const pngOf = async (canvas) => (await new Promise((done) => canvas.toBlob(done, 'image/png'))).arrayBuffer();

/** A picture turned about its middle, on white. A quarter or half turn changes its shape. */
export function turned(canvas, radians) {
  const quarter = Math.abs(Math.abs(radians) - Math.PI / 2) < 0.01;
  const out = document.createElement('canvas');
  const c = Math.abs(Math.cos(radians));
  const s = Math.abs(Math.sin(radians));
  // Keep writing near the edges: rotating inside the old rectangle clips it.
  out.width = quarter ? canvas.height : Math.ceil(canvas.width * c + canvas.height * s - 1e-8);
  out.height = quarter ? canvas.width : Math.ceil(canvas.height * c + canvas.width * s - 1e-8);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(radians);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

/**
 * How far to turn a page so its lines lie level, in radians. Tried by sliding the rows of ink: at the right slant they pile up into sharp
 * lines with white between them. The engine's own figure was off by a quarter of a degree on pages that were straight.
 */
export function slantOf(clean) {
  const small = scaled(clean, Math.min(1, 700 / clean.width));
  const w = small.width;
  const h = small.height;
  const data = small.getContext('2d').getImageData(0, 0, w, h).data;
  const xs = [];
  const ys = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4] < 150) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < 200) return 0;
  const margin = Math.ceil(w * 0.3);
  const rows = new Int32Array(h + margin * 2);
  const score = (slope) => {
    rows.fill(0);
    for (let i = 0; i < xs.length; i++) {
      const at = Math.round(ys[i] + xs[i] * slope) + margin;
      if (at >= 0 && at < rows.length) rows[at]++;
    }
    let sum = 0;
    for (let y = 1; y < rows.length; y++) {
      const change = rows[y] - rows[y - 1];
      sum += change * change;
    }
    return sum;
  };
  const search = (from, to, step) => {
    let best = { slope: from, value: -1 };
    for (let slope = from; slope <= to + 1e-9; slope += step) {
      const value = score(slope);
      if (value > best.value) best = { slope, value };
    }
    return best;
  };
  const coarse = search(-0.27, 0.27, 0.004);
  const fine = search(coarse.slope - 0.004, coarse.slope + 0.004, 0.0005);
  // Sliding by this slope levels the rows: turning the page by it does the same.
  return score(0) * 1.02 < fine.value ? Math.atan(fine.slope) : 0;
}

/**
 * A photo often shows the desk around the page. Each side with a sharp step from dark to bright is cut there, so that sizes and margins
 * come out right. A shadow falls off gradually and has no such step, so it cuts nothing.
 */
function cutToPaper(canvas) {
  const small = scaled(canvas, 400 / canvas.width);
  const w = small.width;
  const h = small.height;
  const data = small.getContext('2d').getImageData(0, 0, w, h).data;
  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return Math.max(data[i], data[i + 1], data[i + 2]);
  };
  const bins = new Uint32Array(256);
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) bins[at(x, y)]++;
  const total = bins.reduce((sum, n) => sum + n, 0);
  let seen = 0;
  let paper = 255;
  while (paper > 0 && seen + bins[paper] < total * 0.3) seen += bins[paper--];
  const brightEnough = paper * 0.72;
  const stepAt = (length, across, read) => {
    // The share of a row (or column) that is bright, moving in from the edge: the first that is mostly bright is the paper's edge.
    const mean = (n) => {
      let sum = 0;
      for (let i = 0; i < across; i += 2) sum += read(n, i);
      return sum / Math.ceil(across / 2);
    };
    const share = (n) => {
      let bright = 0;
      for (let i = 0; i < across; i += 2) if (read(n, i) > brightEnough) bright++;
      return bright / Math.ceil(across / 2);
    };
    if (share(0) >= 0.5) return 0;
    for (let n = 1; n < length * 0.3; n++) {
      if (share(n) >= 0.5) return mean(Math.min(length - 1, n + 3)) - mean(Math.max(0, n - 4)) > paper * 0.18 ? n : 0;
    }
    return 0;
  };
  const left = stepAt(w, h, (n, i) => at(n, i));
  const right = stepAt(w, h, (n, i) => at(w - 1 - n, i));
  const top = stepAt(h, w, (n, i) => at(i, n));
  const bottom = stepAt(h, w, (n, i) => at(i, h - 1 - n));
  small.width = 0;
  if (!left && !right && !top && !bottom) return canvas;
  const k = canvas.width / 400;
  const margin = 2;
  const x0 = left ? Math.round((left + margin) * k) : 0;
  const y0 = top ? Math.round((top + margin) * k) : 0;
  const x1 = right ? Math.round((w - right - margin) * k) : canvas.width;
  const y1 = bottom ? Math.round((h - bottom - margin) * k) : canvas.height;
  const out = document.createElement('canvas');
  out.width = x1 - x0;
  out.height = y1 - y0;
  out.getContext('2d').drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  return out;
}

const scaled = (canvas, k) => {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * k));
  out.height = Math.max(1, Math.round(canvas.height * k));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
};

/** The largest a page is kept at for its pictures: 300 dots per inch on A4. */
const KEEPING_WIDTH = 2480;
/**
 * The size a page is cleaned, measured and read at, in pixels to a millimetre: about 180 dots per inch. The engine reads best at this size:
 * at 300 it passes over whole lines. Measured on three fonts as scans, copies and photos: 91% of words at 300 dots per inch, 96% at this one.
 */
const READING_PX_PER_MM = 7.1;

export async function canvasOfImage(url) {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  const k = Math.min(1, KEEPING_WIDTH / img.naturalWidth);
  canvas.width = Math.round(img.naturalWidth * k);
  canvas.height = Math.round(img.naturalHeight * k);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/* ---------- Words ---------- */

const HAS_LETTER = /[ء-ۓA-Za-z0-9۰-۹]/;

/** What the engine confuses in Persian, which nothing else can mean. */
export function fixWord(raw) {
  let word = raw
    .normalize('NFKC')
    .replace(/[\u200e\u200f]/g, '')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x660 + 0x6f0))
    // Marks that come from specks. An alef's tanvin is the one that belongs in a letter.
    .replace(/[ٌٍَُِّْ]/g, '')
    .replace(/([^ا])ً/g, '$1')
    // The small hamza of «نامهٔ» reads as a round te.
    .replace(/ة(?=$|[^ء-ۓ])/g, 'هٔ')
    .replace(/ـ+/g, '')
    .replace(/آا/g, 'ا')
    .replace(/([۰-۹0-9]),(?=[۰-۹0-9])/g, '$1٬')
    .replace(/^\u200c+|\u200c+$/g, '');
  // The labels at the head of a letter, which nothing else looks like.
  word = word.replace(/^(?:بیوست|پبوست|ببوست|پیبوست|پبیوست)(?=:|$)/, 'پیوست').replace(/^شمارم(?=:)/, 'شماره').replace(/^موضوغ(?=:)/, 'موضوع');
  // A Latin comma after a Persian word is the Persian one.
  word = word.replace(/([ء-ۓ]),$/, '$1،');
  // A comma beside a word reads as a stray hamza.
  word = word.replace(/([^اء.])\.?ء$/, '$1،');
  return word;
}

/** A closing quote with no opening one on its line is a comma that was misread. */
function fixLine(words, height) {
  // A word's box sometimes reaches over its neighbour, which would change the order of the words. The engine's own order is right.
  let rightToLeft = 0;
  for (let i = 1; i < words.length; i++) rightToLeft += words[i - 1].box[0] > words[i].box[0] ? 1 : -1;
  if (rightToLeft >= 0) {
    for (let i = 1; i < words.length; i++) {
      const before = words[i - 1].box;
      const box = words[i].box;
      if (before[0] <= box[0] && box[2] < before[2]) before[0] = box[2];
      else if (box[2] > before[0] && box[0] < before[0]) box[2] = before[0];
    }
  }
  // One word cut in two: both pieces carry the same doubt and all but touch.
  for (let i = words.length - 1; i > 0; i--) {
    const a = words[i - 1];
    const b = words[i];
    if (a.conf === b.conf && a.conf < 80 && a.box[0] - b.box[2] < height * 0.12 && /[ء-ۓ]$/.test(a.text) && /^[ء-ۓ]/.test(b.text)) {
      const glue = 'ادذرزژوآأإؤ'.includes(a.text[a.text.length - 1]) ? '' : '\u200c';
      a.text += glue + b.text;
      a.box = [Math.min(a.box[0], b.box[0]), Math.min(a.box[1], b.box[1]), Math.max(a.box[2], b.box[2]), Math.max(a.box[3], b.box[3])];
      a.mended = a.mended || b.mended;
      words.splice(i, 1);
    }
  }
  const whole = words.map((w) => w.text).join(' ');
  if (whole.includes('»') && !whole.includes('«')) for (const w of words) w.text = w.text.replace(/»/g, '،');
  if (whole.includes('«') && !whole.includes('»')) for (const w of words) w.text = w.text.replace(/«/g, '،');
  // A lone digit the engine doubts, between two words, is the «و» that so often looks like one.
  const isWord = (w) => w && /[ء-ۓ]{2}/.test(w.text);
  words.forEach((w, i) => {
    if (/^[0-9۰-۹]$/.test(w.text) && w.conf < 70 && isWord(words[i - 1]) && isWord(words[i + 1])) w.text = 'و';
  });
  return words;
}

/** A line the engine doubts throughout, or made only of scraps, is a logo or a stain and not words. So is a thin one, of dots from the line below. */
function isScrap(words, height) {
  const letters = words.reduce((sum, w) => sum + (w.text.match(HAS_LETTER) ? w.text.length : 0), 0);
  const mean = words.reduce((sum, w) => sum + w.conf, 0) / (words.length || 1);
  if (!letters) return true;
  if (mean < 45) return true;
  if (height < 0.5 && mean < 85) return true;
  return words.length > 1 && letters / words.length < 1.8 && mean < 70;
}

/* ---------- Lines drawn on the page ---------- */

/** Whether both sides of a line are empty for most of its length, as the sides of a ruled line are and those of a row of letters' feet are not. */
function quiet(line, outerCount, darkAt) {
  const sideIsEmpty = (outer) => {
    if (outer < 0 || outer >= outerCount) return true;
    let dark = 0;
    let seen = 0;
    for (let inner = line.a; inner <= line.b; inner += 2) {
      seen++;
      if (darkAt(outer, inner)) dark++;
    }
    return dark <= seen * 0.15;
  };
  return sideIsEmpty(line.first - 4) && sideIsEmpty(line.last + 4);
}

/** Long straight dark runs of a clean page, for tables and the rule under a letterhead. */
function findRules(clean, k) {
  const step = 1;
  const w = clean.width;
  const h = clean.height;
  const data = clean.getContext('2d').getImageData(0, 0, w, h).data;
  // A thin line is grey by the time the page is this size.
  const dark = (x, y) => data[(y * w + x) * 4] < 200;
  const shortest = 12 / (k * step);
  const thickest = 1.3 / (k * step);
  const rules = [];
  const collect = (outerCount, innerCount, darkAt, make) => {
    const open = [];
    for (let outer = 0; outer <= outerCount; outer++) {
      const runs = [];
      if (outer < outerCount) {
        let start = -1;
        let lastDark = -1;
        for (let inner = 0; inner <= innerCount; inner++) {
          const on = inner < innerCount && darkAt(outer, inner);
          if (on) {
            if (start < 0) start = inner;
            lastDark = inner;
          } else if (start >= 0 && inner - lastDark > 2) {
            if (lastDark - start >= shortest) runs.push([start, lastDark]);
            start = -1;
          }
        }
      }
      // Runs in neighbouring rows are one line.
      for (let i = open.length - 1; i >= 0; i--) {
        const line = open[i];
        const match = runs.findIndex(([a, b]) => Math.min(b, line.b) - Math.max(a, line.a) > (line.b - line.a) * 0.5);
        if (match >= 0) {
          const [a, b] = runs.splice(match, 1)[0];
          line.a = Math.min(line.a, a);
          line.b = Math.max(line.b, b);
          line.last = outer;
        } else if (outer - line.last > 1) {
          open.splice(i, 1);
          if (line.last - line.first + 1 <= thickest && quiet(line, outerCount, darkAt)) rules.push(make(line));
        }
      }
      for (const [a, b] of runs) open.push({ a, b, first: outer, last: outer });
    }
  };
  const mm = k * step;
  collect(h, w, (y, x) => dark(x, y), (l) => ({ kind: 'h', y: ((l.first + l.last + 1) / 2) * mm, x0: l.a * mm, x1: (l.b + 1) * mm, t: (l.last - l.first + 1) * mm }));
  collect(w, h, (x, y) => dark(x, y), (l) => ({ kind: 'v', x: ((l.first + l.last + 1) / 2) * mm, y0: l.a * mm, y1: (l.b + 1) * mm, t: (l.last - l.first + 1) * mm }));
  return rules;
}

/**
 * Takes off the page to be read what is not words: long ruled lines, and shapes far taller than any letter: logos, signatures, stamps with
 * whatever their ring holds. A tall shape on a line makes the engine shrink that whole line to fit it, and the words beside it are lost.
 */
function clearForReading(clean, rules, k) {
  const ctx = clean.getContext('2d');
  ctx.fillStyle = '#fff';
  for (const r of rules) {
    const pad = r.t / k / 2 + 2;
    if (r.kind === 'h' && r.x1 - r.x0 >= 20) ctx.fillRect(r.x0 / k - 2, r.y / k - pad, (r.x1 - r.x0) / k + 4, pad * 2);
    if (r.kind === 'v' && r.y1 - r.y0 >= 20) ctx.fillRect(r.x / k - pad, r.y0 / k - 2, pad * 2, (r.y1 - r.y0) / k + 4);
  }
  const step = 2;
  const small = scaled(clean, 1 / step);
  const w = small.width;
  const h = small.height;
  const data = small.getContext('2d').getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(w * h);
  for (let j = 0; j < ink.length; j++) ink[j] = data[j * 4] < 150 ? 1 : 0;
  const tall = 12 / (k * step);
  const widest = 70 / (k * step);
  const paint = (x, y) => ctx.fillRect((x - 1) * step, (y - 1) * step, step * 3, step * 3);
  for (let start = 0; start < ink.length; start++) {
    if (ink[start] !== 1) continue;
    const cells = [start];
    ink[start] = 2;
    let [x0, y0, x1, y1] = [w, h, -1, -1];
    for (let n = 0; n < cells.length; n++) {
      const at = cells[n];
      const x = at % w;
      const y = (at - x) / w;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const other = (y + dy) * w + x + dx;
          if (x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h && ink[other] === 1) {
            ink[other] = 2;
            cells.push(other);
          }
        }
      }
    }
    if (x1 - x0 + 1 < tall || y1 - y0 + 1 < tall) continue;
    for (const at of cells) paint(at % w, Math.floor(at / w));
    if (x1 - x0 + 1 > widest || y1 - y0 + 1 > widest) continue;
    // Whatever the shape closes in: the words in a stamp's ring.
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const open = new Uint8Array(bw * bh);
    for (const at of cells) open[(Math.floor(at / w) - y0) * bw + (at % w) - x0] = 1;
    const queue = [];
    const reach = (x, y) => {
      if (x >= 0 && y >= 0 && x < bw && y < bh && !open[y * bw + x]) {
        open[y * bw + x] = 2;
        queue.push(y * bw + x);
      }
    };
    for (let x = 0; x < bw; x++) {
      reach(x, 0);
      reach(x, bh - 1);
    }
    for (let y = 0; y < bh; y++) {
      reach(0, y);
      reach(bw - 1, y);
    }
    while (queue.length) {
      const at = queue.pop();
      const x = at % bw;
      const y = (at - x) / bw;
      reach(x - 1, y);
      reach(x + 1, y);
      reach(x, y - 1);
      reach(x, y + 1);
    }
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (!open[y * bw + x]) paint(x + x0, y + y0);
  }
}

/** Ink no word covers, in the shape of a line of text. The engine now and then passes over a whole line that it reads well on its own. Boxes in picture pixels. */
function linesPassedOver(clean, wordBoxes, k) {
  const cell = 2;
  const small = scaled(clean, 1 / cell);
  const w = small.width;
  const h = small.height;
  const data = small.getContext('2d').getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(w * h);
  for (let j = 0; j < ink.length; j++) ink[j] = data[j * 4] < 140 ? 1 : 0;
  for (const [x0, y0, x1, y1] of wordBoxes) {
    for (let y = Math.max(0, Math.floor(y0 / cell) - 1); y <= Math.min(h - 1, Math.ceil(y1 / cell) + 1); y++) {
      for (let x = Math.max(0, Math.floor(x0 / cell) - 1); x <= Math.min(w - 1, Math.ceil(x1 / cell) + 1); x++) ink[y * w + x] = 0;
    }
  }
  const mm = k * cell;
  const across = Math.round(7 / mm);
  const boxes = [];
  for (let start = 0; start < ink.length; start++) {
    if (ink[start] !== 1) continue;
    const queue = [start];
    ink[start] = 2;
    let [x0, y0, x1, y1] = [w, h, -1, -1];
    let count = 0;
    while (queue.length) {
      const at = queue.pop();
      const x = at % w;
      const y = (at - x) / w;
      count++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -across; dx <= across; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const other = ny * w + nx;
          if (ink[other] === 1) {
            ink[other] = 2;
            queue.push(other);
          }
        }
      }
    }
    const width = (x1 - x0 + 1) * mm;
    const height = (y1 - y0 + 1) * mm;
    if (width >= 6 && height >= 2 && height <= 14 && count >= 25) boxes.push([x0 * cell, y0 * cell, (x1 + 1) * cell, (y1 + 1) * cell]);
  }
  return boxes;
}

/* ---------- Pictures on the page: logos, signatures, stamps ---------- */

/** Whatever ink is left once the words and lines are taken away, in groups big enough to be something. Boxes are in picture pixels. */
function findPictureBoxes(source, wordBoxes, rules, k) {
  const cell = 6;
  const w = Math.ceil(source.width / cell);
  const h = Math.ceil(source.height / cell);
  const small = scaled(source, 1 / cell);
  const data = small.getContext('2d').getImageData(0, 0, small.width, small.height).data;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < small.height; y++) {
    for (let x = 0; x < small.width; x++) {
      const i = (y * small.width + x) * 4;
      const hi = Math.max(data[i], data[i + 1], data[i + 2]);
      const lo = Math.min(data[i], data[i + 1], data[i + 2]);
      if (hi - lo > 50) ink[y * w + x] = 2;
      else if (lo < 120) ink[y * w + x] = 1;
    }
  }
  const clear = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, Math.floor(y0 / cell) - 1); y <= Math.min(h - 1, Math.ceil(y1 / cell) + 1); y++) {
      for (let x = Math.max(0, Math.floor(x0 / cell) - 1); x <= Math.min(w - 1, Math.ceil(x1 / cell) + 1); x++) if (ink[y * w + x] === 1) ink[y * w + x] = 0;
    }
  };
  for (const [x0, y0, x1, y1] of wordBoxes) clear(x0, y0, x1, y1);
  for (const r of rules) {
    if (r.kind === 'h') clear(r.x0 / k, (r.y - r.t) / k, r.x1 / k, (r.y + r.t) / k);
    else clear((r.x - r.t) / k, r.y0 / k, (r.x + r.t) / k, r.y1 / k);
  }
  // Pieces close together make one group: a stamp's ring and its words, the strokes of a signature.
  const seen = new Uint8Array(w * h);
  const reach = 4;
  const boxes = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen[start]) continue;
    const queue = [start];
    seen[start] = 1;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
    let count = 0;
    let coloured = 0;
    while (queue.length) {
      const at = queue.pop();
      const x = at % w;
      const y = (at - x) / w;
      count++;
      if (ink[at] === 2) coloured++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const other = ny * w + nx;
          if (ink[other] && !seen[other]) {
            seen[other] = 1;
            queue.push(other);
          }
        }
      }
    }
    const widthMm = (x1 - x0 + 1) * cell * k;
    const heightMm = (y1 - y0 + 1) * cell * k;
    if (widthMm >= 9 && heightMm >= 6 && count >= 40 && widthMm < 190) boxes.push({ box: [x0 * cell, y0 * cell, (x1 + 1) * cell, (y1 + 1) * cell], coloured: coloured > count * 0.6 });
  }
  // A ring inside a ring is one stamp.
  for (let i = boxes.length - 1; i >= 0; i--) {
    const [x0, y0, x1, y1] = boxes[i].box;
    const outer = boxes.find((other, n) => n !== i && other.box[0] <= x1 && x0 <= other.box[2] && other.box[1] <= y1 && y0 <= other.box[3]);
    if (!outer) continue;
    const b = outer.box;
    outer.box = [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)];
    boxes.splice(i, 1);
  }
  return boxes;
}

/* ---------- One page ---------- */

const MM_PER_PT = 25.4 / 72;
/** A word's ink is a little narrower than the room the font gives it. Measured on letters of known sizes. */
const INK_TO_WIDTH = 1.02;
/** Strokes thicker than the page's usual by this much make a line bold. Measured on letters in three fonts, as scans, copies and photos. */
const BOLD_STROKE = 1.25;

// Scan contrast and font families change the gap between regular and bold.
// Use a distinct heavier cluster when there is evidence for one, otherwise
// retain the conservative ratio (a uniformly heavy page is not all bold).
export function boldLines(inks) {
  const usual = median(inks.map((ink) => ink.weight));
  const heavy = inks.map((ink) => ink.weight).filter((weight) => weight > usual * 1.15);
  const threshold = heavy.length >= 2 && heavy.length < inks.length / 2
    ? Math.min(usual * BOLD_STROKE, (usual + median(heavy)) / 2)
    : usual * BOLD_STROKE;
  return inks.map((ink) => ink.weight > threshold);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] || 0;
};

/**
 * What a line's own ink says: how thick its strokes are, and where its foot lies, the row that most of the ink rests on.
 */
function inkOfLines(clean, lines) {
  const ctx = clean.getContext('2d', { willReadFrequently: true });
  return lines.map((line) => {
    let runs = 0;
    let dark = 0;
    let box = null;
    const rows = new Map();
    for (const word of line.words) {
      const [x0, y0, x1, y1] = word.box.map(Math.round);
      const w = x1 - x0;
      const h = y1 - y0;
      if (w < 3 || h < 3) continue;
      box = box || word;
      const data = ctx.getImageData(x0, y0, w, h).data;
      const at = (x, y) => data[(y * w + x) * 4] < 128;
      for (let y = 0; y < h; y++) {
        let inside = false;
        let count = 0;
        for (let x = 0; x < w; x++) {
          const on = at(x, y);
          if (on) count++;
          if (on && !inside) runs++;
          inside = on;
        }
        dark += count;
        rows.set(y0 + y, (rows.get(y0 + y) || 0) + count);
      }
      for (let x = 0; x < w; x++) {
        let inside = false;
        for (let y = 0; y < h; y++) {
          const on = at(x, y);
          if (on) dark++;
          if (on && !inside) runs++;
          inside = on;
        }
      }
    }
    let foot = line.base;
    let most = 0;
    for (const [y, count] of rows) {
      if (count > most) {
        most = count;
        foot = y + 1;
      }
    }
    return { weight: runs ? dark / runs : 0, foot };
  });
}

/** How large B Nazanin must be for a line's words to be as wide as they are on the page, whatever font they are in. */
function sizeFromWidths(line, bold, scale) {
  const ruler = sizeFromWidths.ruler || (sizeFromWidths.ruler = document.createElement('canvas').getContext('2d'));
  ruler.font = `${bold ? 'bold ' : ''}100px "B Nazanin","Tinos","Vazirmatn",serif`;
  const sizes = line.words.filter((w) => w.text.length >= 4 && !/[0-9۰-۹]/.test(w.text)).map((w) => ((w.box[2] - w.box[0]) * scale) / ((ruler.measureText(w.text).width / 100) * MM_PER_PT));
  return sizes.length ? median(sizes) * INK_TO_WIDTH : 0;
}

/** The paragraphs of a run of lines: a line that stops short ends one, and so does a wider gap. */
function paragraphsOfLines(lines) {
  if (!lines.length) return [];
  const left = Math.min(...lines.map((l) => l.box[0]));
  const right = Math.max(...lines.map((l) => l.box[2]));
  const gaps = lines.slice(1).map((l, i) => l.base - lines[i].base);
  const usual = median(gaps);
  const out = [];
  let open = [];
  lines.forEach((line, i) => {
    open.push(line.words.map((w) => w.text).join(' '));
    const short = line.box[0] - left > (right - left) * 0.12;
    const apart = i < gaps.length && gaps[i] > usual * 1.5;
    if (short || apart || i === lines.length - 1) {
      out.push(open.join(' '));
      open = [];
    }
  });
  return out;
}

const standsOnEnd = ([x0, y0, x1, y1]) => y1 - y0 > (x1 - x0) * 1.5;

/** Whether most lines of the engine's answer stand on end. */
function lyingOnItsSide({ paragraphs }) {
  const lines = paragraphs.flat().filter((line) => line.words.length >= 2);
  return lines.filter((line) => standsOnEnd(line.box)).length > lines.length / 2;
}

/** Puts a line found later where it belongs in the reading order: among the lines it stands between, or before the block below it. */
function insertLine(paragraphs, line) {
  for (const lines of paragraphs) {
    for (let i = 0; i + 1 < lines.length; i++) {
      if (lines[i].base < line.base && line.base < lines[i + 1].base && lines[i].box[0] < line.box[2] && line.box[0] < lines[i].box[2]) {
        lines.splice(i + 1, 0, line);
        return;
      }
    }
  }
  const after = paragraphs.findIndex((lines) => lines[0] && lines[0].base > line.base);
  if (after < 0) paragraphs.push([line]);
  else paragraphs.splice(after, 0, [line]);
}

/**
 * Reads one page.
 * @param whole a canvas of the page, perhaps with some of the desk around it
 * @param widthMm how wide the page is on paper
 * @param makePicture turns a cut of the page (a canvas) into {url, aspect}, for logos, signatures and stamps
 */
export async function readPage(engine, whole, widthMm, makePicture) {
  const source = cutToPaper(whole);
  let page = source;
  const cleanOf = (canvas) => {
    const small = scaled(canvas, Math.min(2, (widthMm * READING_PX_PER_MM) / canvas.width));
    const done = cleanPage(small);
    small.width = 0;
    return done;
  };
  let clean = cleanOf(page);
  let rules = [];
  const mmPerPixel = () => widthMm / clean.width;

  // Straight first, then what is not words comes off, then the words are read.
  const readNow = async () => {
    const angle = slantOf(clean);
    if (Math.abs(angle) >= 0.0015) {
      page = turned(page, angle);
      clean = turned(clean, angle);
    }
    rules = findRules(clean, mmPerPixel());
    clearForReading(clean, rules, mmPerPixel());
    return engine.call('read', { png: await pngOf(clean), mode: 3 });
  };
  let answer = await readNow();

  // A page upside down reads as nonsense, which shows. One lying on its side the engine reads well, as lines standing on end.
  const onItsSide = lyingOnItsSide(answer);
  if (answer.confidence < 55 || onItsSide) {
    let best = { confidence: onItsSide ? -1 : answer.confidence + 12, turn: 0 };
    for (const turn of onItsSide ? [Math.PI / 2, -Math.PI / 2] : [Math.PI, Math.PI / 2, -Math.PI / 2]) {
      const trial = await engine.call('read', { png: await pngOf(scaled(turned(clean, turn), 0.8)), mode: 3 });
      if (trial.confidence > best.confidence) best = { confidence: trial.confidence, turn };
    }
    if (best.turn) {
      page = turned(source, best.turn);
      clean = cleanOf(page);
      answer = await readNow();
    }
  }

  const scale = mmPerPixel();
  // Another look at what was passed over, each on its own.
  const covered = answer.paragraphs.flat().flatMap((l) => l.words.map((w) => w.box));
  for (const [x0, y0, x1, y1] of linesPassedOver(clean, covered, scale)) {
    const pad = 8;
    const left = Math.max(0, x0 - pad);
    const top = Math.max(0, y0 - pad);
    const cut = document.createElement('canvas');
    cut.width = Math.min(clean.width, x1 + pad) - left;
    cut.height = Math.min(clean.height, y1 + pad) - top;
    const ctx = cut.getContext('2d');
    ctx.drawImage(clean, left, top, cut.width, cut.height, 0, 0, cut.width, cut.height);
    // At one size the engine may give no answer at all for what it reads well at another.
    for (const zoom of [1, 0.7, 1.4, 0.5]) {
      const again = await engine.call('read', { png: await pngOf(zoom === 1 ? cut : scaled(cut, zoom)), mode: 7 });
      const found = again.paragraphs.flat().filter((line) => {
        const mean = line.words.reduce((sum, w) => sum + w.conf, 0) / (line.words.length || 1);
        return mean >= 50 && line.words.some((w) => /[ء-ۓ۰-۹0-9]{2}/.test(w.text));
      });
      for (const line of found) {
        const moved = ([a, b, c, d]) => [a / zoom + left, b / zoom + top, c / zoom + left, d / zoom + top];
        insertLine(answer.paragraphs, { words: line.words.map((w) => ({ ...w, box: moved(w.box) })), box: moved(line.box), base: line.base / zoom + top });
      }
      if (found.length) break;
    }
  }
  const heights = answer.paragraphs.flat().map((l) => l.box[3] - l.box[1]);
  const usualHeight = median(heights);
  const paragraphs = answer.paragraphs.map((lines) => lines.map((line) => {
    const height = line.box[3] - line.box[1];
    const words = fixLine(line.words.map((w) => ({ ...w, text: fixWord(w.text), mended: /ة(?=$|[^ء-ۓ])/.test(w.text) })).filter((w) => w.text.trim() && (HAS_LETTER.test(w.text) || w.conf >= 60)), height);
    // A line standing on end on an upright page is writing up a margin or in a stamp: it stays as ink, with the pictures.
    const onEnd = standsOnEnd(line.box) && height > usualHeight * 2;
    return words.length && !onEnd && !isScrap(words, height / usualHeight) ? { ...line, words } : null;
  }).filter(Boolean)).filter((lines) => lines.length);
  const lines = paragraphs.flat();

  await Promise.all([document.fonts.load('100px "B Nazanin"', 'سلام'), document.fonts.load('bold 100px "B Nazanin"', 'سلام')]).catch(() => {});
  const inks = inkOfLines(clean, lines);
  const bolds = boldLines(inks);
  const sizes = lines.map((line, n) => sizeFromWidths(line, bolds[n], scale));
  // Lines near the usual size are that size.
  const mainSize = median(sizes.filter(Boolean)) || 14;
  const items = [];
  const words = [];
  const wordBoxes = [];
  lines.forEach((line, n) => {
    const own = sizes[n] || mainSize;
    // A short line has few words to measure by, so it takes more to set it apart.
    const near = line.words.length >= 6 ? 0.12 : 0.3;
    const size = Math.max(7, Math.round(Math.abs(own - mainSize) < mainSize * near ? mainSize : own));
    const foot = inks[n].foot;
    line.base = foot;
    for (const w of line.words) {
      const [x0, , x1] = w.box;
      wordBoxes.push(w.box);
      // Each word carries its own space: where one stands in a line, the next is another word, however close.
      items.push({ text: `${w.text} `, x: x0 * scale, y: foot * scale, w: (x1 - x0) * scale, size, bold: bolds[n], font: 'B Nazanin', rawFont: 'read', shaped: false, told: false, head: w.text[0], tail: w.text[w.text.length - 1] });
      words.push({ text: w.text, conf: w.conf, box: w.box, ...(w.mended && { fixed: true }) });
    }
  });

  // Pictures come from the sharp page, not the small one.
  const toPage = page.width / clean.width;
  const pageScale = scale / toPage;
  const pictures = [];
  for (const { box: [x0, y0, x1, y1], coloured } of findPictureBoxes(page, wordBoxes.map((box) => box.map((v) => v * toPage)), rules, pageScale)) {
    const cut = document.createElement('canvas');
    cut.width = x1 - x0;
    cut.height = y1 - y0;
    const ctx = cut.getContext('2d');
    ctx.drawImage(page, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    // A stamp on top of words takes none of those words with it: they are in the letter already.
    if (coloured) {
      const image = ctx.getImageData(0, 0, cut.width, cut.height);
      const d = image.data;
      for (let i = 0; i < d.length; i += 4) {
        const hi = Math.max(d[i], d[i + 1], d[i + 2]);
        const lo = Math.min(d[i], d[i + 1], d[i + 2]);
        if (hi - lo < 40) d[i] = d[i + 1] = d[i + 2] = 255;
      }
      ctx.putImageData(image, 0, 0);
    }
    const made = await makePicture(cut);
    if (made) pictures.push({ x: x0 * pageScale, y: y0 * pageScale, w: (x1 - x0) * pageScale, h: ((x1 - x0) * pageScale) / made.aspect, url: made.url, source: null });
  }
  const size = median(items.map((it) => it.size));
  const { width, height } = clean;
  clean.width = 0;
  return { items, rules, fills: [], pictures, paragraphs: paragraphs.flatMap(paragraphsOfLines), words, confidence: answer.confidence, size, width, height, page };
}
