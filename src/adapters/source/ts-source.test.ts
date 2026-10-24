import { describe, expect, it } from 'vitest';
import { readFixtureAssembly, readFixtureFiles } from '../../../test/support/fixture.ts';
import type { Assembly } from '../../core/assembly.ts';
import { emptySidecar } from '../../core/sidecar.ts';
import { buildView } from '../../core/view.ts';
import { TsSource } from './ts-source.ts';

describe('TsSource.analyse on the straight-line fixture', () => {
  const facts = new TsSource().analyse(readFixtureFiles('straight-line'), readFixtureAssembly('straight-line'));

  it('gives each construct its file, span, class and literal ID', () => {
    expect(facts.nodes['ShopStack/Uploads']).toEqual({
      span: { file: 'lib/shop-stack.ts', start: { line: 11, col: 5 }, end: { line: 13, col: 7 } },
      className: 's3.Bucket',
      literalId: 'Uploads',
      pathsOnSpan: 1,
      binding: 'none',
      enclosingClass: { name: 'ShopStack', kind: 'stack' },
      props: { form: 'object', props: [{ name: 'versioned', kind: 'literal', text: 'true', value: true }] },
    });
    expect(facts.nodes['ShopStack/Orders']).toMatchObject({ className: 'sqs.Queue', literalId: 'Orders' });
    expect(facts.nodes['ShopStack/Catalog']).toMatchObject({ className: 'dynamodb.Table', literalId: 'Catalog' });
  });

  it('gives the stack its own facts at the call in bin/', () => {
    expect(facts.nodes['ShopStack']).toMatchObject({
      span: { file: 'bin/app.ts', start: { line: 5, col: 1 } },
      className: 'ShopStack',
      literalId: 'ShopStack',
      pathsOnSpan: 1,
      binding: 'none',
    });
  });

  it('has no facts for resources the app did not write', () => {
    expect(Object.keys(facts.nodes).sort()).toEqual([
      'ShopStack',
      'ShopStack/Catalog',
      'ShopStack/Orders',
      'ShopStack/Uploads',
    ]);
  });
});

describe('TsSource.analyse on a stack with a single construct', () => {
  it('still gives that construct its own Node, not the stack', () => {
    const assembly = readFixtureAssembly('straight-line');
    const only = assembly.tree.children[0]!;
    only.children = only.children.filter((c) => c.id === 'Uploads');
    for (const path of ['ShopStack', 'ShopStack/Orders/Resource', 'ShopStack/Catalog/Resource']) delete assembly.creation[path];
    const facts = new TsSource().analyse(readFixtureFiles('straight-line'), assembly);
    expect(Object.keys(facts.nodes)).toEqual(['ShopStack/Uploads']);
  });
});

describe('TsSource.analyse on the shapes fixture', () => {
  const facts = new TsSource().analyse(readFixtureFiles('shapes'), readFixtureAssembly('shapes'));
  const at = (path: string) => facts.nodes[path]!;

  it('reports how each construct is bound: a bare statement, a const, a field', () => {
    expect(at('Shapes/Plain').binding).toBe('none');
    expect(at('Shapes/Bound').binding).toBe('const');
    expect(at('Shapes/Audit').binding).toBe('field');
    expect(at('Shapes/Initialised').binding).toBe('field');
  });

  it('sees through parentheses and a cast when finding what the `new` is bound to', () => {
    expect(at('Shapes/Wrapped').binding).toBe('const');
  });

  it('reports the class whose body holds the `new`, and whether it is a Stack, a Stage or a construct', () => {
    expect(at('Shapes/Plain').enclosingClass).toEqual({ name: 'ShapesStack', kind: 'stack' });
    expect(at('Dev/Alerts').enclosingClass).toEqual({ name: 'RepeatedStack', kind: 'stack' });
    expect(at('Shapes').enclosingClass).toBeUndefined();
  });

  it('says when the `new` is in a loop, whether a statement or a callback, and shares one span between the iterations', () => {
    expect(at('Shapes/LoopOne').surround).toEqual({ kind: 'loop' });
    expect(at('Shapes/LoopTwo').span).toEqual(at('Shapes/LoopOne').span);
    expect(at('Shapes/LoopOne').pathsOnSpan).toBe(2);
    expect(at('Shapes/EachLeft').surround).toEqual({ kind: 'loop' });
    expect(at('Shapes/EachLeft').pathsOnSpan).toBe(2);
  });

  it('names the helper function that holds the `new`', () => {
    expect(at('Shapes/HelperA').surround).toEqual({ kind: 'helper', name: 'makeQueue' });
    expect(at('Shapes/HelperA').pathsOnSpan).toBe(2);
    expect(at('Shapes/HelperA').literalId).toBeUndefined();
  });

  it('has no surround for a `new` that sits in a constructor body', () => {
    expect(at('Shapes/Plain').surround).toBeUndefined();
  });

  it('finds the `new` of an app-defined construct class, which synth gives no stack of its own', () => {
    expect(at('Shapes/Api')).toMatchObject({
      span: { file: 'lib/shapes-stack.ts', start: { line: 50, col: 5 } },
      className: 'ApiService',
      literalId: 'Api',
      enclosingClass: { name: 'ShapesStack', kind: 'stack' },
      pathsOnSpan: 1,
    });
  });

  it('puts what such a class creates inside the class, as a construct', () => {
    expect(at('Shapes/Api/Jobs')).toMatchObject({
      span: { file: 'lib/api-service.ts', start: { line: 8, col: 5 } },
      className: 'sqs.Queue',
      enclosingClass: { name: 'ApiService', kind: 'construct' },
    });
  });

  it('has no literal ID when the ID is a variable', () => {
    expect(at('Shapes/Orders').className).toBe('dynamodb.Table');
    expect(at('Shapes/Orders').literalId).toBeUndefined();
  });

  it('reads each prop of an object literal as a literal or an expression, with its source text', () => {
    expect(at('Shapes/Plain').props).toEqual({
      form: 'object',
      props: [
        { name: 'displayName', kind: 'literal', text: "'Plain'", value: 'Plain' },
        { name: 'fifo', kind: 'literal', text: 'false', value: false },
      ],
    });
    expect(at('Shapes/Bound').props).toEqual({
      form: 'object',
      props: [{ name: 'retentionPeriod', kind: 'expression', text: 'cdk.Duration.days(1)', quantity: { type: 'Duration', unit: 'days', amount: 1 } }],
    });
    expect(at('Shapes/Audit').props).toBeUndefined();
  });

  it('reads an enum member, a quantity and an object literal field by field', () => {
    const files = new Map([
      [
        'lib/x.ts',
        `new dynamodb.Table(this, 'T', {
  partitionKey: { name: 'sku', type: dynamodb.AttributeType.STRING },
  removalPolicy: RemovalPolicy.DESTROY,
  size: Size.mebibytes(512),
  timeout: cdk.Duration.seconds(someVar),
  other: lower.case,
});
`,
      ],
    ]);
    const assembly = {
      schemaVersion: '1',
      tree: { id: 'App', path: '', fqn: 'aws-cdk-lib.App', children: [{ id: 'T', path: 'T', fqn: 'x', children: [] }] },
      stacks: [],
      creation: { T: [{ file: 'lib/x.ts', line: 1, col: 1 }] },
      resourceRefs: [],
    };
    const props = new TsSource().analyse(files, assembly).nodes['T']?.props;
    expect(props).toEqual({
      form: 'object',
      props: [
        {
          name: 'partitionKey',
          kind: 'object',
          text: "{ name: 'sku', type: dynamodb.AttributeType.STRING }",
          fields: [
            { name: 'name', kind: 'literal', text: "'sku'", value: 'sku' },
            { name: 'type', kind: 'expression', text: 'dynamodb.AttributeType.STRING', member: { type: 'AttributeType', name: 'STRING' } },
          ],
        },
        { name: 'removalPolicy', kind: 'expression', text: 'RemovalPolicy.DESTROY', member: { type: 'RemovalPolicy', name: 'DESTROY' } },
        { name: 'size', kind: 'expression', text: 'Size.mebibytes(512)', quantity: { type: 'Size', unit: 'mebibytes', amount: 512 } },
        { name: 'timeout', kind: 'expression', text: 'cdk.Duration.seconds(someVar)' },
        { name: 'other', kind: 'expression', text: 'lower.case' },
      ],
    });
  });

  it('keeps props given as a variable as one piece of source text, not a list of props', () => {
    expect(at('Shapes/FromVariable').props).toEqual({ form: 'other', text: 'tableProps' });
  });

  it('gives two constructs on one line their own spans', () => {
    const [a, b] = [at('Shapes/SameLineA'), at('Shapes/SameLineB')];
    expect(a.span.start.line).toBe(b.span.start.line);
    expect(a.span.end.col).toBeLessThan(b.span.start.col);
    expect([a.literalId, b.literalId]).toEqual(['SameLineA', 'SameLineB']);
  });

  it('gives a construct nested in another\'s props its own span, inside the outer one', () => {
    const [outer, inner] = [at('Shapes/Outer'), at('Shapes/Inner')];
    expect(inner.literalId).toBe('Inner');
    expect(inner.span.start.col).toBeGreaterThan(outer.span.start.col);
    expect(inner.span.end.col).toBeLessThan(outer.span.end.col);
    expect(outer.props).toMatchObject({
      form: 'object',
      props: [{ name: 'eventBridgeEnabled' }, { name: 'serverAccessLogsBucket', kind: 'expression', text: "new s3.Bucket(this, 'Inner')" }],
    });
  });

  it('gives a stack class created more than once the same span for each instance', () => {
    expect(at('Dev/Alerts').pathsOnSpan).toBe(2);
    expect(at('Prod/Alerts').span).toEqual(at('Dev/Alerts').span);
  });
});

describe('TsSource.analyse on the shapes fixture: classes, nested stacks, Stages and imports', () => {
  const facts = new TsSource().analyse(readFixtureFiles('shapes'), readFixtureAssembly('shapes'));
  const at = (path: string) => facts.nodes[path]!;

  it('finds the `new` of a class of the app\'s own that extends a CDK construct, not the constructor it runs', () => {
    expect(at('Shapes/Docs')).toMatchObject({
      span: { file: 'lib/shapes-stack.ts', start: { line: 60, col: 5 } },
      className: 'MyBucket',
      literalId: 'Docs',
      enclosingClass: { name: 'ShapesStack', kind: 'stack' },
      pathsOnSpan: 1,
    });
  });

  it('does the same when that class calls `super` itself', () => {
    expect(at('Shapes/Audit2')).toMatchObject({ className: 'AuditedTopic', literalId: 'Audit2', span: { start: { line: 61 } } });
  });

  it('gives a nested stack its own facts at its `new`, without the construct that wraps its resource in the parent', () => {
    expect(at('Shapes/Nested')).toMatchObject({ className: 'InnerStack', literalId: 'Nested', pathsOnSpan: 1 });
    expect(facts.nodes['Shapes/Nested.NestedStack']).toBeUndefined();
  });

  it('puts what a nested stack creates inside the nested stack\'s class', () => {
    expect(at('Shapes/Nested/InnerQueue')).toMatchObject({
      span: { file: 'lib/inner-stack.ts', start: { line: 9, col: 5 } },
      className: 'sqs.Queue',
      enclosingClass: { name: 'InnerStack', kind: 'stack' },
      pathsOnSpan: 1,
    });
  });

  it('counts the instances of a Stage created twice on every span inside it', () => {
    expect(at('StageDev/Core/Events').pathsOnSpan).toBe(2);
    expect(at('StageProd/Core/Events').span).toEqual(at('StageDev/Core/Events').span);
    expect(at('StageDev/Core/Events').enclosingClass).toEqual({ name: 'AppStage', kind: 'stage' });
  });

  it('finds a `fromXxx` call as an external Node at the call', () => {
    expect(at('Shapes/Existing')).toEqual({
      span: { file: 'lib/shapes-stack.ts', start: { line: 65, col: 5 }, end: { line: 65, col: 66 } },
      className: 's3.Bucket.fromBucketName',
      literalId: 'Existing',
      pathsOnSpan: 1,
      binding: 'none',
      enclosingClass: { name: 'ShapesStack', kind: 'stack' },
      external: true,
    });
  });
});

describe('TsSource.analyse finds a `fromXxx` call in the constructor of a base class', () => {
  const files = new Map([
    ['bin/app.ts', "const app = new cdk.App();\nnew Child(app, 'S');\n"],
    [
      'lib/stacks.ts',
      [
        'export class Base extends cdk.Stack {',
        '  constructor(scope: Construct, id: string) {',
        '    super(scope, id);',
        "    s3.Bucket.fromBucketName(this, 'Imp', 'x');",
        '  }',
        '}',
        'export class Child extends Base {}',
      ].join('\n'),
    ],
  ]);
  const tree = (id: string, path: string, fqn: string, children: Assembly['tree'][] = []) => ({ id, path, fqn, children });
  const assembly: Assembly = {
    schemaVersion: '55.0.0',
    stacks: [{ path: 'S' }],
    creation: { S: [{ file: 'bin/app.ts', line: 2, col: 1 }] },
    resourceRefs: [],
    tree: tree('App', '', 'aws-cdk-lib.App', [tree('S', 'S', 'aws-cdk-lib.Stack', [tree('Imp', 'S/Imp', 'aws-cdk-lib.aws_s3.BucketBase')])]),
  };

  it('gives the subclass\'s instance the external, though the call is written in the base class', () => {
    const facts = new TsSource().analyse(files, assembly);
    expect(facts.nodes['S/Imp']).toMatchObject({ external: true, literalId: 'Imp', className: 's3.Bucket.fromBucketName', pathsOnSpan: 1 });
  });
});

describe('the view of the shapes fixture', () => {
  const assembly = readFixtureAssembly('shapes');
  const facts = new TsSource().analyse(readFixtureFiles('shapes'), assembly);
  // A hoisted Node is no shape of the app's code; the view's own tests cover it.
  const locks = Object.fromEntries(buildView(facts, assembly, emptySidecar()).nodes.filter((n) => !n.hoisted).map((n) => [n.id, n.lock ?? 'editable']));

  it('locks each shape Truss cannot rewrite, with the reason, and leaves the rest editable', () => {
    expect(locks).toEqual({
      'Shapes/Plain': 'editable',
      'Shapes/Bound': 'editable',
      'Shapes/Audit': 'editable',
      'Shapes/Initialised': 'editable',
      'Shapes/Wrapped': 'editable',
      'Shapes/SameLineA': 'editable',
      'Shapes/SameLineB': 'editable',
      'Shapes/Outer': 'editable',
      'Shapes/Inner': 'editable',
      'Shapes/LoopOne': 'Created in a loop',
      'Shapes/LoopTwo': 'Created in a loop',
      'Shapes/EachLeft': 'Created in a loop',
      'Shapes/EachRight': 'Created in a loop',
      'Shapes/HelperA': 'Created by the helper makeQueue',
      'Shapes/HelperB': 'Created by the helper makeQueue',
      'Shapes/Api': 'editable',
      'Shapes/Orders': 'Its Construct ID is not a string literal',
      'Shapes/FromVariable': 'editable',
      'Shapes/Docs': 'editable',
      'Shapes/Audit2': 'editable',
      'Shapes/Existing': 'Refers to an existing resource; the app does not create it',
      'Shapes/Nested/InnerQueue': 'editable',
      'Dev/Alerts': 'editable',
      'Prod/Alerts': 'editable',
      'StageDev/Core/Events': 'editable',
      'StageProd/Core/Events': 'editable',
    });
  });

  it('shows the Stages in the order the app creates them, and a nested stack as a box in its parent', () => {
    const view = buildView(facts, assembly, emptySidecar());
    expect(view.stages).toEqual([
      { id: 'StageDev', label: 'StageDev' },
      { id: 'StageProd', label: 'StageProd' },
    ]);
    expect(view.stacks.map((s) => [s.id, s.parentId, s.stageId])).toEqual([
      ['Shapes', undefined, undefined],
      ['Shapes/Nested', 'Shapes', undefined],
      ['Dev', undefined, undefined],
      ['Prod', undefined, undefined],
      ['StageDev/Core', undefined, 'StageDev'],
      ['StageProd/Core', undefined, 'StageProd'],
    ]);
  });

  it('marks the `fromXxx` Node as external and names the user classes by class and base type', () => {
    const nodes = Object.fromEntries(buildView(facts, assembly, emptySidecar()).nodes.map((n) => [n.id, n]));
    expect(nodes['Shapes/Existing']).toMatchObject({ external: true, label: 'Existing', subtitle: 'Bucket.fromBucketName' });
    expect(nodes['Shapes/Docs']?.subtitle).toBe('MyBucket · S3 Bucket');
    expect(nodes['Shapes/Audit2']?.subtitle).toBe('AuditedTopic · SNS Topic');
    expect(nodes['Shapes/Api']?.subtitle).toBe('ApiService');
  });
});

describe('TsSource.analyse: References', () => {
  const STACK = `import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class AppStack extends Stack {
  private readonly shared = new s3.Bucket(this, 'Shared');
  readonly network: Network;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, 'Vpc');
    const net = vpc;
    const group = new ec2.SecurityGroup(this, 'Group', { vpc });
    const logs = new s3.Bucket(this, 'Logs');
    this.network = new Network(this, 'Network');
    new lambda.Function(this, 'ByName', { vpc, securityGroups: [group, group2], logging: logs });
    new lambda.Function(this, 'ByAlias', { vpc: net });
    new lambda.Function(this, 'ByField', { vpc: this.network.vpc, serverAccessLogsBucket: this.shared, role: this.shared.role });
    new lambda.Function(this, 'ByCall', { vpc: pick(vpc, other), name: \`\${vpc.vpcId}\` });
    new lambda.Function(this, 'ByChoice', { vpc: flag ? vpc : net });
    new lambda.Function(this, 'Short', { vpc, name: vpc.vpcId });
    new lambda.Function(this, 'Inline', { vpc: new ec2.Vpc(this, 'Inner'), other: someParam });
  }
}
`;
  const needles: Record<string, string> = {
    'S/Shared': "new s3.Bucket(this, 'Shared')",
    'S/Vpc': "new ec2.Vpc(this, 'Vpc')",
    'S/Group': "new ec2.SecurityGroup(this, 'Group'",
    'S/Logs': "new s3.Bucket(this, 'Logs')",
    'S/Network': "new Network(this, 'Network')",
    'S/ByName': "new lambda.Function(this, 'ByName'",
    'S/ByAlias': "new lambda.Function(this, 'ByAlias'",
    'S/ByField': "new lambda.Function(this, 'ByField'",
    'S/ByCall': "new lambda.Function(this, 'ByCall'",
    'S/ByChoice': "new lambda.Function(this, 'ByChoice'",
    'S/Short': "new lambda.Function(this, 'Short'",
    'S/Inline': "new lambda.Function(this, 'Inline'",
    'S/Inner': "new ec2.Vpc(this, 'Inner')",
  };
  const frame = (needle: string) => {
    const at = STACK.indexOf(needle);
    const before = STACK.slice(0, at);
    return { file: 'lib/app.ts', line: before.split('\n').length, col: at - before.lastIndexOf('\n') };
  };
  const assembly: Assembly = {
    schemaVersion: '1',
    tree: { id: 'App', path: '', fqn: 'aws-cdk-lib.App', children: [{ id: 'S', path: 'S', fqn: 'aws-cdk-lib.Stack', children: Object.keys(needles).map((p) => ({ id: p.slice(2), path: p, fqn: 'x', children: [] })) }] },
    stacks: [{ path: 'S' }],
    creation: { S: [{ file: 'bin/app.ts', line: 1, col: 1 }], ...Object.fromEntries(Object.entries(needles).map(([path, needle]) => [path, [frame(needle)]])) },
    resourceRefs: [],
  };
  const facts = new TsSource().analyse(new Map([['lib/app.ts', STACK]]), assembly);
  const refs = (from: string) => (facts.references ?? []).filter((r) => r.from === from).map(({ to, prop, form, editable, index }) => ({ to, prop, form, editable, ...(index !== undefined ? { index } : {}) }));

  it('reads an identifier bound to a const, as an editable Reference, in a prop or in an element of an array prop', () => {
    expect(refs('S/ByName')).toEqual([
      { to: 'S/Vpc', prop: 'vpc', form: 'shorthand', editable: true },
      { to: 'S/Group', prop: 'securityGroups', form: 'identifier', editable: true, index: 0 },
      { to: 'S/Logs', prop: 'logging', form: 'identifier', editable: true },
    ]);
  });

  it('reads a shorthand property and a const alias of a Node as editable', () => {
    expect(refs('S/Short')).toContainEqual({ to: 'S/Vpc', prop: 'vpc', form: 'shorthand', editable: true });
    expect(refs('S/ByAlias')).toEqual([{ to: 'S/Vpc', prop: 'vpc', form: 'alias', editable: true }]);
  });

  it('reads this.field, bound by an assignment or a class property initializer, as editable', () => {
    expect(refs('S/ByField')).toContainEqual({ to: 'S/Shared', prop: 'serverAccessLogsBucket', form: 'field', editable: true });
  });

  it('draws an accessor chain to the Node that owns it, and leaves it read-only', () => {
    expect(refs('S/ByField')).toContainEqual({ to: 'S/Network', prop: 'vpc', form: 'accessor', editable: false });
    expect(refs('S/ByField')).toContainEqual({ to: 'S/Shared', prop: 'role', form: 'accessor', editable: false });
    expect(refs('S/Short')).toContainEqual({ to: 'S/Vpc', prop: 'name', form: 'accessor', editable: false });
  });

  it('draws a Node passed through a call, or chosen by a condition, as read-only', () => {
    expect(refs('S/ByCall')).toEqual([{ to: 'S/Vpc', prop: 'vpc', form: 'call', editable: false }]);
    expect(refs('S/ByChoice')).toEqual([
      { to: 'S/Vpc', prop: 'vpc', form: 'conditional', editable: false },
      { to: 'S/Vpc', prop: 'vpc', form: 'conditional', editable: false },
    ]);
  });

  it('leaves a token that is not a Node, a token inside a template, and a construct written in the prop itself, as source text', () => {
    expect(refs('S/Inline')).toEqual([]);
    expect(refs('S/ByCall')).not.toContainEqual(expect.objectContaining({ prop: 'name' }));
    expect(facts.references?.every((r) => r.from !== 'S/Vpc')).toBe(true);
  });

  it('says where the expression is, and what it says', () => {
    const r = facts.references!.find((x) => x.from === 'S/ByName' && x.prop === 'logging')!;
    expect(r.text).toBe('logs');
    expect(r.reason).toBeUndefined();
    expect(r.span.start.line).toBeGreaterThan(1);
  });

  it('has no references for an app without any', () => {
    expect(new TsSource().analyse(readFixtureFiles('straight-line'), readFixtureAssembly('straight-line')).references).toBeUndefined();
  });
});
