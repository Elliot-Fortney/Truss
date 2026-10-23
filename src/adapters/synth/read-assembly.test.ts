import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCreationStack, readAssembly } from './read-assembly.ts';

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
});
