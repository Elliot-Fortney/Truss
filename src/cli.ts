#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createCatalogLoader } from './adapters/catalog/read-catalog.ts';
import { NodeFiles } from './adapters/files/node-files.ts';
import { TsSource } from './adapters/source/ts-source.ts';
import { ToolkitSynth } from './adapters/synth/toolkit-synth.ts';
import type { Asset } from './adapters/server/server.ts';
import { parseCliArgs } from './cli/args.ts';
import { editorCommand, type EditorTarget } from './cli/editor.ts';
import { findAppDir } from './cli/find-app.ts';
import { mayQuit } from './cli/quit.ts';
import { run } from './cli/run.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function loadUi(dir: string): Record<string, Asset> {
  const assets: Record<string, Asset> = {};
  const walk = (sub: string) => {
    for (const name of readdirSync(join(dir, sub))) {
      const rel = join(sub, name);
      if (statSync(join(dir, rel)).isDirectory()) walk(rel);
      else
        assets['/' + rel.split('\\').join('/')] = {
          type: TYPES[extname(name)] ?? 'application/octet-stream',
          body: readFileSync(join(dir, rel)),
        };
    }
  };
  walk('');
  if (assets['/index.html']) assets['/'] = assets['/index.html'];
  return assets;
}

function launch(cmd: string, args: string[]): void {
  spawn(cmd, args, { stdio: 'ignore', detached: true })
    .on('error', () => undefined)
    .unref();
}

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  launch(cmd, args);
}

function openInEditor(target: EditorTarget): void {
  const { cmd, args } = editorCommand(process.env, process.platform, target);
  launch(cmd, args);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const synth = new ToolkitSynth(args.synthTimeout !== undefined ? { timeoutMs: args.synthTimeout * 1000 } : {});
  const running = await run(args, {
    cwd: process.cwd(),
    findApp: findAppDir,
    synth,
    files: (appDir) => new NodeFiles(appDir),
    source: new TsSource(),
    loadCatalog: createCatalogLoader({
      cacheDir: join(homedir(), '.cache', 'truss', 'catalog'),
      log: (line) => {
        console.log(line);
      },
    }),
    token: randomBytes(24).toString('base64url'),
    ui: loadUi(fileURLToPath(new URL('./ui', import.meta.url))),
    open: openBrowser,
    openInEditor,
    log: (line) => {
      console.log(line);
    },
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void running.stop().then(() => process.exit(0));
  };
  /** Asks on the terminal. Without one there is nobody to ask, and Truss quits. */
  const ask = (question: string) =>
    new Promise<string>((resolve) => {
      if (!process.stdin.isTTY) {
        resolve('y');
        return;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // Ctrl+C again at the question means it.
      rl.on('SIGINT', () => (rl.close(), resolve('y')));
      rl.question(question, (answer) => (rl.close(), resolve(answer)));
    });
  let asking = false;
  process.on('SIGINT', () => {
    if (asking) return;
    asking = true;
    void mayQuit(running.draftSize(), ask).then((quit) => {
      asking = false;
      if (quit) stop();
      else console.log('Still running.');
    });
  });
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
