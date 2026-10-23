import type { SearchHit } from './catalog.ts';
import { MAX_ID_LENGTH } from './construct-id.ts';
import { DURATION_UNITS, SIZE_UNITS, type PropValue } from './intents.ts';
import type { PanelView } from './panel.ts';

/** A change to one Node, named by its construct path. */
export type EditMessage =
  | { type: 'move'; requestId: string; id: string; x: number; y: number }
  /** An empty `note` clears the note. */
  | { type: 'note'; requestId: string; id: string; note: string };

/** The palette's search of the Catalog. An empty `query` lists the featured constructs first. */
export type SearchMessage = { type: 'search'; requestId: string; query: string };

/** The property panel of one Node or Stack, named by its construct path. */
export type PanelMessage = { type: 'panel'; requestId: string; id: string };

/** A change to the Draft (ADR 0006). `prop` is the prop, then the field inside it for an object-literal prop. */
export type DraftMessage =
  | { type: 'setProp'; requestId: string; id: string; prop: string[]; value: PropValue }
  /** Changes the Construct ID of a Node or Stack. */
  | { type: 'renameId'; requestId: string; id: string; newId: string }
  | { type: 'undo'; requestId: string }
  | { type: 'redo'; requestId: string }
  | { type: 'save'; requestId: string }
  | { type: 'discard'; requestId: string };

/** Messages the browser sends. Each carries a client request ID that the reply echoes. */
export type ClientMessage = EditMessage | SearchMessage | PanelMessage | DraftMessage;

/** A request as the caller writes it; the transport adds the request ID. */
export type ClientRequest = ClientMessage extends infer M ? (M extends unknown ? Omit<M, 'requestId'> : never) : never;

/** The server's answer to one request. */
export type Reply =
  | { type: 'ack'; requestId: string }
  | { type: 'refused'; requestId: string; reason: string }
  | { type: 'results'; requestId: string; hits: SearchHit[] }
  | { type: 'panel'; requestId: string; panel: PanelView };

export const MAX_NOTE_LENGTH = 10_000;
/** A string prop is a name, a description or a pattern, not a document. */
export const MAX_STRING_VALUE_LENGTH = 4_000;
/** How many fields deep a prop can be (`a.b.c`), which is as deep as the panel nests inputs. */
export const MAX_PROP_DEPTH = 4;
/** Bounds the work of one search: no construct name or CloudFormation type comes near this long. */
export const MAX_QUERY_LENGTH = 200;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Checks a value the browser wants written into the user's code: only shapes Truss writes, with nothing in them that could be read as code. */
export function parsePropValue(raw: unknown): { ok: true; value: PropValue } | { ok: false; reason: string } {
  if (!isObject(raw)) return { ok: false, reason: 'A value is needed' };
  switch (raw['kind']) {
    case 'string':
      if (typeof raw['value'] !== 'string') return { ok: false, reason: 'A string value needs text' };
      if (raw['value'].length > MAX_STRING_VALUE_LENGTH) return { ok: false, reason: `A string can be at most ${MAX_STRING_VALUE_LENGTH} characters` };
      return { ok: true, value: { kind: 'string', value: raw['value'] } };
    case 'number':
      return finite(raw['value']) ? { ok: true, value: { kind: 'number', value: raw['value'] } } : { ok: false, reason: 'A number value needs a finite number' };
    case 'boolean':
      return typeof raw['value'] === 'boolean' ? { ok: true, value: { kind: 'boolean', value: raw['value'] } } : { ok: false, reason: 'A boolean value needs true or false' };
    case 'enum': {
      const { type, member } = raw;
      if (typeof type !== 'string' || !/^aws-cdk-lib(\.[A-Za-z0-9_]+){1,2}$/.test(type)) return { ok: false, reason: 'An enum value needs the enum from aws-cdk-lib' };
      if (typeof member !== 'string' || !IDENTIFIER.test(member)) return { ok: false, reason: 'An enum value needs a member name' };
      return { ok: true, value: { kind: 'enum', type, member } };
    }
    case 'duration':
    case 'size': {
      const units: readonly string[] = raw['kind'] === 'duration' ? DURATION_UNITS : SIZE_UNITS;
      const { unit, amount } = raw;
      if (typeof unit !== 'string' || !units.includes(unit)) return { ok: false, reason: `A ${raw['kind']} needs one of ${units.join(', ')}` };
      if (!finite(amount) || amount < 0) return { ok: false, reason: `A ${raw['kind']} needs an amount of zero or more` };
      return { ok: true, value: { kind: raw['kind'], unit, amount } as PropValue };
    }
    default:
      return { ok: false, reason: `Unknown value kind ${String(raw['kind'])}` };
  }
}

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
  if (raw['type'] === 'undo' || raw['type'] === 'redo' || raw['type'] === 'save' || raw['type'] === 'discard') {
    return { ok: true, message: { type: raw['type'], requestId } };
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
    case 'panel':
      return { ok: true, message: { type: 'panel', requestId, id } };
    case 'renameId': {
      const newId = raw['newId'];
      if (typeof newId !== 'string') return refuse('A renameId needs the new Construct ID as "newId"');
      if (newId.length > MAX_ID_LENGTH) return refuse(`A Construct ID can be at most ${MAX_ID_LENGTH} characters`);
      return { ok: true, message: { type: 'renameId', requestId, id, newId } };
    }
    case 'setProp': {
      const prop = raw['prop'];
      if (!Array.isArray(prop) || prop.length === 0 || prop.length > MAX_PROP_DEPTH || !prop.every((p) => typeof p === 'string' && IDENTIFIER.test(p))) {
        return refuse('A setProp needs the prop as a list of names');
      }
      const value = parsePropValue(raw['value']);
      if (!value.ok) return refuse(value.reason);
      return { ok: true, message: { type: 'setProp', requestId, id, prop: prop as string[], value: value.value } };
    }
    default:
      return refuse(`Unknown request type ${String(raw['type'])}`);
  }
}
