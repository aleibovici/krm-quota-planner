// Text splicing that keeps a hand-formatted YAML file hand-formatted.
//
// The tenancy file is edited by people and carries its reasoning in comments
// and its numbers in aligned flow maps:
//
//     gpu:    {deserved: 3,  limit: 3,  overQuotaWeight: 1}
//     cpu:    {deserved: -1, limit: -1, overQuotaWeight: 1}
//
// Re-serialising the document would rewrite all of that, so an edit here is a
// replacement of one scalar's bytes in the original string. When the new
// value is longer or shorter than the old one, the run of spaces that follows
// (after a comma, or before a trailing comment) absorbs the difference so the
// columns and the comment stay where they were.

/**
 * @typedef {{ start: number, end: number, text: string }} Splice
 */

/**
 * Apply non-overlapping splices to `source`.
 * @param {string} source
 * @param {Splice[]} splices
 * @returns {string}
 */
export function applySplices(source, splices) {
  // Right to left, so earlier offsets stay valid while later text changes length.
  const ordered = [...splices].sort((a, b) => b.start - a.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].end > ordered[i - 1].start) {
      throw new Error(`overlapping edits at offsets ${ordered[i].start} and ${ordered[i - 1].start}`);
    }
  }
  let out = source;
  for (const s of ordered) out = spliceAligned(out, s.start, s.end, s.text);
  return out;
}

/**
 * Replace source[start:end] with `text`, compensating in the padding that
 * follows so later columns do not move. Never removes the last space.
 */
export function spliceAligned(source, start, end, text) {
  const head = source.slice(0, start);
  const tail = source.slice(end);
  const delta = text.length - (end - start);
  const m = delta === 0 ? null : /^(,?)( +)(?=\S)/.exec(tail);
  if (!m) return head + text + tail;

  const [whole, comma, spaces] = m;
  const beforeComment = tail[whole.length] === '#';
  if (!comma && !beforeComment) return head + text + tail; // not padding we own

  let width = spaces.length;
  if (delta > 0) {
    width = Math.max(1, spaces.length - delta); // value grew: eat padding
  } else if (beforeComment || inTable(source, start)) {
    width = spaces.length - delta; // value shrank: pad, but only where columns are aligned
  }
  return head + text + comma + ' '.repeat(width) + tail.slice(whole.length);
}

// True when the line above or below has the same `key: ` ending at the same
// column, i.e. the file lines these values up as a table.
function inTable(source, offset) {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = source.indexOf('\n', offset);
  const col = offset - lineStart;
  const key = /(\w+): *$/.exec(source.slice(lineStart, offset))?.[0];
  if (!key) return false;

  const neighbours = [];
  if (lineStart > 0) {
    const prevStart = source.lastIndexOf('\n', lineStart - 2) + 1;
    neighbours.push(source.slice(prevStart, lineStart - 1));
  }
  if (lineEnd !== -1) {
    const nextEnd = source.indexOf('\n', lineEnd + 1);
    neighbours.push(source.slice(lineEnd + 1, nextEnd === -1 ? undefined : nextEnd));
  }
  return neighbours.some((line) => line.slice(0, col).endsWith(key));
}
