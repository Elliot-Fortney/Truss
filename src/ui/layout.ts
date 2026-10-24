import dagre from '@dagrejs/dagre';
import type { LayerChildView, NodeView, StackBoxView, View } from '../core/view.ts';

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 64;
export const STACK_PADDING = 24;
export const STACK_HEADER = 52;
const STACK_GAP = 48;
/** A construct in an expanded Node's Layer, drawn smaller than a Node. */
export const LAYER_WIDTH = 168;
export const LAYER_HEIGHT = 48;
/** An expanded Node is a box: its own header, then its children inside it. */
export const LAYER_HEADER = 56;
export const LAYER_PADDING = 12;
const LAYER_GAP = 12;

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
  /** `NODE_WIDTH` by `NODE_HEIGHT`, unless the Node is expanded and wraps its Layer. */
  width: number;
  height: number;
}

export interface LayerLayout {
  id: string;
  /** The expanded Node, or expanded child, this one sits in. */
  parentId: string;
  /** Relative to the top-left of the parent. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  /** A parent comes before the Stacks nested in it. */
  stacks: StackLayout[];
  nodes: NodeLayout[];
  /** The children of every expanded Node, parents before their children. */
  layers: LayerLayout[];
}

interface Laid {
  width: number;
  height: number;
  /** Everything inside the box, positioned relative to its parent, parents before their children. */
  layers: LayerLayout[];
}

/** Lays out the children of `parentId` with dagre, descending into those that are expanded, and returns the box that wraps them. */
function layOutLayer(parentId: string, children: readonly LayerChildView[], expanded: ReadonlySet<string>): Laid {
  const byParent = new Map<string, LayerChildView[]>();
  for (const c of children) (byParent.get(c.parentId) ?? byParent.set(c.parentId, []).get(c.parentId)!).push(c);

  const lay = (id: string): Laid => {
    const kids = byParent.get(id) ?? [];
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: LAYER_GAP, ranksep: LAYER_GAP * 2, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    const inside = new Map<string, Laid>();
    for (const k of kids) {
      const open = expanded.has(k.id) && byParent.has(k.id);
      const laid = open ? lay(k.id) : { width: LAYER_WIDTH, height: LAYER_HEIGHT, layers: [] };
      inside.set(k.id, laid);
      g.setNode(k.id, { width: laid.width, height: laid.height });
    }
    dagre.layout(g);

    const layers: LayerLayout[] = [];
    let right = 0;
    let bottom = 0;
    for (const k of kids) {
      const { width, height, layers: below } = inside.get(k.id)!;
      const p = g.node(k.id); // dagre positions by centre
      const x = p.x - width / 2;
      const y = p.y - height / 2;
      right = Math.max(right, x + width);
      bottom = Math.max(bottom, y + height);
      layers.push({ id: k.id, parentId: id, x: LAYER_PADDING + x, y: LAYER_HEADER + y, width, height }, ...below);
    }
    return {
      width: Math.max(NODE_WIDTH, right + LAYER_PADDING * 2),
      height: LAYER_HEADER + bottom + LAYER_PADDING,
      layers,
    };
  };
  return lay(parentId);
}

/**
 * Places every Node, then wraps each Stack box around its Nodes and the boxes nested in it. A Node the
 * Sidecar has a position for sits exactly there (canvas coordinates); the others are laid out with dagre
 * inside their Stack's slot, and the nested boxes go to the right of them, side by side. Top-level
 * Stacks go side by side, each starting clear of the one before. An expanded Node (one id in `expanded`)
 * grows into a box around its children, which dagre lays out inside it, down to the L1.
 */
export function layoutView(view: View, expanded: ReadonlySet<string> = new Set()): Layout {
  const boxes = new Map<string, StackLayout>();
  const nodes: NodeLayout[] = [];
  const layers: LayerLayout[] = [];

  /** The size a Node is drawn at, and the Layer inside it when it is expanded. */
  const fit = new Map<string, Laid>();
  const sizeOf = (n: NodeView): { width: number; height: number } => {
    if (!n.children?.length || !expanded.has(n.id)) return { width: NODE_WIDTH, height: NODE_HEIGHT };
    const laid = layOutLayer(n.id, n.children, expanded);
    fit.set(n.id, laid);
    return { width: laid.width, height: laid.height };
  };

  /** Lays out `stack` and everything nested in it, with its box meant to start at `(x, y)`. */
  const placeStack = (stack: StackBoxView, x: number, y: number): StackLayout => {
    const members = view.nodes.filter((n) => n.stackId === stack.id);
    const memberSize = new Map(members.map((n) => [n.id, sizeOf(n)]));
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 48, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    // dagre writes the centre into the label it is given, so it gets a copy.
    for (const n of members) g.setNode(n.id, { ...memberSize.get(n.id)! });
    // A hoisted Node goes to the right of the Node that caused it.
    for (const n of members) for (const cause of n.causedBy ?? []) if (g.hasNode(cause)) g.setEdge(cause, n.id);
    // Arrows run left to right: a Node goes to the left of the Node its arrow points at.
    for (const e of view.edges)
      if (g.hasNode(e.from) && g.hasNode(e.to) && e.from !== e.to)
        e.flow === 'in' ? g.setEdge(e.to, e.from) : g.setEdge(e.from, e.to);
    dagre.layout(g);

    // Canvas coordinates of each member's top-left corner.
    const placed = members.map((n) => {
      const size = memberSize.get(n.id)!;
      if (n.position) return { id: n.id, x: n.position.x, y: n.position.y, ...size };
      const p = g.node(n.id); // dagre positions by centre
      return {
        id: n.id,
        x: x + STACK_PADDING + p.x - size.width / 2,
        y: y + STACK_HEADER + p.y - size.height / 2,
        ...size,
      };
    });

    let childX = placed.length > 0 ? Math.max(...placed.map((p) => p.x + p.width)) + STACK_GAP : x + STACK_PADDING;
    const children = view.stacks
      .filter((s) => s.parentId === stack.id)
      .map((child) => {
        const box = placeStack(child, childX, y + STACK_HEADER);
        childX = box.x + box.width + STACK_GAP;
        return box;
      });

    const lefts = [...placed.map((p) => p.x), ...children.map((c) => c.x)];
    const tops = [...placed.map((p) => p.y), ...children.map((c) => c.y)];
    const rights = [...placed.map((p) => p.x + p.width), ...children.map((c) => c.x + c.width)];
    const bottoms = [...placed.map((p) => p.y + p.height), ...children.map((c) => c.y + c.height)];
    let box: StackLayout;
    if (lefts.length === 0) {
      box = {
        id: stack.id,
        x,
        y,
        width: NODE_WIDTH + STACK_PADDING * 2,
        height: NODE_HEIGHT + STACK_HEADER + STACK_PADDING,
      };
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
    for (const p of placed) {
      nodes.push({ id: p.id, x: p.x - box.x, y: p.y - box.y, width: p.width, height: p.height });
      layers.push(...(fit.get(p.id)?.layers ?? []));
    }
    return box;
  };

  let cursor = 0;
  for (const stack of view.stacks) {
    if (stack.parentId) continue;
    const box = placeStack(stack, cursor, 0);
    cursor = Math.max(cursor, box.x + box.width) + STACK_GAP;
  }
  return { stacks: view.stacks.flatMap((s) => boxes.get(s.id) ?? []), nodes, layers };
}
