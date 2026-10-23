import type { Assembly, SynthError, SynthResult } from '../core/assembly.ts';
import { searchCatalog, type Catalog, type SearchHit } from '../core/catalog.ts';
import type { Facts } from '../core/facts.ts';
import type { FileSet, Files, Source, Synth } from '../core/ports.ts';
import type { ClientMessage, Reply } from '../core/protocol.ts';
import { currentFormatVersion, emptySidecar, MIGRATIONS, parseSidecar, serializeSidecar, SIDECAR_FILE, withNote, withPosition, type Migration, type Sidecar } from '../core/sidecar.ts';
import { locateError } from '../core/synth-error.ts';
import { buildView, type View } from '../core/view.ts';

export interface SessionDeps {
  appDir: string;
  synth: Synth;
  files: Files;
  source: Source;
  /** What the app's installed libraries offer, read at startup (ADR 0009). Absent, nothing can be searched. */
  catalog?: Catalog;
  /** The Sidecar's format history; only tests give their own. */
  migrations?: readonly Migration[];
}

/**
 * Holds the state for one app and is the only layer that calls the ports. The browser is a view
 * over it: every state change is pushed as the whole View, tagged with a version that only goes up.
 */
/** After this many stale results in a row the next one is shown anyway; the run behind it still follows. */
const MAX_STALE_IN_A_ROW = 2;

export class Session {
  private current: View = { version: 0, synthing: true, hasDesign: false, stages: [], stacks: [], nodes: [] };
  private listeners = new Set<(view: View) => void>();
  private unwatch: (() => void) | undefined;
  private stopped = false;
  /** The synth cycle in progress: the run, plus the one run that may be waiting behind it. */
  private cycle: Promise<void> | undefined;
  /** Set when the files changed during a run, so that run's result is stale and one more run is due. */
  private waiting = false;
  /** Results dropped as stale in a row, so continuous edits can't keep the Design from ever updating. */
  private staleInARow = 0;
  private sidecar: Sidecar = emptySidecar();
  /** Runs Sidecar changes and the showing of a synth result one at a time, so each builds on the one before. */
  private queue: Promise<unknown> = Promise.resolve();
  /** What the Design on screen was derived from; absent until a synth has succeeded with a usable Sidecar. */
  private snapshot: { facts: Facts; assembly: Assembly } | undefined;

  private readonly migrations: readonly Migration[];

  constructor(private readonly deps: SessionDeps) {
    this.migrations = deps.migrations ?? MIGRATIONS;
  }

  view(): View {
    return this.current;
  }

  /** The palette's search: constructs of the Catalog by name, service or CloudFormation type, best first. */
  searchCatalog(query: string, limit?: number): SearchHit[] {
    return this.deps.catalog ? searchCatalog(this.deps.catalog, query, limit) : [];
  }

  /** Calls `listener` with every new View. Returns an unsubscribe function. */
  subscribe(listener: (view: View) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Watches the app, then synths it and derives the first Design. Resolves when that synth is done. */
  async start(): Promise<void> {
    this.unwatch ??= this.deps.files.watch(() => void this.request());
    await this.request();
  }

  /** Stops watching. A synth already running finishes, but nothing is derived after it. */
  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = undefined;
  }

  /** Applies one request from the browser. Never throws: a failure is a refusal. */
  handle(message: ClientMessage): Promise<Reply> {
    return this.serialised(() => this.apply(message));
  }

  /**
   * Asks for a synth of the files as they are now. At most one runs and at most one waits: a request
   * while one is running makes it stale and queues a single run that reads the latest state.
   * Resolves when no run is left.
   */
  private request(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.cycle) {
      this.waiting = true;
      return this.cycle;
    }
    this.cycle = this.drain();
    return this.cycle;
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.waiting = false;
        await this.derive();
      } while (this.waiting && !this.stopped);
    } finally {
      // Cleared in the same turn as the loop's last check, so no request can slip in between.
      this.cycle = undefined;
    }
  }

  private async derive(): Promise<void> {
    this.push({ synthing: true });
    try {
      const [result, files] = await Promise.all([this.deps.synth.synth(this.deps.appDir), this.deps.files.read()]);
      if (this.stopped || this.isStale()) return;
      await this.serialised(() => this.show(result, files));
    } catch (err) {
      if (this.stopped || this.isStale()) return;
      this.fail({ message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Shows a synth result with the Sidecar as the file holds it now, not as it was when the synth began. */
  private async show(result: SynthResult, files: FileSet): Promise<void> {
    const sidecarText = await this.deps.files.readText(SIDECAR_FILE);
    const parsed = sidecarText === undefined ? { ok: true as const, sidecar: emptySidecar() } : parseSidecar(sidecarText, this.migrations);
    if (!parsed.ok) {
      this.snapshot = undefined;
      this.push({ synthing: false, hasDesign: false, error: { kind: 'sidecar', message: parsed.message }, stages: [], stacks: [], nodes: [] });
      return;
    }
    this.sidecar = parsed.sidecar;
    if (!result.ok) return this.fail(result.error);
    const facts = this.deps.source.analyse(files, result.assembly);
    this.snapshot = { facts, assembly: result.assembly };
    this.push({ synthing: false, hasDesign: true, error: undefined, ...buildView(facts, result.assembly, this.sidecar) });
  }

  /** Stale means the files changed during the run, so the next run reads newer ones; but only so many in a row. */
  private isStale(): boolean {
    if (this.waiting && this.staleInARow < MAX_STALE_IN_A_ROW) {
      this.staleInARow++;
      return true;
    }
    this.staleInARow = 0;
    return false;
  }

  /** Shows the error. The last good Design, if there is one, stays so the user keeps their bearings. */
  private fail(error: SynthError): void {
    const location = error.location ?? locateError(error, this.deps.appDir);
    this.push({ synthing: false, error: location ? { ...error, location } : error });
  }

  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async apply(message: ClientMessage): Promise<Reply> {
    const { requestId } = message;
    if (!this.snapshot) return { type: 'refused', requestId, reason: 'There is no Design to edit yet.' };
    if (!this.current.nodes.some((n) => n.id === message.id)) {
      return { type: 'refused', requestId, reason: `No Node at ${message.id}` };
    }
    let next: Sidecar;
    try {
      // The file may have changed since the last change (a branch switch, a pull), so build on what it holds now.
      const text = await this.deps.files.readText(SIDECAR_FILE);
      const parsed = text === undefined ? { ok: true as const, sidecar: emptySidecar() } : parseSidecar(text, this.migrations);
      if (!parsed.ok) return { type: 'refused', requestId, reason: parsed.message };
      next =
        message.type === 'move'
          ? withPosition(parsed.sidecar, message.id, message)
          : withNote(parsed.sidecar, message.id, message.note);
      await this.deps.files.writeText(SIDECAR_FILE, serializeSidecar(next, currentFormatVersion(this.migrations)));
    } catch (err) {
      return { type: 'refused', requestId, reason: `Couldn't update ${SIDECAR_FILE}: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.sidecar = next;
    this.push(buildView(this.snapshot.facts, this.snapshot.assembly, this.sidecar));
    return { type: 'ack', requestId };
  }

  private push(change: Partial<Omit<View, 'version'>>): void {
    const next: View = { ...this.current, ...change, version: this.current.version + 1 };
    if (next.error === undefined) delete next.error;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}
