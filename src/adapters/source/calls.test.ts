import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '../catalog/read-catalog.ts';
import type { Catalog } from '../../core/catalog.ts';
import type { Facts } from '../../core/facts.ts';
import { fixtureDir, readFixtureAssembly, readFixtureFiles } from '../../../test/support/fixture.ts';
import { TsSource } from './ts-source.ts';

let catalog: Catalog;
beforeAll(async () => {
  const load = await loadCatalog(fixtureDir('connections'), { log: () => undefined });
  if (!load.ok) throw new Error(load.message);
  catalog = load.catalog;
}, 60_000);

const summary = (facts: Facts) => (facts.calls ?? []).map((c) => `${c.role} ${c.kind} ${c.on.slice(7)}.${c.method.join('.')}(${c.peer.slice(7)}) ${c.from.slice(7)}->${c.to.slice(7)}${c.env ? ` env=${c.env}` : ''}${c.editable ? '' : ` READONLY ${c.reason}`}`);

describe('analyse on the connections fixture', () => {
  it('reads Overlay hint calls in both forms, a generic jsii grant, and the environment variable that goes with a grant', () => {
    const facts = new TsSource().analyse(readFixtureFiles('connections'), readFixtureAssembly('connections'), catalog);
    expect(summary(facts)).toEqual([
      'primary grant Uploads.grantRead(Handler) Handler->Uploads',
      'secondary grant Handler.addEnvironment(Uploads) Handler->Uploads env=BUCKET_NAME',
      'primary grant Catalog.grants.readWriteData(Worker) Worker->Catalog',
      'primary grant Catalog.grants.readData(Handler) Handler->Catalog',
      'primary grant Catalog.grants.writeData(Handler) Handler->Catalog',
      'primary grant Orders.grantPurge(Idle) Idle->Orders',
      'primary integration Worker.addEventSource(Orders) Orders->Worker',
      'primary integration Events.addSubscription(Idle) Events->Idle',
      'primary network Db.connections.allowDefaultPortFrom(Handler) Handler->Db',
    ]);
    expect((facts.calls ?? []).find((c) => c.method[0] === 'grantPurge')?.hint).toBeUndefined();
    expect((facts.calls ?? []).find((c) => c.method[0] === 'grantRead')?.hint).toMatch(/^aws-cdk-lib\.aws_s3\.Bucket#\d+$/);
  });

  it('reads nothing without the Catalog', () => {
    expect(new TsSource().analyse(readFixtureFiles('connections'), readFixtureAssembly('connections')).calls).toBeUndefined();
  });

  it('leaves calls in a helper, a loop or under a condition read-only, with the reason', () => {
    const files = readFixtureFiles('connections');
    const text = files.get('lib/wiring-stack.ts')!
      .replace('    uploads.grantRead(handler);', '    if (Math.random() > 2) uploads.grantRead(handler);')
      .replace("    orders.grantPurge(idle);", "    for (const f of [idle]) { orders.grantPurge(idle); }")
      .replace('    db.connections.allowDefaultPortFrom(handler);', '    const wire = () => { db.connections.allowDefaultPortFrom(handler); };\n    wire();');
    files.set('lib/wiring-stack.ts', text);
    const calls = new TsSource().analyse(files, readFixtureAssembly('connections'), catalog).calls ?? [];
    const why = (m: string) => calls.find((c) => c.method.join('.').endsWith(m))?.reason;
    expect(why('grantRead')).toMatch(/condition/);
    expect(why('grantPurge')).toMatch(/loop/);
    expect(why('allowDefaultPortFrom')).toMatch(/helper wire/);
  });

  it('does not read a call whose receiver or argument is not a Node of the code', () => {
    const files = readFixtureFiles('connections');
    files.set('lib/wiring-stack.ts', files.get('lib/wiring-stack.ts')!.replace('orders.grantPurge(idle);', 'orders.grantPurge(somewhere.else);'));
    const calls = new TsSource().analyse(files, readFixtureAssembly('connections'), catalog).calls ?? [];
    expect(calls.some((c) => c.method[0] === 'grantPurge')).toBe(false);
  });
});
