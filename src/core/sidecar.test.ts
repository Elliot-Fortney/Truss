import { describe, expect, it } from 'vitest';
import { withMoves, type Sidecar } from './sidecar.ts';

const sidecar: Sidecar = {
  nodes: {
    'S/A': { position: { x: 1, y: 2 } },
    'S/A/Resource': { note: 'deep' },
    'S/AB': { note: 'not beneath' },
    'S/B': { note: 'other' },
  },
};

describe('withMoves', () => {
  it('moves the entry of a path, and of what is beneath it, and no other', () => {
    expect(withMoves(sidecar, [{ from: 'S/A', to: 'S/C' }]).nodes).toEqual({
      'S/C': { position: { x: 1, y: 2 } },
      'S/C/Resource': { note: 'deep' },
      'S/AB': { note: 'not beneath' },
      'S/B': { note: 'other' },
    });
  });

  it('makes the moves in order, so a Node renamed twice ends at its last path', () => {
    const moved = withMoves(sidecar, [
      { from: 'S/A', to: 'S/C' },
      { from: 'S/C', to: 'S/D' },
    ]);
    expect(Object.keys(moved.nodes).sort()).toEqual(['S/AB', 'S/B', 'S/D', 'S/D/Resource']);
  });

  it('puts the moved entry in place of one left at the new path by something that is gone', () => {
    const stale: Sidecar = { nodes: { 'S/A': { note: 'live' }, 'S/C': { note: 'stale' } } };
    expect(withMoves(stale, [{ from: 'S/A', to: 'S/C' }]).nodes).toEqual({ 'S/C': { note: 'live' } });
  });

  it('is the Sidecar itself when nothing moves', () => {
    expect(withMoves(sidecar, [])).toBe(sidecar);
  });
});
