import { describe, expect, it } from 'vitest';
import type { Catalog, CatalogEntry } from './catalog.ts';
import type { Facts, NodeFacts, PropsFacts } from './facts.ts';
import { buildPanel } from './panel.ts';
import type { NodeView, StackBoxView, ViewBody } from './view.ts';

const span = { file: 'lib/a.ts', start: { line: 3, col: 5 }, end: { line: 3, col: 40 } };

const bucket: CatalogEntry = {
  fqn: 'aws-cdk-lib.aws_s3.Bucket',
  name: 'Bucket',
  library: 'aws-cdk-lib',
  tier: 'L2',
  summary: 'An S3 bucket.',
  props: [
    { name: 'bucketName', type: 'string', required: false, summary: 'Physical name of this bucket.', default: '- Assigned by CloudFormation.' },
    { name: 'versioned', type: 'boolean', required: false, summary: 'Whether versioning is on.', default: 'false' },
    { name: 'removalPolicy', type: 'RemovalPolicy', required: false },
    { name: 'encryption', type: 'BucketEncryption', required: false },
    { name: 'accessControl', type: 'BucketAccessControl', required: true, summary: 'Who may read it.' },
  ],
  overlay: { displayName: 'S3 Bucket', featuredProps: ['versioned', 'removalPolicy'], defaults: {}, fixtures: {}, connections: [], accessors: [] },
};
const catalog: Catalog = { entries: [bucket], dropped: [] };

const node = (id: string, fqn: string, extra: Partial<NodeView> = {}): NodeView => ({ id, stackId: 'App', label: id, subtitle: '', fqn, icon: '', ...extra });
const stack: StackBoxView = { id: 'App', label: 'App', env: 'env-agnostic' };
const body = (...nodes: NodeView[]): ViewBody => ({ stages: [], stacks: [stack], nodes });
const facts = (nodes: Record<string, Partial<NodeFacts>>): Facts => ({
  nodes: Object.fromEntries(Object.entries(nodes).map(([path, f]) => [path, { span, className: 'x', pathsOnSpan: 1, binding: 'none' as const, ...f }])),
});
const object = (...props: Extract<PropsFacts, { form: 'object' }>['props']): PropsFacts => ({ form: 'object', props });

describe('buildPanel for a construct in the Catalog', () => {
  const panel = buildPanel(
    'App/Logs',
    body(node('App/Logs', bucket.fqn)),
    facts({ 'App/Logs': { className: 's3.Bucket', props: object({ name: 'bucketName', kind: 'literal', text: "'logs'", value: 'logs' }, { name: 'encryption', kind: 'expression', text: 'BucketEncryption.KMS' }) } }),
    catalog,
  )!;

  it('puts required props first, then featured ones in the Overlay order, then any other prop the code sets', () => {
    expect(panel.rows.map((r) => r.name)).toEqual(['accessControl', 'versioned', 'removalPolicy', 'bucketName', 'encryption']);
  });

  it('leaves the props nothing sets for on demand', () => {
    expect(panel.more).toEqual([]);
    const unset = buildPanel('App/Logs', body(node('App/Logs', bucket.fqn)), facts({ 'App/Logs': { className: 's3.Bucket' } }), catalog)!;
    expect(unset.rows.map((r) => r.name)).toEqual(['accessControl', 'versioned', 'removalPolicy']);
    expect(unset.more.map((r) => r.name)).toEqual(['bucketName', 'encryption']);
  });

  it('gives each row its type, docs summary and CDK default as text, and flags required and featured', () => {
    expect(panel.rows[0]).toEqual({ name: 'accessControl', type: 'BucketAccessControl', summary: 'Who may read it.', required: true });
    expect(panel.rows[1]).toEqual({ name: 'versioned', type: 'boolean', summary: 'Whether versioning is on.', default: 'false', featured: true });
  });

  it('shows a literal as its value and anything else as its source text', () => {
    const byName = Object.fromEntries(panel.rows.map((r) => [r.name, r.written]));
    expect(byName['bucketName']).toEqual({ kind: 'literal', value: 'logs', text: "'logs'" });
    expect(byName['encryption']).toEqual({ kind: 'expression', text: 'BucketEncryption.KMS' });
    expect(byName['versioned']).toBeUndefined();
  });

  it('names the class and carries the construct summary and where it is written', () => {
    expect(panel).toMatchObject({ id: 'App/Logs', kind: 'node', className: 's3.Bucket', summary: 'An S3 bucket.', source: { file: 'lib/a.ts', line: 3, col: 5 } });
  });
});

describe('buildPanel when props are passed as a variable', () => {
  const panel = buildPanel(
    'App/Logs',
    body(node('App/Logs', bucket.fqn)),
    facts({ 'App/Logs': { className: 's3.Bucket', props: { form: 'other', text: 'bucketProps' } } }),
    catalog,
  )!;

  it('keeps the same rows, none of them set, and says where the props come from', () => {
    expect(panel.rows.map((r) => r.name)).toEqual(['accessControl', 'versioned', 'removalPolicy']);
    expect(panel.rows.every((r) => r.written === undefined)).toBe(true);
    expect(panel.propsSource).toBe('bucketProps');
  });
});

describe('buildPanel for a construct the Catalog does not have', () => {
  it('shows a class of the app\'s own with the props as written', () => {
    const panel = buildPanel(
      'App/Docs',
      body(node('App/Docs', 'constructs.Construct')),
      facts({ 'App/Docs': { className: 'DocsSite', props: object({ name: 'domain', kind: 'literal', text: "'a.dev'", value: 'a.dev' }, { name: '...defaults', kind: 'expression', text: '...defaults' }) } }),
      catalog,
    )!;
    expect(panel.rows).toEqual([
      { name: 'domain', written: { kind: 'literal', value: 'a.dev', text: "'a.dev'" } },
      { name: '...defaults', written: { kind: 'expression', text: '...defaults' } },
    ]);
    expect(panel.more).toEqual([]);
    expect(panel.className).toBe('DocsSite');
  });

  it('does not describe a subclass of a CDK construct by its parent\'s props', () => {
    const panel = buildPanel(
      'App/Topic',
      body(node('App/Topic', bucket.fqn)),
      facts({ 'App/Topic': { className: 'AuditedBucket', props: object({ name: 'owner', kind: 'literal', text: "'me'", value: 'me' }) } }),
      catalog,
    )!;
    expect(panel.rows.map((r) => r.name)).toEqual(['owner']);
  });

  it('has no rows for a Node with nothing written, such as an external or hoisted one', () => {
    const panel = buildPanel('App/Existing', body(node('App/Existing', bucket.fqn, { external: true })), facts({ 'App/Existing': { className: 's3.Bucket.fromBucketName' } }), catalog)!;
    expect(panel).toMatchObject({ rows: [], more: [] });
    expect(buildPanel('App/Default', body(node('App/Default', bucket.fqn, { hoisted: true })), facts({}), catalog)).toMatchObject({ rows: [], more: [] });
  });

  it('works without a Catalog', () => {
    const panel = buildPanel('App/Logs', body(node('App/Logs', bucket.fqn)), facts({ 'App/Logs': { className: 's3.Bucket', props: object({ name: 'versioned', kind: 'literal', text: 'true', value: true }) } }), undefined)!;
    expect(panel.rows.map((r) => r.name)).toEqual(['versioned']);
  });

  it('is undefined for a path that is no Node or Stack', () => {
    expect(buildPanel('App/Nope', body(), facts({}), catalog)).toBeUndefined();
  });
});

describe('buildPanel for a Stack', () => {
  const panel = buildPanel(
    'App',
    body(),
    facts({ App: { className: 'ShopStack', props: object({ name: 'env', kind: 'expression', text: 'env' }, { name: 'terminationProtection', kind: 'literal', text: 'true', value: true }, { name: 'tags', kind: 'expression', text: '{ a: "b" }' }) } }),
    catalog,
  )!;

  it('always offers env, terminationProtection and description, with what the code sets', () => {
    expect(panel).toMatchObject({ id: 'App', kind: 'stack', className: 'ShopStack', source: { file: 'lib/a.ts' } });
    expect(panel.rows.map((r) => r.name)).toEqual(['env', 'terminationProtection', 'description', 'tags']);
    expect(panel.rows[0]).toMatchObject({ type: 'Environment', written: { kind: 'expression', text: 'env' } });
    expect(panel.rows[1]).toMatchObject({ type: 'boolean', default: 'false', written: { kind: 'literal', value: true } });
    expect(panel.rows[2]!.written).toBeUndefined();
    expect(panel.more).toEqual([]);
  });
});
