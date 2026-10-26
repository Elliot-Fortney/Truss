import type { SourceLocation } from './assembly.ts';
import type { CatalogProp, SearchHit } from './catalog.ts';
import type { ConnectCheck } from './connect.ts';
import { MAX_ID_LENGTH } from './construct-id.ts';
import { DURATION_UNITS, SIZE_UNITS, type PropValue } from './intents.ts';
import type { PanelView } from './panel.ts';
import type { SourceUse } from './ports.ts';

/** A change to one Node, named by its construct path. */
export type EditMessage =
  /** `into` is the Stack box the Node was dropped in, which differs from its own when the drag crossed Stacks. */
  | { type: 'move'; requestId: string; id: string; x: number; y: number; into?: string }
  /** An empty `note` clears the note. */
  | { type: 'note'; requestId: string; id: string; note: string };

/** The palette's search of the Catalog. An empty `query` lists the featured constructs first. */
export type SearchMessage = { type: 'search'; requestId: string; query: string };

/** The property panel of one Node or Stack, named by its construct path. */
export type PanelMessage = { type: 'panel'; requestId: string; id: string };

/** Asks what dragging from the Node at `id` could end on: whether each other Node takes a Reference from it, and through which props. */
export type ConnectableMessage = { type: 'connectable'; requestId: string; id: string };

/** A change to the Draft (ADR 0006). `prop` is the prop, then the field inside it for an object-literal prop. */
export type DraftMessage =
  | { type: 'setProp'; requestId: string; id: string; prop: string[]; value: PropValue }
  /** Changes the Construct ID of a Node or Stack. */
  | { type: 'renameId'; requestId: string; id: string; newId: string }
  /** Adds the construct `fqn` to the Stack `scope`. `props` are values for required props the Overlay has no default for, from the form. */
  | { type: 'addNode'; requestId: string; scope: string; fqn: string; props?: Record<string, PropValue> }
  /** Copies the Node at `id` with a fresh Construct ID. */
  | { type: 'duplicate'; requestId: string; id: string }
  /** Deletes the Node at `id` from the code. */
  | { type: 'removeNode'; requestId: string; id: string }
  /** Points `prop` of the Node `from` at the Node `to`. A prop that points at another Node already is replaced only with `replace`. */
  | { type: 'connect'; requestId: string; from: string; to: string; prop: string; replace?: boolean }
  /** Takes the Node `to` out of `prop` of the Node `from`. */
  | { type: 'disconnect'; requestId: string; from: string; to: string; prop: string }
  /** Moves the end of a Reference of `prop` from the Node `was` to the Node `to`. */
  | { type: 'repoint'; requestId: string; from: string; was: string; to: string; prop: string }
  /**
   * Connects the Nodes `a` and `b` the way the Overlay's hint `hint` says: a Grant, an Integration or a Network Connection.
   * `env` names the environment variable the hint also sets, or with `null` leaves it out.
   */
  | { type: 'addConnection'; requestId: string; a: string; b: string; hint: string; env?: string | null }
  /** Takes calls that make a Connection out of the code. `calls` are the ids the View gives them. */
  | { type: 'removeConnection'; requestId: string; calls: string[] }
  /** Writes the calls of a Connection again for another hint, or with the environment variable renamed or switched off. */
  | { type: 'changeConnection'; requestId: string; calls: string[]; hint?: string; env?: string | null }
  | { type: 'undo'; requestId: string }
  | { type: 'redo'; requestId: string }
  | { type: 'save'; requestId: string }
  | { type: 'discard'; requestId: string };

/** Messages the browser sends. Each carries a client request ID that the reply echoes. */
export type ClientMessage = EditMessage | SearchMessage | PanelMessage | ConnectableMessage | DraftMessage;

/** A request as the caller writes it; the transport adds the request ID. */
export type ClientRequest = ClientMessage extends infer M ? (M extends unknown ? Omit<M, 'requestId'> : never) : never;

/** The server's answer to one request. */
export type Reply =
  | { type: 'ack'; requestId: string }
  /** `uses` are the places in the code that keep a Node from being removed. */
  | {
      type: 'refused';
      requestId: string;
      reason: string;
      uses?: SourceUse[];
      /** The code the refusal is about, which the user can open in their editor. */ at?: SourceLocation;
    }
  | { type: 'results'; requestId: string; hits: SearchHit[] }
  /** Nothing was staged: the construct needs these props, which only the user can give. */
  | { type: 'form'; requestId: string; fqn: string; props: CatalogProp[] }
  | { type: 'panel'; requestId: string; panel: PanelView }
  /** For each other Node, whether it takes a Reference from the one asked about. */
  | { type: 'connectable'; requestId: string; targets: Record<string, ConnectCheck> };

export const MAX_NOTE_LENGTH = 10_000;
/** A string prop is a name, a description or a pattern, not a document. */
export const MAX_STRING_VALUE_LENGTH = 4_000;
/** How many fields deep a prop can be (`a.b.c`), which is as deep as the panel nests inputs. */
export const MAX_PROP_DEPTH = 4;
/** Bounds the work of one search: no construct name or CloudFormation type comes near this long. */
export const MAX_QUERY_LENGTH = 200;

/** A construct path is a few IDs, each at most `MAX_ID_LENGTH` long, so this is generous. */
const MAX_PATH_LENGTH = 2_000;

/** A Connection is made by a call or two. */
const MAX_CALLS = 20;

/** A construct has a handful of required props, not hundreds. */
const MAX_FORM_PROPS = 50;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Checks a value the browser wants written into the user's code: only shapes Truss writes, with nothing in them that could be read as code. */
export function parsePropValue(raw: unknown): { ok: true; value: PropValue } | { ok: false; reason: string } {
  if (!isObject(raw)) return { ok: false, reason: 'A value is needed' };
  switch (raw['kind']) {
    case 'string':
      if (typeof raw['value'] !== 'string') return { ok: false, reason: 'A string value needs text' };
      if (raw['value'].length > MAX_STRING_VALUE_LENGTH)
        return { ok: false, reason: `A string can be at most ${MAX_STRING_VALUE_LENGTH} characters` };
      return { ok: true, value: { kind: 'string', value: raw['value'] } };
    case 'number':
      return finite(raw['value'])
        ? { ok: true, value: { kind: 'number', value: raw['value'] } }
        : { ok: false, reason: 'A number value needs a finite number' };
    case 'boolean':
      return typeof raw['value'] === 'boolean'
        ? { ok: true, value: { kind: 'boolean', value: raw['value'] } }
        : { ok: false, reason: 'A boolean value needs true or false' };
    case 'enum': {
      const { type, member } = raw;
      if (typeof type !== 'string' || !/^aws-cdk-lib(\.[A-Za-z0-9_]+){1,2}$/.test(type))
        return { ok: false, reason: 'An enum value needs the enum from aws-cdk-lib' };
      if (typeof member !== 'string' || !IDENTIFIER.test(member))
        return { ok: false, reason: 'An enum value needs a member name' };
      return { ok: true, value: { kind: 'enum', type, member } };
    }
    case 'duration':
    case 'size': {
      const units: readonly string[] = raw['kind'] === 'duration' ? DURATION_UNITS : SIZE_UNITS;
      const { unit, amount } = raw;
      if (typeof unit !== 'string' || !units.includes(unit))
        return { ok: false, reason: `A ${raw['kind']} needs one of ${units.join(', ')}` };
      if (!finite(amount) || amount < 0)
        return { ok: false, reason: `A ${raw['kind']} needs an amount of zero or more` };
      return { ok: true, value: { kind: raw['kind'], unit, amount } as PropValue };
    }
    default:
      return { ok: false, reason: `Unknown value kind ${String(raw['kind'])}` };
  }
}

/** Checks a frame from the browser. Anything that isn't a well-formed request is refused with a reason. */
export function parseClientMessage(
  text: string,
): { ok: true; message: ClientMessage } | { ok: false; requestId: string; reason: string } {
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
  if (raw['type'] === 'connect' || raw['type'] === 'disconnect' || raw['type'] === 'repoint') {
    const { from, to, prop } = raw;
    const path = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= MAX_PATH_LENGTH;
    if (!path(from) || !path(to)) return refuse(`A ${raw['type']} needs the construct paths as "from" and "to"`);
    if (typeof prop !== 'string' || !IDENTIFIER.test(prop)) return refuse(`A ${raw['type']} needs the prop as "prop"`);
    if (raw['type'] === 'repoint') {
      const was = raw['was'];
      if (!path(was)) return refuse('A repoint needs the Node the Reference points at now as "was"');
      return { ok: true, message: { type: 'repoint', requestId, from, was, to, prop } };
    }
    if (raw['type'] === 'disconnect') return { ok: true, message: { type: 'disconnect', requestId, from, to, prop } };
    return {
      ok: true,
      message: { type: 'connect', requestId, from, to, prop, ...(raw['replace'] === true ? { replace: true } : {}) },
    };
  }
  if (raw['type'] === 'addConnection' || raw['type'] === 'changeConnection' || raw['type'] === 'removeConnection') {
    const env = raw['env'];
    if (
      env !== undefined &&
      env !== null &&
      (typeof env !== 'string' || !IDENTIFIER.test(env) || env.length > MAX_ID_LENGTH)
    )
      return refuse('An environment variable needs a name made of letters, digits and underscores');
    const hint = raw['hint'];
    const hintOk = typeof hint === 'string' && /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_]+){1,2}#\d{1,4}$/.test(hint);
    if (raw['type'] === 'addConnection') {
      const { a, b } = raw;
      if (
        typeof a !== 'string' ||
        a === '' ||
        a.length > MAX_PATH_LENGTH ||
        typeof b !== 'string' ||
        b === '' ||
        b.length > MAX_PATH_LENGTH
      )
        return refuse('An addConnection needs the construct paths as "a" and "b"');
      if (!hintOk) return refuse('An addConnection needs the hint it makes');
      return {
        ok: true,
        message: { type: 'addConnection', requestId, a, b, hint, ...(env !== undefined ? { env } : {}) },
      };
    }
    const calls = raw['calls'];
    if (
      !Array.isArray(calls) ||
      calls.length === 0 ||
      calls.length > MAX_CALLS ||
      !calls.every((c) => typeof c === 'string' && c !== '' && c.length <= MAX_PATH_LENGTH)
    )
      return refuse(`A ${raw['type']} needs the calls as a list of ids`);
    if (raw['type'] === 'removeConnection')
      return { ok: true, message: { type: 'removeConnection', requestId, calls: calls as string[] } };
    if (hint !== undefined && !hintOk) return refuse('A changeConnection takes the hint as the one it is changed to');
    return {
      ok: true,
      message: {
        type: 'changeConnection',
        requestId,
        calls: calls as string[],
        ...(hintOk ? { hint } : {}),
        ...(env !== undefined ? { env } : {}),
      },
    };
  }
  if (raw['type'] === 'addNode') {
    const { scope, fqn } = raw;
    if (typeof scope !== 'string' || scope === '') return refuse('An addNode needs the Stack path as "scope"');
    if (typeof fqn !== 'string' || !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_]+){1,2}$/.test(fqn))
      return refuse('An addNode needs the construct as "fqn"');
    const given = raw['props'];
    if (given === undefined) return { ok: true, message: { type: 'addNode', requestId, scope, fqn } };
    if (!isObject(given) || Object.keys(given).length > MAX_FORM_PROPS)
      return refuse('An addNode takes its props as an object of values');
    const props: Record<string, PropValue> = {};
    for (const [name, value] of Object.entries(given)) {
      const parsed = IDENTIFIER.test(name)
        ? parsePropValue(value)
        : ({ ok: false, reason: `${name} is not a prop name` } as const);
      if (!parsed.ok) return refuse(parsed.reason);
      props[name] = parsed.value;
    }
    return { ok: true, message: { type: 'addNode', requestId, scope, fqn, props } };
  }
  const id = raw['id'];
  if (typeof id !== 'string' || id === '') return refuse('A request needs the construct path as "id"');

  switch (raw['type']) {
    case 'move': {
      const { x, y } = raw;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
        return refuse('A move needs numeric x and y');
      }
      const into = raw.into;
      if (into !== undefined && typeof into !== 'string') return refuse('A move into a Stack needs its construct path');
      return { ok: true, message: { type: 'move', requestId, id, x, y, ...(into !== undefined ? { into } : {}) } };
    }
    case 'note': {
      const note = raw['note'];
      if (typeof note !== 'string') return refuse('A note needs text');
      if (note.length > MAX_NOTE_LENGTH) return refuse(`A note can be at most ${MAX_NOTE_LENGTH} characters`);
      return { ok: true, message: { type: 'note', requestId, id, note } };
    }
    case 'panel':
      return { ok: true, message: { type: 'panel', requestId, id } };
    case 'connectable':
      return { ok: true, message: { type: 'connectable', requestId, id } };
    case 'duplicate':
      return { ok: true, message: { type: 'duplicate', requestId, id } };
    case 'removeNode':
      return { ok: true, message: { type: 'removeNode', requestId, id } };
    case 'renameId': {
      const newId = raw['newId'];
      if (typeof newId !== 'string') return refuse('A renameId needs the new Construct ID as "newId"');
      if (newId.length > MAX_ID_LENGTH) return refuse(`A Construct ID can be at most ${MAX_ID_LENGTH} characters`);
      return { ok: true, message: { type: 'renameId', requestId, id, newId } };
    }
    case 'setProp': {
      const prop = raw['prop'];
      if (
        !Array.isArray(prop) ||
        prop.length === 0 ||
        prop.length > MAX_PROP_DEPTH ||
        !prop.every((p) => typeof p === 'string' && IDENTIFIER.test(p))
      ) {
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
