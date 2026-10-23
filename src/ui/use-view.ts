import { useEffect, useState } from 'react';
import type { View } from '../core/view.ts';
import { applyPush } from './versions.ts';

export type Connection = 'connecting' | 'open' | 'closed';

/** Follows the server's pushes over the WebSocket, dropping any that are older than what it has. */
export function useView(): { view: View | undefined; connection: Connection } {
  const [view, setView] = useState<View>();
  const [connection, setConnection] = useState<Connection>('connecting');

  useEffect(() => {
    const token = new URLSearchParams(location.search).get('token') ?? '';
    const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
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
    };
  }, []);

  return { view, connection };
}
