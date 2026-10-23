import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Assembly } from '../../src/core/assembly.ts';
import type { FileSet } from '../../src/core/ports.ts';

export const fixtureDir = (name: string) => resolve(import.meta.dirname, '../fixtures', name);

/** The fixture app's TypeScript files, as the Files port would hand them to Source. */
export function readFixtureFiles(name: string): Map<string, string> {
  const root = fixtureDir(name);
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'cdk.out') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) files.set(relative(root, full), readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files;
}

/** The synth output recorded for the fixture (`node scripts/record-fixture.ts <name>`). */
export const readFixtureAssembly = (name: string): Assembly =>
  JSON.parse(readFileSync(join(fixtureDir(name), 'assembly.json'), 'utf8'));

export type { FileSet };
