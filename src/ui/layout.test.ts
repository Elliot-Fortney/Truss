import { describe, expect, it } from 'vitest';
import type { LayerChildView, NodeView, View } from '../core/view.ts';
import {
  LAYER_HEADER,
  LAYER_HEIGHT,
  LAYER_PADDING,
  LAYER_WIDTH,
  layoutView,
  NODE_HEIGHT,
  NODE_WIDTH,
  STACK_HEADER,
  STACK_PADDING,
} from './layout.ts';

const node = (id: string, stackId: string): NodeView => ({
  id,
  stackId,
  label: id,
  subtitle: 'Thing',
  fqn: 'x',
  icon: 'generic',
  source: { file: 'a.ts', line: 1, col: 1 },
});

const view = (nodes: NodeView[], stackIds: string[], nested: Record<string, string> = {}): View => ({
  version: 1,
  synthing: false,
  hasDesign: true,
  stages: [],
  stacks: stackIds.map((id) => ({
    id,
    label: id,
    env: 'env-agnostic',
    ...(nested[id] ? { parentId: nested[id] } : {}),
  })),
  nodes,
  edges: [],
  problems: [],
});

describe('layoutView', () => {
  const layout = layoutView(view([node('A/one', 'A'), node('A/two', 'A'), node('B/three', 'B')], ['A', 'B']));

  it('places every Node inside the box of its Stack', () => {
    for (const n of layout.nodes) {
      const box = layout.stacks.find((s) => s.id === (n.id.startsWith('A') ? 'A' : 'B'))!;
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + NODE_WIDTH).toBeLessThanOrEqual(box.width);
      expect(n.y + NODE_HEIGHT).toBeLessThanOrEqual(box.height);
    }
  });

  it('keeps Nodes in one Stack from overlapping', () => {
    const [a, b] = layout.nodes.filter((n) => n.id.startsWith('A'));
    const apart = Math.abs(a!.x - b!.x) >= NODE_WIDTH || Math.abs(a!.y - b!.y) >= NODE_HEIGHT;
    expect(apart).toBe(true);
  });

  it('keeps Stack boxes from overlapping', () => {
    const [a, b] = layout.stacks;
    const apart =
      a!.x + a!.width <= b!.x || b!.x + b!.width <= a!.x || a!.y + a!.height <= b!.y || b!.y + b!.height <= a!.y;
    expect(apart).toBe(true);
  });

  it('draws an empty Stack as a box', () => {
    const l = layoutView(view([], ['Empty']));
    expect(l.stacks[0]!.width).toBeGreaterThan(0);
    expect(l.stacks[0]!.height).toBeGreaterThan(0);
  });
});

describe('layoutView with References', () => {
  const edge = (from: string, to: string) => ({
    id: `${from}->${to}`,
    kind: 'reference' as const,
    from,
    to,
    prop: 'p',
    text: 'x',
    source: { file: 'a.ts', line: 1, col: 1 },
  });
  const nodes = [node('A/fn', 'A'), node('A/other', 'A'), node('A/vpc', 'A')];
  const laid = layoutView({ ...view(nodes, ['A']), edges: [edge('A/fn', 'A/vpc')] });

  it('puts a Node to the left of the Node it points at, so the arrow runs left to right', () => {
    const [fn, vpc] = ['A/fn', 'A/vpc'].map((id) => laid.nodes.find((n) => n.id === id)!);
    expect(fn!.x + NODE_WIDTH).toBeLessThanOrEqual(vpc!.x);
  });

  it('puts it to the right when what it points at flows into it', () => {
    const l = layoutView({ ...view(nodes, ['A']), edges: [{ ...edge('A/fn', 'A/vpc'), flow: 'in' as const }] });
    const [fn, vpc] = ['A/fn', 'A/vpc'].map((id) => l.nodes.find((n) => n.id === id)!);
    expect(vpc!.x + NODE_WIDTH).toBeLessThanOrEqual(fn!.x);
  });

  it('copes with References that go in a circle, and with one to a Node that is not in the Stack', () => {
    const l = layoutView({
      ...view(nodes, ['A']),
      edges: [edge('A/fn', 'A/vpc'), edge('A/vpc', 'A/fn'), edge('A/fn', 'B/gone'), edge('A/fn', 'A/fn')],
    });
    expect(l.nodes).toHaveLength(3);
  });
});

describe('layoutView with saved positions', () => {
  const nodes = [node('A/one', 'A'), node('A/two', 'A'), node('B/three', 'B')];
  const auto = layoutView(view(nodes, ['A', 'B']));
  const at = (l: ReturnType<typeof layoutView>, id: string) => {
    const n = l.nodes.find((x) => x.id === id)!;
    const box = l.stacks.find((s) => s.id === id.split('/')[0])!;
    return { x: box.x + n.x, y: box.y + n.y }; // canvas coordinates
  };

  it('puts a Node with a saved position at exactly that canvas position', () => {
    const l = layoutView(
      view(
        nodes.map((n) => (n.id === 'A/two' ? { ...n, position: { x: 500, y: 300 } } : n)),
        ['A', 'B'],
      ),
    );
    expect(at(l, 'A/two')).toEqual({ x: 500, y: 300 });
  });

  it('still lays out the Nodes that have no saved position with dagre', () => {
    const l = layoutView(
      view(
        nodes.map((n) => (n.id === 'A/two' ? { ...n, position: { x: 500, y: 300 } } : n)),
        ['A', 'B'],
      ),
    );
    expect(at(l, 'A/one')).toEqual(at(auto, 'A/one'));
  });

  it('grows the Stack box to wrap a Node dragged outside it, with room for the header and padding', () => {
    const l = layoutView(
      view(
        nodes.map((n) => (n.id === 'A/two' ? { ...n, position: { x: 500, y: -200 } } : n)),
        ['A', 'B'],
      ),
    );
    const box = l.stacks.find((s) => s.id === 'A')!;
    expect(box.x + box.width).toBeGreaterThanOrEqual(500 + NODE_WIDTH + STACK_PADDING);
    expect(box.y).toBeLessThanOrEqual(-200 - STACK_HEADER);
    for (const id of ['A/one', 'A/two']) {
      const n = l.nodes.find((x) => x.id === id)!;
      expect(n.x).toBeGreaterThanOrEqual(STACK_PADDING);
      expect(n.y).toBeGreaterThanOrEqual(STACK_HEADER);
      expect(n.x + NODE_WIDTH).toBeLessThanOrEqual(box.width);
      expect(n.y + NODE_HEIGHT).toBeLessThanOrEqual(box.height);
    }
  });

  it('keeps the next Stack clear of a box that grew', () => {
    const l = layoutView(
      view(
        nodes.map((n) => (n.id === 'A/two' ? { ...n, position: { x: 500, y: 0 } } : n)),
        ['A', 'B'],
      ),
    );
    const [a, b] = l.stacks;
    expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);
  });

  it('does not move a saved Node when another one is dragged', () => {
    const base = nodes.map((n) => (n.id === 'A/two' ? { ...n, position: { x: 500, y: 300 } } : n));
    const before = layoutView(view(base, ['A', 'B']));
    const after = layoutView(
      view(
        base.map((n) => (n.id === 'A/one' ? { ...n, position: { x: 900, y: 10 } } : n)),
        ['A', 'B'],
      ),
    );
    expect(at(after, 'A/two')).toEqual(at(before, 'A/two'));
  });
});

describe('layoutView with nested stacks', () => {
  const nodes = [
    node('P/own', 'P'),
    node('P/child/a', 'P/child'),
    node('P/child/b', 'P/child'),
    node('P/other/c', 'P/other'),
    node('Q/d', 'Q'),
  ];
  const layout = layoutView(view(nodes, ['P', 'P/child', 'P/other', 'Q'], { 'P/child': 'P', 'P/other': 'P' }));
  const box = (id: string) => layout.stacks.find((s) => s.id === id)!;
  const rect = (b: { x: number; y: number; width: number; height: number }) => ({
    left: b.x,
    top: b.y,
    right: b.x + b.width,
    bottom: b.y + b.height,
  });
  const apart = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
    a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;

  it("draws a nested stack's box inside its parent's, below the parent's header and clear of its edge", () => {
    for (const id of ['P/child', 'P/other']) {
      const inner = rect(box(id));
      const outer = rect(box('P'));
      expect(inner.left).toBeGreaterThanOrEqual(outer.left + STACK_PADDING);
      expect(inner.top).toBeGreaterThanOrEqual(outer.top + STACK_HEADER);
      expect(inner.right).toBeLessThanOrEqual(outer.right - STACK_PADDING);
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom - STACK_PADDING);
    }
  });

  it("keeps a nested stack clear of its parent's own Nodes and of its sibling", () => {
    const own = layout.nodes.find((n) => n.id === 'P/own')!;
    const ownRect = rect({ x: box('P').x + own.x, y: box('P').y + own.y, width: NODE_WIDTH, height: NODE_HEIGHT });
    expect(apart(ownRect, rect(box('P/child')))).toBe(true);
    expect(apart(ownRect, rect(box('P/other')))).toBe(true);
    expect(apart(rect(box('P/child')), rect(box('P/other')))).toBe(true);
  });

  it("places a nested stack's Nodes inside its own box", () => {
    for (const n of layout.nodes.filter((x) => x.id.startsWith('P/child/'))) {
      const b = box('P/child');
      expect(n.x).toBeGreaterThanOrEqual(STACK_PADDING);
      expect(n.y).toBeGreaterThanOrEqual(STACK_HEADER);
      expect(n.x + NODE_WIDTH).toBeLessThanOrEqual(b.width);
      expect(n.y + NODE_HEIGHT).toBeLessThanOrEqual(b.height);
    }
  });

  it('keeps the next top-level Stack clear of the parent with everything nested in it', () => {
    expect(apart(rect(box('P')), rect(box('Q')))).toBe(true);
    expect(box('Q').x).toBeGreaterThanOrEqual(box('P').x + box('P').width);
  });

  it('names the parent of each nested box, and lists it after the parent', () => {
    expect(layout.stacks.map((s) => [s.id, s.parentId])).toEqual([
      ['P', undefined],
      ['P/child', 'P'],
      ['P/other', 'P'],
      ['Q', undefined],
    ]);
  });

  it('wraps a parent that has no Nodes of its own around its nested stacks', () => {
    const l = layoutView(view([node('P/child/a', 'P/child')], ['P', 'P/child'], { 'P/child': 'P' }));
    const [p, c] = l.stacks;
    expect(c!.x).toBeGreaterThanOrEqual(p!.x + STACK_PADDING);
    expect(c!.y).toBeGreaterThanOrEqual(p!.y + STACK_HEADER);
    expect(c!.x + c!.width).toBeLessThanOrEqual(p!.x + p!.width - STACK_PADDING);
  });
});

describe('layoutView with nested stacks and saved positions', () => {
  it("keeps a nested stack clear of a parent's Node dragged far to the right", () => {
    const nodes = [{ ...node('P/own', 'P'), position: { x: 900, y: 40 } }, node('P/child/a', 'P/child')];
    const l = layoutView(view(nodes, ['P', 'P/child'], { 'P/child': 'P' }));
    const own = l.nodes.find((n) => n.id === 'P/own')!;
    const p = l.stacks.find((s) => s.id === 'P')!;
    const c = l.stacks.find((s) => s.id === 'P/child')!;
    const ownLeft = p.x + own.x;
    expect(ownLeft + NODE_WIDTH <= c.x || c.x + c.width <= ownLeft).toBe(true);
  });
});

describe('layoutView with expanded Nodes', () => {
  const child = (id: string, parentId: string): LayerChildView => ({
    id,
    parentId,
    label: id,
    fqn: 'x',
    icon: 'generic',
  });
  const bucket: NodeView = {
    ...node('A/bucket', 'A'),
    children: [
      child('A/bucket/Resource', 'A/bucket'),
      child('A/bucket/Policy', 'A/bucket'),
      child('A/bucket/Policy/Resource', 'A/bucket/Policy'),
    ],
  };
  const queue = node('A/queue', 'A');
  const v = view([bucket, queue], ['A']);
  const rect = (b: { x: number; y: number; width: number; height: number }) => ({
    left: b.x,
    top: b.y,
    right: b.x + b.width,
    bottom: b.y + b.height,
  });
  const apart = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
    a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
  const find = (l: ReturnType<typeof layoutView>, id: string) => l.nodes.find((n) => n.id === id)!;

  it('draws every Node at the usual size, and shows no children, while nothing is expanded', () => {
    const l = layoutView(v);
    expect(l.layers).toEqual([]);
    expect(l.nodes.map((n) => [n.width, n.height])).toEqual([
      [NODE_WIDTH, NODE_HEIGHT],
      [NODE_WIDTH, NODE_HEIGHT],
    ]);
  });

  it('ignores an expanded id that has no children to show', () => {
    expect(layoutView(v, new Set(['A/queue'])).layers).toEqual([]);
  });

  it('grows an expanded Node into a box that holds its direct children below its header', () => {
    const l = layoutView(v, new Set(['A/bucket']));
    const box = find(l, 'A/bucket');
    const direct = l.layers.filter((c) => c.parentId === 'A/bucket');
    expect(direct.map((c) => c.id)).toEqual(['A/bucket/Resource', 'A/bucket/Policy']);
    for (const c of direct) {
      expect(c.x).toBeGreaterThanOrEqual(LAYER_PADDING);
      expect(c.y).toBeGreaterThanOrEqual(LAYER_HEADER);
      expect(c.x + c.width).toBeLessThanOrEqual(box.width - LAYER_PADDING);
      expect(c.y + c.height).toBeLessThanOrEqual(box.height - LAYER_PADDING);
      expect([c.width, c.height]).toEqual([LAYER_WIDTH, LAYER_HEIGHT]);
    }
  });

  it('keeps the children of one parent from overlapping', () => {
    const [a, b] = layoutView(v, new Set(['A/bucket'])).layers.filter((c) => c.parentId === 'A/bucket');
    expect(apart(rect(a!), rect(b!))).toBe(true);
  });

  it('opens a child that is itself expanded, down to the L1, inside its own box', () => {
    const l = layoutView(v, new Set(['A/bucket', 'A/bucket/Policy']));
    const policy = l.layers.find((c) => c.id === 'A/bucket/Policy')!;
    const leaf = l.layers.find((c) => c.id === 'A/bucket/Policy/Resource')!;
    expect(policy.height).toBeGreaterThan(LAYER_HEIGHT);
    expect(leaf.parentId).toBe('A/bucket/Policy');
    expect(leaf.y).toBeGreaterThanOrEqual(LAYER_HEADER);
    expect(leaf.y + leaf.height).toBeLessThanOrEqual(policy.height - LAYER_PADDING);
    // Parents come before their children.
    expect(l.layers.map((c) => c.id).indexOf(policy.id)).toBeLessThan(l.layers.map((c) => c.id).indexOf(leaf.id));
  });

  it('keeps an expanded Node clear of its neighbours and inside its Stack box', () => {
    const l = layoutView(v, new Set(['A/bucket', 'A/bucket/Policy']));
    const stack = l.stacks[0]!;
    const [a, b] = l.nodes;
    expect(apart(rect(a!), rect(b!))).toBe(true);
    for (const n of [a!, b!]) {
      expect(n.x + n.width).toBeLessThanOrEqual(stack.width);
      expect(n.y + n.height).toBeLessThanOrEqual(stack.height);
    }
  });

  it('puts a hoisted Node to the right of the Node that caused it', () => {
    const cause = node('A/svc', 'A');
    const hoisted: NodeView = { ...node('A/vpc', 'A'), hoisted: true, causedBy: ['A/svc'] };
    const l = layoutView(view([cause, hoisted], ['A']));
    expect(find(l, 'A/vpc').x).toBeGreaterThanOrEqual(find(l, 'A/svc').x + NODE_WIDTH);
  });
});
