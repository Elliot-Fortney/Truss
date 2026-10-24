import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, 'dist/cli.js');
const app = resolve(root, 'test/fixtures/straight-line');

/** Starts `truss --no-open` in an app folder and resolves with its URL once it prints one. */
function startTruss(
  cwd = app,
  env: NodeJS.ProcessEnv = {},
): Promise<{ child: ChildProcess; url: string; exited: Promise<number | null> }> {
  return new Promise((resolveStart, reject) => {
    const child = spawn('node', [cli, '--no-open'], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    for (const [label, cls] of [
      ['Uploads', 'Bucket'],
      ['Orders', 'Queue'],
      ['Catalog', 'Table'],
    ]) {
      const node = page.locator('.truss-node', { hasText: label });
      await expect(node).toBeVisible();
      await expect(node).toContainText(cls!);
    }
    await expect(page.locator('.truss-node')).toHaveCount(3);
    // Each Node shows the official icon for its type, and it really loaded.
    for (const [label, icon] of [
      ['Uploads', 'Res_Amazon-Simple-Storage-Service_Bucket_48'],
      ['Orders', 'Res_Amazon-Simple-Queue-Service_Queue_48'],
      ['Catalog', 'Res_Amazon-DynamoDB_Table_48'],
    ]) {
      const img = page.locator('.truss-node', { hasText: label }).locator('img.node-icon');
      await expect(img).toHaveAttribute('src', new RegExp(icon!));
      expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    }
    // An app without Stages has no Stage picker.
    await expect(page.getByLabel('Stage')).toHaveCount(0);
  } finally {
    truss.child.kill('SIGINT');
    expect(await truss.exited).toBe(0);
  }
});

test('Node names show when zoomed in and drop away, leaving the icon, when zoomed out', async ({ page }) => {
  const truss = await startTruss();
  try {
    await page.goto(truss.url);
    const uploads = page.locator('.truss-node', { hasText: 'Uploads' });
    await expect(uploads).toBeVisible({ timeout: 60_000 });
    const name = uploads.locator('.node-label');
    // Three Nodes fit the view at a high zoom.
    await expect(uploads).not.toHaveClass(/icon-only/);
    await expect(name).toBeVisible();

    for (let i = 0; i < 8; i++) await page.locator('.react-flow__controls-zoomout').click();
    await expect(uploads).toHaveClass(/icon-only/);
    await expect(uploads.locator('img.node-icon')).toBeVisible();
    await expect(name).not.toBeInViewport();
    // The name is still in the page for a screen reader, and in the tooltip.
    await expect(name).toHaveText('Uploads');
    await expect(uploads).toHaveAttribute('title', /^Uploads · aws-cdk-lib\.aws_s3\.Bucket/);

    for (let i = 0; i < 3; i++) await page.locator('.react-flow__controls-zoomin').click();
    await expect(uploads).not.toHaveClass(/icon-only/);
    await expect(name).toBeInViewport();
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
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

test('breaking the app from outside dims the last good Design under a banner, and fixing it recovers', async ({
  page,
}) => {
  const dir = copyApp();
  const stackFile = join(dir, 'lib/shop-stack.ts');
  const original = readFileSync(stackFile, 'utf8');
  const truss = await startTruss(dir);
  try {
    await page.goto(truss.url);
    await expect(page.locator('.truss-node')).toHaveCount(3, { timeout: 60_000 });

    writeFileSync(
      stackFile,
      original.replace(
        'super(scope, id, props);',
        "super(scope, id, props);\n    throw new Error('outside change broke it');",
      ),
    );
    const banner = page.locator('.error-banner');
    await expect(banner).toContainText('outside change broke it', { timeout: 60_000 });
    await expect(banner.getByRole('button', { name: 'Open in editor' })).toBeVisible();
    await expect(page.locator('.truss-node')).toHaveCount(3);
    await expect(page.locator('.canvas')).toHaveClass(/dimmed/);
    // Editing is paused: no Node can be dragged.
    await expect(page.locator('.react-flow__node.draggable')).toHaveCount(0);

    writeFileSync(stackFile, original);
    await expect(banner).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('.canvas')).not.toHaveClass(/dimmed/);
    await expect(page.locator('.react-flow__node-truss.draggable')).toHaveCount(3);
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});

test('a failed first open shows the error full page, then loads the Design once the app synths', async ({ page }) => {
  const dir = copyApp();
  const stackFile = join(dir, 'lib/shop-stack.ts');
  const original = readFileSync(stackFile, 'utf8');
  writeFileSync(
    stackFile,
    original.replace(
      'super(scope, id, props);',
      "super(scope, id, props);\n    throw new Error('broken from the start');",
    ),
  );
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

    await expect
      .poll(() => (existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) : undefined))
      .toMatchObject({
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
    await expect
      .poll(() => JSON.parse(readFileSync(sidecar, 'utf8')).nodes['ShopStack/Orders'].note)
      .toBe('Retries 3x, then DLQ');

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
    // 25 of the app's own, and the notifications handler Outer's bucket brought with it.
    await expect(page.locator('.truss-node')).toHaveCount(26);
    // 4 loop Nodes, 2 helper Nodes, 1 whose ID is a variable, 1 import and the hoisted handler.
    await expect(page.locator('.node-lock')).toHaveCount(9);
    await expect(loop.locator('.node-lock')).toHaveAttribute('title', 'Created in a loop');
    await expect(page.locator('.truss-node', { hasText: 'HelperA' }).locator('.node-lock')).toHaveAttribute(
      'title',
      'Created by the helper makeQueue',
    );
    await expect(page.locator('.truss-node', { hasText: 'Plain' }).locator('.node-lock')).toHaveCount(0);
    // A locked Node stays fully opaque.
    await expect(loop).toHaveCSS('opacity', '1');

    await loop.click();
    await expect(page.getByText('Read-only: Created in a loop')).toBeVisible();
    await page.getByRole('button', { name: 'Open in editor' }).click();
    await expect
      .poll(() => (existsSync(opened) ? readFileSync(opened, 'utf8').trim() : ''))
      .toMatch(/^--goto .*\/lib\/shapes-stack\.ts:41:7$/);

    // An editable Node opens in the editor too, and says nothing about a lock.
    await page.locator('.truss-node', { hasText: 'Plain' }).click();
    await expect(page.getByText(/^Read-only:/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open in editor' })).toBeVisible();
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});

test('Stages show one at a time, nested stacks sit in their parent, imports are dashed and user classes name their base type', async ({
  page,
}) => {
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
    const parent = page
      .locator('.stack-box', { has: page.locator('.stack-header strong', { hasText: /^Shapes$/ }) })
      .first();
    const nested = page
      .locator('.stack-box', { has: page.locator('.stack-header strong', { hasText: /^Nested$/ }) })
      .first();
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

    // A construct with no service to name gets the generic icon, drawn through a mask that must have parsed.
    await expect(page.locator('.node-icon.generic').first()).toHaveCSS('mask-image', /^url\(/);

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

test("the palette searches the app's own Catalog by name, service or CloudFormation type and shows each tier", async ({
  page,
}) => {
  const truss = await startTruss();
  try {
    await page.goto(truss.url);
    const palette = page.getByRole('complementary', { name: 'Palette' });
    const search = palette.getByLabel('Search constructs');
    await expect(search).toBeVisible({ timeout: 60_000 });

    // By CloudFormation type: the L1 and the L2 built on it, each with its tier.
    await search.fill('AWS::S3::Bucket');
    await expect(palette.locator('[title="aws-cdk-lib.aws_s3.Bucket"]')).toBeVisible();
    await expect(palette.locator('[title="aws-cdk-lib.aws_s3.Bucket"] .tier')).toHaveText('L2');
    await expect(palette.locator('[title="aws-cdk-lib.aws_s3.CfnBucket"] .tier')).toHaveText('L1');

    // By name, and by service.
    await search.fill('queue');
    await expect(palette.locator('[title="aws-cdk-lib.aws_sqs.Queue"]')).toBeVisible();
    await search.fill('dynamodb');
    await expect(palette.locator('[title="aws-cdk-lib.aws_dynamodb.Table"]')).toBeVisible();

    // An L3 pattern is told from the rest by its tier.
    await search.fill('ApplicationLoadBalancedFargateService');
    await expect(
      palette.locator('[title="aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService"] .tier'),
    ).toHaveText('L3');

    await search.fill('zzzzzz-nothing');
    await expect(palette.getByText('No constructs match.')).toBeVisible();
  } finally {
    truss.child.kill('SIGINT');
    expect(await truss.exited).toBe(0);
  }
});

test('expanding a Node shows its read-only children down to the L1 with their CloudFormation type, and collapsing hides them', async ({
  page,
}) => {
  const dir = copyApp();
  const truss = await startTruss(dir);
  try {
    await page.goto(truss.url);
    const uploads = page.locator('.truss-node', { hasText: 'Uploads' });
    await expect(uploads).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.layer-node')).toHaveCount(0);

    await uploads.getByRole('button', { name: 'Expand Uploads' }).click();
    const resource = page.locator('.layer-node', { hasText: 'AWS::S3::Bucket' });
    await expect(resource).toBeVisible();
    await expect(resource).toHaveAttribute('title', /^ShopStack\/Uploads\/Resource · AWS::S3::Bucket/);
    // The child sits inside the Node's box.
    const [outer, inner] = [(await uploads.boundingBox())!, (await resource.boundingBox())!];
    expect(inner.x).toBeGreaterThanOrEqual(outer.x);
    expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
    // Still three Nodes of the app's own; a child is not one.
    await expect(page.locator('.truss-node')).toHaveCount(3);

    // A child is read-only: it can be selected for its path and type, but not dragged.
    await resource.click();
    const panel = page.getByRole('complementary').filter({ hasText: 'Construct path' });
    await expect(panel).toContainText('ShopStack/Uploads/Resource');
    await expect(panel).toContainText('Read-only');
    await expect(page.locator('.react-flow__node-layer.draggable')).toHaveCount(0);

    await uploads.getByRole('button', { name: 'Collapse Uploads' }).click();
    await expect(page.locator('.layer-node')).toHaveCount(0);
    // Expanding and collapsing is view state: nothing is written to the app.
    expect(existsSync(join(dir, 'truss.json'))).toBe(false);
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});

test('a resource a construct creates outside its own subtree is drawn at Stack scope, read-only and linked to the Node that caused it', async ({
  page,
}) => {
  const dir = copyApp(resolve(root, 'test/fixtures/shapes'));
  const truss = await startTruss(dir);
  try {
    await page.goto(truss.url);
    const handler = page.locator('.truss-node.hoisted', { hasText: 'BucketNotificationsHandler' });
    await expect(handler).toBeVisible({ timeout: 60_000 });
    await expect(handler.locator('.node-lock')).toBeVisible();
    await expect(page.locator('.react-flow__edge.cause-edge')).not.toHaveCount(0);
    await handler.getByRole('button', { name: /^Expand/ }).click();
    // The Role is itself a Layer, opened down to its L1.
    await expect(page.locator('.layer-node', { hasText: 'AWS::IAM::Role' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Expand Role' }).click();
    await expect(page.locator('.layer-node', { hasText: 'AWS::IAM::Role' })).toBeVisible();
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});

test("selecting a Node lists its props with an input for each literal, and a Stack header opens the Stack's props", async ({
  page,
}) => {
  const truss = await startTruss();
  try {
    await page.goto(truss.url);
    const props = page.getByRole('region', { name: 'Properties' });
    await expect(page.locator('.truss-node', { hasText: 'Uploads' })).toBeVisible({ timeout: 60_000 });

    await page.locator('.truss-node', { hasText: 'Uploads' }).click();
    const versioned = props.locator('.prop-row', { has: page.getByText('versioned', { exact: true }) });
    await expect(versioned.getByRole('checkbox', { name: 'versioned' })).toBeChecked();
    await expect(versioned).toContainText('boolean');

    // Props the code doesn't set are one click away, with their CDK default as text.
    await expect(
      props.locator('.prop-row', { has: page.getByText('transferAcceleration', { exact: true }) }),
    ).toHaveCount(0);
    await props.getByRole('button', { name: /more props?$/ }).click();
    await expect(
      props.locator('.prop-row', { has: page.getByText('transferAcceleration', { exact: true }) }),
    ).toContainText('Default:');

    // A Duration is an amount and a unit.
    await page.locator('.truss-node', { hasText: 'Orders' }).click();
    await expect(props.getByLabel('visibilityTimeout amount')).toHaveValue('30');
    await expect(props.getByLabel('visibilityTimeout unit')).toHaveValue('seconds');

    // A struct is a group of inputs for its fields, and its docs come from the Catalog.
    await page.locator('.truss-node', { hasText: 'Catalog' }).click();
    const partitionKey = props.locator('.prop-row', { has: page.getByText('partitionKey', { exact: true }) });
    await expect(partitionKey.getByLabel('partitionKey.name')).toHaveValue('sku');
    await expect(partitionKey.getByLabel('partitionKey.type')).toHaveValue('STRING');
    await expect(partitionKey).toContainText('Partition key attribute definition.');

    await page.locator('.stack-header', { hasText: 'ShopStack' }).click();
    await expect(page.getByRole('heading', { name: 'ShopStack' })).toBeVisible();
    for (const name of ['env', 'terminationProtection', 'description']) {
      await expect(props.locator('.prop-name', { hasText: new RegExp(`^${name}$`) })).toBeVisible();
    }
  } finally {
    truss.child.kill('SIGINT');
    expect(await truss.exited).toBe(0);
  }
});

test("an edit is staged in the Draft, shown with its diff, undone, redone and saved into the user's own file", async ({
  page,
}) => {
  const dir = copyApp();
  const stackFile = join(dir, 'lib/shop-stack.ts');
  const original = readFileSync(stackFile, 'utf8');
  const truss = await startTruss(dir);
  try {
    await page.goto(truss.url);
    const props = page.getByRole('region', { name: 'Properties' });
    const draft = page.getByRole('region', { name: 'Draft' });
    const uploads = page.locator('.truss-node', { hasText: 'Uploads' });
    await expect(uploads).toBeVisible({ timeout: 60_000 });
    await expect(draft).toHaveCount(0);

    // Untick `versioned` and type a bucket name: both are staged, neither is written.
    await uploads.click();
    await props.getByRole('checkbox', { name: 'versioned' }).uncheck();
    await expect(draft).toContainText('Draft · 1 edit');
    await expect(uploads).toHaveClass(/changed/);
    await props.getByRole('button', { name: /more props?$/ }).click();
    await props.getByLabel('bucketName', { exact: true }).fill('uploads-bucket');
    await props.getByLabel('bucketName', { exact: true }).blur();
    await expect(draft).toContainText('Draft · 2 edits');
    expect(readFileSync(stackFile, 'utf8')).toBe(original);

    // The review shows the exact diff Save will write.
    await draft.getByRole('button', { name: 'Review changes' }).click();
    const diff = draft.getByLabel('Changes to lib/shop-stack.ts');
    await expect(diff).toContainText('-      versioned: true,');
    await expect(diff).toContainText('+      versioned: false,');
    await expect(diff).toContainText("+      bucketName: 'uploads-bucket',");

    // Undo steps back through the Draft; redo brings the edit back.
    await draft.getByRole('button', { name: 'Undo' }).click();
    await expect(draft).toContainText('Draft · 1 edit');
    await expect(diff).not.toContainText('bucketName');
    await draft.getByRole('button', { name: 'Redo' }).click();
    await expect(draft).toContainText('Draft · 2 edits');

    // The Design is re-synthed with the Draft applied, then Save writes it.
    await expect(page.getByText('synthing…')).toHaveCount(0, { timeout: 60_000 });
    await draft.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => readFileSync(stackFile, 'utf8')).toContain("bucketName: 'uploads-bucket'");
    expect(readFileSync(stackFile, 'utf8')).toBe(
      original.replace('versioned: true,', "versioned: false,\n      bucketName: 'uploads-bucket',"),
    );
    await expect(draft).toHaveCount(0);
    await expect(uploads).not.toHaveClass(/changed/);
    // What was saved is what the Design shows, from a fresh synth of the user's files.
    await expect(page.getByText('synthing…')).toHaveCount(0, { timeout: 60_000 });
    await uploads.click();
    await expect(props.getByRole('checkbox', { name: 'versioned' })).not.toBeChecked();
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});

test("Discard drops the whole Draft, and the user's files are never touched", async ({ page }) => {
  const dir = copyApp();
  const stackFile = join(dir, 'lib/shop-stack.ts');
  const original = readFileSync(stackFile, 'utf8');
  const truss = await startTruss(dir);
  try {
    await page.goto(truss.url);
    const draft = page.getByRole('region', { name: 'Draft' });
    await page.locator('.truss-node', { hasText: 'Orders' }).click();
    const amount = page.getByLabel('visibilityTimeout amount');
    await amount.fill('90');
    await amount.blur();
    await expect(draft).toContainText('Draft · 1 edit', { timeout: 60_000 });
    await expect(draft).toContainText('visibilityTimeout → 90 seconds');
    await page.getByLabel('visibilityTimeout unit').selectOption('minutes');
    await expect(draft).toContainText('visibilityTimeout → 90 minutes');
    await draft.getByRole('button', { name: 'Discard' }).click();
    await expect(draft).toHaveCount(0);
    await expect(page.getByLabel('visibilityTimeout amount')).toHaveValue('30');
    expect(readFileSync(stackFile, 'utf8')).toBe(original);
  } finally {
    truss.child.kill('SIGINT');
    await truss.exited;
  }
});

test('Ctrl+C with an unsaved Draft and no terminal to ask on still stops Truss', async ({ page }) => {
  const dir = copyApp();
  const child = spawn('node', [cli, '--no-open'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  try {
    await expect.poll(() => /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/.exec(out)?.[0]).toBeTruthy();
    await page.goto(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/.exec(out)![0]);
    await page.locator('.truss-node', { hasText: 'Uploads' }).click();
    await page.getByRole('checkbox', { name: 'versioned' }).uncheck({ timeout: 60_000 });
    await expect(page.getByRole('region', { name: 'Draft' })).toContainText('1 edit');

    // Truss asks on the terminal before discarding a Draft (see quit.test.ts); with none to ask on, it quits.
    child.kill('SIGINT');
    expect(await exited).toBe(0);
  } finally {
    child.kill('SIGKILL');
  }
});
