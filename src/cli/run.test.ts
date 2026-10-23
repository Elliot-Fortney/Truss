import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { TsSource } from '../adapters/source/ts-source.ts';
import { memoryFiles } from '../../test/support/memory-files.ts';
import { readFixtureAssembly, readFixtureFiles } from '../../test/support/fixture.ts';
import { run, type RunDeps } from './run.ts';

function deps(overrides: Partial<RunDeps> = {}): RunDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    cwd: '/work/app',
    findApp: () => '/work/app',
    synth: { synth: async () => ({ ok: true, assembly: readFixtureAssembly('straight-line') }) },
    files: () => memoryFiles(readFixtureFiles('straight-line')),
    source: new TsSource(),
    loadCatalog: async () => ({ ok: true, catalog: { entries: [], dropped: [] } }),
    token: 'tok123',
    ui: { '/': { type: 'text/html', body: '<p>ui</p>' } },
    open: vi.fn(),
    openInEditor: vi.fn(),
    log: (line) => lines.push(line),
    ...overrides,
  };
}

describe('run', () => {
  it('prints a loopback URL carrying the session token and opens the browser on it', async () => {
    const d = deps();
    const running = await run({ open: true, port: 0 }, d);
    try {
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=tok123$/);
      expect(d.lines.join('\n')).toContain(running.url);
      expect(d.open).toHaveBeenCalledWith(running.url);
    } finally {
      await running.stop();
    }
  });

  it('does not open the browser with --no-open', async () => {
    const d = deps();
    const running = await run({ open: false, port: 0 }, d);
    try {
      expect(d.open).not.toHaveBeenCalled();
    } finally {
      await running.stop();
    }
  });

  it('refuses to start outside a CDK app', async () => {
    const d = deps({ findApp: () => undefined });
    await expect(run({ open: false }, d)).rejects.toThrow(/cdk\.json/);
  });

  it('refuses to start, saying why, when the app is one Truss cannot open', async () => {
    const d = deps({ loadCatalog: async () => ({ ok: false, message: 'aws-cdk-lib 2.100.0 is older than the minimum' }) });
    await expect(run({ open: false, port: 0 }, d)).rejects.toThrow('aws-cdk-lib 2.100.0 is older than the minimum');
    expect(d.open).not.toHaveBeenCalled();
  });

  it('reads the Catalog of the app it found, before it opens anything', async () => {
    const loadCatalog = vi.fn(async () => ({ ok: true as const, catalog: { entries: [], dropped: [] } }));
    const d = deps({ loadCatalog });
    const running = await run({ open: false, port: 0 }, d);
    await running.stop();
    expect(loadCatalog).toHaveBeenCalledWith('/work/app');
  });

  it('says how many edits the Draft holds, none to begin with, so that Ctrl+C knows whether to ask', async () => {
    const running = await run({ open: false, port: 0 }, deps());
    try {
      expect(running.draftSize()).toBe(0);
    } finally {
      await running.stop();
    }
  });

  it('stops its synth when it stops', async () => {
    const dispose = vi.fn();
    const d = deps({ synth: { synth: async () => ({ ok: false, error: { message: 'x' } }), dispose } });
    const running = await run({ open: false, port: 0 }, d);
    await running.stop();
    expect(dispose).toHaveBeenCalled();
  });

  it('stops watching the app when it stops', async () => {
    const unwatch = vi.fn();
    const d = deps({ files: () => ({ ...memoryFiles(readFixtureFiles('straight-line')), watch: () => unwatch }) });
    const running = await run({ open: false, port: 0 }, d);
    await running.stop();
    expect(unwatch).toHaveBeenCalled();
  });

  describe('open in editor', () => {
    const ask = async (d: ReturnType<typeof deps>, file: string, extra: object = {}) => {
      const running = await run({ open: false, port: 0 }, d);
      const url = new URL(running.url);
      const ws = new WebSocket(`ws://${url.host}/ws?token=tok123`, { origin: url.origin });
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ type: 'open-in-editor', file, ...extra }));
      // A second, valid request is handled after the first, so by then the first has been dropped or acted on.
      ws.send(JSON.stringify({ type: 'open-in-editor', file: 'sentinel.ts' }));
      await vi.waitFor(() => expect(d.openInEditor).toHaveBeenCalledWith(expect.objectContaining({ file: '/work/app/sentinel.ts' })));
      ws.close();
      await running.stop();
    };

    it('opens a file in the app at the asked position, as an absolute path', async () => {
      const d = deps();
      await ask(d, 'lib/shop-stack.ts', { line: 12, col: 9 });
      expect(d.openInEditor).toHaveBeenCalledWith({ file: '/work/app/lib/shop-stack.ts', line: 12, col: 9 });
    });

    it('refuses a path that leaves the app folder', async () => {
      const d = deps();
      await ask(d, '../outside/secret.ts');
      await ask(d, '/etc/passwd');
      expect(d.openInEditor).not.toHaveBeenCalledWith(expect.objectContaining({ file: expect.stringContaining('secret') }));
      expect(d.openInEditor).not.toHaveBeenCalledWith(expect.objectContaining({ file: '/etc/passwd' }));
    });
  });
});
