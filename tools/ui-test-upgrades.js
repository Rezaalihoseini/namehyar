// Recovery before debounce, ready-made forms, accessibility and scan preparation.
import assert from 'node:assert/strict';
import { openPhone } from './cdp.js';
const page = await openPhone({ port: 9399 });
const APP = 'http://127.0.0.1:8770/app/src/main/assets/web/index.html';
const WEB = '/app/src/main/assets/web/js';
let failed = false;
try {
  await page.goto(APP);
  await page.sleep(800);
  const first = await page.evaluate(`
    const { app, showScreen } = await import('${WEB}/app.js');
    const { newLetter } = await import('${WEB}/model.js');
    app.letter = newLetter(app.settings);
    app.letter.id = 'recovery-upgrade';
    showScreen('compose', {fresh:false});
    await new Promise(r => setTimeout(r, 100));
    const editor = document.querySelector('#compose .editor');
    editor.innerHTML = '<p>آخرین واژه پیش از بسته شدن ناگهانی</p>';
    editor.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText'}));
    return { body: app.letter.body, journal: JSON.parse(localStorage.getItem('namehyar-draft:recovery-upgrade')) };
  `);
  assert.ok(JSON.stringify(first.body).includes('آخرین واژه'));
  assert.ok(JSON.stringify(first.journal.body).includes('آخرین واژه'));
  console.log('ok immediate editor input has a synchronous recovery snapshot');
  // Model an interrupted session: discard memory and reload before the 500ms archive debounce.
  await page.send('Page.navigate', {url:APP});
  await page.sleep(1000);
  const restored = await page.evaluate(`
    const { app, saveLetterNow } = await import('${WEB}/app.js');
    const { getDoc } = await import('${WEB}/store.js');
    const l = await getDoc('letters', 'recovery-upgrade');
    return {body:l?.body, dirty:l?.bodyDirty, pending:localStorage.getItem('namehyar-draft:recovery-upgrade')};
  `);
  assert.ok(JSON.stringify(restored.body).includes('آخرین واژه'));
  assert.equal(restored.dirty, true);
  assert.equal(restored.pending, null);
  console.log('ok recovery restores the most recent content and clears committed journal');
  const concurrent = await page.evaluate(`
    const { app, saveLetter, saveLetterNow, deleteLetter } = await import('${WEB}/app.js');
    const { newLetter } = await import('${WEB}/model.js');
    const { getDoc } = await import('${WEB}/store.js');
    const a = newLetter(app.settings), b = newLetter(app.settings);
    a.subject='اول'; b.subject='دوم'; saveLetter(a); saveLetter(b);
    await saveLetterNow(b); a.subject='آخرین نسخه'; await saveLetterNow(a);
    const savedA = await getDoc('letters',a.id), savedB = await getDoc('letters',b.id);
    saveLetter(a); await deleteLetter(a.id);
    await new Promise(r=>setTimeout(r,600));
    return {a:savedA.subject,b:savedB.subject,deleted:await getDoc('letters',a.id)};
  `);
  assert.deepEqual(concurrent, {a:'آخرین نسخه',b:'دوم',deleted:null});
  console.log('ok switching drafts and deleting a pending draft cannot lose or resurrect letters');
  const forms = await page.evaluate(`
    const { TEMPLATES } = await import('${WEB}/data/templates.js');
    const ids=['leave','hourly-leave','employment','employment-salary','introduce','office-representative','complaint','organizational-cooperation'];
    return ids.map(id=>({id,body:TEMPLATES.find(t=>t.id===id)?.body}));
  `);
  assert.ok(forms.every((f) => f.body && ['superior','peer','subordinate'].every(rank => /\[[^\]]+\]/.test(f.body[rank]))), JSON.stringify(forms));
  console.log('ok requested administrative templates have fillable forms at every recipient rank');
  const modal = await page.evaluate(`
    const { openSheet, segmented } = await import('${WEB}/app.js');
    const trigger=document.createElement('button'); trigger.textContent='open'; document.body.append(trigger); trigger.focus();
    window.__testTrigger=trigger;
    const close=openSheet('آزمون دسترس‌پذیری',segmented([{id:'a',label:'الف'},{id:'b',label:'ب'}],'a',()=>{}));
    const dialog=document.querySelector('.sheet');
    return {modal:dialog.getAttribute('aria-modal'),focused:document.activeElement===dialog,pressed:dialog.querySelector('[data-value=a]').getAttribute('aria-pressed')};
  `);
  assert.deepEqual(modal, {modal:'true', focused:true, pressed:'true'});
  await page.send('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape'});
  assert.equal(await page.evaluate('return !document.querySelector(".sheet") && document.activeElement===window.__testTrigger;'), true);
  console.log('ok dialogs expose modal state, close with Escape and restore focus');
  await page.evaluate(`const { app, setTheme }=await import('${WEB}/app.js'); setTheme('system');`);
  await page.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme',value:'dark'}]});
  await page.sleep(100);
  assert.equal(await page.evaluate('return document.documentElement.dataset.theme;'), 'dark');
  await page.evaluate(`const { setTheme }=await import('${WEB}/app.js'); setTheme('light');`);
  await page.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme',value:'light'}]});
  await page.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme',value:'dark'}]});
  assert.equal(await page.evaluate('return document.documentElement.dataset.theme;'), 'light');
  console.log('ok automatic theme follows the system while explicit theme is retained');
  await page.evaluate(`const {app,applyTheme}=await import('${WEB}/app.js'); app.settings.uiSize='large'; applyTheme();`);
  for (const width of [320,360,600,1024]) {
    await page.send('Emulation.setDeviceMetricsOverride', {width,height:800,deviceScaleFactor:1,mobile:true});
    const fit=await page.evaluate(`return {size:parseFloat(getComputedStyle(document.body).fontSize),over:document.querySelector('#home .scroll').scrollWidth-document.querySelector('#home .scroll').clientWidth};`);
    assert.ok(fit.size>=18 && fit.over<=1, JSON.stringify({width,...fit}));
  }
  console.log('ok enlarged interface fits 320, 360, 600 and 1024 pixel screens');
  await page.send('Emulation.setDeviceMetricsOverride', {width:360,height:800,deviceScaleFactor:1,mobile:true});
  await page.evaluate(`
    const {app,applyTheme,showScreen}=await import('${WEB}/app.js');
    app.settings.uiSize='normal';applyTheme();
    app.letter=app.letters.find(l=>l.id==='recovery-upgrade');
    app.letter.subject='موضوع آزمایشی';
    showScreen('page');
  `);
  await page.sleep(300);
  await page.tapOn('#page [data-section="subject"]');
  await page.evaluate(`const s=document.querySelector('.tools [aria-label="گام جابه‌جایی"]');s.value='0.25';s.dispatchEvent(new Event('change'));`);
  await page.tapOn('.tools [aria-label="جابه‌جایی به راست"]');
  assert.equal(await page.evaluate('return window.__app.letter.offsets.subject.dx;'),.25);
  await page.tapOn('#page [aria-label="برگرداندن آخرین تغییر"]');
  assert.equal(await page.evaluate('return window.__app.letter.offsets.subject?.dx || 0;'),0);
  console.log('ok quarter-millimetre movement changes the selected text precisely and is undoable');
  await page.tapOn('#page [data-section="subject"]');
  await page.tapOn('.tools [aria-label="ویرایش متن"]');
  const modalDraft = await page.evaluate(`
    const field=document.querySelector('.sheet input');field.value='موضوع در حال ویرایش';field.dispatchEvent(new InputEvent('input',{bubbles:true}));
    return JSON.parse(localStorage.getItem('namehyar-draft:recovery-upgrade')).subject;
  `);
  assert.equal(modalDraft,'موضوع در حال ویرایش');
  await page.evaluate(`window.__onBack();
    window.__app.letter.body.push({kind:'table',header:false,rows:[[{paras:[{runs:[{text:'خانهٔ اول'}]}]},{paras:[{runs:[{text:'خانهٔ دوم'}]}]}]]});
    window.__app.screens.page.refresh();
  `);
  await page.tapOn('#page .page td');
  await page.tapOn('.tools [aria-label="ویرایش متن"]');
  const cellDraft = await page.evaluate(`
    const field=document.querySelector('.sheet input');field.value='جدول در حال تایپ';field.dispatchEvent(new InputEvent('input',{bubbles:true}));
    return JSON.parse(localStorage.getItem('namehyar-draft:recovery-upgrade')).body;
  `);
  assert.ok(JSON.stringify(cellDraft).includes('جدول در حال تایپ'));
  await page.evaluate('window.__onBack();');
  await page.tapOn('#page [aria-label="برگرداندن آخرین تغییر"]');
  assert.ok(await page.evaluate("return JSON.stringify(window.__app.letter.body).includes('خانهٔ اول');"));
  console.log('ok open text and table editors checkpoint while typing, with a single undo per cell edit');
  const scan = await page.evaluate(`
    const {cleanPage,turned,slantOf,fixWord,boldLines}=await import('${WEB}/ocr.js');
    const canvas=document.createElement('canvas'); canvas.width=700;canvas.height=900;
    const c=canvas.getContext('2d'); c.fillStyle='#fff';c.fillRect(0,0,700,900);
    c.fillStyle='#222';for(let y=100;y<800;y+=55)for(let x=90;x<610;x+=31)c.fillRect(x,y,20,8);
    const tilted=turned(canvas,12*Math.PI/180); const angle=slantOf(cleanPage(tilted))*180/Math.PI;
    const tiny=document.createElement('canvas'); tiny.width=1;tiny.height=1; const tc=tiny.getContext('2d');tc.fillStyle='#fff';tc.fillRect(0,0,1,1);
    const small=[...cleanPage(tiny).getContext('2d').getImageData(0,0,1,1).data];
    const photo=document.createElement('canvas');photo.width=400;photo.height=300;const pc=photo.getContext('2d');
    const g=pc.createLinearGradient(0,0,400,0);g.addColorStop(0,'#777');g.addColorStop(1,'#ddd');pc.fillStyle=g;pc.fillRect(0,0,400,300);pc.fillStyle='#111';pc.fillRect(40,130,320,5);
    const cleaned=cleanPage(photo).getContext('2d');
    return {angle,w:tilted.width,h:tilted.height,small,paper:[cleaned.getImageData(20,30,1,1).data[0],cleaned.getImageData(380,30,1,1).data[0]],ink:cleaned.getImageData(100,132,1,1).data[0],word:fixWord('ﻛﻲ ١٢٣'),bold:boldLines([8,8.1,7.9,8.2,9.6,9.7].map(weight=>({weight}))),uniform:boldLines([10,10,10,10].map(weight=>({weight})))};
  `);
  assert.ok(Math.abs(scan.angle+12)<0.6, JSON.stringify(scan));
  assert.ok(scan.w>700 && scan.h>900);
  assert.deepEqual(scan.small,[255,255,255,255]);
  assert.ok(scan.paper.every(v=>v>245) && scan.ink<80,JSON.stringify(scan));
  assert.equal(scan.word,'کی ۱۲۳');
  assert.deepEqual(scan.bold,[false,false,false,false,true,true]);
  assert.deepEqual(scan.uniform,[false,false,false,false]);
  console.log('ok 12-degree deskew, non-clipping rotation, tiny scans, uneven light and Persian Unicode normalization');
  assert.deepEqual(page.errors,[]);
  console.log('all upgrade checks passed');
} catch(error) { console.error(error); failed=true; }
finally { await page.close(); }
process.exitCode=failed?1:0;
