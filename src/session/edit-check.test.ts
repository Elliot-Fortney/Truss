import { describe, expect, it } from 'vitest';
import { NodeFiles } from '../adapters/files/node-files.ts';
import { TsSource } from '../adapters/source/ts-source.ts';
import { ToolkitSynth } from '../adapters/synth/toolkit-synth.ts';
import type { Intent, PropValue } from '../core/intents.ts';
import { fixtureDir } from '../../test/support/fixture.ts';
import { assertEditHolds, checkEdit, type EditApp } from './edit-check.ts';

const appDir = fixtureDir('straight-line');
const app = (): EditApp => ({
  appDir,
  synth: new ToolkitSynth(),
  files: new NodeFiles(appDir),
  source: new TsSource(),
});

const set = (id: string, className: string, prop: string[], value: PropValue): Intent => ({
  type: 'setProp',
  path: `ShopStack/${id}`,
  expect: { className, literalId: id },
  prop,
  value,
});

/** These run the real synth and the real type check over the fixture app, once for each edit. */
describe('assertEditHolds on the straight-line fixture', () => {
  it('holds for an edit of a literal', async () => {
    const { diffs } = await assertEditHolds(app(), [
      set('Uploads', 's3.Bucket', ['versioned'], { kind: 'boolean', value: false }),
    ]);
    expect(diffs.map((d) => d.file)).toEqual(['lib/shop-stack.ts']);
    expect(diffs[0]!.diff).toContain('-      versioned: true,\n+      versioned: false,');
  });

  it('holds for a prop added after the last one, which moves every construct below it', async () => {
    const { files } = await assertEditHolds(app(), [
      set('Uploads', 's3.Bucket', ['bucketName'], { kind: 'string', value: 'uploads' }),
    ]);
    expect(files.get('lib/shop-stack.ts')).toContain("      versioned: true,\n      bucketName: 'uploads',\n");
  });

  it('holds for a Duration, an enum and a field of an object-literal prop in one edit', async () => {
    await assertEditHolds(app(), [
      set('Orders', 'sqs.Queue', ['visibilityTimeout'], { kind: 'duration', unit: 'minutes', amount: 2 }),
      set('Catalog', 'dynamodb.Table', ['partitionKey', 'type'], {
        kind: 'enum',
        type: 'aws-cdk-lib.aws_dynamodb.AttributeType',
        member: 'NUMBER',
      }),
      set('Catalog', 'dynamodb.Table', ['billingMode'], {
        kind: 'enum',
        type: 'aws-cdk-lib.aws_dynamodb.BillingMode',
        member: 'PAY_PER_REQUEST',
      }),
      set('Uploads', 's3.Bucket', ['removalPolicy'], {
        kind: 'enum',
        type: 'aws-cdk-lib.RemovalPolicy',
        member: 'DESTROY',
      }),
    ]);
  });

  it('holds for a prop that makes the construct create more constructs beneath itself', async () => {
    await assertEditHolds(app(), [
      set('Uploads', 's3.Bucket', ['encryption'], {
        kind: 'enum',
        type: 'aws-cdk-lib.aws_s3.BucketEncryption',
        member: 'KMS',
      }),
    ]);
  });

  it('holds for a rename, which moves one subtree in the assembly and changes the code in one place', async () => {
    const rename: Intent = {
      type: 'renameId',
      path: 'ShopStack/Uploads',
      expect: { className: 's3.Bucket', literalId: 'Uploads' },
      newId: 'Files',
    };
    const { diffs, files } = await assertEditHolds(app(), [rename]);
    expect(diffs[0]!.diff).toContain("-    new s3.Bucket(this, 'Uploads', {\n+    new s3.Bucket(this, 'Files', {");
    expect(files.get('lib/shop-stack.ts')).not.toContain("'Uploads'");
  });

  it('holds for a rename of a Node edited in the same Draft, by the path the Draft shows', async () => {
    await assertEditHolds(app(), [
      {
        type: 'renameId',
        path: 'ShopStack/Orders',
        expect: { className: 'sqs.Queue', literalId: 'Orders' },
        newId: 'Jobs',
      },
      set('Jobs', 'sqs.Queue', ['visibilityTimeout'], { kind: 'duration', unit: 'minutes', amount: 2 }),
    ]);
  });

  it('does not hold for a rename to the ID of a sibling, which CDK refuses to synth', async () => {
    const outcome = await checkEdit(app(), [
      {
        type: 'renameId',
        path: 'ShopStack/Uploads',
        expect: { className: 's3.Bucket', literalId: 'Uploads' },
        newId: 'Orders',
      },
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      failures: expect.arrayContaining([expect.stringContaining("doesn't synth")]),
    });
  });

  it('does not hold for a value the type checker rejects, and says where', async () => {
    const outcome = await checkEdit(app(), [set('Uploads', 's3.Bucket', ['bucketName'], { kind: 'number', value: 7 })]);
    expect(outcome).toMatchObject({
      ok: false,
      failures: expect.arrayContaining([expect.stringMatching(/lib\/shop-stack\.ts:\d+: TypeScript 2322/)]),
    });
  });

  it('does not hold for an edit Source cannot place', async () => {
    const outcome = await checkEdit(app(), [
      {
        ...set('Uploads', 's3.Bucket', ['versioned'], { kind: 'boolean', value: false }),
        expect: { className: 'sqs.Queue', literalId: 'Uploads' },
      },
    ]);
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

const referencesDir = fixtureDir('references');
const refs = (): EditApp => ({
  appDir: referencesDir,
  synth: new ToolkitSynth(),
  files: new NodeFiles(referencesDir),
  source: new TsSource(),
});
const node = (id: string, className: string) => ({ path: `Refs/${id}`, className, literalId: id });
const base = (id: string, className: string, prop: string) => ({
  path: `Refs/${id}`,
  expect: { className, literalId: id },
  prop,
});

/** These run the real synth and the real type check over the fixture app with References in it. */
describe('assertEditHolds on the references fixture', () => {
  it('holds for a Reference added to a prop the code does not pass, written in the object the call has', async () => {
    const { files, diffs } = await assertEditHolds(refs(), [
      { type: 'addReference', ...base('Plain', 's3.Bucket', 'encryptionKey'), to: node('Key', 'kms.Key') },
    ]);
    expect(files.get('lib/ref-stack.ts')).toContain(
      "const plain = new s3.Bucket(this, 'Plain', { encryptionKey: key });",
    );
    expect(diffs.map((d) => d.file)).toEqual(['lib/ref-stack.ts']);
  });

  it('holds for a Reference re-pointed from one Node to another', async () => {
    const { files } = await assertEditHolds(refs(), [
      {
        type: 'repointReference',
        ...base('Data', 's3.Bucket', 'encryptionKey'),
        was: node('Key', 'kms.Key'),
        to: node('Spare', 'kms.Key'),
      },
    ]);
    expect(files.get('lib/ref-stack.ts')).toContain('{ encryptionKey: spare, serverAccessLogsBucket: logs }');
  });

  it('holds for a Reference removed, and the construct it made beneath the Node goes with it', async () => {
    const { files } = await assertEditHolds(refs(), [
      {
        type: 'removeReference',
        ...base('Data', 's3.Bucket', 'serverAccessLogsBucket'),
        to: node('Logs', 's3.Bucket'),
      },
    ]);
    expect(files.get('lib/ref-stack.ts')).toContain("new s3.Bucket(this, 'Data', { encryptionKey: key });");
  });

  it('holds for Nodes added to an array prop, and taken out of it again', async () => {
    const { files } = await assertEditHolds(refs(), [
      {
        type: 'addReference',
        ...base('Reader', 'iam.Role', 'managedPolicies'),
        many: true,
        to: node('Write', 'iam.ManagedPolicy'),
      },
    ]);
    expect(files.get('lib/ref-stack.ts')).toContain('managedPolicies: [read, write]');
    await assertEditHolds(refs(), [
      {
        type: 'removeReference',
        ...base('Reader', 'iam.Role', 'managedPolicies'),
        to: node('Read', 'iam.ManagedPolicy'),
      },
    ]);
  });

  it('holds for a Reference to a Node made after the source, which moves the source statement below it', async () => {
    const { files, diffs } = await assertEditHolds(refs(), [
      { type: 'addReference', ...base('Early', 's3.Bucket', 'encryptionKey'), to: node('Target', 'kms.Key') },
    ]);
    const text = files.get('lib/ref-stack.ts')!;
    expect(text).toContain(
      "    const target = new kms.Key(this, 'Target');\n    // Made before the Node it will point at, so a Reference moves it below.\n    // Two lines of comment.\n    const early = new s3.Bucket(this, 'Early', { encryptionKey: target });",
    );
    expect(text.match(/'Early'/g)).toHaveLength(1);
    expect(diffs[0]!.diff).toContain("-    const early = new s3.Bucket(this, 'Early');");
  });

  it('does not hold when the type checker rejects the Node', async () => {
    const outcome = await checkEdit(refs(), [
      { type: 'addReference', ...base('Plain', 's3.Bucket', 'encryptionKey'), to: node('Logs', 's3.Bucket') },
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      failures: expect.arrayContaining([expect.stringMatching(/TypeScript 2/)]),
    });
  });
});

const shapesDir = fixtureDir('shapes');
const shapes = (): EditApp => ({
  appDir: shapesDir,
  synth: new ToolkitSynth(),
  files: new NodeFiles(shapesDir),
  source: new TsSource(),
});

/** ADR 0008: one edit in the body of a Stack or Stage class created twice has to show up in every instance and nowhere else. */
describe('assertEditHolds on the shapes fixture, where a Stage and a Stack class are each created twice', () => {
  it('holds for a prop set in a Stage created twice', async () => {
    const { diffs } = await assertEditHolds(shapes(), [
      {
        type: 'setProp',
        path: 'StageDev/Core/Events',
        expect: { className: 'sns.Topic', literalId: 'Events' },
        prop: ['displayName'],
        value: { kind: 'string', value: 'Events' },
      },
    ]);
    expect(diffs.map((d) => d.file)).toEqual(['lib/app-stage.ts']);
  });

  it('holds for a prop set in a Stack class created twice', async () => {
    const { diffs } = await assertEditHolds(shapes(), [
      {
        type: 'setProp',
        path: 'Prod/Alerts',
        expect: { className: 'sns.Topic', literalId: 'Alerts' },
        prop: ['displayName'],
        value: { kind: 'string', value: 'Alerts' },
      },
    ]);
    expect(diffs.map((d) => d.file)).toEqual(['lib/repeated-stack.ts']);
  });

  it('holds for a prop of the Stack created inside a Stage created twice', async () => {
    await assertEditHolds(shapes(), [
      {
        type: 'setProp',
        path: 'StageProd/Core',
        expect: { className: 'cdk.Stack', literalId: 'Core' },
        prop: ['description'],
        value: { kind: 'string', value: 'Core' },
      },
    ]);
  });
});
