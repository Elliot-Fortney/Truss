import { describe, expect, it } from 'vitest';
import { parseCreationStack } from './read-assembly.ts';

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
