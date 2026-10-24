import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('NodeFiles.watch', () => {
  const stops: (() => void)[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // The OS may replay the setup writes to a new watch, so wait those out before the test starts.
  const watched = async (debounceMs = 50) => {
    const dir = mkdtempSync(join(tmpdir(), 'truss-watch-'));
    dirs.push(dir);
    for (const sub of ['lib', 'node_modules/x', 'cdk.out', '.git']) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, 'lib/a.ts'), 'a');
    const onChange = vi.fn();
    stops.push(new NodeFiles(dir, { debounceMs }).watch(onChange));
    await settle(debounceMs + 300);
    onChange.mockClear();
    return { dir, onChange };
  };
  const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

  it.each([
    ['a source file', 'lib/a.ts'],
    ['a new source file', 'lib/new.ts'],
    ['package-lock.json', 'package-lock.json'],
    ['cdk.json', 'cdk.json'],
  ])('reports a change to %s', async (_name, file) => {
    const { dir, onChange } = await watched();
    writeFileSync(join(dir, file), 'changed');
    await vi.waitFor(
      () => {
        expect(onChange).toHaveBeenCalled();
      },
      { timeout: 5_000 },
    );
  });

  it('reports a burst of writes once', async () => {
    const { dir, onChange } = await watched(150);
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, 'lib/a.ts'), `v${i}`);
    await settle(800);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('still reports while writes keep coming faster than the debounce', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'truss-watch-'));
    dirs.push(dir);
    const onChange = vi.fn();
    stops.push(new NodeFiles(dir, { debounceMs: 300, maxWaitMs: 500 }).watch(onChange));
    await settle(400);
    onChange.mockClear();
    const end = Date.now() + 1200;
    for (let i = 0; Date.now() < end; i++) {
      writeFileSync(join(dir, 'a.ts'), `v${i}`);
      await settle(100);
    }
    expect(onChange).toHaveBeenCalled();
  });

  it('ignores dependencies, build output, git internals and files that cannot change the Design', async () => {
    const { dir, onChange } = await watched();
    writeFileSync(join(dir, 'node_modules/x/index.ts'), 'dep');
    writeFileSync(join(dir, 'node_modules/.package-lock.json'), '{}');
    writeFileSync(join(dir, 'cdk.out/manifest.json'), '{}');
    writeFileSync(join(dir, '.git/index.json'), '{}');
    writeFileSync(join(dir, 'README.md'), 'readme');
    writeFileSync(join(dir, 'lib/.a.ts.swp'), 'swap');
    writeFileSync(join(dir, 'truss.json'), '{}');
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops reporting once stopped, even for a change already waiting out its debounce', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'truss-watch-'));
    dirs.push(dir);
    const onChange = vi.fn();
    const stop = new NodeFiles(dir, { debounceMs: 150 }).watch(onChange);
    await settle(100);
    writeFileSync(join(dir, 'a.ts'), 'x');
    await settle(50);
    stop();
    await settle(500);
    expect(onChange).not.toHaveBeenCalled();
  });
});
