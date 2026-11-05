import assert from 'node:assert/strict';
const stored = new Map();
const native = {
  dbGet: (coll,id) => stored.get(`${coll}/${id}`) || null,
  dbPut: (coll,id,json) => { stored.set(`${coll}/${id}`,json); return true; },
  dbDel: (coll,id) => stored.delete(`${coll}/${id}`),
  dbList: (coll) => JSON.stringify([...stored].filter(([key])=>key.startsWith(coll+'/')).map(([,json])=>JSON.parse(json))),
};
globalThis.window = {NamehyarNative:native};
const {stageDraft,draftToken,clearDraft,recoveryDrafts} = await import('../app/src/main/assets/web/js/drafts.js?native-test');
const a={id:'a',updatedAt:1,body:[{kind:'p',runs:[{text:'نسخهٔ اول'}]}]};
const first=stageDraft(a);
assert.equal(native.dbGet('drafts','a'),first); // Must commit before returning.
a.updatedAt=2; a.body[0].runs[0].text='نسخهٔ جدید';
const latest=stageDraft(a);
clearDraft('a',first);
assert.equal(draftToken('a'),latest);
stageDraft({id:'b',updatedAt:3,body:[]});
assert.equal(recoveryDrafts().length,2);
clearDraft('a',latest);
assert.equal(draftToken('a'),null);
native.dbPut=()=>false;
assert.throws(()=>stageDraft(a),/write failed/);
assert.equal(draftToken('a'),null);
console.log('Native journal: synchronous commit, isolated drafts, revision-safe cleanup and storage failure checks passed');
globalThis.window={};
globalThis.localStorage={
  getItem(key){return this[key] ?? null;},
  setItem(key,value){this[key]=value;},
  removeItem(key){delete this[key];},
};
const browser=await import('../app/src/main/assets/web/js/drafts.js?browser-test');
localStorage['namehyar-draft:broken']='not JSON';
localStorage['namehyar-draft:invalid']=JSON.stringify({id:'invalid',body:'not an array'});
const old=browser.stageDraft(a);a.updatedAt=4;
const next=browser.stageDraft(a);
browser.clearDraft('a',old);
assert.equal(browser.draftToken('a'),next);
assert.deepEqual(browser.recoveryDrafts(),[a]);
browser.clearDraft('a',next);
assert.deepEqual(browser.recoveryDrafts(),[]);
console.log('Browser journal: stale cleanup, damaged-entry isolation and recovery validation checks passed');
