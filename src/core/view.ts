import type { FileDiff } from './diff.ts';
import type { Assembly, EditorRequest, ResourceRef, SynthError, TreeNode } from './assembly.ts';
import { nodeEditability } from './editability.ts';
import type { Facts, NodeFacts } from './facts.ts';
import { iconFor } from './icons.ts';
import { serviceName } from './services.ts';
import { isStackPlumbing, NESTED_STACK_FQN, STAGE_FQN, withoutNestedStackPlumbing } from './tree.ts';
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
  /** The Draft changes this Stack's code. */
  changed?: true;
}

/** A Stage, which the canvas shows one at a time. */
export interface StageView {
  /** The Stage's construct path. */
  id: string;
  label: string;
}

/** One construct beneath a Node, as its Computed Layer shows it. Read-only: it is only what the app's synth produced. */
export interface LayerChildView {
  /** The construct path. */
  id: string;
  /** The Node, or the other child, this one sits in. */
  parentId: string;
  label: string;
  fqn: string;
  icon: string;
  /** CloudFormation type, on L1 resources. */
  cfnType?: string;
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
  /**
   * The Node is a construct created outside the subtree of every Node, such as a default VPC or a
   * singleton provider, drawn at Stack scope. It is always read-only.
   */
  hoisted?: true;
  /** For a hoisted Node, the Nodes whose resources point at it, directly or through other hoisted Nodes. */
  causedBy?: string[];
  /** The Node's Computed Layer: everything beneath it in the synthesized tree, parents before their children. Absent for a Node with nothing beneath it. */
  children?: LayerChildView[];
  /** Where in the app's code the Node comes from. For a hoisted Node, the code of the first Node that caused it, if any. */
  source?: { file: string; line: number; col: number };
  /** Why Truss can't edit this Node, when it can't. Absent means editable. */
  lock?: string;
  /** Where the Sidecar says this Node sits on the canvas. Absent: the canvas lays it out. */
  position?: Point;
  /** The note the Sidecar holds for this Node. */
  note?: string;
  /** The Draft changes this Node's code, so the Node shows as changed. */
  changed?: true;
}

/**
 * A synth error, or (`kind: 'sidecar'`) a `truss.json` that is invalid or from a newer Truss. `kind: 'draft'`
 * is a synth error the Draft causes: the canvas shows the last good Design, and the Draft can still be undone.
 */
export type ViewError = SynthError & { kind?: 'sidecar' | 'draft' };

/** One edit of the Draft, as the list shows it. */
export interface DraftItemView {
  /** The construct path. */
  id: string;
  label: string;
  /** What the edit does, e.g. `versioned → true`. */
  summary: string;
}

/** The Draft (CONTEXT.md): the canvas edits not yet saved, and what Save would write. */
export interface DraftView {
  items: DraftItemView[];
  canUndo: boolean;
  canRedo: boolean;
  /** The exact per-file diff Save will write. */
  diffs: FileDiff[];
  /** Why Save is blocked, when it is: the Problems the Draft introduces. */
  problems: string[];
  /** Edits dropped because the code changed under them, and why. */
  notices: string[];
}

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
  /** Absent when there is nothing in the Draft and nothing to say about it. */
  draft?: DraftView;
  /** Why no edit can be made to the Draft, when that is so: the app can't be synthed with a Draft applied (ADR 0007). */
  draftBlocked?: string;
}

/** The part of a View that is derived from the app. */
export type ViewBody = Pick<View, 'stages' | 'stacks' | 'nodes'>;

function envLabel(env: string | undefined): string {
  const m = env && /^aws:\/\/([^/]+)\/(.+)$/.exec(env);
  return m ? `${m[2]} · ${m[1]}` : 'env-agnostic';
}

const lastSegment = (s: string) => s.split(/[./]/).at(-1) ?? s;

/** `aws-cdk-lib.aws_s3.Bucket` as "S3 Bucket"; undefined for a type with no service name to give, such as `constructs.Construct`. */
function typeLabel(fqn: string): string | undefined {
  const m = /\.aws_([a-z0-9_]+)\.([A-Za-z0-9]+)$/.exec(fqn);
  if (!m) return undefined;
  const name = serviceName(m[1]!);
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

/** Every construct beneath `tree`, parents before their children, leaving out the Stacks (they are boxes, not children). */
function layerOf(tree: TreeNode, envs: ReadonlyMap<string, unknown>): LayerChildView[] {
  const out: LayerChildView[] = [];
  const walk = (parent: TreeNode) => {
    for (const child of withoutNestedStackPlumbing(parent.children)) {
      if (envs.has(child.path) || child.fqn === NESTED_STACK_FQN) continue;
      out.push({
        id: child.path,
        parentId: parent.path,
        label: child.id,
        fqn: child.fqn,
        icon: iconFor(child.fqn),
        ...(child.cfnType ? { cfnType: child.cfnType } : {}),
      });
      walk(child);
    }
  };
  walk(tree);
  return out;
}

/**
 * For each hoisted Node, the Nodes that caused it: those from which a reference between resources leads to it,
 * possibly through other hoisted Nodes (a default Cluster needs a default Vpc). A hoisted Node no Node
 * leads to is tied to the Nodes it points at instead, as a policy attached to a Node is. Order follows `nodes`.
 */
function causes(nodes: readonly NodeView[], refs: readonly ResourceRef[]): Map<string, string[]> {
  const units = new Set(nodes.map((n) => n.id));
  /** The Node or hoisted Node a construct path lies in. */
  const unitOf = (path: string): string | undefined => {
    for (let at = path.length; at > 0; at = path.lastIndexOf('/', at - 1)) {
      const prefix = path.slice(0, at);
      if (units.has(prefix)) return prefix;
    }
    return undefined;
  };
  const hoisted = new Set(nodes.filter((n) => n.hoisted).map((n) => n.id));
  const pointsAt = new Map<string, Set<string>>();
  const attachedTo = new Map<string, Set<string>>();
  for (const { from, to } of refs) {
    const a = unitOf(from);
    const b = unitOf(to);
    if (a === undefined || b === undefined || a === b) continue;
    if (hoisted.has(b)) (pointsAt.get(a) ?? pointsAt.set(a, new Set()).get(a)!).add(b);
    else if (hoisted.has(a)) (attachedTo.get(a) ?? attachedTo.set(a, new Set()).get(a)!).add(b);
  }
  const causedBy = new Map<string, string[]>();
  for (const origin of nodes) {
    if (origin.hoisted) continue;
    const seen = new Set<string>();
    const reach = (from: string) => {
      for (const to of pointsAt.get(from) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        reach(to);
      }
    };
    reach(origin.id);
    for (const id of seen) (causedBy.get(id) ?? causedBy.set(id, []).get(id)!).push(origin.id);
  }
  for (const [id, nodeIds] of attachedTo) if (!causedBy.has(id)) causedBy.set(id, [...nodeIds]);
  return causedBy;
}

/** Projects what the source says plus what synth produced into the view the canvas draws. */
export function buildView(facts: Facts, assembly: Assembly, sidecar: Sidecar, changed: ReadonlySet<string> = new Set()): ViewBody {
  const envs = new Map(assembly.stacks.map((s) => [s.path, s.env]));
  const stages: StageView[] = [];
  const stacks: StackBoxView[] = [];
  const nodes: NodeView[] = [];

  const visit = (tree: TreeNode, stack: StackBoxView | undefined, stageId: string | undefined, insideNode: boolean, atStackScope: boolean) => {
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
        ...(changed.has(tree.path) ? { changed: true as const } : {}),
      };
      stacks.push(stack);
    } else if (stack && nodeFacts && !insideNode) {
      const saved = sidecar.nodes[tree.path];
      const editability = nodeEditability(tree.path, nodeFacts);
      const children = layerOf(tree, envs);
      nodes.push({
        id: tree.path,
        stackId: stack.id,
        label: nodeFacts.literalId ?? tree.id,
        subtitle: subtitleOf(nodeFacts, tree.fqn),
        fqn: tree.fqn,
        icon: iconFor(tree.fqn),
        ...(nodeFacts.external ? { external: true as const } : {}),
        source: { file: nodeFacts.span.file, line: nodeFacts.span.start.line, col: nodeFacts.span.start.col },
        ...(editability.editable ? {} : { lock: editability.reason }),
        ...(changed.has(tree.path) ? { changed: true as const } : {}),
        ...(saved?.position ? { position: saved.position } : {}),
        ...(saved?.note ? { note: saved.note } : {}),
        ...(children.length > 0 ? { children } : {}),
      });
      insideNode = true;
    } else if (stack && atStackScope && !insideNode && !isStackPlumbing(tree)) {
      // Something at Stack scope that no `new` of the app made directly: a construct another one created for itself.
      const saved = sidecar.nodes[tree.path];
      const children = layerOf(tree, envs);
      nodes.push({
        id: tree.path,
        stackId: stack.id,
        label: tree.id,
        subtitle: lastSegment(tree.fqn),
        fqn: tree.fqn,
        icon: iconFor(tree.fqn),
        hoisted: true,
        // `lock` and the link to the Node that caused it are set once every Node is known.
        lock: '',
        ...(saved?.position ? { position: saved.position } : {}),
        ...(saved?.note ? { note: saved.note } : {}),
        ...(children.length > 0 ? { children } : {}),
      });
      insideNode = true;
    }
    for (const child of withoutNestedStackPlumbing(tree.children)) visit(child, stack, stageId, insideNode, isStack);
  };
  visit(assembly.tree, undefined, undefined, false, false);

  const causedBy = causes(nodes, assembly.resourceRefs);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    if (!node.hoisted) continue;
    const causers = causedBy.get(node.id) ?? [];
    if (causers.length === 0) {
      node.lock = 'Created by the library outside the subtree of any construct Truss can place';
      continue;
    }
    node.causedBy = causers;
    const names = causers.map((id) => byId.get(id)!.label).join(', ');
    node.lock = `Created by the library for ${names}, outside its own subtree`;
    const source = byId.get(causers[0]!)?.source;
    if (source) node.source = source;
  }

  return { stages, stacks, nodes };
}

/** What the browser sends: the only message there is. */
export interface OpenInEditorMessage extends EditorRequest {
  type: 'open-in-editor';
}
