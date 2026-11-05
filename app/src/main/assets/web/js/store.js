// Storage. Inside the APK everything goes to SQLite and app files through the native bridge;
// in a desktop browser (used while developing) IndexedDB stands in with the same interface.

import { inlineImageIds } from './model.js';

const N = window.NamehyarNative || null;

export const isNative = !!N;

let dbPromise = null;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('namehyar', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('docs');
        req.result.createObjectStore('media');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idbRun(storeName, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getDoc(coll, id) {
  if (N) {
    const json = N.dbGet(coll, id);
    return json ? JSON.parse(json) : null;
  }
  return (await idbRun('docs', 'readonly', (s) => s.get(`${coll}/${id}`))) || null;
}

export async function putDoc(coll, id, doc) {
  if (N) {
    if (N.dbPut(coll, id, JSON.stringify(doc)) === false) throw new Error('Device storage write failed');
    return;
  }
  return idbRun('docs', 'readwrite', (s) => s.put(doc, `${coll}/${id}`));
}

export async function delDoc(coll, id) {
  if (N) return N.dbDel(coll, id);
  return idbRun('docs', 'readwrite', (s) => s.delete(`${coll}/${id}`));
}

export async function listDocs(coll) {
  if (N) return JSON.parse(N.dbList(coll));
  const range = IDBKeyRange.bound(`${coll}/`, `${coll}/￿`);
  return idbRun('docs', 'readonly', (s) => s.getAll(range));
}

// Media is kept as data URLs in memory, since the page, the PDF and the Word export all need the same bytes.
const mediaCache = new Map();

export function mediaUrl(id) {
  return mediaCache.get(id) || '';
}

export async function putMedia(id, dataUrl) {
  mediaCache.set(id, dataUrl);
  if (N) return N.mediaPut(id, dataUrl);
  return idbRun('media', 'readwrite', (s) => s.put(dataUrl, id));
}

export async function ensureMedia(ids) {
  for (const id of ids) {
    if (!id || mediaCache.has(id)) continue;
    const url = N ? N.mediaGet(id) : await idbRun('media', 'readonly', (s) => s.get(id));
    if (url) mediaCache.set(id, url);
  }
}

export function mediaIdsOf(letter) {
  return [letter.letterhead?.logo, ...(letter.objects || []).map((o) => o.mediaId), ...inlineImageIds(letter), letter.ink?.id, ...Object.values(letter.ink?.fonts || {}), ...(letter.ocr?.pages || [])].filter(Boolean);
}
