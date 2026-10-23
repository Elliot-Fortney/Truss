import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientRequest, Reply } from '../core/protocol.ts';
import type { View } from '../core/view.ts';
import { applyPush } from './versions.ts';

export type Connection = 'connecting' | 'open' | 'closed';

export type Outcome = { ok: true } | { ok: false; reason: string };

/** Follows the server's pushes over the WebSocket, dropping any that are older than what it has. */
export function useView(): {
  view: View | undefined;
  connection: Connection;
  /** Sends a request and resolves with the server's answer. Never rejects. */
  send(request: ClientRequest): Promise<Outcome>;
} {
  const [view, setView] = useState<View>();
  const [connection, setConnection] = useState<Connection>('connecting');
  const socket = useRef<WebSocket | undefined>(undefined);
  const pending = useRef(new Map<string, (outcome: Outcome) => void>());
  const nextId = useRef(0);

  useEffect(() => {
    const token = new URLSearchParams(location.search).get('token') ?? '';
    const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
    const waiting = pending.current;
    socket.current = ws;
    ws.onopen = () => setConnection('open');
    ws.onclose = () => {
      setConnection('closed');
      for (const resolve of waiting.values()) resolve({ ok: false, reason: 'Disconnected from Truss.' });
      waiting.clear();
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { type: 'view'; view: View } | Reply;
      if (msg.type === 'view') {
        setView((current) => applyPush(current, msg.view));
        return;
      }
      const resolve = waiting.get(msg.requestId);
      waiting.delete(msg.requestId);
      resolve?.(msg.type === 'ack' ? { ok: true } : { ok: false, reason: msg.reason });
    };
    return () => {
      // React runs this twice in dev; the first socket's late `onclose` must not flip the live one.
      ws.onopen = ws.onclose = ws.onmessage = null;
      ws.close();
      for (const resolve of waiting.values()) resolve({ ok: false, reason: 'Disconnected from Truss.' });
      waiting.clear();
    };
  }, []);

  const send = useCallback((request: ClientRequest) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve<Outcome>({ ok: false, reason: 'Disconnected from Truss.' });
    const requestId = String(++nextId.current);
    return new Promise<Outcome>((resolve) => {
      pending.current.set(requestId, resolve);
      ws.send(JSON.stringify({ ...request, requestId }));
    });
  }, []);

  return { view, connection, send };
}
