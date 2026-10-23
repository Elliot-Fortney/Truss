// PROTOTYPE (throwaway, ticket #15): drives the spike in Chrome and prints
// frame-time numbers. Usage: npm run bench [-- --throttle=4 --only=<substr>]
import { build, preview } from 'vite';
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const THROTTLE = +arg('throttle', 1);
const ONLY = arg('only', '');

const VARIANTS = [];
for (const expand of ['none', 'l3', 'all'])
  for (const mode of ['omit', 'hidden'])
    for (const apply of ['replace', 'diff'])
      for (const orv of ['0', '1'])
        VARIANTS.push({ nodes: '500', expand, mode, apply, orv });

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
const med = (xs) => pct(xs, 50);
const r1 = (x) => Math.round(x * 10) / 10;
const frames = (ds) => ({ fps: r1(1000 / (ds.reduce((a, b) => a + b, 0) / ds.length)), p50: r1(med(ds)), p95: r1(pct(ds, 95)), max: r1(Math.max(...ds)), long: ds.filter((d) => d > 33.4).length, n: ds.length });

await build({ logLevel: 'warn' });
const server = await preview({ preview: { port: 4179, strictPort: true }, logLevel: 'warn' });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });

async function emptyPanePoint(page) {
  return page.evaluate(() => {
    for (let y = 120; y < innerHeight - 40; y += 20)
      for (let x = 40; x < innerWidth - 40; x += 20)
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
    return null;
  });
}

async function measure(page, gesture) {
  await page.evaluate(() => window.bench.record());
  await gesture();
  return frames(await page.evaluate(() => window.bench.stop()));
}

async function pan(page) {
  const p = await emptyPanePoint(page);
  if (!p) return null;
  return measure(page, async () => {
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    for (let i = 1; i <= 90; i++) { await page.mouse.move(p.x + Math.sin(i / 15) * 300, p.y + Math.cos(i / 15) * 150 - 150); await page.waitForTimeout(16); }
    await page.mouse.up();
  });
}

async function zoom(page) {
  return measure(page, async () => {
    await page.mouse.move(700, 450);
    for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, i < 30 ? -60 : 60); await page.waitForTimeout(16); }
  });
}

async function drag(page, id) {
  await page.evaluate((id) => window.bench.center(id), id);
  await page.evaluate(() => window.bench.settle());
  const p = await page.evaluate((id) => window.bench.screenPos(id), id);
  return measure(page, async () => {
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    for (let i = 1; i <= 60; i++) { await page.mouse.move(p.x + i * 4, p.y + Math.sin(i / 8) * 60); await page.waitForTimeout(16); }
    await page.mouse.up();
  });
}

const summarise = (rs) => {
  const keys = ['project', 'stringify', 'parse', 'reconcile', 'commit', 'toPaint', 'settled'];
  return { ...Object.fromEntries(keys.map((k) => [k, r1(med(rs.map((r) => r[k])))])), maxSettled: r1(Math.max(...rs.map((r) => r.settled))), kb: Math.round(med(rs.map((r) => r.bytes)) / 1024), changed: med(rs.map((r) => r.changed)) };
};

const results = [];
for (const v of VARIANTS) {
  const key = new URLSearchParams(v).toString();
  if (ONLY && !key.includes(ONLY)) continue;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  const t0 = Date.now();
  await page.goto(`http://localhost:4179/?${key}`);
  await page.waitForFunction(() => window.benchReady, null, { timeout: 120000 });
  await page.evaluate(() => window.bench.settle());
  const load = Date.now() - t0;
  const stats = await page.evaluate(() => window.bench.stats());

  const out = { ...v, throttle: THROTTLE, load, ...stats };
  out.panFit = await pan(page);
  out.zoom = await zoom(page);
  await page.evaluate(() => window.bench.fitView()); await page.evaluate(() => window.bench.settle());

  const fn = (await page.evaluate(() => window.bench.ids('L2', false)))[0];
  out.drag = await drag(page, fn);
  out.domNodesAtZoom1 = (await page.evaluate(() => window.bench.stats())).domNodes;
  out.pan1 = await pan(page);
  await page.evaluate(() => window.bench.fitView()); await page.evaluate(() => window.bench.settle());

  // Expand then collapse five L3s (or collapse then expand, when all are open).
  const open = v.expand !== 'none';
  const l3 = (await page.evaluate((o) => window.bench.ids('L3', o), open)).slice(0, 5);
  const first = [], second = [];
  for (const id of l3) first.push(await page.evaluate((id) => window.bench.toggle(id), id));
  for (const id of l3) second.push(await page.evaluate((id) => window.bench.toggle(id), id));
  out.expand = summarise(open ? second : first);
  out.collapse = summarise(open ? first : second);
  const edits = [];
  for (const id of (await page.evaluate(() => window.bench.ids('L2', false))).slice(0, 5)) edits.push(await page.evaluate((id) => window.bench.edit(id), id));
  out.edit = summarise(edits);

  console.log(JSON.stringify(out));
  results.push(out);
  await page.close();
}

writeFileSync(`results-throttle${THROTTLE}${ONLY ? '-' + ONLY.replace(/\W/g, '_') : ''}.json`, JSON.stringify(results, null, 2));
await browser.close();
server.httpServer.close();
