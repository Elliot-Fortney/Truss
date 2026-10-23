import { isAbsolute, join, relative } from 'node:path';
import type { Asset } from '../adapters/server/server.ts';
import { startServer } from '../adapters/server/server.ts';
import type { Files, Source, Synth } from '../core/ports.ts';
import { Session } from '../session/session.ts';
import type { CliArgs } from './args.ts';
import type { EditorTarget } from './editor.ts';

export interface RunDeps {
  cwd: string;
  findApp(from: string): string | undefined;
  synth: Synth & { dispose?(): void };
  files(appDir: string): Files;
  source: Source;
  token: string;
  ui: Record<string, Asset>;
  open(url: string): void;
  /** Opens `file` (absolute) in the user's editor. */
  openInEditor(target: EditorTarget): void;
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
    onOpenInEditor: ({ file, ...at }) => {
      // The page is only trusted to name a file in the app, never one outside it.
      const rel = relative(appDir, join(appDir, file));
      if (isAbsolute(file) || /^\.\.(?:[\\/]|$)/.test(rel) || isAbsolute(rel)) return;
      deps.openInEditor({ file: join(appDir, rel), ...at });
    },
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
      session.stop();
      deps.synth.dispose?.();
      await server.close();
    },
  };
}
