import type { Assembly, SourceLocation } from './assembly.ts';
import { offsetOf, type FileDiff, type TextChange } from './diff.ts';
import type { Facts } from './facts.ts';
import type { Intent } from './intents.ts';
import { describeIntent } from './intents.ts';

export type Severity = 'error' | 'warning' | 'info';

/** Where a Problem comes from (CONTEXT.md). `truss` is a check that the edit Truss planned isn't the edit the intents mean: a bug in Truss, not in the user's code. */
export type ProblemSource = 'synth' | 'annotation' | 'typescript' | 'cycle' | 'truss';

/** An error or warning Truss shows on a Design. */
export interface Problem {
  /** Stable for the same finding, so the browser can link to it. */
  id: string;
  severity: Severity;
  source: ProblemSource;
  message: string;
  /** The construct path of the Node (or Stack, or a construct beneath one) it belongs to. */
  path?: string;
  /** Where in the app's code it is, when it is not tied to a construct. */
  location?: SourceLocation;
  /** For a dependency cycle, the constructs in it, in the order of the cycle. */
  cycle?: string[];
  /** The Draft introduced or changed it. */
  draft: boolean;
  /** It stops Save. */
  blocking: boolean;
  /** The edit Truss planned is wrong; the user's code is not. Offered with a report to file. */
  trussBug?: true;
}

/** The place new Problems are reported, for a bug in Truss. */
export const ISSUE_TRACKER_URL = 'https://github.com/Elliot-Fortney/Truss/issues';

const annotationKey = (a: { path: string; level: string; message: string }) => `${a.path}\0${a.level}\0${a.message}`;

/** The annotations of the cloud assembly (`Annotations.of(x).addError(…)`), and those the Draft adds to `base`'s. */
export function annotationProblems(assembly: Assembly, base?: Assembly): Problem[] {
  const had = new Set((base?.annotations ?? []).map(annotationKey));
  return (assembly.annotations ?? []).map((a) => {
    const draft = base !== undefined && !had.has(annotationKey(a));
    return {
      id: `annotation:${annotationKey(a)}`,
      severity: a.level,
      source: 'annotation',
      message: a.message,
      path: a.path,
      draft,
      blocking: draft && a.level === 'error',
    };
  });
}

/** Strongly connected sets of two or more resources in the graph of what each resource points at (Tarjan). */
function components(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const members: string[] = [];
      for (let w = stack.pop()!; ; w = stack.pop()!) {
        onStack.delete(w);
        members.push(w);
        if (w === v) break;
      }
      if (members.length > 1) out.push(members);
    }
  };
  for (const v of [...edges.keys()].sort()) if (!index.has(v)) visit(v);
  return out;
}

/** One cycle through the members, as the path of resources it follows and back to where it began. */
function walkCycle(members: readonly string[], edges: ReadonlyMap<string, readonly string[]>): string[] {
  const inside = new Set(members);
  const start = [...members].sort()[0]!;
  const via = new Map<string, string>();
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const next of (edges.get(queue[i]!) ?? []).filter((n) => inside.has(n))) {
      if (next === start) {
        const path = [queue[i]!];
        while (path[0] !== start) path.unshift(via.get(path[0]!)!);
        return path;
      }
      if (!via.has(next)) {
        via.set(next, queue[i]!);
        queue.push(next);
      }
    }
  }
  return [start];
}

const cycleKey = (members: readonly string[]) => [...members].sort().join('\0');

/** The dependency cycles between the resources of a Stack, found from what each resource's template points at (`Ref`, `Fn::GetAtt`, `DependsOn`). Each is the resources in the order of the cycle. */
export function findCycles(assembly: Assembly): string[][] {
  const edges = new Map<string, string[]>();
  for (const { from, to } of assembly.resourceRefs) (edges.get(from) ?? edges.set(from, []).get(from)!).push(to);
  return components(edges).map((members) => walkCycle(members, edges));
}

/** The cycles of `assembly`. With `base`, one that `base` did not have is the Draft's, and blocks Save; a cycle the app already had is reported only. */
export function cycleProblems(assembly: Assembly, base?: Assembly): Problem[] {
  const had = new Set(base ? findCycles(base).map(cycleKey) : []);
  return findCycles(assembly).map((cycle) => {
    const draft = base !== undefined && !had.has(cycleKey(cycle));
    return {
      id: `cycle:${cycleKey(cycle)}`,
      severity: 'error' as const,
      source: 'cycle' as const,
      message: `Dependency cycle: ${[...cycle, cycle[0]!].join(' → ')}`,
      path: cycle[0]!,
      cycle,
      draft,
      blocking: draft,
    };
  });
}

/** Where the paths of Problems show: errors count wherever they are, warnings only where the Draft introduced them. Info is for the property panel. */
export const isBadged = (p: Problem): boolean => p.severity === 'error' || (p.severity === 'warning' && p.draft);

export interface Badge {
  errors: number;
  warnings: number;
}

/** The paths a Problem belongs to: every resource in a cycle, else its own path. */
const pathsOf = (p: Problem): string[] => p.cycle ?? (p.path === undefined ? [] : [p.path]);

/**
 * The badge each visible element carries. A Problem on a construct that is not itself drawn (it is inside a
 * collapsed Layer) is counted on the nearest drawn ancestor; one Problem counts once there however many of its paths land on it.
 */
export function badgesFor(problems: readonly Problem[], visible: ReadonlySet<string>): Map<string, Badge> {
  const out = new Map<string, Badge>();
  for (const p of problems.filter(isBadged)) {
    const targets = new Set<string>();
    for (const path of pathsOf(p)) {
      for (let at = path.length; at > 0; at = path.lastIndexOf('/', at - 1)) {
        const prefix = path.slice(0, at);
        if (visible.has(prefix)) {
          targets.add(prefix);
          break;
        }
      }
    }
    for (const t of targets) {
      const badge = out.get(t) ?? out.set(t, { errors: 0, warnings: 0 }).get(t)!;
      if (p.severity === 'error') badge.errors++;
      else badge.warnings++;
    }
  }
  return out;
}

/** The position in the original text that a position in the changed text came from; inside new text, where the replacement began. */
export function sourcePosition(original: string, changes: readonly TextChange[], changed: string, at: { line: number; col: number }): { line: number; col: number } {
  let offset = offsetOf(changed, at.line, at.col);
  let shift = 0;
  for (const c of [...changes].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const start = c.start + shift;
    const end = start + c.text.length;
    if (offset < start) break;
    if (offset < end || (c.text.length === 0 && offset === start)) {
      offset = c.start;
      shift = Number.NaN;
      break;
    }
    shift += c.text.length - (c.end - c.start);
  }
  if (!Number.isNaN(shift)) offset -= shift;
  const before = original.slice(0, offset).split('\n');
  return { line: before.length, col: before.at(-1)!.length + 1 };
}

const within = (s: { start: { line: number; col: number }; end: { line: number; col: number } }, p: { line: number; col: number }) =>
  (p.line > s.start.line || (p.line === s.start.line && p.col >= s.start.col)) && (p.line < s.end.line || (p.line === s.end.line && p.col <= s.end.col));

const size = (s: { start: { line: number }; end: { line: number } }) => s.end.line - s.start.line;

/** The construct path of the innermost `new` that holds a place in the code; undefined when none does. */
export function nodeAt(facts: Facts, location: SourceLocation): string | undefined {
  let best: [string, number] | undefined;
  for (const [path, f] of Object.entries(facts.nodes)) {
    if (f.span.file !== location.file || !within(f.span, location)) continue;
    const s = size(f.span) * 1_000_000 + (f.span.end.col - f.span.start.col);
    if (!best || s < best[1]) best = [path, s];
  }
  return best?.[0];
}

/** What a user files when Truss plans an edit wrongly: the intents, the diff Truss planned and how the assembly differed from what they mean. No line of the user's code outside the lines the edit changes. */
export function buildReport(intents: readonly Intent[], diffs: readonly FileDiff[], failures: readonly string[]): string {
  const changed = (d: FileDiff) =>
    d.diff
      .split('\n')
      .filter((l) => l.startsWith('@@') || l.startsWith('+') || l.startsWith('-'))
      .join('\n');
  return [
    '## Intents',
    ...intents.map((i) => `- ${i.type} ${i.path} (${i.expect.className} ${JSON.stringify(i.expect.literalId)}): ${describeIntent(i)}`),
    '',
    '## Planned diff (changed lines only)',
    ...diffs.map((d) => `${d.file}\n${changed(d)}`),
    '',
    '## Assembly diff',
    ...failures.map((f) => `- ${f}`),
  ].join('\n');
}
