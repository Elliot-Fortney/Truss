import { describe, expect, it } from 'vitest';
import { nodeEditability } from './editability.ts';
import type { NodeFacts } from './facts.ts';

const facts = (overrides: Partial<NodeFacts> = {}): NodeFacts => ({
  span: { file: 'lib/a.ts', start: { line: 10, col: 5 }, end: { line: 10, col: 40 } },
  className: 'sqs.Queue',
  literalId: 'Jobs',
  pathsOnSpan: 1,
  binding: 'none',
  enclosingClass: { name: 'ApiStack', kind: 'stack' },
  ...overrides,
});

describe('nodeEditability', () => {
  it('is editable when one path comes from the span and the ID is a literal matching the path', () => {
    expect(nodeEditability('Api/Jobs', facts())).toEqual({ editable: true });
  });

  it('is editable when the ID matches the last part of a deeper path', () => {
    expect(nodeEditability('Api/Service/Jobs', facts())).toEqual({ editable: true });
  });

  it('is locked, with the class named, inside a construct class of the app', () => {
    expect(
      nodeEditability('Api/Service/Jobs', facts({ enclosingClass: { name: 'ApiService', kind: 'construct' } })),
    ).toEqual({
      editable: false,
      reason: 'Created inside ApiService, a construct class of your own',
    });
  });

  it('is locked in a loop', () => {
    expect(nodeEditability('Api/Loop1', facts({ literalId: undefined, surround: { kind: 'loop' } }))).toEqual({
      editable: false,
      reason: 'Created in a loop',
    });
  });

  it('is locked in a helper, which it names', () => {
    expect(
      nodeEditability('Api/A', facts({ literalId: undefined, surround: { kind: 'helper', name: 'makeQueue' } })),
    ).toEqual({
      editable: false,
      reason: 'Created by the helper makeQueue',
    });
  });

  it('is locked when the Construct ID is not a string literal', () => {
    expect(nodeEditability('Api/Orders', facts({ literalId: undefined }))).toEqual({
      editable: false,
      reason: 'Its Construct ID is not a string literal',
    });
  });

  it('is locked when the literal ID is not the last part of its path', () => {
    expect(nodeEditability('Api/Jobs', facts({ literalId: 'Other' }))).toEqual({
      editable: false,
      reason: 'Its Construct ID in the code, "Other", is not the end of its path Api/Jobs',
    });
  });

  it('is locked when several paths come from one span outside a Stack or Stage class', () => {
    expect(nodeEditability('Api/Jobs', facts({ pathsOnSpan: 3, enclosingClass: undefined }))).toEqual({
      editable: false,
      reason: 'The same `new` call creates 3 constructs',
    });
  });

  it('stays editable when the span repeats only because its Stack class is created more than once (ADR 0008)', () => {
    expect(nodeEditability('Dev/Jobs', facts({ pathsOnSpan: 2 }))).toEqual({ editable: true });
    expect(
      nodeEditability('Dev/Jobs', facts({ pathsOnSpan: 2, enclosingClass: { name: 'AppStage', kind: 'stage' } })),
    ).toEqual({
      editable: true,
    });
  });

  it('still locks a repeated span in a loop, even inside a Stack class', () => {
    expect(nodeEditability('Dev/Loop1', facts({ pathsOnSpan: 4, surround: { kind: 'loop' } }))).toMatchObject({
      editable: false,
    });
  });

  it('names the construct class before any other reason', () => {
    const inClass = facts({
      enclosingClass: { name: 'ApiService', kind: 'construct' },
      surround: { kind: 'loop' },
      literalId: undefined,
    });
    expect(nodeEditability('Api/Service/Q', inClass)).toMatchObject({
      reason: 'Created inside ApiService, a construct class of your own',
    });
  });

  it('is locked for a resource the app refers to with a `fromXxx` call, which creates nothing to edit', () => {
    expect(
      nodeEditability(
        'Api/Existing',
        facts({ literalId: 'Existing', className: 's3.Bucket.fromBucketName', external: true }),
      ),
    ).toEqual({
      editable: false,
      reason: 'Refers to an existing resource; the app does not create it',
    });
  });
});
