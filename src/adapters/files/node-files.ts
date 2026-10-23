import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

  async readText(name: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.appDir, name), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /** Writes to a temporary file and renames it over the target, so a crash never leaves half a file. */
  async writeText(name: string, text: string): Promise<void> {
    const target = join(this.appDir, name);
    const temp = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temp, text);
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }
}
