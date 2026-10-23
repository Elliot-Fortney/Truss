import { watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FileSet, Files } from '../../core/ports.ts';

const SKIP_DIRS = new Set(['node_modules', 'cdk.out', 'dist', '.git']);

/** Files that can change the Design: sources, and the JSON that configures or locks the app. */
const WATCHED = /\.(?:[cm]?[jt]sx?|json)$/;
const DEFAULT_DEBOUNCE_MS = 150;
/** A steady stream of writes (an install, a big checkout) is still reported this often. */
const DEFAULT_MAX_WAIT_MS = 2000;

/** The Files port over the real disk. */
export class NodeFiles implements Files {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(
    private readonly appDir: string,
    opts: { debounceMs?: number; maxWaitMs?: number } = {},
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  watch(onChange: () => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    let firstAt = 0;
    const fire = () => {
      timer = undefined;
      onChange();
    };
    const watcher = watch(this.appDir, { recursive: true }, (_event, filename) => {
      if (!filename || !isWatched(filename)) return;
      const now = Date.now();
      if (timer === undefined) firstAt = now;
      clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(this.debounceMs, firstAt + this.maxWaitMs - now)));
    });
    // A folder deleted under the watcher must not crash Truss.
    watcher.on('error', () => undefined);
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }

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

function isWatched(filename: string): boolean {
  const parts = filename.split(/[\\/]/);
  if (parts.slice(0, -1).some((dir) => SKIP_DIRS.has(dir))) return false;
  const name = parts.at(-1) ?? '';
  return WATCHED.test(name) && !name.startsWith('.');
}
