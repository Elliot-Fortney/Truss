import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { View } from '../../core/view.ts';
import { startServer, type RunningServer, type ViewSource } from './server.ts';

const view = (version: number): View => ({ version, synthing: false, stacks: [], nodes: [] });

function fakeSource(initial: View): ViewSource & { push(v: View): void } {
  let current = initial;
  const listeners = new Set<(v: View) => void>();
  return {
    view: () => current,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    push(v) {
      current = v;
      listeners.forEach((l) => l(v));
    },
  };
}

/** Resolves with the first message, or with the HTTP status of a refused upgrade. */
function connect(url: string, origin?: string): Promise<{ ws: WebSocket; first: Promise<View> } | { status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const first = new Promise<View>((res) => ws.once('message', (d) => res(JSON.parse(String(d)).view)));
    ws.once('open', () => resolve({ ws, first }));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.once('error', () => undefined);
  });
}

const statusWithHost = (port: number, host: string) =>
  new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });

describe('startServer', () => {
  const running: RunningServer[] = [];
  const blockers: Server[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map((s) => s.close()));
    await Promise.all(blockers.splice(0).map((b) => new Promise((r) => b.close(r))));
  });

  const start = async (source = fakeSource(view(1)), opts: Partial<Parameters<typeof startServer>[0]> = {}) => {
    const server = await startServer({ source, port: 0, token: 'secret', ...opts });
    running.push(server);
    return { server, source };
  };
  const wsUrl = (s: RunningServer, token = 'secret') => `ws://127.0.0.1:${s.port}/ws?token=${token}`;

  it('binds to 127.0.0.1 only', async () => {
    const { server } = await start();
    expect(server.host).toBe('127.0.0.1');
  });

  it('sends the current view on connect, then every push', async () => {
    const { server, source } = await start();
    const conn = await connect(wsUrl(server), `http://127.0.0.1:${server.port}`);
    if ('status' in conn) throw new Error(`refused with ${conn.status}`);
    expect((await conn.first).version).toBe(1);
    const next = new Promise<View>((res) => conn.ws.once('message', (d) => res(JSON.parse(String(d)).view)));
    source.push(view(2));
    expect((await next).version).toBe(2);
    conn.ws.close();
  });

  it('refuses a WebSocket upgrade without the session token', async () => {
    const { server } = await start();
    expect(await connect(`ws://127.0.0.1:${server.port}/ws`, `http://127.0.0.1:${server.port}`)).toEqual({ status: 401 });
    expect(await connect(wsUrl(server, 'wrong'), `http://127.0.0.1:${server.port}`)).toEqual({ status: 401 });
  });

  it("refuses a WebSocket upgrade from another page's Origin", async () => {
    const { server } = await start();
    expect(await connect(wsUrl(server), 'https://evil.example')).toEqual({ status: 403 });
    expect(await connect(wsUrl(server), `http://127.0.0.1:${server.port + 1}`)).toEqual({ status: 403 });
  });

  it('refuses an upgrade that sends no Origin at all', async () => {
    const { server } = await start();
    expect(await connect(wsUrl(server))).toEqual({ status: 403 });
  });

  it('serves the UI over HTTP to requests for 127.0.0.1 or localhost only', async () => {
    const { server } = await start(undefined, { ui: { '/': { type: 'text/html', body: '<p>truss</p>' } } });
    const ok = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(await ok.text()).toBe('<p>truss</p>');
    expect(await statusWithHost(server.port, 'evil.example')).toBe(403);
    expect(await statusWithHost(server.port, `localhost:${server.port}`)).toBe(200);
  });

  it('falls back to the next free port when the default is taken', async () => {
    const blocker = createServer().listen(0, '127.0.0.1');
    blockers.push(blocker);
    await new Promise((r) => blocker.once('listening', r));
    const taken = (blocker.address() as AddressInfo).port;
    const { server } = await start(undefined, { port: undefined, defaultPort: taken });
    expect(server.port).toBeGreaterThan(taken);
  });

  it('fails when an explicit --port is taken', async () => {
    const blocker = createServer().listen(0, '127.0.0.1');
    blockers.push(blocker);
    await new Promise((r) => blocker.once('listening', r));
    const taken = (blocker.address() as AddressInfo).port;
    await expect(startServer({ source: fakeSource(view(1)), port: taken, token: 't' })).rejects.toThrow(/in use/i);
  });

  it('closes cleanly, dropping open connections', async () => {
    const { server } = await start();
    const conn = await connect(wsUrl(server), `http://127.0.0.1:${server.port}`);
    if ('status' in conn) throw new Error('refused');
    const closed = new Promise((r) => conn.ws.once('close', r));
    await server.close();
    await closed;
  });
});
