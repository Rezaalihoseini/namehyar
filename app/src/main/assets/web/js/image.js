// Prepares pictures for a letter. removePaper turns a phone photo of a signature or stamp on white
// paper into a clean transparent PNG, following the paper's brightness across the photo so a shadow
// from the phone does not leave a grey patch.

import { readFileAsDataUrl, loadImage } from './util.js';

const MAX_SIDE = 1600;

function toCanvas(img, maxSide = MAX_SIDE) {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function hasTransparency(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

/** Reads a picked file, shrinks it to a sensible size and returns {dataUrl, aspect}. */
export async function importImage(file) {
  const img = await loadImage(await readFileAsDataUrl(file));
  const canvas = toCanvas(img);
  const ctx = canvas.getContext('2d');
  const png = hasTransparency(ctx, canvas.width, canvas.height);
  return {
    dataUrl: png ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92),
    aspect: canvas.width / canvas.height,
  };
}

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Brightness of the paper on a coarse grid: the near-brightest value in each cell. */
function paperGrid(d, w, h, cell) {
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const grid = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hist = new Uint32Array(256);
      let count = 0;
      for (let y = r * cell; y < Math.min(h, (r + 1) * cell); y += 2) {
        for (let x = c * cell; x < Math.min(w, (c + 1) * cell); x += 2) {
          hist[Math.round(lum(d, (y * w + x) * 4))]++;
          count++;
        }
      }
      let seen = 0;
      let v = 255;
      for (let b = 255; b >= 0; b--) {
        seen += hist[b];
        if (seen >= count * 0.1) {
          v = b;
          break;
        }
      }
      grid[r * cols + c] = v;
    }
  }
  return { grid, cols, rows };
}

/**
 * @param flat the whole picture has one paper, its brightest tenth. For a cut from a page, where a logo's own flat colour must not count as
 * paper; a photo of a signature on its own has uneven paper and needs the usual way.
 */
export async function removePaper(dataUrl, { flat = false } = {}) {
  const img = await loadImage(dataUrl);
  const canvas = toCanvas(img, 1400);
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data;
  const cell = Math.max(16, Math.round(Math.max(w, h) / 24));
  const { grid, cols, rows } = paperGrid(d, w, h, cell);
  let flatPaper = 0;
  if (flat) {
    const bins = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) bins[Math.round(lum(d, i))]++;
    let seen = 0;
    flatPaper = 255;
    while (flatPaper > 0 && seen + bins[flatPaper] < (w * h) / 10) seen += bins[flatPaper--];
  }

  const paperAt = (x, y) => {
    if (flat) return flatPaper;
    const fx = Math.min(cols - 1.001, Math.max(0, x / cell - 0.5));
    const fy = Math.min(rows - 1.001, Math.max(0, y / cell - 0.5));
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fy);
    const c1 = Math.min(cols - 1, c0 + 1);
    const r1 = Math.min(rows - 1, r0 + 1);
    const tx = fx - c0;
    const ty = fy - r0;
    const top = grid[r0 * cols + c0] * (1 - tx) + grid[r0 * cols + c1] * tx;
    const bottom = grid[r1 * cols + c0] * (1 - tx) + grid[r1 * cols + c1] * tx;
    return top * (1 - ty) + bottom * ty;
  };

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const paper = Math.max(1, paperAt(x, y));
      // Ink depth relative to the local paper: anything within 12% of the paper disappears.
      const depth = 1 - lum(d, i) / paper;
      const alpha = Math.min(1, Math.max(0, (depth - 0.12) / 0.33));
      if (alpha > 0) {
        // Remove the paper's tint so blue ink stays blue on any background.
        const a = Math.max(alpha, 0.01);
        const k = 255 / paper;
        for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.min(255, Math.max(0, (d[i + ch] * k - 255 * (1 - a)) / a));
      }
      d[i + 3] = Math.round(alpha * (d[i + 3] / 255) * 255);
      if (alpha > 0.2) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { dataUrl, aspect: w / h, empty: true };

  ctx.putImageData(data, 0, 0);
  const pad = Math.round(Math.max(w, h) * 0.01);
  const sx = Math.max(0, minX - pad);
  const sy = Math.max(0, minY - pad);
  const sw = Math.min(w, maxX + pad + 1) - sx;
  const sh = Math.min(h, maxY + pad + 1) - sy;
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return { dataUrl: out.toDataURL('image/png'), aspect: sw / sh };
}

/**
 * A new picture for a frame: it fills the frame without being stretched, as sharp as print needs, and inside the frame's own shape
 * and line when it has them, such as a round portrait with a ring.
 */
export async function pictureForFrame(file, { widthMm, aspect, outline }) {
  const source = await readFileAsDataUrl(file);
  const img = await loadImage(source);
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const sw = iw / ih > aspect ? ih * aspect : iw;
  const sh = sw / aspect;
  const width = Math.max(1, Math.round(Math.min(sw, (widthMm / 25.4) * 300, 3600)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(width / aspect));
  const ctx = canvas.getContext('2d');
  const kept = source.startsWith('data:image/png') && !outline;
  if (!kept) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const k = outline ? canvas.width / outline.pw : 1;
  const inFrame = () => ctx.setTransform(k, 0, 0, k, -outline.ox * k, -outline.oy * k);
  ctx.save();
  if (outline?.clip) {
    inFrame();
    ctx.clip(new Path2D(outline.clip));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
  ctx.restore();
  if (outline?.stroke) {
    inFrame();
    ctx.lineWidth = outline.w;
    ctx.strokeStyle = outline.color;
    ctx.stroke(new Path2D(outline.stroke));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  return kept ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92);
}

/** A hidden file input that returns the picked image file. */
export function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}
