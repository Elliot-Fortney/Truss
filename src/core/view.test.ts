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
  resourceRefs: [],
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
            children: [
              { id: 'Resource', path: 'Api/Jobs/Resource', fqn: 'aws-cdk-lib.aws_sqs.CfnQueue', children: [] },
            ],
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
    'Web/Site': {
      span: span(20),
      className: 's3.Bucket',
      literalId: 'Site',
      pathsOnSpan: 2,
      binding: 'none',
      surround: { kind: 'loop' },
    },
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

  it('puts each construct the app wrote in its Stack box as a Node, with the icon its type has', () => {
    expect(view.nodes.map((n) => [n.id, n.stackId, n.label, n.subtitle, n.icon])).toEqual([
      ['Api/Jobs', 'Api', 'Jobs', 'Queue', 'sqs-queue'],
      ['Web/Site', 'Web', 'Site', 'Bucket', 's3-bucket'],
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

const leaf = (path: string, fqn: string, children: TreeNode[] = []): TreeNode => ({
  id: path.split('/').at(-1)!,
  path,
  fqn,
  children,
});
const here = (line: number) => ({ file: 'lib/a.ts', start: { line, col: 5 }, end: { line, col: 30 } });

describe('buildView with nested stacks and Stages', () => {
  const assembly: Assembly = {
    schemaVersion: '55.0.0',
    stacks: [
      { path: 'Pipeline' },
      { path: 'Dev/Core', env: 'aws://111111111111/eu-west-1' },
      { path: 'Prod/Core', env: 'aws://111111111111/eu-west-1' },
    ],
    creation: {},
    resourceRefs: [],
    tree: leaf('', 'aws-cdk-lib.App', [
      leaf('Pipeline', 'aws-cdk-lib.Stack', [leaf('Pipeline/Repo', 'aws-cdk-lib.aws_s3.Bucket')]),
      leaf('Dev', 'aws-cdk-lib.Stage', [
        leaf('Dev/Core', 'aws-cdk-lib.Stack', [
          leaf('Dev/Core/Jobs', 'aws-cdk-lib.aws_sqs.Queue'),
          leaf('Dev/Core/Worker', 'aws-cdk-lib.NestedStack', [
            leaf('Dev/Core/Worker/Inbox', 'aws-cdk-lib.aws_sqs.Queue'),
          ]),
          leaf('Dev/Core/Worker.NestedStack', 'constructs.Construct', [
            leaf('Dev/Core/Worker.NestedStack/Worker.NestedStackResource', 'aws-cdk-lib.CfnStack'),
          ]),
        ]),
      ]),
      leaf('Prod', 'aws-cdk-lib.Stage', [
        leaf('Prod/Core', 'aws-cdk-lib.Stack', [leaf('Prod/Core/Jobs', 'aws-cdk-lib.aws_sqs.Queue')]),
      ]),
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

  it("draws a nested stack as a box inside its parent, with the parent's environment, listed after the parent", () => {
    expect(view.stacks.find((s) => s.id === 'Dev/Core/Worker')).toEqual({
      id: 'Dev/Core/Worker',
      label: 'Worker',
      env: 'eu-west-1 · 111111111111',
      parentId: 'Dev/Core',
      stageId: 'Dev',
    });
    expect(view.stacks.find((s) => s.id === 'Dev/Core')).not.toHaveProperty('parentId');
  });

  it("puts what a nested stack creates in the nested stack's box, and makes neither it nor its plumbing a Node", () => {
    expect(view.nodes.map((n) => [n.id, n.stackId])).toEqual([
      ['Pipeline/Repo', 'Pipeline'],
      ['Dev/Core/Jobs', 'Dev/Core'],
      ['Dev/Core/Worker/Inbox', 'Dev/Core/Worker'],
      ['Prod/Core/Jobs', 'Prod/Core'],
    ]);
  });

  it('has no Stages for an app without any', () => {
    expect(
      buildView(
        { nodes: {} },
        { ...assembly, tree: leaf('', 'aws-cdk-lib.App', [leaf('Pipeline', 'aws-cdk-lib.Stack')]) },
        emptySidecar(),
      ).stages,
    ).toEqual([]);
  });
});

describe('buildView naming', () => {
  const assembly: Assembly = {
    schemaVersion: '55.0.0',
    stacks: [{ path: 'S' }],
    creation: {},
    resourceRefs: [],
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
  const node = (className: string, id: string, extra: Partial<NodeFacts> = {}): NodeFacts => ({
    span: here(1),
    className,
    literalId: id,
    pathsOnSpan: 1,
    binding: 'none',
    ...extra,
  });
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

describe('buildView Layers', () => {
  const assembly: Assembly = {
    schemaVersion: '55.0.0',
    stacks: [{ path: 'S' }],
    creation: {},
    resourceRefs: [
      // The notifications custom resource under the Bucket points at the stack-wide handler.
      { from: 'S/Site/Notifications/Resource', to: 'S/NotificationsHandler/Resource' },
      { from: 'S/NotificationsHandler/Resource', to: 'S/NotificationsHandler/Role/Resource' },
      // The Service points at a default Cluster, which points at a default Vpc.
      { from: 'S/Service/Resource', to: 'S/DefaultCluster/Resource' },
      { from: 'S/DefaultCluster/Resource', to: 'S/DefaultVpc/Resource' },
      // A reference between two Nodes is a Connection's business, not a hoisted Node's.
      { from: 'S/Service/Resource', to: 'S/Site/Resource' },
    ],
    tree: leaf('', 'aws-cdk-lib.App', [
      leaf('S', 'aws-cdk-lib.Stack', [
        leaf('S/Site', 'aws-cdk-lib.aws_s3.Bucket', [
          { ...leaf('S/Site/Resource', 'aws-cdk-lib.aws_s3.CfnBucket'), cfnType: 'AWS::S3::Bucket' },
          leaf('S/Site/Notifications', 'constructs.Construct', [
            leaf('S/Site/Notifications/Resource', 'aws-cdk-lib.CfnResource'),
          ]),
        ]),
        leaf('S/Service', 'aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService', [
          { ...leaf('S/Service/Resource', 'aws-cdk-lib.aws_ecs.CfnService'), cfnType: 'AWS::ECS::Service' },
        ]),
        leaf('S/NotificationsHandler', 'constructs.Construct', [
          leaf('S/NotificationsHandler/Role', 'aws-cdk-lib.aws_iam.Role', [
            {
              ...leaf('S/NotificationsHandler/Role/Resource', 'aws-cdk-lib.aws_iam.CfnRole'),
              cfnType: 'AWS::IAM::Role',
            },
          ]),
          leaf('S/NotificationsHandler/Resource', 'aws-cdk-lib.CfnResource'),
        ]),
        leaf('S/DefaultCluster', 'aws-cdk-lib.aws_ecs.Cluster', [
          leaf('S/DefaultCluster/Resource', 'aws-cdk-lib.aws_ecs.CfnCluster'),
        ]),
        leaf('S/DefaultVpc', 'aws-cdk-lib.aws_ec2.Vpc', [leaf('S/DefaultVpc/Resource', 'aws-cdk-lib.aws_ec2.CfnVPC')]),
        leaf('S/CDKMetadata', 'constructs.Construct', [leaf('S/CDKMetadata/Default', 'aws-cdk-lib.CfnResource')]),
        leaf('S/BootstrapVersion', 'aws-cdk-lib.CfnParameter'),
        leaf('S/CheckBootstrapVersion', 'aws-cdk-lib.CfnRule'),
      ]),
    ]),
  };
  const node = (className: string, id: string, line: number): NodeFacts => ({
    span: here(line),
    className,
    literalId: id,
    pathsOnSpan: 1,
    binding: 'none',
  });
  const facts: Facts = {
    nodes: {
      'S/Site': node('s3.Bucket', 'Site', 10),
      'S/Service': node('ecsPatterns.ApplicationLoadBalancedFargateService', 'Service', 20),
    },
  };
  const view = buildView(facts, assembly, emptySidecar());
  const byId = (id: string) => view.nodes.find((n) => n.id === id)!;

  it('gives a Node every construct beneath it as read-only children, in tree order, with the type and path of each', () => {
    expect(byId('S/Site').children).toEqual([
      {
        id: 'S/Site/Resource',
        parentId: 'S/Site',
        label: 'Resource',
        fqn: 'aws-cdk-lib.aws_s3.CfnBucket',
        cfnType: 'AWS::S3::Bucket',
        icon: expect.any(String),
      },
      {
        id: 'S/Site/Notifications',
        parentId: 'S/Site',
        label: 'Notifications',
        fqn: 'constructs.Construct',
        icon: expect.any(String),
      },
      {
        id: 'S/Site/Notifications/Resource',
        parentId: 'S/Site/Notifications',
        label: 'Resource',
        fqn: 'aws-cdk-lib.CfnResource',
        icon: expect.any(String),
      },
    ]);
  });

  it('gives a Node with nothing beneath it no children', () => {
    const bare = buildView(
      { nodes: { 'S/Site': node('s3.CfnBucket', 'Site', 10) } },
      {
        ...assembly,
        tree: leaf('', 'aws-cdk-lib.App', [
          leaf('S', 'aws-cdk-lib.Stack', [leaf('S/Site', 'aws-cdk-lib.aws_s3.CfnBucket')]),
        ]),
      },
      emptySidecar(),
    );
    expect(bare.nodes[0]).not.toHaveProperty('children');
  });

  it('draws a construct outside every Node as a read-only hoisted Node at Stack scope, with its own children', () => {
    const handler = byId('S/NotificationsHandler');
    expect(handler).toMatchObject({ stackId: 'S', label: 'NotificationsHandler', hoisted: true });
    expect(handler.lock).toEqual(expect.stringContaining('Site'));
    expect(handler.children?.map((c) => c.id)).toEqual([
      'S/NotificationsHandler/Role',
      'S/NotificationsHandler/Role/Resource',
      'S/NotificationsHandler/Resource',
    ]);
  });

  it('links a hoisted Node to the Node whose resources point at it', () => {
    expect(byId('S/NotificationsHandler').causedBy).toEqual(['S/Site']);
  });

  it('links a hoisted Node reached only through another hoisted Node to the Node that started the chain', () => {
    expect(byId('S/DefaultCluster').causedBy).toEqual(['S/Service']);
    expect(byId('S/DefaultVpc').causedBy).toEqual(['S/Service']);
  });

  it('opens a hoisted Node at the code of the Node that caused it', () => {
    expect(byId('S/NotificationsHandler').source).toEqual({ file: 'lib/a.ts', line: 10, col: 5 });
  });

  it("does not link two Nodes, and marks no Node of the app's own as hoisted", () => {
    expect(byId('S/Site')).not.toHaveProperty('hoisted');
    expect(byId('S/Site')).not.toHaveProperty('causedBy');
    expect(byId('S/Service')).not.toHaveProperty('causedBy');
  });

  it('leaves out the Stack plumbing CDK adds to every Stack', () => {
    const ids = view.nodes.map((n) => n.id);
    expect(ids).not.toContain('S/CDKMetadata');
    expect(ids).not.toContain('S/BootstrapVersion');
    expect(ids).not.toContain('S/CheckBootstrapVersion');
  });

  it('links a hoisted Node that nothing points at to the Node it points at, as a policy attached to a Node is', () => {
    const withPolicy: Assembly = {
      ...assembly,
      resourceRefs: [...assembly.resourceRefs, { from: 'S/Policy/Resource', to: 'S/Site/Resource' }],
      tree: {
        ...assembly.tree,
        children: [
          {
            ...assembly.tree.children[0]!,
            children: [
              ...assembly.tree.children[0]!.children,
              leaf('S/Policy', 'aws-cdk-lib.aws_iam.Policy', [
                leaf('S/Policy/Resource', 'aws-cdk-lib.aws_iam.CfnPolicy'),
              ]),
            ],
          },
        ],
      },
    };
    const policy = buildView(facts, withPolicy, emptySidecar()).nodes.find((n) => n.id === 'S/Policy')!;
    expect(policy.causedBy).toEqual(['S/Site']);
  });

  it('still shows a hoisted Node nothing points at, read-only and without a link', () => {
    const orphan = buildView(facts, { ...assembly, resourceRefs: [] }, emptySidecar()).nodes.find(
      (n) => n.id === 'S/DefaultVpc',
    )!;
    expect(orphan).toMatchObject({ hoisted: true, lock: expect.any(String) });
    expect(orphan).not.toHaveProperty('causedBy');
  });
});

describe('buildView edges', () => {
  const refSpan = { file: 'lib/a.ts', start: { line: 12, col: 30 }, end: { line: 12, col: 34 } };
  const reference = (extra: Partial<NonNullable<Facts['references']>[number]> = {}) => ({
    from: 'Api/Jobs',
    to: 'Api/Site',
    prop: 'bucket',
    form: 'identifier' as const,
    editable: true,
    text: 'site',
    span: refSpan,
    ...extra,
  });
  const tree: TreeNode = {
    id: 'App',
    path: '',
    fqn: 'aws-cdk-lib.App',
    children: [
      {
        id: 'Api',
        path: 'Api',
        fqn: 'aws-cdk-lib.Stack',
        children: [
          { id: 'Jobs', path: 'Api/Jobs', fqn: 'aws-cdk-lib.aws_sqs.Queue', children: [] },
          {
            id: 'Site',
            path: 'Api/Site',
            fqn: 'aws-cdk-lib.aws_s3.Bucket',
            children: [
              { id: 'Resource', path: 'Api/Site/Resource', fqn: 'aws-cdk-lib.aws_s3.CfnBucket', children: [] },
            ],
          },
        ],
      },
    ],
  };
  const edgeFacts = (references: NonNullable<Facts['references']>): Facts => ({
    nodes: {
      Api: facts.nodes.Api!,
      'Api/Jobs': facts.nodes['Api/Jobs']!,
      'Api/Site': { span: span(20), className: 's3.Bucket', literalId: 'Site', pathsOnSpan: 1, binding: 'const' },
    },
    references,
  });
  const edges = (references: NonNullable<Facts['references']>, changed: ReadonlySet<string> = new Set()) =>
    buildView(edgeFacts(references), { ...assembly, tree, stacks: [{ path: 'Api' }] }, emptySidecar(), changed).edges;

  it('draws a Reference as an edge from the Node that holds it to the Node it points at, with where the code writes it', () => {
    expect(edges([reference()])).toEqual([
      {
        id: 'Api/Jobs->Api/Site:bucket',
        kind: 'reference',
        from: 'Api/Jobs',
        to: 'Api/Site',
        prop: 'bucket',
        text: 'site',
        source: { file: 'lib/a.ts', line: 12, col: 30 },
      },
    ]);
  });

  it('numbers the edges of an array prop, and says why a read-only one is', () => {
    const [first, second] = edges([
      reference({ index: 0 }),
      reference({ index: 1, form: 'call', editable: false, reason: 'Passed through a call' }),
    ]);
    expect(first).toMatchObject({ id: 'Api/Jobs->Api/Site:bucket[0]', index: 0 });
    expect(first).not.toHaveProperty('readOnly');
    expect(second).toMatchObject({ index: 1, readOnly: 'Passed through a call' });
  });

  it('draws a Reference to something inside a Node to the Node', () => {
    expect(edges([reference({ to: 'Api/Site/Resource' })])).toMatchObject([{ to: 'Api/Site' }]);
  });

  it('leaves out a Reference whose end is not a Node on screen, or that points at its own Node', () => {
    expect(edges([reference({ to: 'Elsewhere/Thing' }), reference({ to: 'Api/Jobs/Child' })])).toEqual([]);
  });

  it('marks the edges of a Node the Draft changes', () => {
    expect(edges([reference()], new Set(['Api/Jobs']))[0]).toMatchObject({ changed: true });
    expect(edges([reference()], new Set(['Api/Site']))[0]).not.toHaveProperty('changed');
  });

  it('says the arrow runs the other way for a prop the Overlay marks as flowing in', () => {
    const view = buildView(
      edgeFacts([reference({ prop: 'role' }), reference({ prop: 'vpc' })]),
      { ...assembly, tree, stacks: [{ path: 'Api' }] },
      emptySidecar(),
      new Set(),
      new Set(),
      (fqn, prop) => fqn === 'aws-cdk-lib.aws_sqs.Queue' && prop === 'role',
    );
    expect(view.edges.map((e) => [e.prop, e.flow])).toEqual([
      ['role', 'in'],
      ['vpc', undefined],
    ]);
  });

  it('has none for an app without References', () => {
    expect(buildView(facts, assembly, emptySidecar()).edges).toEqual([]);
  });
});

describe('buildView with synth effects', () => {
  const end = (path: string) => ({ paths: [path], text: `{${path}}` });
  const withEffects: Assembly = {
    ...assembly,
    effects: [
      {
        kind: 'integration',
        at: 'Api/Jobs/Resource',
        source: end('Api/Jobs/Resource'),
        target: end('Web/Site/Resource'),
        detail: 'subscription (https)',
      },
      {
        kind: 'grant',
        at: 'Api/Jobs/Policy',
        source: end('Api/Jobs/Resource'),
        target: { paths: [], text: '*' },
        detail: 'sqs:*',
      },
    ],
    importRefs: [{ from: 'Web/Site/Resource', to: 'Api/Jobs/Resource', prop: 'Tags' }],
  };
  const view = buildView(facts, withEffects, emptySidecar());

  it('draws an Integration between the Nodes the ends roll up to, and a read-only Reference across Stacks', () => {
    expect(view.edges.map((e) => [e.kind, e.from, e.to, e.readOnly !== undefined])).toEqual([
      ['integration', 'Api/Jobs', 'Web/Site', true],
      ['reference', 'Web/Site', 'Api/Jobs', true],
    ]);
  });

  it('lists an effect with no Node at its other end on the Node, not as an edge', () => {
    expect(view.nodes.find((n) => n.id === 'Api/Jobs')!.otherPermissions).toEqual([
      { detail: 'sqs:*', summary: 'sqs:* · Jobs → *', at: 'Api/Jobs/Policy' },
    ]);
    expect(view.nodes.find((n) => n.id === 'Web/Site')!.otherPermissions).toBeUndefined();
  });
});
