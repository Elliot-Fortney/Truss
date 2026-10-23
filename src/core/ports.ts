import type { Assembly, SynthResult } from './assembly.ts';
import type { Facts } from './facts.ts';

/** The app's source files, by path relative to the app folder. */
export type FileSet = ReadonlyMap<string, string>;

export interface Synth {
  /** Synths the app in `appDir`. Never throws for a broken app; returns the synth error instead. */
  synth(appDir: string, opts?: { signal?: AbortSignal }): Promise<SynthResult>;
}

export interface Source {
  analyse(files: FileSet, assembly: Assembly): Facts;
}

export interface Files {
  /** Reads the app's TypeScript sources, keyed by path relative to the app folder. */
  read(): Promise<FileSet>;
  /**
   * Calls `onChange` when anything in the app folder that can change the Design is touched: an
   * editor save, `git pull`, a formatter, a new `package-lock.json`. Events are already debounced.
   * Returns a function that stops watching.
   */
  watch(onChange: () => void): () => void;
}
