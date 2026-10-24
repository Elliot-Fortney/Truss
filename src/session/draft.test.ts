import { describe, expect, it, vi } from 'vitest';
import type { SynthResult } from '../core/assembly.ts';
import { buildCatalog, digestAssembly } from '../core/catalog.ts';
import type { PropValue } from '../core/intents.ts';
import type { Diagnostic, DraftSupport, FileSet, Files, Synth } from '../core/ports.ts';
import type { Reply } from '../core/protocol.ts';
import { TsSource } from '../adapters/source/ts-source.ts';
import { memoryFiles, type MemoryFiles } from '../../test/support/memory-files.ts';
import { readFixtureAssembly, readFixtureFiles } from '../../test/support/fixture.ts';
import { Session } from './session.ts';

const doc = (summary: string) => ({ summary, stability: 'stable' });
const prop = (name: string, type: unknown, optional = true) => ({
  name,
  type,
  docs: doc(`The ${name}.`),
  ...(optional ? { optional: true } : {}),
});
const cls = (fqn: string, propsFqn: string) => ({
  kind: 'class',
  fqn,
  name: fqn.split('.').at(-1),
  namespace: fqn.split('.')[1],
  base: 'constructs.Construct',
  docs: doc(`A ${fqn}.`),
  initializer: {
    parameters: [
      { name: 'scope', type: { fqn: 'constructs.Construct' } },
      { name: 'id', type: { primitive: 'string' } },
      { name: 'props', optional: true, type: { fqn: propsFqn } },
    ],
  },
});
const struct = (fqn: string, properties: unknown[]) => ({
  kind: 'interface',
  datatype: true,
  fqn,
  name: fqn.split('.').at(-1),
  properties,
});

/** A small aws-cdk-lib with the three constructs of the straight-line fixture. */
const catalog = buildCatalog([
  digestAssembly({
    name: 'aws-cdk-lib',
    version: '2.274.0',
    types: Object.fromEntries(
      [
        cls('aws-cdk-lib.aws_s3.Bucket', 'aws-cdk-lib.aws_s3.BucketProps'),
        struct('aws-cdk-lib.aws_s3.BucketProps', [
          prop('versioned', { primitive: 'boolean' }),
          prop('bucketName', { primitive: 'string' }),
          prop('removalPolicy', { fqn: 'aws-cdk-lib.RemovalPolicy' }),
        ]),
        cls('aws-cdk-lib.aws_sqs.Queue', 'aws-cdk-lib.aws_sqs.QueueProps'),
        struct('aws-cdk-lib.aws_sqs.QueueProps', [
          prop('visibilityTimeout', { fqn: 'aws-cdk-lib.Duration' }),
          prop('fifo', { primitive: 'boolean' }),
        ]),
        cls('aws-cdk-lib.aws_dynamodb.Table', 'aws-cdk-lib.aws_dynamodb.TableProps'),
        struct('aws-cdk-lib.aws_dynamodb.TableProps', [
          prop('partitionKey', { fqn: 'aws-cdk-lib.aws_dynamodb.Attribute' }, false),
          prop('tableName', { primitive: 'string' }),
        ]),
        struct('aws-cdk-lib.aws_dynamodb.Attribute', [
          prop('name', { primitive: 'string' }, false),
          prop('type', { fqn: 'aws-cdk-lib.aws_dynamodb.AttributeType' }, false),
        ]),
        {
          kind: 'enum',
          fqn: 'aws-cdk-lib.aws_dynamodb.AttributeType',
          name: 'AttributeType',
          members: [{ name: 'STRING' }, { name: 'NUMBER' }],
        },
        {
          kind: 'enum',
          fqn: 'aws-cdk-lib.RemovalPolicy',
          name: 'RemovalPolicy',
          members: [{ name: 'DESTROY' }, { name: 'RETAIN' }],
        },
        cls('aws-cdk-lib.aws_sns.Topic', 'aws-cdk-lib.aws_sns.TopicProps'),
        struct('aws-cdk-lib.aws_sns.TopicProps', [
          prop('displayName', { primitive: 'string' }, false),
          prop('fifo', { primitive: 'boolean' }),
        ]),
        { kind: 'class', fqn: 'aws-cdk-lib.Duration', name: 'Duration' },
      ].map((t) => [t.fqn, t]),
    ),
  }),
]);

const SHOP = 'lib/shop-stack.ts';
const good = (): SynthResult => ({ ok: true, assembly: readFixtureAssembly('straight-line') });

/** A Synth that records each call, and answers every one with the straight-line fixture unless told otherwise. */
class FakeSynth implements Synth {
  calls: { overlay?: FileSet }[] = [];
  result: (overlay?: FileSet) => SynthResult | Promise<SynthResult> = () => good();
  support: DraftSupport = { ok: true };
  synth(_appDir: string, opts: { overlay?: FileSet } = {}): Promise<SynthResult> {
    this.calls.push(opts.overlay ? { overlay: opts.overlay } : {});
    return Promise.resolve(this.result(opts.overlay));
  }
  draftSupport = async () => this.support;
  get shadowCalls() {
    return this.calls.filter((c) => c.overlay);
  }
}

/** MemoryFiles whose watch events the test fires, and whose source files the test can change under the session. */
interface Rig {
  session: Session;
  files: MemoryFiles & { sources: Map<string, string>; change(): void };
  synth: FakeSynth;
}

async function rig(opts: { source?: TsSource; synth?: FakeSynth } = {}): Promise<Rig> {
  const sources = readFixtureFiles('straight-line');
  const memory = memoryFiles(sources);
  const listeners = new Set<() => void>();
  const files = Object.assign(memory, {
    sources,
    read: async () => new Map(sources),
    change: () => {
      listeners.forEach((l) => {
        l();
      });
    },
    watch: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  }) as Rig['files'];
  const synth = opts.synth ?? new FakeSynth();
  const session = new Session({
    appDir: '/app',
    synth,
    files: files,
    source: opts.source ?? new TsSource(),
    catalog,
  });
  await session.start();
  return { session, files, synth };
}

let n = 0;
const set = (r: Rig, id: string, prop: string | string[], value: PropValue): Promise<Reply> =>
  r.session.handle({ type: 'setProp', requestId: `r${++n}`, id, prop: Array.isArray(prop) ? prop : [prop], value });
const send = (r: Rig, type: 'undo' | 'redo' | 'save' | 'discard'): Promise<Reply> =>
  r.session.handle({ type, requestId: `r${++n}` });
const settled = (r: Rig) =>
  vi.waitFor(() => {
    expect(r.session.view().synthing).toBe(false);
  });
const bool = (value: boolean): PropValue => ({ kind: 'boolean', value });
const refusal = (reply: Reply) => (reply.type === 'refused' ? reply.reason : `not refused: ${reply.type}`);
const UPLOADS = 'ShopStack/Uploads';

describe('the Draft', () => {
  it('stages a setProp as an intent, shows it at once, and synths a shadow copy with its text', async () => {
    const r = await rig();
    expect(await set(r, UPLOADS, 'versioned', bool(false))).toMatchObject({ type: 'ack' });
    // At once, before synth has caught up: the list, the badge, the diff.
    const view = r.session.view();
    expect(view.draft?.items).toEqual([{ id: UPLOADS, label: 'Uploads', summary: 'versioned → false' }]);
    expect(view.nodes.find((x) => x.id === UPLOADS)?.changed).toBe(true);
    expect(view.nodes.find((x) => x.id === 'ShopStack/Orders')?.changed).toBeUndefined();
    expect(view.draft?.diffs).toHaveLength(1);
    expect(view.draft?.diffs[0]?.diff).toContain('-      versioned: true,\n+      versioned: false,');
    expect(view.synthing).toBe(true);

    await settled(r);
    expect(r.synth.shadowCalls).toHaveLength(1);
    expect(r.synth.shadowCalls[0]!.overlay!.get(SHOP)).toContain('versioned: false');
    expect(r.session.view().draft?.problems).toEqual([]);
    // Nothing reaches the user's files until Save.
    expect(r.files.writes).toEqual([]);
    expect(r.files.sources.get(SHOP)).toContain('versioned: true');
  });

  it('shows the staged value in the property panel before synth has caught up', async () => {
    const synth = new FakeSynth();
    const r = await rig({ synth });
    synth.result = () => new Promise(() => undefined);
    await set(r, UPLOADS, 'versioned', bool(false));
    const reply = await r.session.handle({ type: 'panel', requestId: 'p', id: UPLOADS });
    const row = reply.type === 'panel' ? reply.panel.rows.find((x) => x.name === 'versioned') : undefined;
    expect(row).toMatchObject({ written: { kind: 'literal', value: false }, input: { kind: 'boolean' } });
  });

  it('coalesces a run of edits to one field into one Draft item, and keeps edits to other fields apart', async () => {
    const r = await rig();
    await set(r, UPLOADS, 'bucketName', { kind: 'string', value: 'a' });
    await set(r, UPLOADS, 'bucketName', { kind: 'string', value: 'ab' });
    await set(r, UPLOADS, 'versioned', bool(false));
    expect(r.session.view().draft?.items.map((i) => i.summary)).toEqual(['bucketName → "ab"', 'versioned → false']);
  });

  it('undo pops the last intent and redo pushes it back, without touching disk', async () => {
    const r = await rig();
    await set(r, UPLOADS, 'versioned', bool(false));
    await set(r, 'ShopStack/Orders', 'fifo', bool(true));
    await settled(r);

    expect(await send(r, 'undo')).toMatchObject({ type: 'ack' });
    expect(r.session.view().draft).toMatchObject({
      items: [{ summary: 'versioned → false' }],
      canUndo: true,
      canRedo: true,
    });
    expect(await send(r, 'redo')).toMatchObject({ type: 'ack' });
    expect(r.session.view().draft?.items.map((i) => i.id)).toEqual([UPLOADS, 'ShopStack/Orders']);
    expect(r.session.view().draft?.canRedo).toBe(false);
    expect(r.files.writes).toEqual([]);
  });

  it('a new edit ends redo', async () => {
    const r = await rig();
    await set(r, UPLOADS, 'versioned', bool(false));
    await send(r, 'undo');
    expect(r.session.view().draft?.canRedo).toBe(true);
    await set(r, UPLOADS, 'bucketName', { kind: 'string', value: 'x' });
    expect(r.session.view().draft?.canRedo).toBe(false);
  });

  it('undoing the last intent shows the Design on disk again without a synth', async () => {
    const r = await rig();
    await set(r, UPLOADS, 'versioned', bool(false));
    await settled(r);
    const synths = r.synth.calls.length;
    await send(r, 'undo');
    expect(r.session.view()).toMatchObject({ synthing: false, hasDesign: true });
    expect(r.session.view().nodes.find((x) => x.id === UPLOADS)?.changed).toBeUndefined();
    expect(r.synth.calls).toHaveLength(synths);
    // Redo is still on offer, so the Draft view stays.
    expect(r.session.view().draft).toMatchObject({ items: [], canRedo: true });
  });

  it('discard drops the whole Draft, redo included', async () => {
    const r = await rig();
    await set(r, UPLOADS, 'versioned', bool(false));
    await set(r, 'ShopStack/Orders', 'fifo', bool(true));
    await send(r, 'undo');
    await send(r, 'discard');
    expect(r.session.view().draft).toBeUndefined();
    expect(r.session.draftSize()).toBe(0);
    expect(r.files.writes).toEqual([]);
  });

  it('puts a value back to what the code says and the Draft holds nothing', async () => {
    const r = await rig();
    await set(r, UPLOADS, 'versioned', bool(false));
    await set(r, UPLOADS, 'versioned', bool(true));
    expect(r.session.draftSize()).toBe(0);
  });

  it('sets a field of an object-literal prop, and a Duration', async () => {
    const r = await rig();
    expect(await set(r, 'ShopStack/Catalog', ['partitionKey', 'name'], { kind: 'string', value: 'id' })).toMatchObject({
      type: 'ack',
    });
    expect(
      await set(r, 'ShopStack/Orders', 'visibilityTimeout', { kind: 'duration', unit: 'minutes', amount: 2 }),
    ).toMatchObject({ type: 'ack' });
    const diff = r.session.view().draft!.diffs[0]!.diff;
    expect(diff).toContain("+      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },");
    expect(diff).toContain('+      visibilityTimeout: cdk.Duration.minutes(2),');
  });

  it('does not paint a discarded Draft when its synth finishes after the discard', async () => {
    const synth = new FakeSynth();
    const r = await rig({ synth });
    let release!: () => void;
    synth.result = () =>
      new Promise(
        (resolve) =>
          (release = () => {
            resolve(good());
          }),
      );
    await set(r, UPLOADS, 'versioned', bool(false));
    await send(r, 'discard');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.session.view()).toMatchObject({ synthing: false, hasDesign: true });
    expect(r.session.view().draft).toBeUndefined();
    expect(r.session.view().nodes.find((x) => x.id === UPLOADS)?.changed).toBeUndefined();
    expect(r.session.draftSize()).toBe(0);
  });

  it('takes the changed badges off at once when the Draft is saved', async () => {
    const r = await rig();
    await set(r, UPLOADS, 'versioned', bool(false));
    await settled(r);
    expect(r.session.view().nodes.find((x) => x.id === UPLOADS)?.changed).toBe(true);
    await send(r, 'save');
    expect(r.session.view().nodes.find((x) => x.id === UPLOADS)?.changed).toBeUndefined();
  });

  describe('refuses an edit', () => {
    it('to a prop the panel does not offer an input for, a value of the wrong kind, or a member the enum lacks', async () => {
      const r = await rig();
      expect(refusal(await set(r, UPLOADS, 'nonsense', bool(true)))).toMatch(/can't be edited/);
      expect(refusal(await set(r, UPLOADS, 'versioned', { kind: 'string', value: 'yes' }))).toMatch(/takes a boolean/);
      expect(
        refusal(
          await set(r, UPLOADS, 'removalPolicy', {
            kind: 'enum',
            type: 'aws-cdk-lib.RemovalPolicy',
            member: 'EXPLODE',
          }),
        ),
      ).toMatch(/takes a enum/);
      expect(
        refusal(
          await set(r, UPLOADS, 'removalPolicy', { kind: 'enum', type: 'aws-cdk-lib.aws_s3.Other', member: 'DESTROY' }),
        ),
      ).toMatch(/takes a enum/);
      expect(r.session.draftSize()).toBe(0);
    });

    it('to a Node that is not there', async () => {
      expect(refusal(await set(await rig(), 'Nope/Nothing', 'x', bool(true)))).toMatch(/No Node or Stack/);
    });

    it('to a Node the code locks, giving the lock reason, and to a Stack it can only read', async () => {
      const session = new Session({
        appDir: '/app',
        synth: { synth: async () => ({ ok: true, assembly: readFixtureAssembly('shapes') }) },
        files: memoryFiles(readFixtureFiles('shapes')),
        source: new TsSource(),
        catalog,
      });
      await session.start();
      const reply = await session.handle({
        type: 'setProp',
        requestId: 'r',
        id: 'Shapes/LoopOne',
        prop: ['fifo'],
        value: bool(true),
      });
      expect(refusal(reply)).toMatch(/loop/i);
      const fromVariable = await session.handle({
        type: 'setProp',
        requestId: 'r',
        id: 'Shapes/FromVariable',
        prop: ['tableName'],
        value: { kind: 'string', value: 'x' },
      });
      expect(refusal(fromVariable)).toMatch(/passed as tableProps/);
      expect(session.draftSize()).toBe(0);
    });

    it('while the app does not synth, until it does again', async () => {
      const synth = new FakeSynth();
      const r = await rig({ synth });
      synth.result = () => ({ ok: false, error: { message: 'boom' } });
      r.files.change();
      await vi.waitFor(() => {
        expect(r.session.view().error?.message).toBe('boom');
      });
      expect(refusal(await set(r, UPLOADS, 'versioned', bool(false)))).toMatch(/paused.*boom/);
    });
  });

  describe('when the app cannot be synthed with a Draft applied', () => {
    it('shows why, and takes no edit', async () => {
      const synth = new FakeSynth();
      synth.support = { ok: false, reason: 'no build script' };
      const r = await rig({ synth });
      expect(r.session.view().draftBlocked).toBe('no build script');
      expect(refusal(await set(r, UPLOADS, 'versioned', bool(false)))).toBe('no build script');
      const reply = await r.session.handle({ type: 'panel', requestId: 'p', id: UPLOADS });
      expect(reply.type === 'panel' && reply.panel.readOnly).toBe('no build script');
      expect(reply.type === 'panel' && reply.panel.rows.every((row) => row.input === undefined)).toBe(true);
    });
  });

  describe('when the Draft makes the app fail to synth', () => {
    it('shows the error as the Draft’s, keeps the last good Design, and lets the user undo it', async () => {
      const synth = new FakeSynth();
      const r = await rig({ synth });
      synth.result = (overlay) => (overlay ? { ok: false, error: { message: 'bad prop' } } : good());
      await set(r, UPLOADS, 'versioned', bool(false));
      await vi.waitFor(() => {
        expect(r.session.view().error).toMatchObject({ kind: 'draft', message: 'bad prop' });
      });
      expect(r.session.view().hasDesign).toBe(true);
      expect(refusal(await send(r, 'save'))).toMatch(/Fix the Problem.*bad prop/);
      // The Draft can still be edited and undone.
      expect(await set(r, 'ShopStack/Orders', 'fifo', bool(true))).toMatchObject({ type: 'ack' });
      await send(r, 'discard');
      expect(r.session.view().error).toBeUndefined();
    });
  });

  describe('Problems', () => {
    const withRefs = (assembly: ReturnType<typeof readFixtureAssembly>, ...pairs: [string, string][]) => ({
      ...assembly,
      resourceRefs: [...assembly.resourceRefs, ...pairs.map(([from, to]) => ({ from, to }))],
    });
    const annotated = (level: 'error' | 'warning' | 'info', message: string, path = 'ShopStack/Orders') => ({
      path,
      level,
      message,
    });
    /** A rig whose app on disk is good, and whose Draft synths to whatever `draft` says. */
    const rigWith = (draft: (overlay: FileSet) => SynthResult, base: SynthResult = good()) => {
      const synth = new FakeSynth();
      synth.result = (overlay) => (overlay ? draft(overlay) : base);
      return rig({ synth });
    };
    // The line of `versioned: true` in lib/shop-stack.ts, inside the Uploads `new`.
    const trace = (line: number) => `Error: boom\n    at new Bucket (/app/lib/shop-stack.ts:${line}:7)`;

    it('traces a synth error to the Node whose new it points into, and to the line in the code on disk', async () => {
      const r = await rigWith(() => ({ ok: false, error: { message: 'boom', output: trace(12) } }));
      await set(r, UPLOADS, 'versioned', bool(false));
      await vi.waitFor(() => {
        expect(r.session.view().error).toMatchObject({ kind: 'draft' });
      });
      expect(r.session.view().problems).toEqual([
        expect.objectContaining({
          source: 'synth',
          path: UPLOADS,
          draft: true,
          blocking: true,
          location: { file: SHOP, line: 12, col: 7 },
        }),
      ]);
    });

    it('traces to file:line when the frame is in no Node', async () => {
      const r = await rigWith(() => ({ ok: false, error: { message: 'boom', output: trace(3) } }));
      await set(r, UPLOADS, 'versioned', bool(false));
      await vi.waitFor(() => {
        expect(r.session.view().error).toMatchObject({ kind: 'draft' });
      });
      const [found] = r.session.view().problems;
      expect(found).toMatchObject({ source: 'synth', location: { file: SHOP, line: 3 } });
      expect(found?.path).toBeUndefined();
    });

    it('flags the edits staged since the last good synth as suspect, and carries the error and Undo on a single one', async () => {
      const synth = new FakeSynth();
      const r = await rig({ synth });
      await set(r, 'ShopStack/Orders', 'fifo', bool(true));
      await settled(r);
      synth.result = (overlay) => (overlay ? { ok: false, error: { message: 'bad prop' } } : good());
      await set(r, UPLOADS, 'versioned', bool(false));
      await vi.waitFor(() => {
        expect(r.session.view().error?.kind).toBe('draft');
      });
      expect(r.session.view().draft?.items).toEqual([
        expect.not.objectContaining({ suspect: true }),
        expect.objectContaining({ id: UPLOADS, suspect: true, error: 'bad prop', undoable: true }),
      ]);

      // Undo takes the suspect out, the Draft synths again, and no flag is left.
      synth.result = () => good();
      await send(r, 'undo');
      await settled(r);
      expect(r.session.view().error).toBeUndefined();
      expect(r.session.view().draft?.items.some((i) => i.suspect)).toBe(false);
    });

    it('flags several suspects without naming one, and clears the flags on the next good synth', async () => {
      const synth = new FakeSynth();
      const r = await rig({ synth });
      synth.result = (overlay) => (overlay ? { ok: false, error: { message: 'bad' } } : good());
      await set(r, UPLOADS, 'versioned', bool(false));
      await vi.waitFor(() => {
        expect(r.session.view().error?.kind).toBe('draft');
      });
      await set(r, 'ShopStack/Orders', 'fifo', bool(true));
      await vi.waitFor(() => {
        expect(r.session.view().synthing).toBe(false);
      });
      const items = r.session.view().draft!.items;
      expect(items.map((i) => i.suspect)).toEqual([true, true]);
      expect(items.some((i) => i.error || i.undoable)).toBe(false);

      synth.result = () => good();
      await set(r, UPLOADS, 'bucketName', { kind: 'string', value: 'x' });
      await settled(r);
      expect(r.session.view().draft?.items.some((i) => i.suspect)).toBe(false);
    });

    it('blocks Save on an error annotation the Draft adds, and badges nothing for the one the app already had', async () => {
      const base = readFixtureAssembly('straight-line');
      base.annotations = [annotated('error', 'old error', 'ShopStack/Catalog')];
      const r = await rigWith(
        () => ({
          ok: true,
          assembly: { ...base, annotations: [...base.annotations!, annotated('error', 'queue is wrong')] },
        }),
        { ok: true, assembly: base },
      );
      expect(r.session.view().problems).toEqual([
        expect.objectContaining({ message: 'old error', draft: false, blocking: false }),
      ]);
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      expect(r.session.view().problems.map((p) => [p.message, p.draft, p.blocking])).toEqual([
        ['old error', false, false],
        ['queue is wrong', true, true],
      ]);
      expect(r.session.view().draft?.problems).toEqual(['queue is wrong']);
      expect(refusal(await send(r, 'save'))).toMatch(/can't be saved.*queue is wrong/);
    });

    it('does not block Save on a warning', async () => {
      const r = await rigWith(() => ({
        ok: true,
        assembly: { ...readFixtureAssembly('straight-line'), annotations: [annotated('warning', 'careful')] },
      }));
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      expect(r.session.view().problems).toEqual([
        expect.objectContaining({ severity: 'warning', draft: true, blocking: false }),
      ]);
      expect(await send(r, 'save')).toMatchObject({ type: 'ack' });
    });

    it('names the resources of a cycle the Draft closes, blocks Save, and only reports one the app had', async () => {
      const had = withRefs(
        readFixtureAssembly('straight-line'),
        ['ShopStack/Orders/Resource', 'ShopStack/Uploads/Resource'],
        ['ShopStack/Uploads/Resource', 'ShopStack/Orders/Resource'],
      );
      const closes = withRefs(
        had,
        ['ShopStack/Catalog/Resource', 'ShopStack/Catalog/Role'],
        ['ShopStack/Catalog/Role', 'ShopStack/Catalog/Resource'],
      );
      const r = await rigWith(() => ({ ok: true, assembly: closes }), { ok: true, assembly: had });
      expect(r.session.view().problems).toEqual([
        expect.objectContaining({ source: 'cycle', draft: false, blocking: false }),
      ]);
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      const cycles = r.session.view().problems.filter((p) => p.source === 'cycle');
      expect(cycles.map((p) => [p.draft, p.blocking]).sort()).toEqual([
        [false, false],
        [true, true],
      ]);
      expect(cycles.find((p) => p.draft)!.message).toBe(
        'Dependency cycle: ShopStack/Catalog/Resource → ShopStack/Catalog/Role → ShopStack/Catalog/Resource',
      );
      expect(refusal(await send(r, 'save'))).toMatch(/Dependency cycle/);
    });

    it('shows a TypeScript diagnostic the Draft adds as a Problem on its Node', async () => {
      const source = new TsSource();
      source.diagnostics = (_dir, files) =>
        files.get(SHOP)!.includes('versioned: false')
          ? [{ file: SHOP, line: 12, code: 2322, message: 'Type is not assignable' }]
          : [];
      const r = await rig({ source });
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      expect(r.session.view().problems).toEqual([
        expect.objectContaining({
          source: 'typescript',
          path: UPLOADS,
          blocking: true,
          message: expect.stringContaining('TypeScript 2322'),
        }),
      ]);
    });

    it('calls a failed check of the planned edit a bug in Truss, and gives a report with only the changed lines', async () => {
      const synth = new FakeSynth();
      synth.result = (overlay) => {
        if (!overlay) return good();
        const assembly = readFixtureAssembly('straight-line');
        const stack = assembly.tree.children.find((c) => c.path === 'ShopStack')!;
        stack.children = stack.children.filter((c) => c.path !== 'ShopStack/Orders');
        return { ok: true, assembly };
      };
      const r = await rig({ synth });
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      expect(r.session.view().problems[0]).toMatchObject({ source: 'truss', trussBug: true, blocking: true });
      const report = r.session.view().draft?.report ?? '';
      expect(report).toContain('versioned → false');
      expect(report).toContain('+      versioned: false,');
      expect(report).not.toContain('visibilityTimeout');
    });

    it('lists what is on a construct, info included, in its property panel', async () => {
      const r = await rigWith(() => good(), {
        ok: true,
        assembly: { ...readFixtureAssembly('straight-line'), annotations: [annotated('info', 'FYI')] },
      });
      const reply = await r.session.handle({ type: 'panel', requestId: 'p', id: 'ShopStack/Orders' });
      expect(reply.type === 'panel' ? reply.panel.problems : undefined).toEqual([
        { severity: 'info', message: 'FYI', draft: false },
      ]);
    });
  });

  describe('Save', () => {
    it('writes the shadow copy’s text byte for byte, clears the Draft and synths what was written', async () => {
      const r = await rig();
      await set(r, UPLOADS, 'versioned', bool(false));
      await set(r, UPLOADS, 'bucketName', { kind: 'string', value: 'up' });
      await settled(r);
      const shadow = r.synth.shadowCalls.at(-1)!.overlay!;
      const synths = r.synth.calls.length;

      expect(await send(r, 'save')).toMatchObject({ type: 'ack' });
      expect(r.files.writes).toEqual([SHOP]);
      expect(r.files.texts.get(SHOP)).toBe(shadow.get(SHOP));
      expect(r.session.view().draft).toBeUndefined();
      expect(r.session.draftSize()).toBe(0);
      await vi.waitFor(() => {
        expect(r.synth.calls.length).toBeGreaterThan(synths);
      });
      expect(r.synth.calls.at(-1)).toEqual({});
    });

    it('waits for the synth in flight, so that it saves what the screen shows', async () => {
      const synth = new FakeSynth();
      const r = await rig({ synth });
      let release!: () => void;
      synth.result = () =>
        new Promise(
          (resolve) =>
            (release = () => {
              resolve(good());
            }),
        );
      await set(r, UPLOADS, 'versioned', bool(false));
      const saving = send(r, 'save');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(r.files.writes).toEqual([]);
      release();
      expect(await saving).toMatchObject({ type: 'ack' });
      expect(r.files.writes).toEqual([SHOP]);
    });

    it('refuses with nothing to save', async () => {
      expect(refusal(await send(await rig(), 'save'))).toMatch(/nothing/);
    });

    it('is refused, writing nothing, when a file it touches changed on disk since Truss read it', async () => {
      const r = await rig();
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      r.files.sources.set(SHOP, r.files.sources.get(SHOP)! + '// edited elsewhere\n');
      expect(refusal(await send(r, 'save'))).toMatch(/lib\/shop-stack\.ts changed on disk/);
      expect(r.files.writes).toEqual([]);
      expect(r.session.draftSize()).toBe(1);
    });

    it('is all or nothing: a failed write puts back the files already written', async () => {
      const r = await rig();
      // Two files in one Draft: the Stack in bin/ and a construct in lib/.
      await set(r, 'ShopStack', 'terminationProtection', bool(true));
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      const original = new Map(r.files.sources);
      const writes: [string, string][] = [];
      let failing = true;
      r.files.writeText = async (name, text) => {
        if (name === SHOP && failing) throw new Error('disk full');
        writes.push([name, text]);
        r.files.sources.set(name, text);
      };
      expect(refusal(await send(r, 'save'))).toMatch(/nothing was saved: disk full/);
      for (const [name, text] of original) expect(r.files.sources.get(name), name).toBe(text);
      expect(writes.map(([name]) => name)).toEqual(['bin/app.ts', 'bin/app.ts']);
      expect(r.session.draftSize()).toBe(2);
      failing = false;
    });

    it('is blocked by a Problem the checks find, and shows it in the Draft', async () => {
      const synth = new FakeSynth();
      // The shadow synth loses a Node the edit has no business touching.
      synth.result = (overlay) => {
        if (!overlay) return good();
        const assembly = readFixtureAssembly('straight-line');
        const stack = assembly.tree.children.find((c) => c.path === 'ShopStack')!;
        stack.children = stack.children.filter((c) => c.path !== 'ShopStack/Orders');
        return { ok: true, assembly };
      };
      const r = await rig({ synth });
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      expect(r.session.view().draft?.problems).toEqual([expect.stringContaining('ShopStack/Orders')]);
      expect(refusal(await send(r, 'save'))).toMatch(/can't be saved.*ShopStack\/Orders/);
      expect(r.files.writes).toEqual([]);
    });

    it('is blocked by a TypeScript diagnostic the edit introduces, and not by one the code already had', async () => {
      const source = new TsSource();
      const existing: Diagnostic = { file: SHOP, line: 3, code: 2304, message: 'Cannot find name x' };
      source.diagnostics = (_dir, files) => [
        existing,
        ...(files.get(SHOP)!.includes('versioned: false')
          ? [{ file: SHOP, line: 12, code: 2322, message: 'Type is not assignable' }]
          : []),
      ];
      const r = await rig({ source });
      await set(r, UPLOADS, 'bucketName', { kind: 'string', value: 'ok' });
      await settled(r);
      expect(await send(r, 'save')).toMatchObject({ type: 'ack' });

      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      expect(refusal(await send(r, 'save'))).toMatch(/lib\/shop-stack\.ts:12: TypeScript 2322/);
      expect(r.session.view().draft?.problems.join()).toMatch(/2322/);
    });
  });

  describe('when the code changes under the Draft', () => {
    it('plans the Draft again on the new code, and drops an edit whose target is gone, saying so', async () => {
      const r = await rig();
      await set(r, UPLOADS, 'versioned', bool(false));
      await set(r, 'ShopStack/Orders', 'fifo', bool(true));
      await settled(r);

      // Someone renames Uploads in the editor: the Construct ID the edit expected is gone.
      r.files.sources.set(SHOP, r.files.sources.get(SHOP)!.replace("'Uploads'", "'Renamed'"));
      r.files.change();
      await vi.waitFor(() => {
        expect(r.session.view().draft?.notices).toHaveLength(1);
      });
      await settled(r);
      expect(r.session.view().draft?.notices[0]).toMatch(/Dropped versioned → false on Uploads/);
      expect(r.session.view().draft?.items.map((i) => i.id)).toEqual(['ShopStack/Orders']);
      expect(r.synth.shadowCalls.at(-1)!.overlay!.get(SHOP)).toContain('fifo: true');
    });

    it('keeps an edit whose target is still there, on the new code', async () => {
      const r = await rig();
      await set(r, 'ShopStack/Orders', 'fifo', bool(true));
      await settled(r);
      r.files.sources.set(SHOP, r.files.sources.get(SHOP)!.replace('versioned: true', 'versioned: false'));
      r.files.change();
      await vi.waitFor(() => {
        expect(r.synth.shadowCalls.length).toBeGreaterThan(1);
      });
      await settled(r);
      expect(r.session.view().draft?.items).toHaveLength(1);
      expect(r.session.view().draft?.notices).toEqual([]);
      expect(r.synth.shadowCalls.at(-1)!.overlay!.get(SHOP)).toContain('versioned: false');
    });

    it('shows the Design on the new code, with the Draft empty and the notice kept, when every edit is dropped', async () => {
      const r = await rig();
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      const shadows = r.synth.shadowCalls.length;

      r.files.sources.set(SHOP, r.files.sources.get(SHOP)!.replace("'Uploads'", "'Renamed'"));
      r.files.change();
      await vi.waitFor(() => {
        expect(r.session.view().draft?.notices).toHaveLength(1);
      });
      await settled(r);
      const draft = r.session.view().draft;
      expect(draft?.items).toEqual([]);
      expect(draft?.diffs).toEqual([]);
      expect(r.session.draftSize()).toBe(0);
      expect(r.session.view().nodes.some((x) => x.changed)).toBe(false);
      // Nothing is left to apply, so no shadow synth is made for it.
      expect(r.synth.shadowCalls).toHaveLength(shadows);
    });

    it('keeps the notices of earlier rebases until the Draft is discarded', async () => {
      const r = await rig();
      await set(r, UPLOADS, 'versioned', bool(false));
      await set(r, 'ShopStack/Orders', 'fifo', bool(true));
      await settled(r);

      r.files.sources.set(SHOP, r.files.sources.get(SHOP)!.replace("'Uploads'", "'Renamed'"));
      r.files.change();
      await vi.waitFor(() => {
        expect(r.session.view().draft?.notices).toHaveLength(1);
      });
      await settled(r);
      r.files.sources.set(SHOP, r.files.sources.get(SHOP)!.replace("'Orders'", "'Renamed2'"));
      r.files.change();
      await vi.waitFor(() => {
        expect(r.session.view().draft?.notices).toHaveLength(2);
      });
      await settled(r);
      expect(r.session.view().draft?.notices.join('\n')).toMatch(
        /versioned → false on Uploads[^]*fifo → true on Orders/,
      );

      await send(r, 'discard');
      expect(r.session.view().draft).toBeUndefined();
    });
  });

  describe('while the code on disk does not synth', () => {
    const breakApp = async (r: Rig) => {
      r.synth.result = () => ({ ok: false, error: { message: 'boom' } });
      r.files.change();
      await vi.waitFor(() => {
        expect(r.session.view().error?.message).toBe('boom');
      });
    };

    it('holds the Draft as it was, unplanned on the new code, and refuses Save', async () => {
      const r = await rig();
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      const shadows = r.synth.shadowCalls.length;

      // The rename that would drop the edit is on disk, but nothing can say so while the app doesn't synth.
      r.files.sources.set(SHOP, r.files.sources.get(SHOP)!.replace("'Uploads'", "'Renamed'"));
      await breakApp(r);
      const draft = r.session.view().draft;
      expect(draft?.items).toHaveLength(1);
      expect(draft?.notices).toEqual([]);
      expect(r.synth.shadowCalls).toHaveLength(shadows);

      expect(refusal(await send(r, 'save'))).toMatch(/Save is paused until the app synths again.*boom/);
      expect(r.files.writes).toEqual([]);
      expect(r.session.draftSize()).toBe(1);
    });

    it('rebases the Draft when the app synths again, saying what no longer applies', async () => {
      const r = await rig();
      await set(r, UPLOADS, 'versioned', bool(false));
      await set(r, 'ShopStack/Orders', 'fifo', bool(true));
      await settled(r);

      r.files.sources.set(SHOP, r.files.sources.get(SHOP)!.replace("'Uploads'", "'Renamed'"));
      await breakApp(r);
      r.synth.result = () => good();
      r.files.change();
      await vi.waitFor(() => {
        expect(r.session.view().error).toBeUndefined();
      });
      await settled(r);
      expect(r.session.view().draft?.notices[0]).toMatch(/Dropped versioned → false on Uploads/);
      expect(r.session.view().draft?.items.map((i) => i.id)).toEqual(['ShopStack/Orders']);
      expect(await send(r, 'save')).toMatchObject({ type: 'ack' });
    });

    it('clears the error when the app synths again and every edit is dropped', async () => {
      const r = await rig();
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);

      r.files.sources.set(SHOP, r.files.sources.get(SHOP)!.replace("'Uploads'", "'Renamed'"));
      await breakApp(r);
      r.synth.result = () => good();
      r.files.change();
      await vi.waitFor(() => {
        expect(r.session.view().draft?.notices).toHaveLength(1);
      });
      await settled(r);
      expect(r.session.view().error).toBeUndefined();
      expect(r.session.draftSize()).toBe(0);
    });

    it('takes no undo or redo, which would change a Draft that is not on the new code', async () => {
      const r = await rig();
      await set(r, UPLOADS, 'versioned', bool(false));
      await set(r, 'ShopStack/Orders', 'fifo', bool(true));
      await send(r, 'undo');
      await settled(r);
      await breakApp(r);

      expect(refusal(await send(r, 'undo'))).toMatch(/paused.*boom/);
      expect(refusal(await send(r, 'redo'))).toMatch(/paused.*boom/);
      expect(r.session.draftSize()).toBe(1);
    });

    it('still lets the Draft be discarded', async () => {
      const r = await rig();
      await set(r, UPLOADS, 'versioned', bool(false));
      await settled(r);
      await breakApp(r);

      expect(await send(r, 'discard')).toMatchObject({ type: 'ack' });
      expect(r.session.draftSize()).toBe(0);
      expect(r.session.view().draft).toBeUndefined();
      // The app still doesn't synth, and the screen says so.
      expect(r.session.view().error?.message).toBe('boom');
    });
  });
});

describe('renaming a Construct ID', () => {
  const rename = (r: Rig, id: string, newId: string): Promise<Reply> =>
    r.session.handle({ type: 'renameId', requestId: `r${++n}`, id, newId });
  const FILES = 'ShopStack/Files';

  /** The fixture's assembly as synth makes it once Uploads is called Files: the same subtree under another path. */
  const filesAssembly = (): SynthResult => {
    const assembly = JSON.parse(JSON.stringify(readFixtureAssembly('straight-line')).replaceAll(UPLOADS, FILES));
    const moved = assembly.tree.children[0].children.find((c: { path: string }) => c.path === FILES);
    moved.id = 'Files';
    return { ok: true, assembly };
  };
  const synthRenamed = () => {
    const synth = new FakeSynth();
    synth.result = (overlay) => (overlay?.get(SHOP)?.includes("'Files'") ? filesAssembly() : good());
    return synth;
  };

  it('stages a rename as an intent, shows its diff at once, and writes nothing until Save', async () => {
    const r = await rig();
    expect(await rename(r, UPLOADS, 'Files')).toMatchObject({ type: 'ack' });
    expect(r.session.view().draft?.items).toEqual([
      { id: UPLOADS, label: 'Uploads', summary: 'Construct ID → "Files"' },
    ]);
    expect(r.session.view().nodes.find((x) => x.id === UPLOADS)?.changed).toBe(true);
    expect(r.session.view().draft?.diffs[0]?.diff).toContain(
      "-    new s3.Bucket(this, 'Uploads', {\n+    new s3.Bucket(this, 'Files', {",
    );
    await settled(r);
    expect(r.synth.shadowCalls[0]!.overlay!.get(SHOP)).toContain("new s3.Bucket(this, 'Files'");
    expect(r.files.writes).toEqual([]);
  });

  it('offers the Construct ID in the panel with the IDs it can not take', async () => {
    const r = await rig();
    const reply = await r.session.handle({ type: 'panel', requestId: 'p', id: UPLOADS });
    // Beside the other Nodes are the constructs the Design does not draw, which an ID can clash with too.
    expect(reply.type === 'panel' && reply.panel.idEdit?.siblings).toEqual(
      expect.arrayContaining(['Orders', 'Catalog', 'CDKMetadata']),
    );
    expect(reply.type === 'panel' && reply.panel.idEdit?.siblings).not.toContain('Uploads');
  });

  it.each([
    ['an empty ID', '', /empty/],
    ['an ID with a slash', 'a/b', /'\/'/],
    ['an ID with a newline', 'a\nb', /newline/],
    ['the ID of a sibling', 'Orders', /sibling already has/],
  ])('refuses %s', async (_name, newId, reason) => {
    const r = await rig();
    expect(refusal(await rename(r, UPLOADS, newId))).toMatch(reason);
    expect(r.session.draftSize()).toBe(0);
  });

  it('does not check the case of the ID', async () => {
    const r = await rig();
    expect(await rename(r, UPLOADS, 'uploads_bucket')).toMatchObject({ type: 'ack' });
  });

  it('refuses a Node the code locks, and one that is not there', async () => {
    const r = await rig();
    expect(refusal(await rename(r, 'Nope/Nothing', 'X'))).toMatch(/No Node or Stack/);
  });

  describe('Save', () => {
    const sidecar = (nodes: object) => JSON.stringify({ formatVersion: 1, nodes });

    it('writes the new ID and moves the Sidecar entry of the Node, and of what is beneath it, with it', async () => {
      const r = await rig({ synth: synthRenamed() });
      r.files.texts.set(
        'truss.json',
        sidecar({
          [UPLOADS]: { position: { x: 1, y: 2 }, note: 'mine' },
          [`${UPLOADS}/Resource`]: { note: 'deep' },
          'ShopStack/Orders': { position: { x: 5, y: 6 } },
        }),
      );
      await r.session.handle({ type: 'note', requestId: 'n', id: UPLOADS, note: 'mine' });
      await rename(r, UPLOADS, 'Files');
      await settled(r);
      expect(r.session.view().nodes.find((x) => x.id === FILES)?.note).toBe('mine');
      expect(r.files.texts.get('truss.json')).toContain('ShopStack/Uploads');

      expect(await send(r, 'save')).toMatchObject({ type: 'ack' });
      expect(r.files.texts.get(SHOP)).toContain("new s3.Bucket(this, 'Files'");
      expect(JSON.parse(r.files.texts.get('truss.json')!).nodes).toEqual({
        [FILES]: { position: { x: 1, y: 2 }, note: 'mine' },
        [`${FILES}/Resource`]: { note: 'deep' },
        'ShopStack/Orders': { position: { x: 5, y: 6 } },
      });
    });

    it('keeps a position set after the rename under the old path until Save moves it', async () => {
      const r = await rig({ synth: synthRenamed() });
      await rename(r, UPLOADS, 'Files');
      await settled(r);
      await r.session.handle({ type: 'move', requestId: 'm', id: FILES, x: 10, y: 20 });
      expect(Object.keys(JSON.parse(r.files.texts.get('truss.json')!).nodes)).toEqual([UPLOADS]);
      await send(r, 'save');
      expect(JSON.parse(r.files.texts.get('truss.json')!).nodes).toEqual({ [FILES]: { position: { x: 10, y: 20 } } });
    });

    it('refuses to save a rename that synth does not show as one moved subtree', async () => {
      // The synth gives the old paths back, as if the ID in the code were not what names the construct.
      const r = await rig();
      await rename(r, UPLOADS, 'Files');
      await settled(r);
      expect(refusal(await send(r, 'save'))).toMatch(/was not renamed/);
      expect(r.files.writes).toEqual([]);
    });
  });
});

describe('adding a Node, and duplicating one', () => {
  const add = (r: Rig, scope: string, fqn: string, props?: Record<string, PropValue>): Promise<Reply> =>
    r.session.handle({ type: 'addNode', requestId: `r${++n}`, scope, fqn, ...(props ? { props } : {}) });
  const duplicate = (r: Rig, id: string): Promise<Reply> =>
    r.session.handle({ type: 'duplicate', requestId: `r${++n}`, id });
  const BUCKET = 'aws-cdk-lib.aws_s3.Bucket';

  /** The fixture's assembly with one more child under ShopStack: `path` made like `like`, or a bare `fqn`. */
  const withChild = (child: { id: string; fqn: string; like?: string }): SynthResult => {
    const assembly = readFixtureAssembly('straight-line');
    const stack = assembly.tree.children.find((c) => c.path === 'ShopStack')!;
    const like = child.like ? stack.children.find((c) => c.path === child.like)! : undefined;
    const copy = like
      ? JSON.parse(JSON.stringify(like).replaceAll(like.path, `ShopStack/${child.id}`))
      : { id: child.id, path: `ShopStack/${child.id}`, fqn: child.fqn, children: [] };
    stack.children.push({ ...copy, id: child.id, path: `ShopStack/${child.id}` });
    return { ok: true, assembly };
  };
  const synthWith = (child: Parameters<typeof withChild>[0], marker: string) => {
    const synth = new FakeSynth();
    synth.result = (overlay) => (overlay?.get(SHOP)?.includes(marker) ? withChild(child) : good());
    return synth;
  };

  it('stages the statement a developer would write, shows it at once, and writes it on Save', async () => {
    const r = await rig({ synth: synthWith({ id: 'Bucket', fqn: BUCKET }, "new s3.Bucket(this, 'Bucket')") });
    expect(await add(r, 'ShopStack', BUCKET)).toMatchObject({ type: 'ack' });
    expect(r.session.view().draft?.items).toEqual([
      { id: 'ShopStack', label: 'Bucket', summary: 'Add Bucket "Bucket"' },
    ]);
    expect(r.session.view().draft?.diffs[0]?.diff).toContain("+    const bucket = new s3.Bucket(this, 'Bucket');");
    await settled(r);
    expect(r.session.view().draft?.problems).toEqual([]);
    expect(r.files.writes).toEqual([]);

    expect(await send(r, 'save')).toMatchObject({ type: 'ack' });
    expect(r.files.texts.get(SHOP)).toContain("    new dynamodb.Table(this, 'Catalog', {");
    expect(r.files.texts.get(SHOP)).toContain("const bucket = new s3.Bucket(this, 'Bucket');");
  });

  it('refuses to save an add that synth does not show as one new construct of that class', async () => {
    const r = await rig();
    await add(r, 'ShopStack', BUCKET);
    await settled(r);
    expect(refusal(await send(r, 'save'))).toMatch(/ShopStack\/Bucket was not added/);
    expect(r.files.writes).toEqual([]);
  });

  it('gives a second construct of the same kind an ID of its own', async () => {
    const r = await rig();
    await add(r, 'ShopStack', 'aws-cdk-lib.aws_sqs.Queue');
    expect(r.session.view().draft?.items[0]?.label).toBe('Queue');
    expect(r.session.view().draft?.diffs[0]?.diff).toContain("new sqs.Queue(this, 'Queue')");
  });

  it('asks for the props the construct needs and has no default for, and stages nothing until they come', async () => {
    const r = await rig();
    const asked = await add(r, 'ShopStack', 'aws-cdk-lib.aws_sns.Topic');
    expect(asked).toMatchObject({
      type: 'form',
      fqn: 'aws-cdk-lib.aws_sns.Topic',
      props: [{ name: 'displayName', required: true }],
    });
    expect(r.session.draftSize()).toBe(0);
    expect(
      await add(r, 'ShopStack', 'aws-cdk-lib.aws_sns.Topic', { displayName: { kind: 'string', value: 'Alerts' } }),
    ).toMatchObject({ type: 'ack' });
    expect(r.session.view().draft?.diffs[0]?.diff).toContain(
      "const topic = new sns.Topic(this, 'Topic', { displayName: 'Alerts' });",
    );
    expect(r.session.view().draft?.diffs[0]?.diff).toContain("import * as sns from 'aws-cdk-lib/aws-sns';");
  });

  it('refuses a value of the wrong kind for the form, a construct that needs what Truss cannot write, and a scope that is not a Stack', async () => {
    const r = await rig();
    expect(
      await add(r, 'ShopStack', 'aws-cdk-lib.aws_sns.Topic', { displayName: { kind: 'boolean', value: true } }),
    ).toMatchObject({ type: 'form' });
    expect(refusal(await add(r, 'ShopStack', 'aws-cdk-lib.aws_dynamodb.Table'))).toMatch(/partitionKey/);
    expect(refusal(await add(r, 'ShopStack/Uploads', BUCKET))).toMatch(/No Stack/);
    expect(refusal(await add(r, 'ShopStack', 'aws-cdk-lib.aws_nothing.Thing'))).toMatch(/not in the Catalog/);
    expect(r.session.draftSize()).toBe(0);
  });

  it('copies a Node with a fresh ID, and saves it', async () => {
    const r = await rig({ synth: synthWith({ id: 'Uploads2', fqn: BUCKET, like: UPLOADS }, "'Uploads2'") });
    expect(await duplicate(r, UPLOADS)).toMatchObject({ type: 'ack' });
    expect(r.session.view().draft?.items).toEqual([
      { id: UPLOADS, label: 'Uploads2', summary: 'Duplicate as "Uploads2"' },
    ]);
    await settled(r);
    expect(r.session.view().draft?.problems).toEqual([]);
    expect(await send(r, 'save')).toMatchObject({ type: 'ack' });
    expect(r.files.texts.get(SHOP)).toContain("new s3.Bucket(this, 'Uploads2', {\n      versioned: true,\n    });");
  });

  it('refuses to duplicate what is not there', async () => {
    const r = await rig();
    expect(refusal(await duplicate(r, 'ShopStack/Nope'))).toMatch(/No Node/);
  });

  it('undoes an add like any other edit', async () => {
    const r = await rig();
    await add(r, 'ShopStack', BUCKET);
    expect(await send(r, 'undo')).toMatchObject({ type: 'ack' });
    expect(r.session.draftSize()).toBe(0);
  });
});

describe('removing a Node', () => {
  const remove = (r: Rig, id: string): Promise<Reply> =>
    r.session.handle({ type: 'removeNode', requestId: `r${++n}`, id });
  const ORDERS = 'ShopStack/Orders';
  const sidecar = (nodes: object) => JSON.stringify({ formatVersion: 1, nodes });

  /** Synth of the fixture with the Uploads subtree gone, once the code no longer makes it. */
  const synthWithout = () => {
    const synth = new FakeSynth();
    synth.result = (overlay) => {
      const assembly = readFixtureAssembly('straight-line');
      if (overlay?.get(SHOP) && !overlay.get(SHOP)!.includes("'Uploads'")) {
        const stack = assembly.tree.children.find((c) => c.path === 'ShopStack')!;
        stack.children = stack.children.filter((c) => c.path !== UPLOADS);
      }
      return { ok: true, assembly };
    };
    return synth;
  };

  it('stages the removal, shows the Node as a ghost, and writes the deletion on Save with the Sidecar entry gone', async () => {
    const r = await rig({ synth: synthWithout() });
    r.files.texts.set(
      'truss.json',
      sidecar({
        [UPLOADS]: { position: { x: 1, y: 2 } },
        [`${UPLOADS}/Resource`]: { note: 'deep' },
        [ORDERS]: { position: { x: 5, y: 6 } },
      }),
    );
    await r.session.handle({ type: 'note', requestId: 'n', id: ORDERS, note: 'keep' });
    expect(await remove(r, UPLOADS)).toMatchObject({ type: 'ack' });
    expect(r.session.view().draft?.items).toEqual([{ id: UPLOADS, label: 'Uploads', summary: 'Remove Uploads' }]);
    expect(r.session.view().draft?.diffs[0]?.diff).toContain("-    new s3.Bucket(this, 'Uploads', {");
    await settled(r);
    expect(r.session.view().draft?.problems).toEqual([]);
    expect(r.session.view().nodes.find((x) => x.id === UPLOADS)).toMatchObject({
      removed: true,
      label: 'Uploads',
      stackId: 'ShopStack',
    });
    expect(r.session.view().nodes.filter((x) => x.removed)).toHaveLength(1);
    expect(r.files.writes).not.toContain(SHOP);

    expect(await send(r, 'save')).toMatchObject({ type: 'ack' });
    expect(r.files.texts.get(SHOP)).not.toContain('Uploads');
    expect(JSON.parse(r.files.texts.get('truss.json')!).nodes).toEqual({
      [ORDERS]: { position: { x: 5, y: 6 }, note: 'keep' },
    });
    await settled(r);
    expect(r.session.view().nodes.some((x) => x.removed)).toBe(false);
  });

  it('takes the ghost away on undo', async () => {
    const r = await rig({ synth: synthWithout() });
    await remove(r, UPLOADS);
    await send(r, 'undo');
    expect(r.session.view().nodes.some((x) => x.removed)).toBe(false);
    expect(r.session.draftSize()).toBe(0);
  });

  it('refuses to save a removal that synth shows took more than the Node away', async () => {
    const r = await rig();
    await remove(r, UPLOADS);
    await settled(r);
    expect(refusal(await send(r, 'save'))).toMatch(/ShopStack\/Uploads was not removed/);
    expect(r.files.writes).toEqual([]);
  });

  it('refuses a Node that other code uses, and lists where', async () => {
    const r = await rig();
    // The statement keeps its line and column, so the creation site synth recorded still points at it.
    r.files.sources.set(
      SHOP,
      r.files.sources
        .get(SHOP)!
        .replace(
          "super(scope, id, props);\n\n    new s3.Bucket(this, 'Uploads', {",
          "super(scope, id, props);\n    const uploads =\n    new s3.Bucket(this, 'Uploads', {",
        )
        .replace('    });\n\n    new sqs', '    });\n    console.log(uploads);\n    new sqs'),
    );
    r.files.change();
    await settled(r);
    const reply = await remove(r, UPLOADS);
    expect(reply).toMatchObject({ type: 'refused', uses: [{ file: SHOP, text: 'console.log(uploads);' }] });
    expect(r.session.draftSize()).toBe(0);
  });

  it('refuses what is not there', async () => {
    const r = await rig();
    expect(refusal(await remove(r, 'ShopStack/Nope'))).toMatch(/No Node/);
  });
});
