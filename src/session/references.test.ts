import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SynthResult } from '../core/assembly.ts';
import type { Catalog } from '../core/catalog.ts';
import type { FileSet, Files, Synth } from '../core/ports.ts';
import type { Reply } from '../core/protocol.ts';
import { loadCatalog } from '../adapters/catalog/read-catalog.ts';
import { TsSource } from '../adapters/source/ts-source.ts';
import { memoryFiles, type MemoryFiles } from '../../test/support/memory-files.ts';
import { fixtureDir, readFixtureAssembly, readFixtureFiles } from '../../test/support/fixture.ts';
import { Session } from './session.ts';

let catalog: Catalog;
beforeAll(async () => {
  const load = await loadCatalog(fixtureDir('references'), { log: () => undefined });
  if (!load.ok) throw new Error(load.message);
  catalog = load.catalog;
}, 60_000);

const REFS = 'lib/ref-stack.ts';
const recorded = (): SynthResult => ({ ok: true, assembly: readFixtureAssembly('references') });

/** A Synth that answers every call with the recorded assembly, shadow copies included. */
const synth: Synth = { synth: async () => recorded(), draftSupport: async () => ({ ok: true }) };

async function rig(): Promise<{ session: Session; files: MemoryFiles & { sources: Map<string, string> } }> {
  const sources = readFixtureFiles('references');
  const memory = memoryFiles(sources);
  const files = Object.assign(memory, { sources, read: async () => new Map(sources) }) as MemoryFiles & {
    sources: Map<string, string>;
  };
  const session = new Session({ appDir: '/app', synth, files: files, source: new TsSource(), catalog });
  await session.start();
  return { session, files };
}

let n = 0;
const ask = (s: Session, message: Record<string, unknown>): Promise<Reply> =>
  s.handle({ requestId: `r${++n}`, ...message } as never);
const refusal = (reply: Reply) => (reply.type === 'refused' ? reply.reason : `not refused: ${reply.type}`);
const settled = (s: Session) =>
  vi.waitFor(() => {
    expect(s.view().synthing).toBe(false);
  });
const P = (id: string) => `Refs/${id}`;

describe('the References of a Design', () => {
  it('draws the References the code writes as edges from the Node that holds them', async () => {
    const { session } = await rig();
    const edges = session
      .view()
      .edges.map((e) => `${e.from.slice(5)}->${e.to.slice(5)}:${e.prop}${e.index !== undefined ? `[${e.index}]` : ''}`);
    expect(edges.sort()).toEqual([
      'Data->Key:encryptionKey',
      'Data->Logs:serverAccessLogsBucket',
      'Reader->Read:managedPolicies[0]',
    ]);
    expect(session.view().edges.every((e) => e.readOnly === undefined)).toBe(true);
  });
});

describe('connectable', () => {
  it('answers, for every other Node, whether it takes a Reference from the one dragged, and through which props', async () => {
    const { session } = await rig();
    const reply = await ask(session, { type: 'connectable', id: P('Plain') });
    if (reply.type !== 'connectable') throw new Error(refusal(reply));
    expect(reply.targets[P('Key')]).toMatchObject({ ok: true, options: [{ prop: 'encryptionKey', many: false }] });
    expect(reply.targets[P('Logs')]).toMatchObject({ ok: true, options: [{ prop: 'serverAccessLogsBucket' }] });
    expect(reply.targets[P('Read')]).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no prop that takes'),
    });
    expect(reply.targets[P('Plain')]).toBeUndefined();
  });

  it('offers to replace a single value that points elsewhere, and refuses an exact duplicate', async () => {
    const { session } = await rig();
    const reply = await ask(session, { type: 'connectable', id: P('Data') });
    if (reply.type !== 'connectable') throw new Error(refusal(reply));
    expect(reply.targets[P('Spare')]).toMatchObject({
      ok: true,
      options: [{ prop: 'encryptionKey', replaces: { id: P('Key') } }],
    });
    expect(reply.targets[P('Key')]).toEqual({ ok: false, reason: 'encryptionKey already points at Key' });
  });

  it('refuses a Node that is not in the Design', async () => {
    const { session } = await rig();
    expect(refusal(await ask(session, { type: 'connectable', id: P('Nope') }))).toBe('No Node at Refs/Nope');
  });
});

describe('connect, disconnect and repoint', () => {
  it('stages a Reference added by a drop, shows it in the Draft list and the diff, and writes nothing to disk', async () => {
    const { session, files } = await rig();
    expect(
      await ask(session, { type: 'connect', from: P('Plain'), to: P('Key'), prop: 'encryptionKey' }),
    ).toMatchObject({ type: 'ack' });
    const draft = session.view().draft!;
    expect(draft.items).toEqual([{ id: P('Plain'), label: 'Plain', summary: 'encryptionKey → Key' }]);
    expect(draft.diffs[0]!.diff).toContain("+    const plain = new s3.Bucket(this, 'Plain', { encryptionKey: key });");
    expect(session.view().nodes.find((x) => x.id === P('Plain'))?.changed).toBe(true);
    await settled(session);
    expect(files.writes).toEqual([]);
  });

  it('asks for a replace before pointing a single value elsewhere, and then re-points', async () => {
    const { session } = await rig();
    expect(
      refusal(await ask(session, { type: 'connect', from: P('Data'), to: P('Spare'), prop: 'encryptionKey' })),
    ).toBe('encryptionKey already points at Key');
    expect(
      await ask(session, { type: 'connect', from: P('Data'), to: P('Spare'), prop: 'encryptionKey', replace: true }),
    ).toMatchObject({ type: 'ack' });
    expect(session.view().draft?.items.map((i) => i.summary)).toEqual(['encryptionKey → Spare (was Key)']);
    expect(session.view().draft?.diffs[0]!.diff).toContain(
      "+    const data = new s3.Bucket(this, 'Data', { encryptionKey: spare, serverAccessLogsBucket: logs });",
    );
  });

  it('takes a Reference out, and a Reference added and then removed leaves no edit at all', async () => {
    const { session } = await rig();
    expect(
      await ask(session, { type: 'disconnect', from: P('Data'), to: P('Logs'), prop: 'serverAccessLogsBucket' }),
    ).toMatchObject({ type: 'ack' });
    expect(session.view().draft?.diffs[0]!.diff).toContain(
      "-    const data = new s3.Bucket(this, 'Data', { encryptionKey: key, serverAccessLogsBucket: logs });",
    );
    await ask(session, { type: 'discard' });
    await ask(session, { type: 'connect', from: P('Plain'), to: P('Key'), prop: 'encryptionKey' });
    await ask(session, { type: 'disconnect', from: P('Plain'), to: P('Key'), prop: 'encryptionKey' });
    expect(session.view().draft).toBeUndefined();
  });

  it('moves the end of a Reference, and an element of an array prop', async () => {
    const { session } = await rig();
    expect(
      await ask(session, {
        type: 'repoint',
        from: P('Data'),
        was: P('Logs'),
        to: P('Plain'),
        prop: 'serverAccessLogsBucket',
      }),
    ).toMatchObject({ type: 'ack' });
    expect(session.view().draft?.diffs[0]!.diff).toContain('serverAccessLogsBucket: plain');
    await ask(session, { type: 'discard' });
    expect(
      await ask(session, {
        type: 'repoint',
        from: P('Reader'),
        was: P('Read'),
        to: P('Write'),
        prop: 'managedPolicies',
      }),
    ).toMatchObject({ type: 'ack' });
    expect(session.view().draft?.diffs[0]!.diff).toContain('managedPolicies: [write]');
  });

  it('says a statement moves, in the diff, when the Node it points at is made after it', async () => {
    const { session } = await rig();
    expect(
      await ask(session, { type: 'connect', from: P('Early'), to: P('Target'), prop: 'encryptionKey' }),
    ).toMatchObject({ type: 'ack' });
    const diff = session.view().draft!.diffs[0]!;
    expect(diff.moves).toEqual(['Early moves below Target']);
    expect(diff.diff).toContain("-    const early = new s3.Bucket(this, 'Early');");
  });

  it('refuses with the reason, and where the code is, when the source cannot take it', async () => {
    const { session } = await rig();
    const reply = await ask(session, { type: 'connect', from: P('Plain'), to: P('Read'), prop: 'encryptionKey' });
    expect(reply).toMatchObject({ type: 'refused', at: { file: REFS } });
    expect(refusal(reply)).toBe('Plain has no prop that takes Read');
    expect(session.view().draft).toBeUndefined();
  });

  it('refuses to take out a Reference the code does not have', async () => {
    const { session } = await rig();
    expect(
      refusal(await ask(session, { type: 'disconnect', from: P('Data'), to: P('Spare'), prop: 'encryptionKey' })),
    ).toBe("encryptionKey doesn't point at Spare");
  });
});

describe('the panel Node picker', () => {
  it('is checked as a drop is: the same intents', async () => {
    const { session } = await rig();
    await ask(session, { type: 'connect', from: P('Reader'), to: P('Write'), prop: 'managedPolicies' });
    expect(session.view().draft?.items.map((i) => i.summary)).toEqual(['managedPolicies → add Write']);
    expect(session.view().draft?.diffs[0]!.diff).toContain('managedPolicies: [read, write]');
  });
});
