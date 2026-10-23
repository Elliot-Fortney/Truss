import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFiles } from './node-files.ts';

describe('NodeFiles.read', () => {
  it("reads the app's TypeScript sources by relative path and skips dependencies and build output", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'truss-files-'));
    for (const sub of ['bin', 'lib/deep', 'node_modules/x', 'cdk.out']) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, 'bin/app.ts'), 'a');
    writeFileSync(join(dir, 'lib/deep/stack.ts'), 'b');
    writeFileSync(join(dir, 'lib/types.d.ts'), 'declaration');
    writeFileSync(join(dir, 'node_modules/x/index.ts'), 'dep');
    writeFileSync(join(dir, 'cdk.out/tree.ts'), 'out');
    writeFileSync(join(dir, 'README.md'), 'readme');

    const files = await new NodeFiles(dir).read();
    expect([...files.entries()].sort()).toEqual([
      ['bin/app.ts', 'a'],
      ['lib/deep/stack.ts', 'b'],
    ]);
  });
});
