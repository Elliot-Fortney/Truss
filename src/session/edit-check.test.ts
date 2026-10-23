import { describe, expect, it } from 'vitest';
import { NodeFiles } from '../adapters/files/node-files.ts';
import { TsSource } from '../adapters/source/ts-source.ts';
import { ToolkitSynth } from '../adapters/synth/toolkit-synth.ts';
import type { Intent, PropValue } from '../core/intents.ts';
import { fixtureDir } from '../../test/support/fixture.ts';
import { assertEditHolds, checkEdit, type EditApp } from './edit-check.ts';

const appDir = fixtureDir('straight-line');
const app = (): EditApp => ({ appDir, synth: new ToolkitSynth(), files: new NodeFiles(appDir), source: new TsSource() });

const set = (id: string, className: string, prop: string[], value: PropValue): Intent => ({ type: 'setProp', path: `ShopStack/${id}`, expect: { className, literalId: id }, prop, value });

/** These run the real synth and the real type check over the fixture app, once for each edit. */
describe('assertEditHolds on the straight-line fixture', () => {
  it('holds for an edit of a literal', async () => {
    const { diffs } = await assertEditHolds(app(), [set('Uploads', 's3.Bucket', ['versioned'], { kind: 'boolean', value: false })]);
    expect(diffs.map((d) => d.file)).toEqual(['lib/shop-stack.ts']);
    expect(diffs[0]!.diff).toContain('-      versioned: true,\n+      versioned: false,');
  });

  it('holds for a prop added after the last one, which moves every construct below it', async () => {
    const { files } = await assertEditHolds(app(), [set('Uploads', 's3.Bucket', ['bucketName'], { kind: 'string', value: 'uploads' })]);
    expect(files.get('lib/shop-stack.ts')).toContain("      versioned: true,\n      bucketName: 'uploads',\n");
  });

  it('holds for a Duration, an enum and a field of an object-literal prop in one edit', async () => {
    await assertEditHolds(app(), [
      set('Orders', 'sqs.Queue', ['visibilityTimeout'], { kind: 'duration', unit: 'minutes', amount: 2 }),
      set('Catalog', 'dynamodb.Table', ['partitionKey', 'type'], { kind: 'enum', type: 'aws-cdk-lib.aws_dynamodb.AttributeType', member: 'NUMBER' }),
      set('Catalog', 'dynamodb.Table', ['billingMode'], { kind: 'enum', type: 'aws-cdk-lib.aws_dynamodb.BillingMode', member: 'PAY_PER_REQUEST' }),
      set('Uploads', 's3.Bucket', ['removalPolicy'], { kind: 'enum', type: 'aws-cdk-lib.RemovalPolicy', member: 'DESTROY' }),
    ]);
  });

  it('holds for a prop that makes the construct create more constructs beneath itself', async () => {
    await assertEditHolds(app(), [set('Uploads', 's3.Bucket', ['encryption'], { kind: 'enum', type: 'aws-cdk-lib.aws_s3.BucketEncryption', member: 'KMS' })]);
  });

  it('holds for a rename, which moves one subtree in the assembly and changes the code in one place', async () => {
    const rename: Intent = { type: 'renameId', path: 'ShopStack/Uploads', expect: { className: 's3.Bucket', literalId: 'Uploads' }, newId: 'Files' };
    const { diffs, files } = await assertEditHolds(app(), [rename]);
    expect(diffs[0]!.diff).toContain("-    new s3.Bucket(this, 'Uploads', {\n+    new s3.Bucket(this, 'Files', {");
    expect(files.get('lib/shop-stack.ts')).not.toContain("'Uploads'");
  });

  it('holds for a rename of a Node edited in the same Draft, by the path the Draft shows', async () => {
    await assertEditHolds(app(), [
      { type: 'renameId', path: 'ShopStack/Orders', expect: { className: 'sqs.Queue', literalId: 'Orders' }, newId: 'Jobs' },
      set('Jobs', 'sqs.Queue', ['visibilityTimeout'], { kind: 'duration', unit: 'minutes', amount: 2 }),
    ]);
  });

  it('does not hold for a rename to the ID of a sibling, which CDK refuses to synth', async () => {
    const outcome = await checkEdit(app(), [{ type: 'renameId', path: 'ShopStack/Uploads', expect: { className: 's3.Bucket', literalId: 'Uploads' }, newId: 'Orders' }]);
    expect(outcome).toMatchObject({ ok: false, failures: expect.arrayContaining([expect.stringContaining("doesn't synth")]) });
  });

  it('does not hold for a value the type checker rejects, and says where', async () => {
    const outcome = await checkEdit(app(), [set('Uploads', 's3.Bucket', ['bucketName'], { kind: 'number', value: 7 })]);
    expect(outcome).toMatchObject({ ok: false, failures: expect.arrayContaining([expect.stringMatching(/lib\/shop-stack\.ts:\d+: TypeScript 2322/)]) });
  });

  it('does not hold for an edit Source cannot place', async () => {
    const outcome = await checkEdit(app(), [{ ...set('Uploads', 's3.Bucket', ['versioned'], { kind: 'boolean', value: false }), expect: { className: 'sqs.Queue', literalId: 'Uploads' } }]);
    expect(outcome).toMatchObject({ ok: false, failures: [expect.stringContaining('no longer')] });
  });

  it('does not hold when the edit makes the app fail to synth', async () => {
    // A queue cannot be FIFO with a name that does not end in .fifo: CDK refuses at synth, which type checking cannot see.
    const outcome = await checkEdit(app(), [
      set('Orders', 'sqs.Queue', ['fifo'], { kind: 'boolean', value: true }),
      set('Orders', 'sqs.Queue', ['queueName'], { kind: 'string', value: 'orders' }),
    ]);
    expect(outcome).toMatchObject({ ok: false, failures: [expect.stringContaining("doesn't synth with the edit")] });
  });
});
