import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The nearest folder at or above `from` that holds a `cdk.json`. */
export function findAppDir(from: string): string | undefined {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'cdk.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
