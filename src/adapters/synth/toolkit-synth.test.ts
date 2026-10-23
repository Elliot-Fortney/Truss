import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
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

const worker = (name: string) => fileURLToPath(new URL(`../../../test/support/workers/${name}`, import.meta.url));

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

  describe('with an overlay (a Draft)', () => {
    it('synths a shadow copy with the overlay’s text and leaves the real files alone', async () => {
      const dir = fixtureDir('straight-line');
      const path = join(dir, 'lib/shop-stack.ts');
      const before = readFileSync(path, 'utf8');
      const edited = before.replace("'Uploads'", "'Renamed'");
      const result = await new ToolkitSynth().synth(dir, { overlay: new Map([['lib/shop-stack.ts', edited]]) });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.assembly.tree.children.find((c) => c.path === 'ShopStack')?.children.map((c) => c.path)).toContain('ShopStack/Renamed');
      // The creation stacks are relative to the app folder, as they are for a real synth.
      expect(result.assembly.creation['ShopStack/Renamed/Resource']?.[0]).toMatchObject({ file: 'lib/shop-stack.ts', line: 11 });
      expect(readFileSync(path, 'utf8')).toBe(before);
    });

    it('returns the synth error when the Draft’s text does not compile', async () => {
      const dir = fixtureDir('straight-line');
      const result = await new ToolkitSynth().synth(dir, { overlay: new Map([['lib/shop-stack.ts', 'this is not typescript(']]) });
      expect(result.ok).toBe(false);
    });

    it('runs the app’s build script in the shadow copy first when the app runs compiled JavaScript', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'truss-compiled-'));
      writeFileSync(join(dir, 'cdk.json'), JSON.stringify({ app: 'node app.js' }));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node build.js' } }));
      writeFileSync(join(dir, 'build.js'), "require('fs').copyFileSync('src.js', 'app.js');");
      const src = (id: string) => `const cdk = require('aws-cdk-lib'); new cdk.Stack(new cdk.App(), '${id}');`;
      writeFileSync(join(dir, 'src.js'), src('Original'));
      symlinkSync(join(fixtureDir('straight-line'), 'node_modules'), join(dir, 'node_modules'));

      const synth = new ToolkitSynth();
      expect(await synth.draftSupport(dir)).toEqual({ ok: true });
      const result = await synth.synth(dir, { overlay: new Map([['src.js', src('Edited')]]) });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.assembly.stacks.map((s) => s.path)).toEqual(['Edited']);
      // Nothing was built in the user's folder.
      expect(existsSync(join(dir, 'app.js'))).toBe(false);
    });

    it('returns the build’s output as the synth error when the build fails', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'truss-compiled-'));
      writeFileSync(join(dir, 'cdk.json'), JSON.stringify({ app: 'node app.js' }));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "console.error(\'type error in lib\'); process.exit(2)"' } }));
      const result = await new ToolkitSynth().synth(dir, { overlay: new Map([['x.js', '']]) });
      expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('build'), output: expect.stringContaining('type error in lib') } });
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

  describe('timeout', () => {
    it('kills a synth that runs too long and says so', async () => {
      const synth = new ToolkitSynth({ timeoutMs: 300, worker: worker('hang-worker.mjs') });
      const started = Date.now();
      const result = await synth.synth('/app');
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result).toEqual({ ok: false, error: { message: 'synth timed out after 0.3 s', output: '' } });
    });

    it('says whole seconds for the default-sized timeouts', async () => {
      const synth = new ToolkitSynth({ timeoutMs: 1000, worker: worker('hang-worker.mjs') });
      const result = await synth.synth('/app');
      expect(!result.ok && result.error.message).toBe('synth timed out after 1 s');
    });

    it('kills the app command the timed-out synth started', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'truss-slow-'));
      const pidFile = join(dir, 'app.pid');
      writeFileSync(
        join(dir, 'hang.js'),
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      );
      writeFileSync(join(dir, 'cdk.json'), JSON.stringify({ app: 'node hang.js' }));

      const pending = new ToolkitSynth({ timeoutMs: 8_000 }).synth(dir);
      await until(() => existsSync(pidFile));
      const appPid = Number(readFileSync(pidFile, 'utf8'));
      const result = await pending;
      expect(!result.ok && result.error.message).toMatch(/timed out/);
      await until(() => !alive(appPid));
    }, 30_000);

    it('starts the next synth in a fresh child process', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'truss-fresh-'));
      const marker = join(dir, 'seen');
      // Hangs on its first run in a fresh child; a child that remembered the hang would never answer.
      writeFileSync(
        join(dir, 'worker.mjs'),
        `import { existsSync, writeFileSync } from 'node:fs';
         process.on('message', () => {
           if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, ''); return setInterval(() => {}, 1000); }
           const tree = { id: 'App', path: '', fqn: 'x', children: [] };
           process.send({ ok: true, assembly: { schemaVersion: '1', tree, stacks: [], creation: {} } }, () => process.exit(0));
         });`,
      );
      const synth = new ToolkitSynth({ timeoutMs: 500, worker: join(dir, 'worker.mjs') });
      expect((await synth.synth('/app')).ok).toBe(false);
      expect((await synth.synth('/app')).ok).toBe(true);
    });
  });

  describe('a crashed child', () => {
    it('is an error naming the exit code and what it printed', async () => {
      const synth = new ToolkitSynth({ worker: worker('crash-worker.mjs') });
      const result = await synth.synth('/app');
      expect(result).toMatchObject({ ok: false, error: { message: 'synth process exited with code 7' } });
      expect(!result.ok && result.error.output).toContain('worker went down');
    });

    it('is not restarted on its own, only by the next request', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'truss-crash-'));
      const counter = join(dir, 'count');
      writeFileSync(counter, '');
      writeFileSync(
        join(dir, 'crash.mjs'),
        `import { appendFileSync } from 'node:fs'; process.on('message', () => { appendFileSync(${JSON.stringify(counter)}, 'x'); process.exit(1); });`,
      );
      const synth = new ToolkitSynth({ worker: join(dir, 'crash.mjs') });
      await synth.synth('/app');
      await new Promise((r) => setTimeout(r, 500));
      expect(readFileSync(counter, 'utf8')).toBe('x');
      await synth.synth('/app');
      expect(readFileSync(counter, 'utf8')).toBe('xx');
    });
  });
});
