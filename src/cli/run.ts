import type { Asset } from '../adapters/server/server.ts';
import { startServer } from '../adapters/server/server.ts';
import type { Files, Source, Synth } from '../core/ports.ts';
import { Session } from '../session/session.ts';
import type { CliArgs } from './args.ts';

export interface RunDeps {
  cwd: string;
  findApp(from: string): string | undefined;
  synth: Synth & { dispose?(): void };
  files(appDir: string): Files;
  source: Source;
  token: string;
  ui: Record<string, Asset>;
  open(url: string): void;
  log(line: string): void;
}

export interface Running {
  url: string;
  stop(): Promise<void>;
}

/** Starts Truss for the app around `cwd`. Everything it touches is passed in, so tests can fake it. */
export async function run(args: CliArgs, deps: RunDeps): Promise<Running> {
  const appDir = deps.findApp(deps.cwd);
  if (!appDir) {
    throw new Error(`No cdk.json found in ${deps.cwd} or any folder above it. Run truss inside a TypeScript CDK app.`);
  }

  const session = new Session({ appDir, synth: deps.synth, files: deps.files(appDir), source: deps.source });
  const server = await startServer({
    source: session,
    token: deps.token,
    ui: deps.ui,
    ...(args.port !== undefined ? { port: args.port } : {}),
  });
  const url = `http://${server.host}:${server.port}/?token=${deps.token}`;
  deps.log(`Truss is open on ${url}`);
  deps.log('Press Ctrl+C to stop.');
  if (args.open) deps.open(url);

  // The browser is already connecting; it sees "synthing…" until this finishes.
  void session.start();

  return {
    url,
    stop: async () => {
      deps.synth.dispose?.();
      await server.close();
    },
  };
}
