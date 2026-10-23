import { withId } from './construct-id.ts';
import type { Snippet } from './overlay.ts';
import type { PropFacts, PropsFacts } from './facts.ts';

export const DURATION_UNITS = ['millis', 'seconds', 'minutes', 'hours', 'days'] as const;
export const SIZE_UNITS = ['kibibytes', 'mebibytes', 'gibibytes', 'tebibytes', 'pebibytes'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];
export type SizeUnit = (typeof SIZE_UNITS)[number];

/** A value a prop can be set to from the canvas: the literals Truss writes into code. */
export type PropValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  /** `type` is the enum's jsii FQN, e.g. `aws-cdk-lib.aws_s3.BucketEncryption`, so the code can be given the import it needs. */
  | { kind: 'enum'; type: string; member: string }
  | { kind: 'duration'; unit: DurationUnit; amount: number }
  | { kind: 'size'; unit: SizeUnit; amount: number };

/** What a canvas gesture means for the code, named by construct path and checked against the class and ID the user saw (ADR 0007). */
export interface SetPropIntent {
  type: 'setProp';
  /** The construct path of the Node or Stack. */
  path: string;
  /** The class as written and the literal ID at the time of the edit; a target that no longer matches is not edited. */
  expect: { className: string; literalId: string };
  /** The prop, then the field inside it for a prop that is an object literal: `['partitionKey', 'name']`. */
  prop: string[];
  value: PropValue;
}

/** Gives a construct a new Construct ID, by rewriting the literal in its `new` call and nothing else. */
export interface RenameIdIntent {
  type: 'renameId';
  /** The construct path of the Node or Stack as the Draft shows it when the edit is made. */
  path: string;
  /** The class as written and the literal ID at the time of the edit. */
  expect: { className: string; literalId: string };
  newId: string;
}

/** A prop of a new construct: a piece of code from the Overlay's defaults, or a value the user gave in the form. */
export type AddedProp = { name: string; snippet: Snippet } | { name: string; value: PropValue };

/** Adds a construct of the Catalog to a Stack, as the statement the developer would have written. */
export interface AddNodeIntent {
  type: 'addNode';
  /** The construct path of the Stack it is added to. */
  path: string;
  /** The class as written and the literal ID of that Stack at the time of the edit. */
  expect: { className: string; literalId: string };
  /** The jsii FQN of the construct to add, e.g. `aws-cdk-lib.aws_s3.Bucket`. */
  fqn: string;
  /** The Construct ID it gets. */
  id: string;
  /** The props the construct needs to be valid. */
  props: AddedProp[];
}

/** Copies the `new` statement of an editable Node, with a fresh Construct ID. */
export interface DuplicateIntent {
  type: 'duplicate';
  /** The construct path of the Node that is copied. */
  path: string;
  expect: { className: string; literalId: string };
  /** The Construct ID of the copy. */
  newId: string;
}

export type Intent = SetPropIntent | RenameIdIntent | AddNodeIntent | DuplicateIntent;

/** The path a construct made by `intent` has, in the paths as they are once the intents before it have been made. Undefined for an intent that makes none. */
export const createdPath = (intent: Intent): string | undefined => (intent.type === 'addNode' ? `${intent.path}/${intent.id}` : intent.type === 'duplicate' ? withId(intent.path, intent.newId) : undefined);

/** The Construct ID of the construct an intent is about: the one it makes, or the one it edits. */
export const idOf = (intent: Intent): string => (intent.type === 'addNode' ? intent.id : intent.type === 'duplicate' ? intent.newId : intent.expect.literalId);

/** Where a rename moves a construct: its path before and after, and so everything beneath it. */
export interface Move {
  from: string;
  to: string;
}

/** The moves the renames among `intents` make, in order. Each is in the paths as they are once the ones before it have been made. */
export const movesOf = (intents: readonly Intent[]): Move[] =>
  intents.flatMap((i) => (i.type === 'renameId' ? [{ from: i.path, to: withId(i.path, i.newId) }] : []));

const under = (path: string, from: string) => path === from || path.startsWith(`${from}/`);

/** `path` once `moves` are made, in order. */
export const afterMoves = (moves: readonly Move[], path: string): string => moves.reduce((p, m) => (under(p, m.from) ? m.to + p.slice(m.from.length) : p), path);

/** `path`, as `moves` leave it, as it was before any of them. */
export const beforeMoves = (moves: readonly Move[], path: string): string => moves.reduceRight((p, m) => (under(p, m.to) ? m.from + p.slice(m.to.length) : p), path);

/**
 * The intents named by the paths and IDs the Base has. A rename changes a construct's path in the Draft, so
 * an edit made after it names the new path; planned on the Base, it has to name the old one.
 */
export function onBase(intents: readonly Intent[]): Intent[] {
  return intents.map((intent, i) => {
    const path = beforeMoves(movesOf(intents.slice(0, i)), intent.path);
    if (path === intent.path) return intent;
    const literalId = path.split('/').at(-1)!;
    return { ...intent, path, expect: { ...intent.expect, literalId: intent.path.split('/').at(-1) === intent.expect.literalId ? literalId : intent.expect.literalId } };
  });
}

/** The history of the Draft (CONTEXT.md): intents in the order they were made, and the undone ones that redo can bring back. */
export interface DraftHistory {
  intents: readonly Intent[];
  redo: readonly Intent[];
}

export const emptyDraftHistory: DraftHistory = { intents: [], redo: [] };

const sameTarget = (a: SetPropIntent, b: SetPropIntent) => a.path === b.path && a.prop.length === b.prop.length && a.prop.every((p, i) => p === b.prop[i]);

/**
 * Adds an intent. Setting the same prop again replaces the last intent, so one run of edits to a field is one undo step,
 * and so does renaming the construct just renamed (back to the ID it started with, that is no edit at all). A new edit ends redo.
 */
export function stage(draft: DraftHistory, intent: Intent): DraftHistory {
  const last = draft.intents.at(-1);
  const rest = draft.intents.slice(0, -1);
  if (last?.type === 'setProp' && intent.type === 'setProp' && sameTarget(last, intent)) return { intents: [...rest, intent], redo: [] };
  if (last?.type === 'renameId' && intent.type === 'renameId' && afterMoves(movesOf([last]), last.path) === intent.path) {
    return { intents: intent.newId === last.expect.literalId ? rest : [...rest, { ...intent, path: last.path, expect: last.expect }], redo: [] };
  }
  return { intents: [...draft.intents, intent], redo: [] };
}

export function undo(draft: DraftHistory): DraftHistory {
  const last = draft.intents.at(-1);
  return last ? { intents: draft.intents.slice(0, -1), redo: [...draft.redo, last] } : draft;
}

export function redo(draft: DraftHistory): DraftHistory {
  const next = draft.redo.at(-1);
  return next ? { intents: [...draft.intents, next], redo: draft.redo.slice(0, -1) } : draft;
}

/** A value as the Draft list shows it. */
export function valueText(value: PropValue): string {
  switch (value.kind) {
    case 'string':
      return JSON.stringify(value.value);
    case 'number':
    case 'boolean':
      return String(value.value);
    case 'enum':
      return `${value.type.split('.').at(-1)}.${value.member}`;
    case 'duration':
    case 'size':
      return `${value.amount} ${value.unit}`;
  }
}

/** An intent as the Draft list words it, e.g. `versioned → true`. */
export function describeIntent(intent: Intent): string {
  switch (intent.type) {
    case 'renameId':
      return `Construct ID → ${JSON.stringify(intent.newId)}`;
    case 'addNode':
      return `Add ${intent.fqn.split('.').at(-1)} ${JSON.stringify(intent.id)}`;
    case 'duplicate':
      return `Duplicate as ${JSON.stringify(intent.newId)}`;
    case 'setProp':
      return `${intent.prop.join('.')} → ${valueText(intent.value)}`;
  }
}

// --- Panel overlay ---------------------------------------------------------------------------------------

const QUANTITY_TYPES = { duration: 'Duration', size: 'Size' } as const;

function factOf(name: string, value: PropValue): PropFacts {
  switch (value.kind) {
    case 'string':
      return { name, kind: 'literal', text: JSON.stringify(value.value), value: value.value };
    case 'number':
    case 'boolean':
      return { name, kind: 'literal', text: String(value.value), value: value.value };
    case 'enum': {
      const type = value.type.split('.').at(-1)!;
      return { name, kind: 'expression', text: `${type}.${value.member}`, member: { type, name: value.member } };
    }
    case 'duration':
    case 'size': {
      const type = QUANTITY_TYPES[value.kind];
      return { name, kind: 'expression', text: `${type}.${value.unit}(${value.amount})`, quantity: { type, unit: value.unit, amount: value.amount } };
    }
  }
}

function setIn(props: readonly PropFacts[], path: readonly string[], value: PropValue): PropFacts[] {
  const [name, ...rest] = path;
  if (name === undefined) return [...props];
  const at = props.findIndex((p) => p.name === name);
  const existing = at >= 0 ? props[at] : undefined;
  let next: PropFacts;
  if (rest.length === 0) next = factOf(name, value);
  else {
    const fields = setIn(existing?.kind === 'object' ? (existing.fields ?? []) : [], rest, value);
    next = { name, kind: 'object', text: '{ … }', fields };
  }
  return at >= 0 ? props.map((p, i) => (i === at ? next : p)) : [...props, next];
}

/** The props of a construct as the code would have them with these intents applied, for showing a value before synth has caught up. */
export function withIntents(props: PropsFacts | undefined, intents: readonly Intent[]): PropsFacts | undefined {
  if (!intents.some((i) => i.type === 'setProp') || props?.form === 'other') return props;
  return { form: 'object', props: intents.reduce((all, i) => (i.type === 'setProp' ? setIn(all, i.prop, i.value) : all), props?.props ?? []) };
}
