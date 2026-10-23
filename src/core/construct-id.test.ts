import { describe, expect, it } from 'vitest';
import type { TreeNode } from './assembly.ts';
import { constructIdProblem, siblingIds, withId } from './construct-id.ts';

describe('constructIdProblem', () => {
  it('accepts an ID no sibling has, whatever its case', () => {
    expect(constructIdProblem('uploads_bucket', ['Orders'])).toBeUndefined();
    expect(constructIdProblem('X', [])).toBeUndefined();
  });

  it('refuses an empty ID', () => {
    expect(constructIdProblem('', [])).toMatch(/empty/);
  });

  it('refuses a "/" and a newline, which the path and the code could not hold', () => {
    expect(constructIdProblem('a/b', [])).toMatch(/'\/'/);
    expect(constructIdProblem('a\nb', [])).toMatch(/newline/);
    expect(constructIdProblem('a\rb', [])).toMatch(/newline/);
  });

  it('refuses the ID of a sibling, also as CDK writes it', () => {
    expect(constructIdProblem('Orders', ['Uploads', 'Orders'])).toMatch(/sibling already has/);
    expect(constructIdProblem('a--b', ['a--b'])).toMatch(/sibling already has/);
  });

  it('refuses Resource next to Default, and the other way round', () => {
    expect(constructIdProblem('Resource', ['Default'])).toMatch(/"Default"/);
    expect(constructIdProblem('Default', ['Resource'])).toMatch(/"Resource"/);
    expect(constructIdProblem('Default', ['Other'])).toBeUndefined();
  });
});

const node = (path: string, ...children: TreeNode[]): TreeNode => ({ id: path.split('/').at(-1)!, path, fqn: 'x', children });
const tree: TreeNode = { id: '', path: '', fqn: 'App', children: [node('S', node('S/A'), node('S/B', node('S/B/Resource'))), node('T')] };

describe('siblingIds', () => {
  it('lists the IDs beside a construct, not its own', () => {
    expect(siblingIds(tree, 'S/A')).toEqual(['B']);
    expect(siblingIds(tree, 'S/B/Resource')).toEqual([]);
  });

  it('reads a Stack’s siblings from the App root', () => {
    expect(siblingIds(tree, 'S')).toEqual(['T']);
  });

  it('is empty for a parent that is not there', () => {
    expect(siblingIds(tree, 'Nope/A')).toEqual([]);
  });
});

describe('withId', () => {
  it('replaces the last part of a path', () => {
    expect(withId('S/A', 'C')).toBe('S/C');
    expect(withId('S', 'C')).toBe('C');
  });
});
