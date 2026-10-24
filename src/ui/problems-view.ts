import type { Problem } from '../core/problems.ts';

export type ProblemFilter = 'draft' | 'all';

/** The Problems to list: with `draft`, only those the Draft introduced or changed. Errors first, then warnings; each kept in the order found. */
export function listProblems(problems: readonly Problem[], filter: ProblemFilter): Problem[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return (
    problems
      // Info is for the property panel only.
      .filter((p) => p.severity !== 'info' && (filter === 'all' || p.draft))
      .map((p, i) => ({ p, i }))
      .sort((a, b) => rank[a.p.severity] - rank[b.p.severity] || a.i - b.i)
      .map(({ p }) => p)
  );
}

/** The drawn element a Problem is shown on: its construct, or the nearest drawn one above it. */
export function jumpTarget(problem: Problem, drawn: ReadonlySet<string>): string | undefined {
  for (const path of problem.cycle ?? (problem.path === undefined ? [] : [problem.path])) {
    for (let at = path.length; at > 0; at = path.lastIndexOf('/', at - 1)) {
      const prefix = path.slice(0, at);
      if (drawn.has(prefix)) return prefix;
    }
  }
  return undefined;
}
