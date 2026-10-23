import { describe, expect, it } from 'vitest';
import type { SynthResult } from '../core/assembly.ts';
import type { Files, Synth } from '../core/ports.ts';
import type { View } from '../core/view.ts';
import { TsSource } from '../adapters/source/ts-source.ts';
import { readFixtureAssembly, readFixtureFiles } from '../../test/support/fixture.ts';
import { Session } from './session.ts';

/** In-memory Files whose watch events are scripted by the test. */
class FakeFiles implements Files {
  watching = 0;
  private listeners = new Set<() => void>();
  constructor(public files: Map<string, string> = new Map()) {}
  read = async () => this.files;
  watch(onChange: () => void) {
    this.listeners.add(onChange);
    this.watching++;
    return () => {
      this.listeners.delete(onChange);
      this.watching--;
    };
  }
  change(): void {
    for (const l of this.listeners) l();
  }
}

/** A Synth whose every call waits for the test to settle it. */
class ScriptedSynth implements Synth {
  calls: Array<{ settle(result: SynthResult): void }> = [];
  synth(): Promise<SynthResult> {
    return new Promise((resolve) => this.calls.push({ settle: resolve }));
  }
}

const fakeSynth = (result: SynthResult): Synth => ({ synth: async () => result });
const good = (): SynthResult => ({ ok: true, assembly: readFixtureAssembly('straight-line') });
const withoutOrders = (): SynthResult => {
  const assembly = readFixtureAssembly('straight-line');
  const stack = assembly.tree.children.find((c) => c.path === 'ShopStack')!;
  stack.children = stack.children.filter((c) => c.path !== 'ShopStack/Orders');
  return { ok: true, assembly };
};
const bad = (message = 'boom'): SynthResult => ({ ok: false, error: { message, output: 'trace' } });

const straightLine = () => ({
  files: new FakeFiles(readFixtureFiles('straight-line')),
  synth: fakeSynth(good()),
});
const make = (deps: { files: Files; synth: Synth }) => new Session({ appDir: '/app', source: new TsSource(), ...deps });
const nodeIds = (view: View) => view.nodes.map((n) => n.id);
/** Lets promise continuations and the session's awaited reads run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Session', () => {
  it('starts with an empty view that is still synthing', () => {
    const session = make(straightLine());
    expect(session.view()).toMatchObject({ version: 0, synthing: true, hasDesign: false, nodes: [], stacks: [] });
  });

  it('derives the Design from the fake synth, the in-memory files and the real Source', async () => {
    const session = make(straightLine());
    await session.start();
    const view = session.view();
    expect(view.synthing).toBe(false);
    expect(view.hasDesign).toBe(true);
    expect(view.stacks).toEqual([{ id: 'ShopStack', label: 'ShopStack', env: 'us-east-1 · 123456789012' }]);
    expect(view.nodes.map((n) => [n.id, n.stackId, n.subtitle])).toEqual([
      ['ShopStack/Uploads', 'ShopStack', 'Bucket'],
      ['ShopStack/Orders', 'ShopStack', 'Queue'],
      ['ShopStack/Catalog', 'ShopStack', 'Table'],
    ]);
  });

  it('pushes every state change with a version that only goes up', async () => {
    const session = make(straightLine());
    const pushed: number[] = [];
    session.subscribe((v) => pushed.push(v.version));
    await session.start();
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    expect(pushed).toEqual([...pushed].sort((a, b) => a - b));
    expect(new Set(pushed).size).toBe(pushed.length);
  });

  it('stops sending pushes to a listener that unsubscribed', async () => {
    const session = make(straightLine());
    const pushed: number[] = [];
    const off = session.subscribe((v) => pushed.push(v.version));
    off();
    await session.start();
    expect(pushed).toEqual([]);
  });

  it('shows an error instead of staying on "synthing…" when reading the files fails', async () => {
    const files = new FakeFiles();
    files.read = () => Promise.reject(new Error('EACCES: permission denied'));
    const session = make({ files, synth: straightLine().synth });
    await session.start();
    expect(session.view()).toMatchObject({ synthing: false, error: { message: expect.stringContaining('EACCES') } });
  });

  describe('when the first synth fails', () => {
    it('shows the synth error with no Design', async () => {
      const session = make({ files: new FakeFiles(), synth: fakeSynth(bad()) });
      await session.start();
      expect(session.view()).toMatchObject({
        synthing: false,
        hasDesign: false,
        error: { message: 'boom', output: 'trace' },
        nodes: [],
      });
    });

    it('attributes the error to file:line where the trace allows', async () => {
      const synth = fakeSynth({ ok: false, error: { message: 'x', output: 'at new ShopStack (/app/lib/shop-stack.ts:12:9)' } });
      const session = make({ files: new FakeFiles(), synth });
      await session.start();
      expect(session.view().error?.location).toEqual({ file: 'lib/shop-stack.ts', line: 12, col: 9 });
    });

    it('keeps watching and loads the Design as soon as synth succeeds', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      const results = [bad(), good()];
      const session = make({ files, synth: { synth: async () => results.shift()! } });
      await session.start();
      expect(session.view().hasDesign).toBe(false);

      files.change();
      await flush();
      expect(session.view()).toMatchObject({ synthing: false, hasDesign: true });
      expect(session.view().error).toBeUndefined();
      expect(nodeIds(session.view())).toHaveLength(3);
    });
  });

  describe('when files change', () => {
    it('re-derives the Design', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      const results = [good(), withoutOrders()];
      const session = make({ files, synth: { synth: async () => results.shift()! } });
      await session.start();
      expect(nodeIds(session.view())).toContain('ShopStack/Orders');

      files.change();
      await flush();
      expect(nodeIds(session.view())).not.toContain('ShopStack/Orders');
    });

    it('shows "synthing…" while synth runs, then clears it', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      const synth = new ScriptedSynth();
      const session = make({ files, synth });
      const started = session.start();
      await flush();
      synth.calls[0]!.settle(good());
      await started;
      expect(session.view().synthing).toBe(false);

      files.change();
      await flush();
      expect(session.view().synthing).toBe(true);
      expect(session.view().hasDesign).toBe(true);
      synth.calls[1]!.settle(good());
      await flush();
      expect(session.view().synthing).toBe(false);
    });

    it('runs one synth at a time, and a burst of changes while one runs makes one more', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      const synth = new ScriptedSynth();
      const session = make({ files, synth });
      void session.start();
      await flush();
      expect(synth.calls).toHaveLength(1);

      files.change();
      files.change();
      files.change();
      await flush();
      expect(synth.calls).toHaveLength(1);

      synth.calls[0]!.settle(good());
      await flush();
      expect(synth.calls).toHaveLength(2);

      synth.calls[1]!.settle(good());
      await flush();
      expect(synth.calls).toHaveLength(2);
    });

    it('drops the result of a synth that a later change made stale', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      const synth = new ScriptedSynth();
      const session = make({ files, synth });
      const pushed: View[] = [];
      session.subscribe((v) => pushed.push(v));
      void session.start();
      await flush();

      files.change();
      synth.calls[0]!.settle(good());
      await flush();
      expect(pushed.some((v) => v.hasDesign)).toBe(false);
      expect(session.view().synthing).toBe(true);

      synth.calls[1]!.settle(withoutOrders());
      await flush();
      expect(nodeIds(session.view())).toEqual(['ShopStack/Uploads', 'ShopStack/Catalog']);
      expect(pushed.filter((v) => v.hasDesign)).toHaveLength(1);
    });

    it('still shows a result when edits keep arriving, so the Design is never starved', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      const synth = new ScriptedSynth();
      const session = make({ files, synth });
      void session.start();
      await flush();

      // An edit lands during every run. The first two results are dropped, the third is shown.
      for (let run = 0; run < 3; run++) {
        files.change();
        synth.calls[run]!.settle(good());
        await flush();
        expect(session.view().hasDesign).toBe(run === 2);
      }
      expect(synth.calls).toHaveLength(4);
    });

    it('reads the files for the waiting synth after the change, not before', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      const synth = new ScriptedSynth();
      let reads = 0;
      const read = files.read;
      files.read = () => (reads++, read());
      const session = make({ files, synth });
      void session.start();
      await flush();
      const before = reads;

      files.change();
      synth.calls[0]!.settle(good());
      await flush();
      expect(reads).toBe(before + 1);
    });

    it('keeps the last good Design, with the error, when synth fails after an outside change', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      const results = [good(), bad('app threw')];
      const session = make({ files, synth: { synth: async () => results.shift()! } });
      await session.start();
      const before = session.view();

      files.change();
      await flush();
      const view = session.view();
      expect(view).toMatchObject({ synthing: false, hasDesign: true, error: { message: 'app threw' } });
      expect(view.nodes).toEqual(before.nodes);
      expect(view.stacks).toEqual(before.stacks);
    });

    it('recovers by itself when the next change synths again', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      const results = [good(), bad(), withoutOrders()];
      const session = make({ files, synth: { synth: async () => results.shift()! } });
      await session.start();
      files.change();
      await flush();
      expect(session.view().error).toBeDefined();

      files.change();
      await flush();
      expect(session.view().error).toBeUndefined();
      expect(nodeIds(session.view())).toEqual(['ShopStack/Uploads', 'ShopStack/Catalog']);
    });

    it('does not retry a failed synth on its own', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      let calls = 0;
      const session = make({ files, synth: { synth: async () => (calls++, bad()) } });
      await session.start();
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toBe(1);
    });
  });

  describe('stop', () => {
    it('stops watching', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      const session = make({ files, synth: fakeSynth(good()) });
      await session.start();
      expect(files.watching).toBe(1);
      session.stop();
      expect(files.watching).toBe(0);
    });

    it('does not start another synth for a change that arrives while stopping', async () => {
      const files = new FakeFiles(readFixtureFiles('straight-line'));
      const synth = new ScriptedSynth();
      const session = make({ files, synth });
      void session.start();
      await flush();
      files.change();
      session.stop();
      synth.calls[0]!.settle(good());
      await flush();
      expect(synth.calls).toHaveLength(1);
    });
  });
});
