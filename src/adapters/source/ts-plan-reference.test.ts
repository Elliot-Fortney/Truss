import { describe, expect, it } from 'vitest';
import type { Assembly } from '../../core/assembly.ts';
import { applyChanges } from '../../core/diff.ts';
import type { Intent, NodeRef } from '../../core/intents.ts';
import type { FileSet } from '../../core/ports.ts';
import { TsSource } from './ts-source.ts';

const source = new TsSource();

/** An app of one file: each construct in `needles` is the `new` that starts where the needle does, in a Stack called `S`. */
function app(text: string, needles: Record<string, string>, extra: Record<string, string> = {}) {
  const files: FileSet = new Map([['lib/app.ts', text], ...Object.entries(extra)]);
  const frame = (needle: string) => {
    const at = text.indexOf(needle);
    if (at < 0) throw new Error(`no ${needle}`);
    const before = text.slice(0, at);
    return { file: 'lib/app.ts', line: before.split('\n').length, col: at - before.lastIndexOf('\n') };
  };
  const assembly: Assembly = {
    schemaVersion: '1',
    tree: {
      id: 'App',
      path: '',
      fqn: 'aws-cdk-lib.App',
      children: [
        {
          id: 'S',
          path: 'S',
          fqn: 'aws-cdk-lib.Stack',
          children: Object.keys(needles).map((id) => ({ id, path: `S/${id}`, fqn: 'x', children: [] })),
        },
      ],
    },
    stacks: [{ path: 'S' }],
    creation: {
      S: [{ file: 'bin/app.ts', line: 1, col: 1 }],
      ...Object.fromEntries(Object.entries(needles).map(([id, needle]) => [`S/${id}`, [frame(needle)]])),
    },
    resourceRefs: [],
  };
  const facts = source.analyse(files, assembly);
  const ref = (id: string): NodeRef => ({
    path: `S/${id}`,
    className: facts.nodes[`S/${id}`]!.className,
    literalId: id,
  });
  const base = (id: string, prop: string) => ({
    path: `S/${id}`,
    expect: { className: facts.nodes[`S/${id}`]!.className, literalId: id },
    prop,
  });
  const run = (...intents: Intent[]) => {
    const result = source.plan(files, facts, intents);
    if (!result.ok) return result;
    return {
      ok: true as const,
      text: result.changes['lib/app.ts'] ? applyChanges(text, result.changes['lib/app.ts']) : text,
      changes: result.changes,
    };
  };
  const text_ = (...intents: Intent[]) => {
    const r = run(...intents);
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    return r.text;
  };
  const add = (from: string, prop: string, to: string, many?: true): Intent => ({
    type: 'addReference',
    ...base(from, prop),
    ...(many ? { many } : {}),
    to: ref(to),
  });
  const remove = (from: string, prop: string, to: string): Intent => ({
    type: 'removeReference',
    ...base(from, prop),
    to: ref(to),
  });
  const repoint = (from: string, prop: string, was: string, to: string): Intent => ({
    type: 'repointReference',
    ...base(from, prop),
    was: ref(was),
    to: ref(to),
  });
  return { facts, run, text: text_, add, remove, repoint };
}

const HEAD = `import * as s3 from 'aws-cdk-lib/aws-s3';\nimport * as kms from 'aws-cdk-lib/aws-kms';\n`;
const stackOf = (body: string) =>
  `${HEAD}\nexport class S extends Stack {\n  constructor(scope: Construct, id: string) {\n    super(scope, id);\n\n${body}  }\n}\n`;

describe('addReference', () => {
  const body = `    const key = new kms.Key(this, 'Key');
    const other = new kms.Key(this, 'Other');
    const logs = new s3.Bucket(this, 'Logs');
    new s3.Bucket(this, 'Data', { versioned: true });
    new s3.Bucket(this, 'Plain');
`;
  const needles = {
    Key: "new kms.Key(this, 'Key'",
    Other: "new kms.Key(this, 'Other'",
    Logs: "new s3.Bucket(this, 'Logs'",
    Data: "new s3.Bucket(this, 'Data'",
    Plain: "new s3.Bucket(this, 'Plain'",
  };
  const a = app(stackOf(body), needles);

  it('adds the prop after the last one, named for the binding when it is the prop name', () => {
    expect(a.text(a.add('Data', 'encryptionKey', 'Key'))).toContain(
      "new s3.Bucket(this, 'Data', { versioned: true, encryptionKey: key });",
    );
  });

  it('writes a shorthand property when the binding has the prop name', () => {
    const b = app(
      stackOf(
        `    const encryptionKey = new kms.Key(this, 'Key');\n    new s3.Bucket(this, 'Data', { versioned: true });\n`,
      ),
      { Key: "new kms.Key(this, 'Key'", Data: "new s3.Bucket(this, 'Data'" },
    );
    expect(b.text(b.add('Data', 'encryptionKey', 'Key'))).toContain('{ versioned: true, encryptionKey });');
  });

  it('gives a construct that passes no props an object of its own', () => {
    expect(a.text(a.add('Plain', 'serverAccessLogsBucket', 'Logs'))).toContain(
      "new s3.Bucket(this, 'Plain', { serverAccessLogsBucket: logs });",
    );
  });

  it('refers to a Node kept in a field as this.field', () => {
    const b = app(stackOf(`    this.key = new kms.Key(this, 'Key');\n    new s3.Bucket(this, 'Data');\n`), {
      Key: "new kms.Key(this, 'Key'",
      Data: "new s3.Bucket(this, 'Data'",
    });
    expect(b.text(b.add('Data', 'encryptionKey', 'Key'))).toContain(
      "new s3.Bucket(this, 'Data', { encryptionKey: this.key });",
    );
  });

  it('refers to a Node kept in a class property initializer as this.field', () => {
    const text = `${HEAD}\nexport class S extends Stack {\n  private readonly key = new kms.Key(this, 'Key');\n\n  constructor(scope: Construct, id: string) {\n    super(scope, id);\n    new s3.Bucket(this, 'Data');\n  }\n}\n`;
    const b = app(text, { Key: "new kms.Key(this, 'Key'", Data: "new s3.Bucket(this, 'Data'" });
    expect(b.text(b.add('Data', 'encryptionKey', 'Key'))).toContain('{ encryptionKey: this.key }');
  });

  it('lays a new prop out the way a multi-line object is laid out', () => {
    const b = app(
      stackOf(
        `    const key = new kms.Key(this, 'Key');\n    new s3.Bucket(this, 'Data', {\n      versioned: true,\n    });\n`,
      ),
      { Key: "new kms.Key(this, 'Key'", Data: "new s3.Bucket(this, 'Data'" },
    );
    expect(b.text(b.add('Data', 'encryptionKey', 'Key'))).toContain(
      '{\n      versioned: true,\n      encryptionKey: key,\n    });',
    );
  });

  it('creates an array for a prop that takes several, and adds to one the code has', () => {
    const c = app(
      stackOf(
        `    const a = new iam.ManagedPolicy(this, 'A');\n    const b = new iam.ManagedPolicy(this, 'B');\n    new iam.Role(this, 'Empty');\n    new iam.Role(this, 'One', { managedPolicies: [a] });\n`,
      ),
      {
        A: "new iam.ManagedPolicy(this, 'A'",
        B: "new iam.ManagedPolicy(this, 'B'",
        Empty: "new iam.Role(this, 'Empty'",
        One: "new iam.Role(this, 'One'",
      },
    );
    expect(c.text(c.add('Empty', 'managedPolicies', 'A', true))).toContain(
      "new iam.Role(this, 'Empty', { managedPolicies: [a] });",
    );
    expect(c.text(c.add('One', 'managedPolicies', 'B', true))).toContain('{ managedPolicies: [a, b] }');
    expect(c.text(c.add('One', 'managedPolicies', 'B', true), c.add('Empty', 'managedPolicies', 'A', true))).toContain(
      '{ managedPolicies: [a] }',
    );
  });

  it('is refused for a Node the prop already points at', () => {
    const b = app(
      stackOf(`    const key = new kms.Key(this, 'Key');\n    new s3.Bucket(this, 'Data', { encryptionKey: key });\n`),
      { Key: "new kms.Key(this, 'Key'", Data: "new s3.Bucket(this, 'Data'" },
    );
    expect(b.run(b.add('Data', 'encryptionKey', 'Key'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('already points at'),
    });
  });

  it('is refused for a prop the code sets to an expression Truss leaves alone', () => {
    const b = app(
      stackOf(
        `    const key = new kms.Key(this, 'Key');\n    new s3.Bucket(this, 'Data', { encryptionKey: pick(key) });\n`,
      ),
      { Key: "new kms.Key(this, 'Key'", Data: "new s3.Bucket(this, 'Data'" },
    );
    expect(b.run(b.add('Data', 'encryptionKey', 'Key'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('leaves alone'),
    });
  });

  it('is refused for a Node that is not kept in a variable or a field', () => {
    const b = app(stackOf(`    new kms.Key(this, 'Key');\n    new s3.Bucket(this, 'Data');\n`), {
      Key: "new kms.Key(this, 'Key'",
      Data: "new s3.Bucket(this, 'Data'",
    });
    expect(b.run(b.add('Data', 'encryptionKey', 'Key'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("isn't kept in a variable"),
    });
  });

  it('is refused when the two Nodes have no scope in common', () => {
    const b = app(
      stackOf(
        `    const key = new kms.Key(this, 'Key');\n    if (flag) {\n      new s3.Bucket(this, 'Data');\n    }\n    if (other) {\n      const inner = new kms.Key(this, 'Inner');\n    }\n`,
      ),
      {
        Key: "new kms.Key(this, 'Key'",
        Data: "new s3.Bucket(this, 'Data'",
        Inner: "new kms.Key(this, 'Inner'",
      },
    );
    expect(b.text(b.add('Data', 'encryptionKey', 'Key'))).toContain('encryptionKey: key');
    expect(b.run(b.add('Data', 'encryptionKey', 'Inner'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no scope in common'),
    });
  });

  it('is refused when the Node in the Draft is not the one in the code', () => {
    const intent = a.add('Data', 'encryptionKey', 'Key');
    expect(
      a.run({ ...intent, to: { path: 'S/Key', className: 'kms.Other', literalId: 'Key' } } as Intent),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('no longer') });
  });
});

describe('removeReference', () => {
  const one = (props: string) =>
    app(stackOf(`    const key = new kms.Key(this, 'Key');\n    new s3.Bucket(this, 'Data', ${props});\n`), {
      Key: "new kms.Key(this, 'Key'",
      Data: "new s3.Bucket(this, 'Data'",
    });

  it('takes the prop out, with its comma', () => {
    const a = one('{ encryptionKey: key, versioned: true }');
    expect(a.text(a.remove('Data', 'encryptionKey', 'Key'))).toContain(
      "new s3.Bucket(this, 'Data', { versioned: true });",
    );
    const b = one('{ versioned: true, encryptionKey: key }');
    expect(b.text(b.remove('Data', 'encryptionKey', 'Key'))).toContain(
      "new s3.Bucket(this, 'Data', { versioned: true });",
    );
    const c = one('{ versioned: true, encryptionKey: key, enforceSSL: true }');
    expect(c.text(c.remove('Data', 'encryptionKey', 'Key'))).toContain('{ versioned: true, enforceSSL: true });');
  });

  it('takes a shorthand property out the same way', () => {
    const a = app(
      stackOf(
        `    const encryptionKey = new kms.Key(this, 'Key');\n    new s3.Bucket(this, 'Data', { versioned: true, encryptionKey });\n`,
      ),
      { Key: "new kms.Key(this, 'Key'", Data: "new s3.Bucket(this, 'Data'" },
    );
    expect(a.text(a.remove('Data', 'encryptionKey', 'Key'))).toContain('{ versioned: true });');
  });

  it('leaves an empty object when it was the only prop', () => {
    const a = one('{ encryptionKey: key }');
    expect(a.text(a.remove('Data', 'encryptionKey', 'Key'))).toContain("new s3.Bucket(this, 'Data', {});");
  });

  it('takes a line out of a multi-line object, keeping the trailing comma the object has', () => {
    const a = one('{\n      versioned: true,\n      encryptionKey: key,\n    }');
    expect(a.text(a.remove('Data', 'encryptionKey', 'Key'))).toContain('{\n      versioned: true,\n    });');
    const b = one('{\n      encryptionKey: key,\n      versioned: true,\n    }');
    expect(b.text(b.remove('Data', 'encryptionKey', 'Key'))).toContain('{\n      versioned: true,\n    });');
  });

  it('takes one element out of an array prop, and the prop when it was the last', () => {
    const a = app(
      stackOf(
        `    const a = new iam.ManagedPolicy(this, 'A');\n    const b = new iam.ManagedPolicy(this, 'B');\n    const c = new iam.ManagedPolicy(this, 'C');\n    new iam.Role(this, 'Role', { managedPolicies: [a, b, c] });\n    new iam.Role(this, 'Solo', { managedPolicies: [a] });\n`,
      ),
      {
        A: "new iam.ManagedPolicy(this, 'A'",
        B: "new iam.ManagedPolicy(this, 'B'",
        C: "new iam.ManagedPolicy(this, 'C'",
        Role: "new iam.Role(this, 'Role'",
        Solo: "new iam.Role(this, 'Solo'",
      },
    );
    expect(a.text(a.remove('Role', 'managedPolicies', 'B'))).toContain('{ managedPolicies: [a, c] }');
    expect(a.text(a.remove('Role', 'managedPolicies', 'C'))).toContain('{ managedPolicies: [a, b] }');
    expect(a.text(a.remove('Role', 'managedPolicies', 'A'))).toContain('{ managedPolicies: [b, c] }');
    expect(a.text(a.remove('Role', 'managedPolicies', 'B'), a.remove('Role', 'managedPolicies', 'C'))).toContain(
      '{ managedPolicies: [a] }',
    );
    expect(a.text(a.remove('Solo', 'managedPolicies', 'A'))).toContain("new iam.Role(this, 'Solo', {});");
  });

  it('is refused for a Node the prop does not point at', () => {
    const a = one('{ encryptionKey: key }');
    expect(a.run(a.remove('Data', 'serverAccessLogsBucket', 'Key'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("doesn't point at"),
    });
  });

  it('is refused for a Reference the code writes as a call', () => {
    const a = one('{ encryptionKey: pick(key) }');
    expect(a.run(a.remove('Data', 'encryptionKey', 'Key'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('leaves alone'),
    });
  });
});

describe('repointReference', () => {
  const two = app(
    stackOf(
      `    const key = new kms.Key(this, 'Key');\n    const other = new kms.Key(this, 'Other');\n    const encryptionKey = other;\n    new s3.Bucket(this, 'Data', { encryptionKey: key });\n    new s3.Bucket(this, 'Short', { encryptionKey: other });\n`,
    ),
    {
      Key: "new kms.Key(this, 'Key'",
      Other: "new kms.Key(this, 'Other'",
      Data: "new s3.Bucket(this, 'Data'",
      Short: "new s3.Bucket(this, 'Short'",
    },
  );

  it('writes the other Node in the place of the first', () => {
    expect(two.text(two.repoint('Data', 'encryptionKey', 'Key', 'Other'))).toContain(
      "new s3.Bucket(this, 'Data', { encryptionKey: other });",
    );
  });

  it('turns a shorthand property into a full one', () => {
    const a = app(
      stackOf(
        `    const encryptionKey = new kms.Key(this, 'Key');\n    const other = new kms.Key(this, 'Other');\n    new s3.Bucket(this, 'Data', { encryptionKey });\n`,
      ),
      { Key: "new kms.Key(this, 'Key'", Other: "new kms.Key(this, 'Other'", Data: "new s3.Bucket(this, 'Data'" },
    );
    expect(a.text(a.repoint('Data', 'encryptionKey', 'Key', 'Other'))).toContain('{ encryptionKey: other }');
  });

  it('writes a shorthand property when the new Node is bound to the prop name', () => {
    const a = app(
      stackOf(
        `    const key = new kms.Key(this, 'Key');\n    const encryptionKey = new kms.Key(this, 'Other');\n    new s3.Bucket(this, 'Data', { encryptionKey: key });\n`,
      ),
      { Key: "new kms.Key(this, 'Key'", Other: "new kms.Key(this, 'Other'", Data: "new s3.Bucket(this, 'Data'" },
    );
    expect(a.text(a.repoint('Data', 'encryptionKey', 'Key', 'Other'))).toContain('{ encryptionKey }');
  });

  it('writes the other Node in the place of one element of an array', () => {
    const a = app(
      stackOf(
        `    const a = new iam.ManagedPolicy(this, 'A');\n    const b = new iam.ManagedPolicy(this, 'B');\n    const c = new iam.ManagedPolicy(this, 'C');\n    new iam.Role(this, 'Role', { managedPolicies: [a, b] });\n`,
      ),
      {
        A: "new iam.ManagedPolicy(this, 'A'",
        B: "new iam.ManagedPolicy(this, 'B'",
        C: "new iam.ManagedPolicy(this, 'C'",
        Role: "new iam.Role(this, 'Role'",
      },
    );
    expect(a.text(a.repoint('Role', 'managedPolicies', 'A', 'C'))).toContain('{ managedPolicies: [c, b] }');
  });

  it('is refused for a Node the prop does not point at', () => {
    expect(two.run(two.repoint('Data', 'encryptionKey', 'Other', 'Key'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("doesn't point at"),
    });
  });
});

describe('a Reference to a Node made later', () => {
  const text = stackOf(`    // The data.
    const data = new s3.Bucket(this, 'Data', { versioned: true }); // keep
    const unrelated = new s3.Bucket(this, 'Unrelated');

    // The key.
    const key = new kms.Key(this, 'Key');
    const after = new s3.Bucket(this, 'After');
`);
  const needles = {
    Data: "new s3.Bucket(this, 'Data'",
    Unrelated: "new s3.Bucket(this, 'Unrelated'",
    Key: "new kms.Key(this, 'Key'",
    After: "new s3.Bucket(this, 'After'",
  };
  const a = app(text, needles);

  it('moves the source statement below the Node, with the comment above it, and writes the Reference in it', () => {
    const out = a.text(a.add('Data', 'encryptionKey', 'Key'));
    expect(out).toContain(`    const unrelated = new s3.Bucket(this, 'Unrelated');

    // The key.
    const key = new kms.Key(this, 'Key');
    // The data.
    const data = new s3.Bucket(this, 'Data', { versioned: true, encryptionKey: key }); // keep
    const after = new s3.Bucket(this, 'After');
`);
    expect(out.match(/'Data'/g)).toHaveLength(1);
  });

  it('marks the changes that move the statement', () => {
    const r = a.run(a.add('Data', 'encryptionKey', 'Key'));
    if (!r.ok) throw new Error(r.reason);
    expect(r.changes['lib/app.ts']!.filter((c) => c.purpose === 'move')).toHaveLength(2);
  });

  it('moves it only once for two Nodes made after it, below the last', () => {
    const b = app(
      stackOf(
        `    const data = new s3.Bucket(this, 'Data');\n    const key = new kms.Key(this, 'Key');\n    const logs = new s3.Bucket(this, 'Logs');\n`,
      ),
      { Data: "new s3.Bucket(this, 'Data'", Key: "new kms.Key(this, 'Key'", Logs: "new s3.Bucket(this, 'Logs'" },
    );
    const out = b.text(b.add('Data', 'encryptionKey', 'Key'), b.add('Data', 'serverAccessLogsBucket', 'Logs'));
    expect(out).toContain(
      "const logs = new s3.Bucket(this, 'Logs');\n    const data = new s3.Bucket(this, 'Data', { encryptionKey: key, serverAccessLogsBucket: logs });",
    );
  });

  it('is refused while something between uses the source', () => {
    const b = app(
      stackOf(
        `    const data = new s3.Bucket(this, 'Data');\n    data.addToResourcePolicy(policy);\n    const key = new kms.Key(this, 'Key');\n`,
      ),
      { Data: "new s3.Bucket(this, 'Data'", Key: "new kms.Key(this, 'Key'" },
    );
    expect(b.run(b.add('Data', 'encryptionKey', 'Key'))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/used on line \d+, before Key is made/),
    });
  });

  it('is refused when the source statement does more than make the source', () => {
    const b = app(
      stackOf(`    const data = new s3.Bucket(this, 'Data'), side = 1;\n    const key = new kms.Key(this, 'Key');\n`),
      { Data: "new s3.Bucket(this, 'Data'", Key: "new kms.Key(this, 'Key'" },
    );
    expect(b.run(b.add('Data', 'encryptionKey', 'Key'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('does more than make it'),
    });
  });

  it('is refused when the two are not in the same block', () => {
    const b = app(
      stackOf(
        `    if (flag) {\n      new s3.Bucket(this, 'Data');\n    }\n    const key = new kms.Key(this, 'Key');\n`,
      ),
      { Data: "new s3.Bucket(this, 'Data'", Key: "new kms.Key(this, 'Key'" },
    );
    expect(b.run(b.add('Data', 'encryptionKey', 'Key'))).toMatchObject({ ok: false });
  });

  it('moves a statement that keeps its construct in a field', () => {
    const b = app(
      stackOf(`    this.data = new s3.Bucket(this, 'Data');\n    const key = new kms.Key(this, 'Key');\n`),
      { Data: "new s3.Bucket(this, 'Data'", Key: "new kms.Key(this, 'Key'" },
    );
    expect(b.text(b.add('Data', 'encryptionKey', 'Key'))).toContain(
      "const key = new kms.Key(this, 'Key');\n    this.data = new s3.Bucket(this, 'Data', { encryptionKey: key });",
    );
  });
});
