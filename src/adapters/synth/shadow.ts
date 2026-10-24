import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { DraftSupport, FileSet } from '../../core/ports.ts';

/** Left out of a shadow copy: dependencies are linked, not copied, and the rest is output or history. */
const NOT_COPIED = new Set(['node_modules', 'cdk.out', '.git']);

/** The `app` command in `cdk.json`, or undefined when there is none to read. */
export async function appCommandOf(appDir: string): Promise<string | undefined> {
  try {
    const app = (JSON.parse(await readFile(join(appDir, 'cdk.json'), 'utf8')) as { app?: unknown }).app;
    return typeof app === 'string' ? app : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the command runs JavaScript the app's `build` script produced, rather than TypeScript through `ts-node` or `tsx`. */
export function runsCompiledJs(command: string): boolean {
  return /(^|[\s;&|])node\s[^;&|]*\.[cm]?js\b/.test(command) && !/\b(ts-node|tsx)\b/.test(command);
}

async function buildScriptOf(appDir: string): Promise<string | undefined> {
  try {
    const scripts = (
      JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    ).scripts;
    return typeof scripts?.build === 'string' ? scripts.build : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a Draft can be synthed for the app (ADR 0007): an app that runs compiled JS needs a `build` script to compile the Draft with. */
export async function draftSupportOf(appDir: string): Promise<DraftSupport> {
  const command = await appCommandOf(appDir);
  if (command === undefined || !runsCompiledJs(command)) return { ok: true };
  if (await buildScriptOf(appDir)) return { ok: true };
  return {
    ok: false,
    reason: `The app runs compiled JavaScript (${command}) and package.json has no "build" script, so Truss can't preview an edit before it is saved. Add a build script to edit this app.`,
  };
}

/** Whether the app has to be built in a shadow copy before it is synthed. */
export async function needsBuild(appDir: string): Promise<boolean> {
  const command = await appCommandOf(appDir);
  return command !== undefined && runsCompiledJs(command);
}

export interface Shadow {
  dir: string;
  remove(): Promise<void>;
}

/**
 * A copy of the app in a temporary folder: its files copied, `node_modules` linked, and the files of
 * `overlay` (by path relative to the app) written over them. The folder is the real path, so the
 * paths in a creation stack come out relative to it.
 */
export async function makeShadow(appDir: string, overlay: FileSet): Promise<Shadow> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'truss-shadow-')));
  const remove = () => rm(dir, { recursive: true, force: true });
  try {
    await cp(appDir, dir, { recursive: true, filter: (src) => src === appDir || !NOT_COPIED.has(basename(src)) });
    await symlink(join(appDir, 'node_modules'), join(dir, 'node_modules'), 'junction').catch(
      (err: NodeJS.ErrnoException) => {
        // An app with no dependencies of its own (a monorepo that hoists them) has nothing to link.
        if (err.code !== 'ENOENT' && err.code !== 'EEXIST') throw err;
      },
    );
    for (const [file, text] of overlay) {
      const rel = relative(dir, join(dir, file));
      if (isAbsolute(file) || rel.startsWith('..')) throw new Error(`${file} is outside the app`);
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), text);
    }
    return { dir, remove };
  } catch (err) {
    await remove();
    throw err;
  }
}
