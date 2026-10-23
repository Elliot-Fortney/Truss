import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('NodeFiles.readText and writeText', () => {
  const appDir = () => mkdtempSync(join(tmpdir(), 'truss-files-'));

  it('reads a file next to cdk.json, or undefined when there is none', async () => {
    const dir = appDir();
    writeFileSync(join(dir, 'truss.json'), '{}');
    const files = new NodeFiles(dir);
    expect(await files.readText('truss.json')).toBe('{}');
    expect(await files.readText('missing.json')).toBeUndefined();
  });

  it('writes the whole file, replacing what was there, and leaves no temporary file behind', async () => {
    const dir = appDir();
    writeFileSync(join(dir, 'truss.json'), 'old');
    const files = new NodeFiles(dir);
    await files.writeText('truss.json', 'new\n');
    await files.writeText('other.json', 'x');
    expect(readFileSync(join(dir, 'truss.json'), 'utf8')).toBe('new\n');
    expect(readdirSync(dir).sort()).toEqual(['other.json', 'truss.json']);
  });

  it('reports a read that fails for a reason other than a missing file', async () => {
    const dir = appDir();
    mkdirSync(join(dir, 'truss.json'));
    await expect(new NodeFiles(dir).readText('truss.json')).rejects.toThrow(/EISDIR/);
  });
});
