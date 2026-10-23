import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SynthResult } from '../../core/assembly.ts';
import type { Synth } from '../../core/ports.ts';
import type { WorkerRequest } from './synth-worker.ts';

const WORKER = fileURLToPath(import.meta.url).replace(/toolkit-synth\.(ts|js)$/, 'synth-worker.$1');

/** The real Synth: CDK's own synth through `@aws-cdk/toolkit-lib`, in a child process that can be killed. */
export class ToolkitSynth implements Synth {
  private live = new Set<ChildProcess>();

  /** Kills every synth still running, so nothing outlives Truss. */
  dispose(): void {
    for (const child of this.live) killTree(child);
  }

  synth(appDir: string, opts: { signal?: AbortSignal } = {}): Promise<SynthResult> {
    return new Promise((resolve) => {
      // Its own process group, so killing the worker also kills the app command it spawned.
      const child = fork(WORKER, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true });
      this.live.add(child);
      let log = '';
      child.stdout?.on('data', (d) => (log += d));
      child.stderr?.on('data', (d) => (log += d));

      let settled = false;
      const settle = (result: SynthResult) => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener('abort', onAbort);
        this.live.delete(child);
        killTree(child);
        resolve(result);
      };
      const onAbort = () => settle({ ok: false, error: { message: 'synth was cancelled', output: log } });

      child.on('message', (result: SynthResult) => {
        if (!result.ok && log) result.error.output = [result.error.output, log].filter(Boolean).join('\n');
        settle(result);
      });
      child.on('error', (err) => settle({ ok: false, error: { message: err.message, output: log } }));
      // `disconnect` comes after every message has been delivered; `exit` can come before the last one.
      child.on('disconnect', () =>
        settle({ ok: false, error: { message: `synth process exited with code ${child.exitCode ?? 'unknown'}`, output: log } }),
      );

      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener('abort', onAbort);
      child.send({ appDir } satisfies WorkerRequest);
    });
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}
