// Prints a page to PDF with headless Chrome once the page says it is ready (its title starts with "pages:").
//   node tools/chrome-pdf.js <url> <out.pdf>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out] = process.argv.slice(2);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'nh-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error('Chrome did not start');
}

try {
  const ws = new WebSocket(await connect());
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg.result);
      waiting.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Page.navigate', { url });
  let title = '';
  for (let i = 0; i < 80 && !title.startsWith('pages:'); i++) {
    await sleep(250);
    const res = await send('Runtime.evaluate', { expression: 'document.title' });
    title = res?.result?.value || '';
  }
  if (!title.startsWith('pages:')) throw new Error(`page never became ready, title: ${title}`);
  const pdf = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  writeFileSync(out, Buffer.from(pdf.data, 'base64'));
  console.log(`${title}, wrote ${out}`);
  ws.close();
} finally {
  chrome.kill();
  await sleep(400);
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
