// Compares two renders of a page pixel by pixel, in Chrome, and writes what differs as a picture: red is ink only in the first
// (the source), blue is ink only in the second. A pixel counts as the same when something like it stands within a pixel or so,
// because two PDF renderers never smooth letters quite alike.
//   node tools/pixel-compare.js a.png b.png diff.png [reach]
import { readFileSync, writeFileSync } from 'node:fs';
import { openPhone } from './cdp.js';

const [fileA, fileB, out, reachArg] = process.argv.slice(2);
const reach = Number(reachArg || 1);
const url = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
const page = await openPhone({ port: 9371 });
try {
  await page.goto('about:blank');
  const result = await page.evaluate(`
    const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const [a, b] = await Promise.all([load(${JSON.stringify(url(fileA))}), load(${JSON.stringify(url(fileB))})]);
    const W = a.width, H = a.height;
    const pixelsOf = (img) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
      x.drawImage(img, 0, 0, W, H);
      return x.getImageData(0, 0, W, H).data;
    };
    const A = pixelsOf(a), B = pixelsOf(b);
    const reach = ${reach};
    const near = (P, Q, x, y) => {
      const i = (y * W + x) * 4;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const j = (Y * W + X) * 4;
          if (Math.abs(P[i] - Q[j]) + Math.abs(P[i + 1] - Q[j + 1]) + Math.abs(P[i + 2] - Q[j + 2]) < 150) return true;
        }
      }
      return false;
    };
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const out = ctx.createImageData(W, H);
    let ink = 0, onlyA = 0, onlyB = 0, inkB = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const darkA = A[i] + A[i + 1] + A[i + 2] < 600;
        const darkB = B[i] + B[i + 1] + B[i + 2] < 600;
        if (darkA) ink++;
        if (darkB) inkB++;
        const gray = 255 - (255 - (A[i] + A[i + 1] + A[i + 2]) / 3) * 0.25;
        let r = gray, g = gray, bl = gray;
        if (darkA && !near(A, B, x, y)) { onlyA++; r = 230; g = 30; bl = 30; }
        else if (darkB && !near(B, A, x, y)) { onlyB++; r = 30; g = 60; bl = 230; }
        out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = bl; out.data[i + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    return { W, H, sizeB: [b.width, b.height], ink, inkB, onlyA, onlyB, missing: +(100 * onlyA / (ink || 1)).toFixed(2), extra: +(100 * onlyB / (inkB || 1)).toFixed(2), png: c.toDataURL('image/png').split(',')[1] };
  `);
  writeFileSync(out, Buffer.from(result.png, 'base64'));
  const { png, ...numbers } = result;
  console.log(JSON.stringify(numbers));
} finally {
  await page.close();
}
