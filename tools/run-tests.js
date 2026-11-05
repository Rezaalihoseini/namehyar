// Runs every self-contained JS suite, owns its server, and retains each exit status.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleLetter } from './sample-letter.js';
import { buildDocx } from '../app/src/main/assets/web/js/export-docx.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.TEST_OUTPUT_DIR || 'ui-test-out/suite');
mkdirSync(out, { recursive: true });
let server;
async function ready() {
  try { const r = await fetch('http://127.0.0.1:8770/app/src/main/assets/web/index.html'); return r.ok && (await r.text()).includes('js/main.js'); } catch { return false; }
}
const all = ['table-edit-test.js', 'draft-journal-test.js', 'editor-state-test.js', ...readdirSync(resolve(root, 'tools')).filter((f) => /^ui-test(?:-.*)?\.js$/.test(f)).sort(), 'free-test.js'];
const suites = process.argv.length > 2 ? process.argv.slice(2) : all;
if (suites.some((s) => !all.includes(s))) throw new Error('Unknown test suite');
const results = [];
try {
  if (suites.includes('ui-test-real-scan.js')) execFileSync('python3', [resolve(root, 'tools/fetch-scan-fixtures.py')], {stdio:'inherit'});
  if (!(await ready())) {
    const fd = openSync(resolve(out, 'server.log'), 'w');
    server = spawn('python3', ['-m', 'http.server', '8770', '--bind', '127.0.0.1', '--directory', root], { stdio: ['ignore', fd, fd] });
    closeSync(fd);
    server.on('error', (error) => console.error(error));
    for (let i = 0; i < 50 && !(await ready()); i++) await new Promise((r) => setTimeout(r, 100));
    if (!(await ready())) throw new Error('Test HTTP server did not become ready');
  }
  for (const suite of suites) {
    const log = resolve(out, suite + '.log');
    const fd = openSync(log, 'w');
    console.log(`RUN ${suite}`);
    const start = Date.now();
    const args = [resolve(root, 'tools', suite), resolve(out, suite.replace('.js', ''))];
    if (suite === 'ui-test-more.js') {
      // Exercise the optional Word import/edit branch on every complete run.
      const letter = sampleLetter();
      letter.body[0].runs.unshift({ text: 'مرکز رشد واحدهای فناور: ' });
      letter.body[0].indent = { first: 6 };
      const fixture = resolve(out, 'word-import-fixture.docx');
      writeFileSync(fixture, buildDocx(letter, () => null, {pageCount:1, pageAnchors:[0]}));
      args.push(fixture);
    }
    const child = spawn(process.execPath, args, {
      cwd: root, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      else child.kill();
    }, 15 * 60 * 1000);
    const outcome = await new Promise((done) => {
      child.on('error', (error) => done({ code: null, error: error.message }));
      child.on('exit', (code, signal) => done({ code, signal }));
    });
    clearTimeout(timer);
    results.push({ suite, ...outcome, timedOut, seconds: Math.round((Date.now() - start) / 1000), log });
    console.log(`${outcome.code === 0 && !timedOut ? 'PASS' : 'FAIL'} ${suite} (${results.at(-1).seconds}s)`);
    writeFileSync(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
  }
} finally { server?.kill(); }
console.log(`${results.filter((r) => r.code === 0 && !r.timedOut).length}/${results.length} suites passed`);
process.exitCode = results.some((r) => r.code !== 0 || r.timedOut) ? 1 : 0;
