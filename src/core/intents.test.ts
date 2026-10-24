import { describe, expect, it } from 'vitest';
import {
  afterMoves,
  beforeMoves,
  createdPath,
  describeIntent,
  emptyDraftHistory,
  movesOf,
  onBase,
  redo,
  stage,
  undo,
  withIntents,
  type Intent,
  type PropValue,
} from './intents.ts';

const set = (prop: string[], value: PropValue, path = 'A/B'): Intent => ({
  type: 'setProp',
  path,
  expect: { className: 's3.Bucket', literalId: 'B' },
  prop,
  value,
});
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
  it.each<[PropValue, string]>([
    [bool(true), 'versioned → true'],
    [{ kind: 'string', value: 'a b' }, 'versioned → "a b"'],
    [{ kind: 'number', value: 3 }, 'versioned → 3'],
    [{ kind: 'enum', type: 'aws-cdk-lib.RemovalPolicy', member: 'DESTROY' }, 'versioned → RemovalPolicy.DESTROY'],
    [{ kind: 'duration', unit: 'seconds', amount: 30 }, 'versioned → 30 seconds'],
    [{ kind: 'size', unit: 'mebibytes', amount: 512 }, 'versioned → 512 mebibytes'],
  ])('writes %j as %s', (value, text) => {
    expect(describeIntent(set(['versioned'], value))).toBe(text);
  });

  it('writes a field of a prop with a dot', () => {
    expect(describeIntent(set(['partitionKey', 'name'], { kind: 'string', value: 'id' }))).toBe(
      'partitionKey.name → "id"',
    );
  });
});

describe('withIntents', () => {
  it('replaces a prop the code writes, adds one it does not, and builds the objects around a field', () => {
    const props = withIntents(
      { form: 'object', props: [{ name: 'versioned', kind: 'literal', text: 'true', value: true }] },
      [
        set(['versioned'], bool(false)),
        set(['bucketName'], { kind: 'string', value: 'x' }),
        set(['partitionKey', 'name'], { kind: 'string', value: 'id' }),
      ],
    );
    expect(props).toEqual({
      form: 'object',
      props: [
        { name: 'versioned', kind: 'literal', text: 'false', value: false },
        { name: 'bucketName', kind: 'literal', text: '"x"', value: 'x' },
        {
          name: 'partitionKey',
          kind: 'object',
          text: '{ … }',
          fields: [{ name: 'name', kind: 'literal', text: '"id"', value: 'id' }],
        },
      ],
    });
  });

  it('sets a field inside an object the code writes, keeping its other fields', () => {
    const props = withIntents(
      {
        form: 'object',
        props: [
          {
            name: 'k',
            kind: 'object',
            text: '{…}',
            fields: [
              { name: 'a', kind: 'literal', text: '1', value: 1 },
              { name: 'b', kind: 'literal', text: '2', value: 2 },
            ],
          },
        ],
      },
      [set(['k', 'a'], { kind: 'number', value: 9 })],
    );
    expect(props).toMatchObject({
      props: [
        {
          fields: [
            { name: 'a', value: 9 },
            { name: 'b', value: 2 },
          ],
        },
      ],
    });
  });

  it('shows enums and quantities as the code would write them', () => {
    expect(
      withIntents(undefined, [
        set(['p'], { kind: 'enum', type: 'aws-cdk-lib.aws_s3.BucketEncryption', member: 'KMS' }),
        set(['t'], { kind: 'duration', unit: 'days', amount: 2 }),
      ]),
    ).toEqual({
      form: 'object',
      props: [
        {
          name: 'p',
          kind: 'expression',
          text: 'BucketEncryption.KMS',
          member: { type: 'BucketEncryption', name: 'KMS' },
        },
        {
          name: 't',
          kind: 'expression',
          text: 'Duration.days(2)',
          quantity: { type: 'Duration', unit: 'days', amount: 2 },
        },
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
  const rename = (path: string, newId: string, literalId = path.split('/').at(-1)!): Intent => ({
    type: 'renameId',
    path,
    expect: { className: 's3.Bucket', literalId },
    newId,
  });

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
      expect(onBase([rename('A/B', 'C'), { ...edit, expect: { ...edit.expect, literalId: 'C' } }])[1]).toMatchObject({
        path: 'A/B',
        expect: { literalId: 'B' },
      });
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

describe('adding and copying', () => {
  const add: Intent = {
    type: 'addNode',
    path: 'S',
    expect: { className: 'Stack', literalId: 'S' },
    fqn: 'aws-cdk-lib.aws_s3.Bucket',
    id: 'Data',
    props: [],
  };
  const copy: Intent = { type: 'duplicate', path: 'S/A', expect: { className: 'X', literalId: 'A' }, newId: 'A2' };

  it('words them for the Draft list', () => {
    expect(describeIntent(add)).toBe('Add Bucket "Data"');
    expect(describeIntent(copy)).toBe('Duplicate as "A2"');
  });

  it('names the path of the construct they make', () => {
    expect(createdPath(add)).toBe('S/Data');
    expect(createdPath(copy)).toBe('S/A2');
    expect(
      createdPath({ type: 'renameId', path: 'S/A', expect: { className: 'X', literalId: 'A' }, newId: 'B' }),
    ).toBeUndefined();
  });

  it('keeps every one as its own step of undo', () => {
    const twice = stage(stage(emptyDraftHistory, add), add);
    expect(twice.intents).toHaveLength(2);
    expect(undo(twice).intents).toHaveLength(1);
  });

  it('names the Stack by its old path once it has been renamed', () => {
    const rename: Intent = { type: 'renameId', path: 'S', expect: { className: 'Stack', literalId: 'S' }, newId: 'T' };
    expect(onBase([rename, { ...add, path: 'T', expect: { className: 'Stack', literalId: 'T' } }])[1]).toMatchObject({
      path: 'S',
      expect: { literalId: 'S' },
    });
  });
});

describe('Reference intents', () => {
  const ref = (id: string) => ({ path: `A/${id}`, className: 'kms.Key', literalId: id });
  const expectB = { className: 's3.Bucket', literalId: 'B' };
  const add = (to: string, prop = 'encryptionKey'): Intent => ({
    type: 'addReference',
    path: 'A/B',
    expect: expectB,
    prop,
    to: ref(to),
  });
  const remove = (to: string, prop = 'encryptionKey'): Intent => ({
    type: 'removeReference',
    path: 'A/B',
    expect: expectB,
    prop,
    to: ref(to),
  });
  const repoint = (was: string, to: string, prop = 'encryptionKey'): Intent => ({
    type: 'repointReference',
    path: 'A/B',
    expect: expectB,
    prop,
    was: ref(was),
    to: ref(to),
  });

  it('words each of them for the Draft list', () => {
    expect(describeIntent(add('Key'))).toBe('encryptionKey → Key');
    expect(describeIntent({ ...(add('Key') as Extract<Intent, { type: 'addReference' }>), many: true })).toBe(
      'encryptionKey → add Key',
    );
    expect(describeIntent(remove('Key'))).toBe('encryptionKey → remove Key');
    expect(describeIntent(repoint('Key', 'Other'))).toBe('encryptionKey → Other (was Key)');
  });

  it('drops an added Reference that is then removed: it never reaches the code', () => {
    expect(stage(stage(emptyDraftHistory, add('Key')), remove('Key')).intents).toEqual([]);
  });

  it('keeps a removal of another Node, and of another prop, as an edit of its own', () => {
    expect(stage(stage(emptyDraftHistory, add('Key')), remove('Other')).intents).toHaveLength(2);
    expect(stage(stage(emptyDraftHistory, add('Key')), remove('Key', 'other')).intents).toHaveLength(2);
  });

  it('folds a re-point of a Reference just added into the add, and a run of re-points into one', () => {
    expect(stage(stage(emptyDraftHistory, add('Key')), repoint('Key', 'Other')).intents).toEqual([add('Other')]);
    expect(stage(stage(emptyDraftHistory, repoint('Key', 'Other')), repoint('Other', 'Third')).intents).toEqual([
      repoint('Key', 'Third'),
    ]);
  });

  it('drops a re-point that is pointed back, and turns a re-point then removal into the removal of the first Node', () => {
    expect(stage(stage(emptyDraftHistory, repoint('Key', 'Other')), repoint('Other', 'Key')).intents).toEqual([]);
    expect(stage(stage(emptyDraftHistory, repoint('Key', 'Other')), remove('Other')).intents).toEqual([remove('Key')]);
  });

  it('names the Nodes by their paths on the Base, after a rename', () => {
    const rename: Intent = {
      type: 'renameId',
      path: 'A/Key',
      expect: { className: 'kms.Key', literalId: 'Key' },
      newId: 'Vault',
    };
    const [, onDisk] = onBase([
      rename,
      {
        ...(add('Vault') as Extract<Intent, { type: 'addReference' }>),
        to: { path: 'A/Vault', className: 'kms.Key', literalId: 'Vault' },
      },
    ]);
    expect(onDisk).toMatchObject({ type: 'addReference', to: { path: 'A/Key', literalId: 'Key' } });
  });
});

describe('stage with Connection edits', () => {
  const self = {
    path: 'S/A',
    expect: { className: 's3.Bucket', literalId: 'A' },
    peer: { path: 'S/B', className: 'lambda.Function', literalId: 'B' },
    kind: 'grant' as const,
  };
  const plan = (method: string[]) => ({ on: 'self' as const, method, args: ['{peer}'], role: 'primary' as const });
  const add = (method: string[]): Intent => ({ type: 'addConnection', ...self, calls: [plan(method)] });
  const refOf = (method: string[]) => ({ role: 'primary' as const, on: 'S/A', peer: 'S/B', method });

  it('cancels a Connection that is added and then removed, and keeps the edit when a different call is removed', () => {
    const added = stage(emptyDraftHistory, add(['grantRead']));
    expect(stage(added, { type: 'removeConnection', ...self, calls: [refOf(['grantRead'])] }).intents).toEqual([]);
    expect(stage(added, { type: 'removeConnection', ...self, calls: [refOf(['grantWrite'])] }).intents).toHaveLength(2);
  });

  it('turns an added Connection that is then changed into the one Connection it ends as', () => {
    const added = stage(emptyDraftHistory, add(['grantRead']));
    const changed = stage(added, {
      type: 'replaceConnection',
      ...self,
      was: [refOf(['grantRead'])],
      calls: [plan(['grantWrite'])],
    });
    expect(changed.intents).toEqual([add(['grantWrite'])]);
  });

  it('words a Connection in the Draft list', () => {
    expect(describeIntent(add(['grants', 'read']))).toBe('Connect B: grants.read');
  });
});
