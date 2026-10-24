import { entryFor, type Catalog, type CatalogEntry } from './catalog.ts';
import { hintsFor, type HintOption } from './connection.ts';
import { nodeEditability } from './editability.ts';
import type { Facts, NodeFacts, ReferenceFacts } from './facts.ts';
import type { Intent, NodeRef } from './intents.ts';
import type { NodeView, ViewBody } from './view.ts';

/** What dragging from one Node to another is judged against. */
export interface ConnectContext {
  /** The Design on screen. */
  view: ViewBody;
  /** What the code of that Design says. */
  facts: Facts;
  catalog: Catalog | undefined;
  /** Why the Draft can't take an edit at the moment, when it can't. */
  blocked?: string;
  /** The paths of the constructs the Draft adds, which have no code on disk to edit until it is saved. */
  added?: ReadonlySet<string>;
}

/** One prop the target could fill. */
export interface ConnectOption {
  prop: string;
  /** What the prop is typed as, e.g. `IVpc` or `ISecurityGroup[]`. */
  type: string;
  /** The prop takes several Nodes; a drop adds one. */
  many: boolean;
  /** For a prop that takes one Node and already points at another, the one a drop would replace. */
  replaces?: { id: string; label: string };
}

/** `options` are the props of the target a Reference could go in; `hints` are the Grants, Integrations and Network Connections the Overlays offer. Either can be empty, but not both. */
export type ConnectCheck = { ok: true; options: ConnectOption[]; hints?: HintOption[] } | { ok: false; reason: string };

const ADDED = 'Added in the Draft: save it to connect it.';

const nameOf = (n: NodeView) => n.label;

/** Why `node` can't have its props changed, or undefined when it can. */
function whyReadOnly(ctx: ConnectContext, node: NodeView, facts: NodeFacts | undefined): string | undefined {
  if (node.removed) return `${nameOf(node)} is deleted in the Draft`;
  if (ctx.added?.has(node.id)) return ADDED;
  if (node.lock !== undefined) return node.lock;
  if (!facts) return `Truss found no code for ${nameOf(node)}`;
  const lock = nodeEditability(node.id, facts);
  if (!lock.editable) return lock.reason;
  if (facts.props?.form === 'other') return `The props of ${nameOf(node)} are passed as ${facts.props.text}, so Truss can't change them`;
  return ctx.blocked;
}

/** What the prop `prop` of `from` points at now. */
const held = (refs: readonly ReferenceFacts[], from: string, prop: string) => refs.filter((r) => r.from === from && r.prop === prop);

/** How many elements an array literal as written holds; -1 for anything that isn't one. */
function countElements(text: string): number {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return -1;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return 0;
  let depth = 0;
  let count = 1;
  for (const ch of inner) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return inner.endsWith(',') ? count - 1 : count;
}

function optionsOf(ctx: ConnectContext, from: NodeView, to: NodeView, entry: CatalogEntry, fromFacts: NodeFacts, why: string[]): ConnectOption[] {
  const target = entryFor(ctx.catalog!, to.fqn);
  const assignable = new Set([to.fqn, ...(target?.assignableTo ?? [])]);
  const refs = ctx.facts.references ?? [];
  const label = (path: string) => ctx.view.nodes.find((n) => n.id === path)?.label ?? path.split('/').at(-1)!;
  const options: ConnectOption[] = [];
  for (const prop of entry.props) {
    if (!prop.accepts || !assignable.has(prop.accepts.fqn)) continue;
    const now = held(refs, from.id, prop.name);
    const written = fromFacts.props?.form === 'object' ? fromFacts.props.props.find((p) => p.name === prop.name) : undefined;
    const many = prop.accepts.many === true;
    const fixed = now.find((r) => !r.editable);
    if (fixed) {
      why.push(`${prop.name} is set by ${fixed.text}, which Truss leaves alone`);
      continue;
    }
    // Written as something that isn't a Reference Truss reads (a parameter, a call), or as a list that holds other things: there is no telling what to replace.
    if (written && now.length === 0 && !(many && countElements(written.text) === 0)) {
      why.push(`${prop.name} is written as ${written.text} in the code`);
      continue;
    }
    if (written && many && now.length !== countElements(written.text)) {
      why.push(`${prop.name} holds more than the Nodes Truss can read`);
      continue;
    }
    if (now.some((r) => r.to === to.id)) {
      why.push(`${prop.name} already points at ${nameOf(to)}`);
      continue;
    }
    options.push({
      prop: prop.name,
      type: prop.type,
      many,
      ...(!many && now.length === 1 ? { replaces: { id: now[0]!.to, label: label(now[0]!.to) } } : {}),
    });
  }
  return options;
}

/**
 * Whether `from` can be connected to `to` by a Reference, and through which props: those of `from` typed as
 * an interface or class that `to` is. One option means a drop makes it directly; none, with the reason why.
 */
export function canConnect(ctx: ConnectContext, from: string, to: string): ConnectCheck {
  const reference = canReference(ctx, from, to);
  if (from === to || !ctx.view.nodes.some((n) => n.id === from) || !ctx.view.nodes.some((n) => n.id === to)) return reference;
  const hints = hintsFor(ctx, from, to);
  if (!hints.ok) return reference.ok || hints.nothing ? reference : { ok: false, reason: hints.reason };
  return { ok: true, options: reference.ok ? reference.options : [], hints: hints.options };
}

/** Whether `from` can point at `to` through one of its props. */
function canReference(ctx: ConnectContext, from: string, to: string): ConnectCheck {
  const source = ctx.view.nodes.find((n) => n.id === from);
  const target = ctx.view.nodes.find((n) => n.id === to);
  if (!source || !target) return { ok: false, reason: `No Node at ${source ? to : from}` };
  if (from === to) return { ok: false, reason: `${nameOf(source)} can't point at itself` };
  const fromFacts = ctx.facts.nodes[from];
  const toFacts = ctx.facts.nodes[to];
  const locked = whyReadOnly(ctx, source, fromFacts);
  if (locked || !fromFacts) return { ok: false, reason: locked ?? `Truss found no code for ${nameOf(source)}` };
  if (target.removed) return { ok: false, reason: `${nameOf(target)} is deleted in the Draft` };
  if (ctx.added?.has(to)) return { ok: false, reason: ADDED };
  if (target.hoisted || !toFacts) return { ok: false, reason: `${nameOf(target)} is created by the library, not by a statement of your code, so there is nothing to point at` };
  if (toFacts.binding === 'none') return { ok: false, reason: `${nameOf(target)} isn't kept in a variable or a field, so there is nothing to point at` };
  if (toFacts.pathsOnSpan !== fromFacts.pathsOnSpan) return { ok: false, reason: `${nameOf(target)} and ${nameOf(source)} are not made the same number of times` };
  if (toFacts.span.file !== fromFacts.span.file || toFacts.enclosingClass?.name !== fromFacts.enclosingClass?.name) {
    return { ok: false, reason: `${nameOf(source)} and ${nameOf(target)} have no scope in common: ${nameOf(target)} is in ${toFacts.enclosingClass?.name ?? toFacts.span.file}` };
  }
  const entry = ctx.catalog && entryFor(ctx.catalog, source.fqn);
  const written = fromFacts.className.split('.').at(-1);
  if (!entry || written !== entry.name) return { ok: false, reason: `Truss doesn't know the props of ${source.subtitle || source.fqn}` };
  const why: string[] = [];
  const options = optionsOf(ctx, source, target, entry, fromFacts, why);
  if (options.length > 0) return { ok: true, options };
  return { ok: false, reason: why[0] ?? `${nameOf(source)} has no prop that takes ${nameOf(target)}` };
}

/** What dragging from `from` could end on: the answer for every other Node of the Design. */
export function connectTargets(ctx: ConnectContext, from: string): Record<string, ConnectCheck> {
  return Object.fromEntries(ctx.view.nodes.filter((n) => n.id !== from).map((n) => [n.id, canConnect(ctx, from, n.id)]));
}

const nodeRef = (ctx: ConnectContext, path: string): NodeRef => {
  const f = ctx.facts.nodes[path]!;
  return { path, className: f.className, literalId: f.literalId ?? '' };
};

const sourceExpect = (ctx: ConnectContext, from: string) => {
  const f = ctx.facts.nodes[from]!;
  return { className: f.className, literalId: f.literalId ?? '' };
};

type Made = { ok: true; intent: Intent } | { ok: false; reason: string };

const labelOf = (ctx: ConnectContext, id: string) => ctx.view.nodes.find((n) => n.id === id)?.label ?? id;

/** What dropping `from` on `to` means for the Draft. A prop that points at another Node now needs `replace`: the caller asks the user first. */
export function intentForConnect(ctx: ConnectContext, from: string, to: string, prop: string, replace = false): Made {
  const check = canConnect(ctx, from, to);
  if (!check.ok) return check;
  const option = check.options.find((o) => o.prop === prop);
  if (!option) return { ok: false, reason: `${prop} doesn't take ${labelOf(ctx, to)}` };
  const base = { path: from, expect: sourceExpect(ctx, from), prop };
  if (option.replaces) {
    if (!replace) return { ok: false, reason: `${prop} already points at ${option.replaces.label}` };
    return { ok: true, intent: { type: 'repointReference', ...base, was: nodeRef(ctx, option.replaces.id), to: nodeRef(ctx, to) } };
  }
  return { ok: true, intent: { type: 'addReference', ...base, ...(option.many ? { many: true as const } : {}), to: nodeRef(ctx, to) } };
}

/** What taking `to` out of a prop of `from` means for the Draft. */
export function intentForDisconnect(ctx: ConnectContext, from: string, to: string, prop: string): Made {
  const source = ctx.view.nodes.find((n) => n.id === from);
  if (!source) return { ok: false, reason: `No Node at ${from}` };
  const locked = whyReadOnly(ctx, source, ctx.facts.nodes[from]);
  if (locked) return { ok: false, reason: locked };
  const ref = (ctx.facts.references ?? []).find((r) => r.from === from && r.to === to && r.prop === prop);
  if (!ref) return { ok: false, reason: `${prop} doesn't point at ${labelOf(ctx, to)}` };
  if (!ref.editable) return { ok: false, reason: ref.reason ?? `${prop} can't be changed here` };
  return { ok: true, intent: { type: 'removeReference', path: from, expect: sourceExpect(ctx, from), prop, to: nodeRef(ctx, to) } };
}

/** What moving the end of a Reference from `was` to `to` means for the Draft. */
export function intentForRepoint(ctx: ConnectContext, from: string, was: string, to: string, prop: string): Made {
  const removal = intentForDisconnect(ctx, from, was, prop);
  if (!removal.ok) return removal;
  const check = canConnect(ctx, from, to);
  if (!check.ok) return check;
  // Re-pointing a single-value prop is a drop that replaces; an array prop gets the Node in the place of the old one.
  const option = check.options.find((o) => o.prop === prop);
  if (!option) return { ok: false, reason: `${prop} doesn't take ${labelOf(ctx, to)}` };
  return { ok: true, intent: { type: 'repointReference', path: from, expect: sourceExpect(ctx, from), prop, was: nodeRef(ctx, was), to: nodeRef(ctx, to) } };
}
