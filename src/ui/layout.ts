import dagre from '@dagrejs/dagre';
import type { StackBoxView, View } from '../core/view.ts';

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 64;
export const STACK_PADDING = 24;
export const STACK_HEADER = 52;
const STACK_GAP = 48;

export interface StackLayout {
  id: string;
  /** The Stack this one is nested in; its box lies inside that one. */
  parentId?: string;
  /** Canvas coordinates, for a nested box too. */
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
  /** A parent comes before the Stacks nested in it. */
  stacks: StackLayout[];
  nodes: NodeLayout[];
}

/**
 * Places every Node, then wraps each Stack box around its Nodes and the boxes nested in it. A Node the
 * Sidecar has a position for sits exactly there (canvas coordinates); the others are laid out with dagre
 * inside their Stack's slot, and the nested boxes go to the right of them, side by side. Top-level
 * Stacks go side by side, each starting clear of the one before.
 */
export function layoutView(view: View): Layout {
  const boxes = new Map<string, StackLayout>();
  const nodes: NodeLayout[] = [];

  /** Lays out `stack` and everything nested in it, with its box meant to start at `(x, y)`. */
  const placeStack = (stack: StackBoxView, x: number, y: number): StackLayout => {
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
      return { id: n.id, x: x + STACK_PADDING + p.x - NODE_WIDTH / 2, y: y + STACK_HEADER + p.y - NODE_HEIGHT / 2 };
    });

    let childX = placed.length > 0 ? Math.max(...placed.map((p) => p.x)) + NODE_WIDTH + STACK_GAP : x + STACK_PADDING;
    const children = view.stacks
      .filter((s) => s.parentId === stack.id)
      .map((child) => {
        const box = placeStack(child, childX, y + STACK_HEADER);
        childX = box.x + box.width + STACK_GAP;
        return box;
      });

    const lefts = [...placed.map((p) => p.x), ...children.map((c) => c.x)];
    const tops = [...placed.map((p) => p.y), ...children.map((c) => c.y)];
    const rights = [...placed.map((p) => p.x + NODE_WIDTH), ...children.map((c) => c.x + c.width)];
    const bottoms = [...placed.map((p) => p.y + NODE_HEIGHT), ...children.map((c) => c.y + c.height)];
    let box: StackLayout;
    if (lefts.length === 0) {
      box = { id: stack.id, x, y, width: NODE_WIDTH + STACK_PADDING * 2, height: NODE_HEIGHT + STACK_HEADER + STACK_PADDING };
    } else {
      const minX = Math.min(...lefts);
      const minY = Math.min(...tops);
      box = {
        id: stack.id,
        x: minX - STACK_PADDING,
        y: minY - STACK_HEADER,
        width: Math.max(...rights) - minX + STACK_PADDING * 2,
        height: Math.max(...bottoms) - minY + STACK_HEADER + STACK_PADDING,
      };
    }
    if (stack.parentId) box.parentId = stack.parentId;
    boxes.set(stack.id, box);
    for (const p of placed) nodes.push({ id: p.id, x: p.x - box.x, y: p.y - box.y });
    return box;
  };

  let cursor = 0;
  for (const stack of view.stacks) {
    if (stack.parentId) continue;
    const box = placeStack(stack, cursor, 0);
    cursor = Math.max(cursor, box.x + box.width) + STACK_GAP;
  }
  return { stacks: view.stacks.flatMap((s) => boxes.get(s.id) ?? []), nodes };
}
