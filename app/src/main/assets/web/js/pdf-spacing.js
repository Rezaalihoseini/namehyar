// PDF text extractors sometimes append a synthetic space after a detached
// Persian glyph. Only recover a half-space when its advance is demonstrably
// zero; genuine word spaces must keep their width and their spelling.
export function recoverZeroAdvanceSpace(raw, width, fontScale, advances) {
  const text = raw.trimEnd();
  if (text === raw || !/[ء-ۓﭐ-﷿ﹰ-ﻼ]/.test(text) || /\s/.test(text) || !advances) return raw;
  let advance = 0;
  for (const char of text) {
    if (!advances.has(char)) return raw;
    advance += advances.get(char) * fontScale;
  }
  return Math.abs(width - advance) < Math.max(0.01, fontScale * 0.01) ? text + '\u200c' : raw;
}
