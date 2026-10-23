import type { Files, Source, Synth } from '../core/ports.ts';
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
  private current: View = { version: 0, synthing: true, stacks: [], nodes: [] };
  private listeners = new Set<(view: View) => void>();

  constructor(private readonly deps: SessionDeps) {}

  view(): View {
    return this.current;
  }

  /** Calls `listener` with every new View. Returns an unsubscribe function. */
  subscribe(listener: (view: View) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Synths the app and derives the first Design. */
  async start(): Promise<void> {
    this.push({ synthing: true });
    try {
      const [result, files] = await Promise.all([this.deps.synth.synth(this.deps.appDir), this.deps.files.read()]);
      if (!result.ok) {
        this.push({ synthing: false, error: result.error, stacks: [], nodes: [] });
        return;
      }
      const facts = this.deps.source.analyse(files, result.assembly);
      this.push({ synthing: false, error: undefined, ...buildView(facts, result.assembly) });
    } catch (err) {
      this.push({
        synthing: false,
        error: { message: err instanceof Error ? err.message : String(err) },
        stacks: [],
        nodes: [],
      });
    }
  }

  private push(change: Partial<Omit<View, 'version'>>): void {
    const next: View = { ...this.current, ...change, version: this.current.version + 1 };
    if (next.error === undefined) delete next.error;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}
