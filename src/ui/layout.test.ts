import { describe, expect, it } from 'vitest';
import type { NodeView, View } from '../core/view.ts';
import { layoutView, NODE_HEIGHT, NODE_WIDTH, STACK_HEADER, STACK_PADDING } from './layout.ts';

const node = (id: string, stackId: string): NodeView => ({
  id,
  stackId,
  label: id,
  subtitle: 'Thing',
  fqn: 'x',
  icon: 'generic',
  source: { file: 'a.ts', line: 1, col: 1 },
});

const view = (nodes: NodeView[], stackIds: string[]): View => ({
  version: 1,
  synthing: false,
  stacks: stackIds.map((id) => ({ id, label: id, env: 'env-agnostic' })),
  nodes,
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
    const apart = a!.x + a!.width <= b!.x || b!.x + b!.width <= a!.x || a!.y + a!.height <= b!.y || b!.y + b!.height <= a!.y;
    expect(apart).toBe(true);
  });

  it('draws an empty Stack as a box', () => {
    const l = layoutView(view([], ['Empty']));
    expect(l.stacks[0]!.width).toBeGreaterThan(0);
    expect(l.stacks[0]!.height).toBeGreaterThan(0);
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
    const l = layoutView(view(nodes.map((n) => (n.id === 'A/two' ? { ...n, position: { x: 500, y: 300 } } : n)), ['A', 'B']));
    expect(at(l, 'A/two')).toEqual({ x: 500, y: 300 });
  });

  it('still lays out the Nodes that have no saved position with dagre', () => {
    const l = layoutView(view(nodes.map((n) => (n.id === 'A/two' ? { ...n, position: { x: 500, y: 300 } } : n)), ['A', 'B']));
    expect(at(l, 'A/one')).toEqual(at(auto, 'A/one'));
  });

  it('grows the Stack box to wrap a Node dragged outside it, with room for the header and padding', () => {
    const l = layoutView(view(nodes.map((n) => (n.id === 'A/two' ? { ...n, position: { x: 500, y: -200 } } : n)), ['A', 'B']));
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
    const l = layoutView(view(nodes.map((n) => (n.id === 'A/two' ? { ...n, position: { x: 500, y: 0 } } : n)), ['A', 'B']));
    const [a, b] = l.stacks;
    expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);
  });

  it('does not move a saved Node when another one is dragged', () => {
    const base = nodes.map((n) => (n.id === 'A/two' ? { ...n, position: { x: 500, y: 300 } } : n));
    const before = layoutView(view(base, ['A', 'B']));
    const after = layoutView(view(base.map((n) => (n.id === 'A/one' ? { ...n, position: { x: 900, y: 10 } } : n)), ['A', 'B']));
    expect(at(after, 'A/two')).toEqual(at(before, 'A/two'));
  });
});
