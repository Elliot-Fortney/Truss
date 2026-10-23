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

const view = (nodes: NodeView[], stackIds: string[], nested: Record<string, string> = {}): View => ({
  version: 1,
  synthing: false,
  hasDesign: true,
  stages: [],
  stacks: stackIds.map((id) => ({ id, label: id, env: 'env-agnostic', ...(nested[id] ? { parentId: nested[id] } : {}) })),
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

describe('layoutView with nested stacks', () => {
  const nodes = [node('P/own', 'P'), node('P/child/a', 'P/child'), node('P/child/b', 'P/child'), node('P/other/c', 'P/other'), node('Q/d', 'Q')];
  const layout = layoutView(view(nodes, ['P', 'P/child', 'P/other', 'Q'], { 'P/child': 'P', 'P/other': 'P' }));
  const box = (id: string) => layout.stacks.find((s) => s.id === id)!;
  const rect = (b: { x: number; y: number; width: number; height: number }) => ({ left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height });
  const apart = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;

  it('draws a nested stack\'s box inside its parent\'s, below the parent\'s header and clear of its edge', () => {
    for (const id of ['P/child', 'P/other']) {
      const inner = rect(box(id));
      const outer = rect(box('P'));
      expect(inner.left).toBeGreaterThanOrEqual(outer.left + STACK_PADDING);
      expect(inner.top).toBeGreaterThanOrEqual(outer.top + STACK_HEADER);
      expect(inner.right).toBeLessThanOrEqual(outer.right - STACK_PADDING);
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom - STACK_PADDING);
    }
  });

  it('keeps a nested stack clear of its parent\'s own Nodes and of its sibling', () => {
    const own = layout.nodes.find((n) => n.id === 'P/own')!;
    const ownRect = rect({ x: box('P').x + own.x, y: box('P').y + own.y, width: NODE_WIDTH, height: NODE_HEIGHT });
    expect(apart(ownRect, rect(box('P/child')))).toBe(true);
    expect(apart(ownRect, rect(box('P/other')))).toBe(true);
    expect(apart(rect(box('P/child')), rect(box('P/other')))).toBe(true);
  });

  it('places a nested stack\'s Nodes inside its own box', () => {
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
  it('keeps a nested stack clear of a parent\'s Node dragged far to the right', () => {
    const nodes = [{ ...node('P/own', 'P'), position: { x: 900, y: 40 } }, node('P/child/a', 'P/child')];
    const l = layoutView(view(nodes, ['P', 'P/child'], { 'P/child': 'P' }));
    const own = l.nodes.find((n) => n.id === 'P/own')!;
    const p = l.stacks.find((s) => s.id === 'P')!;
    const c = l.stacks.find((s) => s.id === 'P/child')!;
    const ownLeft = p.x + own.x;
    expect(ownLeft + NODE_WIDTH <= c.x || c.x + c.width <= ownLeft).toBe(true);
  });
});
