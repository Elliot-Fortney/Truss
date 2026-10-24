import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceLocation } from '../core/assembly.ts';
import type { CatalogProp, SearchHit } from '../core/catalog.ts';
import type { PropValue } from '../core/intents.ts';
import type { SourceUse } from '../core/ports.ts';
import type { PanelView } from '../core/panel.ts';
import type { Targets } from './connect.ts';
import type { ClientRequest, Reply } from '../core/protocol.ts';
import type { OpenInEditorMessage, View } from '../core/view.ts';
import { applyPush } from './versions.ts';

export type Connection = 'connecting' | 'open' | 'closed';

/** `uses` are the places in the code that keep a Node from being removed. */
export type Outcome = { ok: true } | { ok: false; reason: string; uses?: SourceUse[]; at?: SourceLocation };

export type ConnectableOutcome = { ok: true; targets: Targets } | { ok: false; reason: string };

export type SearchOutcome = { ok: true; hits: SearchHit[] } | { ok: false; reason: string };

/** What adding a construct came to: staged, turned away, or in need of props from the user first. */
export type AddOutcome = { ok: true } | { ok: false; reason: string } | { ok: false; form: CatalogProp[] };

export type PanelOutcome = { ok: true; panel: PanelView } | { ok: false; reason: string };

const DISCONNECTED: Reply = { type: 'refused', requestId: '', reason: 'Disconnected from Truss.' };

/** Follows the server's pushes over the WebSocket, dropping any that are older than what it has. */
export function useView(): {
  view: View | undefined;
  connection: Connection;
  /** Sends a request and resolves with the server's answer. Never rejects. */
  send(request: ClientRequest): Promise<Outcome>;
  /** Searches the Catalog by name, service or CloudFormation type. Never rejects. */
  search(query: string): Promise<SearchOutcome>;
  /** Asks for the property panel of a Node or Stack. Never rejects. */
  panel(id: string): Promise<PanelOutcome>;
  /** Asks, for the Node `id`, which other Nodes would take a Reference from it. Never rejects. */
  connectable(id: string): Promise<ConnectableOutcome>;
  /** Adds the construct `fqn` to the Stack `scope`. Never rejects. */
  addNode(scope: string, fqn: string, props?: Record<string, PropValue>): Promise<AddOutcome>;
  openInEditor(at: SourceLocation): void;
} {
  const [view, setView] = useState<View>();
  const [connection, setConnection] = useState<Connection>('connecting');
  const socket = useRef<WebSocket | undefined>(undefined);
  const pending = useRef(new Map<string, (reply: Reply) => void>());
  const nextId = useRef(0);

  useEffect(() => {
    const token = new URLSearchParams(location.search).get('token') ?? '';
    const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
    const waiting = pending.current;
    socket.current = ws;
    ws.onopen = () => setConnection('open');
    ws.onclose = () => {
      setConnection('closed');
      for (const resolve of waiting.values()) resolve(DISCONNECTED);
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
      resolve?.(msg);
    };
    return () => {
      // React runs this twice in dev; the first socket's late `onclose` must not flip the live one.
      ws.onopen = ws.onclose = ws.onmessage = null;
      ws.close();
      for (const resolve of waiting.values()) resolve(DISCONNECTED);
      waiting.clear();
      if (socket.current === ws) socket.current = undefined;
    };
  }, []);

  const ask = useCallback((request: ClientRequest) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(DISCONNECTED);
    const requestId = String(++nextId.current);
    return new Promise<Reply>((resolve) => {
      pending.current.set(requestId, resolve);
      ws.send(JSON.stringify({ ...request, requestId }));
    });
  }, []);

  const send = useCallback(
    async (request: ClientRequest): Promise<Outcome> => {
      const reply = await ask(request);
      return reply.type === 'refused' ? { ok: false, reason: reply.reason, ...(reply.uses ? { uses: reply.uses } : {}), ...(reply.at ? { at: reply.at } : {}) } : { ok: true };
    },
    [ask],
  );

  const search = useCallback(
    async (query: string): Promise<SearchOutcome> => {
      const reply = await ask({ type: 'search', query });
      if (reply.type === 'results') return { ok: true, hits: reply.hits };
      return { ok: false, reason: reply.type === 'refused' ? reply.reason : 'Unexpected reply to a search.' };
    },
    [ask],
  );

  const panel = useCallback(
    async (id: string): Promise<PanelOutcome> => {
      const reply = await ask({ type: 'panel', id });
      if (reply.type === 'panel') return { ok: true, panel: reply.panel };
      return { ok: false, reason: reply.type === 'refused' ? reply.reason : 'Unexpected reply to a panel request.' };
    },
    [ask],
  );

  const connectable = useCallback(
    async (id: string): Promise<ConnectableOutcome> => {
      const reply = await ask({ type: 'connectable', id });
      if (reply.type === 'connectable') return { ok: true, targets: reply.targets };
      return { ok: false, reason: reply.type === 'refused' ? reply.reason : 'Unexpected reply to a connect request.' };
    },
    [ask],
  );

  const addNode = useCallback(
    async (scope: string, fqn: string, props?: Record<string, PropValue>): Promise<AddOutcome> => {
      const reply = await ask({ type: 'addNode', scope, fqn, ...(props ? { props } : {}) });
      if (reply.type === 'form') return { ok: false, form: reply.props };
      return reply.type === 'refused' ? { ok: false, reason: reply.reason } : { ok: true };
    },
    [ask],
  );

  /** Asks Truss to show a place in the app's code in the user's editor. */
  const openInEditor = useCallback((at: SourceLocation) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'open-in-editor', ...at } satisfies OpenInEditorMessage));
  }, []);

  return { view, connection, send, search, panel, connectable, addNode, openInEditor };
}
