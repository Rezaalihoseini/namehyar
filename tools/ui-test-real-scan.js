// A real public scan with a supplied DOCX transcript; not an app-rendered page.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openPhone } from './cdp.js';
import { ocrMetrics } from './ocr-metrics.js';
const truth = readFileSync(resolve('ui-test-out/real-scans/truth.txt'), 'utf8');
const out = resolve(process.argv[2] || 'ui-test-out/real-scan-results');
mkdirSync(out,{recursive:true});
const page=await openPhone({port:9403});
let failed=false;
try {
  await page.goto('http://127.0.0.1:8770/app/src/main/assets/web/index.html');
  const results=await page.evaluate(`
    const {canvasOfImage,startEngine,turned,readPage}=await import('/app/src/main/assets/web/js/ocr.js');
    const source=await canvasOfImage('/ui-test-out/real-scans/sample_farsi.jpeg');
    const engine=await startEngine();const results=[];
    try { for(const variant of ['original','tilted','shadow']) {
      let canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
      canvas.getContext('2d').drawImage(source,0,0);
      if(variant==='tilted')canvas=turned(canvas,12*Math.PI/180);
      if(variant==='shadow') {
        const ctx=canvas.getContext('2d');const image=ctx.getImageData(0,0,canvas.width,canvas.height);
        for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++) {
          const k=.35+.5*x/canvas.width; const i=(y*canvas.width+x)*4;
          for(let channel=0;channel<3;channel++)image.data[i+channel]*=k;
        }
        ctx.putImageData(image,0,0);
      }
      const result=await readPage(engine,canvas,210,async()=>null);
      results.push({variant,text:result.words.map(w=>w.text).join(' '),confidence:result.confidence});
      result.page.width=0;
    } return results; } finally {engine.stop();}
  `);
  const limits={original:.15,tilted:.20,shadow:.15};
  for(const result of results) {
    Object.assign(result,ocrMetrics(truth,result.text));
    console.log(`${result.variant}: CER ${(result.cer*100).toFixed(2)}%, exact-word recall ${(result.wordRecall*100).toFixed(2)}%, engine confidence ${result.confidence}`);
    assert.ok(result.cer<=limits[result.variant],`${result.variant} CER exceeds ${limits[result.variant]*100}%`);
  }
  assert.deepEqual(page.errors,[]);
  writeFileSync(resolve(out,'metrics.json'),JSON.stringify(results,null,2));
  console.log('all real-scan acceptance checks passed (one source document, three conditions)');
} catch(error) {console.error(error);failed=true;} finally {await page.close();}
process.exitCode=failed?1:0;
