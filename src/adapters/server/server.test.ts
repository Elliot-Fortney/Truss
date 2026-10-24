import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientMessage, Reply } from '../../core/protocol.ts';
import type { View } from '../../core/view.ts';
import { startServer, type RunningServer, type ViewSource } from './server.ts';

const view = (version: number): View => ({
  version,
  synthing: false,
  hasDesign: false,
  stages: [],
  stacks: [],
  nodes: [],
  edges: [],
  problems: [],
});

function fakeSource(initial: View): ViewSource & { push(v: View): void; handled: ClientMessage[] } {
  let current = initial;
  const handled: ClientMessage[] = [];
  const listeners = new Set<(v: View) => void>();
  return {
    handled,
    handle: async (m) => {
      handled.push(m);
      if (m.type === 'search') return { type: 'results', requestId: m.requestId, hits: [] };
      if (!('id' in m)) return { type: 'ack', requestId: m.requestId };
      return m.id === 'unknown'
        ? { type: 'refused', requestId: m.requestId, reason: 'No Node' }
        : { type: 'ack', requestId: m.requestId };
    },
    view: () => current,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    push(v) {
      current = v;
      listeners.forEach((l) => {
        l(v);
      });
    },
  };
}

/** Resolves with the first message, or with the HTTP status of a refused upgrade. */
function connect(url: string, origin?: string): Promise<{ ws: WebSocket; first: Promise<View> } | { status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const first = new Promise<View>((res) =>
      ws.once('message', (d) => {
        res(JSON.parse(String(d)).view);
      }),
    );
    ws.once('open', () => {
      resolve({ ws, first });
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
    });
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
    const next = new Promise<View>((res) =>
      conn.ws.once('message', (d) => {
        res(JSON.parse(String(d)).view);
      }),
    );
    source.push(view(2));
    expect((await next).version).toBe(2);
    conn.ws.close();
  });

  it('refuses a WebSocket upgrade without the session token', async () => {
    const { server } = await start();
    expect(await connect(`ws://127.0.0.1:${server.port}/ws`, `http://127.0.0.1:${server.port}`)).toEqual({
      status: 401,
    });
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

  describe('open-in-editor', () => {
    const open = async (onOpenInEditor = vi.fn()) => {
      const { server } = await start(undefined, { onOpenInEditor });
      const conn = await connect(wsUrl(server), `http://127.0.0.1:${server.port}`);
      if ('status' in conn) throw new Error('refused');
      await conn.first;
      return { ws: conn.ws, onOpenInEditor };
    };

    it('hands a request from the page to the handler', async () => {
      const { ws, onOpenInEditor } = await open();
      ws.send(JSON.stringify({ type: 'open-in-editor', file: 'lib/a.ts', line: 4, col: 2 }));
      await vi.waitFor(() => {
        expect(onOpenInEditor).toHaveBeenCalledWith({ file: 'lib/a.ts', line: 4, col: 2 });
      });
      ws.close();
    });

    it('accepts a request with no position', async () => {
      const { ws, onOpenInEditor } = await open();
      ws.send(JSON.stringify({ type: 'open-in-editor', file: 'lib/a.ts' }));
      await vi.waitFor(() => {
        expect(onOpenInEditor).toHaveBeenCalledWith({ file: 'lib/a.ts' });
      });
      ws.close();
    });

    it('ignores malformed frames and unknown messages, and keeps serving the client', async () => {
      const { ws, onOpenInEditor } = await open();
      for (const frame of [
        'not json',
        '[]',
        'null',
        JSON.stringify({ type: 'something-else' }),
        JSON.stringify({ type: 'open-in-editor' }),
        JSON.stringify({ type: 'open-in-editor', file: 42 }),
        JSON.stringify({ type: 'open-in-editor', file: 'a.ts', line: 'x' }),
        JSON.stringify({ type: 'open-in-editor', file: 'a.ts', col: 0 }),
      ]) {
        ws.send(frame);
      }
      ws.send(JSON.stringify({ type: 'open-in-editor', file: 'ok.ts' }));
      await vi.waitFor(() => {
        expect(onOpenInEditor).toHaveBeenCalledTimes(1);
      });
      expect(onOpenInEditor).toHaveBeenCalledWith({ file: 'ok.ts' });
      ws.close();
    });

    it('survives a handler that throws', async () => {
      const throwing = vi.fn(() => {
        throw new Error('no editor');
      });
      const { ws } = await open(throwing);
      ws.send(JSON.stringify({ type: 'open-in-editor', file: 'a.ts' }));
      await vi.waitFor(() => {
        expect(throwing).toHaveBeenCalled();
      });
      expect(ws.readyState).toBe(ws.OPEN);
      ws.close();
    });
  });

  it('closes cleanly, dropping open connections', async () => {
    const { server } = await start();
    const conn = await connect(wsUrl(server), `http://127.0.0.1:${server.port}`);
    if ('status' in conn) throw new Error('refused');
    const closed = new Promise((r) => conn.ws.once('close', r));
    await server.close();
    await closed;
  });

  describe('requests from the browser', () => {
    /** Connects, waits out the first View, sends `payload`, and resolves with the next message. */
    const ask = async (source: ReturnType<typeof fakeSource>, payload: string): Promise<Reply> => {
      const { server } = await start(source);
      const conn = await connect(wsUrl(server), `http://127.0.0.1:${server.port}`);
      if ('status' in conn) throw new Error(`refused with ${conn.status}`);
      await conn.first;
      const reply = new Promise<Reply>((res) =>
        conn.ws.once('message', (d) => {
          res(JSON.parse(String(d)));
        }),
      );
      conn.ws.send(payload);
      const got = await reply;
      conn.ws.close();
      return got;
    };

    it.each([
      [{ type: 'move', requestId: 'r1', id: 'A/b', x: 10, y: 20 }],
      [{ type: 'note', requestId: 'r2', id: 'A/b', note: 'hello' }],
    ])('hands %j to the session and sends back its reply', async (message) => {
      const source = fakeSource(view(1));
      expect(await ask(source, JSON.stringify(message))).toEqual({ type: 'ack', requestId: message.requestId });
      expect(source.handled).toEqual([message]);
    });

    it('hands a search to the session and sends back its hits', async () => {
      const source = fakeSource(view(1));
      expect(await ask(source, JSON.stringify({ type: 'search', requestId: 's', query: 'queue' }))).toEqual({
        type: 'results',
        requestId: 's',
        hits: [],
      });
      expect(source.handled).toEqual([{ type: 'search', requestId: 's', query: 'queue' }]);
    });

    it("sends back the session's refusal", async () => {
      const reply = await ask(
        fakeSource(view(1)),
        JSON.stringify({ type: 'move', requestId: 'r', id: 'unknown', x: 1, y: 1 }),
      );
      expect(reply).toEqual({ type: 'refused', requestId: 'r', reason: 'No Node' });
    });

    it.each([
      ['not JSON', 'nope', ''],
      ['an unknown type', JSON.stringify({ type: 'explode', requestId: 'r' }), 'r'],
      ['a move without numbers', JSON.stringify({ type: 'move', requestId: 'r', id: 'A', x: '1', y: 2 }), 'r'],
      ['a move to infinity', '{"type":"move","requestId":"r","id":"A","x":1e999,"y":2}', 'r'],
      ['a note that is not text', JSON.stringify({ type: 'note', requestId: 'r', id: 'A', note: 5 }), 'r'],
      [
        'a note that is far too long',
        JSON.stringify({ type: 'note', requestId: 'r', id: 'A', note: 'x'.repeat(10_001) }),
        'r',
      ],
      ['no request ID', JSON.stringify({ type: 'move', id: 'A', x: 1, y: 2 }), ''],
      ['a search without a query', JSON.stringify({ type: 'search', requestId: 'r' }), 'r'],
    ])('refuses %s without troubling the session', async (_why, payload, requestId) => {
      const source = fakeSource(view(1));
      const reply = await ask(source, payload);
      expect(reply).toEqual({ type: 'refused', requestId, reason: expect.any(String) });
      expect(source.handled).toEqual([]);
    });
  });
});
