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

export type Intent = SetPropIntent;

/** The Draft (CONTEXT.md): intents in the order they were made, and the undone ones that redo can bring back. */
export interface Draft {
  intents: readonly Intent[];
  redo: readonly Intent[];
}

export const emptyDraft: Draft = { intents: [], redo: [] };

const sameTarget = (a: Intent, b: Intent) => a.path === b.path && a.prop.length === b.prop.length && a.prop.every((p, i) => p === b.prop[i]);

/** Adds an intent. Setting the same prop again replaces the last intent, so one run of edits to a field is one undo step. A new edit ends redo. */
export function stage(draft: Draft, intent: Intent): Draft {
  const last = draft.intents.at(-1);
  const kept = last && sameTarget(last, intent) ? draft.intents.slice(0, -1) : draft.intents;
  return { intents: [...kept, intent], redo: [] };
}

export function undo(draft: Draft): Draft {
  const last = draft.intents.at(-1);
  return last ? { intents: draft.intents.slice(0, -1), redo: [...draft.redo, last] } : draft;
}

export function redo(draft: Draft): Draft {
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
export const describeIntent = (intent: Intent): string => `${intent.prop.join('.')} → ${valueText(intent.value)}`;

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
  if (intents.length === 0 || props?.form === 'other') return props;
  return { form: 'object', props: intents.reduce((all, i) => setIn(all, i.prop, i.value), props?.props ?? []) };
}
