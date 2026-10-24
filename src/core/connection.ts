// Grants, Integrations and Network Connections made from the canvas (CONTEXT.md, ADR 0012): which Overlay hints fit a pair of Nodes, and the intents that write, rewrite and remove the calls that make them.
import { entryFor, type Catalog } from './catalog.ts';
import { nodeEditability } from './editability.ts';
import type { CallFacts, Facts, NodeFacts } from './facts.ts';
import type { CallPlan, CallRef, Intent, NodeRef } from './intents.ts';
import type { ConnectionHint, ConnectionKind, HintCall, ResolvedOverlay } from './overlay.ts';
import type { ConnectionPropsView } from './connections.ts';
import type { EdgeView, NodeView, ViewBody } from './view.ts';

/** What a Connection is made against: the Design on screen and what its code says. The same as what dragging from one Node to another is judged against. */
export interface HintContext {
  view: ViewBody;
  facts: Facts;
  catalog: Catalog | undefined;
  /** Why the Draft can't take an edit at the moment, when it can't. */
  blocked?: string;
  /** The paths of the constructs the Draft adds, which have no code on disk to edit until it is saved. */
  added?: ReadonlySet<string>;
}

/** One way the Overlay says two Nodes can be connected. */
export interface HintOption {
  /** Names the hint to the server: `<FQN of the construct the Overlay is for>#<index>`. */
  hint: string;
  /** The Node the hint belongs to and the Node it connects it to. */
  self: string;
  peer: string;
  kind: ConnectionKind;
  /** What the picker says: `Uploads is read by Handler`. */
  text: string;
  /** The Overlay's choice when several fit. */
  default?: true;
  /** The environment variable it also sets, and the name it gets unless the user says otherwise. */
  env?: string;
  /** The calls of the code it takes the place of: the Pair already has a Grant that this one completes, and a combined Grant does the work of both. */
  replaces?: string[];
}

const ADDED = 'Added in the Draft: save it to connect it.';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const label = (ctx: Pick<HintContext, 'view'>, path: string) =>
  ctx.view.nodes.find((n) => n.id === path)?.label ?? path.split('/').at(-1)!;

/** Why the code can't be given a call between these two Nodes, or undefined when it can. */
function whyUnwritable(ctx: HintContext, a: NodeView, b: NodeView): string | undefined {
  if (ctx.blocked) return ctx.blocked;
  const facts: NodeFacts[] = [];
  for (const node of [a, b]) {
    if (node.removed) return `${node.label} is deleted in the Draft`;
    if (ctx.added?.has(node.id)) return ADDED;
    if (node.lock !== undefined || node.hoisted)
      return node.lock || `${node.label} is created by the library, not by a statement of your code`;
    const f = ctx.facts.nodes[node.id];
    if (!f) return `Truss found no code for ${node.label}`;
    const lock = nodeEditability(node.id, f);
    if (!lock.editable) return lock.reason;
    if (f.binding === 'none')
      return `${node.label} isn't kept in a variable or a field, so there is nothing to call it by`;
    facts.push(f);
  }
  const [x, y] = facts as [NodeFacts, NodeFacts];
  if (x.pathsOnSpan !== y.pathsOnSpan) return `${a.label} and ${b.label} are not made the same number of times`;
  if (x.span.file !== y.span.file || x.enclosingClass?.name !== y.enclosingClass?.name) {
    return `${a.label} and ${b.label} have no scope in common: ${b.label} is in ${y.enclosingClass?.name ?? y.span.file}`;
  }
  return undefined;
}

/** A hint's call once the environment variable is the user's: its name, or none. */
function planOf(
  call: HintCall | Omit<HintCall, 'on'>,
  role: 'primary' | 'secondary',
  on: 'self' | 'peer',
  form: string[],
  env: string | null | undefined,
  accessor: string[] | undefined,
): CallPlan | undefined {
  const named = role === 'secondary' && /^['"]/.test(call.args[0] ?? '');
  if (named && env === null) return undefined;
  const args = call.args.map((a, i) => (named && i === 0 && env !== undefined ? `'${env}'` : a));
  const through = (a: string) => (accessor ? a.split('{peer}').join(`{peer}.${accessor.join('.')}`) : a);
  return {
    on,
    method: form,
    args: role === 'primary' ? args.map(through) : args,
    ...(call.uses ? { uses: call.uses } : {}),
    role,
  };
}

/** The literal name a hint's environment variable gets, when it has one. */
export function envOfHint(hint: ConnectionHint): string | undefined {
  for (const call of hint.secondary ?? []) {
    const first = call.args[0]?.trim();
    if (call.forms[0]?.at(-1) === 'addEnvironment' && first && /^(['"]).*\1$/.test(first)) return first.slice(1, -1);
  }
  return undefined;
}

/** The hint behind an id, and the Overlay it is in. */
function hintBehind(
  catalog: Catalog | undefined,
  id: string,
): { hint: ConnectionHint; overlay: ResolvedOverlay; fqn: string; index: number } | undefined {
  const at = id.lastIndexOf('#');
  const fqn = id.slice(0, at);
  const index = Number(id.slice(at + 1));
  const overlay = catalog && at > 0 ? entryFor(catalog, fqn)?.overlay : undefined;
  const hint = overlay?.connections[index];
  return overlay && hint ? { hint, overlay, fqn, index } : undefined;
}

/** The path an Overlay accessor takes to reach the grantee, or the connectable, of a Node that is an L3. */
function accessorFor(catalog: Catalog, node: NodeView, kind: ConnectionKind): string[] | undefined {
  const as = kind === 'grant' ? 'grantee' : kind === 'network' ? 'connectable' : undefined;
  return as ? entryFor(catalog, node.fqn)?.overlay?.accessors.find((a) => a.as === as)?.path : undefined;
}

/** The primary calls of the code between two Nodes, in either direction. */
function primariesBetween(facts: Facts, a: string, b: string): CallFacts[] {
  return (facts.calls ?? []).filter(
    (c) => c.role === 'primary' && ((c.on === a && c.peer === b) || (c.on === b && c.peer === a)),
  );
}

/** The calls that go with a primary one: the secondary calls between the same two Nodes. */
function secondariesBetween(facts: Facts, a: string, b: string): CallFacts[] {
  return (facts.calls ?? []).filter(
    (c) => c.role === 'secondary' && ((c.on === a && c.peer === b) || (c.on === b && c.peer === a)),
  );
}

const unique = <T>(items: readonly T[]) => [...new Set(items)];

/**
 * Every hint of either Node's Overlay that connects it to the other, whether or not the code could be given it. A hint
 * belongs to the Overlay of the construct its primary call is made on, so both directions are looked at.
 */
function fitting(
  ctx: HintContext,
  a: NodeView,
  b: NodeView,
): { hint: ConnectionHint; id: string; self: NodeView; peer: NodeView }[] {
  const catalog = ctx.catalog;
  if (!catalog) return [];
  const out: { hint: ConnectionHint; id: string; self: NodeView; peer: NodeView }[] = [];
  for (const [self, peer] of [
    [a, b],
    [b, a],
  ] as const) {
    const entry = entryFor(catalog, self.fqn);
    const written = ctx.facts.nodes[self.id]?.className.split('.').at(-1);
    if (!entry?.overlay || written !== entry.name) continue;
    const assignable = new Set([peer.fqn, ...(entryFor(catalog, peer.fqn)?.assignableTo ?? [])]);
    entry.overlay.connections.forEach((hint, index) => {
      if (hint.peers.some((p) => assignable.has(p))) out.push({ hint, id: `${entry.fqn}#${index}`, self, peer });
    });
  }
  return out;
}

/**
 * The hints the Overlays offer for connecting `a` and `b`, once the code can take a call between them. A Grant that
 * completes one the pair already has is offered as the combined Grant where an Overlay has one, in place of the half it would add.
 */
export function hintsFor(
  ctx: HintContext,
  a: string,
  b: string,
): { ok: true; options: HintOption[] } | { ok: false; reason: string; nothing?: true } {
  const nodeA = ctx.view.nodes.find((n) => n.id === a);
  const nodeB = ctx.view.nodes.find((n) => n.id === b);
  if (!nodeA || !nodeB || a === b) return { ok: false, reason: 'Nothing to connect' };
  const fits = fitting(ctx, nodeA, nodeB);
  if (fits.length === 0)
    return { ok: false, reason: `Truss has no way to connect ${nodeA.label} and ${nodeB.label}`, nothing: true };
  const unwritable = whyUnwritable(ctx, nodeA, nodeB);
  if (unwritable) return { ok: false, reason: unwritable };
  const existing = primariesBetween(ctx.facts, a, b).filter((c) => c.hint !== undefined);
  const options: HintOption[] = [];
  const add = (f: (typeof fits)[number], replaces?: string[]) => {
    const there = options.find((o) => o.hint === f.id);
    if (there) {
      if (replaces && !there.replaces) there.replaces = replaces;
      return;
    }
    const env = envOfHint(f.hint);
    options.push({
      hint: f.id,
      self: f.self.id,
      peer: f.peer.id,
      kind: f.hint.kind,
      text: `${f.self.label} ${f.hint.label} ${f.peer.label}`,
      ...(f.hint.default ? { default: true as const } : {}),
      ...(env ? { env } : {}),
      ...(replaces ? { replaces } : {}),
    });
  };
  for (const f of fits) {
    if (existing.some((c) => c.hint === f.id)) continue;
    // A combined Grant the pair has already covers the halves it is made of.
    if (existing.some((c) => hintBehind(ctx.catalog, c.hint!)?.hint.combines?.includes(f.hint.label))) continue;
    // The label of a hint is what it is called among the others of its Overlay.
    const others = existing
      .flatMap((c) => hintBehind(ctx.catalog, c.hint!)?.hint ?? [])
      .filter((h) => h.kind === f.hint.kind);
    const combined = fits.find(
      (c) =>
        c.self === f.self &&
        c.hint.combines?.includes(f.hint.label) &&
        others.some((h) => c.hint.combines!.includes(h.label)),
    );
    if (combined) {
      const ids = existing
        .filter(
          (c) =>
            hintBehind(ctx.catalog, c.hint!)?.hint &&
            combined.hint.combines!.includes(hintBehind(ctx.catalog, c.hint!)!.hint.label),
        )
        .map((c) => c.id);
      add(combined, unique([...ids, ...secondariesBetween(ctx.facts, a, b).map((c) => c.id)]));
    } else add(f);
  }
  // The Overlay's default goes first, then the others in the order the Overlay lists them.
  options.sort((x, y) => Number(y.default === true) - Number(x.default === true));
  if (options.length === 0)
    return { ok: false, reason: `${nodeA.label} and ${nodeB.label} are connected that way already` };
  return { ok: true, options };
}

type Made = { ok: true; intent: Intent } | { ok: false; reason: string };

const nodeRef = (ctx: HintContext, path: string): NodeRef => {
  const f = ctx.facts.nodes[path]!;
  return { path, className: f.className, literalId: f.literalId ?? '' };
};

const expectOf = (ctx: HintContext, path: string) => {
  const f = ctx.facts.nodes[path]!;
  return { className: f.className, literalId: f.literalId ?? '' };
};

/** The calls a hint writes between two Nodes, with the environment variable named, or left out with `null`. */
function plansFor(
  ctx: HintContext,
  id: string,
  self: NodeView,
  peer: NodeView,
  env: string | null | undefined,
): { kind: ConnectionKind; calls: CallPlan[] } | { reason: string } {
  const found = hintBehind(ctx.catalog, id);
  if (!found) return { reason: 'That way of connecting them is not offered' };
  const { hint } = found;
  if (typeof env === 'string' && !IDENTIFIER.test(env))
    return { reason: `${env} is not a name an environment variable can have` };
  const accessor = accessorFor(ctx.catalog!, peer, hint.kind);
  const primary = planOf(hint.primary, 'primary', 'self', hint.primary.forms[0]!, undefined, accessor);
  const secondary = (hint.secondary ?? []).flatMap(
    (c) => planOf(c, 'secondary', c.on, c.forms[0]!, env, undefined) ?? [],
  );
  return { kind: hint.kind, calls: [primary!, ...secondary] };
}

/** What connecting `a` and `b` in the way a hint says means for the Draft. `env` renames the environment variable the hint sets, or with `null` leaves it out. */
export function intentForAddConnection(
  ctx: HintContext,
  a: string,
  b: string,
  hint: string,
  env?: string | null,
): Made {
  const offered = hintsFor(ctx, a, b);
  if (!offered.ok) return offered;
  const option = offered.options.find((o) => o.hint === hint);
  if (!option) return { ok: false, reason: 'That way of connecting them is not offered' };
  const self = ctx.view.nodes.find((n) => n.id === option.self)!;
  const peer = ctx.view.nodes.find((n) => n.id === option.peer)!;
  const plans = plansFor(ctx, hint, self, peer, env);
  if ('reason' in plans) return { ok: false, reason: plans.reason };
  if (option.replaces) return changeIntent(ctx, option.replaces, { hint, ...(env !== undefined ? { env } : {}) });
  return {
    ok: true,
    intent: {
      type: 'addConnection',
      path: self.id,
      expect: expectOf(ctx, self.id),
      peer: nodeRef(ctx, peer.id),
      kind: plans.kind,
      calls: plans.calls,
    },
  };
}

const refOfFact = (c: CallFacts): CallRef => ({
  role: c.role,
  on: c.on,
  peer: c.peer,
  method: c.method,
  ...(c.env !== undefined ? { env: c.env } : {}),
});

/** The calls with these ids, each of which has to be one Truss edits. */
function callsWith(ctx: HintContext, ids: readonly string[]): { calls: CallFacts[] } | { reason: string } {
  const calls: CallFacts[] = [];
  for (const id of unique(ids)) {
    const call = (ctx.facts.calls ?? []).find((c) => c.id === id);
    if (!call) return { reason: `There is no such call in the code any more` };
    if (!call.editable) return { reason: call.reason ?? `Truss leaves ${call.text} alone` };
    calls.push(call);
  }
  if (calls.length === 0) return { reason: 'There is no call to change' };
  return { calls };
}

/** What taking calls out of the code means for the Draft. */
export function intentForRemoveConnection(ctx: HintContext, ids: readonly string[]): Made {
  if (ctx.blocked) return { ok: false, reason: ctx.blocked };
  const found = callsWith(ctx, ids);
  if ('reason' in found) return { ok: false, reason: found.reason };
  const first = found.calls.find((c) => c.role === 'primary') ?? found.calls[0]!;
  const gone = whyGone(ctx, [first.on, first.peer]);
  if (gone) return { ok: false, reason: gone };
  return {
    ok: true,
    intent: {
      type: 'removeConnection',
      path: first.on,
      expect: expectOf(ctx, first.on),
      peer: nodeRef(ctx, first.peer),
      kind: first.kind,
      calls: found.calls.map(refOfFact),
    },
  };
}

const whyGone = (ctx: HintContext, paths: readonly string[]): string | undefined => {
  for (const path of paths) {
    const node = ctx.view.nodes.find((n) => n.id === path);
    if (!node) return `No Node at ${path}`;
    if (node.removed) return `${node.label} is deleted in the Draft`;
    if (ctx.added?.has(path)) return ADDED;
    if (!ctx.facts.nodes[path]) return `Truss found no code for ${node.label}`;
  }
  return undefined;
};

/**
 * What changing a Connection means for the Draft: its calls (by id) written again for another hint, or with the environment
 * variable renamed (`env` a name) or switched off (`env` null). Left out, either stays as the code has it.
 */
export function intentForChangeConnection(
  ctx: HintContext,
  ids: readonly string[],
  change: { hint?: string; env?: string | null },
): Made {
  if (ctx.blocked) return { ok: false, reason: ctx.blocked };
  return changeIntent(ctx, ids, change);
}

function changeIntent(ctx: HintContext, ids: readonly string[], change: { hint?: string; env?: string | null }): Made {
  const found = callsWith(ctx, ids);
  if ('reason' in found) return { ok: false, reason: found.reason };
  const primary = found.calls.find((c) => c.role === 'primary');
  if (!primary) return { ok: false, reason: 'The Connection has no call of its own to change' };
  const current = primary.hint;
  const hint = change.hint ?? current;
  if (!hint)
    return { ok: false, reason: 'Truss recognises this call as a Grant but has no hint for writing it another way' };
  const behind = hintBehind(ctx.catalog, hint);
  const pair = hintsForPair(ctx, primary.on, primary.peer, hint);
  const self = ctx.view.nodes.find((n) => n.id === pair?.self);
  const peer = ctx.view.nodes.find((n) => n.id === pair?.peer);
  if (!behind || !self || !peer) return { ok: false, reason: 'That way of connecting them is not offered' };
  const gone = whyGone(ctx, [self.id, peer.id]);
  if (gone) return { ok: false, reason: gone };
  const sets = found.calls.filter((c) => c.role === 'secondary' && c.env !== undefined);
  const hasEnv = envOfHint(behind.hint) !== undefined;
  const base = { path: self.id, expect: expectOf(ctx, self.id), peer: nodeRef(ctx, peer.id), kind: behind.hint.kind };
  if (hint === current) {
    // The kind stays as the code writes it, down to the arguments: only the environment variable changes.
    if (change.env === undefined) return { ok: false, reason: 'Nothing to change' };
    if (!hasEnv) return { ok: false, reason: 'This Connection sets no environment variable' };
    if (change.env === null) {
      if (sets.length === 0) return { ok: false, reason: 'This Connection sets no environment variable' };
      return { ok: true, intent: { type: 'removeConnection', ...base, calls: sets.map(refOfFact) } };
    }
    const plans = plansFor(ctx, hint, self, peer, change.env);
    if ('reason' in plans) return { ok: false, reason: plans.reason };
    const calls = plans.calls.filter((c) => c.role === 'secondary');
    if (sets.length === 0) return { ok: true, intent: { type: 'addConnection', ...base, calls } };
    return { ok: true, intent: { type: 'replaceConnection', ...base, was: sets.map(refOfFact), calls } };
  }
  // Another kind: written again whole, the environment variable as it is unless the user says.
  const env = change.env !== undefined ? change.env : (sets[0]?.env ?? null);
  const plans = plansFor(ctx, hint, self, peer, hasEnv ? env : undefined);
  if ('reason' in plans) return { ok: false, reason: plans.reason };
  return {
    ok: true,
    intent: {
      type: 'replaceConnection',
      ...base,
      kind: plans.kind,
      was: found.calls.map(refOfFact),
      calls: plans.calls,
    },
  };
}

/** Which Node a hint belongs to for a pair, however the pair is connected now. */
function hintsForPair(
  ctx: HintContext,
  a: string,
  b: string,
  hint: string,
): { self: string; peer: string } | undefined {
  const nodeA = ctx.view.nodes.find((n) => n.id === a);
  const nodeB = ctx.view.nodes.find((n) => n.id === b);
  const found = nodeA && nodeB ? fitting(ctx, nodeA, nodeB).find((f) => f.id === hint) : undefined;
  return found ? { self: found.self.id, peer: found.peer.id } : undefined;
}

/** The props of the Connection an edge is, when its calls can be changed. Absent for an edge Truss can't edit. */
export function connectionProps(
  ctx: HintContext,
  edge: Pick<EdgeView, 'from' | 'to' | 'kind' | 'calls' | 'readOnly'>,
): ConnectionPropsView | undefined {
  if (!edge.calls || edge.readOnly !== undefined || ctx.blocked || edge.kind === 'reference') return undefined;
  const primaries = edge.calls.filter((c) => c.role === 'primary' && c.hint !== undefined);
  if (primaries.length === 0 || primaries.length !== edge.calls.filter((c) => c.role === 'primary').length)
    return undefined;
  const nodeA = ctx.view.nodes.find((n) => n.id === edge.from);
  const nodeB = ctx.view.nodes.find((n) => n.id === edge.to);
  if (!nodeA || !nodeB) return undefined;
  const props: ConnectionPropsView = {};
  const all = fitting(ctx, nodeA, nodeB).filter((f) => f.hint.kind === edge.kind);
  const textOf = (f: (typeof all)[number]) => `${f.self.label} ${f.hint.label} ${f.peer.label}`;
  if (primaries.length === 1) {
    const current = primaries[0]!.hint!;
    const here = all.find((f) => f.id === current);
    // The kind can be changed to any other that fits, and to the one it is.
    if (here)
      props.access = {
        current,
        options: all.filter((f) => f.self === here.self).map((f) => ({ hint: f.id, text: textOf(f) })),
      };
  } else {
    const have = primaries.map((c) => hintBehind(ctx.catalog, c.hint!)).flatMap((h) => h?.hint.label ?? []);
    const combined = all.find(
      (f) =>
        f.hint.combines && have.every((l) => f.hint.combines!.includes(l)) && f.hint.combines.length === have.length,
    );
    if (combined) props.combine = { hint: combined.id, text: textOf(combined) };
  }
  const hint = primaries[0]!.hint ? hintBehind(ctx.catalog, primaries[0]!.hint) : undefined;
  const fallback = hint ? envOfHint(hint.hint) : undefined;
  if (primaries.length === 1 && fallback) {
    const set = edge.calls.find((c) => c.role === 'secondary' && c.env !== undefined);
    props.env = { name: set?.env ?? fallback, on: set !== undefined, default: fallback };
  }
  return props.access || props.combine || props.env ? props : undefined;
}
