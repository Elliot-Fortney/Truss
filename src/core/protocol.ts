import type { SearchHit } from './catalog.ts';

/** A change to one Node, named by its construct path. */
export type EditMessage =
  | { type: 'move'; requestId: string; id: string; x: number; y: number }
  /** An empty `note` clears the note. */
  | { type: 'note'; requestId: string; id: string; note: string };

/** The palette's search of the Catalog. An empty `query` lists the featured constructs first. */
export type SearchMessage = { type: 'search'; requestId: string; query: string };

/** Messages the browser sends. Each carries a client request ID that the reply echoes. */
export type ClientMessage = EditMessage | SearchMessage;

/** A request as the caller writes it; the transport adds the request ID. */
export type ClientRequest = ClientMessage extends infer M ? (M extends unknown ? Omit<M, 'requestId'> : never) : never;

/** The server's answer to one request. */
export type Reply =
  | { type: 'ack'; requestId: string }
  | { type: 'refused'; requestId: string; reason: string }
  | { type: 'results'; requestId: string; hits: SearchHit[] };

export const MAX_NOTE_LENGTH = 10_000;
/** Bounds the work of one search: no construct name or CloudFormation type comes near this long. */
export const MAX_QUERY_LENGTH = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks a frame from the browser. Anything that isn't a well-formed request is refused with a reason. */
export function parseClientMessage(text: string): { ok: true; message: ClientMessage } | { ok: false; requestId: string; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, requestId: '', reason: 'Not valid JSON' };
  }
  if (!isObject(raw)) return { ok: false, requestId: '', reason: 'Not a request' };
  const requestId = typeof raw['requestId'] === 'string' ? raw['requestId'] : '';
  const refuse = (reason: string) => ({ ok: false as const, requestId, reason });
  if (requestId === '') return refuse('A request needs a requestId');
  if (raw['type'] === 'search') {
    const query = raw['query'];
    if (typeof query !== 'string') return refuse('A search needs a query');
    if (query.length > MAX_QUERY_LENGTH) return refuse(`A search query can be at most ${MAX_QUERY_LENGTH} characters`);
    return { ok: true, message: { type: 'search', requestId, query } };
  }
  const id = raw['id'];
  if (typeof id !== 'string' || id === '') return refuse('A request needs the construct path as "id"');

  switch (raw['type']) {
    case 'move': {
      const { x, y } = raw;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
        return refuse('A move needs numeric x and y');
      }
      return { ok: true, message: { type: 'move', requestId, id, x, y } };
    }
    case 'note': {
      const note = raw['note'];
      if (typeof note !== 'string') return refuse('A note needs text');
      if (note.length > MAX_NOTE_LENGTH) return refuse(`A note can be at most ${MAX_NOTE_LENGTH} characters`);
      return { ok: true, message: { type: 'note', requestId, id, note } };
    }
    default:
      return refuse(`Unknown request type ${String(raw['type'])}`);
  }
}
