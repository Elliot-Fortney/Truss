import { describe, expect, it } from 'vitest';
import { addScopeOf, stackPathOf, writtenOf } from './add.ts';

const stacks = [{ id: 'A' }, { id: 'B' }];

describe('addScopeOf', () => {
  it('prefers the open Stack, then the Stack of the selected Node', () => {
    expect(addScopeOf(stacks, 'B', 'A')).toBe('B');
    expect(addScopeOf(stacks, undefined, 'A')).toBe('A');
  });

  it('falls back to the only Stack, and has none to offer when there are several and nothing is selected', () => {
    expect(addScopeOf([{ id: 'A' }], undefined, undefined)).toBe('A');
    expect(addScopeOf(stacks, undefined, undefined)).toBeUndefined();
  });

  it('ignores a selection that is not on show', () => {
    expect(addScopeOf(stacks, 'Gone', 'Also/Gone')).toBeUndefined();
  });
});

describe('stackPathOf', () => {
  it('reads the path off a Stack box’s canvas id', () => {
    expect(stackPathOf('stack:App/Dev')).toBe('App/Dev');
    expect(stackPathOf('App/Dev/Bucket')).toBeUndefined();
    expect(stackPathOf(undefined)).toBeUndefined();
  });
});

describe('writtenOf', () => {
  it('shows a form value as the code would write it', () => {
    expect(writtenOf({ kind: 'string', value: 'x' })).toEqual({ kind: 'literal', value: 'x', text: 'x' });
    expect(writtenOf({ kind: 'enum', type: 'aws-cdk-lib.RemovalPolicy', member: 'DESTROY' })).toMatchObject({ member: { type: 'RemovalPolicy', name: 'DESTROY' } });
    expect(writtenOf({ kind: 'duration', unit: 'seconds', amount: 30 })).toMatchObject({ quantity: { type: 'Duration', unit: 'seconds', amount: 30 } });
  });
});
