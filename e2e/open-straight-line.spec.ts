import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, 'dist/cli.js');
const app = resolve(root, 'test/fixtures/straight-line');

/** Starts `truss --no-open` in an app folder and resolves with its URL once it prints one. */
function startTruss(cwd = app, env: NodeJS.ProcessEnv = {}): Promise<{ child: ChildProcess; url: string; exited: Promise<number | null> }> {
  return new Promise((resolveStart, reject) => {
    const child = spawn('node', [cli, '--no-open'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    // An app without Stages has no Stage picker.
    await expect(page.getByLabel('Stage')).toHaveCount(0);
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

/** A throwaway copy of the fixture app (without any truss.json) that a test may edit while Truss watches it. */
function copyApp(from = app): string {
  const dir = mkdtempSync(join(tmpdir(), 'truss-e2e-'));
  cpSync(from, dir, { recursive: true, filter: (src) => !/node_modules|cdk\.out|truss\.json/.test(src) });
  // The shapes fixture shares the straight-line fixture's install locally; in CI each has its own.
  const installed = existsSync(join(from, 'node_modules')) ? join(from, 'node_modules') : join(app, 'node_modules');
  symlinkSync(installed, join(dir, 'node_modules'));
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

test('a dragged Node and its note are saved in truss.json and survive a reload', async ({ page }) => {
  const dir = copyApp();
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

    // Delete is a code edit, not a canvas gesture: the selected Node must stay.
    await orders.click();
    await page.keyboard.press('Delete');
    await expect(orders).toBeVisible();

    // Add a note to it.
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
  const dir = copyApp();
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

test('Nodes Truss cannot edit show a lock with the reason, and every Node opens in the editor', async ({ page }) => {
  const dir = copyApp(resolve(root, 'test/fixtures/shapes'));
  const bin = mkdtempSync(join(tmpdir(), 'truss-editor-'));
  // Named like VS Code's launcher so Truss passes `--goto file:line:col`.
  const editor = join(bin, 'code');
  const opened = join(bin, 'opened.txt');
  writeFileSync(editor, `#!/bin/sh\necho "$@" > "${opened}"\n`, { mode: 0o755 });
  const truss = await startTruss(dir, { TRUSS_EDITOR: editor });
  try {
    await page.goto(truss.url);
    const loop = page.locator('.truss-node', { hasText: 'LoopOne' });
    await expect(loop).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.truss-node')).toHaveCount(25);
    // 4 loop Nodes, 2 helper Nodes, 1 whose ID is a variable and 1 import.
    await expect(page.locator('.node-lock')).toHaveCount(8);
    await expect(loop.locator('.node-lock')).toHaveAttribute('title', 'Created in a loop');
    await expect(page.locator('.truss-node', { hasText: 'HelperA' }).locator('.node-lock')).toHaveAttribute('title', 'Created by the helper makeQueue');
    await expect(page.locator('.truss-node', { hasText: 'Plain' }).locator('.node-lock')).toHaveCount(0);
    // A locked Node stays fully opaque.
    await expect(loop).toHaveCSS('opacity', '1');

    await loop.click();
    await expect(page.locator('.lock-reason')).toHaveText('Read-only: Created in a loop');
    await page.getByRole('button', { name: 'Open in editor' }).click();
    await expect.poll(() => (existsSync(opened) ? readFileSync(opened, 'utf8').trim() : '')).toMatch(/^--goto .*\/lib\/shapes-stack\.ts:41:7$/);

    // An editable Node opens in the editor too, and says nothing about a lock.
    await page.locator('.truss-node', { hasText: 'Plain' }).click();
    await expect(page.locator('.lock-reason')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open in editor' })).toBeVisible();
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});

test('Stages show one at a time, nested stacks sit in their parent, imports are dashed and user classes name their base type', async ({ page }) => {
  const dir = copyApp(resolve(root, 'test/fixtures/shapes'));
  const truss = await startTruss(dir);
  try {
    await page.goto(truss.url);
    const picker = page.getByLabel('Stage');
    await expect(picker).toBeVisible({ timeout: 60_000 });
    await expect(picker.locator('option')).toHaveText(['StageDev', 'StageProd']);

    // The first Stage in synth order is open; the Stacks outside every Stage are there too.
    await expect(picker).toHaveValue('StageDev');
    await expect(page.locator('.stack-header strong', { hasText: /^Core$/ })).toHaveCount(1);
    await expect(page.locator('.truss-node', { hasText: 'Events' })).toHaveCount(1);
    await expect(page.locator('.stack-header strong', { hasText: /^Shapes$/ })).toBeVisible();
    await expect(page.locator('.stack-header strong', { hasText: /^Dev$/ })).toBeVisible();

    // A nested stack is a box inside its parent's, with the parent's environment.
    const parent = page.locator('.stack-box', { has: page.locator('.stack-header strong', { hasText: /^Shapes$/ }) }).first();
    const nested = page.locator('.stack-box', { has: page.locator('.stack-header strong', { hasText: /^Nested$/ }) }).first();
    const [outer, inner] = [(await parent.boundingBox())!, (await nested.boundingBox())!];
    expect(inner.x).toBeGreaterThanOrEqual(outer.x);
    expect(inner.y).toBeGreaterThanOrEqual(outer.y);
    expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
    expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
    await expect(nested).toContainText('us-east-1 · 123456789012');
    await expect(page.locator('.truss-node', { hasText: 'InnerQueue' })).toBeVisible();

    // A `fromXxx` import is dashed; a class of the app's own says what it builds on.
    await expect(page.locator('.truss-node.external')).toHaveCount(1);
    await expect(page.locator('.truss-node.external')).toContainText('Existing');
    await expect(page.locator('.truss-node', { hasText: 'Plain' })).not.toHaveClass(/external/);
    await expect(page.locator('.truss-node', { hasText: 'Docs' })).toContainText('MyBucket · S3 Bucket');

    // Picking the other Stage swaps its Stacks in, and the choice survives a reload.
    await picker.selectOption('StageProd');
    await expect(page.locator('.stack-header strong', { hasText: /^Core$/ })).toHaveCount(1);
    await expect(page.locator('.truss-node', { hasText: 'Events' })).toHaveCount(1);
    await page.reload();
    await expect(page.getByLabel('Stage')).toHaveValue('StageProd', { timeout: 60_000 });
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});
