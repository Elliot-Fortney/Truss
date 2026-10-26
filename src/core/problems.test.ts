import { describe, expect, it } from 'vitest';
import type { Assembly } from './assembly.ts';
import type { Facts } from './facts.ts';
import {
  annotationProblems,
  badgesFor,
  buildReport,
  contextProblems,
  cycleProblems,
  findCycles,
  nodeAt,
  sourcePosition,
  type Problem,
} from './problems.ts';

const assembly = (extra: Partial<Assembly> = {}): Assembly => ({
  schemaVersion: '1',
  tree: { id: '', path: '', fqn: 'x', children: [] },
  stacks: [],
  creation: {},
  resourceRefs: [],
  ...extra,
});
const refs = (...pairs: [string, string][]) => pairs.map(([from, to]) => ({ from, to }));
const problem = (p: Partial<Problem>): Problem => ({
  id: 'p',
  severity: 'error',
  source: 'annotation',
  message: 'm',
  draft: false,
  blocking: false,
  ...p,
});

describe('dependency cycles', () => {
  it('finds a cycle and walks it in order', () => {
    const a = assembly({ resourceRefs: refs(['S/A', 'S/B'], ['S/B', 'S/C'], ['S/C', 'S/A'], ['S/C', 'S/D']) });
    expect(findCycles(a)).toEqual([['S/A', 'S/B', 'S/C']]);
  });

  it('finds nothing in a graph without one', () => {
    expect(findCycles(assembly({ resourceRefs: refs(['S/A', 'S/B'], ['S/B', 'S/C']) }))).toEqual([]);
  });

  it('names the resources, and blocks only a cycle the base did not have', () => {
    const base = assembly({ resourceRefs: refs(['S/A', 'S/B'], ['S/B', 'S/A']) });
    const draft = assembly({ resourceRefs: refs(['S/A', 'S/B'], ['S/B', 'S/A'], ['S/X', 'S/Y'], ['S/Y', 'S/X']) });
    const found = cycleProblems(draft, base);
    expect(found.map((p) => [p.message, p.draft, p.blocking])).toEqual([
      ['Dependency cycle: S/A → S/B → S/A', false, false],
      ['Dependency cycle: S/X → S/Y → S/X', true, true],
    ]);
    expect(cycleProblems(base).every((p) => !p.blocking)).toBe(true);
  });
});

describe('annotations', () => {
  const note = (level: 'error' | 'warning' | 'info', message: string) => ({ path: 'S/Q', level, message });
  it('blocks only an error the base did not have', () => {
    const base = assembly({ annotations: [note('error', 'old')] });
    const draft = assembly({ annotations: [note('error', 'old'), note('error', 'new'), note('warning', 'careful')] });
    expect(annotationProblems(draft, base).map((p) => [p.message, p.draft, p.blocking])).toEqual([
      ['old', false, false],
      ['new', true, true],
      ['careful', true, false],
    ]);
  });
});

describe('badges', () => {
  const visible = new Set(['S', 'S/Q', 'S/F']);
  it('bubbles to the nearest visible ancestor with a count, once per Problem', () => {
    const badges = badgesFor(
      [problem({ path: 'S/Q/Resource' }), problem({ path: 'S/Q/Policy/Resource' }), problem({ path: 'S/F' })],
      visible,
    );
    expect(badges.get('S/Q')).toEqual({ errors: 2, warnings: 0 });
    expect(badges.get('S/F')).toEqual({ errors: 1, warnings: 0 });
  });

  it('badges every error but only the warnings the Draft introduced, and never info', () => {
    const badges = badgesFor(
      [
        problem({ path: 'S/Q', severity: 'warning' }),
        problem({ path: 'S/F', severity: 'warning', draft: true }),
        problem({ path: 'S/F', severity: 'info', draft: true }),
      ],
      visible,
    );
    expect(badges.has('S/Q')).toBe(false);
    expect(badges.get('S/F')).toEqual({ errors: 0, warnings: 1 });
  });

  it('badges each Node of a cycle once', () => {
    const [cycle] = cycleProblems(
      assembly({ resourceRefs: refs(['S/Q/A', 'S/Q/B'], ['S/Q/B', 'S/Q/A'], ['S/Q/A', 'S/F/C'], ['S/F/C', 'S/Q/A']) }),
    );
    expect([...badgesFor([cycle!], visible)].sort()).toEqual([
      ['S/F', { errors: 1, warnings: 0 }],
      ['S/Q', { errors: 1, warnings: 0 }],
    ]);
  });
});

describe('tracing an error to a Node', () => {
  const span = (file: string, l1: number, c1: number, l2: number, c2: number) => ({
    file,
    start: { line: l1, col: c1 },
    end: { line: l2, col: c2 },
  });
  const node = (s: ReturnType<typeof span>) => ({ span: s, className: 'X', pathsOnSpan: 1, binding: 'none' as const });
  it('finds the innermost span holding the place', () => {
    const facts: Facts = {
      nodes: {
        Outer: node(span('a.ts', 1, 1, 20, 2)),
        Inner: node(span('a.ts', 5, 3, 8, 4)),
        Other: node(span('b.ts', 1, 1, 20, 2)),
      },
    };
    expect(nodeAt(facts, { file: 'a.ts', line: 6, col: 9 })).toBe('Inner');
    expect(nodeAt(facts, { file: 'a.ts', line: 12, col: 1 })).toBe('Outer');
    expect(nodeAt(facts, { file: 'c.ts', line: 1, col: 1 })).toBeUndefined();
  });

  it('maps a place in the changed text back to the original', () => {
    const original = 'aaa\nbbb\nccc\n';
    const changes = [{ start: 4, end: 7, text: 'BBBBB\nxx' }];
    const changed = 'aaa\nBBBBB\nxx\nccc\n';
    expect(sourcePosition(original, changes, changed, { line: 4, col: 2 })).toEqual({ line: 3, col: 2 });
    expect(sourcePosition(original, changes, changed, { line: 2, col: 3 })).toEqual({ line: 2, col: 1 });
    expect(sourcePosition(original, changes, changed, { line: 1, col: 2 })).toEqual({ line: 1, col: 2 });
  });
});

describe('the report', () => {
  it('has the intents, the changed lines and the failures, and none of the code around them', () => {
    const report = buildReport(
      [
        {
          type: 'setProp',
          path: 'S/Q',
          expect: { className: 'sqs.Queue', literalId: 'Q' },
          prop: ['fifo'],
          value: { kind: 'boolean', value: true },
        },
      ],
      [
        {
          file: 'lib/s.ts',
          diff: '--- a/lib/s.ts\n+++ b/lib/s.ts\n@@ -1,3 +1,3 @@\n secret line\n-  fifo: false,\n+  fifo: true,\n more secret\n',
        },
      ],
      ['The edit changes S/Z, which it should not touch'],
    );
    expect(report).toContain('setProp S/Q');
    expect(report).toContain('+  fifo: true,');
    expect(report).toContain('S/Z, which it should not touch');
    expect(report).not.toContain('secret');
  });
});

describe('missing context (ADR 0011)', () => {
  const external = (className: string): Facts['nodes'][string] => ({
    span: { file: 'lib/s.ts', start: { line: 1, col: 1 }, end: { line: 1, col: 2 } },
    className,
    pathsOnSpan: 1,
    binding: 'const',
    external: true,
  });
  const facts = (nodes: Facts['nodes']): Facts => ({ nodes });
  const missing = (...providers: string[]) =>
    assembly({ missingContext: providers.map((provider) => ({ key: `${provider}:x`, provider })) });
  const WARNING = 'Context missing: run `cdk synth` once with AWS credentials';

  it('is a warning on the External Node that the lookup made', () => {
    const f = facts({
      'S/Vpc': external('ec2.Vpc.fromLookup'),
      'S/Zone': external('route53.HostedZone.fromLookup'),
      'S/Bucket': external('s3.Bucket.fromBucketName'),
    });
    const found = contextProblems(missing('vpc-provider'), f);
    expect(found).toMatchObject([
      { severity: 'warning', source: 'context', message: WARNING, path: 'S/Vpc', draft: false, blocking: false },
    ]);
  });

  it('is on every External Node that could have made it when the lookup is not told apart', () => {
    const f = facts({ 'S/A': external('ec2.Vpc.fromLookup'), 'S/B': external('ec2.Vpc.fromLookup') });
    expect(contextProblems(missing('vpc-provider'), f).map((p) => p.path)).toEqual(['S/A', 'S/B']);
  });

  it('is on a Node of any lookup for a provider Truss does not know', () => {
    const f = facts({ 'S/Thing': external('x.Thing.fromLookup') });
    expect(contextProblems(missing('brand-new-provider'), f).map((p) => p.path)).toEqual(['S/Thing']);
  });

  it('is still reported, with no Node, when no External Node made the lookup', () => {
    const found = contextProblems(missing('availability-zones'), facts({}));
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBeUndefined();
  });

  it('is never blocking, and is the Draft’s only when the base did not have it', () => {
    const f = facts({ 'S/Vpc': external('ec2.Vpc.fromLookup') });
    const base = { assembly: assembly(), facts: f };
    expect(contextProblems(missing('vpc-provider'), f, base).map((p) => [p.draft, p.blocking])).toEqual([
      [true, false],
    ]);
    expect(contextProblems(missing('vpc-provider'), f, { assembly: missing('vpc-provider'), facts: f })[0]!.draft).toBe(
      false,
    );
  });

  it('says nothing for an assembly with no missing context', () => {
    expect(contextProblems(assembly(), facts({}))).toEqual([]);
  });
});
