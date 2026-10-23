import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceLocation } from '../core/assembly.ts';
import type { View } from '../core/view.ts';
import { applyPush } from './versions.ts';

export type Connection = 'connecting' | 'open' | 'closed';

/** Follows the server's pushes over the WebSocket, dropping any that are older than what it has. */
export function useView(): {
  view: View | undefined;
  connection: Connection;
  openInEditor(at: SourceLocation): void;
} {
  const [view, setView] = useState<View>();
  const [connection, setConnection] = useState<Connection>('connecting');
  const socket = useRef<WebSocket | undefined>(undefined);

  useEffect(() => {
    const token = new URLSearchParams(location.search).get('token') ?? '';
    const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
    socket.current = ws;
    ws.onopen = () => setConnection('open');
    ws.onclose = () => setConnection('closed');
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; view: View };
      if (msg.type === 'view') setView((current) => applyPush(current, msg.view));
    };
    return () => {
      // React runs this twice in dev; the first socket's late `onclose` must not flip the live one.
      ws.onopen = ws.onclose = ws.onmessage = null;
      ws.close();
      if (socket.current === ws) socket.current = undefined;
    };
  }, []);

  /** Asks Truss to show a place in the app's code in the user's editor. */
  const openInEditor = useCallback((at: SourceLocation) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'open-in-editor', ...at }));
  }, []);

  return { view, connection, openInEditor };
}
