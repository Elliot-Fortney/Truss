import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureDir } from '../../../test/support/fixture.ts';
import { ToolkitSynth } from './toolkit-synth.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('ToolkitSynth', () => {
  it('synths the straight-line fixture with creation stacks', async () => {
    const result = await new ToolkitSynth().synth(fixtureDir('straight-line'));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.assembly.stacks).toEqual([{ path: 'ShopStack', env: 'aws://123456789012/us-east-1' }]);
    expect(result.assembly.creation['ShopStack/Uploads/Resource']?.[0]).toMatchObject({
      file: 'lib/shop-stack.ts',
      line: 11,
    });
  });

  it('returns a synth error, not a throw, when the app fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'truss-bad-'));
    writeFileSync(join(dir, 'cdk.json'), JSON.stringify({ app: 'node -e "console.error(\'kaboom\'); process.exit(1)"' }));
    const result = await new ToolkitSynth().synth(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/exited|kaboom|failed/i);
  });

  it('kills the whole process tree when aborted, leaving nothing running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'truss-hang-'));
    mkdirSync(dir, { recursive: true });
    const pidFile = join(dir, 'app.pid');
    writeFileSync(
      join(dir, 'hang.js'),
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    writeFileSync(join(dir, 'cdk.json'), JSON.stringify({ app: 'node hang.js' }));

    const abort = new AbortController();
    const pending = new ToolkitSynth().synth(dir, { signal: abort.signal });
    await until(() => existsSync(pidFile));
    const appPid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(appPid)).toBe(true);

    abort.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    await until(() => !alive(appPid));
  });
});
