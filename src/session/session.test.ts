import { describe, expect, it, vi } from 'vitest';
import type { SynthResult } from '../core/assembly.ts';
import type { CatalogLoad, Files, Synth } from '../core/ports.ts';
import type { Migration } from '../core/sidecar.ts';
import type { View } from '../core/view.ts';
import { buildCatalog, digestAssembly, type Catalog } from '../core/catalog.ts';
import { TsSource } from '../adapters/source/ts-source.ts';
import { readFixtureAssembly, readFixtureFiles } from '../../test/support/fixture.ts';
import { Session } from './session.ts';

/** In-memory Files whose watch events are scripted by the test. `texts` holds the non-source files (the Sidecar) by name. */
class FakeFiles implements Files {
  watching = 0;
  private listeners = new Set<() => void>();
  texts: Map<string, string>;
  /** Names passed to `writeText`, in order. */
  writes: string[] = [];
  constructor(
    public files: Map<string, string> = new Map(),
    texts: Record<string, string> = {},
  ) {
    this.texts = new Map(Object.entries(texts));
  }
  read = async () => this.files;
  readText = async (name: string) => this.texts.get(name);
  writeText = async (name: string, text: string) => {
    this.writes.push(name);
    this.texts.set(name, text);
  };
  // An arrow property, so a test can spread a FakeFiles to override one method.
  watch = (onChange: () => void) => {
    this.listeners.add(onChange);
    this.watching++;
    return () => {
      this.listeners.delete(onChange);
      this.watching--;
    };
  };
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

const fixtureFiles = (texts: Record<string, string> = {}) => new FakeFiles(readFixtureFiles('straight-line'), texts);
const started = async (files: Files, migrations?: readonly Migration[]) => {
  const session = new Session({ appDir: '/app', files, synth: fakeSynth(good()), source: new TsSource(), ...(migrations ? { migrations } : {}) });
  await session.start();
  return session;
};

describe('Session Catalog', () => {
  const catalog = buildCatalog([
    digestAssembly({
      name: 'lib',
      version: '1.0.0',
      types: {
        'lib.s3.Bucket': { kind: 'class', fqn: 'lib.s3.Bucket', name: 'Bucket', namespace: 's3', base: 'constructs.Construct' },
        'lib.sqs.Queue': { kind: 'class', fqn: 'lib.sqs.Queue', name: 'Queue', namespace: 'sqs', base: 'constructs.Construct' },
      },
    }),
  ]);
  const session = (c?: Catalog) =>
    new Session({ appDir: '/work/app', synth: fakeSynth(good()), files: new FakeFiles(readFixtureFiles('straight-line')), source: new TsSource(), ...(c ? { catalog: c } : {}) });

  it('searches the Catalog it was handed', () => {
    expect(session(catalog).searchCatalog('bucket').map((h) => h.fqn)).toEqual(['lib.s3.Bucket']);
    expect(session(catalog).searchCatalog('').map((h) => h.name)).toEqual(['Bucket', 'Queue']);
    expect(session(catalog).searchCatalog('', 1)).toHaveLength(1);
  });

  it('finds nothing when it was handed no Catalog', () => {
    expect(session().searchCatalog('bucket')).toEqual([]);
  });
});

describe('Session Catalog refresh', () => {
  const catalogOf = (...names: string[]) =>
    buildCatalog([
      digestAssembly({
        name: 'lib',
        version: '1.0.0',
        types: Object.fromEntries(names.map((n) => [`lib.s3.${n}`, { kind: 'class', fqn: `lib.s3.${n}`, name: n, namespace: 's3', base: 'constructs.Construct' }])),
      }),
    ]);

  function setup(reload: () => Promise<CatalogLoad>) {
    const events: string[] = [];
    const files = new FakeFiles(readFixtureFiles('straight-line'));
    const synth: Synth = {
      synth: async () => {
        events.push('synth');
        return good();
      },
    };
    const session = new Session({
      appDir: '/app',
      source: new TsSource(),
      files,
      synth,
      catalog: catalogOf('Bucket'),
      reloadCatalog: async () => {
        events.push('catalog');
        return reload();
      },
    });
    return { session, files, events };
  }

  it('reads the Catalog again before each synth, so a changed aws-cdk-lib is searched from then on', async () => {
    let next: CatalogLoad = { ok: true, catalog: catalogOf('Bucket') };
    const { session, files, events } = setup(async () => next);
    await session.start();
    expect(events).toEqual(['catalog', 'synth']);
    expect(session.searchCatalog('').map((h) => h.name)).toEqual(['Bucket']);

    next = { ok: true, catalog: catalogOf('Bucket', 'Table') };
    files.change();
    await flush();
    await flush();
    expect(events).toEqual(['catalog', 'synth', 'catalog', 'synth']);
    expect(session.searchCatalog('').map((h) => h.name)).toEqual(['Bucket', 'Table']);
  });

  it('shows why when the app has moved to a version Truss cannot open, keeps the Design and the old Catalog, and does not synth', async () => {
    let next: CatalogLoad = { ok: true, catalog: catalogOf('Bucket') };
    const { session, files, events } = setup(async () => next);
    await session.start();

    next = { ok: false, message: 'aws-cdk-lib 2.100.0 is older than the minimum' };
    files.change();
    await flush();
    await flush();
    expect(events).toEqual(['catalog', 'synth', 'catalog']);
    expect(session.view()).toMatchObject({ synthing: false, hasDesign: true, error: { message: 'aws-cdk-lib 2.100.0 is older than the minimum' } });
    expect(session.searchCatalog('').map((h) => h.name)).toEqual(['Bucket']);

    next = { ok: true, catalog: catalogOf('Bucket') };
    files.change();
    await flush();
    await flush();
    expect(events.at(-1)).toBe('synth');
    expect(session.view().error).toBeUndefined();
  });

  it('shows a failure to read the Catalog as the reason, rather than throwing', async () => {
    const { session } = setup(async () => {
      throw new Error('disk gone');
    });
    await session.start();
    expect(session.view()).toMatchObject({ synthing: false, error: { message: 'disk gone' } });
  });
});

describe('Session Sidecar', () => {
  it('writes a dragged Node position to truss.json keyed by construct path, and shows it in the View', async () => {
    const files = fixtureFiles();
    const session = await started(files);

    const reply = await session.handle({ type: 'move', requestId: 'r1', id: 'ShopStack/Orders', x: 120.4, y: 80 });

    expect(reply).toEqual({ type: 'ack', requestId: 'r1' });
    expect(files.texts.get('truss.json')).toBe(
      '{\n  "formatVersion": 1,\n  "nodes": {\n    "ShopStack/Orders": {\n      "position": {\n        "x": 120,\n        "y": 80\n      }\n    }\n  }\n}\n',
    );
    expect(session.view().nodes.find((n) => n.id === 'ShopStack/Orders')?.position).toEqual({ x: 120, y: 80 });
    expect(session.view().nodes.find((n) => n.id === 'ShopStack/Uploads')?.position).toBeUndefined();
  });

  it('stores a Node note beside its position, and clearing it leaves the position', async () => {
    const files = fixtureFiles();
    const session = await started(files);
    const note = (text: string) => session.handle({ type: 'note', requestId: 'n', id: 'ShopStack/Orders', note: text });
    const stored = () => JSON.parse(files.texts.get('truss.json')!).nodes['ShopStack/Orders'];

    await session.handle({ type: 'move', requestId: 'm', id: 'ShopStack/Orders', x: 1, y: 2 });
    expect(await note('Retries 3x, then DLQ')).toEqual({ type: 'ack', requestId: 'n' });
    expect(stored()).toEqual({ note: 'Retries 3x, then DLQ', position: { x: 1, y: 2 } });
    expect(session.view().nodes.find((n) => n.id === 'ShopStack/Orders')?.note).toBe('Retries 3x, then DLQ');

    await note('Retries 5x');
    expect(stored().note).toBe('Retries 5x');

    await note('');
    expect(stored()).toEqual({ position: { x: 1, y: 2 } });
    expect(session.view().nodes.find((n) => n.id === 'ShopStack/Orders')?.note).toBeUndefined();
  });

  it('drops an entry that has neither a position nor a note left', async () => {
    const files = fixtureFiles();
    const session = await started(files);
    await session.handle({ type: 'note', requestId: 'a', id: 'ShopStack/Orders', note: 'x' });
    await session.handle({ type: 'note', requestId: 'b', id: 'ShopStack/Orders', note: '' });
    expect(JSON.parse(files.texts.get('truss.json')!).nodes).toEqual({});
  });

  it('refuses a request for a path that is not a Node in the Design, and writes nothing', async () => {
    const files = fixtureFiles();
    const session = await started(files);
    const reply = await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Nope', x: 1, y: 1 });
    expect(reply).toEqual({ type: 'refused', requestId: 'r', reason: expect.stringContaining('ShopStack/Nope') });
    expect(files.writes).toEqual([]);
  });

  const saved = (nodes: object, formatVersion = 1) => JSON.stringify({ formatVersion, nodes });

  it('shows the positions and notes an existing truss.json holds (round-trip)', async () => {
    const files = fixtureFiles({
      'truss.json': saved({ 'ShopStack/Uploads': { position: { x: 10, y: 20 }, note: 'Public uploads' } }),
    });
    const session = await started(files);
    const uploads = session.view().nodes.find((n) => n.id === 'ShopStack/Uploads');
    expect(uploads).toMatchObject({ position: { x: 10, y: 20 }, note: 'Public uploads' });
    expect(files.writes).toEqual([]);
  });

  it('keeps entries for paths missing from the current code, and writes keys in sorted order', async () => {
    const files = fixtureFiles({
      'truss.json': saved({
        'ShopStack/Zeta': { note: 'Removed on another branch' },
        'ShopStack/Uploads': { position: { y: 20, x: 10 } },
      }),
    });
    const session = await started(files);
    expect(session.view().nodes.map((n) => n.id)).not.toContain('ShopStack/Zeta');

    await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Orders', x: 5, y: 6 });

    const written = JSON.parse(files.texts.get('truss.json')!);
    expect(Object.keys(written.nodes)).toEqual(['ShopStack/Orders', 'ShopStack/Uploads', 'ShopStack/Zeta']);
    expect(written.nodes['ShopStack/Zeta']).toEqual({ note: 'Removed on another branch' });
    expect(Object.keys(written.nodes['ShopStack/Uploads'].position)).toEqual(['x', 'y']);
  });

  it('refuses a Sidecar from a newer Truss with a clear message, and leaves the file alone', async () => {
    const newer = saved({ 'ShopStack/Uploads': { position: { x: 1, y: 2 } } }, 7);
    const files = fixtureFiles({ 'truss.json': newer });
    const session = await started(files);

    expect(session.view()).toMatchObject({
      synthing: false,
      hasDesign: false,
      nodes: [],
      error: { kind: 'sidecar', message: expect.stringMatching(/truss\.json.*format 7.*newer.*upgrade Truss/i) },
    });
    const reply = await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Uploads', x: 5, y: 5 });
    expect(reply.type).toBe('refused');
    expect(files.texts.get('truss.json')).toBe(newer);
    expect(files.writes).toEqual([]);
  });

  it.each([
    ['is not JSON', '<<<<<<< HEAD'],
    ['has no formatVersion', JSON.stringify({ nodes: {} })],
    ['has a position without numbers', saved({ 'ShopStack/Orders': { position: { x: 'left', y: 1 } } })],
  ])('refuses a truss.json that %s, and leaves the file alone', async (_why, text) => {
    const files = fixtureFiles({ 'truss.json': text });
    const session = await started(files);
    expect(session.view()).toMatchObject({ nodes: [], error: { kind: 'sidecar', message: expect.stringContaining('truss.json') } });
    expect(files.texts.get('truss.json')).toBe(text);
  });

  it('keeps every change when requests arrive before the previous write has finished', async () => {
    const files = fixtureFiles();
    const slow: Files = {
      ...files,
      writeText: async (name, text) => {
        await new Promise((r) => setTimeout(r, 5));
        await files.writeText(name, text);
      },
    };
    const session = await started(slow);

    await Promise.all([
      session.handle({ type: 'move', requestId: 'a', id: 'ShopStack/Orders', x: 1, y: 1 }),
      session.handle({ type: 'note', requestId: 'b', id: 'ShopStack/Uploads', note: 'hi' }),
      session.handle({ type: 'move', requestId: 'c', id: 'ShopStack/Orders', x: 2, y: 2 }),
    ]);

    expect(JSON.parse(files.texts.get('truss.json')!).nodes).toEqual({
      'ShopStack/Orders': { position: { x: 2, y: 2 } },
      'ShopStack/Uploads': { note: 'hi' },
    });
  });

  it('refuses, and keeps its state, when the Sidecar cannot be written', async () => {
    const files = fixtureFiles();
    const session = await started({ ...files, writeText: async () => Promise.reject(new Error('EACCES: permission denied')) });
    const reply = await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Orders', x: 1, y: 1 });
    expect(reply).toEqual({ type: 'refused', requestId: 'r', reason: expect.stringContaining('EACCES') });
    expect(session.view().nodes.find((n) => n.id === 'ShopStack/Orders')?.position).toBeUndefined();
  });

  it("builds on what truss.json holds now, not what it held at start, so a branch switch isn't overwritten", async () => {
    const files = fixtureFiles({ 'truss.json': saved({ 'ShopStack/Uploads': { note: 'mine' } }) });
    const session = await started(files);
    // A teammate's version arrives on disk (git pull) while Truss is open.
    files.texts.set('truss.json', saved({ 'ShopStack/Uploads': { note: 'theirs' }, 'ShopStack/Catalog': { position: { x: 7, y: 8 } } }));

    await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Orders', x: 1, y: 2 });

    expect(JSON.parse(files.texts.get('truss.json')!).nodes).toEqual({
      'ShopStack/Uploads': { note: 'theirs' },
      'ShopStack/Catalog': { position: { x: 7, y: 8 } },
      'ShopStack/Orders': { position: { x: 1, y: 2 } },
    });
    expect(session.view().nodes.find((n) => n.id === 'ShopStack/Catalog')?.position).toEqual({ x: 7, y: 8 });
  });

  it('starts from an empty Sidecar when truss.json was deleted while Truss is open', async () => {
    const files = fixtureFiles({ 'truss.json': saved({ 'ShopStack/Uploads': { note: 'old' } }) });
    const session = await started(files);
    files.texts.delete('truss.json');
    await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Orders', x: 1, y: 2 });
    expect(JSON.parse(files.texts.get('truss.json')!).nodes).toEqual({ 'ShopStack/Orders': { position: { x: 1, y: 2 } } });
  });

  it('refuses, and writes nothing, when truss.json has become unusable since start', async () => {
    const files = fixtureFiles();
    const session = await started(files);
    files.texts.set('truss.json', saved({}, 9));
    const reply = await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Orders', x: 1, y: 2 });
    expect(reply).toEqual({ type: 'refused', requestId: 'r', reason: expect.stringContaining('format 9') });
    expect(files.writes).toEqual([]);
  });

  it('says there is no Design yet, not that the Node is missing, when nothing has synthed', async () => {
    const session = make({ files: fixtureFiles(), synth: fakeSynth(bad()) });
    await session.start();
    const reply = await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Orders', x: 1, y: 2 });
    expect(reply).toEqual({ type: 'refused', requestId: 'r', reason: expect.stringMatching(/no design/i) });
  });

  it('shows the Sidecar as the file holds it when files change, and recovers once a refused one is fixed', async () => {
    const files = fixtureFiles({ 'truss.json': saved({ 'ShopStack/Uploads': { position: { x: 1, y: 2 } } }) });
    const session = await started(files);
    const uploads = () => session.view().nodes.find((n) => n.id === 'ShopStack/Uploads');

    files.texts.set('truss.json', saved({ 'ShopStack/Uploads': { position: { x: 30, y: 40 } } }));
    files.change();
    await vi.waitFor(() => expect(uploads()?.position).toEqual({ x: 30, y: 40 }));

    files.texts.set('truss.json', saved({}, 9));
    files.change();
    await vi.waitFor(() => expect(session.view()).toMatchObject({ hasDesign: false, nodes: [], error: { kind: 'sidecar' } }));
    expect(files.texts.get('truss.json')).toBe(saved({}, 9));

    files.texts.set('truss.json', saved({ 'ShopStack/Uploads': { note: 'back' } }));
    files.change();
    await vi.waitFor(() => expect(session.view()).toMatchObject({ hasDesign: true, nodes: expect.any(Array) }));
    expect(session.view().error).toBeUndefined();
    expect(uploads()?.note).toBe('back');
  });

  describe('migration', () => {
    // Two made-up format changes: v1 -> v2 renamed `layout` to `nodes`; v2 -> v3 nested x and y under `position`.
    const migrations: readonly Migration[] = [
      ({ layout, ...rest }) => ({ ...rest, nodes: layout }),
      ({ nodes, ...rest }) => ({
        ...rest,
        nodes: Object.fromEntries(
          Object.entries(nodes as Record<string, { x: number; y: number }>).map(([path, { x, y }]) => [path, { position: { x, y } }]),
        ),
      }),
    ];
    const withMigrations = (files: FakeFiles) => {
      return started(files, migrations);
    };

    it('runs every step from the file\'s version to the current one, and writes the current version on the next change', async () => {
      const files = fixtureFiles({
        'truss.json': JSON.stringify({ formatVersion: 1, layout: { 'ShopStack/Uploads': { x: 3, y: 4 } } }),
      });
      const session = await withMigrations(files);

      expect(session.view().nodes.find((n) => n.id === 'ShopStack/Uploads')?.position).toEqual({ x: 3, y: 4 });
      expect(files.writes).toEqual([]);

      await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Orders', x: 9, y: 9 });
      expect(JSON.parse(files.texts.get('truss.json')!)).toEqual({
        formatVersion: 3,
        nodes: { 'ShopStack/Orders': { position: { x: 9, y: 9 } }, 'ShopStack/Uploads': { position: { x: 3, y: 4 } } },
      });
    });

    it('starts at the step after the file\'s version', async () => {
      const files = fixtureFiles({
        'truss.json': JSON.stringify({ formatVersion: 2, nodes: { 'ShopStack/Uploads': { x: 3, y: 4 } } }),
      });
      const session = await withMigrations(files);
      expect(session.view().nodes.find((n) => n.id === 'ShopStack/Uploads')?.position).toEqual({ x: 3, y: 4 });
    });

    it('refuses a format newer than the chain\'s end', async () => {
      const files = fixtureFiles({ 'truss.json': JSON.stringify({ formatVersion: 4, nodes: {} }) });
      const session = await withMigrations(files);
      expect(session.view().error).toMatchObject({ kind: 'sidecar', message: expect.stringContaining('format 4') });
    });
  });
});
