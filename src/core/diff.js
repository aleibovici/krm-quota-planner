// Unified diff that `git apply` accepts.
//
// The files this tool touches are a few hundred lines, so a plain
// longest-common-subsequence table is fine and keeps the tool free of a diff
// dependency.

/**
 * @param {string} path repository-relative path, used for both sides
 * @param {string} before
 * @param {string} after
 * @param {number} [context]
 * @returns {string} '' when the texts are identical
 */
export function unifiedDiff(path, before, after, context = 3) {
  if (before === after) return '';
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a.lines, b.lines);

  // A hunk is a run of changes plus `context` unchanged lines either side;
  // runs whose context would touch or overlap are one hunk.
  const ranges = [];
  ops.forEach((op, index) => {
    if (op.type === ' ') return;
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  });
  const hunks = ranges.map(([start, end]) => ops.slice(start, end + 1));

  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    const first = hunk[0];
    const oldCount = hunk.filter((o) => o.type !== '+').length;
    const newCount = hunk.filter((o) => o.type !== '-').length;
    const oldStart = oldCount ? first.a + 1 : first.a;
    const newStart = newCount ? first.b + 1 : first.b;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of hunk) {
      out.push(o.type + o.line);
      const lastOfOld = o.type !== '+' && o.a === a.lines.length - 1 && !a.finalNewline;
      const lastOfNew = o.type !== '-' && o.b === b.lines.length - 1 && !b.finalNewline;
      if ((o.type === '-' && lastOfOld) || (o.type === '+' && lastOfNew) || (o.type === ' ' && lastOfOld && lastOfNew)) {
        out.push('\\ No newline at end of file');
      }
    }
  }
  return out.join('\n') + '\n';
}

function splitLines(text) {
  const finalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

/** @returns {{ type: ' '|'-'|'+', line: string, a: number, b: number }[]} a/b = index in old/new at this op */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i:] and b[j:]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ type: ' ', line: a[i], a: i, b: j });
      i++; j++;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ type: '-', line: a[i], a: i, b: j });
      i++;
    } else {
      ops.push({ type: '+', line: b[j], a: i, b: j });
      j++;
    }
  }
  return ops;
}
