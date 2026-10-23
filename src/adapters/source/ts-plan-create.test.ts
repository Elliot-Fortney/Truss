import { describe, expect, it } from 'vitest';
import { applyChanges } from '../../core/diff.ts';
import type { Facts, NodeFacts } from '../../core/facts.ts';
import type { Intent } from '../../core/intents.ts';
import type { FileSet } from '../../core/ports.ts';
import { TsSource } from './ts-source.ts';

const source = new TsSource();

/** Where the `new` that starts at `needle` is in `text`. */
function spanAt(file: string, text: string, needle: string): NodeFacts['span'] {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`no ${needle}`);
  const pos = (offset: number) => ({ line: text.slice(0, offset).split('\n').length, col: offset - text.lastIndexOf('\n', offset - 1) });
  return { file, start: pos(at), end: pos(at + needle.length) };
}

const node = (file: string, text: string, needle: string, className: string, literalId: string, extra: Partial<NodeFacts> = {}): NodeFacts => ({
  span: spanAt(file, text, needle),
  className,
  literalId,
  pathsOnSpan: 1,
  binding: 'const',
  ...extra,
});

function run(files: Record<string, string>, facts: Facts, ...intents: Intent[]) {
  const set: FileSet = new Map(Object.entries(files));
  const result = source.plan(set, facts, intents);
  if (!result.ok) return result;
  return { ok: true as const, files: Object.fromEntries([...set].map(([file, text]) => [file, result.changes[file] ? applyChanges(text, result.changes[file]) : text])) };
}

const out = (r: ReturnType<typeof run>, file: string): string => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.files[file]!;
};

const add = (path: string, className: string, literalId: string, fqn: string, id: string, props: Extract<Intent, { type: 'addNode' }>['props'] = []): Intent => ({ type: 'addNode', path, expect: { className, literalId }, fqn, id, props });

const BUCKET = 'aws-cdk-lib.aws_s3.Bucket';

describe('addNode in a Stack class', () => {
  const stack = `import { Stack } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class MyStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const uploads = new s3.Bucket(this, 'Uploads');
    const logs = new s3.Bucket(this, 'Logs'); // keep
    this.tag();
  }
}
`;
  const app = `const app = new App();\nnew MyStack(app, 'Dev');\n`;
  const facts: Facts = {
    nodes: {
      Dev: node('bin/app.ts', app, 'new MyStack', 'MyStack', 'Dev', { binding: 'none' }),
      'Dev/Uploads': node('lib/stack.ts', stack, 'new s3.Bucket(this, \'Uploads\'', 's3.Bucket', 'Uploads', { enclosingClass: { name: 'MyStack', kind: 'stack' } }),
      'Dev/Logs': node('lib/stack.ts', stack, 'new s3.Bucket(this, \'Logs\'', 's3.Bucket', 'Logs', { enclosingClass: { name: 'MyStack', kind: 'stack' } }),
    },
  };
  const files = { 'bin/app.ts': app, 'lib/stack.ts': stack };

  it('writes a const after the last editable sibling, keeping its trailing comment, and reuses the file’s alias', () => {
    const r = run(files, facts, add('Dev', 'MyStack', 'Dev', BUCKET, 'Archive', [{ name: 'versioned', value: { kind: 'boolean', value: true } }]));
    expect(out(r, 'lib/stack.ts')).toContain(`    const logs = new s3.Bucket(this, 'Logs'); // keep\n    const archive = new s3.Bucket(this, 'Archive', { versioned: true });\n    this.tag();`);
    expect(out(r, 'bin/app.ts')).toBe(app);
  });

  it('adds the import in the file’s style when the module is not imported yet', () => {
    const r = run(files, facts, add('Dev', 'MyStack', 'Dev', 'aws-cdk-lib.aws_sqs.Queue', 'Jobs'));
    const text = out(r, 'lib/stack.ts');
    expect(text).toContain(`import * as sqs from 'aws-cdk-lib/aws-sqs';`);
    expect(text).toContain(`const jobs = new sqs.Queue(this, 'Jobs');`);
  });

  it('fills a prop from an Overlay snippet, importing what it names', () => {
    const r = run(files, facts, add('Dev', 'MyStack', 'Dev', 'aws-cdk-lib.aws_lambda.Function', 'Handler', [
      { name: 'runtime', snippet: { code: 'Runtime.NODEJS_22_X', uses: ['aws-cdk-lib.aws_lambda.Runtime'] } },
      { name: 'handler', snippet: { code: "'index.handler'" } },
    ]));
    const text = out(r, 'lib/stack.ts');
    expect(text).toContain(`import * as lambda from 'aws-cdk-lib/aws-lambda';`);
    expect(text).toContain(`const handler = new lambda.Function(this, 'Handler', { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler' });`);
  });

  it('adds several in the order given, each with a binding of its own', () => {
    const r = run(files, facts, add('Dev', 'MyStack', 'Dev', BUCKET, 'Archive'), add('Dev', 'MyStack', 'Dev', BUCKET, 'Archive2'));
    const text = out(r, 'lib/stack.ts');
    expect(text.indexOf("'Archive')")).toBeLessThan(text.indexOf("'Archive2')"));
    expect(text).toContain('const archive = ');
    expect(text).toContain('const archive2 = ');
  });

  it('picks a binding the file does not use yet', () => {
    const r = run(files, facts, add('Dev', 'MyStack', 'Dev', BUCKET, 'Logs'));
    expect(out(r, 'lib/stack.ts')).toContain(`const logs2 = new s3.Bucket(this, 'Logs');`);
  });

  it('refuses a Stack that is no longer the class the user saw', () => {
    const r = run(files, facts, add('Dev', 'OtherStack', 'Dev', BUCKET, 'Archive'));
    expect(r.ok).toBe(false);
  });

  it('refuses a construct outside aws-cdk-lib', () => {
    const r = run(files, facts, add('Dev', 'MyStack', 'Dev', 'other-lib.Thing', 'Thing'));
    expect(r.ok).toBe(false);
  });
});

describe('addNode in a Stack class that keeps its constructs in fields', () => {
  const stack = `import { Stack } from 'aws-cdk-lib';
import { Bucket } from 'aws-cdk-lib/aws-s3';

export class MyStack extends Stack {
  readonly uploads: Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.uploads = new Bucket(this, "Uploads");
  }
}
`;
  const app = `new MyStack(app, "Dev");\n`;
  const facts: Facts = {
    nodes: {
      Dev: node('bin/app.ts', app, 'new MyStack', 'MyStack', 'Dev', { binding: 'none' }),
      'Dev/Uploads': node('lib/stack.ts', stack, 'new Bucket(this', 'Bucket', 'Uploads', { binding: 'field', enclosingClass: { name: 'MyStack', kind: 'stack' } }),
    },
  };

  it('declares a field and assigns it, in the file’s quote and import style', () => {
    const r = run({ 'bin/app.ts': app, 'lib/stack.ts': stack }, facts, add('Dev', 'MyStack', 'Dev', 'aws-cdk-lib.aws_sqs.Queue', 'Jobs'));
    const text = out(r, 'lib/stack.ts');
    expect(text).toContain(`import { Queue } from 'aws-cdk-lib/aws-sqs';`);
    expect(text).toContain(`  readonly uploads: Bucket;\n  readonly jobs: Queue;\n`);
    expect(text).toContain(`    this.uploads = new Bucket(this, "Uploads");\n    this.jobs = new Queue(this, "Jobs");\n  }`);
  });
});

describe('addNode in a Stack made inline', () => {
  const app = `import { App, Stack } from 'aws-cdk-lib';

const app = new App();
const stack = new Stack(app, 'Dev');
const queue = new Queue(stack, 'Queue');
app.synth();
`;
  const facts: Facts = {
    nodes: {
      Dev: node('bin/app.ts', app, 'new Stack(app', 'Stack', 'Dev'),
      'Dev/Queue': node('bin/app.ts', app, 'new Queue(stack', 'Queue', 'Queue'),
    },
  };

  it('goes after the last use of the Stack’s variable', () => {
    const r = run({ 'bin/app.ts': app }, facts, add('Dev', 'Stack', 'Dev', BUCKET, 'Data'));
    const text = out(r, 'bin/app.ts');
    expect(text).toContain(`const queue = new Queue(stack, 'Queue');\nconst data = new s3.Bucket(stack, 'Data');\napp.synth();`);
    expect(text).toContain(`import * as s3 from 'aws-cdk-lib/aws-s3';`);
  });

  it('refuses a Stack that is not kept in a variable', () => {
    const unbound = `new Stack(app, 'Dev');\n`;
    const r = run({ 'bin/app.ts': unbound }, { nodes: { Dev: node('bin/app.ts', unbound, 'new Stack', 'Stack', 'Dev', { binding: 'none' }) } }, add('Dev', 'Stack', 'Dev', BUCKET, 'Data'));
    expect(r).toMatchObject({ ok: false });
  });
});

describe('duplicate', () => {
  const stack = `import { Stack, Duration } from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';

export class MyStack extends Stack {
  readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const jobs = new sqs.Queue(this, 'Jobs', {
      visibilityTimeout: Duration.seconds(30),
    });
    this.dlq = new sqs.Queue(this, 'Dead');
    this.tag();
  }
}
`;
  const app = `new MyStack(app, 'Dev');\n`;
  const inClass = { enclosingClass: { name: 'MyStack', kind: 'stack' as const } };
  const facts: Facts = {
    nodes: {
      Dev: node('bin/app.ts', app, 'new MyStack', 'MyStack', 'Dev', { binding: 'none' }),
      'Dev/Jobs': node('lib/stack.ts', stack, "new sqs.Queue(this, 'Jobs'", 'sqs.Queue', 'Jobs', inClass),
      'Dev/Dead': node('lib/stack.ts', stack, "new sqs.Queue(this, 'Dead'", 'sqs.Queue', 'Dead', { ...inClass, binding: 'field' }),
    },
  };
  const files = { 'bin/app.ts': app, 'lib/stack.ts': stack };
  const dup = (path: string, className: string, literalId: string, newId: string): Intent => ({ type: 'duplicate', path, expect: { className, literalId }, newId });

  it('copies the statement, with a fresh ID and binding, after the last sibling', () => {
    const text = out(run(files, facts, dup('Dev/Jobs', 'sqs.Queue', 'Jobs', 'Jobs2')), 'lib/stack.ts');
    expect(text).toContain(`    this.dlq = new sqs.Queue(this, 'Dead');\n    const jobs2 = new sqs.Queue(this, 'Jobs2', {\n      visibilityTimeout: Duration.seconds(30),\n    });\n    this.tag();`);
  });

  it('copies a field with its declaration', () => {
    const text = out(run(files, facts, dup('Dev/Dead', 'sqs.Queue', 'Dead', 'Dead2')), 'lib/stack.ts');
    expect(text).toContain(`  readonly dlq: sqs.Queue;\n  readonly dead2: sqs.Queue;\n`);
    expect(text).toContain(`    this.dead2 = new sqs.Queue(this, 'Dead2');`);
  });

  it('refuses a Node that is not editable', () => {
    const locked: Facts = { nodes: { ...facts.nodes, 'Dev/Jobs': { ...facts.nodes['Dev/Jobs']!, surround: { kind: 'loop' } } } };
    expect(run(files, locked, dup('Dev/Jobs', 'sqs.Queue', 'Jobs', 'Jobs2'))).toMatchObject({ ok: false, reason: 'Created in a loop' });
  });
});
