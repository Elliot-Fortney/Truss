import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, 'dist/cli.js');
const app = resolve(root, 'test/fixtures/straight-line');

/** Starts `truss --no-open` in the fixture app and resolves with its URL once it prints one. */
function startTruss(): Promise<{ child: ChildProcess; url: string; exited: Promise<number | null> }> {
  return new Promise((resolveStart, reject) => {
    const child = spawn('node', [cli, '--no-open'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
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
