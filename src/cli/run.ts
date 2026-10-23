import { isAbsolute, join, relative } from 'node:path';
import type { Asset } from '../adapters/server/server.ts';
import { startServer } from '../adapters/server/server.ts';
import type { Files, LoadCatalog, Source, Synth } from '../core/ports.ts';
import { Session } from '../session/session.ts';
import type { CliArgs } from './args.ts';
import type { EditorTarget } from './editor.ts';

export interface RunDeps {
  cwd: string;
  findApp(from: string): string | undefined;
  synth: Synth & { dispose?(): void };
  files(appDir: string): Files;
  source: Source;
  loadCatalog: LoadCatalog;
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

  // Refuses an app Truss can't open before anything else starts, and reads what the app's libraries offer.
  const loaded = await deps.loadCatalog(appDir);
  if (!loaded.ok) throw new Error(loaded.message);

  const session = new Session({ appDir, synth: deps.synth, files: deps.files(appDir), source: deps.source, catalog: loaded.catalog });
  const server = await startServer({
    source: session,
    token: deps.token,
    ui: deps.ui,
    onOpenInEditor: ({ file, ...at }) => {
      const inside = resolveInside(appDir, file);
      if (inside) deps.openInEditor({ file: inside, ...at });
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

/** The absolute path of `file` under `dir`, or undefined when it names something outside it. The page is never trusted with more. */
function resolveInside(dir: string, file: string): string | undefined {
  if (isAbsolute(file)) return undefined;
  const full = join(dir, file);
  const rel = relative(dir, full);
  return /^\.\.(?:[\\/]|$)/.test(rel) || isAbsolute(rel) ? undefined : full;
}
