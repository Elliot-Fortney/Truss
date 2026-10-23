import type { FileSet, Files } from '../core/ports.ts';

export type CommitOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Writes the planned `overlay` to the app's files, all of them or none (ADR 0006). Refuses, writing
 * nothing, when a file it would touch differs on disk from the base it was planned on. When a write
 * fails, the files already written are put back and the ones that could not be written are named.
 */
export async function commit(files: Files, overlay: FileSet, baseFiles: FileSet): Promise<CommitOutcome> {
  const touched = [...overlay.keys()];
  const onDisk = await files.read();
  const changed = touched.filter((file) => onDisk.get(file) !== baseFiles.get(file));
  if (changed.length > 0) return { ok: false, reason: `${changed.join(', ')} changed on disk since Truss last read it. Nothing was saved; Truss is reading the new code.` };

  const written: string[] = [];
  try {
    for (const file of touched) {
      await files.writeText(file, overlay.get(file)!);
      written.push(file);
    }
  } catch (err) {
    for (const file of written) await files.writeText(file, baseFiles.get(file)!).catch(() => undefined);
    return { ok: false, reason: `Couldn't write ${touched.join(', ')}; nothing was saved: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true };
}
