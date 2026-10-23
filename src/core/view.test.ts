import { describe, expect, it } from 'vitest';
import type { Assembly, TreeNode } from './assembly.ts';
import type { Facts, NodeFacts } from './facts.ts';
import { emptySidecar } from './sidecar.ts';
import { buildView } from './view.ts';

const span = (line: number) => ({ file: 'lib/a.ts', start: { line, col: 5 }, end: { line, col: 20 } });

const assembly: Assembly = {
  schemaVersion: '55.0.0',
  stacks: [{ path: 'Api', env: 'aws://123456789012/us-east-1' }, { path: 'Web' }],
  creation: {},
  tree: {
    id: 'App',
    path: '',
    fqn: 'aws-cdk-lib.App',
    children: [
      {
        id: 'Api',
        path: 'Api',
        fqn: 'aws-cdk-lib.Stack',
        children: [
          {
            id: 'Jobs',
            path: 'Api/Jobs',
            fqn: 'aws-cdk-lib.aws_sqs.Queue',
            children: [{ id: 'Resource', path: 'Api/Jobs/Resource', fqn: 'aws-cdk-lib.aws_sqs.CfnQueue', children: [] }],
          },
          { id: 'CheckBootstrapVersion', path: 'Api/CheckBootstrapVersion', fqn: 'aws-cdk-lib.CfnRule', children: [] },
        ],
      },
      {
        id: 'Web',
        path: 'Web',
        fqn: 'aws-cdk-lib.Stack',
        children: [{ id: 'Site', path: 'Web/Site', fqn: 'aws-cdk-lib.aws_s3.Bucket', children: [] }],
      },
    ],
  },
};

const facts: Facts = {
  nodes: {
    Api: { span: span(1), className: 'ApiStack', literalId: 'Api', pathsOnSpan: 1, binding: 'none' },
    'Api/Jobs': { span: span(10), className: 'sqs.Queue', literalId: 'Jobs', pathsOnSpan: 1, binding: 'none' },
    'Web/Site': { span: span(20), className: 's3.Bucket', literalId: 'Site', pathsOnSpan: 2, binding: 'none', surround: { kind: 'loop' } },
  },
};

describe('buildView', () => {
  const view = buildView(facts, assembly, emptySidecar());

  it('draws each Stack as a box headed by its id and environment', () => {
    expect(view.stacks).toEqual([
      { id: 'Api', label: 'Api', env: 'us-east-1 · 123456789012' },
      { id: 'Web', label: 'Web', env: 'env-agnostic' },
    ]);
  });

  it('puts each construct the app wrote in its Stack box as a Node, with a generic icon', () => {
    expect(view.nodes.map((n) => [n.id, n.stackId, n.label, n.subtitle, n.icon])).toEqual([
      ['Api/Jobs', 'Api', 'Jobs', 'Queue', 'generic'],
      ['Web/Site', 'Web', 'Site', 'Bucket', 'generic'],
    ]);
  });

  it('is not a Node for the Stack itself, nor for the L1 beneath a Node, nor for hoisted resources', () => {
    const ids = view.nodes.map((n) => n.id);
    expect(ids).not.toContain('Api');
    expect(ids).not.toContain('Api/Jobs/Resource');
    expect(ids).not.toContain('Api/CheckBootstrapVersion');
  });

  it('records where in the code each Node came from', () => {
    expect(view.nodes[0]?.source).toEqual({ file: 'lib/a.ts', line: 10, col: 5 });
  });

  it('leaves a Node editable by default and locks one with the reason its code cannot be edited', () => {
    const [jobs, site] = view.nodes;
    expect(jobs).not.toHaveProperty('lock');
    expect(site?.lock).toBe('Created in a loop');
  });
});

const leaf = (path: string, fqn: string, children: TreeNode[] = []): TreeNode => ({ id: path.split('/').at(-1)!, path, fqn, children });
const here = (line: number) => ({ file: 'lib/a.ts', start: { line, col: 5 }, end: { line, col: 30 } });

describe('buildView with nested stacks and Stages', () => {
  const assembly: Assembly = {
    schemaVersion: '55.0.0',
    stacks: [{ path: 'Pipeline' }, { path: 'Dev/Core', env: 'aws://111111111111/eu-west-1' }, { path: 'Prod/Core', env: 'aws://111111111111/eu-west-1' }],
    creation: {},
    tree: leaf('', 'aws-cdk-lib.App', [
      leaf('Pipeline', 'aws-cdk-lib.Stack', [leaf('Pipeline/Repo', 'aws-cdk-lib.aws_s3.Bucket')]),
      leaf('Dev', 'aws-cdk-lib.Stage', [
        leaf('Dev/Core', 'aws-cdk-lib.Stack', [
          leaf('Dev/Core/Jobs', 'aws-cdk-lib.aws_sqs.Queue'),
          leaf('Dev/Core/Worker', 'aws-cdk-lib.NestedStack', [leaf('Dev/Core/Worker/Inbox', 'aws-cdk-lib.aws_sqs.Queue')]),
          leaf('Dev/Core/Worker.NestedStack', 'constructs.Construct', [leaf('Dev/Core/Worker.NestedStack/Worker.NestedStackResource', 'aws-cdk-lib.CfnStack')]),
        ]),
      ]),
      leaf('Prod', 'aws-cdk-lib.Stage', [leaf('Prod/Core', 'aws-cdk-lib.Stack', [leaf('Prod/Core/Jobs', 'aws-cdk-lib.aws_sqs.Queue')])]),
    ]),
  };
  const node = (className: string, id: string, extra: Partial<NodeFacts> = {}): NodeFacts => ({
    span: here(1),
    className,
    literalId: id,
    pathsOnSpan: 1,
    binding: 'none',
    ...extra,
  });
  const facts: Facts = {
    nodes: {
      'Pipeline/Repo': node('s3.Bucket', 'Repo'),
      'Dev/Core/Jobs': node('sqs.Queue', 'Jobs', { pathsOnSpan: 2 }),
      'Dev/Core/Worker': node('WorkerStack', 'Worker'),
      'Dev/Core/Worker/Inbox': node('sqs.Queue', 'Inbox'),
      'Prod/Core/Jobs': node('sqs.Queue', 'Jobs', { pathsOnSpan: 2 }),
    },
  };
  const view = buildView(facts, assembly, emptySidecar());

  it('lists the Stages in the order the app creates them', () => {
    expect(view.stages).toEqual([
      { id: 'Dev', label: 'Dev' },
      { id: 'Prod', label: 'Prod' },
    ]);
  });

  it('says which Stage each Stack belongs to, and none for a Stack outside every Stage', () => {
    expect(view.stacks.map((s) => [s.id, s.stageId])).toEqual([
      ['Pipeline', undefined],
      ['Dev/Core', 'Dev'],
      ['Dev/Core/Worker', 'Dev'],
      ['Prod/Core', 'Prod'],
    ]);
  });

  it('draws a nested stack as a box inside its parent, with the parent\'s environment, listed after the parent', () => {
    expect(view.stacks.find((s) => s.id === 'Dev/Core/Worker')).toEqual({
      id: 'Dev/Core/Worker',
      label: 'Worker',
      env: 'eu-west-1 · 111111111111',
      parentId: 'Dev/Core',
      stageId: 'Dev',
    });
    expect(view.stacks.find((s) => s.id === 'Dev/Core')).not.toHaveProperty('parentId');
  });

  it('puts what a nested stack creates in the nested stack\'s box, and makes neither it nor its plumbing a Node', () => {
    expect(view.nodes.map((n) => [n.id, n.stackId])).toEqual([
      ['Pipeline/Repo', 'Pipeline'],
      ['Dev/Core/Jobs', 'Dev/Core'],
      ['Dev/Core/Worker/Inbox', 'Dev/Core/Worker'],
      ['Prod/Core/Jobs', 'Prod/Core'],
    ]);
  });

  it('has no Stages for an app without any', () => {
    expect(buildView({ nodes: {} }, { ...assembly, tree: leaf('', 'aws-cdk-lib.App', [leaf('Pipeline', 'aws-cdk-lib.Stack')]) }, emptySidecar()).stages).toEqual([]);
  });
});

describe('buildView naming', () => {
  const assembly: Assembly = {
    schemaVersion: '55.0.0',
    stacks: [{ path: 'S' }],
    creation: {},
    tree: leaf('', 'aws-cdk-lib.App', [
      leaf('S', 'aws-cdk-lib.Stack', [
        leaf('S/Plain', 'aws-cdk-lib.aws_s3.Bucket'),
        leaf('S/Docs', 'aws-cdk-lib.aws_s3.Bucket'),
        leaf('S/Table', 'aws-cdk-lib.aws_dynamodb.Table'),
        leaf('S/Api', 'constructs.Construct'),
        leaf('S/Existing', 'aws-cdk-lib.aws_s3.BucketBase'),
        leaf('S/Stream', 'aws-cdk-lib.aws_kinesis.Stream'),
        leaf('S/Web', 'aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService'),
      ]),
    ]),
  };
  const node = (className: string, id: string, extra: Partial<NodeFacts> = {}): NodeFacts => ({ span: here(1), className, literalId: id, pathsOnSpan: 1, binding: 'none', ...extra });
  const view = buildView(
    {
      nodes: {
        'S/Plain': node('s3.Bucket', 'Plain'),
        'S/Docs': node('MyBucket', 'Docs'),
        'S/Table': node('MyTable', 'Table'),
        'S/Api': node('ApiService', 'Api'),
        'S/Existing': node('s3.Bucket.fromBucketName', 'Existing', { external: true }),
        'S/Stream': node('MyStream', 'Stream'),
        'S/Web': node('MyWeb', 'Web'),
      },
    },
    assembly,
    emptySidecar(),
  );
  const byId = (id: string) => view.nodes.find((n) => n.id === id)!;

  it('names a construct of the app\'s own class by that class and the type it is, "MyBucket · S3 Bucket"', () => {
    expect(byId('S/Docs').subtitle).toBe('MyBucket · S3 Bucket');
    expect(byId('S/Table').subtitle).toBe('MyTable · DynamoDB Table');
  });

  it('names the type by the service when its module is one word, and by the class alone when it is not', () => {
    expect(byId('S/Stream').subtitle).toBe('MyStream · Kinesis Stream');
    expect(byId('S/Web').subtitle).toBe('MyWeb');
  });

  it('names a class that only extends Construct by its own name', () => {
    expect(byId('S/Api').subtitle).toBe('ApiService');
  });

  it('leaves a CDK class named as written', () => {
    expect(byId('S/Plain').subtitle).toBe('Bucket');
  });

  it('marks a Node made by a `fromXxx` call as external, and names it by the call', () => {
    expect(byId('S/Existing')).toMatchObject({ external: true, subtitle: 'Bucket.fromBucketName' });
    expect(byId('S/Plain')).not.toHaveProperty('external');
  });
});
