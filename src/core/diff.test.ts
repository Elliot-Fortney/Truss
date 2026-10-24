import { describe, expect, it } from 'vitest';
import { applyChanges, offsetOf, unifiedDiff } from './diff.ts';

describe('applyChanges', () => {
  it('replaces and inserts by offset into the original text', () => {
    expect(
      applyChanges('hello world', [
        { start: 6, end: 11, text: 'there' },
        { start: 0, end: 0, text: '>> ' },
      ]),
    ).toBe('>> hello there');
  });

  it('keeps insertions at one offset in the order given', () => {
    expect(
      applyChanges('ab', [
        { start: 1, end: 1, text: 'X' },
        { start: 1, end: 1, text: 'Y' },
      ]),
    ).toBe('aXYb');
  });

  it('refuses changes that overlap', () => {
    expect(() =>
      applyChanges('abcdef', [
        { start: 0, end: 4, text: '' },
        { start: 2, end: 3, text: 'x' },
      ]),
    ).toThrow(/overlap/);
  });
});

describe('offsetOf', () => {
  it('turns a 1-based line and column into an offset', () => {
    expect(offsetOf('ab\ncd\nef', 1, 1)).toBe(0);
    expect(offsetOf('ab\ncd\nef', 2, 2)).toBe(4);
    expect(offsetOf('ab\ncd\nef', 3, 1)).toBe(6);
    expect(offsetOf('ab\r\ncd', 2, 1)).toBe(4);
  });
});

describe('unifiedDiff', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

  it('is undefined for the same text', () => {
    expect(unifiedDiff('a.ts', 'x\n', 'x\n')).toBeUndefined();
  });

  it('shows a change with three lines of context and a hunk header', () => {
    const before = lines(12).join('\n') + '\n';
    const after = before.replace('line 6\n', 'changed\n');
    expect(unifiedDiff('a.ts', before, after)?.diff).toBe(
      [
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -3,7 +3,7 @@',
        ' line 3',
        ' line 4',
        ' line 5',
        '-line 6',
        '+changed',
        ' line 7',
        ' line 8',
        ' line 9',
        '',
      ].join('\n'),
    );
  });

  it('puts distant changes in hunks of their own', () => {
    const before = lines(30).join('\n') + '\n';
    const after = before.replace('line 2\n', 'two\n').replace('line 29\n', 'twenty-nine\n');
    const diff = unifiedDiff('a.ts', before, after)!.diff;
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(diff).toContain('@@ -1,5 +1,5 @@');
    expect(diff).toContain('@@ -26,5 +26,5 @@');
  });

  it('shows added lines and removed lines at the ends of a file', () => {
    expect(unifiedDiff('a.ts', 'a\n', 'new\na\nb\n')?.diff).toBe(
      ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,3 @@', '+new', ' a', '+b', ''].join('\n'),
    );
    expect(unifiedDiff('a.ts', 'a\nb\n', 'b\n')?.diff).toContain('-a\n b');
  });

  it('is the same for CRLF text', () => {
    expect(unifiedDiff('a.ts', 'a\r\nb\r\n', 'a\r\nc\r\n')?.diff).toContain('-b\n+c');
  });
});
