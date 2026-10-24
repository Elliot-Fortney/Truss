/** A replacement of `text.slice(start, end)`, with offsets into the original text. */
export interface TextChange {
  start: number;
  end: number;
  text: string;
  /** `import` for a line added to the file's imports; `add` for a statement or field that makes a new construct; `remove` for the statement (and field) of a construct that is deleted; `move` for a statement that moves below another, both where it leaves and where it lands; every other change belongs to the construct an intent names. */
  purpose?: 'import' | 'add' | 'remove' | 'move';
  /** For the deletion half of a `move`: what moves, in words, for the diff to say beside the lines. */
  note?: string;
}

/** Applies changes made against `text`. They must not overlap; insertions at one offset keep the order given. */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  const sorted = changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.start - b.c.start || a.c.end - b.c.end || a.i - b.i);
  let out = '';
  let at = 0;
  for (const { c } of sorted) {
    if (c.start < at) throw new Error('Text changes overlap');
    out += text.slice(at, c.start) + c.text;
    at = c.end;
  }
  return out + text.slice(at);
}

/** The offset into `text` of a 1-based line and column. */
export function offsetOf(text: string, line: number, col: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset + col - 1;
}

export interface FileDiff {
  file: string;
  /** Unified diff with three lines of context. */
  diff: string;
  /** Statements that move rather than change, which the diff shows as lines removed and added again. */
  moves?: string[];
}

const CONTEXT = 3;
/** Past this many lines changed in a row, the differing middle is shown as removed then added rather than matched line by line. */
const MAX_MATCHED_LINES = 2000;

interface Op {
  sign: ' ' | '-' | '+';
  line: string;
}

/** The line-by-line edit script from `a` to `b`. */
function script(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const ops: Op[] = a.slice(0, head).map((line) => ({ sign: ' ', line }));
  if (midA.length > MAX_MATCHED_LINES || midB.length > MAX_MATCHED_LINES) {
    ops.push(...midA.map((line): Op => ({ sign: '-', line })), ...midB.map((line): Op => ({ sign: '+', line })));
  } else {
    // Longest common subsequence of the middle, which is small for the edits Truss makes.
    const n = midA.length;
    const m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) (ops.push({ sign: ' ', line: midA[i++]! }), j++);
      else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ sign: '-', line: midA[i++]! });
      else ops.push({ sign: '+', line: midB[j++]! });
    }
  }
  ops.push(...a.slice(a.length - tail).map((line): Op => ({ sign: ' ', line })));
  return ops;
}

const linesOf = (text: string) => (text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/));

/** The unified diff Save will write for one file, or undefined when the texts are the same. */
export function unifiedDiff(file: string, before: string, after: string): FileDiff | undefined {
  if (before === after) return undefined;
  const ops = script(linesOf(before), linesOf(after));
  const shown = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.sign === ' ') return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) shown[k] = true;
  });
  const out = [`--- a/${file}`, `+++ b/${file}`];
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < ops.length;) {
    if (!shown[i]) {
      const op = ops[i++]!;
      if (op.sign !== '+') oldLine++;
      if (op.sign !== '-') newLine++;
      continue;
    }
    const hunkOld = oldLine;
    const hunkNew = newLine;
    let removed = 0;
    let added = 0;
    const body: string[] = [];
    for (; i < ops.length && shown[i]; i++) {
      const op = ops[i]!;
      body.push(op.sign + op.line);
      if (op.sign !== '+') removed++;
      if (op.sign !== '-') added++;
    }
    oldLine += removed;
    newLine += added;
    out.push(`@@ -${hunkOld},${removed} +${hunkNew},${added} @@`, ...body);
  }
  return { file, diff: out.join('\n') + '\n' };
}
