import dagre from '@dagrejs/dagre';
import type { View } from '../core/view.ts';

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 64;
export const STACK_PADDING = 24;
export const STACK_HEADER = 52;
const STACK_GAP = 48;

export interface StackLayout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NodeLayout {
  id: string;
  /** Relative to the top-left of its Stack box. */
  x: number;
  y: number;
}

export interface Layout {
  stacks: StackLayout[];
  nodes: NodeLayout[];
}

/** Lays Nodes out with dagre inside each Stack box, then sets the boxes side by side. */
export function layoutView(view: View): Layout {
  const stacks: StackLayout[] = [];
  const nodes: NodeLayout[] = [];
  let cursor = 0;

  for (const stack of view.stacks) {
    const members = view.nodes.filter((n) => n.stackId === stack.id);
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 48, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of members) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    dagre.layout(g);

    let innerWidth = NODE_WIDTH;
    let innerHeight = NODE_HEIGHT;
    for (const n of members) {
      const p = g.node(n.id);
      // dagre positions by centre.
      const x = p.x - NODE_WIDTH / 2;
      const y = p.y - NODE_HEIGHT / 2;
      nodes.push({ id: n.id, x: x + STACK_PADDING, y: y + STACK_HEADER });
      innerWidth = Math.max(innerWidth, x + NODE_WIDTH);
      innerHeight = Math.max(innerHeight, y + NODE_HEIGHT);
    }
    const width = innerWidth + STACK_PADDING * 2;
    const height = innerHeight + STACK_HEADER + STACK_PADDING;
    stacks.push({ id: stack.id, x: cursor, y: 0, width, height });
    cursor += width + STACK_GAP;
  }
  return { stacks, nodes };
}
