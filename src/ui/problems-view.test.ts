import { describe, expect, it } from 'vitest';
import type { Problem } from '../core/problems.ts';
import { jumpTarget, listProblems } from './problems-view.ts';

const p = (id: string, extra: Partial<Problem> = {}): Problem => ({ id, severity: 'error', source: 'annotation', message: id, draft: false, blocking: false, ...extra });

describe('listProblems', () => {
  const all = [p('info', { severity: 'info' }), p('warn', { severity: 'warning', draft: true }), p('old-error'), p('new-error', { draft: true })];
  it('lists errors first, then warnings, in the order found, and never info', () => {
    expect(listProblems(all, 'all').map((x) => x.id)).toEqual(['old-error', 'new-error', 'warn']);
  });
  it('lists only what the Draft introduced with the Draft filter', () => {
    expect(listProblems(all, 'draft').map((x) => x.id)).toEqual(['new-error', 'warn']);
  });
});

describe('jumpTarget', () => {
  it('goes to the nearest drawn construct at or above the Problem', () => {
    expect(jumpTarget(p('x', { path: 'S/Q/Resource' }), new Set(['S', 'S/Q']))).toBe('S/Q');
    expect(jumpTarget(p('x', { path: 'S/Q' }), new Set(['S']))).toBe('S');
  });
  it('has nowhere to go for a Problem on no construct', () => {
    expect(jumpTarget(p('x'), new Set(['S']))).toBeUndefined();
  });
});
