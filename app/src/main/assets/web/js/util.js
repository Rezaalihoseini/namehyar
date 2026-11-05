export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Small DOM builder: h('div', {class: 'x', onClick: fn}, child, child). */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const clone = (o) => JSON.parse(JSON.stringify(o));

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let toastTimer = null;
export function toast(msg, ms = 2600) {
  let el = $('#toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** Runs a handler on tap without taking focus away from the text editor. */
export function keepFocus(el) {
  el.addEventListener('pointerdown', (e) => e.preventDefault());
  el.addEventListener('mousedown', (e) => e.preventDefault());
  return el;
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = src;
  });
}

/** A file of the app's own, with more than one try. */
export async function fetchBytes(url, tries = 3) {
  try {
    const answer = await fetch(url);
    if (!answer.ok) throw new Error(`could not read ${url}`);
    return await answer.arrayBuffer();
  } catch (err) {
    if (tries <= 1) throw err;
    await new Promise((done) => setTimeout(done, 500));
    return fetchBytes(url, tries - 1);
  }
}

export function dataUrlToBytes(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/^data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime, ext: mime === 'image/jpeg' ? 'jpeg' : 'png' };
}

export function bytesToBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
}
