import { describe, expect, it } from 'vitest';
import type { NodeView, View } from '../core/view.ts';
import { layoutView, NODE_HEIGHT, NODE_WIDTH } from './layout.ts';

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
  hasDesign: true,
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
