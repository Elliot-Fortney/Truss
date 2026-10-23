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

/**
 * Places every Node, then wraps each Stack box around its Nodes. A Node the Sidecar has a position for sits
 * exactly there (canvas coordinates); the others are laid out with dagre inside their Stack's slot.
 * Stacks go side by side, each starting clear of the one before.
 */
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

    // Canvas coordinates of each member's top-left corner.
    const placed = members.map((n) => {
      if (n.position) return { id: n.id, x: n.position.x, y: n.position.y };
      const p = g.node(n.id); // dagre positions by centre
      return { id: n.id, x: cursor + STACK_PADDING + p.x - NODE_WIDTH / 2, y: STACK_HEADER + p.y - NODE_HEIGHT / 2 };
    });

    let box: StackLayout;
    if (placed.length === 0) {
      box = { id: stack.id, x: cursor, y: 0, width: NODE_WIDTH + STACK_PADDING * 2, height: NODE_HEIGHT + STACK_HEADER + STACK_PADDING };
    } else {
      const minX = Math.min(...placed.map((p) => p.x));
      const minY = Math.min(...placed.map((p) => p.y));
      const maxX = Math.max(...placed.map((p) => p.x)) + NODE_WIDTH;
      const maxY = Math.max(...placed.map((p) => p.y)) + NODE_HEIGHT;
      box = {
        id: stack.id,
        x: minX - STACK_PADDING,
        y: minY - STACK_HEADER,
        width: maxX - minX + STACK_PADDING * 2,
        height: maxY - minY + STACK_HEADER + STACK_PADDING,
      };
    }
    stacks.push(box);
    for (const p of placed) nodes.push({ id: p.id, x: p.x - box.x, y: p.y - box.y });
    cursor = Math.max(cursor, box.x + box.width) + STACK_GAP;
  }
  return { stacks, nodes };
}
