// A synchronous recovery journal. On Android the bridge commits to SQLite before
// returning; the browser fallback uses localStorage until IndexedDB commits.
const PREFIX = 'namehyar-draft:';
const native = window.NamehyarNative;

export function draftToken(id) {
  return native ? native.dbGet('drafts', id) : localStorage.getItem(PREFIX + id);
}

export function stageDraft(letter) {
  const token = JSON.stringify(letter);
  if (native) {
    if (native.dbPut('drafts', letter.id, token) === false) throw new Error('Recovery checkpoint write failed');
  }
  else localStorage.setItem(PREFIX + letter.id, token);
  return token;
}

export function clearDraft(id, token) {
  if (token !== undefined && draftToken(id) !== token) return;
  if (native) native.dbDel('drafts', id);
  else localStorage.removeItem(PREFIX + id);
}

export function recoveryDrafts() {
  const entries = native ? JSON.parse(native.dbList('drafts')) : Object.keys(localStorage)
    .filter((key) => key.startsWith(PREFIX)).map((key) => {
      try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
    });
  return entries.filter((letter) => letter && typeof letter.id === 'string' && Array.isArray(letter.body) && Number.isFinite(letter.updatedAt));
}
