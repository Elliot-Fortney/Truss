import { describe, expect, it } from 'vitest';
import { applyChanges, unifiedDiff } from '../../core/diff.ts';
import type { Facts } from '../../core/facts.ts';
import type { Intent, PropValue } from '../../core/intents.ts';
import type { FileSet } from '../../core/ports.ts';
import { TsSource } from './ts-source.ts';

const FILE = 'lib/stack.ts';

/** Facts for each `new X(this, 'Id'` in `text`, as `analyse` would report them (only what `plan` reads). */
function factsOf(text: string): Facts {
  const nodes: Facts['nodes'] = {};
  for (const m of text.matchAll(/new ([\w.]+)\(this, ['"`](\w+)['"`]/g)) {
    const before = text.slice(0, m.index);
    const line = before.split('\n').length;
    const col = m.index - before.lastIndexOf('\n');
    nodes[`Stack/${m[2]}`] = {
      span: { file: FILE, start: { line, col }, end: { line, col } },
      className: m[1]!,
      literalId: m[2]!,
      pathsOnSpan: 1,
      binding: 'none',
    };
  }
  return { nodes };
}

const set = (id: string, className: string, prop: string | string[], value: PropValue): Intent => ({
  type: 'setProp',
  path: `Stack/${id}`,
  expect: { className, literalId: id },
  prop: Array.isArray(prop) ? prop : [prop],
  value,
});
const str = (value: string): PropValue => ({ kind: 'string', value });

const source = new TsSource();

/** What Save would write: the file after the planned changes, or the refusal. */
function plan(text: string, ...intents: Intent[]) {
  const files: FileSet = new Map([[FILE, text]]);
  const result = source.plan(files, factsOf(text), intents);
  if (!result.ok) return result;
  const changes = result.changes[FILE];
  return { ok: true as const, after: changes ? applyChanges(text, changes) : text, changes: result.changes };
}

const after = (text: string, ...intents: Intent[]): string => {
  const r = plan(text, ...intents);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.after;
};

const bucket = (body: string) => `import * as s3 from 'aws-cdk-lib/aws-s3';

export class S extends Stack {
  constructor() {
${body}
  }
}
`;

describe('Source.plan golden diffs', () => {
  it('edits a literal in place', () => {
    const text = bucket(`    new s3.Bucket(this, 'Uploads', {
      versioned: true,
    });`);
    const r = plan(text, set('Uploads', 's3.Bucket', 'versioned', { kind: 'boolean', value: false }));
    expect(r.ok && unifiedDiff(FILE, text, r.after)?.diff).toBe(`--- a/lib/stack.ts
+++ b/lib/stack.ts
@@ -3,7 +3,7 @@
 export class S extends Stack {
   constructor() {
     new s3.Bucket(this, 'Uploads', {
-      versioned: true,
+      versioned: false,
     });
   }
 }
`);
  });

  it('appends a prop after the last one in a multi-line object', () => {
    const text = bucket(`    new s3.Bucket(this, 'Uploads', {
      versioned: true,
    });`);
    const r = plan(text, set('Uploads', 's3.Bucket', 'bucketName', str('uploads')));
    expect(r.ok && unifiedDiff(FILE, text, r.after)?.diff).toBe(`--- a/lib/stack.ts
+++ b/lib/stack.ts
@@ -4,6 +4,7 @@
   constructor() {
     new s3.Bucket(this, 'Uploads', {
       versioned: true,
+      bucketName: 'uploads',
     });
   }
 }
`);
  });

  it('appends inside a single-line object, keeping its spacing', () => {
    expect(
      after(
        bucket(`    new s3.Bucket(this, 'A', { versioned: true });`),
        set('A', 's3.Bucket', 'bucketName', str('a')),
      ),
    ).toContain(`{ versioned: true, bucketName: 'a' }`);
    expect(
      after(bucket(`    new s3.Bucket(this, 'A', {versioned: true});`), set('A', 's3.Bucket', 'bucketName', str('a'))),
    ).toContain(`{versioned: true, bucketName: 'a'}`);
    expect(
      after(
        bucket(`    new s3.Bucket(this, 'A', { versioned: true, });`),
        set('A', 's3.Bucket', 'bucketName', str('a')),
      ),
    ).toContain(`{ versioned: true, bucketName: 'a', }`);
  });

  it('puts the prop after a spread, where it wins', () => {
    const text = bucket(`    new s3.Bucket(this, 'A', {
      ...defaults,
    });`);
    expect(after(text, set('A', 's3.Bucket', 'versioned', { kind: 'boolean', value: true })))
      .toContain(`      ...defaults,
      versioned: true,
    });`);
  });

  it('fills an empty object', () => {
    expect(
      after(
        bucket(`    new s3.Bucket(this, 'A', {});`),
        set('A', 's3.Bucket', 'versioned', { kind: 'boolean', value: true }),
      ),
    ).toContain(`new s3.Bucket(this, 'A', { versioned: true });`);
  });

  it('adds an object literal when the props are omitted', () => {
    const text = bucket(`    new s3.Bucket(this, 'Uploads');`);
    const r = plan(text, set('Uploads', 's3.Bucket', 'versioned', { kind: 'boolean', value: true }));
    expect(r.ok && unifiedDiff(FILE, text, r.after)?.diff).toBe(
      [
        '--- a/lib/stack.ts',
        '+++ b/lib/stack.ts',
        '@@ -2,6 +2,6 @@',
        ' ',
        ' export class S extends Stack {',
        '   constructor() {',
        "-    new s3.Bucket(this, 'Uploads');",
        "+    new s3.Bucket(this, 'Uploads', { versioned: true });",
        '   }',
        ' }',
        '',
      ].join('\n'),
    );
  });

  it('puts several props into the object it adds, and a later edit of the same prop wins', () => {
    const out = after(
      bucket(`    new s3.Bucket(this, 'A');`),
      set('A', 's3.Bucket', 'versioned', { kind: 'boolean', value: true }),
      set('A', 's3.Bucket', 'bucketName', str('one')),
      set('A', 's3.Bucket', 'bucketName', str('two')),
    );
    expect(out).toContain(`new s3.Bucket(this, 'A', { versioned: true, bucketName: 'two' });`);
  });

  it('edits the field of an object-literal prop, and creates the object when the prop is missing', () => {
    const text = bucket(`    new dynamodb.Table(this, 'T', {
      partitionKey: { name: 'sku', type: dynamodb.AttributeType.STRING },
    });
    new dynamodb.Table(this, 'U', {});`);
    expect(after(text, set('T', 'dynamodb.Table', ['partitionKey', 'name'], str('id')))).toContain(
      `partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING }`,
    );
    expect(after(text, set('T', 'dynamodb.Table', ['partitionKey', 'sortKey'], str('x')))).toContain(
      `partitionKey: { name: 'sku', type: dynamodb.AttributeType.STRING, sortKey: 'x' }`,
    );
    expect(after(text, set('U', 'dynamodb.Table', ['partitionKey', 'name'], str('id')))).toContain(
      `new dynamodb.Table(this, 'U', { partitionKey: { name: 'id' } });`,
    );
  });

  it('edits each construct of a line of constructs, without disturbing the others', () => {
    const text = bucket(`    new s3.Bucket(this, 'A'); new s3.Bucket(this, 'B');`);
    expect(after(text, set('B', 's3.Bucket', 'versioned', { kind: 'boolean', value: true }))).toContain(
      `new s3.Bucket(this, 'A'); new s3.Bucket(this, 'B', { versioned: true });`,
    );
  });

  it('edits a construct nested in another one’s props', () => {
    const text = bucket(
      `    new s3.Bucket(this, 'Outer', { eventBridgeEnabled: true, serverAccessLogsBucket: new s3.Bucket(this, 'Inner') });`,
    );
    const out = after(
      text,
      set('Inner', 's3.Bucket', 'versioned', { kind: 'boolean', value: true }),
      set('Outer', 's3.Bucket', 'versioned', { kind: 'boolean', value: true }),
    );
    expect(out).toContain(
      `new s3.Bucket(this, 'Outer', { eventBridgeEnabled: true, serverAccessLogsBucket: new s3.Bucket(this, 'Inner', { versioned: true }), versioned: true })`,
    );
  });

  it('keeps a comment after the last prop on its line', () => {
    const text = bucket(`    new s3.Bucket(this, 'A', {
      versioned: true, // keep
    });
    new s3.Bucket(this, 'B', {
      versioned: true // keep
    });`);
    const out = after(
      text,
      set('A', 's3.Bucket', 'bucketName', str('a')),
      set('B', 's3.Bucket', 'bucketName', str('b')),
    );
    expect(out).toContain(`      versioned: true, // keep
      bucketName: 'a',
    });`);
    expect(out).toContain(`      versioned: true, // keep
      bucketName: 'b'
    });`);
  });

  it('keeps how the code writes a Duration, an enum and a quote it already uses', () => {
    const text = bucket(`    new sqs.Queue(this, 'Q', {
      visibilityTimeout: cdk.Duration.seconds(30),
      encryption: sqs.QueueEncryption.KMS,
      queueName: "q",
    });`);
    const out = after(
      text,
      set('Q', 'sqs.Queue', 'visibilityTimeout', { kind: 'duration', unit: 'minutes', amount: 2 }),
      set('Q', 'sqs.Queue', 'encryption', {
        kind: 'enum',
        type: 'aws-cdk-lib.aws_sqs.QueueEncryption',
        member: 'SQS_MANAGED',
      }),
      set('Q', 'sqs.Queue', 'queueName', str('it"s')),
    );
    expect(out).toContain(`visibilityTimeout: cdk.Duration.minutes(2),`);
    expect(out).toContain(`encryption: sqs.QueueEncryption.SQS_MANAGED,`);
    expect(out).toContain(`queueName: "it\\"s",`);
  });

  it('writes numbers, negative numbers and sizes', () => {
    const text = bucket(`    new X.Y(this, 'A', { n: 1, s: Size.mebibytes(1) });`);
    const out = after(
      text,
      set('A', 'X.Y', 'n', { kind: 'number', value: -2.5 }),
      set('A', 'X.Y', 's', { kind: 'size', unit: 'gibibytes', amount: 4 }),
    );
    expect(out).toContain(`{ n: -2.5, s: Size.gibibytes(4) }`);
  });
});

describe('Source.plan imports', () => {
  const edit = (text: string, value: PropValue) => after(text, set('A', 'X.Y', 'p', value));
  const duration: PropValue = { kind: 'duration', unit: 'seconds', amount: 5 };
  const removal: PropValue = { kind: 'enum', type: 'aws-cdk-lib.RemovalPolicy', member: 'DESTROY' };
  const encryption: PropValue = { kind: 'enum', type: 'aws-cdk-lib.aws_s3.BucketEncryption', member: 'KMS' };

  it('uses the alias the file already imports aws-cdk-lib as', () => {
    const out = edit(`import * as cdk from 'aws-cdk-lib';\nnew X.Y(this, 'A');\n`, duration);
    expect(out).toContain(`new X.Y(this, 'A', { p: cdk.Duration.seconds(5) });`);
    expect(out.split('\n').filter((l) => l.startsWith('import'))).toEqual([`import * as cdk from 'aws-cdk-lib';`]);
  });

  it('uses a name the file already imports', () => {
    const out = edit(`import { Duration } from 'aws-cdk-lib';\nnew X.Y(this, 'A');\n`, duration);
    expect(out).toContain(`{ p: Duration.seconds(5) }`);
  });

  it('adds the name to an existing named import', () => {
    expect(edit(`import { Stack } from 'aws-cdk-lib';\nnew X.Y(this, 'A');\n`, duration)).toBe(
      `import { Stack, Duration } from 'aws-cdk-lib';\nnew X.Y(this, 'A', { p: Duration.seconds(5) });\n`,
    );
    expect(edit(`import {\n  Stack,\n} from 'aws-cdk-lib';\nnew X.Y(this, 'A');\n`, removal)).toContain(
      `import {\n  Stack,\n  RemovalPolicy,\n} from 'aws-cdk-lib';`,
    );
  });

  it('adds a named import in the file’s quote and semicolon style when it imports nothing from the module', () => {
    expect(edit(`import { Construct } from "constructs"\nnew X.Y(this, 'A');\n`, duration)).toBe(
      `import { Construct } from "constructs"\nimport { Duration } from "aws-cdk-lib"\nnew X.Y(this, 'A', { p: Duration.seconds(5) });\n`,
    );
    expect(edit(`new X.Y(this, 'A');\n`, duration)).toBe(
      `import { Duration } from 'aws-cdk-lib';\nnew X.Y(this, 'A', { p: Duration.seconds(5) });\n`,
    );
  });

  it('imports the module of a service enum as a namespace, with the alias CDK apps use', () => {
    const out = edit(`import * as sqs from 'aws-cdk-lib/aws-sqs';\nnew X.Y(this, 'A');\n`, encryption);
    expect(out).toBe(
      `import * as sqs from 'aws-cdk-lib/aws-sqs';\nimport * as s3 from 'aws-cdk-lib/aws-s3';\nnew X.Y(this, 'A', { p: s3.BucketEncryption.KMS });\n`,
    );
  });

  it('imports it by name when the file imports its CDK modules by name', () => {
    const out = edit(`import { Queue } from 'aws-cdk-lib/aws-sqs';\nnew X.Y(this, 'A');\n`, encryption);
    expect(out).toContain(`import { BucketEncryption } from 'aws-cdk-lib/aws-s3';`);
    expect(out).toContain(`{ p: BucketEncryption.KMS }`);
  });

  it('refuses an enum of another library, and a name the file already uses for something else', () => {
    expect(
      plan(
        `new X.Y(this, 'A');\n`,
        set('A', 'X.Y', 'p', { kind: 'enum', type: 'aws-cdk-lib.aws_s3.nested.Deep', member: 'A' }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      plan(`new X.Y(this, 'A');\n`, set('A', 'X.Y', 'p', { kind: 'enum', type: 'other-lib.Color', member: 'RED' })),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('other-lib') });
    expect(plan(`const s3 = 1;\nnew X.Y(this, 'A');\n`, set('A', 'X.Y', 'p', encryption))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('s3'),
    });
  });
});

/** The style matrix: the same edits made to a file written every way the plan has to preserve. */
describe('Source.plan style matrix', () => {
  interface Style {
    indent: string;
    eol: string;
    semi: string;
    quote: string;
    trailing: boolean;
  }
  const styles: Style[] = [];
  for (const indent of ['  ', '    ', '\t']) {
    for (const eol of ['\n', '\r\n']) {
      for (const semi of [';', '']) {
        for (const quote of ["'", '"']) {
          for (const trailing of [true, false]) styles.push({ indent, eol, semi, quote, trailing });
        }
      }
    }
  }

  const file = (s: Style, props: string[]) => {
    const { indent: i, quote: q, semi, eol } = s;
    const body = props.map((p, n) => `${i}${i}${i}${p}${n < props.length - 1 || s.trailing ? ',' : ''}`);
    return [
      `import * as s3 from ${q}aws-cdk-lib/aws-s3${q}${semi}`,
      ``,
      `export class S extends Stack {`,
      `${i}constructor() {`,
      `${i}${i}new s3.Bucket(this, ${q}A${q}, {`,
      ...body,
      `${i}${i}})${semi}`,
      `${i}}`,
      `}`,
      ``,
    ].join(eol);
  };

  it.each(styles.map((s) => [JSON.stringify(s), s] as const))('keeps the style of %s', (_name, s) => {
    const q = s.quote;
    const text = file(s, [`versioned: true`, `bucketName: ${q}a${q}`]);
    const out = after(
      text,
      set('A', 's3.Bucket', 'versioned', { kind: 'boolean', value: false }),
      set('A', 's3.Bucket', 'bucketName', str('b')),
      set('A', 's3.Bucket', 'removalPolicy', { kind: 'enum', type: 'aws-cdk-lib.RemovalPolicy', member: 'DESTROY' }),
      set('A', 's3.Bucket', 'autoDeleteObjects', { kind: 'boolean', value: true }),
    );
    const expected = [
      `import * as s3 from ${q}aws-cdk-lib/aws-s3${q}${s.semi}`,
      `import { RemovalPolicy } from ${q}aws-cdk-lib${q}${s.semi}`,
      ``,
      `export class S extends Stack {`,
      `${s.indent}constructor() {`,
      `${s.indent}${s.indent}new s3.Bucket(this, ${q}A${q}, {`,
      `${s.indent}${s.indent}${s.indent}versioned: false,`,
      `${s.indent}${s.indent}${s.indent}bucketName: ${q}b${q},`,
      `${s.indent}${s.indent}${s.indent}removalPolicy: RemovalPolicy.DESTROY,`,
      `${s.indent}${s.indent}${s.indent}autoDeleteObjects: true${s.trailing ? ',' : ''}`,
      `${s.indent}${s.indent}})${s.semi}`,
      `${s.indent}}`,
      `}`,
      ``,
    ].join(s.eol);
    expect(out).toBe(expected);
  });

  it.each(styles.map((s) => [JSON.stringify(s), s] as const))(
    'adds an object literal, and appends to a one-line object, in the style of %s',
    (_name, s) => {
      const { indent: i, quote: q, semi, eol } = s;
      const wrap = (...calls: string[]) =>
        [
          `import * as s3 from ${q}aws-cdk-lib/aws-s3${q}${semi}`,
          ``,
          `export class S extends Stack {`,
          `${i}constructor() {`,
          ...calls.map((c) => `${i}${i}${c}${semi}`),
          `${i}}`,
          `}`,
          ``,
        ].join(eol);
      const text = wrap(`new s3.Bucket(this, ${q}A${q})`, `new s3.Bucket(this, ${q}B${q}, { versioned: true })`);
      const out = after(
        text,
        set('A', 's3.Bucket', 'bucketName', str('a')),
        set('B', 's3.Bucket', 'bucketName', str('b')),
      );
      expect(out).toBe(
        wrap(
          `new s3.Bucket(this, ${q}A${q}, { bucketName: ${q}a${q} })`,
          `new s3.Bucket(this, ${q}B${q}, { versioned: true, bucketName: ${q}b${q} })`,
        ),
      );
    },
  );

  it('writes the CRLF it finds, never a bare LF, when it adds lines', () => {
    const text = file({ indent: '  ', eol: '\r\n', semi: ';', quote: "'", trailing: true }, [`versioned: true`]);
    const out = after(text, set('A', 's3.Bucket', 'bucketName', str('x')));
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('Source.plan refusals', () => {
  const text = bucket(`    new s3.Bucket(this, 'A', props);
    new s3.Bucket(this, 'B', { versioned });
    new s3.Bucket(this, 'C', { versioned: flag, name: nameOf() });
    new s3.Bucket(this, 'D', { nested: other });`);
  const bool: PropValue = { kind: 'boolean', value: true };

  it('refuses props passed as a variable, shorthand props, and expressions it must not replace', () => {
    expect(plan(text, set('A', 's3.Bucket', 'versioned', bool))).toMatchObject({
      ok: false,
      intent: 0,
      reason: expect.stringContaining('props'),
    });
    expect(plan(text, set('B', 's3.Bucket', 'versioned', bool))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('versioned'),
    });
    expect(plan(text, set('C', 's3.Bucket', 'versioned', bool))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('flag'),
    });
    expect(plan(text, set('C', 's3.Bucket', 'name', str('x')))).toMatchObject({ ok: false });
    expect(plan(text, set('D', 's3.Bucket', ['nested', 'field'], bool))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('other'),
    });
  });

  it('names the intent it failed on', () => {
    expect(plan(text, set('C', 's3.Bucket', 'other', bool), set('A', 's3.Bucket', 'versioned', bool))).toMatchObject({
      ok: false,
      intent: 1,
    });
  });

  it('refuses a target whose class or Construct ID is no longer what the user saw', () => {
    const intent = set('C', 's3.Bucket', 'other', bool);
    expect(plan(text, { ...intent, expect: { className: 'sqs.Queue', literalId: 'C' } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no longer'),
    });
    expect(plan(text, { ...intent, expect: { className: 's3.Bucket', literalId: 'Z' } })).toMatchObject({ ok: false });
    expect(plan(text, set('Gone', 's3.Bucket', 'x', bool))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no construct'),
    });
  });

  it('refuses a construct that is only referred to, and a prop name that is not a name', () => {
    const files: FileSet = new Map([[FILE, text]]);
    const facts = factsOf(text);
    facts.nodes['Stack/A']!.external = true;
    expect(source.plan(files, facts, [set('A', 's3.Bucket', 'x', bool)])).toMatchObject({ ok: false });
    expect(plan(text, set('B', 's3.Bucket', 'a: 1, evil', bool))).toMatchObject({ ok: false });
  });

  it('refuses when the code has moved from where the facts say the `new` is', () => {
    const files: FileSet = new Map([[FILE, '\n' + text]]);
    expect(source.plan(files, factsOf(text), [set('C', 's3.Bucket', 'other', bool)])).toMatchObject({ ok: false });
  });

  it('plans nothing for an edit that leaves the code as it is', () => {
    const same = bucket(`    new s3.Bucket(this, 'A', { versioned: true });`);
    expect(plan(same, set('A', 's3.Bucket', 'versioned', bool))).toMatchObject({ ok: true, changes: {} });
  });
});

describe('Source.plan renameId', () => {
  const rename = (id: string, newId: string, className = 's3.Bucket', parent = 'Stack'): Intent => ({
    type: 'renameId',
    path: `${parent}/${id}`,
    expect: { className, literalId: id },
    newId,
  });

  it('rewrites the literal and nothing else', () => {
    const text = bucket(`    new s3.Bucket(this, 'Uploads', {
      versioned: true,
    });`);
    const r = plan(text, rename('Uploads', 'Files'));
    expect(r.ok && unifiedDiff(FILE, text, r.after)?.diff).toBe(`--- a/lib/stack.ts
+++ b/lib/stack.ts
@@ -2,7 +2,7 @@
 
 export class S extends Stack {
   constructor() {
-    new s3.Bucket(this, 'Uploads', {
+    new s3.Bucket(this, 'Files', {
       versioned: true,
     });
   }
`);
  });

  it('leaves the variable the construct is assigned to alone', () => {
    const text = bucket("    const uploads = new s3.Bucket(this, 'Uploads');\n    uploads.grantRead(role);");
    expect(after(text, rename('Uploads', 'Files'))).toBe(
      bucket("    const uploads = new s3.Bucket(this, 'Files');\n    uploads.grantRead(role);"),
    );
  });

  it('keeps the quotes the ID was written in', () => {
    expect(after(bucket('    new s3.Bucket(this, "Uploads");'), rename('Uploads', 'Files'))).toBe(
      bucket('    new s3.Bucket(this, "Files");'),
    );
    expect(after(bucket('    new s3.Bucket(this, `Uploads`);'), rename('Uploads', 'Files'))).toBe(
      bucket('    new s3.Bucket(this, `Files`);'),
    );
  });

  it('escapes what the ID holds that the quote would not', () => {
    expect(after(bucket("    new s3.Bucket(this, 'Uploads');"), rename('Uploads', "It's"))).toBe(
      bucket("    new s3.Bucket(this, 'It\\'s');"),
    );
  });

  it('renames one of several constructs and no other', () => {
    const text = bucket("    new s3.Bucket(this, 'A');\n    new s3.Bucket(this, 'B');");
    expect(after(text, rename('B', 'C'))).toBe(bucket("    new s3.Bucket(this, 'A');\n    new s3.Bucket(this, 'C');"));
  });

  it('plans a rename and a prop edit of the same construct together', () => {
    const text = bucket("    new s3.Bucket(this, 'Uploads', { versioned: true });");
    expect(
      after(text, rename('Uploads', 'Files'), {
        ...set('Uploads', 's3.Bucket', 'versioned', { kind: 'boolean', value: false }),
        path: 'Stack/Files',
        expect: { className: 's3.Bucket', literalId: 'Files' },
      }),
    ).toBe(bucket("    new s3.Bucket(this, 'Files', { versioned: false });"));
  });

  it('adds no props to a construct that passes none', () => {
    const text = bucket("    new s3.Bucket(this, 'Uploads');");
    expect(after(text, rename('Uploads', 'Files'))).toBe(bucket("    new s3.Bucket(this, 'Files');"));
  });

  it('changes nothing when the ID stays the same', () => {
    const r = plan(bucket("    new s3.Bucket(this, 'Uploads');"), rename('Uploads', 'Uploads'));
    expect(r.ok && r.changes).toEqual({});
  });

  it('follows a construct renamed twice to its last ID', () => {
    const text = bucket("    new s3.Bucket(this, 'Uploads');");
    const again: Intent = { ...rename('Files', 'Docs'), path: 'Stack/Files' };
    expect(after(text, rename('Uploads', 'Files'), again)).toBe(bucket("    new s3.Bucket(this, 'Docs');"));
  });

  it('finds the construct by its old path when its parent was renamed first', () => {
    const text = bucket("    new s3.Bucket(this, 'Uploads');");
    const files: FileSet = new Map([[FILE, text]]);
    const facts = factsOf(text);
    const inner = facts.nodes['Stack/Uploads']!;
    const outer = {
      ...inner,
      className: 'Stack',
      literalId: 'Stack',
      span: { ...inner.span, start: { line: 1, col: 1 }, end: { line: 1, col: 2 } },
    };
    const result = source.plan(files, { nodes: { ...facts.nodes, Stack: outer } }, [
      { type: 'renameId', path: 'Stack', expect: { className: 'Stack', literalId: 'Stack' }, newId: 'Shop' },
      { ...rename('Uploads', 'Files'), path: 'Shop/Uploads' },
    ]);
    expect(result.ok).toBe(false);
    // The Stack's `new` is not in this file; what matters is that the second intent is looked up under the Base's path and not refused as missing.
    expect(!result.ok && result.intent).toBe(0);
  });

  it('refuses an ID the code could not hold, naming the intent', () => {
    const text = bucket("    new s3.Bucket(this, 'Uploads');");
    expect(plan(text, rename('Uploads', 'a/b'))).toMatchObject({
      ok: false,
      intent: 0,
      reason: expect.stringContaining("'/'"),
    });
    expect(plan(text, rename('Uploads', ''))).toMatchObject({ ok: false, reason: expect.stringContaining('empty') });
  });

  it('refuses a construct whose `new` makes several, which one literal would rename together', () => {
    const text = bucket("    new s3.Bucket(this, 'Uploads');");
    const files: FileSet = new Map([[FILE, text]]);
    const facts = factsOf(text);
    facts.nodes['Stack/Uploads']!.pathsOnSpan = 2;
    expect(source.plan(files, facts, [rename('Uploads', 'Files')])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('2 constructs'),
    });
  });

  it('refuses a construct that is no longer what the user saw', () => {
    const text = bucket("    new s3.Bucket(this, 'Uploads');");
    expect(plan(text, rename('Uploads', 'Files', 'sqs.Queue'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no longer'),
    });
  });
});
