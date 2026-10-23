import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCreationStack, readAssembly, templateRefs } from './read-assembly.ts';

const APP = '/work/app';

describe('parseCreationStack', () => {
  it('keeps frames in the app and drops everything else', () => {
    expect(
      parseCreationStack(
        [
          '...new Bucket2 in aws-cdk-lib...',
          'new ShopStack (/work/app/lib/shop-stack.ts:11:5)',
          'Object.<anonymous> (/work/app/node_modules/dep/index.js:1:1)',
          '(no user code in 10 frames, use --stack-trace-limit to capture more)',
        ],
        APP,
      ),
    ).toEqual([{ fn: 'new ShopStack', file: 'lib/shop-stack.ts', line: 11, col: 5 }]);
  });

  it('reads anonymous frames, which V8 prints without parentheses', () => {
    expect(parseCreationStack(['/work/app/bin/app.ts:5:1'], APP)).toEqual([{ file: 'bin/app.ts', line: 5, col: 1 }]);
  });

  it('reads file:// URLs, as ESM loaders print them', () => {
    expect(parseCreationStack(['file:///work/app/bin/app.ts:5:1', 'run (file:///work/app/lib/a.ts:2:3)'], APP)).toEqual([
      { file: 'bin/app.ts', line: 5, col: 1 },
      { fn: 'run', file: 'lib/a.ts', line: 2, col: 3 },
    ]);
  });
});

describe('templateRefs', () => {
  const resource = (path: string, extra: Record<string, unknown> = {}) => ({ Type: 'AWS::X::Y', Metadata: { 'aws:cdk:path': path }, ...extra });

  it('finds what each resource points at through Ref, GetAtt in both forms, Sub and DependsOn, by construct path', () => {
    const refs = templateRefs({
      Resources: {
        A: resource('S/A/Resource', {
          Properties: {
            One: { Ref: 'B' },
            Two: { 'Fn::GetAtt': ['C', 'Arn'] },
            Three: { 'Fn::GetAtt': 'D.Arn' },
            Four: { 'Fn::Sub': 'arn:${AWS::Partition}:x:${E}:${F.Arn}:${!Literal}' },
            Five: { 'Fn::Join': ['', ['a', { Ref: 'G' }]] },
            Six: { 'Fn::Sub': ['${Var}-${H}', { Var: { Ref: 'I' } }] },
          },
          DependsOn: ['J', 'K'],
        }),
        B: resource('S/B/Resource'),
        C: resource('S/C/Resource'),
        D: resource('S/D/Resource'),
        E: resource('S/E/Resource'),
        F: resource('S/F/Resource'),
        G: resource('S/G/Resource'),
        H: resource('S/H/Resource'),
        I: resource('S/I/Resource'),
        J: resource('S/J/Resource'),
        K: resource('S/K/Resource'),
      },
    });
    expect(refs.map((r) => r.to).sort()).toEqual(['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'].map((x) => `S/${x}/Resource`));
    expect(refs.every((r) => r.from === 'S/A/Resource')).toBe(true);
  });

  it('keeps one entry per pair and ignores pseudo parameters, parameters, itself and resources with no construct path', () => {
    const refs = templateRefs({
      Parameters: { P: { Type: 'String' } },
      Resources: {
        A: resource('S/A/Resource', { Properties: { X: { Ref: 'B' }, Y: { Ref: 'B' }, Z: { Ref: 'AWS::Region' }, W: { Ref: 'P' }, V: { Ref: 'A' }, U: { Ref: 'Bare' } } }),
        B: resource('S/B/Resource'),
        Bare: { Type: 'AWS::X::Y' },
      },
    });
    expect(refs).toEqual([{ from: 'S/A/Resource', to: 'S/B/Resource' }]);
  });
});

describe('readAssembly', () => {
  const write = (dir: string, name: string, json: unknown) => writeFileSync(join(dir, name), JSON.stringify(json));

  it('reads the Stacks of a Stage from its nested assembly, under their construct paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'truss-assembly-'));
    try {
      mkdirSync(join(root, 'assembly-Dev'));
      write(root, 'tree.json', { tree: { id: 'App', path: '', children: {} } });
      write(root, 'manifest.json', {
        version: '55.0.0',
        artifacts: {
          'assembly-Dev': { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Dev' } },
          Web: { type: 'aws:cloudformation:stack', environment: 'aws://111111111111/eu-west-1', displayName: 'Web' },
        },
      });
      write(root, 'assembly-Dev/manifest.json', {
        version: '55.0.0',
        artifacts: {
          DevCore0C665B1D: {
            type: 'aws:cloudformation:stack',
            environment: 'aws://unknown-account/unknown-region',
            displayName: 'Dev/Core',
            additionalMetadataFile: 'DevCore.metadata.json',
          },
        },
      });
      write(root, 'assembly-Dev/DevCore.metadata.json', {
        '/Dev/Core/Events/Resource': [{ type: 'aws:cdk:creationStack', data: [`new AppStage (${root}/lib/app-stage.ts:9:5)`] }],
      });

      const assembly = readAssembly(root, root);

      expect(assembly.stacks).toEqual([{ path: 'Dev/Core' }, { path: 'Web', env: 'aws://111111111111/eu-west-1' }]);
      expect(assembly.creation['Dev/Core/Events/Resource']).toEqual([{ fn: 'new AppStage', file: 'lib/app-stage.ts', line: 9, col: 5 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the references between resources from each Stack\'s template', () => {
    const root = mkdtempSync(join(tmpdir(), 'truss-assembly-'));
    try {
      write(root, 'tree.json', { tree: { id: 'App', path: '', children: {} } });
      write(root, 'manifest.json', {
        version: '55.0.0',
        artifacts: { Web: { type: 'aws:cloudformation:stack', displayName: 'Web', properties: { templateFile: 'Web.template.json' } } },
      });
      write(root, 'Web.template.json', {
        Resources: {
          A: { Type: 'AWS::X::Y', Metadata: { 'aws:cdk:path': 'Web/A/Resource' }, Properties: { Arn: { 'Fn::GetAtt': ['B', 'Arn'] } } },
          B: { Type: 'AWS::X::Y', Metadata: { 'aws:cdk:path': 'Web/B/Resource' } },
        },
      });
      expect(readAssembly(root, root).resourceRefs).toEqual([{ from: 'Web/A/Resource', to: 'Web/B/Resource' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the error, warning and info annotations of each construct', () => {
    const root = mkdtempSync(join(tmpdir(), 'truss-assembly-'));
    try {
      write(root, 'tree.json', { tree: { id: 'App', path: '', children: {} } });
      write(root, 'manifest.json', {
        version: '55.0.0',
        artifacts: { Web: { type: 'aws:cloudformation:stack', displayName: 'Web', additionalMetadataFile: 'Web.metadata.json' } },
      });
      write(root, 'Web.metadata.json', {
        '/Web/Queue': [
          { type: 'aws:cdk:error', data: 'no good' },
          { type: 'aws:cdk:warning', data: 'careful' },
          { type: 'aws:cdk:info', data: 'fyi' },
          { type: 'aws:cdk:logicalId', data: 'Queue123' },
        ],
      });
      expect(readAssembly(root, root).annotations).toEqual([
        { path: 'Web/Queue', level: 'error', message: 'no good' },
        { path: 'Web/Queue', level: 'warning', message: 'careful' },
        { path: 'Web/Queue', level: 'info', message: 'fyi' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads no references from a Stack with no template file', () => {
    const root = mkdtempSync(join(tmpdir(), 'truss-assembly-'));
    try {
      write(root, 'tree.json', { tree: { id: 'App', path: '', children: {} } });
      write(root, 'manifest.json', { version: '55.0.0', artifacts: { Web: { type: 'aws:cloudformation:stack', displayName: 'Web' } } });
      expect(readAssembly(root, root).resourceRefs).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
