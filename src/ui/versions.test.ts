import { describe, expect, it } from 'vitest';
import type { View } from '../core/view.ts';
import { applyPush } from './versions.ts';

const v = (version: number): View => ({
  version,
  synthing: false,
  hasDesign: false,
  stages: [],
  stacks: [],
  nodes: [],
  edges: [],
  problems: [],
});

describe('applyPush', () => {
  it('takes the first push', () => {
    expect(applyPush(undefined, v(3))).toEqual(v(3));
  });
  it('takes a newer push', () => {
    expect(applyPush(v(3), v(4)).version).toBe(4);
  });
  it('drops a stale push, keeping the view it has', () => {
    const current = v(5);
    expect(applyPush(current, v(4))).toBe(current);
    expect(applyPush(current, v(5))).toBe(current);
  });
});
