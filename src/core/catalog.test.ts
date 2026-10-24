import { describe, expect, it } from 'vitest';
import { buildCatalog, digestAssembly, entryFor, searchCatalog, type Catalog } from './catalog.ts';
import type { Overlay } from './overlay.ts';

const doc = (summary: string, extra: Record<string, unknown> = {}) => ({ summary, stability: 'stable', ...extra });
const prop = (name: string, type: unknown, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  docs: doc(`The ${name}.`),
  ...extra,
});
const init = (propsFqn?: string) => ({
  parameters: [
    { name: 'scope', type: { fqn: 'constructs.Construct' } },
    { name: 'id', type: { primitive: 'string' } },
    ...(propsFqn ? [{ name: 'props', optional: true, type: { fqn: propsFqn } }] : []),
  ],
});

const LIB = 'aws-cdk-lib';
const cls = (fqn: string, extra: Record<string, unknown> = {}) => {
  const [, namespace, name] = fqn.split('.');
  return { kind: 'class', fqn, name, namespace, assembly: LIB, docs: doc(`A ${name}.`), ...extra };
};
const struct = (fqn: string, properties: unknown[], extra: Record<string, unknown> = {}) => ({
  kind: 'interface',
  datatype: true,
  fqn,
  name: fqn.split('.').at(-1),
  properties,
  ...extra,
});

/** A small `aws-cdk-lib` with one of each shape the generator has to tell apart. */
function cdkLib(version = '2.274.0') {
  const types = [
    cls('constructs.Construct', { assembly: 'constructs', initializer: init() }),
    cls('aws-cdk-lib.CfnElement', { base: 'constructs.Construct', abstract: true }),
    cls('aws-cdk-lib.CfnResource', { base: 'aws-cdk-lib.CfnElement', initializer: init() }),
    cls('aws-cdk-lib.Resource', { base: 'constructs.Construct', abstract: true }),
    cls('aws-cdk-lib.CfnRefElement', { base: 'aws-cdk-lib.CfnElement', abstract: true }),
    cls('aws-cdk-lib.CfnOutput', { base: 'aws-cdk-lib.CfnElement', initializer: init('aws-cdk-lib.CfnOutputProps') }),
    cls('aws-cdk-lib.CfnParameter', { base: 'aws-cdk-lib.CfnElement', initializer: init() }),
    cls('constructs.RootConstruct', { assembly: 'constructs', base: 'constructs.Construct', initializer: init() }),
    cls('aws-cdk-lib.Stack', { base: 'constructs.Construct', initializer: init() }),
    cls('aws-cdk-lib.Stage', { base: 'constructs.Construct', initializer: init() }),
    cls('aws-cdk-lib.App', { base: 'aws-cdk-lib.Stage', initializer: init() }),
    cls('aws-cdk-lib.NestedStack', { base: 'aws-cdk-lib.Stack', initializer: init() }),

    cls('aws-cdk-lib.aws_s3.Bucket', {
      base: 'aws-cdk-lib.Resource',
      initializer: init('aws-cdk-lib.aws_s3.BucketProps'),
    }),
    struct('aws-cdk-lib.aws_s3.BucketProps', [
      prop(
        'bucketName',
        { primitive: 'string' },
        { optional: true, docs: doc('Physical name.', { default: '- Assigned by CloudFormation.' }) },
      ),
      prop('versioned', { primitive: 'boolean' }, { optional: true }),
      prop('tags', { collection: { kind: 'map', elementtype: { primitive: 'string' } } }, { optional: true }),
      prop(
        'lifecycleRules',
        { collection: { kind: 'array', elementtype: { fqn: 'aws-cdk-lib.aws_s3.LifecycleRule' } } },
        { optional: true },
      ),
      prop('removalPolicy', { fqn: 'aws-cdk-lib.RemovalPolicy' }, { optional: true }),
    ]),
    cls('aws-cdk-lib.aws_s3.CfnBucket', {
      base: 'aws-cdk-lib.CfnResource',
      initializer: init('aws-cdk-lib.aws_s3.CfnBucketProps'),
      docs: doc('The `AWS::S3::Bucket` resource.', { custom: { cloudformationResource: 'AWS::S3::Bucket' } }),
    }),
    struct('aws-cdk-lib.aws_s3.CfnBucketProps', [
      prop(
        'accessControl',
        { union: { types: [{ primitive: 'string' }, { fqn: 'aws-cdk-lib.interfaces.aws_s3.IBucketRef' }] } },
        { optional: true },
      ),
    ]),

    cls('aws-cdk-lib.aws_lambda.Function', {
      base: 'aws-cdk-lib.Resource',
      initializer: init('aws-cdk-lib.aws_lambda.FunctionProps'),
    }),
    cls('aws-cdk-lib.aws_lambda.CfnFunction', {
      base: 'aws-cdk-lib.CfnResource',
      initializer: init('aws-cdk-lib.aws_lambda.CfnFunctionProps'),
      docs: doc('The `AWS::Lambda::Function` resource.', {
        custom: { cloudformationResource: 'AWS::Lambda::Function' },
      }),
    }),
    struct('aws-cdk-lib.aws_lambda.CfnFunctionProps', []),
    struct(
      'aws-cdk-lib.aws_lambda.FunctionProps',
      [prop('code', { fqn: 'aws-cdk-lib.aws_lambda.Code' }), prop('handler', { primitive: 'string' })],
      {
        interfaces: ['aws-cdk-lib.aws_lambda.FunctionOptions'],
      },
    ),
    struct(
      'aws-cdk-lib.aws_lambda.FunctionOptions',
      [
        prop('timeout', { fqn: 'aws-cdk-lib.Duration' }, { optional: true }),
        prop('handler', { primitive: 'string' }, { optional: true }),
      ],
      {
        interfaces: ['aws-cdk-lib.aws_lambda.EventInvokeConfigOptions'],
      },
    ),
    struct('aws-cdk-lib.aws_lambda.EventInvokeConfigOptions', [
      prop('retryAttempts', { primitive: 'number' }, { optional: true }),
    ]),

    cls('aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService', {
      base: 'aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedServiceBase',
      initializer: init('aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateServiceProps'),
    }),
    cls('aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedServiceBase', {
      base: 'constructs.Construct',
      abstract: true,
    }),
    struct('aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateServiceProps', [
      prop('cpu', { primitive: 'number' }, { optional: true }),
    ]),

    cls('aws-cdk-lib.aws_s3.Notifier', { base: 'constructs.Construct', initializer: { ...init(), protected: true } }),
    cls('aws-cdk-lib.aws_sqs.Queue', { base: 'aws-cdk-lib.Resource', initializer: init() }),
    cls('aws-cdk-lib.aws_stepfunctions_tasks.SqsSendMessage', { base: 'constructs.Construct', initializer: init() }),
    cls('aws-cdk-lib.aws_kms.OldKey', {
      base: 'aws-cdk-lib.Resource',
      initializer: init(),
      docs: doc('Old.', { stability: 'deprecated' }),
    }),
    cls('aws-cdk-lib.Duration', { initializer: undefined }),
  ];
  return { name: LIB, version, types: Object.fromEntries(types.map((t) => [t.fqn, t])) };
}

function thirdParty() {
  const lib = 'my-constructs';
  const types = [
    {
      kind: 'class',
      fqn: 'my-constructs.Queueish',
      name: 'Queueish',
      assembly: lib,
      base: 'constructs.Construct',
      docs: doc('A third-party construct.'),
      initializer: init('my-constructs.QueueishProps'),
    },
    {
      kind: 'interface',
      datatype: true,
      fqn: 'my-constructs.QueueishProps',
      name: 'QueueishProps',
      assembly: lib,
      interfaces: ['aws-cdk-lib.aws_lambda.EventInvokeConfigOptions'],
      properties: [prop('queueName', { primitive: 'string' })],
    },
  ];
  return { name: lib, version: '1.2.3', types: Object.fromEntries(types.map((t) => [t.fqn, t])) };
}

const catalogOf = (...assemblies: unknown[]): Catalog => buildCatalog(assemblies.map(digestAssembly));

describe('digestAssembly', () => {
  it('keeps the package name and version', () => {
    expect(digestAssembly(cdkLib('2.200.1'))).toMatchObject({ name: 'aws-cdk-lib', version: '2.200.1' });
  });

  it('is plain JSON, so it can be cached', () => {
    const d = digestAssembly(cdkLib());
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it.each([null, 'text', {}, { name: 'x' }, { name: 'x', version: '1.0.0' }])(
    'refuses %j as a jsii assembly',
    (raw) => {
      expect(() => digestAssembly(raw)).toThrow(/jsii assembly/);
    },
  );
});

describe('buildCatalog', () => {
  const catalog = catalogOf(cdkLib());

  it('describes a construct with where it lives and what it is', () => {
    expect(entryFor(catalog, 'aws-cdk-lib.aws_s3.Bucket')).toMatchObject({
      fqn: 'aws-cdk-lib.aws_s3.Bucket',
      name: 'Bucket',
      library: 'aws-cdk-lib',
      service: 'S3',
      tier: 'L2',
      summary: 'A Bucket.',
    });
  });

  it('puts an L1 under CfnResource, with its CloudFormation type', () => {
    expect(entryFor(catalog, 'aws-cdk-lib.aws_s3.CfnBucket')).toMatchObject({ tier: 'L1', cfnType: 'AWS::S3::Bucket' });
  });

  it('gives an L2 the CloudFormation type of its L1 sibling', () => {
    expect(entryFor(catalog, 'aws-cdk-lib.aws_s3.Bucket')?.cfnType).toBe('AWS::S3::Bucket');
    expect(entryFor(catalog, 'aws-cdk-lib.aws_lambda.Function')?.cfnType).toBe('AWS::Lambda::Function');
  });

  it('puts a construct in a *_patterns module at L3, under its service', () => {
    expect(entryFor(catalog, 'aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService')).toMatchObject({
      tier: 'L3',
      service: 'ECS',
    });
  });

  it('leaves out what can never be placed: abstract classes, protected constructors, Stacks, Stages, and the two base classes', () => {
    const fqns = new Set(catalog.entries.map((e) => e.fqn));
    for (const gone of [
      'aws-cdk-lib.Resource',
      'aws-cdk-lib.CfnElement',
      'aws-cdk-lib.aws_s3.Notifier',
      'aws-cdk-lib.Stack',
      'aws-cdk-lib.NestedStack',
      'aws-cdk-lib.Stage',
      'aws-cdk-lib.App',
      'constructs.Construct',
      'aws-cdk-lib.CfnResource',
      'aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedServiceBase',
      'constructs.RootConstruct',
    ]) {
      expect(fqns, gone).not.toContain(gone);
    }
  });

  it('leaves out template elements such as outputs and parameters, which are not resources', () => {
    expect(entryFor(catalog, 'aws-cdk-lib.CfnOutput')).toBeUndefined();
    expect(entryFor(catalog, 'aws-cdk-lib.CfnParameter')).toBeUndefined();
  });

  it('leaves out classes that are not constructs', () => {
    expect(entryFor(catalog, 'aws-cdk-lib.Duration')).toBeUndefined();
  });

  it('marks a deprecated construct', () => {
    expect(entryFor(catalog, 'aws-cdk-lib.aws_kms.OldKey')?.deprecated).toBe(true);
    expect(entryFor(catalog, 'aws-cdk-lib.aws_s3.Bucket')?.deprecated).toBeUndefined();
  });

  describe('props', () => {
    it('lists each prop with its type, summary and CDK default as text, flagging required ones', () => {
      const props = entryFor(catalog, 'aws-cdk-lib.aws_s3.Bucket')!.props;
      expect(props.find((p) => p.name === 'bucketName')).toEqual({
        name: 'bucketName',
        type: 'string',
        required: false,
        summary: 'Physical name.',
        default: '- Assigned by CloudFormation.',
        input: { kind: 'string' },
      });
      expect(props.find((p) => p.name === 'versioned')).toMatchObject({ type: 'boolean', required: false });
    });

    it('writes collections, maps and classes the way a developer would', () => {
      const props = entryFor(catalog, 'aws-cdk-lib.aws_s3.Bucket')!.props;
      expect(props.find((p) => p.name === 'tags')?.type).toBe('Record<string, string>');
      expect(props.find((p) => p.name === 'lifecycleRules')?.type).toBe('LifecycleRule[]');
      expect(props.find((p) => p.name === 'removalPolicy')?.type).toBe('RemovalPolicy');
    });

    it('keeps the widening of L1 prop types contained: a Ref alternative to string is not shown', () => {
      expect(entryFor(catalog, 'aws-cdk-lib.aws_s3.CfnBucket')!.props).toEqual([
        expect.objectContaining({ name: 'accessControl', type: 'string' }),
      ]);
    });

    it('flattens props inherited through struct bases, nearest struct first', () => {
      const props = entryFor(catalog, 'aws-cdk-lib.aws_lambda.Function')!.props;
      expect(props.map((p) => p.name)).toEqual(['retryAttempts', 'timeout', 'handler', 'code']);
    });

    it('lets a struct redeclare an inherited prop, and flags it as the redeclaration says', () => {
      const handler = entryFor(catalog, 'aws-cdk-lib.aws_lambda.Function')!.props.find((p) => p.name === 'handler');
      expect(handler).toMatchObject({ required: true });
    });

    it('flags required props', () => {
      const required = entryFor(catalog, 'aws-cdk-lib.aws_lambda.Function')!
        .props.filter((p) => p.required)
        .map((p) => p.name);
      expect(required).toEqual(['handler', 'code']);
    });

    it('has no props for a construct with no props struct', () => {
      expect(entryFor(catalog, 'aws-cdk-lib.aws_kms.OldKey')!.props).toEqual([]);
    });

    it('survives a struct that inherits from itself', () => {
      const raw = cdkLib() as { types: Record<string, { interfaces?: string[] }> };
      raw.types['aws-cdk-lib.aws_lambda.EventInvokeConfigOptions']!.interfaces = [
        'aws-cdk-lib.aws_lambda.FunctionProps',
      ];
      const c = catalogOf(raw);
      expect(
        entryFor(c, 'aws-cdk-lib.aws_lambda.Function')!
          .props.map((p) => p.name)
          .sort(),
      ).toEqual(['code', 'handler', 'retryAttempts', 'timeout']);
    });

    it('keeps props from a struct base in another library when that library is in the Catalog, and skips it when not', () => {
      expect(entryFor(catalogOf(cdkLib(), thirdParty()), 'my-constructs.Queueish')!.props.map((p) => p.name)).toEqual([
        'retryAttempts',
        'queueName',
      ]);
      expect(entryFor(catalogOf(thirdParty()), 'my-constructs.Queueish')!.props.map((p) => p.name)).toEqual([
        'queueName',
      ]);
    });
  });

  describe('prop inputs', () => {
    /** A bucket-like construct whose props use an enum, a struct nested in a struct, a Duration, a Size and an array. */
    function withInputs() {
      const raw = cdkLib() as { types: Record<string, unknown> };
      Object.assign(raw.types, {
        'aws-cdk-lib.RemovalPolicy': {
          kind: 'enum',
          fqn: 'aws-cdk-lib.RemovalPolicy',
          name: 'RemovalPolicy',
          members: [{ name: 'DESTROY' }, { name: 'RETAIN' }],
        },
        'other-lib.Color': { kind: 'enum', fqn: 'other-lib.Color', name: 'Color', members: [{ name: 'RED' }] },
        'aws-cdk-lib.Size': cls('aws-cdk-lib.Size'),
        'aws-cdk-lib.aws_sqs.QueueProps': struct('aws-cdk-lib.aws_sqs.QueueProps', [
          prop('visibilityTimeout', { fqn: 'aws-cdk-lib.Duration' }, { optional: true }),
          prop('maxMessageSize', { fqn: 'aws-cdk-lib.Size' }, { optional: true }),
          prop('removalPolicy', { fqn: 'aws-cdk-lib.RemovalPolicy' }, { optional: true }),
          prop('color', { fqn: 'other-lib.Color' }, { optional: true }),
          prop('deadLetter', { fqn: 'aws-cdk-lib.aws_sqs.DeadLetter' }, { optional: true }),
          prop('self', { fqn: 'aws-cdk-lib.aws_sqs.Selfish' }, { optional: true }),
          prop('either', { union: { types: [{ primitive: 'string' }, { primitive: 'number' }] } }, { optional: true }),
        ]),
        'aws-cdk-lib.aws_sqs.DeadLetter': struct('aws-cdk-lib.aws_sqs.DeadLetter', [
          prop('maxReceiveCount', { primitive: 'number' }),
          prop('queues', { collection: { kind: 'array', elementtype: { primitive: 'string' } } }, { optional: true }),
        ]),
        'aws-cdk-lib.aws_sqs.Selfish': struct('aws-cdk-lib.aws_sqs.Selfish', [
          prop('again', { fqn: 'aws-cdk-lib.aws_sqs.Selfish' }, { optional: true }),
        ]),
      });
      raw.types['aws-cdk-lib.aws_sqs.Queue'] = cls('aws-cdk-lib.aws_sqs.Queue', {
        base: 'aws-cdk-lib.Resource',
        initializer: init('aws-cdk-lib.aws_sqs.QueueProps'),
      });
      return Object.fromEntries(
        entryFor(catalogOf(raw), 'aws-cdk-lib.aws_sqs.Queue')!.props.map((p) => [p.name, p.input]),
      );
    }

    it('offers an input for a Duration, a Size and an enum of CDK itself with its members', () => {
      const inputs = withInputs();
      expect(inputs['visibilityTimeout']).toEqual({ kind: 'duration' });
      expect(inputs['maxMessageSize']).toEqual({ kind: 'size' });
      expect(inputs['removalPolicy']).toEqual({
        kind: 'enum',
        fqn: 'aws-cdk-lib.RemovalPolicy',
        members: ['DESTROY', 'RETAIN'],
      });
    });

    it('lists the fields of a struct that Truss can write a literal for, and leaves out the rest', () => {
      const dead = withInputs()['deadLetter'];
      expect(dead).toEqual({
        kind: 'struct',
        fields: [expect.objectContaining({ name: 'maxReceiveCount', required: true, input: { kind: 'number' } })],
      });
    });

    it('offers nothing for an enum of another library, a union of several types, or a struct that contains itself', () => {
      const inputs = withInputs();
      expect(inputs['color']).toBeUndefined();
      expect(inputs['either']).toBeUndefined();
      expect(inputs['self']).toBeUndefined();
    });

    it('digests the members of an enum', () => {
      expect(digestAssembly(withEnum()).enumMembers).toEqual({ 'aws-cdk-lib.RemovalPolicy': ['DESTROY'] });
    });

    function withEnum() {
      const raw = cdkLib() as { types: Record<string, unknown> };
      raw.types['aws-cdk-lib.RemovalPolicy'] = {
        kind: 'enum',
        fqn: 'aws-cdk-lib.RemovalPolicy',
        name: 'RemovalPolicy',
        members: [{ name: 'DESTROY' }],
      };
      return raw;
    }
  });

  describe('third-party libraries', () => {
    it('adds their constructs even when the library holding Construct is not loaded', () => {
      const c = catalogOf(cdkLib(), thirdParty());
      expect(entryFor(c, 'my-constructs.Queueish')).toMatchObject({
        library: 'my-constructs',
        tier: 'L2',
        name: 'Queueish',
      });
    });

    it('has no service for a library that does not follow the aws-cdk-lib module layout', () => {
      expect(entryFor(catalogOf(thirdParty()), 'my-constructs.Queueish')?.service).toBeUndefined();
    });
  });

  it('is ordered, so the Catalog is the same however its libraries were found', () => {
    const a = catalogOf(cdkLib(), thirdParty());
    const b = catalogOf(thirdParty(), cdkLib());
    expect(a).toEqual(b);
  });
});

describe('searchCatalog', () => {
  const catalog = catalogOf(cdkLib(), thirdParty());
  const names = (query: string) => searchCatalog(catalog, query).map((h) => h.fqn);

  it('finds a construct by name, ignoring case', () => {
    expect(names('bucket')[0]).toBe('aws-cdk-lib.aws_s3.Bucket');
    expect(names('BUCKET')).toContain('aws-cdk-lib.aws_s3.CfnBucket');
  });

  it('puts an exact name first, then L2 before L3 before L1', () => {
    expect(names('bucket')).toEqual(['aws-cdk-lib.aws_s3.Bucket', 'aws-cdk-lib.aws_s3.CfnBucket']);
  });

  it('finds every construct of a service by the service name', () => {
    expect(names('s3')).toEqual(['aws-cdk-lib.aws_s3.Bucket', 'aws-cdk-lib.aws_s3.CfnBucket']);
    expect(names('lambda')).toEqual(['aws-cdk-lib.aws_lambda.Function', 'aws-cdk-lib.aws_lambda.CfnFunction']);
  });

  it('ranks the constructs of a service above one whose name merely starts with it', () => {
    expect(names('sqs')).toEqual(['aws-cdk-lib.aws_sqs.Queue', 'aws-cdk-lib.aws_stepfunctions_tasks.SqsSendMessage']);
  });

  it('finds a construct by CloudFormation type, whole or in part', () => {
    expect(names('AWS::S3::Bucket')).toEqual(['aws-cdk-lib.aws_s3.Bucket', 'aws-cdk-lib.aws_s3.CfnBucket']);
    expect(names('aws::lambda')).toEqual(['aws-cdk-lib.aws_lambda.Function', 'aws-cdk-lib.aws_lambda.CfnFunction']);
  });

  it('wants every word of a query to match somewhere', () => {
    expect(names('s3 bucket')).toEqual(['aws-cdk-lib.aws_s3.Bucket', 'aws-cdk-lib.aws_s3.CfnBucket']);
    expect(names('lambda bucket')).toEqual([]);
  });

  it('finds a pattern by its service, and a third-party construct by its library', () => {
    expect(names('ecs')).toEqual(['aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService']);
    expect(names('my-constructs')).toEqual(['my-constructs.Queueish']);
  });

  it('shows each hit with its tier, and without the props', () => {
    const hit = searchCatalog(catalog, 'bucket')[0]!;
    expect(hit).toMatchObject({ name: 'Bucket', tier: 'L2', service: 'S3', cfnType: 'AWS::S3::Bucket' });
    expect(hit).not.toHaveProperty('props');
  });

  it('puts deprecated constructs last', () => {
    expect(names('kms')).toEqual(['aws-cdk-lib.aws_kms.OldKey']);
    const c = catalogOf(cdkLib());
    const all = searchCatalog(c, '').map((h) => h.fqn);
    expect(all.at(-1)).toBe('aws-cdk-lib.aws_kms.OldKey');
  });

  it('lists everything, in order, for an empty query, up to the limit', () => {
    expect(searchCatalog(catalog, '  ', 3)).toHaveLength(3);
    expect(searchCatalog(catalog, '', 1000)).toHaveLength(catalog.entries.length);
  });

  it('finds nothing for a word nothing contains', () => {
    expect(names('zzzz')).toEqual([]);
  });
});

describe('Overlays', () => {
  const bucket: Overlay = {
    fqn: 'aws-cdk-lib.aws_s3.Bucket',
    displayName: 'S3 Bucket',
    featuredProps: ['versioned', 'bucketName'],
  };
  const withOverlays = (...overlays: Overlay[]) => buildCatalog([digestAssembly(cdkLib())], overlays);

  it('gives a construct its friendly name and marks it featured in the palette', () => {
    const hit = searchCatalog(withOverlays(bucket), 'bucket')[0]!;
    expect(hit).toMatchObject({ fqn: 'aws-cdk-lib.aws_s3.Bucket', displayName: 'S3 Bucket', featured: true });
    expect(searchCatalog(withOverlays(), 'bucket')[0]).not.toHaveProperty('displayName');
    expect(searchCatalog(withOverlays(), 'bucket')[0]).not.toHaveProperty('featured');
  });

  it('finds a featured construct by its friendly name', () => {
    const c = withOverlays({ ...bucket, displayName: 'Storage Bucket' });
    expect(searchCatalog(c, 'storage').map((h) => h.fqn)).toEqual(['aws-cdk-lib.aws_s3.Bucket']);
  });

  it('lists featured constructs first, ahead of those of equal rank', () => {
    const c = withOverlays({ fqn: 'aws-cdk-lib.aws_lambda.Function', displayName: 'Lambda Function' });
    expect(searchCatalog(c, '')[0]).toMatchObject({ fqn: 'aws-cdk-lib.aws_lambda.Function', featured: true });
  });

  it('replaces the tier the generator decided on', () => {
    const c = withOverlays({ ...bucket, tier: 'L3' });
    expect(entryFor(c, 'aws-cdk-lib.aws_s3.Bucket')?.tier).toBe('L3');
  });

  describe('items that do not resolve', () => {
    /** A small library with the members the Overlay items below refer to. */
    function overlayLib() {
      const raw = cdkLib() as { types: Record<string, unknown> };
      const t = raw.types;
      const method = (name: string) => ({ name, parameters: [] });
      t['aws-cdk-lib.aws_s3.Bucket'] = {
        ...(t['aws-cdk-lib.aws_s3.Bucket'] as object),
        base: 'aws-cdk-lib.aws_s3.BucketBase',
        methods: [method('addLifecycleRule')],
      };
      t['aws-cdk-lib.aws_s3.BucketBase'] = cls('aws-cdk-lib.aws_s3.BucketBase', {
        base: 'aws-cdk-lib.Resource',
        abstract: true,
        methods: [
          method('grantRead'),
          { name: 'protectedThing', protected: true },
          { name: 'fromBucketName', static: true },
        ],
        properties: [
          prop('grants', { fqn: 'aws-cdk-lib.aws_s3.BucketGrants' }, { immutable: true }),
          prop('bucketArn', { primitive: 'string' }),
          prop('root', { fqn: 'aws-cdk-lib.aws_s3.IFolder' }),
        ],
      });
      t['aws-cdk-lib.aws_s3.IFolder'] = {
        kind: 'interface',
        fqn: 'aws-cdk-lib.aws_s3.IFolder',
        name: 'IFolder',
        interfaces: ['aws-cdk-lib.aws_s3.IBaseFolder'],
        methods: [method('addFolder')],
      };
      t['aws-cdk-lib.aws_s3.IBaseFolder'] = {
        kind: 'interface',
        fqn: 'aws-cdk-lib.aws_s3.IBaseFolder',
        name: 'IBaseFolder',
        methods: [method('addFile')],
        properties: [prop('path', { primitive: 'string' })],
      };
      t['aws-cdk-lib.aws_s3.BucketGrants'] = cls('aws-cdk-lib.aws_s3.BucketGrants', { methods: [method('read')] });
      t['aws-cdk-lib.RemovalPolicy'] = {
        kind: 'enum',
        fqn: 'aws-cdk-lib.RemovalPolicy',
        name: 'RemovalPolicy',
        members: [{ name: 'DESTROY' }],
      };
      t['aws-cdk-lib.aws_lambda.Function'] = {
        ...(t['aws-cdk-lib.aws_lambda.Function'] as object),
        methods: [method('addEnvironment'), method('addEventSource')],
        properties: [prop('role', { fqn: 'aws-cdk-lib.aws_iam.IRole' })],
      };
      return raw;
    }
    const build = (...overlays: Overlay[]) => buildCatalog([digestAssembly(overlayLib())], overlays);
    const bucketWith = (extra: Partial<Overlay>): Overlay => ({
      fqn: 'aws-cdk-lib.aws_s3.Bucket',
      displayName: 'S3 Bucket',
      ...extra,
    });

    it('drops a whole Overlay whose construct is not in the Catalog, and says so', () => {
      const c = build({ fqn: 'aws-cdk-lib.aws_s3.NoSuchThing', displayName: 'Nothing' });
      expect(c.entries.some((e) => e.overlay)).toBe(false);
      expect(c.dropped).toEqual([expect.stringContaining('aws-cdk-lib.aws_s3.NoSuchThing')]);
    });

    it('keeps featured props the construct has, in the Overlay order, and drops the ones it does not', () => {
      const c = build(bucketWith({ featuredProps: ['versioned', 'gone', 'bucketName'] }));
      expect(entryFor(c, 'aws-cdk-lib.aws_s3.Bucket')?.overlay?.featuredProps).toEqual(['versioned', 'bucketName']);
      expect(c.dropped).toEqual([expect.stringMatching(/Bucket.*featured prop "gone"/)]);
    });

    it('keeps defaults and fixtures for props the construct has, and for the classes they name', () => {
      const ok = { code: 'RemovalPolicy.DESTROY', uses: ['aws-cdk-lib.RemovalPolicy'] };
      const c = build(
        bucketWith({
          defaults: {
            removalPolicy: ok,
            gone: { code: '1' },
            versioned: { code: 'Nope.X', uses: ['aws-cdk-lib.Nope'] },
          },
          fixtures: { bucketName: { code: "'b'" }, alsoGone: { code: '1' } },
        }),
      );
      const overlay = entryFor(c, 'aws-cdk-lib.aws_s3.Bucket')!.overlay!;
      expect(overlay.defaults).toEqual({ removalPolicy: ok });
      expect(overlay.fixtures).toEqual({ bucketName: { code: "'b'" } });
      expect(c.dropped).toHaveLength(3);
      expect(c.dropped.join('\n')).toMatch(/default "gone"/);
      expect(c.dropped.join('\n')).toMatch(/default "versioned".*aws-cdk-lib\.Nope/);
      expect(c.dropped.join('\n')).toMatch(/fixture "alsoGone"/);
    });

    describe('Connection hints', () => {
      const grantRead = {
        kind: 'grant' as const,
        label: 'is read by',
        peers: ['aws-cdk-lib.aws_lambda.Function'],
        flow: 'out' as const,
        primary: { forms: [['grants', 'read'], ['grantRead']], args: ['{peer}'] },
      };
      const hintsOf = (c: Catalog) => entryFor(c, 'aws-cdk-lib.aws_s3.Bucket')!.overlay!.connections;

      it('keeps a hint whose calls resolve, through the class and the classes it extends', () => {
        const c = build(bucketWith({ connections: [grantRead] }));
        expect(hintsOf(c)).toEqual([grantRead]);
        expect(c.dropped).toEqual([]);
      });

      it('drops the spellings of a call that do not resolve, so the app is written in the form it has', () => {
        const old = build(
          bucketWith({
            connections: [
              { ...grantRead, primary: { ...grantRead.primary, forms: [['grants', 'readAll'], ['grantRead']] } },
            ],
          }),
        );
        expect(hintsOf(old)[0]!.primary.forms).toEqual([['grantRead']]);
        expect(old.dropped).toEqual([expect.stringMatching(/form grants\.readAll/)]);
      });

      it('drops a hint none of whose primary spellings resolve', () => {
        const c = build(
          bucketWith({ connections: [{ ...grantRead, primary: { ...grantRead.primary, forms: [['grantNothing']] } }] }),
        );
        expect(hintsOf(c)).toEqual([]);
        expect(c.dropped.join('\n')).toMatch(/hint "is read by".*grantNothing/);
      });

      it('does not take a static or protected method for one the Node can be called with', () => {
        for (const member of ['fromBucketName', 'protectedThing']) {
          const c = build(
            bucketWith({ connections: [{ ...grantRead, primary: { ...grantRead.primary, forms: [[member]] } }] }),
          );
          expect(hintsOf(c), member).toEqual([]);
        }
      });

      it('drops peers that are not in the libraries, and the hint when none are left', () => {
        const some = build(
          bucketWith({
            connections: [{ ...grantRead, peers: ['aws-cdk-lib.aws_lambda.Function', 'aws-cdk-lib.aws_nope.Thing'] }],
          }),
        );
        expect(hintsOf(some)[0]!.peers).toEqual(['aws-cdk-lib.aws_lambda.Function']);
        const none = build(bucketWith({ connections: [{ ...grantRead, peers: ['aws-cdk-lib.aws_nope.Thing'] }] }));
        expect(hintsOf(none)).toEqual([]);
      });

      it('follows a property typed as an interface, and finds methods on the interfaces it extends', () => {
        for (const member of ['addFolder', 'addFile']) {
          const hint = { ...grantRead, primary: { ...grantRead.primary, forms: [['root', member]] } };
          expect(hintsOf(build(bucketWith({ connections: [hint] }))), member).toEqual([hint]);
        }
      });

      it('drops a hint whose arguments name a class that is not there', () => {
        const c = build(
          bucketWith({
            connections: [{ ...grantRead, primary: { ...grantRead.primary, uses: ['aws-cdk-lib.aws_nope.Thing'] } }],
          }),
        );
        expect(hintsOf(c)).toEqual([]);
      });

      it('drops a secondary call that does not resolve on the peer, and keeps the hint', () => {
        const env = { on: 'peer' as const, forms: [['addEnvironment']], args: ["'BUCKET'", '{self}.bucketName'] };
        const lost = { on: 'peer' as const, forms: [['addNothing']], args: [] };
        const c = build(bucketWith({ connections: [{ ...grantRead, secondary: [env, lost] }] }));
        expect(hintsOf(c)[0]!.secondary).toEqual([env]);
        expect(c.dropped).toEqual([expect.stringMatching(/addNothing/)]);
      });
    });

    describe('reference flows', () => {
      const fn = (referenceFlows: Overlay['referenceFlows']): Overlay => ({
        fqn: 'aws-cdk-lib.aws_lambda.Function',
        displayName: 'Function',
        referenceFlows,
      });

      it('keeps the props the construct has, and drops the ones it does not, saying so', () => {
        const c = build(fn({ timeout: 'in', gone: 'in' }));
        expect(entryFor(c, 'aws-cdk-lib.aws_lambda.Function')!.overlay!.referenceFlows).toEqual({ timeout: 'in' });
        expect(c.dropped).toEqual([expect.stringMatching(/Function.*reference flow "gone"/)]);
      });

      it('is empty for an Overlay that has none', () => {
        expect(entryFor(build(fn(undefined)), 'aws-cdk-lib.aws_lambda.Function')!.overlay!.referenceFlows).toEqual({});
      });
    });

    describe('accessors', () => {
      const fn = (accessors: Overlay['accessors']): Overlay => ({
        fqn: 'aws-cdk-lib.aws_lambda.Function',
        displayName: 'Function',
        accessors,
      });

      it('keeps an accessor whose path follows properties the construct has, and drops one that does not', () => {
        const good = { as: 'grantee' as const, path: ['role'] };
        const c = build(
          fn([good, { as: 'grantee', path: ['nope', 'role'] }, { as: 'connectable', path: ['role', 'deeper'] }]),
        );
        expect(entryFor(c, 'aws-cdk-lib.aws_lambda.Function')!.overlay!.accessors).toEqual([good]);
        expect(c.dropped).toHaveLength(2);
      });
    });
  });
});

describe('props that take constructs', () => {
  /** A Function whose props take a Vpc, a list of security groups, a Duration and a struct. */
  function withReferences() {
    const raw = cdkLib() as { types: Record<string, unknown> };
    const t = raw.types;
    t['aws-cdk-lib.aws_ec2.IVpc'] = {
      kind: 'interface',
      fqn: 'aws-cdk-lib.aws_ec2.IVpc',
      name: 'IVpc',
      interfaces: ['aws-cdk-lib.IResource'],
    };
    t['aws-cdk-lib.IResource'] = { kind: 'interface', fqn: 'aws-cdk-lib.IResource', name: 'IResource' };
    t['aws-cdk-lib.aws_ec2.ISecurityGroup'] = {
      kind: 'interface',
      fqn: 'aws-cdk-lib.aws_ec2.ISecurityGroup',
      name: 'ISecurityGroup',
    };
    t['aws-cdk-lib.aws_ec2.Vpc'] = cls('aws-cdk-lib.aws_ec2.Vpc', {
      base: 'aws-cdk-lib.Resource',
      interfaces: ['aws-cdk-lib.aws_ec2.IVpc'],
      initializer: init(),
    });
    t['aws-cdk-lib.aws_ec2.SecurityGroup'] = cls('aws-cdk-lib.aws_ec2.SecurityGroup', {
      base: 'aws-cdk-lib.Resource',
      interfaces: ['aws-cdk-lib.aws_ec2.ISecurityGroup'],
      initializer: init(),
    });
    t['aws-cdk-lib.aws_lambda.FunctionOptions'] = struct('aws-cdk-lib.aws_lambda.FunctionOptions', [
      prop('timeout', { fqn: 'aws-cdk-lib.Duration' }, { optional: true }),
      prop('vpc', { fqn: 'aws-cdk-lib.aws_ec2.IVpc' }, { optional: true }),
      prop(
        'securityGroups',
        { collection: { kind: 'array', elementtype: { fqn: 'aws-cdk-lib.aws_ec2.ISecurityGroup' } } },
        { optional: true },
      ),
      prop(
        'role',
        { union: { types: [{ fqn: 'aws-cdk-lib.aws_ec2.IVpc' }, { fqn: 'aws-cdk-lib.interfaces.aws_iam.IRoleRef' }] } },
        { optional: true },
      ),
      prop(
        'tags',
        { collection: { kind: 'map', elementtype: { fqn: 'aws-cdk-lib.aws_ec2.IVpc' } } },
        { optional: true },
      ),
    ]);
    return catalogOf(raw);
  }
  const prop_ = (name: string) =>
    entryFor(withReferences(), 'aws-cdk-lib.aws_lambda.Function')!.props.find((p) => p.name === name);

  it('marks a prop typed as an interface, or a construct class, with what it accepts', () => {
    expect(prop_('vpc')?.accepts).toEqual({ fqn: 'aws-cdk-lib.aws_ec2.IVpc' });
  });

  it('marks an array of them as taking several', () => {
    expect(prop_('securityGroups')?.accepts).toEqual({ fqn: 'aws-cdk-lib.aws_ec2.ISecurityGroup', many: true });
  });

  it('sees through the Ref alternative an L1 prop adds', () => {
    expect(prop_('role')?.accepts).toEqual({ fqn: 'aws-cdk-lib.aws_ec2.IVpc' });
  });

  it('leaves out a prop typed as anything else: a Duration, a primitive, a map', () => {
    for (const name of ['timeout', 'handler', 'tags']) expect(prop_(name)).not.toHaveProperty('accepts');
  });

  it('lists everything a construct is assignable to, through its base classes and interfaces', () => {
    const vpc = entryFor(withReferences(), 'aws-cdk-lib.aws_ec2.Vpc')!;
    expect(vpc.assignableTo).toEqual(
      expect.arrayContaining([
        'aws-cdk-lib.aws_ec2.Vpc',
        'aws-cdk-lib.aws_ec2.IVpc',
        'aws-cdk-lib.IResource',
        'aws-cdk-lib.Resource',
      ]),
    );
  });

  it('keeps that list out of a search hit', () => {
    expect(searchCatalog(withReferences(), 'vpc')[0]).not.toHaveProperty('assignableTo');
  });
});

describe('grant methods', () => {
  const method = (name: string, param: string, returns: string) => ({
    name,
    parameters: [{ name: 'identity', type: { fqn: param } }],
    returns: { type: { fqn: returns } },
  });
  const raw = {
    name: 'x',
    version: '1.0.0',
    types: {
      'x.Thing': {
        kind: 'class',
        fqn: 'x.Thing',
        name: 'Thing',
        base: 'constructs.Construct',
        methods: [
          method('grantRead', 'aws-cdk-lib.aws_iam.IGrantable', 'aws-cdk-lib.aws_iam.Grant'),
          method('grantNothing', 'x.Other', 'aws-cdk-lib.aws_iam.Grant'),
          method('poke', 'aws-cdk-lib.aws_iam.IGrantable', 'x.Other'),
        ],
      },
    },
  };

  it('keeps the methods that take an IGrantable and return a Grant', () => {
    expect(digestAssembly(raw).classes[0]!.grantMethods).toEqual(['grantRead']);
  });
});
