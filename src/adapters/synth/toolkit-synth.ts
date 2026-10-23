import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SynthResult } from '../../core/assembly.ts';
import type { Synth } from '../../core/ports.ts';
import type { WorkerRequest } from './synth-worker.ts';

const WORKER = fileURLToPath(import.meta.url).replace(/toolkit-synth\.(ts|js)$/, 'synth-worker.$1');

export const DEFAULT_SYNTH_TIMEOUT_MS = 120_000;

export interface ToolkitSynthOptions {
  /** How long one synth may run before its child process is killed. */
  timeoutMs?: number;
  /** The script the child process runs. Only tests change it. */
  worker?: string;
}

/** The real Synth: CDK's own synth through `@aws-cdk/toolkit-lib`, in a child process that can be killed. */
export class ToolkitSynth implements Synth {
  private live = new Set<ChildProcess>();
  private readonly timeoutMs: number;
  private readonly worker: string;

  constructor(opts: ToolkitSynthOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_SYNTH_TIMEOUT_MS;
    this.worker = opts.worker ?? WORKER;
  }

  /** Kills every synth still running, so nothing outlives Truss. */
  dispose(): void {
    for (const child of this.live) killTree(child);
  }

  synth(appDir: string, opts: { signal?: AbortSignal } = {}): Promise<SynthResult> {
    return new Promise((resolve) => {
      // Its own process group, so killing the worker also kills the app command it spawned.
      const child = fork(this.worker, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true });
      this.live.add(child);
      let log = '';
      child.stdout?.on('data', (d) => (log += d));
      child.stderr?.on('data', (d) => (log += d));

      let settled = false;
      const settle = (result: SynthResult) => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        this.live.delete(child);
        killTree(child);
        resolve(result);
      };
      const timer = setTimeout(
        () => settle({ ok: false, error: { message: `synth timed out after ${this.timeoutMs / 1000} s`, output: log } }),
        this.timeoutMs,
      );
      const onAbort = () => settle({ ok: false, error: { message: 'synth was cancelled', output: log } });

      child.on('message', (result: SynthResult) => {
        if (!result.ok && log) result.error.output = [result.error.output, log].filter(Boolean).join('\n');
        settle(result);
      });
      child.on('error', (err) => settle({ ok: false, error: { message: err.message, output: log } }));
      // A crash is reported once every message has been delivered (`disconnect`) and the exit code and
      // output are known (`close`); `exit` alone can come before the last message.
      let disconnected = false;
      let closed = false;
      const settleIfCrashed = () => {
        if (!disconnected || !closed) return;
        const how = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode ?? 'unknown'}`;
        settle({ ok: false, error: { message: `synth process exited with ${how}`, output: log } });
      };
      child.on('disconnect', () => ((disconnected = true), settleIfCrashed()));
      child.on('close', () => ((closed = true), settleIfCrashed()));

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
