import { describe, expect, it } from 'vitest';
import type { Facts } from '../../core/facts.ts';
import { readFixtureAssembly, readFixtureFiles } from '../../../test/support/fixture.ts';
import { TsSource } from './ts-source.ts';

const analyseWith = (code: string): Facts => {
  const files = readFixtureFiles('connections');
  files.set(
    'lib/wiring-stack.ts',
    files
      .get('lib/wiring-stack.ts')!
      .replace('    // The handler reaches the database.', `${code}\n    // The handler reaches the database.`),
  );
  return new TsSource().analyse(files, readFixtureAssembly('connections'));
};
const summary = (facts: Facts) => (facts.overrides ?? []).map((o) => `${o.node.slice(7)}: ${o.text}`);

describe('Overrides', () => {
  it('reads the three escape hatches on a Node’s default child, through a variable, a cast or a field', () => {
    const facts = analyseWith(`
    const cfnBucket = uploads.node.defaultChild as s3.CfnBucket;
    cfnBucket.addPropertyOverride('VersioningConfiguration.Status', 'Enabled');
    (orders.node.defaultChild as sqs.CfnQueue).addOverride('Properties.DelaySeconds', 5);
    const cfnTable = catalog.node.defaultChild!;
    (cfnTable as dynamodb.CfnTable).addDeletionOverride('Properties.SSESpecification');`);
    expect(summary(facts)).toEqual([
      "Uploads: cfnBucket.addPropertyOverride('VersioningConfiguration.Status', 'Enabled');",
      "Orders: (orders.node.defaultChild as sqs.CfnQueue).addOverride('Properties.DelaySeconds', 5);",
      "Catalog: (cfnTable as dynamodb.CfnTable).addDeletionOverride('Properties.SSESpecification');",
    ]);
    expect(facts.overrides![0]).toMatchObject({ method: 'addPropertyOverride', span: { file: 'lib/wiring-stack.ts' } });
  });

  it('reads a Layer child found by its ID', () => {
    const facts = analyseWith(`
    (uploads.node.findChild('Resource') as s3.CfnBucket).addPropertyOverride('A', 1);
    (uploads.node.tryFindChild('Resource') as s3.CfnBucket).addPropertyOverride('B', 2);`);
    expect(summary(facts)).toEqual([
      "Uploads: (uploads.node.findChild('Resource') as s3.CfnBucket).addPropertyOverride('A', 1);",
      "Uploads: (uploads.node.tryFindChild('Resource') as s3.CfnBucket).addPropertyOverride('B', 2);",
    ]);
  });

  it('ignores an override call whose receiver is not a Node’s child', () => {
    const facts = analyseWith(`
    somewhere.addPropertyOverride('A', 1);
    uploads.addOverride('B', 2);
    const other = unknownThing.node.defaultChild as s3.CfnBucket;
    other.addPropertyOverride('C', 3);
    uploads.node.defaultChild;`);
    expect(facts.overrides).toBeUndefined();
  });
});
