import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { draftSupportOf, makeShadow, runsCompiledJs } from './shadow.ts';

const tempApp = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'truss-app-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};

describe('makeShadow', () => {
  it('copies the app, links node_modules, leaves out cdk.out and .git, and writes the overlay over the copy', async () => {
    const app = tempApp({
      'cdk.json': '{}',
      'lib/a.ts': 'old',
      'lib/b.ts': 'same',
      'cdk.out/x': 'x',
      '.git/HEAD': 'x',
      'node_modules/dep/index.js': 'dep',
    });
    const shadow = await makeShadow(
      app,
      new Map([
        ['lib/a.ts', 'new'],
        ['lib/deeper/c.ts', 'added'],
      ]),
    );
    try {
      expect(readFileSync(join(shadow.dir, 'lib/a.ts'), 'utf8')).toBe('new');
      expect(readFileSync(join(shadow.dir, 'lib/b.ts'), 'utf8')).toBe('same');
      expect(readFileSync(join(shadow.dir, 'lib/deeper/c.ts'), 'utf8')).toBe('added');
      expect(existsSync(join(shadow.dir, 'cdk.out'))).toBe(false);
      expect(existsSync(join(shadow.dir, '.git'))).toBe(false);
      expect(lstatSync(join(shadow.dir, 'node_modules')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(shadow.dir, 'node_modules'))).toBe(join(app, 'node_modules'));
      expect(readFileSync(join(shadow.dir, 'node_modules/dep/index.js'), 'utf8')).toBe('dep');
      // The user's files are not touched.
      expect(readFileSync(join(app, 'lib/a.ts'), 'utf8')).toBe('old');
    } finally {
      await shadow.remove();
    }
    expect(existsSync(shadow.dir)).toBe(false);
  });

  it('copes with an app that has no node_modules', async () => {
    const shadow = await makeShadow(tempApp({ 'cdk.json': '{}' }), new Map());
    try {
      expect(existsSync(join(shadow.dir, 'cdk.json'))).toBe(true);
    } finally {
      await shadow.remove();
    }
  });

  it('refuses an overlay file outside the app, and leaves nothing behind', async () => {
    const app = tempApp({ 'cdk.json': '{}' });
    await expect(makeShadow(app, new Map([['../escape.ts', 'x']]))).rejects.toThrow(/outside the app/);
  });
});

describe('runsCompiledJs', () => {
  it.each([
    'node bin/app.js',
    'node dist/bin/app.mjs',
    'node -r source-map-support/register bin/app.js',
    'npm run build && node bin/app.js',
  ])('is true for %s', (cmd) => {
    expect(runsCompiledJs(cmd)).toBe(true);
  });
  it.each([
    'npx tsx bin/app.ts',
    'npx ts-node --prefer-ts-exts bin/app.ts',
    'node --import tsx bin/app.ts',
    'python app.py',
    'npx ts-node bin/app.js',
  ])('is false for %s', (cmd) => {
    expect(runsCompiledJs(cmd)).toBe(false);
  });
});

describe('draftSupportOf', () => {
  it('supports an app that runs TypeScript directly', async () => {
    expect(await draftSupportOf(tempApp({ 'cdk.json': JSON.stringify({ app: 'npx tsx bin/app.ts' }) }))).toEqual({
      ok: true,
    });
  });

  it('supports an app that runs compiled JavaScript when it has a build script', async () => {
    const app = tempApp({
      'cdk.json': JSON.stringify({ app: 'node bin/app.js' }),
      'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
    });
    expect(await draftSupportOf(app)).toEqual({ ok: true });
  });

  it('is read-only, with the reason, when compiled JavaScript has no build script', async () => {
    const app = tempApp({
      'cdk.json': JSON.stringify({ app: 'node bin/app.js' }),
      'package.json': JSON.stringify({ scripts: { test: 'jest' } }),
    });
    expect(await draftSupportOf(app)).toEqual({ ok: false, reason: expect.stringContaining('no "build" script') });
    expect(await draftSupportOf(tempApp({ 'cdk.json': JSON.stringify({ app: 'node bin/app.js' }) }))).toMatchObject({
      ok: false,
    });
  });
});
