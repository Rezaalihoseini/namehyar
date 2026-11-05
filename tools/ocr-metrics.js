// Report script-normalized CER and order-independent, count-aware word recall.
export const normalizeOcr = (text) => text.normalize('NFKC').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
  .replace(/[٠-٩۰-۹]/g, (c) => String(c.charCodeAt(0) - (c >= '۰' ? 0x6f0 : 0x660)))
  .replace(/[\u200e\u200f\u064b-\u0652]/g, '').replace(/[\u200c\s]+/g, ' ').trim();
export function ocrMetrics(reference, recognized) {
  const a = [...normalizeOcr(reference)], b = [...normalizeOcr(recognized)];
  if (!a.length) throw new Error('Empty OCR reference');
  let prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j-1]+1, prev[j]+1, prev[j-1]+(a[i-1]===b[j-1]?0:1));
    prev = next;
  }
  const available = new Map();
  for (const word of normalizeOcr(recognized).split(' ')) available.set(word, (available.get(word) || 0) + 1);
  const words = normalizeOcr(reference).split(' ');
  let matched = 0;
  for (const word of words) if (available.get(word) > 0) { matched++; available.set(word, available.get(word)-1); }
  return { cer: prev[b.length]/a.length, wordRecall: matched/words.length, referenceCharacters: a.length, referenceWords: words.length };
}
