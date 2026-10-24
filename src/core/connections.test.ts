import { describe, expect, it } from 'vitest';
import type { Assembly, Effect } from './assembly.ts';
import { connectionsOf, type ConnectionEdge } from './connections.ts';
import type { Facts } from './facts.ts';
import type { NodeView } from './view.ts';

const node = (id: string, label = id.split('/').at(-1)!, extra: Partial<NodeView> = {}): NodeView => ({
  id,
  stackId: id.split('/')[0]!,
  label,
  subtitle: '',
  fqn: 'x',
  icon: '',
  source: { file: 'lib/a.ts', line: 1, col: 1 },
  ...extra,
});

const assembly = (effects: Effect[], importRefs: Assembly['importRefs'] = []): Assembly => ({
  schemaVersion: '1',
  tree: { id: '', path: '', fqn: 'x', children: [] },
  stacks: [],
  creation: {},
  resourceRefs: [],
  effects,
  importRefs,
});
const end = (...paths: string[]) => ({ paths, text: paths.map((p) => `{${p}}`).join('') });
const grant = (at: string, source: string[], target: ReturnType<typeof end>, detail = 's3:GetObject'): Effect => ({
  kind: 'grant',
  at,
  source: end(...source),
  target,
  detail,
});

const nodes = [
  node('S/Fn'),
  node('S/Bucket'),
  node('S/Queue'),
  node('S/Existing', 'Existing', { external: true }),
  node('T/Other'),
];
const noFacts: Facts = { nodes: {} };

describe('connectionsOf', () => {
  it('rolls each end up to the nearest Node and makes one edge per kind and pair, listing every effect', () => {
    const { edges } = connectionsOf(
      assembly([
        grant('S/Fn/ServiceRole/DefaultPolicy/Resource', ['S/Fn/ServiceRole/Resource'], end('S/Bucket/Resource')),
        grant(
          'S/Fn/ServiceRole/DefaultPolicy/Resource',
          ['S/Fn/ServiceRole/Resource'],
          end('S/Bucket/Resource'),
          's3:PutObject',
        ),
        {
          kind: 'integration',
          at: 'S/Fn/SqsEventSource/Resource',
          source: end('S/Queue/Resource'),
          target: end('S/Fn/Resource'),
          detail: 'event source mapping',
        },
      ]),
      noFacts,
      nodes,
      [],
    );
    expect(edges.map((e) => [e.id, e.kind, e.from, e.to, e.prop, e.readOnly !== undefined, e.effects?.length])).toEqual(
      [
        ['grant:S/Fn->S/Bucket', 'grant', 'S/Fn', 'S/Bucket', '2 permissions', true, 2],
        ['integration:S/Queue->S/Fn', 'integration', 'S/Queue', 'S/Fn', 'event source mapping', true, 1],
      ],
    );
    expect(edges[0]!.effects!.map((e) => e.summary)).toEqual([
      's3:GetObject · Fn → Bucket',
      's3:PutObject · Fn → Bucket',
    ]);
    expect(edges[0]!.source).toEqual(nodes[0]!.source);
  });

  it('counts an External Node as an end when the end spells out its name', () => {
    const facts: Facts = {
      nodes: {
        'S/Existing': {
          span: { file: 'a', start: { line: 1, col: 1 }, end: { line: 1, col: 2 } },
          className: 's3.Bucket.fromBucketName',
          pathsOnSpan: 1,
          binding: 'none',
          external: true,
          identifiers: ['existing-bucket'],
        },
      },
    };
    const { edges } = connectionsOf(
      assembly([grant('p', ['S/Fn/Role/Resource'], { paths: [], text: 'arn:aws:s3:::existing-bucket/*' })]),
      facts,
      nodes,
      [],
    );
    expect(edges.map((e) => [e.from, e.to])).toEqual([['S/Fn', 'S/Existing']]);
    const miss = connectionsOf(
      assembly([grant('p', ['S/Fn/Role/Resource'], { paths: [], text: 'arn:aws:s3:::not-existing-bucket' })]),
      facts,
      nodes,
      [],
    );
    expect(miss.edges).toEqual([]);
  });

  it('lists an effect with no Node at its other end on the Node that owns it, instead of drawing an edge', () => {
    const { edges, other } = connectionsOf(
      assembly([
        grant('S/Fn/Policy', ['S/Fn/Role'], { paths: [], text: '*' }),
        grant('S/Fn/Policy', ['S/Fn/Role'], end('S/Fn/Role')),
        {
          kind: 'integration',
          at: 'S/Topic/Sub',
          source: end('S/Queue/Resource'),
          target: { paths: [], text: 'ops@example.com' },
          detail: 'subscription (email)',
        },
        {
          kind: 'network',
          at: 'S/Bucket/Rule',
          source: { paths: [], text: '10.0.0.0/8' },
          target: end('S/Bucket/Resource'),
          detail: 'tcp 22',
        },
      ]),
      noFacts,
      nodes,
      [],
    );
    expect(edges).toEqual([]);
    expect(other.get('S/Fn')!.permissions.map((e) => e.summary)).toEqual([
      's3:GetObject · Fn → *',
      's3:GetObject · Fn → Fn',
    ]);
    expect(other.get('S/Queue')!.integrations.map((e) => e.summary)).toEqual([
      'subscription (email) · Queue → ops@example.com',
    ]);
    expect(other.get('S/Bucket')!.permissions.map((e) => e.summary)).toEqual(['tcp 22 · 10.0.0.0/8 → Bucket']);
  });

  it('draws a reference across Stacks as a read-only Reference, unless the code already draws one', () => {
    const imports = [{ from: 'T/Other/Resource', to: 'S/Queue/Resource', prop: 'Environment' }];
    const { edges } = connectionsOf(assembly([], imports), noFacts, nodes, []);
    expect(edges).toMatchObject([
      { id: 'T/Other->S/Queue:Environment', kind: 'reference', from: 'T/Other', to: 'S/Queue', prop: 'Environment' },
    ]);
    expect(edges[0]!.readOnly).toBeTruthy();
    const drawn = {
      id: 'x',
      kind: 'reference',
      from: 'T/Other',
      to: 'S/Queue',
      prop: 'queue',
      text: 'q',
    } as ConnectionEdge;
    expect(connectionsOf(assembly([], imports), noFacts, nodes, [drawn]).edges).toEqual([]);
  });

  it('draws nothing for an assembly recorded before effects were read', () => {
    const old = { ...assembly([]), effects: undefined, importRefs: undefined };
    expect(connectionsOf(old, noFacts, nodes, [])).toEqual({ edges: [], other: new Map() });
  });
});
