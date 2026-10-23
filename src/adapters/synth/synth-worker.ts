// Runs in a child process so a hung or crashing app can be killed without taking Truss down.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Toolkit } from '@aws-cdk/toolkit-lib';
import type { SynthResult } from '../../core/assembly.ts';
import { readAssembly } from './read-assembly.ts';

export interface WorkerRequest {
  appDir: string;
}

const output: string[] = [];

async function synth({ appDir }: WorkerRequest): Promise<SynthResult> {
  const outdir = mkdtempSync(join(tmpdir(), 'truss-synth-'));
  try {
    const toolkit = new Toolkit({
      ioHost: {
        notify: async (msg) => {
          if (msg.level !== 'trace') output.push(String(msg.message));
        },
        requestResponse: async (msg) => msg.defaultResponse,
      },
    });
    const source = await toolkit.fromCdkApp(await appCommand(appDir), {
      workingDirectory: appDir,
      outdir,
      // ADR 0011: Truss never performs context lookups.
      lookups: false,
      // Creation stacks are how a construct path is traced back to the line that made it.
      synthOptions: { debug: true },
    });
    const cached = await toolkit.synth(source);
    const assembly = readAssembly(outdir, appDir);
    await cached.dispose?.();
    return { ok: true, assembly };
  } catch (err) {
    return {
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err), output: output.join('\n') },
    };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

async function appCommand(appDir: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const cdkJson = JSON.parse(readFileSync(join(appDir, 'cdk.json'), 'utf8')) as { app?: string };
  if (!cdkJson.app) throw new Error('cdk.json has no "app" command');
  return cdkJson.app;
}

process.on('message', async (req: WorkerRequest) => {
  const result = await synth(req);
  process.send?.(result, () => process.exit(0));
});
