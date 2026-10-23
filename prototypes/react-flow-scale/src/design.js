// PROTOTYPE (throwaway, ticket #15): a synthetic, CDK-shaped Design.
// Seeded so every run builds the same tree. Subtrees mimic real construct
// trees: an L3 Fargate service (~30 constructs), L2s with a few L1 children.

function rng(seed) {
  return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const R = ['Resource', 'L1'];
const role = (id) => [id, 'L2', [R, ['DefaultPolicy', 'L2', [R]]]];
const sg = ['SecurityGroup', 'L2', [R]];
const subnet = (id) => [id, 'L2', [['Subnet', 'L1'], ['RouteTable', 'L1'], ['RouteTableAssociation', 'L1'], ['DefaultRoute', 'L1']]];

const TEMPLATES = {
  fargate: ['aws-ecs-patterns.ApplicationLoadBalancedFargateService', 'L3', [
    ['LB', 'L2', [R, sg, ['PublicListener', 'L2', [R, ['ECSGroup', 'L2', [R]]]]]],
    ['TaskDef', 'L2', [R, role('TaskRole'), role('ExecutionRole'), ['web', 'L2', [['LogGroup', 'L2', [R]]]]]],
    ['Service', 'L2', [['Service', 'L1'], sg]],
    ['Cluster', 'L2', [R]],
  ]],
  vpc: ['aws-ec2.Vpc', 'L2', [R, subnet('PublicSubnet1'), subnet('PublicSubnet2'), subnet('PrivateSubnet1'), subnet('PrivateSubnet2'), ['IGW', 'L1'], ['VPCGW', 'L1']]],
  fn: ['aws-lambda.Function', 'L2', [role('ServiceRole'), R]],
  bucket: ['aws-s3.Bucket', 'L2', [R, ['Policy', 'L2', [R]]]],
  queue: ['aws-sqs.Queue', 'L2', [R]],
  table: ['aws-dynamodb.Table', 'L2', [R]],
  topic: ['aws-sns.Topic', 'L2', [R]],
  cfn: ['aws-ssm.CfnParameter', 'L1', []],
};

// Roughly what a big real app looks like: mostly L2s, a few L3s and VPCs.
const MIX = [
  ['fargate', 0.1], ['vpc', 0.02], ['fn', 0.35], ['bucket', 0.12],
  ['queue', 0.15], ['table', 0.08], ['topic', 0.08], ['cfn', 0.1],
];

function build(path, [fqnOrId, tier, kids = []], fqn) {
  const node = { id: path, label: path.split('/').pop(), fqn: fqn ?? fqnOrId, tier, children: [] };
  for (const kid of kids) node.children.push(build(`${path}/${kid[0]}`, kid, `${tier === 'L3' ? 'L2' : 'L1'}:${kid[0]}`));
  return node;
}

export function makeDesign({ nodes = 500, stacks = 6, edges = 600, seed = 1 } = {}) {
  const rand = rng(seed);
  const pick = () => {
    let r = rand();
    for (const [k, p] of MIX) if ((r -= p) <= 0) return k;
    return 'fn';
  };
  const design = { stacks: [], edges: [] };
  const top = [];
  for (let s = 0; s < stacks; s++) design.stacks.push({ id: `Stack${s}`, children: [] });
  for (let i = 0; i < nodes; i++) {
    const stack = design.stacks[i % stacks];
    const kind = pick();
    const t = TEMPLATES[kind];
    const node = build(`${stack.id}/${kind[0].toUpperCase()}${kind.slice(1)}${i}`, t, t[0]);
    stack.children.push(node);
    top.push(node);
  }
  const kinds = ['reference', 'grant', 'integration', 'network'];
  for (let i = 0; i < edges; i++) {
    const a = top[Math.floor(rand() * top.length)];
    // Most Connections stay inside one Stack, like real apps.
    const sameStack = rand() < 0.85;
    const pool = sameStack ? design.stacks[top.indexOf(a) % stacks].children : top;
    const b = pool[Math.floor(rand() * pool.length)];
    if (a !== b) design.edges.push({ id: `e${i}`, source: a.id, target: b.id, kind: kinds[i % 4] });
  }
  return design;
}

export function countConstructs(design) {
  let n = 0;
  const walk = (x) => { n++; x.children.forEach(walk); };
  design.stacks.forEach((s) => s.children.forEach(walk));
  return n;
}

export function allIds(design, pred = () => true) {
  const out = [];
  const walk = (x) => { if (pred(x)) out.push(x.id); x.children.forEach(walk); };
  design.stacks.forEach((s) => s.children.forEach(walk));
  return out;
}
