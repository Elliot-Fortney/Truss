import { describe, expect, it } from 'vitest';
import { buildCatalog, digestAssembly, entryFor, searchCatalog, type Catalog } from './catalog.ts';

const doc = (summary: string, extra: Record<string, unknown> = {}) => ({ summary, stability: 'stable', ...extra });
const prop = (name: string, type: unknown, extra: Record<string, unknown> = {}) => ({ name, type, docs: doc(`The ${name}.`), ...extra });
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
    cls('aws-cdk-lib.Stack', { base: 'constructs.Construct', initializer: init() }),
    cls('aws-cdk-lib.Stage', { base: 'constructs.Construct', initializer: init() }),
    cls('aws-cdk-lib.App', { base: 'aws-cdk-lib.Stage', initializer: init() }),
    cls('aws-cdk-lib.NestedStack', { base: 'aws-cdk-lib.Stack', initializer: init() }),

    cls('aws-cdk-lib.aws_s3.Bucket', { base: 'aws-cdk-lib.Resource', initializer: init('aws-cdk-lib.aws_s3.BucketProps') }),
    struct('aws-cdk-lib.aws_s3.BucketProps', [
      prop('bucketName', { primitive: 'string' }, { optional: true, docs: doc('Physical name.', { default: '- Assigned by CloudFormation.' }) }),
      prop('versioned', { primitive: 'boolean' }, { optional: true }),
      prop('tags', { collection: { kind: 'map', elementtype: { primitive: 'string' } } }, { optional: true }),
      prop('lifecycleRules', { collection: { kind: 'array', elementtype: { fqn: 'aws-cdk-lib.aws_s3.LifecycleRule' } } }, { optional: true }),
      prop('removalPolicy', { fqn: 'aws-cdk-lib.RemovalPolicy' }, { optional: true }),
    ]),
    cls('aws-cdk-lib.aws_s3.CfnBucket', {
      base: 'aws-cdk-lib.CfnResource',
      initializer: init('aws-cdk-lib.aws_s3.CfnBucketProps'),
      docs: doc('The `AWS::S3::Bucket` resource.', { custom: { cloudformationResource: 'AWS::S3::Bucket' } }),
    }),
    struct('aws-cdk-lib.aws_s3.CfnBucketProps', [
      prop('accessControl', { union: { types: [{ primitive: 'string' }, { fqn: 'aws-cdk-lib.interfaces.aws_s3.IBucketRef' }] } }, { optional: true }),
    ]),

    cls('aws-cdk-lib.aws_lambda.Function', { base: 'aws-cdk-lib.Resource', initializer: init('aws-cdk-lib.aws_lambda.FunctionProps') }),
    cls('aws-cdk-lib.aws_lambda.CfnFunction', {
      base: 'aws-cdk-lib.CfnResource',
      initializer: init('aws-cdk-lib.aws_lambda.CfnFunctionProps'),
      docs: doc('The `AWS::Lambda::Function` resource.', { custom: { cloudformationResource: 'AWS::Lambda::Function' } }),
    }),
    struct('aws-cdk-lib.aws_lambda.CfnFunctionProps', []),
    struct('aws-cdk-lib.aws_lambda.FunctionProps', [prop('code', { fqn: 'aws-cdk-lib.aws_lambda.Code' }), prop('handler', { primitive: 'string' })], {
      interfaces: ['aws-cdk-lib.aws_lambda.FunctionOptions'],
    }),
    struct('aws-cdk-lib.aws_lambda.FunctionOptions', [prop('timeout', { fqn: 'aws-cdk-lib.Duration' }, { optional: true }), prop('handler', { primitive: 'string' }, { optional: true })], {
      interfaces: ['aws-cdk-lib.aws_lambda.EventInvokeConfigOptions'],
    }),
    struct('aws-cdk-lib.aws_lambda.EventInvokeConfigOptions', [prop('retryAttempts', { primitive: 'number' }, { optional: true })]),

    cls('aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService', {
      base: 'aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedServiceBase',
      initializer: init('aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateServiceProps'),
    }),
    cls('aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedServiceBase', { base: 'constructs.Construct', abstract: true }),
    struct('aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateServiceProps', [prop('cpu', { primitive: 'number' }, { optional: true })]),

    cls('aws-cdk-lib.aws_s3.Notifier', { base: 'constructs.Construct', initializer: { ...init(), protected: true } }),
    cls('aws-cdk-lib.aws_kms.OldKey', { base: 'aws-cdk-lib.Resource', initializer: init(), docs: doc('Old.', { stability: 'deprecated' }) }),
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

  it.each([null, 'text', {}, { name: 'x' }, { name: 'x', version: '1.0.0' }])('refuses %j as a jsii assembly', (raw) => {
    expect(() => digestAssembly(raw)).toThrow(/jsii assembly/);
  });
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
    expect(entryFor(catalog, 'aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService')).toMatchObject({ tier: 'L3', service: 'ECS' });
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
    ]) {
      expect(fqns, gone).not.toContain(gone);
    }
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
      expect(entryFor(catalog, 'aws-cdk-lib.aws_s3.CfnBucket')!.props).toEqual([expect.objectContaining({ name: 'accessControl', type: 'string' })]);
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
      const required = entryFor(catalog, 'aws-cdk-lib.aws_lambda.Function')!.props.filter((p) => p.required).map((p) => p.name);
      expect(required).toEqual(['handler', 'code']);
    });

    it('has no props for a construct with no props struct', () => {
      expect(entryFor(catalog, 'aws-cdk-lib.aws_kms.OldKey')!.props).toEqual([]);
    });

    it('survives a struct that inherits from itself', () => {
      const raw = cdkLib() as { types: Record<string, { interfaces?: string[] }> };
      raw.types['aws-cdk-lib.aws_lambda.EventInvokeConfigOptions']!.interfaces = ['aws-cdk-lib.aws_lambda.FunctionProps'];
      const c = catalogOf(raw);
      expect(entryFor(c, 'aws-cdk-lib.aws_lambda.Function')!.props.map((p) => p.name).sort()).toEqual(['code', 'handler', 'retryAttempts', 'timeout']);
    });

    it('keeps props from a struct base in another library when that library is in the Catalog, and skips it when not', () => {
      expect(entryFor(catalogOf(cdkLib(), thirdParty()), 'my-constructs.Queueish')!.props.map((p) => p.name)).toEqual(['retryAttempts', 'queueName']);
      expect(entryFor(catalogOf(thirdParty()), 'my-constructs.Queueish')!.props.map((p) => p.name)).toEqual(['queueName']);
    });
  });

  describe('third-party libraries', () => {
    it('adds their constructs even when the library holding Construct is not loaded', () => {
      const c = catalogOf(cdkLib(), thirdParty());
      expect(entryFor(c, 'my-constructs.Queueish')).toMatchObject({ library: 'my-constructs', tier: 'L2', name: 'Queueish' });
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
