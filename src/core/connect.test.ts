import { describe, expect, it } from 'vitest';
import { buildCatalog, digestAssembly } from './catalog.ts';
import {
  canConnect,
  connectTargets,
  intentForConnect,
  intentForDisconnect,
  intentForRepoint,
  type ConnectContext,
} from './connect.ts';
import type { Facts, NodeFacts, ReferenceFacts } from './facts.ts';
import type { NodeView } from './view.ts';

const doc = { summary: 's', stability: 'stable' };
const cls = (fqn: string, extra: Record<string, unknown> = {}) => ({
  kind: 'class',
  fqn,
  name: fqn.split('.').at(-1),
  namespace: fqn.split('.')[1],
  base: 'constructs.Construct',
  docs: doc,
  ...extra,
});
const init = (propsFqn: string) => ({ parameters: [{}, {}, { type: { fqn: propsFqn } }] });
const struct = (fqn: string, properties: unknown[]) => ({ kind: 'interface', datatype: true, fqn, properties });
const iface = (fqn: string) => ({ kind: 'interface', fqn, name: fqn.split('.').at(-1) });
const prop = (name: string, type: unknown) => ({ name, type, optional: true });

const catalog = buildCatalog([
  digestAssembly({
    name: 'aws-cdk-lib',
    version: '2.0.0',
    types: {
      'aws-cdk-lib.aws_kms.IKey': iface('aws-cdk-lib.aws_kms.IKey'),
      'aws-cdk-lib.aws_kms.Key': cls('aws-cdk-lib.aws_kms.Key', {
        interfaces: ['aws-cdk-lib.aws_kms.IKey'],
        initializer: init('aws-cdk-lib.aws_kms.KeyProps'),
      }),
      'aws-cdk-lib.aws_kms.KeyProps': struct('aws-cdk-lib.aws_kms.KeyProps', []),
      'aws-cdk-lib.aws_iam.IManagedPolicy': iface('aws-cdk-lib.aws_iam.IManagedPolicy'),
      'aws-cdk-lib.aws_iam.ManagedPolicy': cls('aws-cdk-lib.aws_iam.ManagedPolicy', {
        interfaces: ['aws-cdk-lib.aws_iam.IManagedPolicy'],
        initializer: init('aws-cdk-lib.aws_iam.ManagedPolicyProps'),
      }),
      'aws-cdk-lib.aws_iam.ManagedPolicyProps': struct('aws-cdk-lib.aws_iam.ManagedPolicyProps', []),
      'aws-cdk-lib.aws_iam.Role': cls('aws-cdk-lib.aws_iam.Role', {
        initializer: init('aws-cdk-lib.aws_iam.RoleProps'),
      }),
      'aws-cdk-lib.aws_iam.RoleProps': struct('aws-cdk-lib.aws_iam.RoleProps', [
        prop('managedPolicies', {
          collection: { kind: 'array', elementtype: { fqn: 'aws-cdk-lib.aws_iam.IManagedPolicy' } },
        }),
      ]),
      'aws-cdk-lib.aws_s3.Bucket': cls('aws-cdk-lib.aws_s3.Bucket', {
        initializer: init('aws-cdk-lib.aws_s3.BucketProps'),
      }),
      'aws-cdk-lib.aws_s3.BucketProps': struct('aws-cdk-lib.aws_s3.BucketProps', [
        prop('encryptionKey', { fqn: 'aws-cdk-lib.aws_kms.IKey' }),
        prop('versioned', { primitive: 'boolean' }),
      ]),
    },
  }),
]);

const span = { file: 'lib/a.ts', start: { line: 1, col: 1 }, end: { line: 1, col: 2 } };
const fact = (literalId: string, className: string, extra: Partial<NodeFacts> = {}): NodeFacts => ({
  span,
  className,
  literalId,
  pathsOnSpan: 1,
  binding: 'const',
  enclosingClass: { name: 'S', kind: 'stack' },
  ...extra,
});
const view = (id: string, fqn: string, extra: Partial<NodeView> = {}): NodeView => ({
  id: `S/${id}`,
  stackId: 'S',
  label: id,
  subtitle: '',
  fqn,
  icon: '',
  ...extra,
});

const ref = (from: string, to: string, prop: string, extra: Partial<ReferenceFacts> = {}): ReferenceFacts => ({
  from: `S/${from}`,
  to: `S/${to}`,
  prop,
  form: 'identifier',
  editable: true,
  text: to.toLowerCase(),
  span,
  ...extra,
});

const context = (
  over: Partial<ConnectContext> = {},
  references: ReferenceFacts[] = [],
  nodeFacts: Record<string, NodeFacts> = {},
): ConnectContext => {
  const facts: Facts = {
    nodes: {
      'S/Data': fact('Data', 's3.Bucket', { props: { form: 'object', props: [] } }),
      'S/Key': fact('Key', 'kms.Key'),
      'S/Other': fact('Other', 'kms.Key'),
      'S/Role': fact('Role', 'iam.Role', { props: { form: 'object', props: [] } }),
      'S/Policy': fact('Policy', 'iam.ManagedPolicy'),
      ...nodeFacts,
    },
    ...(references.length > 0 ? { references } : {}),
  };
  return {
    view: {
      stages: [],
      stacks: [],
      edges: [],
      nodes: [
        view('Data', 'aws-cdk-lib.aws_s3.Bucket'),
        view('Key', 'aws-cdk-lib.aws_kms.Key'),
        view('Other', 'aws-cdk-lib.aws_kms.Key'),
        view('Role', 'aws-cdk-lib.aws_iam.Role'),
        view('Policy', 'aws-cdk-lib.aws_iam.ManagedPolicy'),
      ],
    },
    facts,
    catalog,
    ...over,
  };
};

describe('canConnect', () => {
  it('offers the prop whose type is an interface the target implements, as the one option', () => {
    expect(canConnect(context(), 'S/Data', 'S/Key')).toEqual({
      ok: true,
      options: [{ prop: 'encryptionKey', type: 'IKey', many: false }],
    });
  });

  it('offers an array prop as one that takes several', () => {
    expect(canConnect(context(), 'S/Role', 'S/Policy')).toEqual({
      ok: true,
      options: [{ prop: 'managedPolicies', type: 'IManagedPolicy[]', many: true }],
    });
  });

  it('refuses a drop on a Node no prop takes, saying so', () => {
    expect(canConnect(context(), 'S/Data', 'S/Policy')).toEqual({
      ok: false,
      reason: 'Data has no prop that takes Policy',
    });
  });

  it('offers to replace a single-value prop that points elsewhere', () => {
    const c = canConnect(context({}, [ref('Data', 'Key', 'encryptionKey')]), 'S/Data', 'S/Other');
    expect(c).toEqual({
      ok: true,
      options: [{ prop: 'encryptionKey', type: 'IKey', many: false, replaces: { id: 'S/Key', label: 'Key' } }],
    });
  });

  it('refuses an exact duplicate, for one value or several', () => {
    expect(canConnect(context({}, [ref('Data', 'Key', 'encryptionKey')]), 'S/Data', 'S/Key')).toEqual({
      ok: false,
      reason: 'encryptionKey already points at Key',
    });
    const roleFacts = {
      'S/Role': fact('Role', 'iam.Role', {
        props: { form: 'object', props: [{ name: 'managedPolicies', kind: 'expression', text: '[policy]' }] },
      }),
    };
    expect(
      canConnect(
        context({}, [ref('Role', 'Policy', 'managedPolicies', { index: 0 })], roleFacts),
        'S/Role',
        'S/Policy',
      ),
    ).toEqual({ ok: false, reason: 'managedPolicies already points at Policy' });
  });

  it('adds to an array prop that already holds other Nodes', () => {
    const roleFacts = {
      'S/Role': fact('Role', 'iam.Role', {
        props: { form: 'object', props: [{ name: 'managedPolicies', kind: 'expression', text: '[other]' }] },
      }),
    };
    const c = canConnect(
      context({}, [ref('Role', 'Other', 'managedPolicies', { index: 0 })], roleFacts),
      'S/Role',
      'S/Policy',
    );
    expect(c).toMatchObject({ ok: true, options: [{ prop: 'managedPolicies', many: true }] });
  });

  it('refuses a prop the code sets to an expression, with what it says', () => {
    const facts = {
      'S/Data': fact('Data', 's3.Bucket', {
        props: { form: 'object', props: [{ name: 'encryptionKey', kind: 'expression', text: 'props.key' }] },
      }),
    };
    expect(canConnect(context({}, [], facts), 'S/Data', 'S/Key')).toEqual({
      ok: false,
      reason: 'encryptionKey is written as props.key in the code',
    });
    const call = [ref('Data', 'Key', 'encryptionKey', { form: 'call', editable: false, text: 'pick(key)' })];
    expect(canConnect(context({}, call), 'S/Data', 'S/Other')).toEqual({
      ok: false,
      reason: 'encryptionKey is set by pick(key), which Truss leaves alone',
    });
  });

  it('refuses when the source is locked, added or deleted in the Draft, or editing is paused', () => {
    const locked = context();
    locked.view.nodes[0] = view('Data', 'aws-cdk-lib.aws_s3.Bucket', { lock: 'Created in a loop' });
    expect(canConnect(locked, 'S/Data', 'S/Key')).toEqual({ ok: false, reason: 'Created in a loop' });
    expect(canConnect(context({ added: new Set(['S/Data']) }), 'S/Data', 'S/Key')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Added in the Draft'),
    });
    expect(canConnect(context({ blocked: 'Editing is paused' }), 'S/Data', 'S/Key')).toEqual({
      ok: false,
      reason: 'Editing is paused',
    });
  });

  it('refuses a target that is deleted or added in the Draft, hoisted, or not kept in a variable', () => {
    expect(canConnect(context({ added: new Set(['S/Key']) }), 'S/Data', 'S/Key')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Added in the Draft'),
    });
    expect(
      canConnect(context({}, [], { 'S/Key': fact('Key', 'kms.Key', { binding: 'none' }) }), 'S/Data', 'S/Key'),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("isn't kept in a variable") });
    const hoisted = context();
    hoisted.view.nodes[1] = view('Key', 'aws-cdk-lib.aws_kms.Key', { hoisted: true });
    expect(canConnect(hoisted, 'S/Data', 'S/Key')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('created by the library'),
    });
  });

  it('refuses a target that shares no scope: another class, another file', () => {
    const other = { 'S/Key': fact('Key', 'kms.Key', { enclosingClass: { name: 'Elsewhere', kind: 'stack' } }) };
    expect(canConnect(context({}, [], other), 'S/Data', 'S/Key')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no scope in common'),
    });
    const file = { 'S/Key': fact('Key', 'kms.Key', { span: { ...span, file: 'lib/b.ts' } }) };
    expect(canConnect(context({}, [], file), 'S/Data', 'S/Key')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no scope in common'),
    });
  });

  it('refuses a Node that points at itself, and one the Catalog does not describe', () => {
    expect(canConnect(context(), 'S/Data', 'S/Data')).toEqual({ ok: false, reason: "Data can't point at itself" });
    expect(canConnect(context({ catalog: undefined }), 'S/Data', 'S/Key')).toMatchObject({
      ok: false,
      reason: expect.stringContaining("doesn't know the props"),
    });
  });
});

describe('connectTargets', () => {
  it('answers for every other Node, so the canvas can dim the ones that will not take the drop', () => {
    const targets = connectTargets(context(), 'S/Data');
    expect(Object.keys(targets).sort()).toEqual(['S/Key', 'S/Other', 'S/Policy', 'S/Role']);
    expect(targets['S/Key']).toMatchObject({ ok: true });
    expect(targets['S/Role']).toMatchObject({ ok: false });
  });
});

describe('intentForConnect', () => {
  it('names the source and the target as the user saw them', () => {
    expect(intentForConnect(context(), 'S/Data', 'S/Key', 'encryptionKey')).toEqual({
      ok: true,
      intent: {
        type: 'addReference',
        path: 'S/Data',
        expect: { className: 's3.Bucket', literalId: 'Data' },
        prop: 'encryptionKey',
        to: { path: 'S/Key', className: 'kms.Key', literalId: 'Key' },
      },
    });
  });

  it('marks an add to an array prop', () => {
    expect(intentForConnect(context(), 'S/Role', 'S/Policy', 'managedPolicies')).toMatchObject({
      ok: true,
      intent: { type: 'addReference', many: true },
    });
  });

  it('asks before replacing a single value, and then re-points', () => {
    const c = context({}, [ref('Data', 'Key', 'encryptionKey')]);
    expect(intentForConnect(c, 'S/Data', 'S/Other', 'encryptionKey')).toEqual({
      ok: false,
      reason: 'encryptionKey already points at Key',
    });
    expect(intentForConnect(c, 'S/Data', 'S/Other', 'encryptionKey', true)).toMatchObject({
      ok: true,
      intent: { type: 'repointReference', was: { path: 'S/Key' }, to: { path: 'S/Other' } },
    });
  });

  it('refuses a prop the target does not fit', () => {
    expect(intentForConnect(context(), 'S/Data', 'S/Key', 'versioned')).toEqual({
      ok: false,
      reason: "versioned doesn't take Key",
    });
  });
});

describe('intentForDisconnect and intentForRepoint', () => {
  const c = context({}, [
    ref('Data', 'Key', 'encryptionKey'),
    ref('Data', 'Other', 'encryptionKey', { form: 'conditional', editable: false, reason: 'Chosen by a condition' }),
  ]);

  it('removes a Reference the code writes as a Node, and refuses one it does not', () => {
    const plain = context({}, [ref('Data', 'Key', 'encryptionKey')]);
    expect(intentForDisconnect(plain, 'S/Data', 'S/Key', 'encryptionKey')).toMatchObject({
      ok: true,
      intent: { type: 'removeReference', to: { path: 'S/Key' } },
    });
    expect(intentForDisconnect(c, 'S/Data', 'S/Other', 'encryptionKey')).toEqual({
      ok: false,
      reason: 'Chosen by a condition',
    });
    expect(intentForDisconnect(plain, 'S/Data', 'S/Other', 'encryptionKey')).toEqual({
      ok: false,
      reason: "encryptionKey doesn't point at Other",
    });
  });

  it('moves the end of a Reference to another Node', () => {
    const plain = context({}, [ref('Data', 'Key', 'encryptionKey')]);
    expect(intentForRepoint(plain, 'S/Data', 'S/Key', 'S/Other', 'encryptionKey')).toMatchObject({
      ok: true,
      intent: { type: 'repointReference', was: { path: 'S/Key' }, to: { path: 'S/Other' } },
    });
    expect(intentForRepoint(plain, 'S/Data', 'S/Key', 'S/Policy', 'encryptionKey')).toMatchObject({ ok: false });
  });
});
