import type { Assembly, EditorRequest, SynthError, TreeNode } from './assembly.ts';
import type { Facts } from './facts.ts';
import type { Point, Sidecar } from './sidecar.ts';

/** A Stack drawn as a group box. */
export interface StackBoxView {
  id: string;
  label: string;
  /** `us-east-1 · 123456789012`, or `env-agnostic`. */
  env: string;
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
  source: { file: string; line: number; col: number };
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
  stacks: StackBoxView[];
  nodes: NodeView[];
}

/** The part of a View that is derived from the app. */
export type ViewBody = Pick<View, 'stacks' | 'nodes'>;

const GENERIC_ICON = 'generic';

function envLabel(env: string | undefined): string {
  const m = env && /^aws:\/\/([^/]+)\/(.+)$/.exec(env);
  return m ? `${m[2]} · ${m[1]}` : 'env-agnostic';
}

/** Projects what the source says plus what synth produced into the view the canvas draws. */
export function buildView(facts: Facts, assembly: Assembly, sidecar: Sidecar): ViewBody {
  const stacks: StackBoxView[] = assembly.stacks.map((s) => ({
    id: s.path,
    label: s.path.split('/').at(-1) ?? s.path,
    env: envLabel(s.env),
  }));
  const stackPaths = new Set(stacks.map((s) => s.id));

  const nodes: NodeView[] = [];
  const visit = (tree: TreeNode, stackId: string | undefined, insideNode: boolean) => {
    const isStack = stackPaths.has(tree.path);
    const nodeFacts = facts.nodes[tree.path];
    if (isStack) stackId = tree.path;
    else if (stackId && nodeFacts && !insideNode) {
      const saved = sidecar.nodes[tree.path];
      nodes.push({
        id: tree.path,
        stackId,
        label: nodeFacts.literalId ?? tree.id,
        subtitle: nodeFacts.className.split('.').at(-1) ?? nodeFacts.className,
        fqn: tree.fqn,
        icon: GENERIC_ICON,
        source: { file: nodeFacts.span.file, line: nodeFacts.span.start.line, col: nodeFacts.span.start.col },
        ...(saved?.position ? { position: saved.position } : {}),
        ...(saved?.note ? { note: saved.note } : {}),
      });
      insideNode = true;
    }
    for (const child of tree.children) visit(child, stackId, insideNode);
  };
  visit(assembly.tree, undefined, false);

  return { stacks, nodes };
}

/** What the browser sends: the only message there is. */
export interface OpenInEditorMessage extends EditorRequest {
  type: 'open-in-editor';
}
