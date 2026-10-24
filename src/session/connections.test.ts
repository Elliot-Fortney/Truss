import { beforeAll, describe, expect, it } from 'vitest';
import { NodeFiles } from '../adapters/files/node-files.ts';
import { loadCatalog } from '../adapters/catalog/read-catalog.ts';
import { TsSource } from '../adapters/source/ts-source.ts';
import { ToolkitSynth } from '../adapters/synth/toolkit-synth.ts';
import type { Catalog } from '../core/catalog.ts';
import {
  connectionProps,
  hintsFor,
  intentForAddConnection,
  intentForChangeConnection,
  intentForRemoveConnection,
  type HintContext,
} from '../core/connection.ts';
import { emptySidecar } from '../core/sidecar.ts';
import type { Intent } from '../core/intents.ts';
import { buildView } from '../core/view.ts';
import { fixtureDir, readFixtureAssembly, readFixtureFiles } from '../../test/support/fixture.ts';
import { assertEditHolds, checkEdit, type EditApp } from './edit-check.ts';

const appDir = fixtureDir('connections');
const P = (id: string) => `Wiring/${id}`;
let catalog: Catalog;
let ctx: HintContext;
let app: EditApp;

beforeAll(async () => {
  const load = await loadCatalog(appDir, { log: () => undefined });
  if (!load.ok) throw new Error(load.message);
  catalog = load.catalog;
  const assembly = readFixtureAssembly('connections');
  const facts = new TsSource().analyse(readFixtureFiles('connections'), assembly, catalog);
  ctx = { view: buildView(facts, assembly, emptySidecar()), facts, catalog };
  app = { appDir, catalog, synth: new ToolkitSynth(), files: new NodeFiles(appDir), source: new TsSource() };
}, 60_000);

/** The hint that connects a and b with this wording. */
function hint(a: string, b: string, text: RegExp): string {
  const found = hintsFor(ctx, P(a), P(b));
  if (!found.ok) throw new Error(found.reason);
  const option = found.options.find((o) => text.test(o.text));
  if (!option) throw new Error(`no hint ${text}: ${found.options.map((o) => o.text).join(' | ')}`);
  return option.hint;
}

const add = (a: string, b: string, text: RegExp, env?: string | null): Intent => {
  const made = intentForAddConnection(ctx, P(a), P(b), hint(a, b, text), env);
  if (!made.ok) throw new Error(made.reason);
  return made.intent;
};

const idsOf = (on: string, peer: string, role?: 'primary' | 'secondary') =>
  (ctx.facts.calls ?? [])
    .filter((c) => c.on === P(on) && c.peer === P(peer) && (role === undefined || c.role === role))
    .map((c) => c.id);

const FILE = 'lib/wiring-stack.ts';

/** These run the real synth and the real type check over the fixture app, once for each edit. */
describe('assertEditHolds on the connections fixture', () => {
  it('holds for a Grant, written with the environment variable that goes with it', async () => {
    const { files } = await assertEditHolds(app, [add('Catalog', 'Idle', /is read by/)]);
    const text = files.get(FILE)!;
    expect(text).toContain("catalog.grants.readData(idle);\n    idle.addEnvironment('TABLE_NAME', catalog.tableName);");
  });

  it('holds for a Grant with the environment variable renamed, and with it left out', async () => {
    const renamed = await assertEditHolds(app, [add('Catalog', 'Idle', /is read by/, 'TABLE')]);
    expect(renamed.files.get(FILE)).toContain("idle.addEnvironment('TABLE', catalog.tableName);");
    const without = await assertEditHolds(app, [add('Catalog', 'Idle', /is read by/, null)]);
    expect(without.files.get(FILE)).not.toContain('TABLE_NAME');
  });

  it('holds for an Integration, with the imports its arguments need', async () => {
    const { files } = await assertEditHolds(app, [add('Uploads', 'Worker', /invokes/)]);
    const text = files.get(FILE)!;
    expect(text).toMatch(
      /uploads\.addEventNotification\(\w+\.EventType\.OBJECT_CREATED, new \w+\.LambdaDestination\(worker\)\);/,
    );
    expect(text).toContain('aws-cdk-lib/aws-s3-notifications');
  });

  it('holds for an Integration written on the other Node, and one with a class named by an import', async () => {
    await assertEditHolds(app, [add('Events', 'Worker', /notifies/)]);
    await assertEditHolds(app, [add('Orders', 'Idle', /is triggered by/)]);
  });

  it('holds for a Network Connection', async () => {
    const { files } = await assertEditHolds(app, [add('Db', 'Reporter', /accepts connections from/)]);
    expect(files.get(FILE)).toContain('db.connections.allowDefaultPortFrom(reporter);');
  });

  it('holds for the calls of a Connection removed, the environment variable with them', async () => {
    const made = intentForRemoveConnection(ctx, [...idsOf('Uploads', 'Handler'), ...idsOf('Handler', 'Uploads')]);
    if (!made.ok) throw new Error(made.reason);
    const { files } = await assertEditHolds(app, [made.intent]);
    expect(files.get(FILE)).not.toContain('uploads.grantRead(handler)');
    expect(files.get(FILE)).not.toContain('BUCKET_NAME');
  });

  it('holds for one call of a Connection removed alone', async () => {
    const made = intentForRemoveConnection(ctx, idsOf('Handler', 'Uploads', 'secondary'));
    if (!made.ok) throw new Error(made.reason);
    const { files } = await assertEditHolds(app, [made.intent]);
    expect(files.get(FILE)).toContain('uploads.grantRead(handler);');
    expect(files.get(FILE)).not.toContain('BUCKET_NAME');
  });

  it('holds for a Grant a generic jsii method makes, removed', async () => {
    const made = intentForRemoveConnection(ctx, idsOf('Orders', 'Idle'));
    if (!made.ok) throw new Error(made.reason);
    const { files } = await assertEditHolds(app, [made.intent]);
    expect(files.get(FILE)).not.toContain('grantPurge');
  });

  it('holds for a Connection changed to another kind, in the place of the old calls', async () => {
    const made = intentForChangeConnection(ctx, [...idsOf('Uploads', 'Handler'), ...idsOf('Handler', 'Uploads')], {
      hint: hint('Uploads', 'Handler', /read and written/),
    });
    if (!made.ok) throw new Error(made.reason);
    const { files } = await assertEditHolds(app, [made.intent]);
    const text = files.get(FILE)!;
    expect(text).toContain(
      "uploads.grants.readWrite(handler);\n    handler.addEnvironment('BUCKET_NAME', uploads.bucketName);",
    );
    expect(text).not.toContain('grantRead(handler)');
  });

  it('holds for the environment variable of a Connection renamed, and switched off', async () => {
    const ids = [...idsOf('Uploads', 'Handler'), ...idsOf('Handler', 'Uploads')];
    const renamed = intentForChangeConnection(ctx, ids, { env: 'BUCKET' });
    if (!renamed.ok) throw new Error(renamed.reason);
    expect((await assertEditHolds(app, [renamed.intent])).files.get(FILE)).toContain(
      "handler.addEnvironment('BUCKET', uploads.bucketName);",
    );
    const off = intentForChangeConnection(ctx, ids, { env: null });
    if (!off.ok) throw new Error(off.reason);
    const { files } = await assertEditHolds(app, [off.intent]);
    expect(files.get(FILE)).toContain('uploads.grantRead(handler);');
    expect(files.get(FILE)).not.toContain('BUCKET_NAME');
  });

  it('holds for two Grants on one pair taken as the combined Grant', async () => {
    const edge = ctx.view.edges.find((e) => e.id === `grant:${P('Handler')}->${P('Catalog')}`)!;
    const props = connectionProps(ctx, edge);
    expect(props?.combine?.text).toMatch(/is read and written by/);
    const made = intentForChangeConnection(
      ctx,
      edge.calls!.map((c) => c.id),
      { hint: props!.combine!.hint },
    );
    if (!made.ok) throw new Error(made.reason);
    const { files } = await assertEditHolds(app, [made.intent]);
    expect(files.get(FILE)).toContain('catalog.grants.readWriteData(handler);');
    expect(files.get(FILE)).not.toContain('catalog.grants.readData(handler)');
  });

  it('holds for a Node deleted, which takes the calls that connect it with it', async () => {
    const { files } = await assertEditHolds(app, [
      { type: 'removeNode', path: P('Uploads'), expect: { className: 's3.Bucket', literalId: 'Uploads' } },
    ]);
    expect(files.get(FILE)).not.toContain('uploads');
    expect(files.get(FILE)).not.toContain('BUCKET_NAME');
  });

  it('does not hold for a Connection that the app refuses to synth', async () => {
    // A Function outside the VPC has no security group to open a port for.
    const outcome = await checkEdit(app, [add('Db', 'Worker', /accepts connections from/)]);
    expect(outcome.ok).toBe(false);
  });
});
