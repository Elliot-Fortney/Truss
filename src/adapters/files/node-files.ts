import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FileSet, Files } from '../../core/ports.ts';

const SKIP_DIRS = new Set(['node_modules', 'cdk.out', 'dist', '.git']);

/** The Files port over the real disk. */
export class NodeFiles implements Files {
  constructor(private readonly appDir: string) {}

  async read(): Promise<FileSet> {
    const files = new Map<string, string>();
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          files.set(relative(this.appDir, full), await readFile(full, 'utf8'));
        }
      }
    };
    await walk(this.appDir);
    return files;
  }
}
