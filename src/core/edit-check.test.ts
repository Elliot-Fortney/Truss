import { describe, expect, it } from 'vitest';
import type { Assembly, TreeNode } from './assembly.ts';
import type { TextChange } from './diff.ts';
import { judgeEdit, newDiagnostics, targetPaths } from './edit-check.ts';
import type { Facts, NodeFacts } from './facts.ts';
import type { Intent } from './intents.ts';

const text = 'aaaa\nnew X(this, "A", {})\nnew X(this, "B", {})\nzzzz\n';
const span = (line: number, endCol: number) => ({ file: 'f.ts', start: { line, col: 1 }, end: { line, col: endCol } });
const node = (line: number): NodeFacts => ({
  span: span(line, 26),
  className: 'X',
  literalId: 'A',
  pathsOnSpan: 1,
  binding: 'none',
});
const facts: Facts = { nodes: { 'S/A': node(2), 'S/B': { ...node(3), literalId: 'B' }, 'T/A': node(2) } };
const A: [string, string][] = [
  ['S/A', 'x'],
  ['T/A', 'x'],
];
const intent = (path: string): Intent => ({
  type: 'setProp',
  path,
  expect: { className: 'X', literalId: 'A' },
  prop: ['p'],
  value: { kind: 'boolean', value: true },
});
const tree = (...paths: [string, string][]): TreeNode => ({
  id: '',
  path: '',
  fqn: 'App',
  children: paths.map(([path, fqn]) => ({ id: path, path, fqn, children: [] })),
});
const assembly = (t: TreeNode, stacks: Assembly['stacks'] = []): Assembly => ({
  schemaVersion: '1',
  tree: t,
  stacks,
  creation: {},
  resourceRefs: [],
});
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
    expect(check({ changes: { 'f.ts': [inA, outside] } })).toEqual([
      expect.stringContaining('outside the code it was meant to change'),
    ]);
    const next: TextChange = {
      start: text.indexOf('{}', inA.end),
      end: text.indexOf('{}', inA.end) + 2,
      text: '{ x: 1 }',
    };
    expect(check({ changes: { 'f.ts': [inA, next] } })).toHaveLength(1);
    expect(check({ changes: { 'f.ts': [inA, { start: 0, end: 0, text: 'import x;\n', purpose: 'import' }] } })).toEqual(
      [],
    );
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
    const stacks = (env: string, other: string) => [
      { path: 'S/A', env },
      { path: 'Z', env: other },
    ];
    const after = (env: string, other: string) => assembly(tree(...A, ['S/B', 'x']), stacks(env, other));
    const before = assembly(tree(...A, ['S/B', 'x']), stacks('aws://1/a', 'aws://1/a'));
    expect(check({ before, after: after('aws://1/b', 'aws://1/a') })).toEqual([]);
    expect(check({ before, after: after('aws://1/a', 'aws://1/b') })).toEqual([expect.stringContaining('Stack')]);
  });
});

describe('judgeEdit of a rename', () => {
  const rename: Intent = { type: 'renameId', path: 'S/A', expect: { className: 'X', literalId: 'A' }, newId: 'C' };
  const base = assembly(tree(...A, ['S/B', 'x'], ['S/A/Resource', 'r']));
  const moved = (...rest: [string, string][]) => assembly(tree(['T/A', 'x'], ['S/B', 'x'], ...rest));
  const judge = (after: Assembly, over: Partial<Parameters<typeof judgeEdit>[0]> = {}) =>
    judgeEdit({ files, changes: { 'f.ts': [inA] }, facts, intents: [rename], before: base, after, ...over });

  it('holds when the construct and what is beneath it are somewhere else and nothing else is', () => {
    expect(judge(moved(['S/C', 'x'], ['S/C/Resource', 'r']))).toEqual([]);
  });

  it('fails when the path did not change, or the old one is still there', () => {
    expect(judge(base)[0]).toContain('S/A was not renamed to S/C');
    expect(judge(moved(['S/C', 'x'], ['S/C/Resource', 'r'], ['S/A', 'x']))[0]).toContain('S/A was not renamed to S/C');
  });

  it('fails when something beneath it did not go with it', () => {
    expect(judge(moved(['S/C', 'x']))).toEqual(['S/A/Resource did not move with S/A']);
  });

  it('fails when another construct changed as well', () => {
    expect(judge(assembly(tree(['T/A', 'x'], ['S/C', 'x'], ['S/C/Resource', 'r']))).join()).toContain('S/B');
  });

  it('follows the new path of a Stack that is renamed', () => {
    const stack: Intent = { type: 'renameId', path: 'S', expect: { className: 'X', literalId: 'A' }, newId: 'R' };
    const stackFacts: Facts = { nodes: { S: node(2) } };
    const before = assembly(tree(['S', 'x'], ['S/B', 'x']), [
      { path: 'S', env: 'a' },
      { path: 'Z', env: 'a' },
    ]);
    const after = assembly(tree(['R', 'x'], ['R/B', 'x']), [
      { path: 'R', env: 'a' },
      { path: 'Z', env: 'a' },
    ]);
    expect(
      judgeEdit({ files, changes: { 'f.ts': [inA] }, facts: stackFacts, intents: [stack], before, after }),
    ).toEqual([]);
    const other = assembly(tree(['R', 'x'], ['R/B', 'x']), [
      { path: 'R', env: 'a' },
      { path: 'Z', env: 'b' },
    ]);
    expect(
      judgeEdit({ files, changes: { 'f.ts': [inA] }, facts: stackFacts, intents: [stack], before, after: other }),
    ).toEqual([expect.stringContaining('Stack')]);
  });

  it('judges an edit made after the rename by the construct’s path in the Base', () => {
    const later: Intent = { ...intent('S/C'), expect: { className: 'X', literalId: 'C' } };
    expect(judge(moved(['S/C', 'x'], ['S/C/Resource', 'r']), { intents: [rename, later] })).toEqual([]);
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

describe('judgeEdit for added and copied constructs', () => {
  const add: Intent = {
    type: 'addNode',
    path: 'S',
    expect: { className: 'Stack', literalId: 'S' },
    fqn: 'lib.Bucket',
    id: 'New',
    props: [],
  };
  const withStack: Facts = { nodes: { ...facts.nodes, S: { ...node(1), className: 'Stack', literalId: 'S' } } };
  const statement: TextChange = {
    start: text.indexOf('zzzz'),
    end: text.indexOf('zzzz'),
    text: 'new Bucket(this, "New");\n',
    purpose: 'add',
  };
  const base = assembly(tree(...A, ['S/B', 'x']));
  const run = (over: Partial<Parameters<typeof judgeEdit>[0]> = {}) =>
    judgeEdit({
      files,
      changes: { 'f.ts': [statement] },
      facts: withStack,
      intents: [add],
      before: base,
      after: assembly(tree(...A, ['S/B', 'x'], ['S/New', 'lib.Bucket'], ['S/New/Resource', 'lib.CfnBucket'])),
      ...over,
    });

  it('holds for one new path of the expected class and what it creates beneath itself', () => {
    expect(run()).toEqual([]);
  });

  it('does not make the Stack a target', () => {
    expect([...targetPaths(withStack, [add])]).toEqual([]);
  });

  it('fails when the new path is missing, is another class, or something else changed too', () => {
    expect(run({ after: base })[0]).toContain('S/New was not added');
    expect(run({ after: assembly(tree(...A, ['S/B', 'x'], ['S/New', 'lib.Other'])) })[0]).toContain(
      'not the lib.Bucket',
    );
    expect(run({ after: assembly(tree(...A, ['S/B', 'changed'], ['S/New', 'lib.Bucket'])) })[0]).toContain('S/B');
    expect(
      run({ after: assembly(tree(...A, ['S/B', 'x'], ['S/New', 'lib.Bucket'], ['S/Extra', 'lib.Bucket'])) })[0],
    ).toContain('S/Extra');
  });

  it('expects the copy of a Node to be the same class under the new ID', () => {
    const copy: Intent = { type: 'duplicate', path: 'S/B', expect: { className: 'X', literalId: 'B' }, newId: 'B2' };
    const mine = (over: Partial<Parameters<typeof judgeEdit>[0]> = {}) =>
      judgeEdit({
        files,
        changes: { 'f.ts': [statement] },
        facts,
        intents: [copy],
        before: base,
        after: assembly(tree(...A, ['S/B', 'x'], ['S/B2', 'x'])),
        ...over,
      });
    expect(mine()).toEqual([]);
    expect(mine({ after: assembly(tree(...A, ['S/B', 'x'], ['S/B2', 'y'])) })[0]).toContain('S/B2');
  });
});

describe('judgeEdit for a removed Node', () => {
  const gone: Intent = { type: 'removeNode', path: 'S/B', expect: { className: 'X', literalId: 'B' } };
  const cut: TextChange = {
    start: text.indexOf('new X(this, "B"'),
    end: text.indexOf('zzzz'),
    text: '',
    purpose: 'remove',
  };
  const base = assembly(tree(...A, ['S/B', 'x'], ['S/B/Resource', 'r']));
  const run = (over: Partial<Parameters<typeof judgeEdit>[0]> = {}) =>
    judgeEdit({
      files,
      changes: { 'f.ts': [cut] },
      facts,
      intents: [gone],
      before: base,
      after: assembly(tree(...A)),
      ...over,
    });

  it('holds when exactly that subtree is gone', () => {
    expect(run()).toEqual([]);
  });

  it('fails when the Node, or something beneath it, is still there', () => {
    expect(run({ after: assembly(tree(...A, ['S/B', 'x'])) })[0]).toContain('S/B was not removed');
    expect(run({ after: assembly(tree(...A, ['S/B/Resource', 'r'])) })[0]).toContain('S/B/Resource');
  });

  it('fails when something else went too', () => {
    expect(run({ after: assembly(tree(['S/A', 'x'])) })[0]).toContain('T/A');
  });

  it('holds for a Node renamed earlier in the Draft', () => {
    const renamed: Intent = { type: 'renameId', path: 'S/B', expect: { className: 'X', literalId: 'B' }, newId: 'C' };
    const removed: Intent = { type: 'removeNode', path: 'S/C', expect: { className: 'X', literalId: 'C' } };
    expect(run({ intents: [renamed, removed] })).toEqual([]);
  });
});

describe('judgeEdit on a Reference', () => {
  const resource = (path: string): TreeNode => ({
    id: path.split('/').at(-1)!,
    path,
    fqn: 'x',
    cfnType: 'AWS::X::Y',
    children: [],
  });
  const withResources = (): TreeNode => ({
    id: '',
    path: '',
    fqn: 'App',
    children: [
      { id: 'S/A', path: 'S/A', fqn: 'x', children: [resource('S/A/Resource')] },
      { id: 'S/B', path: 'S/B', fqn: 'x', children: [resource('S/B/Resource')] },
      { id: 'T/A', path: 'T/A', fqn: 'x', children: [] },
    ],
  });
  const add: Extract<Intent, { type: 'addReference' }> = {
    type: 'addReference',
    path: 'S/A',
    expect: { className: 'X', literalId: 'A' },
    prop: 'p',
    to: { path: 'S/B', className: 'X', literalId: 'B' },
  };
  const judge = (resourceRefs: Assembly['resourceRefs'], intents: Intent[] = [add]) =>
    judgeEdit({
      files,
      changes: { 'f.ts': [inA] },
      facts,
      intents,
      before: assembly(withResources()),
      after: { ...assembly(withResources()), resourceRefs },
    });

  it('holds when a resource of the source points at a resource of the target', () => {
    expect(judge([{ from: 'S/A/Resource', to: 'S/B/Resource' }])).toEqual([]);
  });

  it('fails an added Reference the template does not show', () => {
    expect(judge([])).toEqual(['S/A does not point at S/B after the edit']);
  });

  it('checks a re-point the same way, and not a removal', () => {
    const repoint: Intent = {
      type: 'repointReference',
      path: 'S/A',
      expect: add.expect,
      prop: 'p',
      was: { path: 'S/C', className: 'X', literalId: 'C' },
      to: { path: 'S/B', className: 'X', literalId: 'B' },
    };
    expect(judge([], [repoint])).toEqual(['S/A does not point at S/B after the edit']);
    const remove: Intent = {
      type: 'removeReference',
      path: 'S/A',
      expect: add.expect,
      prop: 'p',
      to: { path: 'S/B', className: 'X', literalId: 'B' },
    };
    expect(judge([], [remove])).toEqual([]);
  });

  it('does not check a Reference to a Node with no resource, or one made in another Stack', () => {
    const bare: TreeNode = {
      id: '',
      path: '',
      fqn: 'App',
      children: [
        { id: 'S/A', path: 'S/A', fqn: 'x', children: [resource('S/A/Resource')] },
        { id: 'S/B', path: 'S/B', fqn: 'x', children: [] },
        { id: 'T/A', path: 'T/A', fqn: 'x', children: [] },
      ],
    };
    expect(
      judgeEdit({
        files,
        changes: { 'f.ts': [inA] },
        facts,
        intents: [add],
        before: assembly(bare),
        after: assembly(bare),
      }),
    ).toEqual([]);
    expect(judge([], [{ ...add, to: { path: 'T/B', className: 'X', literalId: 'B' } }])).toEqual([]);
  });
});
