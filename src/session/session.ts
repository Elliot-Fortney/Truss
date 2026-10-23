import type { SynthError } from '../core/assembly.ts';
import type { Files, Source, Synth } from '../core/ports.ts';
import { locateError } from '../core/synth-error.ts';
import { buildView, type View } from '../core/view.ts';

export interface SessionDeps {
  appDir: string;
  synth: Synth;
  files: Files;
  source: Source;
}

/**
 * Holds the state for one app and is the only layer that calls the ports. The browser is a view
 * over it: every state change is pushed as the whole View, tagged with a version that only goes up.
 */
export class Session {
  private current: View = { version: 0, synthing: true, hasDesign: false, stacks: [], nodes: [] };
  private listeners = new Set<(view: View) => void>();
  private unwatch: (() => void) | undefined;
  private stopped = false;
  /** The synth cycle in progress: the run, plus the one run that may be waiting behind it. */
  private cycle: Promise<void> | undefined;
  /** Set when the files changed during a run, so that run's result is stale and one more run is due. */
  private waiting = false;

  constructor(private readonly deps: SessionDeps) {}

  view(): View {
    return this.current;
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
      if (this.waiting || this.stopped) return; // Stale: the next run reads newer files.
      if (!result.ok) return this.fail(result.error);
      const facts = this.deps.source.analyse(files, result.assembly);
      this.push({ synthing: false, hasDesign: true, error: undefined, ...buildView(facts, result.assembly) });
    } catch (err) {
      if (this.waiting || this.stopped) return;
      this.fail({ message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Shows the error. The last good Design, if there is one, stays so the user keeps their bearings. */
  private fail(error: SynthError): void {
    const location = error.location ?? locateError(error, this.deps.appDir);
    this.push({ synthing: false, error: location ? { ...error, location } : error });
  }

  private push(change: Partial<Omit<View, 'version'>>): void {
    const next: View = { ...this.current, ...change, version: this.current.version + 1 };
    if (next.error === undefined) delete next.error;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}
