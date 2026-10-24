import { describe, expect, it } from 'vitest';
import { canRepoint, dimmed, dropOn, edgeLabel, edgeTitle, type Targets } from './connect.ts';

const targets: Targets = {
  key: { ok: true, options: [{ prop: 'encryptionKey', type: 'IKey', many: false }] },
  spare: { ok: true, options: [{ prop: 'encryptionKey', type: 'IKey', many: false, replaces: { id: 'key', label: 'Key' } }] },
  both: { ok: true, options: [{ prop: 'a', type: 'IThing', many: false }, { prop: 'b', type: 'IThing[]', many: true }] },
  nope: { ok: false, reason: 'Data has no prop that takes Nope' },
};

describe('dropOn', () => {
  it('connects at once when one prop takes the Node', () => {
    expect(dropOn(targets, 'key')).toEqual({ kind: 'connect', prop: 'encryptionKey' });
  });

  it('asks before replacing a value, naming what is there', () => {
    expect(dropOn(targets, 'spare')).toEqual({ kind: 'replace', prop: 'encryptionKey', current: 'Key' });
  });

  it('asks which prop when several take the Node', () => {
    expect(dropOn(targets, 'both')).toMatchObject({ kind: 'choose', options: [{ prop: 'a' }, { prop: 'b' }] });
  });

  it('refuses with the reason the Node was dimmed for', () => {
    expect(dropOn(targets, 'nope')).toEqual({ kind: 'refused', reason: 'Data has no prop that takes Nope' });
  });

  it('refuses a drop on nothing, on the Node it started from, and before the answer has come', () => {
    expect(dropOn(targets, undefined)).toMatchObject({ kind: 'refused' });
    expect(dropOn(targets, 'itself')).toMatchObject({ kind: 'refused' });
    expect(dropOn(undefined, 'key')).toMatchObject({ kind: 'refused', reason: expect.stringContaining('still working out') });
  });
});

describe('dimmed', () => {
  it('dims every Node that would refuse the drop, and none while no drag is going on', () => {
    expect(dimmed(targets, 'nope', 'src')).toBe(true);
    expect(dimmed(targets, 'unknown', 'src')).toBe(true);
    expect(dimmed(targets, 'key', 'src')).toBe(false);
    expect(dimmed(undefined, 'nope', undefined)).toBe(false);
  });

  it('leaves the Node the drag started from as it is', () => {
    expect(dimmed(targets, 'src', 'src')).toBe(false);
  });
});

describe('canRepoint', () => {
  it('is true for a Node that takes the prop being re-pointed, and only that', () => {
    expect(canRepoint(targets, 'key', 'encryptionKey')).toBe(true);
    expect(canRepoint(targets, 'key', 'other')).toBe(false);
    expect(canRepoint(targets, 'nope', 'encryptionKey')).toBe(false);
    expect(canRepoint(undefined, 'key', 'encryptionKey')).toBe(false);
  });
});

describe('edge words', () => {
  const edge = { id: 'e', kind: 'reference' as const, from: 'S/Fn', to: 'S/Vpc', prop: 'securityGroups', index: 1, text: 'sg', source: { file: 'a.ts', line: 1, col: 1 } };
  const names = new Map([['S/Fn', 'Fn'], ['S/Vpc', 'Vpc']]);

  it('labels an element of an array prop with its position', () => {
    expect(edgeLabel(edge)).toBe('securityGroups[1]');
    expect(edgeLabel({ prop: 'vpc' })).toBe('vpc');
  });

  it('says which prop of which Node points at which, and why it is read-only', () => {
    expect(edgeTitle(edge, names)).toBe('Fn.securityGroups[1] → Vpc');
    expect(edgeTitle({ ...edge, readOnly: 'Passed through a call' }, names)).toBe('Fn.securityGroups[1] → Vpc (read-only: Passed through a call)');
  });
});

describe('dropOn with hints', () => {
  const h = (hint: string, text: string, extra = {}) => ({ hint, self: 'a', peer: 'b', kind: 'grant' as const, text, ...extra });
  it('stages the one hint that fits, and asks when there are several or a prop takes it too', () => {
    expect(dropOn({ x: { ok: true, options: [], hints: [h('H#0', 'A is read by B')] } }, 'x')).toMatchObject({ kind: 'hint', hint: { hint: 'H#0' } });
    expect(dropOn({ x: { ok: true, options: [], hints: [h('H#0', 'one'), h('H#1', 'two')] } }, 'x')).toMatchObject({ kind: 'choose', hints: [{ hint: 'H#0' }, { hint: 'H#1' }] });
    expect(dropOn({ x: { ok: true, options: [{ prop: 'p', type: 'T', many: false }], hints: [h('H#0', 'one')] } }, 'x')).toMatchObject({ kind: 'choose' });
  });
});
