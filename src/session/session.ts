import type { Assembly } from '../core/assembly.ts';
import type { Facts } from '../core/facts.ts';
import type { Files, Source, Synth } from '../core/ports.ts';
import type { ClientMessage, Reply } from '../core/protocol.ts';
import { currentFormatVersion, emptySidecar, MIGRATIONS, parseSidecar, serializeSidecar, SIDECAR_FILE, withNote, withPosition, type Migration, type Sidecar } from '../core/sidecar.ts';
import { buildView, type View } from '../core/view.ts';

export interface SessionDeps {
  appDir: string;
  synth: Synth;
  files: Files;
  source: Source;
  /** The Sidecar's format history; only tests give their own. */
  migrations?: readonly Migration[];
}

/**
 * Holds the state for one app and is the only layer that calls the ports. The browser is a view
 * over it: every state change is pushed as the whole View, tagged with a version that only goes up.
 */
export class Session {
  private current: View = { version: 0, synthing: true, stacks: [], nodes: [] };
  private listeners = new Set<(view: View) => void>();
  private sidecar: Sidecar = emptySidecar();
  private queue: Promise<unknown> = Promise.resolve();
  private snapshot: { facts: Facts; assembly: Assembly } | undefined;

  private readonly migrations: readonly Migration[];

  constructor(private readonly deps: SessionDeps) {
    this.migrations = deps.migrations ?? MIGRATIONS;
  }

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
      const [result, files, sidecarText] = await Promise.all([
        this.deps.synth.synth(this.deps.appDir),
        this.deps.files.read(),
        this.deps.files.readText(SIDECAR_FILE),
      ]);
      if (sidecarText !== undefined) {
        const parsed = parseSidecar(sidecarText, this.migrations);
        if (!parsed.ok) {
          this.push({ synthing: false, error: { kind: 'sidecar', message: parsed.message }, stacks: [], nodes: [] });
          return;
        }
        this.sidecar = parsed.sidecar;
      }
      if (!result.ok) {
        this.push({ synthing: false, error: { kind: 'synth', ...result.error }, stacks: [], nodes: [] });
        return;
      }
      const facts = this.deps.source.analyse(files, result.assembly);
      this.snapshot = { facts, assembly: result.assembly };
      this.push({ synthing: false, error: undefined, ...buildView(facts, result.assembly, this.sidecar) });
    } catch (err) {
      this.push({
        synthing: false,
        error: { kind: 'synth', message: err instanceof Error ? err.message : String(err) },
        stacks: [],
        nodes: [],
      });
    }
  }

  /** Applies one request from the browser. Never throws: a failure is a refusal. */
  handle(message: ClientMessage): Promise<Reply> {
    // One at a time, so each change is built on the one before it.
    const reply = this.queue.then(() => this.apply(message));
    this.queue = reply.then(() => undefined);
    return reply;
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
