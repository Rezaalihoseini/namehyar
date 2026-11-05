// A small driver for headless Chrome set up like a phone, with real touch input. Used by the UI tests in tools/.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHROME, CHROME_ARGS } from './browser.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openPhone({ width = 360, height = 800, port = 9334 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'nh-ui-'));
  const chrome = spawn(CHROME, [...CHROME_ARGS, '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

  let launchError = null;
  chrome.on('error', (error) => { launchError = error; });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    if (launchError) throw launchError;
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome did not start');

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const waiting = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  };

  const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y]) => ({ x, y })) });

  return {
    send,
    evaluate,
    sleep,
    errors,
    async goto(url) {
      await send('Page.navigate', { url });
      await sleep(600);
    },
    async screenshot(file) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
    },
    /** The centre of an element on the screen. */
    async centre(selector, index = 0) {
      const box = await evaluate(`const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };`);
      if (!box) throw new Error(`nothing on screen for ${selector}`);
      return box;
    },
    async tap(x, y) {
      await touch('touchStart', [[x, y]]);
      await sleep(40);
      await touch('touchEnd', []);
      await sleep(120);
    },
    async tapOn(selector, index = 0) {
      const c = await this.centre(selector, index);
      await this.tap(c.x, c.y);
    },
    /** A finger put down, optionally held still, moved in steps and lifted. */
    async drag(x0, y0, x1, y1, { hold = 0, steps = 8 } = {}) {
      await touch('touchStart', [[x0, y0]]);
      if (hold) await sleep(hold);
      for (let i = 1; i <= steps; i++) {
        await touch('touchMove', [[x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps]]);
        await sleep(16);
      }
      await touch('touchEnd', []);
      await sleep(200);
    },
    async close() {
      ws.close();
      chrome.kill();
      await sleep(400);
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
