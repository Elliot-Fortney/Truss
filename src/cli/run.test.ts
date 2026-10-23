import { describe, expect, it, vi } from 'vitest';
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
    token: 'tok123',
    ui: { '/': { type: 'text/html', body: '<p>ui</p>' } },
    open: vi.fn(),
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

  it('stops its synth when it stops', async () => {
    const dispose = vi.fn();
    const d = deps({ synth: { synth: async () => ({ ok: false, error: { message: 'x' } }), dispose } });
    const running = await run({ open: false, port: 0 }, d);
    await running.stop();
    expect(dispose).toHaveBeenCalled();
  });
});
