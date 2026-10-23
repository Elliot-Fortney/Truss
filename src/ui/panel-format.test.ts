import { describe, expect, it } from 'vitest';
import { idFieldState, literalText, moreLabel, propsNotice, unsetText } from './panel-format.ts';

describe('literalText', () => {
  it('shows a literal as the value it has, strings without their quotes', () => {
    expect(literalText('logs')).toBe('logs');
    expect(literalText(30)).toBe('30');
    expect(literalText(false)).toBe('false');
    expect(literalText(null)).toBe('null');
  });

  it('marks an empty string, which would otherwise look like no value at all', () => {
    expect(literalText('')).toBe('""');
  });
});

describe('unsetText', () => {
  it('says a prop is not set when the code writes its props out', () => {
    expect(unsetText({})).toBe('not set');
  });

  it('does not claim a prop is unset when the props come from a variable, which may well set it', () => {
    expect(unsetText({ propsSource: 'bucketProps' })).toBe('see bucketProps');
  });
});

describe('propsNotice', () => {
  it('says why every prop is read-only when the props are passed as a variable', () => {
    expect(propsNotice({ propsSource: 'bucketProps' })).toBe('Props are passed as bucketProps, so Truss shows every prop read-only.');
  });

  it('has nothing to say when the props are written out', () => {
    expect(propsNotice({})).toBeUndefined();
  });
});

describe('moreLabel', () => {
  it('counts the props kept on demand, hidden or shown', () => {
    expect(moreLabel(1, false)).toBe('Show 1 more prop');
    expect(moreLabel(12, false)).toBe('Show 12 more props');
    expect(moreLabel(12, true)).toBe('Hide 12 more props');
  });
});

describe('idFieldState', () => {
  const panel = { literalId: 'Logs', idEdit: { siblings: ['Other', 'Default'] } };

  it('says nothing of the ID as it is', () => {
    expect(idFieldState('Logs', panel)).toEqual({ canStage: false });
  });

  it('warns that CloudFormation replaces the resource once a valid ID is typed, without blocking it', () => {
    expect(idFieldState('Files', panel)).toEqual({ note: 'Changes the construct path: CloudFormation will replace this resource.', canStage: true });
    expect(idFieldState('files_bucket', panel).canStage).toBe(true);
  });

  it('gives the problem instead, and stages nothing, for an ID the rules refuse', () => {
    expect(idFieldState('', panel)).toMatchObject({ problem: expect.stringContaining('empty'), canStage: false });
    expect(idFieldState('a/b', panel)).toMatchObject({ problem: expect.any(String), canStage: false });
    expect(idFieldState('Other', panel)).toMatchObject({ problem: expect.stringContaining('sibling'), canStage: false });
    expect(idFieldState('Resource', panel)).toMatchObject({ problem: expect.stringContaining('Default') });
    expect(idFieldState('Other', panel).note).toBeUndefined();
  });

  it('stages nothing when the ID cannot be edited', () => {
    expect(idFieldState('Files', { literalId: 'Logs' })).toEqual({ canStage: false });
  });
});
