import type { Assembly, SynthResult } from './assembly.ts';
import type { Catalog } from './catalog.ts';
import type { TextChange } from './diff.ts';
import type { Facts } from './facts.ts';
import type { Intent } from './intents.ts';

/** The app's source files, by path relative to the app folder. */
export type FileSet = ReadonlyMap<string, string>;

/** Whether the app can be synthed with a Draft applied (ADR 0007), and if not, why. */
export type DraftSupport = { ok: true } | { ok: false; reason: string };

export interface Synth {
  /**
   * Synths the app in `appDir`. Never throws for a broken app; returns the synth error instead. With
   * `overlay`, synths a shadow copy of the app in which those files (by path relative to the app folder)
   * have that text, and the real files are left alone.
   */
  synth(appDir: string, opts?: { signal?: AbortSignal; overlay?: FileSet }): Promise<SynthResult>;
  /** Whether `synth` can be given an `overlay` for this app. Absent: it always can. */
  draftSupport?(appDir: string): Promise<DraftSupport>;
}

/** The changes that make the code say what the intents mean, by file; or the first intent Source could not place, and why. */
export type PlanResult =
  | { ok: true; changes: Record<string, TextChange[]> }
  | { ok: false; intent: number; reason: string; uses?: SourceUse[] };

/** A place in the app's code that uses a construct an intent would remove. Lines and columns are 1-based. */
export interface SourceUse {
  file: string;
  line: number;
  col: number;
  /** The line of code the use is on, trimmed. */
  text: string;
}

/** A TypeScript error or warning in a file of the app. */
export interface Diagnostic {
  file: string;
  line: number;
  code: number;
  message: string;
}

export interface Source {
  /** What the code says about the Design. With the Catalog, also the calls that make Grants, Integrations and Network Connections. */
  analyse(files: FileSet, assembly: Assembly, catalog?: Catalog): Facts;
  /** Plans the text changes for `intents` against `files`, which `facts` were read from. Writes nothing. */
  plan(files: FileSet, facts: Facts, intents: readonly Intent[]): PlanResult;
  /** The TypeScript diagnostics of the `touched` files, type-checked as part of the app in `appDir` with `files` in place of what is on disk. */
  diagnostics(appDir: string, files: FileSet, touched: readonly string[]): Diagnostic[];
}

export interface Files {
  /** Reads the app's TypeScript sources, keyed by path relative to the app folder. */
  read(): Promise<FileSet>;
  /** Reads one file next to `cdk.json` as text, or `undefined` when it doesn't exist. */
  readText(name: string): Promise<string | undefined>;
  /** Writes one file next to `cdk.json`, whole or not at all. */
  writeText(name: string, text: string): Promise<void>;

  /**
   * Calls `onChange` when anything in the app folder that can change the Design is touched: an
   * editor save, `git pull`, a formatter, a new `package-lock.json`. Events are already debounced.
   * Returns a function that stops watching.
   */
  watch(onChange: () => void): () => void;
}

/**
 * Truss's answer to an app at startup: its Catalog, or why Truss can't open it (ADR 0009). Not a port
 * the session calls: the composition root asks once, and hands the session the Catalog as plain data.
 */
export type CatalogLoad = { ok: true; catalog: Catalog } | { ok: false; message: string };

/** Reads the Catalog from the packages the app at `appDir` has installed. */
export type LoadCatalog = (appDir: string) => Promise<CatalogLoad>;
