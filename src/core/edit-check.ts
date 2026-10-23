import type { Assembly, TreeNode } from './assembly.ts';
import { offsetOf, type TextChange } from './diff.ts';
import type { Facts } from './facts.ts';
import { afterMoves, beforeMoves, movesOf, onBase, type Intent } from './intents.ts';
import type { Diagnostic, FileSet } from './ports.ts';

const spanKey = (f: { span: { file: string; start: { line: number; col: number } } }) => `${f.span.file}:${f.span.start.line}:${f.span.start.col}`;

/** The paths in the Base of every construct made by the `new` call an intent names, which is more than one for a Stack class created several times (ADR 0008). */
export function targetPaths(facts: Facts, intents: readonly Intent[]): Set<string> {
  const spans = new Set(onBase(intents).flatMap((i) => (facts.nodes[i.path] ? [spanKey(facts.nodes[i.path]!)] : [])));
  return new Set(Object.entries(facts.nodes).flatMap(([path, f]) => (spans.has(spanKey(f)) ? [path] : [])));
}

function pathsOf(tree: TreeNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: TreeNode) => {
    out.set(n.path, n.fqn);
    n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

/** What the planned changes are checked against, none of which is the planner's own word for what it did. */
export interface EditCheck {
  /** The app's files as they are on disk. */
  files: FileSet;
  /** The planned changes, by file. */
  changes: Record<string, TextChange[]>;
  /** What the source said about the app on disk. */
  facts: Facts;
  intents: readonly Intent[];
  /** The Design as synth makes it from the files on disk, and from the files with the changes made. */
  before: Assembly;
  after: Assembly;
}

/**
 * Why an edit can't be trusted, if it can't: its diff reaches outside the constructs the intents name, or
 * the app it makes isn't the app the intents mean (ADR 0006, ADR 0007). An empty list means it holds.
 * Whether the app still type-checks and synths is decided from their own results.
 */
export function judgeEdit({ files, changes, facts, intents, before, after }: EditCheck): string[] {
  const failures: string[] = [];
  const onDisk = onBase(intents);
  const targets = [...new Set(onDisk.flatMap((i) => (facts.nodes[i.path] ? [facts.nodes[i.path]!] : [])))];

  // Confined diff: every change is inside a `new` call an intent names, or adds an import.
  for (const [file, list] of Object.entries(changes)) {
    const text = files.get(file) ?? '';
    const inside = targets.filter((t) => t.span.file === file).map((t) => [offsetOf(text, t.span.start.line, t.span.start.col), offsetOf(text, t.span.end.line, t.span.end.col)] as const);
    for (const c of list) {
      if (c.purpose === 'import' || inside.some(([start, end]) => c.start >= start && c.end <= end)) continue;
      failures.push(`The edit changes ${file} outside the code it was meant to change`);
      break;
    }
  }

  // Intent-shaped assembly diff: a prop changes what the targets create, and nothing else.
  // A rename moves one construct and what is beneath it, which is then the only thing that is somewhere else in the tree.
  const moves = movesOf(intents);
  const paths = targetPaths(facts, intents);
  const below = (path: string) => [...paths].some((t) => path.startsWith(`${t}/`));
  const was = pathsOf(before.tree);
  const reached = pathsOf(after.tree);
  const now = new Map([...reached].map(([path, fqn]) => [beforeMoves(moves, path), fqn]));
  for (const path of [...paths].sort()) {
    if (!was.has(path) || !now.has(path) || was.get(path) !== now.get(path)) failures.push(`${path} is no longer the same construct after the edit`);
  }
  for (const path of [...paths].sort()) {
    const to = afterMoves(moves, path);
    if (to !== path && (!reached.has(to) || reached.has(path))) failures.push(`${path} was not renamed to ${to}`);
  }
  // What lies beneath a construct that is only renamed goes with it whole, where a prop may make the construct create more beneath itself.
  const edited = targetPaths(facts, onDisk.filter((i) => i.type === 'setProp'));
  for (const root of onDisk.flatMap((i) => (i.type === 'renameId' && !edited.has(i.path) ? [i.path] : []))) {
    const lost = [...new Set([...was.keys(), ...now.keys()])].filter((path) => path.startsWith(`${root}/`) && was.get(path) !== now.get(path));
    for (const path of lost) if (!lost.some((other) => path.startsWith(`${other}/`))) failures.push(`${path} did not move with ${root}`);
  }
  const changed = [...new Set([...was.keys(), ...now.keys()])].filter((path) => !paths.has(path) && was.get(path) !== now.get(path) && !below(path));
  // A construct that came or went takes everything beneath it along, which is one thing to say, not many.
  for (const path of changed) {
    if (!changed.some((other) => path.startsWith(`${other}/`))) failures.push(`The edit changes ${path}, which it should not touch`);
  }
  const stacks = (a: Assembly) => JSON.stringify(a.stacks.filter((s) => !paths.has(beforeMoves(moves, s.path)) && !below(beforeMoves(moves, s.path))));
  if (stacks(before) !== stacks(after)) failures.push('The edit changes a Stack it should not touch');
  return failures;
}

/** The diagnostics the edit adds: those in `after` that `before` didn't have (by file, code and message, so a line that moved doesn't count). */
export function newDiagnostics(before: readonly Diagnostic[], after: readonly Diagnostic[]): Diagnostic[] {
  const key = (d: Diagnostic) => `${d.file}|${d.code}|${d.message}`;
  const had = new Map<string, number>();
  for (const d of before) had.set(key(d), (had.get(key(d)) ?? 0) + 1);
  return after.filter((d) => {
    const left = had.get(key(d)) ?? 0;
    if (left > 0) had.set(key(d), left - 1);
    return left === 0;
  });
}
