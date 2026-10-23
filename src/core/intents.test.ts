import { describe, expect, it } from 'vitest';
import { afterMoves, beforeMoves, describeIntent, emptyDraftHistory, movesOf, onBase, redo, stage, undo, withIntents, type Intent, type PropValue } from './intents.ts';

const set = (prop: string[], value: PropValue, path = 'A/B'): Intent => ({ type: 'setProp', path, expect: { className: 's3.Bucket', literalId: 'B' }, prop, value });
const bool = (value: boolean): PropValue => ({ kind: 'boolean', value });

describe('the Draft', () => {
  it('stages intents in order, and undo pops while redo pushes', () => {
    const a = set(['versioned'], bool(true));
    const b = set(['bucketName'], { kind: 'string', value: 'x' });
    let draft = stage(stage(emptyDraftHistory, a), b);
    expect(draft.intents).toEqual([a, b]);
    draft = undo(draft);
    expect(draft).toEqual({ intents: [a], redo: [b] });
    draft = redo(draft);
    expect(draft).toEqual({ intents: [a, b], redo: [] });
  });

  it('does nothing to undo an empty Draft or redo with nothing undone', () => {
    expect(undo(emptyDraftHistory)).toBe(emptyDraftHistory);
    expect(redo(emptyDraftHistory)).toBe(emptyDraftHistory);
  });

  it('ends redo with a new edit', () => {
    const draft = stage(undo(stage(emptyDraftHistory, set(['a'], bool(true)))), set(['b'], bool(true)));
    expect(draft.redo).toEqual([]);
  });

  it('replaces the last intent when the same prop is set again, and not when another prop or Node comes between', () => {
    const first = stage(emptyDraftHistory, set(['a'], bool(true)));
    expect(stage(first, set(['a'], bool(false))).intents).toEqual([set(['a'], bool(false))]);
    expect(stage(first, set(['a', 'b'], bool(false))).intents).toHaveLength(2);
    expect(stage(first, set(['a'], bool(false), 'A/Other')).intents).toHaveLength(2);
    const between = stage(stage(first, set(['b'], bool(true))), set(['a'], bool(false)));
    expect(between.intents).toHaveLength(3);
  });
});

describe('describeIntent', () => {
  it.each([
    [bool(true), 'versioned → true'],
    [{ kind: 'string', value: 'a b' } as PropValue, 'versioned → "a b"'],
    [{ kind: 'number', value: 3 } as PropValue, 'versioned → 3'],
    [{ kind: 'enum', type: 'aws-cdk-lib.RemovalPolicy', member: 'DESTROY' } as PropValue, 'versioned → RemovalPolicy.DESTROY'],
    [{ kind: 'duration', unit: 'seconds', amount: 30 } as PropValue, 'versioned → 30 seconds'],
    [{ kind: 'size', unit: 'mebibytes', amount: 512 } as PropValue, 'versioned → 512 mebibytes'],
  ])('writes %j as %s', (value, text) => {
    expect(describeIntent(set(['versioned'], value))).toBe(text);
  });

  it('writes a field of a prop with a dot', () => {
    expect(describeIntent(set(['partitionKey', 'name'], { kind: 'string', value: 'id' }))).toBe('partitionKey.name → "id"');
  });
});

describe('withIntents', () => {
  it('replaces a prop the code writes, adds one it does not, and builds the objects around a field', () => {
    const props = withIntents(
      { form: 'object', props: [{ name: 'versioned', kind: 'literal', text: 'true', value: true }] },
      [set(['versioned'], bool(false)), set(['bucketName'], { kind: 'string', value: 'x' }), set(['partitionKey', 'name'], { kind: 'string', value: 'id' })],
    );
    expect(props).toEqual({
      form: 'object',
      props: [
        { name: 'versioned', kind: 'literal', text: 'false', value: false },
        { name: 'bucketName', kind: 'literal', text: '"x"', value: 'x' },
        { name: 'partitionKey', kind: 'object', text: '{ … }', fields: [{ name: 'name', kind: 'literal', text: '"id"', value: 'id' }] },
      ],
    });
  });

  it('sets a field inside an object the code writes, keeping its other fields', () => {
    const props = withIntents(
      { form: 'object', props: [{ name: 'k', kind: 'object', text: '{…}', fields: [{ name: 'a', kind: 'literal', text: '1', value: 1 }, { name: 'b', kind: 'literal', text: '2', value: 2 }] }] },
      [set(['k', 'a'], { kind: 'number', value: 9 })],
    );
    expect(props).toMatchObject({ props: [{ fields: [{ name: 'a', value: 9 }, { name: 'b', value: 2 }] }] });
  });

  it('shows enums and quantities as the code would write them', () => {
    expect(withIntents(undefined, [set(['p'], { kind: 'enum', type: 'aws-cdk-lib.aws_s3.BucketEncryption', member: 'KMS' }), set(['t'], { kind: 'duration', unit: 'days', amount: 2 })])).toEqual({
      form: 'object',
      props: [
        { name: 'p', kind: 'expression', text: 'BucketEncryption.KMS', member: { type: 'BucketEncryption', name: 'KMS' } },
        { name: 't', kind: 'expression', text: 'Duration.days(2)', quantity: { type: 'Duration', unit: 'days', amount: 2 } },
      ],
    });
  });

  it('leaves props passed as a variable, and a construct with no intents, as they are', () => {
    const other = { form: 'other' as const, text: 'tableProps' };
    expect(withIntents(other, [set(['a'], bool(true))])).toBe(other);
    expect(withIntents(undefined, [])).toBeUndefined();
  });
});

describe('renameId', () => {
  const rename = (path: string, newId: string, literalId = path.split('/').at(-1)!): Intent => ({ type: 'renameId', path, expect: { className: 's3.Bucket', literalId }, newId });

  it('is worded for the Draft list', () => {
    expect(describeIntent(rename('A/B', 'C'))).toBe('Construct ID → "C"');
  });

  it('is one undo step for a run of renames of the same Node, named by the Base’s path and ID', () => {
    const run = stage(stage(emptyDraftHistory, rename('A/B', 'Ca')), rename('A/Ca', 'Cat'));
    expect(run.intents).toEqual([rename('A/B', 'Cat')]);
  });

  it('is no edit at all once the Node is given its first ID back', () => {
    const back = stage(stage(emptyDraftHistory, rename('A/B', 'C')), rename('A/C', 'B'));
    expect(back.intents).toEqual([]);
  });

  it('does not join a rename to an edit of a prop, or of another Node', () => {
    const first = stage(emptyDraftHistory, set(['a'], bool(true), 'A/C'));
    expect(stage(first, rename('A/C', 'D')).intents).toHaveLength(2);
    expect(stage(stage(emptyDraftHistory, rename('A/B', 'C')), rename('A/Other', 'D')).intents).toHaveLength(2);
  });

  it('leaves the props of a Node it renames alone in the panel', () => {
    expect(withIntents({ form: 'object', props: [] }, [rename('A/B', 'C')])).toEqual({ form: 'object', props: [] });
    expect(withIntents(undefined, [rename('A/B', 'C')])).toBeUndefined();
  });

  describe('moves', () => {
    const moves = movesOf([rename('A/B', 'C'), set(['x'], bool(true), 'A/C'), rename('A', 'Z')]);

    it('are the renames, each as the paths stood when it was made', () => {
      expect(moves).toEqual([
        { from: 'A/B', to: 'A/C' },
        { from: 'A', to: 'Z' },
      ]);
    });

    it('take a path and what is beneath it to the new one, and back', () => {
      expect(afterMoves(moves, 'A/B')).toBe('Z/C');
      expect(afterMoves(moves, 'A/B/Resource')).toBe('Z/C/Resource');
      expect(afterMoves(moves, 'AB/B')).toBe('AB/B');
      expect(beforeMoves(moves, 'Z/C/Resource')).toBe('A/B/Resource');
      expect(beforeMoves(moves, 'Y/B')).toBe('Y/B');
    });
  });

  describe('onBase', () => {
    it('names the Base’s path and ID in an edit made after a rename', () => {
      const edit = set(['a'], bool(true), 'A/C');
      expect(onBase([rename('A/B', 'C'), { ...edit, expect: { ...edit.expect, literalId: 'C' } }])[1]).toMatchObject({ path: 'A/B', expect: { literalId: 'B' } });
    });

    it('keeps the ID an edit expects when it is a Node beneath the renamed one that it names', () => {
      const edit = set(['a'], bool(true), 'Z/Q');
      const [, onDisk] = onBase([rename('A', 'Z'), { ...edit, expect: { ...edit.expect, literalId: 'Q' } }]);
      expect(onDisk).toMatchObject({ path: 'A/Q', expect: { literalId: 'Q' } });
    });

    it('is the intents themselves when nothing was renamed', () => {
      const intents = [set(['a'], bool(true))];
      expect(onBase(intents)[0]).toBe(intents[0]);
    });
  });
});
