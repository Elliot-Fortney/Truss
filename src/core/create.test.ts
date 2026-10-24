import { describe, expect, it } from 'vitest';
import type { TreeNode } from './assembly.ts';
import { buildCatalog, digestAssembly } from './catalog.ts';
import { freshId, intentForAdd, intentForDuplicate, intentForRemove } from './create.ts';
import type { NodeFacts } from './facts.ts';
import type { PanelView } from './panel.ts';

const tree: TreeNode = {
  id: '',
  path: '',
  fqn: 'App',
  children: [{ id: 'Dev', path: 'Dev', fqn: 'Stack', children: ['Bucket', 'Bucket2', 'Logs'].map((id) => ({ id, path: `Dev/${id}`, fqn: 'x', children: [] })) }],
};
const scope = { id: 'Dev', tree, facts: { span: { file: 'f.ts', start: { line: 1, col: 1 }, end: { line: 1, col: 2 } }, className: 'MyStack', literalId: 'Dev', pathsOnSpan: 1, binding: 'none' } satisfies NodeFacts };

const doc = { summary: 's', stability: 'stable' };
const digest = digestAssembly({
  name: 'aws-cdk-lib',
  version: '2.0.0',
  types: {
    'aws-cdk-lib.aws_s3.Bucket': { kind: 'class', fqn: 'aws-cdk-lib.aws_s3.Bucket', name: 'Bucket', namespace: 'aws_s3', base: 'constructs.Construct', docs: doc, initializer: { parameters: [{}, {}, { type: { fqn: 'aws-cdk-lib.aws_s3.BucketProps' } }] } },
    'aws-cdk-lib.aws_s3.BucketProps': { kind: 'interface', datatype: true, fqn: 'aws-cdk-lib.aws_s3.BucketProps', properties: [{ name: 'bucketName', type: { primitive: 'string' }, optional: true }] },
    'aws-cdk-lib.aws_sns.Topic': { kind: 'class', fqn: 'aws-cdk-lib.aws_sns.Topic', name: 'Topic', namespace: 'aws_sns', base: 'constructs.Construct', docs: doc, initializer: { parameters: [{}, {}, { type: { fqn: 'aws-cdk-lib.aws_sns.TopicProps' } }] } },
    'aws-cdk-lib.aws_sns.TopicProps': { kind: 'interface', datatype: true, fqn: 'aws-cdk-lib.aws_sns.TopicProps', properties: [{ name: 'displayName', type: { primitive: 'string' } }] },
  },
});
const catalog = buildCatalog([digest], [{ fqn: 'aws-cdk-lib.aws_sns.Topic', displayName: 'SNS Topic', defaults: { displayName: { code: "'Topic'" } } }]);
const withoutOverlay = buildCatalog([digest]);

describe('freshId', () => {
  it('is the name itself when it is free, and the next number otherwise', () => {
    expect(freshId('Bucket', [])).toBe('Bucket');
    expect(freshId('Bucket', ['Bucket'])).toBe('Bucket2');
    expect(freshId('Bucket', ['Bucket', 'Bucket2'])).toBe('Bucket3');
  });

  it('counts on from a number the name already ends in', () => {
    expect(freshId('Bucket2', ['Bucket2'])).toBe('Bucket3');
  });

  it('does not take a name CDK would read as a sibling’s', () => {
    expect(freshId('Resource', ['Default'])).toBe('Resource2');
  });
});

describe('intentForAdd', () => {
  it('names the Stack as the user saw it and gives the construct an ID no sibling has', () => {
    expect(intentForAdd(catalog, 'aws-cdk-lib.aws_s3.Bucket', scope, {})).toEqual({
      ok: true,
      intent: { type: 'addNode', path: 'Dev', expect: { className: 'MyStack', literalId: 'Dev' }, fqn: 'aws-cdk-lib.aws_s3.Bucket', id: 'Bucket3', props: [] },
    });
  });

  it('fills a required prop from the Overlay’s default', () => {
    expect(intentForAdd(catalog, 'aws-cdk-lib.aws_sns.Topic', scope, {})).toMatchObject({ ok: true, intent: { props: [{ name: 'displayName', snippet: { code: "'Topic'" } }] } });
  });

  it('takes the user’s value over the default', () => {
    const value = { kind: 'string', value: 'Mine' } as const;
    expect(intentForAdd(catalog, 'aws-cdk-lib.aws_sns.Topic', scope, { displayName: value })).toMatchObject({ ok: true, intent: { props: [{ name: 'displayName', value }] } });
  });

  it('asks for a required prop with neither', () => {
    expect(intentForAdd(withoutOverlay, 'aws-cdk-lib.aws_sns.Topic', scope, {})).toMatchObject({ ok: false, form: [{ name: 'displayName' }] });
  });

  it('refuses what the Catalog does not have, and a Stack with no code', () => {
    expect(intentForAdd(catalog, 'aws-cdk-lib.aws_x.Nope', scope, {})).toMatchObject({ ok: false, reason: expect.stringContaining('not in the Catalog') });
    expect(intentForAdd(undefined, 'aws-cdk-lib.aws_s3.Bucket', scope, {})).toMatchObject({ ok: false });
    expect(intentForAdd(catalog, 'aws-cdk-lib.aws_s3.Bucket', { ...scope, facts: undefined }, {})).toMatchObject({ ok: false, reason: expect.stringContaining('no code') });
  });
});

describe('intentForDuplicate', () => {
  const panel = (over: Partial<PanelView> = {}): PanelView => ({ id: 'Dev/Logs', kind: 'node', className: 's3.Bucket', literalId: 'Logs', idEdit: { siblings: ['Bucket'] }, rows: [], more: [], ...over });

  it('copies under a fresh ID, naming the Node as the user saw it', () => {
    expect(intentForDuplicate(panel(), 'Dev/Logs')).toEqual({ ok: true, intent: { type: 'duplicate', path: 'Dev/Logs', expect: { className: 's3.Bucket', literalId: 'Logs' }, newId: 'Logs2' } });
  });

  it('refuses a Node that can not be edited, and a Stack', () => {
    expect(intentForDuplicate(panel({ readOnly: 'Created in a loop' }), 'Dev/Logs')).toEqual({ ok: false, reason: 'Created in a loop' });
    expect(intentForDuplicate(panel({ kind: 'stack' }), 'Dev')).toMatchObject({ ok: false });
    expect(intentForDuplicate(undefined, 'Dev/Logs')).toMatchObject({ ok: false });
  });
});

describe('intentForRemove', () => {
  const panel = (over: Partial<PanelView> = {}): PanelView => ({ id: 'Dev/Logs', kind: 'node', className: 's3.Bucket', literalId: 'Logs', idEdit: { siblings: ['Bucket'] }, rows: [], more: [], ...over });

  it('removes the Node as the user saw it', () => {
    expect(intentForRemove(panel(), 'Dev/Logs')).toEqual({ ok: true, intent: { type: 'removeNode', path: 'Dev/Logs', expect: { className: 's3.Bucket', literalId: 'Logs' } } });
  });

  it('refuses a Node that can not be edited, and a Stack', () => {
    expect(intentForRemove(panel({ readOnly: 'Created in a loop' }), 'Dev/Logs')).toEqual({ ok: false, reason: 'Created in a loop' });
    expect(intentForRemove(panel({ kind: 'stack' }), 'Dev')).toMatchObject({ ok: false });
    expect(intentForRemove(undefined, 'Dev/Logs')).toMatchObject({ ok: false });
  });
});
