import type { SourceLocation, SynthError } from './assembly.ts';

// `file.ts:12:9` as in a stack frame, or `file.ts(12,9)` as the type checker writes it.
const REFERENCE = /([^\s()'"]+?\.(?:ts|tsx|mts|cts))(?::(\d+):(\d+)|\((\d+),(\d+)\))/g;

/**
 * The first place in the app's own TypeScript that a synth error's trace points at, relative to
 * the app folder. Frames are innermost first, so the first one inside the app is where it threw.
 */
export function locateError(error: SynthError, appDir: string): SourceLocation | undefined {
  const root = appDir.replaceAll('\\', '/').replace(/\/+$/, '');
  for (const text of [error.output, error.message]) {
    for (const m of (text ?? '').matchAll(REFERENCE)) {
      const file = relativeToApp(m[1]!, root);
      if (file) return { file, line: Number(m[2] ?? m[4]), col: Number(m[3] ?? m[5]) };
    }
  }
  return undefined;
}

function relativeToApp(path: string, root: string): string | undefined {
  const p = path.replaceAll('\\', '/').replace(/^file:\/\//, '');
  const rel =
    p.startsWith('/') || /^[A-Za-z]:\//.test(p)
      ? p.startsWith(`${root}/`)
        ? p.slice(root.length + 1)
        : undefined
      : p.replace(/^\.\//, '');
  if (!rel || rel.split('/').some((s) => s === '..' || s === 'node_modules')) return undefined;
  return rel;
}
