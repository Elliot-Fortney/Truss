import type { Assembly, EditorRequest, SynthError, TreeNode } from './assembly.ts';
import { nodeEditability } from './editability.ts';
import type { Facts, NodeFacts } from './facts.ts';
import { NESTED_STACK_FQN, STAGE_FQN, withoutNestedStackPlumbing } from './tree.ts';
import type { Point, Sidecar } from './sidecar.ts';

/** A Stack drawn as a group box. */
export interface StackBoxView {
  id: string;
  label: string;
  /** `us-east-1 · 123456789012`, or `env-agnostic`. */
  env: string;
  /** The Stack this one is nested in, which draws it as a box inside its own. */
  parentId?: string;
  /** The Stage the Stack belongs to. Absent for a Stack outside every Stage, which is always shown. */
  stageId?: string;
}

/** A Stage, which the canvas shows one at a time. */
export interface StageView {
  /** The Stage's construct path. */
  id: string;
  label: string;
}

export interface NodeView {
  /** The construct path, which is the Node's identity. */
  id: string;
  /** Path of the Stack box that holds this Node. */
  stackId: string;
  label: string;
  /** The class as written in the app's code, e.g. `Bucket`. */
  subtitle: string;
  fqn: string;
  icon: string;
  /** The Node is a `fromXxx` resource the app refers to but doesn't create. */
  external?: true;
  source: { file: string; line: number; col: number };
  /** Why Truss can't edit this Node, when it can't. Absent means editable. */
  lock?: string;
  /** Where the Sidecar says this Node sits on the canvas. Absent: the canvas lays it out. */
  position?: Point;
  /** The note the Sidecar holds for this Node. */
  note?: string;
}

/** A synth error, or (`kind: 'sidecar'`) a `truss.json` that is invalid or from a newer Truss. */
export type ViewError = SynthError & { kind?: 'sidecar' };

/** Everything the browser draws. The server pushes the whole of it, tagged with a version. */
export interface View {
  version: number;
  /** True while a synth is running, so the Design may be out of date. */
  synthing: boolean;
  /**
   * The error from the latest synth, or a Sidecar Truss refuses to use. With `hasDesign` false there
   * is nothing to show but the error; with it true the Design below is the last good one, and the
   * canvas is dimmed under a banner.
   */
  error?: ViewError;
  /** True once a synth has succeeded, so `stacks` and `nodes` are a Design rather than empty. */
  hasDesign: boolean;
  /** In the order the app creates them. Empty for an app without Stages, which has no picker. */
  stages: StageView[];
  /** Parents come before the Stacks nested in them. */
  stacks: StackBoxView[];
  nodes: NodeView[];
}

/** The part of a View that is derived from the app. */
export type ViewBody = Pick<View, 'stages' | 'stacks' | 'nodes'>;

const GENERIC_ICON = 'generic';

function envLabel(env: string | undefined): string {
  const m = env && /^aws:\/\/([^/]+)\/(.+)$/.exec(env);
  return m ? `${m[2]} · ${m[1]}` : 'env-agnostic';
}

const lastSegment = (s: string) => s.split(/[./]/).at(-1) ?? s;

/** How an AWS service is written, where capitalising its module name wouldn't do. */
const SERVICE_NAMES: Record<string, string> = {
  apigateway: 'API Gateway',
  apigatewayv2: 'API Gateway',
  cloudfront: 'CloudFront',
  dynamodb: 'DynamoDB',
  ec2: 'EC2',
  ecs: 'ECS',
  efs: 'EFS',
  eks: 'EKS',
  events: 'EventBridge',
  iam: 'IAM',
  kms: 'KMS',
  lambda: 'Lambda',
  rds: 'RDS',
  s3: 'S3',
  secretsmanager: 'Secrets Manager',
  sns: 'SNS',
  sqs: 'SQS',
  stepfunctions: 'Step Functions',
};

/** `aws-cdk-lib.aws_s3.Bucket` as "S3 Bucket"; undefined for a type with no service name to give, such as `constructs.Construct`. */
function typeLabel(fqn: string): string | undefined {
  const m = /\.aws_([a-z0-9_]+)\.([A-Za-z0-9]+)$/.exec(fqn);
  if (!m) return undefined;
  const service = m[1]!;
  // A module of several words (`ecs_patterns`) can't be turned into a service name by capitalising it.
  const name = SERVICE_NAMES[service] ?? (/^[a-z0-9]+$/.test(service) ? service[0]!.toUpperCase() + service.slice(1) : undefined);
  return name ? `${name} ${m[2]}` : undefined;
}

/** The line under a Node's name: the class as written and, for a class of the app's own, the type it builds on. */
function subtitleOf(facts: NodeFacts, fqn: string): string {
  if (facts.external) return facts.className.split('.').slice(-2).join('.');
  const written = lastSegment(facts.className);
  if (written === lastSegment(fqn)) return written;
  const base = typeLabel(fqn);
  return base ? `${written} · ${base}` : written;
}

/** Projects what the source says plus what synth produced into the view the canvas draws. */
export function buildView(facts: Facts, assembly: Assembly, sidecar: Sidecar): ViewBody {
  const envs = new Map(assembly.stacks.map((s) => [s.path, s.env]));
  const stages: StageView[] = [];
  const stacks: StackBoxView[] = [];
  const nodes: NodeView[] = [];

  const visit = (tree: TreeNode, stack: StackBoxView | undefined, stageId: string | undefined, insideNode: boolean) => {
    if (tree.fqn === STAGE_FQN && stageId === undefined) {
      // A Stage inside a Stage is part of the outer one: the canvas has one picker, not a tree of them.
      stages.push({ id: tree.path, label: tree.id });
      stageId = tree.path;
    }
    const isStack = envs.has(tree.path) || tree.fqn === NESTED_STACK_FQN;
    const nodeFacts = facts.nodes[tree.path];
    if (isStack) {
      // A nested stack is not in the manifest, and lives where its parent does.
      const env = envs.has(tree.path) ? envs.get(tree.path) : envs.get(stack?.id ?? '');
      stack = {
        id: tree.path,
        label: tree.id,
        env: envLabel(env),
        ...(stack ? { parentId: stack.id } : {}),
        ...(stageId ? { stageId } : {}),
      };
      stacks.push(stack);
    } else if (stack && nodeFacts && !insideNode) {
      const saved = sidecar.nodes[tree.path];
      const editability = nodeEditability(tree.path, nodeFacts);
      nodes.push({
        id: tree.path,
        stackId: stack.id,
        label: nodeFacts.literalId ?? tree.id,
        subtitle: subtitleOf(nodeFacts, tree.fqn),
        fqn: tree.fqn,
        icon: GENERIC_ICON,
        ...(nodeFacts.external ? { external: true as const } : {}),
        source: { file: nodeFacts.span.file, line: nodeFacts.span.start.line, col: nodeFacts.span.start.col },
        ...(editability.editable ? {} : { lock: editability.reason }),
        ...(saved?.position ? { position: saved.position } : {}),
        ...(saved?.note ? { note: saved.note } : {}),
      });
      insideNode = true;
    }
    for (const child of withoutNestedStackPlumbing(tree.children)) visit(child, stack, stageId, insideNode);
  };
  visit(assembly.tree, undefined, undefined, false);

  return { stages, stacks, nodes };
}

/** What the browser sends: the only message there is. */
export interface OpenInEditorMessage extends EditorRequest {
  type: 'open-in-editor';
}
