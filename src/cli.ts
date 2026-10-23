#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFiles } from './adapters/files/node-files.ts';
import { TsSource } from './adapters/source/ts-source.ts';
import { ToolkitSynth } from './adapters/synth/toolkit-synth.ts';
import type { Asset } from './adapters/server/server.ts';
import { parseCliArgs } from './cli/args.ts';
import { findAppDir } from './cli/find-app.ts';
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
      else assets['/' + rel.split('\\').join('/')] = { type: TYPES[extname(name)] ?? 'application/octet-stream', body: readFileSync(join(dir, rel)) };
    }
  };
  walk('');
  if (assets['/index.html']) assets['/'] = assets['/index.html'];
  return assets;
}

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const synth = new ToolkitSynth();
  const running = await run(args, {
    cwd: process.cwd(),
    findApp: findAppDir,
    synth,
    files: (appDir) => new NodeFiles(appDir),
    source: new TsSource(),
    token: randomBytes(24).toString('base64url'),
    ui: loadUi(fileURLToPath(new URL('./ui', import.meta.url))),
    open: openBrowser,
    log: (line) => console.log(line),
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void running.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
