import { describe, expect, it } from 'vitest';
import type { Assembly } from './assembly.ts';
import type { Facts } from './facts.ts';
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
    Api: { span: span(1), className: 'ApiStack', literalId: 'Api', pathsOnSpan: 1 },
    'Api/Jobs': { span: span(10), className: 'sqs.Queue', literalId: 'Jobs', pathsOnSpan: 1 },
    'Web/Site': { span: span(20), className: 's3.Bucket', literalId: 'Site', pathsOnSpan: 1 },
  },
};

describe('buildView', () => {
  const view = buildView(facts, assembly);

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
});
