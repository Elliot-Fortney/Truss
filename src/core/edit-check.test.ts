import { describe, expect, it } from 'vitest';
import type { Assembly, TreeNode } from './assembly.ts';
import type { TextChange } from './diff.ts';
import { judgeEdit, newDiagnostics, targetPaths } from './edit-check.ts';
import type { Facts, NodeFacts } from './facts.ts';
import type { Intent } from './intents.ts';

const text = 'aaaa\nnew X(this, "A", {})\nnew X(this, "B", {})\nzzzz\n';
const span = (line: number, endCol: number) => ({ file: 'f.ts', start: { line, col: 1 }, end: { line, col: endCol } });
const node = (line: number): NodeFacts => ({ span: span(line, 26), className: 'X', literalId: 'A', pathsOnSpan: 1, binding: 'none' });
const facts: Facts = { nodes: { 'S/A': node(2), 'S/B': { ...node(3), literalId: 'B' }, 'T/A': node(2) } };
const A: Array<[string, string]> = [['S/A', 'x'], ['T/A', 'x']];
const intent = (path: string): Intent => ({ type: 'setProp', path, expect: { className: 'X', literalId: 'A' }, prop: ['p'], value: { kind: 'boolean', value: true } });
const tree = (...paths: Array<[string, string]>): TreeNode => ({ id: '', path: '', fqn: 'App', children: paths.map(([path, fqn]) => ({ id: path, path, fqn, children: [] })) });
const assembly = (t: TreeNode, stacks: Assembly['stacks'] = []): Assembly => ({ schemaVersion: '1', tree: t, stacks, creation: {}, resourceRefs: [] });
const files = new Map([['f.ts', text]]);
const inA: TextChange = { start: text.indexOf('{}'), end: text.indexOf('{}') + 2, text: '{ p: true }' };
const check = (over: Partial<Parameters<typeof judgeEdit>[0]> = {}) =>
  judgeEdit({
    files,
    changes: { 'f.ts': [inA] },
    facts,
    intents: [intent('S/A')],
    before: assembly(tree(...A, ['S/B', 'x'])),
    after: assembly(tree(...A, ['S/B', 'x'], ['S/A/Key', 'k'])),
    ...over,
  });

describe('targetPaths', () => {
  it('is every path made by the `new` an intent names, which is several for a class created more than once', () => {
    expect([...targetPaths(facts, [intent('S/A')])].sort()).toEqual(['S/A', 'T/A']);
  });
});

describe('judgeEdit', () => {
  it('holds for a change inside the call, and constructs added beneath the target', () => {
    expect(check()).toEqual([]);
  });

  it('fails a change outside the calls the intents name, but lets an import line in', () => {
    const outside: TextChange = { start: 0, end: 4, text: 'bbbb' };
    expect(check({ changes: { 'f.ts': [inA, outside] } })).toEqual([expect.stringContaining('outside the code it was meant to change')]);
    const next: TextChange = { start: text.indexOf('{}', inA.end), end: text.indexOf('{}', inA.end) + 2, text: '{ x: 1 }' };
    expect(check({ changes: { 'f.ts': [inA, next] } })).toHaveLength(1);
    expect(check({ changes: { 'f.ts': [inA, { start: 0, end: 0, text: 'import x;\n', purpose: 'import' }] } })).toEqual([]);
  });

  it('fails an edit that changes a construct other than the targets', () => {
    expect(check({ after: assembly(tree(...A)) })).toEqual([expect.stringContaining('S/B')]);
    expect(check({ after: assembly(tree(...A, ['S/B', 'changed'])) })).toEqual([expect.stringContaining('S/B')]);
  });

  it('says it once for a construct and everything beneath it', () => {
    const before = assembly(tree(...A, ['S/B', 'x'], ['S/B/Resource', 'r']));
    expect(check({ before, after: assembly(tree(...A)) })).toHaveLength(1);
  });

  it('fails a target that is gone or has become another kind of construct', () => {
    expect(check({ after: assembly(tree(['T/A', 'x'], ['S/B', 'x'])) })[0]).toContain('S/A');
    expect(check({ after: assembly(tree(['S/A', 'other'], ['T/A', 'x'], ['S/B', 'x'])) })[0]).toContain('S/A');
  });

  it('lets a target Stack’s environment change and no other Stack’s', () => {
    const stacks = (env: string, other: string) => [{ path: 'S/A', env }, { path: 'Z', env: other }];
    const after = (env: string, other: string) => assembly(tree(...A, ['S/B', 'x']), stacks(env, other));
    const before = assembly(tree(...A, ['S/B', 'x']), stacks('aws://1/a', 'aws://1/a'));
    expect(check({ before, after: after('aws://1/b', 'aws://1/a') })).toEqual([]);
    expect(check({ before, after: after('aws://1/a', 'aws://1/b') })).toEqual([expect.stringContaining('Stack')]);
  });
});

describe('newDiagnostics', () => {
  const d = (code: number, line = 1, file = 'a.ts') => ({ file, line, code, message: `m${code}` });

  it('is what the edit adds, ignoring a diagnostic that only moved to another line', () => {
    expect(newDiagnostics([d(1, 3)], [d(1, 9), d(2)])).toEqual([d(2)]);
  });

  it('counts a repeated diagnostic, so a second copy is new', () => {
    expect(newDiagnostics([d(1)], [d(1), d(1, 5)])).toEqual([d(1, 5)]);
  });

  it('is empty when the edit removes diagnostics', () => {
    expect(newDiagnostics([d(1), d(2)], [d(2)])).toEqual([]);
  });
});
