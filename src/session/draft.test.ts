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
const prop = (name: string, type: unknown, optional = true) => ({ name, type, docs: doc(`The ${name}.`), ...(optional ? { optional: true } : {}) });
const cls = (fqn: string, propsFqn: string) => ({
  kind: 'class',
  fqn,
  name: fqn.split('.').at(-1),
  namespace: fqn.split('.')[1],
  base: 'constructs.Construct',
  docs: doc(`A ${fqn}.`),
  initializer: { parameters: [{ name: 'scope', type: { fqn: 'constructs.Construct' } }, { name: 'id', type: { primitive: 'string' } }, { name: 'props', optional: true, type: { fqn: propsFqn } }] },
});
const struct = (fqn: string, properties: unknown[]) => ({ kind: 'interface', datatype: true, fqn, name: fqn.split('.').at(-1), properties });

/** A small aws-cdk-lib with the three constructs of the straight-line fixture. */
const catalog = buildCatalog([
  digestAssembly({
    name: 'aws-cdk-lib',
    version: '2.274.0',
    types: Object.fromEntries(
      [
        cls('aws-cdk-lib.aws_s3.Bucket', 'aws-cdk-lib.aws_s3.BucketProps'),
        struct('aws-cdk-lib.aws_s3.BucketProps', [prop('versioned', { primitive: 'boolean' }), prop('bucketName', { primitive: 'string' }), prop('removalPolicy', { fqn: 'aws-cdk-lib.RemovalPolicy' })]),
        cls('aws-cdk-lib.aws_sqs.Queue', 'aws-cdk-lib.aws_sqs.QueueProps'),
        struct('aws-cdk-lib.aws_sqs.QueueProps', [prop('visibilityTimeout', { fqn: 'aws-cdk-lib.Duration' }), prop('fifo', { primitive: 'boolean' })]),
        cls('aws-cdk-lib.aws_dynamodb.Table', 'aws-cdk-lib.aws_dynamodb.TableProps'),
        struct('aws-cdk-lib.aws_dynamodb.TableProps', [prop('partitionKey', { fqn: 'aws-cdk-lib.aws_dynamodb.Attribute'}, false), prop('tableName', { primitive: 'string' })]),
        struct('aws-cdk-lib.aws_dynamodb.Attribute', [prop('name', { primitive: 'string' }, false), prop('type', { fqn: 'aws-cdk-lib.aws_dynamodb.AttributeType' }, false)]),
        { kind: 'enum', fqn: 'aws-cdk-lib.aws_dynamodb.AttributeType', name: 'AttributeType', members: [{ name: 'STRING' }, { name: 'NUMBER' }] },
        { kind: 'enum', fqn: 'aws-cdk-lib.RemovalPolicy', name: 'RemovalPolicy', members: [{ name: 'DESTROY' }, { name: 'RETAIN' }] },
        { kind: 'class', fqn: 'aws-cdk-lib.Duration', name: 'Duration' },
      ].map((t) => [t.fqn, t]),
    ),
  }),
]);

const SHOP = 'lib/shop-stack.ts';
const good = (): SynthResult => ({ ok: true, assembly: readFixtureAssembly('straight-line') });

/** A Synth that records each call, and answers every one with the straight-line fixture unless told otherwise. */
class FakeSynth implements Synth {
  calls: Array<{ overlay?: FileSet }> = [];
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
  const files = Object.assign(memory, { sources, read: async () => new Map(sources), change: () => listeners.forEach((l) => l()), watch: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) }) as Rig['files'];
  const synth = opts.synth ?? new FakeSynth();
  const session = new Session({ appDir: '/app', synth, files: files as Files, source: opts.source ?? new TsSource(), catalog });
  await session.start();
  return { session, files, synth };
}

let n = 0;
const set = (r: Rig, id: string, prop: string | string[], value: PropValue): Promise<Reply> =>
  r.session.handle({ type: 'setProp', requestId: `r${++n}`, id, prop: Array.isArray(prop) ? prop : [prop], value });
const send = (r: Rig, type: 'undo' | 'redo' | 'save' | 'discard'): Promise<Reply> => r.session.handle({ type, requestId: `r${++n}` });
const settled = (r: Rig) => vi.waitFor(() => expect(r.session.view().synthing).toBe(false));
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
    expect(r.session.view().draft).toMatchObject({ items: [{ summary: 'versioned → false' }], canUndo: true, canRedo: true });
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
    expect(await set(r, 'ShopStack/Catalog', ['partitionKey', 'name'], { kind: 'string', value: 'id' })).toMatchObject({ type: 'ack' });
    expect(await set(r, 'ShopStack/Orders', 'visibilityTimeout', { kind: 'duration', unit: 'minutes', amount: 2 })).toMatchObject({ type: 'ack' });
    const diff = r.session.view().draft!.diffs[0]!.diff;
    expect(diff).toContain("+      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },");
    expect(diff).toContain('+      visibilityTimeout: cdk.Duration.minutes(2),');
  });

  it('does not paint a discarded Draft when its synth finishes after the discard', async () => {
    const synth = new FakeSynth();
    const r = await rig({ synth });
    let release!: () => void;
    synth.result = () => new Promise((resolve) => (release = () => resolve(good())));
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
      expect(refusal(await set(r, UPLOADS, 'removalPolicy', { kind: 'enum', type: 'aws-cdk-lib.RemovalPolicy', member: 'EXPLODE' }))).toMatch(/takes a enum/);
      expect(refusal(await set(r, UPLOADS, 'removalPolicy', { kind: 'enum', type: 'aws-cdk-lib.aws_s3.Other', member: 'DESTROY' }))).toMatch(/takes a enum/);
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
      const reply = await session.handle({ type: 'setProp', requestId: 'r', id: 'Shapes/LoopOne', prop: ['fifo'], value: bool(true) });
      expect(refusal(reply)).toMatch(/loop/i);
      const fromVariable = await session.handle({ type: 'setProp', requestId: 'r', id: 'Shapes/FromVariable', prop: ['tableName'], value: { kind: 'string', value: 'x' } });
      expect(refusal(fromVariable)).toMatch(/passed as tableProps/);
      expect(session.draftSize()).toBe(0);
    });

    it('while the app does not synth, until it does again', async () => {
      const synth = new FakeSynth();
      const r = await rig({ synth });
      synth.result = () => ({ ok: false, error: { message: 'boom' } });
      r.files.change();
      await vi.waitFor(() => expect(r.session.view().error?.message).toBe('boom'));
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
      await vi.waitFor(() => expect(r.session.view().error).toMatchObject({ kind: 'draft', message: 'bad prop' }));
      expect(r.session.view().hasDesign).toBe(true);
      expect(refusal(await send(r, 'save'))).toMatch(/Fix the Problem.*bad prop/);
      // The Draft can still be edited and undone.
      expect(await set(r, 'ShopStack/Orders', 'fifo', bool(true))).toMatchObject({ type: 'ack' });
      await send(r, 'discard');
      expect(r.session.view().error).toBeUndefined();
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
      await vi.waitFor(() => expect(r.synth.calls.length).toBeGreaterThan(synths));
      expect(r.synth.calls.at(-1)).toEqual({});
    });

    it('waits for the synth in flight, so that it saves what the screen shows', async () => {
      const synth = new FakeSynth();
      const r = await rig({ synth });
      let release!: () => void;
      synth.result = () => new Promise((resolve) => (release = () => resolve(good())));
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
      const writes: Array<[string, string]> = [];
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
      source.diagnostics = (_dir, files) => [existing, ...(files.get(SHOP)!.includes('versioned: false') ? [{ file: SHOP, line: 12, code: 2322, message: 'Type is not assignable' }] : [])];
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
      await vi.waitFor(() => expect(r.session.view().draft?.notices).toHaveLength(1));
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
      await vi.waitFor(() => expect(r.synth.shadowCalls.length).toBeGreaterThan(1));
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
      await vi.waitFor(() => expect(r.session.view().draft?.notices).toHaveLength(1));
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
      await vi.waitFor(() => expect(r.session.view().draft?.notices).toHaveLength(1));
      await settled(r);
      r.files.sources.set(SHOP, r.files.sources.get(SHOP)!.replace("'Orders'", "'Renamed2'"));
      r.files.change();
      await vi.waitFor(() => expect(r.session.view().draft?.notices).toHaveLength(2));
      await settled(r);
      expect(r.session.view().draft?.notices.join('\n')).toMatch(/versioned → false on Uploads[^]*fifo → true on Orders/);

      await send(r, 'discard');
      expect(r.session.view().draft).toBeUndefined();
    });
  });

  describe('while the code on disk does not synth', () => {
    const breakApp = async (r: Rig) => {
      r.synth.result = () => ({ ok: false, error: { message: 'boom' } });
      r.files.change();
      await vi.waitFor(() => expect(r.session.view().error?.message).toBe('boom'));
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
      await vi.waitFor(() => expect(r.session.view().error).toBeUndefined());
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
      await vi.waitFor(() => expect(r.session.view().draft?.notices).toHaveLength(1));
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
