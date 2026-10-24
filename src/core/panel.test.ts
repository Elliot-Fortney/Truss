import { describe, expect, it } from 'vitest';
import type { Catalog, CatalogEntry } from './catalog.ts';
import type { Facts, NodeFacts, PropsFacts } from './facts.ts';
import type { Intent, PropValue } from './intents.ts';
import { buildPanel, editableAs, inputFor, intentForEdit, intentForRename } from './panel.ts';
import type { TreeNode } from './assembly.ts';
import type { NodeView, StackBoxView, ViewBody } from './view.ts';

const span = { file: 'lib/a.ts', start: { line: 3, col: 5 }, end: { line: 3, col: 40 } };

const bucket: CatalogEntry = {
  fqn: 'aws-cdk-lib.aws_s3.Bucket',
  name: 'Bucket',
  library: 'aws-cdk-lib',
  tier: 'L2',
  summary: 'An S3 bucket.',
  assignableTo: ['aws-cdk-lib.aws_s3.Bucket'],
  props: [
    { name: 'bucketName', type: 'string', required: false, summary: 'Physical name of this bucket.', default: '- Assigned by CloudFormation.' },
    { name: 'versioned', type: 'boolean', required: false, summary: 'Whether versioning is on.', default: 'false' },
    { name: 'removalPolicy', type: 'RemovalPolicy', required: false },
    { name: 'encryption', type: 'BucketEncryption', required: false },
    { name: 'accessControl', type: 'BucketAccessControl', required: true, summary: 'Who may read it.' },
  ],
  overlay: { displayName: 'S3 Bucket', featuredProps: ['versioned', 'removalPolicy'], defaults: {}, fixtures: {}, connections: [], accessors: [], referenceFlows: {} },
};
const catalog: Catalog = { entries: [bucket], dropped: [] };

const node = (id: string, fqn: string, extra: Partial<NodeView> = {}): NodeView => ({ id, stackId: 'App', label: id, subtitle: '', fqn, icon: '', ...extra });
const stack: StackBoxView = { id: 'App', label: 'App', env: 'env-agnostic' };
const body = (...nodes: NodeView[]): ViewBody => ({ stages: [], stacks: [stack], nodes, edges: [] });
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

describe('buildPanel for editing', () => {
  const enumInput = { kind: 'enum' as const, fqn: 'aws-cdk-lib.RemovalPolicy', members: ['DESTROY', 'RETAIN'] };
  const editable: CatalogEntry = {
    ...bucket,
    props: [
      { name: 'bucketName', type: 'string', required: false, input: { kind: 'string' } },
      { name: 'versioned', type: 'boolean', required: false, input: { kind: 'boolean' } },
      { name: 'removalPolicy', type: 'RemovalPolicy', required: false, input: enumInput },
      { name: 'timeout', type: 'Duration', required: false, input: { kind: 'duration' } },
      { name: 'partitionKey', type: 'Attribute', required: false, input: { kind: 'struct', fields: [{ name: 'name', type: 'string', required: true, input: { kind: 'string' } }] } },
      { name: 'lifecycleRules', type: 'LifecycleRule[]', required: false },
    ],
    overlay: { ...bucket.overlay!, featuredProps: ['versioned', 'removalPolicy', 'timeout', 'partitionKey'] },
  };
  const cat: Catalog = { entries: [editable], dropped: [] };
  const intent = (prop: string[], value: PropValue, path = 'App/Logs'): Intent => ({ type: 'setProp', path, expect: { className: 's3.Bucket', literalId: 'Logs' }, prop, value });
  const panelOf = (props: PropsFacts | undefined, editing?: Parameters<typeof buildPanel>[4], over: Partial<NodeView> = {}) =>
    buildPanel('App/Logs', body(node('App/Logs', bucket.fqn, over)), facts({ 'App/Logs': { className: 's3.Bucket', literalId: 'Logs', ...(props ? { props } : {}) } }), cat, editing)!;
  const input = (panel: ReturnType<typeof panelOf>, name: string) => [...panel.rows, ...panel.more].find((r) => r.name === name)?.input;

  it('gives a row its input when editing is on, and none when it is not asked for', () => {
    expect(input(panelOf(undefined, { intents: [] }), 'versioned')).toEqual({ kind: 'boolean' });
    expect(input(panelOf(undefined), 'versioned')).toBeUndefined();
    expect(panelOf(undefined, { intents: [] }).literalId).toBe('Logs');
  });

  it('is read-only for a construct the Draft adds, which has no code on disk yet', () => {
    const panel = panelOf(undefined, { intents: [], added: new Set(['App/Logs']) });
    expect(panel.readOnly).toMatch(/save it/);
    expect(input(panel, 'versioned')).toBeUndefined();
    expect(panel.idEdit).toBeUndefined();
  });

  it('offers no input for a type Truss writes no literal for', () => {
    expect(input(panelOf(undefined, { intents: [] }), 'lifecycleRules')).toBeUndefined();
  });

  it('keeps an input for a prop the code writes as a literal, a member, a quantity or an object, and drops it for any other expression', () => {
    const props = object(
      { name: 'versioned', kind: 'literal', text: 'true', value: true },
      { name: 'removalPolicy', kind: 'expression', text: 'RemovalPolicy.DESTROY', member: { type: 'RemovalPolicy', name: 'DESTROY' } },
      { name: 'timeout', kind: 'expression', text: 'cdk.Duration.seconds(5)', quantity: { type: 'Duration', unit: 'seconds', amount: 5 } },
      { name: 'partitionKey', kind: 'object', text: '{ name: "a" }', fields: [{ name: 'name', kind: 'literal', text: '"a"', value: 'a' }] },
      { name: 'bucketName', kind: 'expression', text: 'nameOf()' },
    );
    const panel = panelOf(props, { intents: [] });
    expect(['versioned', 'removalPolicy', 'timeout', 'partitionKey'].map((n) => input(panel, n)?.kind)).toEqual(['boolean', 'enum', 'duration', 'struct']);
    expect(input(panel, 'bucketName')).toBeUndefined();
    expect(panel.rows.find((r) => r.name === 'partitionKey')?.written).toEqual({ kind: 'object', text: '{ name: "a" }', fields: [{ name: 'name', written: { kind: 'literal', value: 'a', text: '"a"' } }] });
  });

  it('is read-only, with the reason and no inputs, for a locked Node, props passed as a variable, or a blocked Draft', () => {
    const locked = panelOf(undefined, { intents: [] }, { lock: 'Created in a loop' });
    expect(locked.readOnly).toBe('Created in a loop');
    expect(input(locked, 'versioned')).toBeUndefined();
    const variable = panelOf({ form: 'other', text: 'bucketProps' }, { intents: [] });
    expect(variable.readOnly).toMatch(/passed as bucketProps/);
    const blocked = panelOf(undefined, { intents: [], blocked: 'no build script' });
    expect(blocked.readOnly).toBe('no build script');
    expect(input(blocked, 'versioned')).toBeUndefined();
    expect(panelOf(undefined, { intents: [] }).readOnly).toBeUndefined();
  });

  it('shows the Draft’s values as the code would have them, before synth has caught up', () => {
    const props = object({ name: 'versioned', kind: 'literal', text: 'true', value: true });
    const panel = panelOf(props, { intents: [intent(['versioned'], { kind: 'boolean', value: false }), intent(['removalPolicy'], { kind: 'enum', type: 'aws-cdk-lib.RemovalPolicy', member: 'RETAIN' })] });
    const written = (n: string) => [...panel.rows, ...panel.more].find((r) => r.name === n)?.written;
    expect(written('versioned')).toMatchObject({ kind: 'literal', value: false });
    expect(written('removalPolicy')).toMatchObject({ kind: 'expression', member: { type: 'RemovalPolicy', name: 'RETAIN' } });
    expect(input(panel, 'removalPolicy')?.kind).toBe('enum');
  });

  it('shows an edit made to another instance of the same `new` as made here (ADR 0008)', () => {
    const shared = facts({ 'App/Logs': { className: 's3.Bucket', literalId: 'Logs' }, 'Other/Logs': { className: 's3.Bucket', literalId: 'Logs' } });
    const panel = buildPanel('App/Logs', body(node('App/Logs', bucket.fqn)), shared, cat, { intents: [intent(['versioned'], { kind: 'boolean', value: true }, 'Other/Logs')] })!;
    expect(panel.rows.find((r) => r.name === 'versioned')?.written).toMatchObject({ value: true });
  });

  it('offers a Stack’s own props as inputs, and is read-only when the Stack has no code', () => {
    const stackPanel = buildPanel('App', body(), facts({ App: { className: 'ShopStack', literalId: 'App' } }), cat, { intents: [] })!;
    expect(stackPanel.rows.map((r) => [r.name, r.input?.kind])).toEqual([['env', 'struct'], ['terminationProtection', 'boolean'], ['description', 'string']]);
    expect(buildPanel('App', body(), facts({}), cat, { intents: [] })!.readOnly).toMatch(/no code/);
  });

  describe('inputFor', () => {
    const panel = panelOf(object({ name: 'partitionKey', kind: 'object', text: '', fields: [{ name: 'name', kind: 'literal', text: '"a"', value: 'a' }, { name: 'sort', kind: 'expression', text: 'x' }] }), { intents: [] });
    it('finds the input of a prop and of a field inside a struct prop', () => {
      expect(inputFor(panel, ['versioned'])).toEqual({ kind: 'boolean' });
      expect(inputFor(panel, ['partitionKey', 'name'])).toEqual({ kind: 'string' });
    });
    it('finds none for an unknown prop, an unknown field, a field of a prop that is not a struct, or a field the code writes as an expression', () => {
      expect(inputFor(panel, ['nope'])).toBeUndefined();
      expect(inputFor(panel, ['partitionKey', 'nope'])).toBeUndefined();
      expect(inputFor(panel, ['versioned', 'x'])).toBeUndefined();
      const odd = panelOf(object({ name: 'partitionKey', kind: 'object', text: '', fields: [{ name: 'name', kind: 'expression', text: 'id()' }] }), { intents: [] });
      expect(inputFor(odd, ['partitionKey', 'name'])).toBeUndefined();
    });
  });

  describe('the Construct ID', () => {
    const tree: TreeNode = {
      id: '',
      path: '',
      fqn: 'App',
      children: [{ id: 'App', path: 'App', fqn: 'Stack', children: ['Logs', 'Other', 'Default'].map((id) => ({ id, path: `App/${id}`, fqn: 'x', children: [] })) }],
    };
    const open = () => panelOf(undefined, { intents: [], tree });
    const refusal = (r: ReturnType<typeof intentForRename>) => (r.ok ? undefined : r.reason);

    it('is offered with the IDs beside it when the Node can be edited', () => {
      expect(open().idEdit).toEqual({ siblings: ['Other', 'Default'] });
    });

    it('is not offered when the panel is read-only or has no tree to read siblings from', () => {
      expect(panelOf(undefined, { intents: [], tree, blocked: 'paused' }).idEdit).toBeUndefined();
      expect(panelOf(undefined, { intents: [] }).idEdit).toBeUndefined();
      expect(panelOf(undefined).idEdit).toBeUndefined();
    });

    it('is not offered for a `new` that makes several constructs', () => {
      const several = buildPanel('App/Logs', body(node('App/Logs', bucket.fqn)), facts({ 'App/Logs': { className: 's3.Bucket', literalId: 'Logs', pathsOnSpan: 2 } }), cat, { intents: [], tree })!;
      expect(several.idEdit).toBeUndefined();
    });

    it('returns the rename to stage for an ID the siblings allow', () => {
      expect(intentForRename(open(), 'App/Logs', 'Files')).toEqual({ ok: true, intent: { type: 'renameId', path: 'App/Logs', expect: { className: 's3.Bucket', literalId: 'Logs' }, newId: 'Files' } });
    });

    it('refuses with the reason an ID breaks, a panel that is read-only, and no panel', () => {
      expect(refusal(intentForRename(open(), 'App/Logs', 'Other'))).toMatch(/sibling already has/);
      expect(refusal(intentForRename(open(), 'App/Logs', 'Resource'))).toMatch(/"Default"/);
      expect(refusal(intentForRename(open(), 'App/Logs', ''))).toMatch(/empty/);
      expect(refusal(intentForRename(panelOf(undefined, { intents: [], tree, blocked: 'paused' }), 'App/Logs', 'Files'))).toBe('paused');
      expect(refusal(intentForRename(undefined, 'App/Nope', 'Files'))).toBe('No Node or Stack at App/Nope');
    });
  });

  describe('intentForEdit', () => {
    const flag = { kind: 'boolean' as const, value: true };
    const open = () => panelOf(undefined, { intents: [] });
    const refusal = (r: ReturnType<typeof intentForEdit>) => (r.ok ? undefined : r.reason);

    it('returns the intent to stage for a value the input takes', () => {
      expect(intentForEdit(open(), 'App/Logs', ['versioned'], flag)).toEqual({ ok: true, intent: intent(['versioned'], flag) });
      const retain = { kind: 'enum' as const, type: 'aws-cdk-lib.RemovalPolicy', member: 'RETAIN' };
      expect(intentForEdit(open(), 'App/Logs', ['removalPolicy'], retain)).toEqual({ ok: true, intent: intent(['removalPolicy'], retain) });
    });

    it('refuses when there is no panel', () => {
      expect(refusal(intentForEdit(undefined, 'App/Nope', ['versioned'], flag))).toBe('No Node or Stack at App/Nope');
    });

    it('refuses with the reason when the panel is read-only', () => {
      expect(refusal(intentForEdit(panelOf(undefined, { intents: [], blocked: 'no build script' }), 'App/Logs', ['versioned'], flag))).toBe('no build script');
    });

    it('refuses a prop the panel has no input for', () => {
      expect(refusal(intentForEdit(open(), 'App/Logs', ['lifecycleRules'], flag))).toBe("lifecycleRules can't be edited here");
      expect(refusal(intentForEdit(open(), 'App/Logs', ['partitionKey', 'nope'], flag))).toBe("partitionKey.nope can't be edited here");
    });

    it('refuses a value of the wrong kind, and an enum of another type or member', () => {
      expect(refusal(intentForEdit(open(), 'App/Logs', ['versioned'], { kind: 'string', value: 'yes' }))).toBe('versioned takes a boolean, not a string');
      expect(refusal(intentForEdit(open(), 'App/Logs', ['removalPolicy'], { kind: 'enum', type: 'aws-cdk-lib.Other', member: 'RETAIN' }))).toBe('removalPolicy takes a enum, not a enum');
      expect(refusal(intentForEdit(open(), 'App/Logs', ['removalPolicy'], { kind: 'enum', type: 'aws-cdk-lib.RemovalPolicy', member: 'NOPE' }))).toBe('removalPolicy takes a enum, not a enum');
    });

    it('refuses when the code gives the Node no Construct ID to edit by', () => {
      const noId = buildPanel('App/Logs', body(node('App/Logs', bucket.fqn)), facts({ 'App/Logs': { className: 's3.Bucket' } }), cat, { intents: [] })!;
      expect(refusal(intentForEdit(noId, 'App/Logs', ['versioned'], flag))).toBe('App/Logs has no Construct ID in the code to edit by');
    });
  });
});

describe('editableAs', () => {
  it('matches an input with what the code gives the prop', () => {
    expect(editableAs({ kind: 'string' }, undefined)).toBe(true);
    expect(editableAs({ kind: 'string' }, { kind: 'literal', value: 'a', text: "'a'" })).toBe(true);
    expect(editableAs({ kind: 'string' }, { kind: 'literal', value: 1, text: '1' })).toBe(false);
    expect(editableAs({ kind: 'number' }, { kind: 'literal', value: 1, text: '1' })).toBe(true);
    expect(editableAs({ kind: 'boolean' }, { kind: 'expression', text: 'flag' })).toBe(false);
    expect(editableAs({ kind: 'enum', fqn: 'aws-cdk-lib.aws_s3.BucketEncryption', members: [] }, { kind: 'expression', text: 's3.BucketEncryption.KMS', member: { type: 'BucketEncryption', name: 'KMS' } })).toBe(true);
    expect(editableAs({ kind: 'enum', fqn: 'aws-cdk-lib.aws_s3.BucketEncryption', members: [] }, { kind: 'expression', text: 'RemovalPolicy.DESTROY', member: { type: 'RemovalPolicy', name: 'DESTROY' } })).toBe(false);
    expect(editableAs({ kind: 'size' }, { kind: 'expression', text: 'Duration.days(1)', quantity: { type: 'Duration', unit: 'days', amount: 1 } })).toBe(false);
    expect(editableAs({ kind: 'struct', fields: [] }, { kind: 'expression', text: 'attr' })).toBe(false);
  });
});

describe('buildPanel Node picker', () => {
  const key: CatalogEntry = { fqn: 'aws-cdk-lib.aws_kms.Key', name: 'Key', library: 'aws-cdk-lib', tier: 'L2', props: [], assignableTo: ['aws-cdk-lib.aws_kms.Key', 'aws-cdk-lib.aws_kms.IKey'] };
  const logs: CatalogEntry = {
    ...bucket,
    props: [
      { name: 'encryptionKey', type: 'IKey', required: false, accepts: { fqn: 'aws-cdk-lib.aws_kms.IKey' } },
      { name: 'replicas', type: 'IKey[]', required: false, accepts: { fqn: 'aws-cdk-lib.aws_kms.IKey', many: true } },
    ],
  };
  const withKeys: Catalog = { entries: [logs, key], dropped: [] };
  const nodes = () => body(node('App/Logs', bucket.fqn), node('App/Key', key.fqn, { label: 'Key' }), node('App/Spare', key.fqn, { label: 'Spare' }), node('App/Other', bucket.fqn, { label: 'Other' }));
  const world = (extra: Partial<NodeFacts> = {}, references: Facts['references'] = []): Facts => ({
    ...facts({
      'App/Logs': { className: 's3.Bucket', literalId: 'Logs', ...extra },
      'App/Key': { className: 'kms.Key', literalId: 'Key', binding: 'const' },
      'App/Spare': { className: 'kms.Key', literalId: 'Spare', binding: 'const' },
      'App/Other': { className: 's3.Bucket', literalId: 'Other', binding: 'const' },
    }),
    references,
  });
  const ref = (to: string, prop: string, extra: Partial<NonNullable<Facts['references']>[number]> = {}) => ({ from: 'App/Logs', to: `App/${to}`, prop, form: 'identifier' as const, editable: true, text: to.toLowerCase(), span, ...extra });
  const rowsOf = (f: Facts, editing: Parameters<typeof buildPanel>[4] = { intents: [] }) => {
    const p = buildPanel('App/Logs', nodes(), f, withKeys, editing)!;
    return Object.fromEntries([...p.rows, ...p.more].map((r) => [r.name, r.nodes]));
  };

  it('lists the Nodes a prop could point at, those that fit its type', () => {
    expect(rowsOf(world({ props: object() }))['encryptionKey']).toEqual({
      many: false,
      current: [],
      choices: [
        { id: 'App/Key', label: 'Key' },
        { id: 'App/Spare', label: 'Spare' },
      ],
    });
  });

  it('shows what the prop points at now, and does not offer it again', () => {
    const picker = rowsOf(world({ props: object({ name: 'encryptionKey', kind: 'expression', text: 'key' }) }, [ref('Key', 'encryptionKey')]))['encryptionKey'];
    expect(picker).toMatchObject({ current: [{ id: 'App/Key', label: 'Key' }], choices: [{ id: 'App/Spare', label: 'Spare' }] });
  });

  it('takes several Nodes for an array prop, in order', () => {
    const picker = rowsOf(world({ props: object({ name: 'replicas', kind: 'expression', text: '[spare, key]' }) }, [ref('Spare', 'replicas', { index: 0 }), ref('Key', 'replicas', { index: 1 })]))['replicas'];
    expect(picker).toMatchObject({ many: true, current: [{ id: 'App/Spare' }, { id: 'App/Key' }], choices: [] });
  });

  it('marks a Reference the code writes as a call as one it only shows', () => {
    const picker = rowsOf(world({ props: object({ name: 'encryptionKey', kind: 'expression', text: 'pick(key)' }) }, [ref('Key', 'encryptionKey', { form: 'call', editable: false, reason: 'Passed through a call' })]))['encryptionKey'];
    expect(picker?.current).toEqual([{ id: 'App/Key', label: 'Key', readOnly: 'Passed through a call' }]);
  });

  it('has no picker for a prop written as an expression that is no Node', () => {
    expect(rowsOf(world({ props: object({ name: 'encryptionKey', kind: 'expression', text: 'props.key' }) }))['encryptionKey']).toBeUndefined();
  });

  it('has none while the panel is read-only', () => {
    expect(rowsOf(world({ props: object() }), { intents: [], blocked: 'Editing is paused' })['encryptionKey']).toBeUndefined();
    const readOnly = buildPanel('App/Logs', nodes(), world({ props: object() }), withKeys)!;
    expect([...readOnly.rows, ...readOnly.more].every((r) => r.nodes === undefined)).toBe(true);
  });
});
