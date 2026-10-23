import { describe, expect, it } from 'vitest';
import { readFixtureAssembly, readFixtureFiles } from '../../../test/support/fixture.ts';
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
      props: { form: 'object', props: [{ name: 'versioned', kind: 'literal', text: 'true' }] },
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
        { name: 'displayName', kind: 'literal', text: "'Plain'" },
        { name: 'fifo', kind: 'literal', text: 'false' },
      ],
    });
    expect(at('Shapes/Bound').props).toEqual({
      form: 'object',
      props: [{ name: 'retentionPeriod', kind: 'expression', text: 'cdk.Duration.days(1)' }],
    });
    expect(at('Shapes/Audit').props).toBeUndefined();
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

describe('the view of the shapes fixture', () => {
  const assembly = readFixtureAssembly('shapes');
  const facts = new TsSource().analyse(readFixtureFiles('shapes'), assembly);
  const locks = Object.fromEntries(buildView(facts, assembly, emptySidecar()).nodes.map((n) => [n.id, n.lock ?? 'editable']));

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
      'Shapes/Existing': 'editable',
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
