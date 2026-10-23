import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, 'dist/cli.js');
const app = resolve(root, 'test/fixtures/straight-line');

/** Starts `truss --no-open` in an app folder and resolves with its URL once it prints one. */
function startTruss(cwd = app): Promise<{ child: ChildProcess; url: string; exited: Promise<number | null> }> {
  return new Promise((resolveStart, reject) => {
    const child = spawn('node', [cli, '--no-open'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    let out = '';
    child.stdout!.on('data', (d) => {
      out += d;
      const url = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/.exec(out)?.[0];
      if (url) resolveStart({ child, url, exited });
    });
    child.stderr!.on('data', (d) => (out += d));
    child.once('exit', () => reject(new Error(`truss exited before printing a URL:\n${out}`)));
  });
}

test('npx truss opens a straight-line CDK app and shows its Nodes in the Stack box', async ({ page }) => {
  const truss = await startTruss();
  try {
    await page.goto(truss.url);

    await expect(page.getByText('ShopStack', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('us-east-1 · 123456789012')).toBeVisible();
    for (const [label, cls] of [['Uploads', 'Bucket'], ['Orders', 'Queue'], ['Catalog', 'Table']]) {
      const node = page.locator('.truss-node', { hasText: label });
      await expect(node).toBeVisible();
      await expect(node).toContainText(cls!);
    }
    await expect(page.locator('.truss-node')).toHaveCount(3);
  } finally {
    truss.child.kill('SIGINT');
    expect(await truss.exited).toBe(0);
  }
});

test('Ctrl+C stops Truss and frees its port', async ({ page }) => {
  const truss = await startTruss();
  await page.goto(truss.url);
  await expect(page.locator('.truss-node').first()).toBeVisible({ timeout: 60_000 });

  truss.child.kill('SIGINT');
  expect(await truss.exited).toBe(0);
  await expect(fetch(truss.url)).rejects.toThrow();
});

test('refuses the WebSocket without the session token', async ({ page }) => {
  const truss = await startTruss();
  try {
    const noToken = truss.url.replace(/\?token=.*/, '');
    await page.goto(noToken);
    await expect(page.getByText('Disconnected from Truss.')).toBeVisible();
    await expect(page.locator('.truss-node')).toHaveCount(0);
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});

/** A throwaway copy of the fixture app that a test may edit while Truss watches it. */
function copyApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'truss-e2e-'));
  cpSync(app, dir, { recursive: true, filter: (src) => !/node_modules|cdk\.out/.test(src) });
  symlinkSync(join(app, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

test('breaking the app from outside dims the last good Design under a banner, and fixing it recovers', async ({ page }) => {
  const dir = copyApp();
  const stackFile = join(dir, 'lib/shop-stack.ts');
  const original = readFileSync(stackFile, 'utf8');
  const truss = await startTruss(dir);
  try {
    await page.goto(truss.url);
    await expect(page.locator('.truss-node')).toHaveCount(3, { timeout: 60_000 });

    writeFileSync(stackFile, original.replace("super(scope, id, props);", "super(scope, id, props);\n    throw new Error('outside change broke it');"));
    const banner = page.locator('.error-banner');
    await expect(banner).toContainText('outside change broke it', { timeout: 60_000 });
    await expect(banner.getByRole('button', { name: 'Open in editor' })).toBeVisible();
    await expect(page.locator('.truss-node')).toHaveCount(3);
    await expect(page.locator('.canvas')).toHaveClass(/dimmed/);

    writeFileSync(stackFile, original);
    await expect(banner).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('.canvas')).not.toHaveClass(/dimmed/);
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});

test('a failed first open shows the error full page, then loads the Design once the app synths', async ({ page }) => {
  const dir = copyApp();
  const stackFile = join(dir, 'lib/shop-stack.ts');
  const original = readFileSync(stackFile, 'utf8');
  writeFileSync(stackFile, original.replace("super(scope, id, props);", "super(scope, id, props);\n    throw new Error('broken from the start');"));
  const truss = await startTruss(dir);
  try {
    await page.goto(truss.url);
    const error = page.getByRole('alert');
    await expect(error).toContainText('broken from the start', { timeout: 60_000 });
    await expect(error).toContainText('lib/shop-stack.ts');
    await expect(error.getByRole('button', { name: 'Open in editor' })).toBeVisible();
    await expect(page.locator('.truss-node')).toHaveCount(0);

    writeFileSync(stackFile, original);
    await expect(page.locator('.truss-node')).toHaveCount(3, { timeout: 60_000 });
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});
