import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, 'dist/cli.js');
const app = resolve(root, 'test/fixtures/straight-line');

/** Starts `truss --no-open` in the fixture app and resolves with its URL once it prints one. */
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

/** A scratch copy of the fixture app (sharing its node_modules), so a test can write truss.json without touching the repo. */
function scratchApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'truss-e2e-'));
  cpSync(app, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|cdk\.out)$/.test(src) });
  symlinkSync(join(app, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

test('a dragged Node and its note are saved in truss.json and survive a reload', async ({ page }) => {
  const dir = scratchApp();
  const sidecar = join(dir, 'truss.json');
  const truss = await startTruss(dir);
  try {
    await page.goto(truss.url);
    const orders = page.locator('.truss-node', { hasText: 'Orders' });
    const uploads = page.locator('.truss-node', { hasText: 'Uploads' });
    await expect(orders).toBeVisible({ timeout: 60_000 });
    expect(existsSync(sidecar)).toBe(false);

    // Drag Orders down and to the right.
    const from = (await orders.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 150, from.y + from.height / 2 + 120, { steps: 10 });
    await page.mouse.up();

    await expect.poll(() => (existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) : undefined)).toMatchObject({
      formatVersion: 1,
      nodes: { 'ShopStack/Orders': { position: { x: expect.any(Number), y: expect.any(Number) } } },
    });

    // Add a note to it.
    await orders.click();
    await page.getByLabel('Note').fill('Retries 3x, then DLQ');
    await page.getByLabel('Note').blur();
    await expect.poll(() => JSON.parse(readFileSync(sidecar, 'utf8')).nodes['ShopStack/Orders'].note).toBe('Retries 3x, then DLQ');

    const offset = async () => {
      const [o, u] = [(await orders.boundingBox())!, (await uploads.boundingBox())!];
      return [(o.x - u.x) / u.width, (o.y - u.y) / u.height];
    };
    const before = await offset();
    await page.reload();
    await expect(orders).toBeVisible({ timeout: 60_000 });
    const after = await offset();
    expect(after[0]).toBeCloseTo(before[0]!, 1);
    expect(after[1]).toBeCloseTo(before[1]!, 1);
    await orders.click();
    await expect(page.getByLabel('Note')).toHaveValue('Retries 3x, then DLQ');
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});

test('a truss.json from a newer Truss is refused with a clear message and left untouched', async ({ page }) => {
  const dir = scratchApp();
  const text = JSON.stringify({ formatVersion: 99, nodes: {} });
  writeFileSync(join(dir, 'truss.json'), text);
  const truss = await startTruss(dir);
  try {
    await page.goto(truss.url);
    await expect(page.getByRole('alert')).toContainText(/format 99.*newer.*Upgrade Truss/, { timeout: 60_000 });
    await expect(page.locator('.truss-node')).toHaveCount(0);
    expect(readFileSync(join(dir, 'truss.json'), 'utf8')).toBe(text);
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});
