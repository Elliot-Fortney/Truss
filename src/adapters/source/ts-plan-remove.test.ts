import { describe, expect, it } from 'vitest';
import { applyChanges } from '../../core/diff.ts';
import type { Facts, NodeFacts } from '../../core/facts.ts';
import type { Intent } from '../../core/intents.ts';
import type { FileSet } from '../../core/ports.ts';
import { TsSource } from './ts-source.ts';

const source = new TsSource();

function spanAt(file: string, text: string, needle: string): NodeFacts['span'] {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`no ${needle}`);
  const pos = (offset: number) => ({
    line: text.slice(0, offset).split('\n').length,
    col: offset - text.lastIndexOf('\n', offset - 1),
  });
  return { file, start: pos(at), end: pos(at + needle.length) };
}

const node = (
  file: string,
  text: string,
  needle: string,
  className: string,
  literalId: string,
  extra: Partial<NodeFacts> = {},
): NodeFacts => ({
  span: spanAt(file, text, needle),
  className,
  literalId,
  pathsOnSpan: 1,
  binding: 'const',
  enclosingClass: { name: 'MyStack', kind: 'stack' },
  ...extra,
});

const remove = (path: string, className: string, literalId: string): Intent => ({
  type: 'removeNode',
  path,
  expect: { className, literalId },
});

function run(files: Record<string, string>, facts: Facts, ...intents: Intent[]) {
  const set: FileSet = new Map(Object.entries(files));
  const result = source.plan(set, facts, intents);
  if (!result.ok) return result;
  return {
    ok: true as const,
    files: Object.fromEntries(
      [...set].map(([file, text]) => [file, result.changes[file] ? applyChanges(text, result.changes[file]) : text]),
    ),
  };
}

const out = (r: ReturnType<typeof run>, file: string): string => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.files[file]!;
};

const stack = `import { Stack } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';

export class MyStack extends Stack {
  readonly dead: sqs.Queue;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Where uploads land.
    // Keep versions.
    const uploads = new s3.Bucket(this, 'Uploads', {
      versioned: true,
    }); // trailing

    const logs = new s3.Bucket(this, 'Logs');

    /** The dead letters. */
    this.dead = new sqs.Queue(this, 'Dead');
    new sqs.Queue(this, 'Loose');
    this.tag();
  }
}
`;
const app = `import { MyStack } from '../lib/stack';\nconst dev = new MyStack(app, 'Dev');\n`;
const files = { 'bin/app.ts': app, 'lib/stack.ts': stack };
const facts: Facts = {
  nodes: {
    Dev: node('bin/app.ts', app, 'new MyStack', 'MyStack', 'Dev', { enclosingClass: undefined as never }),
    'Dev/Uploads': node('lib/stack.ts', stack, "new s3.Bucket(this, 'Uploads'", 's3.Bucket', 'Uploads'),
    'Dev/Logs': node('lib/stack.ts', stack, "new s3.Bucket(this, 'Logs'", 's3.Bucket', 'Logs'),
    'Dev/Dead': node('lib/stack.ts', stack, "new sqs.Queue(this, 'Dead'", 'sqs.Queue', 'Dead', { binding: 'field' }),
    'Dev/Loose': node('lib/stack.ts', stack, "new sqs.Queue(this, 'Loose'", 'sqs.Queue', 'Loose', { binding: 'none' }),
  },
};
delete (facts.nodes['Dev'] as { enclosingClass?: unknown }).enclosingClass;

describe('removeNode', () => {
  it('removes the statement with the comment above it and the one trailing it', () => {
    const text = out(run(files, facts, remove('Dev/Uploads', 's3.Bucket', 'Uploads')), 'lib/stack.ts');
    expect(text).toContain(`    super(scope, id);\n\n    const logs = new s3.Bucket(this, 'Logs');\n`);
    expect(text).not.toContain('Uploads');
    expect(text).not.toContain('Keep versions');
    expect(text).not.toContain('trailing');
  });

  it('removes a field with its declaration and comment', () => {
    const text = out(run(files, facts, remove('Dev/Dead', 'sqs.Queue', 'Dead')), 'lib/stack.ts');
    expect(text).not.toContain('dead');
    expect(text).not.toContain('dead letters');
    expect(text).toContain(`export class MyStack extends Stack {\n  constructor(`);
    expect(text).toContain(`    const logs = new s3.Bucket(this, 'Logs');\n\n    new sqs.Queue(this, 'Loose');`);
  });

  it('removes a construct made by a bare statement', () => {
    const text = out(run(files, facts, remove('Dev/Loose', 'sqs.Queue', 'Loose')), 'lib/stack.ts');
    expect(text).not.toContain('Loose');
    expect(text).toContain(`    this.dead = new sqs.Queue(this, 'Dead');\n    this.tag();`);
  });

  it('refuses while another statement uses it, and lists the uses', () => {
    const used = stack.replace('this.tag();', 'logs.grantRead(uploads);\n    this.tag();');
    const r = run(
      { ...files, 'lib/stack.ts': used },
      {
        nodes: {
          ...facts.nodes,
          'Dev/Uploads': node('lib/stack.ts', used, "new s3.Bucket(this, 'Uploads'", 's3.Bucket', 'Uploads'),
        },
      },
      remove('Dev/Uploads', 's3.Bucket', 'Uploads'),
    );
    expect(r).toMatchObject({ ok: false, uses: [{ file: 'lib/stack.ts', text: 'logs.grantRead(uploads);' }] });
    expect((r as { uses: Array<{ line: number }> }).uses[0]!.line).toBe(
      used.split('\n').findIndex((l) => l.includes('grantRead')) + 1,
    );
  });

  it('refuses a field used in another file', () => {
    const elsewhere = `import { MyStack } from '../lib/stack';\nconst dev = new MyStack(app, 'Dev');\nconsole.log(dev.dead);\n`;
    const r = run({ ...files, 'bin/app.ts': elsewhere }, facts, remove('Dev/Dead', 'sqs.Queue', 'Dead'));
    expect(r).toMatchObject({ ok: false, uses: [{ file: 'bin/app.ts', line: 3, text: 'console.log(dev.dead);' }] });
  });

  it('refuses a Node that is not editable, or that no longer matches', () => {
    const looped: Facts = {
      nodes: { ...facts.nodes, 'Dev/Logs': { ...facts.nodes['Dev/Logs']!, surround: { kind: 'loop' } } },
    };
    expect(run(files, looped, remove('Dev/Logs', 's3.Bucket', 'Logs'))).toMatchObject({
      ok: false,
      reason: 'Created in a loop',
    });
    expect(run(files, facts, remove('Dev/Logs', 's3.Bucket', 'Other'))).toMatchObject({ ok: false });
  });

  it('leaves a renamed Node’s rename out: the statement goes whole', () => {
    const rename: Intent = {
      type: 'renameId',
      path: 'Dev/Logs',
      expect: { className: 's3.Bucket', literalId: 'Logs' },
      newId: 'Audit',
    };
    const text = out(run(files, facts, rename, remove('Dev/Audit', 's3.Bucket', 'Audit')), 'lib/stack.ts');
    expect(text).not.toContain('Logs');
    expect(text).not.toContain('Audit');
  });
});
