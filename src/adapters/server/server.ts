import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import type { View } from '../../core/view.ts';

/** What the server needs from the session: the current View and a feed of new ones. */
export interface ViewSource {
  view(): View;
  subscribe(listener: (view: View) => void): () => void;
}

export interface Asset {
  type: string;
  body: string | Uint8Array;
}

export interface ServerOptions {
  source: ViewSource;
  /** The random per-run secret the WebSocket upgrade requires. */
  token: string;
  /** Static UI files by URL path. */
  ui?: Record<string, Asset>;
  /** An explicit port (`--port`). Fails when it is taken. */
  port?: number;
  /** Where to start looking when no port was asked for; falls back to the next free one. */
  defaultPort?: number;
}

export interface RunningServer {
  host: '127.0.0.1';
  port: number;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
export const DEFAULT_PORT = 4318;
const MAX_PORT_TRIES = 50;

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });

  let port = opts.port ?? opts.defaultPort ?? DEFAULT_PORT;
  for (let tries = 0; ; tries++) {
    try {
      await listen(server, port);
      break;
    } catch (err) {
      const inUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!inUse) throw err;
      if (opts.port !== undefined) throw new Error(`port ${opts.port} is already in use`);
      if (tries >= MAX_PORT_TRIES) throw new Error(`no free port from ${opts.defaultPort ?? DEFAULT_PORT} up`);
      port++;
    }
  }
  const actual = (server.address() as AddressInfo).port;

  // A page on another site must not be able to talk to us, even through a rebound DNS name.
  const hostOk = (req: IncomingMessage) => [`127.0.0.1:${actual}`, `localhost:${actual}`].includes(req.headers.host ?? '');
  const originOk = (req: IncomingMessage) =>
    [`http://127.0.0.1:${actual}`, `http://localhost:${actual}`].includes(req.headers.origin ?? '');

  server.on('request', (req, res) => {
    if (!hostOk(req)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const asset = opts.ui?.[path];
    if (!asset) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' }).end(asset.body);
  });

  const wss = new WebSocketServer({ noServer: true });
  const refuse = (socket: Socket, status: number, reason: string) => {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  server.on('upgrade', (req, socket: Socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return refuse(socket, 404, 'Not Found');
    if (!hostOk(req)) return refuse(socket, 403, 'Forbidden');
    if (!sameToken(url.searchParams.get('token') ?? '', opts.token)) return refuse(socket, 401, 'Unauthorized');
    if (!originOk(req)) return refuse(socket, 403, 'Forbidden');

    wss.handleUpgrade(req, socket, head, (ws) => {
      const send = (view: View) => ws.send(JSON.stringify({ type: 'view', view }));
      send(opts.source.view());
      const off = opts.source.subscribe(send);
      ws.once('close', off);
      // A malformed frame or a reset must drop that client, not crash Truss.
      ws.on('error', () => ws.terminate());
    });
  });

  return {
    host: HOST,
    port: actual,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
