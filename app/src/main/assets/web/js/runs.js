// Runs are the stretches of a paragraph's text that share one look. A word can have a look of its own,
// by cutting the runs around it, and the cuts are healed again when two neighbours end up looking the same.

const LOOK = ['b', 'u', 'i', 'font', 'size', 'color'];

const sameLook = (a, b) => LOOK.every((key) => a[key] === b[key]);

export const runsText = (runs) => (runs || []).map((run) => run.text || '').join('');

/** Gives a stretch of the text a look. Without a stretch, the whole text. Pictures in the text stay as they are. */
export function applyLook(runs, look, start = 0, end = Infinity) {
  const out = [];
  const push = (run) => {
    const last = out[out.length - 1];
    if (last && !last.img && !run.img && sameLook(last, run)) last.text += run.text;
    else out.push({ ...run });
  };
  let pos = 0;
  for (const run of runs || []) {
    if (run.img) {
      push(run);
      continue;
    }
    if (!run.text) continue;
    const from = Math.max(start - pos, 0);
    const to = Math.min(end - pos, run.text.length);
    if (from >= to) push(run);
    else {
      if (from > 0) push({ ...run, text: run.text.slice(0, from) });
      push({ ...run, ...look, text: run.text.slice(from, to) });
      if (to < run.text.length) push({ ...run, text: run.text.slice(to) });
    }
    pos += run.text.length;
  }
  return out;
}

/** The run that holds a place in the text. */
export function runAt(runs, offset) {
  let pos = 0;
  for (const run of runs || []) {
    if (!run.text) continue;
    pos += run.text.length;
    if (offset < pos) return run;
  }
  return null;
}

/** Takes the given parts of a look off every run, so that the look of the whole applies to them again. */
export function clearLook(runs, keys) {
  return applyLook((runs || []).map((run) => {
    if (run.img) return run;
    const rest = { ...run };
    for (const key of keys) delete rest[key];
    return rest;
  }), {});
}

/** Where a word really stands in a text, when the place given for it is slightly off: the nearest place it occurs. */
export function placeOfWord(text, { start, end, text: word }) {
  if (text.slice(start, end) === word) return { start, end };
  let best = -1;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (best < 0 || Math.abs(at - start) < Math.abs(best - start)) best = at;
  }
  return best < 0 ? null : { start: best, end: best + word.length };
}
