import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SynthResult } from '../core/assembly.ts';
import type { Catalog } from '../core/catalog.ts';
import type { Files, Synth } from '../core/ports.ts';
import type { Reply } from '../core/protocol.ts';
import { loadCatalog } from '../adapters/catalog/read-catalog.ts';
import { TsSource } from '../adapters/source/ts-source.ts';
import { memoryFiles } from '../../test/support/memory-files.ts';
import { fixtureDir, readFixtureAssembly, readFixtureFiles } from '../../test/support/fixture.ts';
import { Session } from './session.ts';

let catalog: Catalog;
beforeAll(async () => {
  const load = await loadCatalog(fixtureDir('connections'), { log: () => undefined });
  if (!load.ok) throw new Error(load.message);
  catalog = load.catalog;
}, 60_000);

const recorded = (): SynthResult => ({ ok: true, assembly: readFixtureAssembly('connections') });
const synth: Synth = { synth: async () => recorded(), draftSupport: async () => ({ ok: true }) };

async function rig() {
  const sources = readFixtureFiles('connections');
  const files = Object.assign(memoryFiles(sources), { read: async () => new Map(sources) }) as unknown as Files;
  const session = new Session({ appDir: '/app', synth, files, source: new TsSource(), catalog });
  await session.start();
  return session;
}

let n = 0;
const ask = (s: Session, message: Record<string, unknown>): Promise<Reply> => s.handle({ requestId: `r${++n}`, ...message } as never);
const P = (id: string) => `Wiring/${id}`;
const settled = (s: Session) => vi.waitFor(() => expect(s.view().synthing).toBe(false));

describe('Connections of a Design', () => {
  it('draws the edges the code makes with their calls, editable when the calls are, and read-only when none is recognised', async () => {
    const s = await rig();
    const edges = s.view().edges;
    const grant = edges.find((e) => e.id === `grant:${P('Handler')}->${P('Uploads')}`)!;
    expect(grant.readOnly).toBeUndefined();
    expect(grant.calls?.map((c) => c.role)).toEqual(['primary', 'secondary']);
    expect(grant.connection?.access?.options.map((o) => o.text)).toContain('Uploads is read and written by Handler');
    expect(grant.connection?.env).toEqual({ name: 'BUCKET_NAME', on: true, default: 'BUCKET_NAME' });
    const unexplained = edges.find((e) => e.id === `grant:${P('Worker')}->${P('Orders')}`)!;
    expect(unexplained.readOnly).toMatch(/no call it recognises/);
    expect(unexplained.connection).toBeUndefined();
    expect(edges.find((e) => e.id === `grant:${P('Handler')}->${P('Catalog')}`)?.connection?.combine?.text).toMatch(/read and written/);
  });

  it('offers hints when a drag ends on a Node, the Overlay default first, and never a generic grant method', async () => {
    const s = await rig();
    const reply = await ask(s, { type: 'connectable', id: P('Uploads') });
    if (reply.type !== 'connectable') throw new Error('no answer');
    const check = reply.targets[P('Reporter')]!;
    expect(check).toMatchObject({ ok: true });
    const hints = check.ok ? (check.hints ?? []) : [];
    expect(hints.map((h) => h.text)).toEqual(['Uploads is read by Reporter', 'Uploads invokes Reporter', 'Uploads is written by Reporter', 'Uploads is read and written by Reporter']);
    expect(hints[0]).toMatchObject({ default: true, env: 'BUCKET_NAME' });
    expect(hints.some((h) => /purge/i.test(h.text))).toBe(false);
    // Already connected as read: the pair is offered the combined Grant in place of the half it would add.
    const connected = (await ask(s, { type: 'connectable', id: P('Uploads') })) as Extract<Reply, { type: 'connectable' }>;
    const toHandler = connected.targets[P('Handler')]!;
    expect(toHandler.ok && toHandler.hints?.find((h) => /read and written/.test(h.text))?.replaces).toHaveLength(2);
    expect(toHandler.ok && toHandler.hints?.some((h) => /is read by/.test(h.text))).toBe(false);
  });

  it('stages a Connection, shows it in the Draft, and takes it back with Undo', async () => {
    const s = await rig();
    const hint = ((await ask(s, { type: 'connectable', id: P('Uploads') })) as Extract<Reply, { type: 'connectable' }>).targets[P('Reporter')]!;
    const id = hint.ok ? hint.hints![0]!.hint : '';
    const staged = await ask(s, { type: 'addConnection', a: P('Uploads'), b: P('Reporter'), hint: id });
    expect(staged.type).toBe('ack');
    await settled(s);
    expect(s.view().draft?.items).toHaveLength(1);
    expect(s.view().draft?.diffs[0]?.diff).toContain('+    uploads.grants.read(reporter);');
    expect(s.view().draft?.diffs[0]?.diff).toContain("+    reporter.addEnvironment('BUCKET_NAME', uploads.bucketName);");
    await ask(s, { type: 'undo' });
    expect(s.view().draft?.items).toEqual([]);
  });

  it('refuses what the Overlays do not offer, and a call Truss leaves alone, with the reason', async () => {
    const s = await rig();
    const none = await ask(s, { type: 'addConnection', a: P('Uploads'), b: P('Reporter'), hint: 'aws-cdk-lib.aws_s3.Bucket#99' });
    expect(none).toMatchObject({ type: 'refused', reason: expect.stringContaining('not offered') });
    const gone = await ask(s, { type: 'removeConnection', calls: ['lib/nowhere.ts:1:1'] });
    expect(gone.type).toBe('refused');
  });
});
