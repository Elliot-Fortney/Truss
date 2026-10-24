import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, 'dist/cli.js');
const app = resolve(root, 'test/fixtures/references');

/** Starts `truss --no-open` in an app folder and resolves with its URL once it prints one. */
function startTruss(cwd: string): Promise<{ child: ChildProcess; url: string; exited: Promise<number | null> }> {
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

/** Drags from the right-hand handle of one Node and drops in the middle of another. */
async function dragFromTo(page: Page, from: Locator, to: Locator): Promise<void> {
  await from.hover();
  const handle = from.locator('.truss-handle.drag-handle');
  const h = (await handle.boundingBox())!;
  const t = (await to.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 12 });
  await page.mouse.up();
}

test('References are drawn as edges, and a drag from one Node to another stages one in the Draft', async ({ page }) => {
  const truss = await startTruss(app);
  try {
    await page.goto(truss.url);
    const node = (label: string) => page.locator('.truss-node', { hasText: label }).first();
    await expect(node('Plain')).toBeVisible({ timeout: 60_000 });
    // The code writes three: Data's key and logs, Reader's policy.
    await expect(page.locator('.react-flow__edge.reference-edge')).toHaveCount(3);

    // Dimmed while dragging: a Node no prop of Plain takes.
    await node('Plain').hover();
    const handle = (await node('Plain').locator('.truss-handle.drag-handle').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 40, handle.y + 40, { steps: 4 });
    await expect(page.locator('.react-flow__node.connect-dim', { hasText: 'Read' }).first()).toBeVisible();
    await expect(page.locator('.react-flow__node.connect-dim', { hasText: 'Spare' })).toHaveCount(0);
    await page.mouse.up();

    await dragFromTo(page, node('Plain'), node('Spare'));
    await expect(page.locator('.draft-bar, [aria-label="Draft"]').first()).toContainText('encryptionKey → Spare', {
      timeout: 30_000,
    });
    await expect(page.locator('.react-flow__edge.reference-edge')).toHaveCount(4, { timeout: 30_000 });
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});

test('a drop on a Node that takes nothing is refused where it was dropped, with the reason', async ({ page }) => {
  const truss = await startTruss(app);
  try {
    await page.goto(truss.url);
    const node = (label: string) => page.locator('.truss-node', { hasText: label }).first();
    await expect(node('Plain')).toBeVisible({ timeout: 60_000 });
    await dragFromTo(page, node('Plain'), node('Read'));
    const tip = page.locator('.refusal-tip');
    await expect(tip).toContainText('Plain has no prop that takes Read');
    await expect(tip.getByRole('button', { name: 'Open in editor' })).toBeVisible();
    await expect(page.locator('.react-flow__edge.reference-edge')).toHaveCount(3);
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});
