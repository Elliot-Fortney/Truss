import type { Assembly, Effect, EffectEnd } from './assembly.ts';
import type { CallFacts, Facts } from './facts.ts';

/** One thing the synthesized app grants, triggers or opens (ADR 0012), as the panel lists it. */
export interface EffectView {
  /** What it says in a few words: `s3:GetObject`, `event source mapping`, `tcp 5432`. */
  detail: string;
  /** The whole of it with both ends, e.g. `s3:GetObject · Fn → *`. */
  summary: string;
  /** The construct path of the resource that carries it, e.g. a policy. */
  at: string;
}

/** A call in the code that makes a Connection, as the panel of its edge lists it. */
export interface EdgeCallView {
  /** Names the call in the code as it is now. */
  id: string;
  role: 'primary' | 'secondary';
  /** The statement as written. */
  text: string;
  /** The Overlay hint it is an instance of; absent for a generic jsii grant call. */
  hint?: string;
  /** For a call that sets an environment variable, its name. */
  env?: string;
  /** Whether Truss can remove or rewrite it, and why not. */
  editable: boolean;
  reason?: string;
}

/** What the panel of an edge offers to change about the Connection it is: the props of the Connection. */
export interface ConnectionPropsView {
  /** What the Connection is, among the ways the Overlay offers to make it. Featured first. */
  access?: { current: string; options: { hint: string; text: string }[] };
  /** Two Grants on the pair that the Overlay has one Grant for. */
  combine?: { hint: string; text: string };
  /** The environment variable the Connection sets, and whether it does. */
  env?: { name: string; on: boolean; default: string };
}

/** The part of a Node on screen that connections are rolled up to. */
export interface ConnectableNode {
  id: string;
  label: string;
  source?: { file: string; line: number; col: number };
}

/** An edge drawn from what synth produced; the same fields an `EdgeView` has. */
export interface ConnectionEdge {
  id: string;
  kind: 'reference' | 'grant' | 'integration' | 'network';
  from: string;
  to: string;
  prop: string;
  text: string;
  /** Why Truss draws it but doesn't edit it, when that is so. */
  readOnly?: string;
  /** Read from what synth produced, not written in the code. */
  fromSynth?: true;
  source?: { file: string; line: number; col: number };
  effects?: EffectView[];
  /** The calls of the code that make it. */
  calls?: EdgeCallView[];
  /** What can be changed about the Connection, when it can be. */
  connection?: ConnectionPropsView;
}

type Kind = 'grant' | 'integration' | 'network';

const READ_ONLY = 'Truss reads this from what the app synthesizes, and no call it recognises makes it';
const CROSS_STACK = "It reads another Stack's export through Fn::ImportValue, which Truss does not edit";

const NOUN: Record<Kind, [string, string]> = {
  grant: ['permission', 'permissions'],
  integration: ['trigger', 'triggers'],
  network: ['rule', 'rules'],
};

const callView = (c: CallFacts): EdgeCallView => ({
  id: c.id,
  role: c.role,
  text: c.text,
  ...(c.hint ? { hint: c.hint } : {}),
  ...(c.env !== undefined ? { env: c.env } : {}),
  editable: c.editable,
  ...(c.reason ? { reason: c.reason } : {}),
});

/** Why the edge can't be removed as one, when it can't: every call that makes it has to be one Truss edits (ADR 0012). */
function readOnlyOf(mine: readonly CallFacts[]): string | undefined {
  const primaries = mine.filter((c) => c.role === 'primary');
  if (primaries.length === 0) return READ_ONLY;
  return primaries.find((c) => !c.editable)?.reason ?? undefined;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The Connections and the unplaced ends that the synthesized app adds to the Nodes on screen. */
export interface Connections {
  edges: ConnectionEdge[];
  /** By Node, what has no Node at its other end. */
  other: Map<string, { permissions: EffectView[]; integrations: EffectView[] }>;
}

/**
 * Rolls the effects of the synthesized app (ADR 0012) up to the Nodes on screen. An end is the nearest Node above the
 * construct it names, or an External Node whose name or ARN the end spells out. There is one edge per (kind, source Node,
 * target Node), carrying every effect. An effect with an end that is no Node, or that starts and ends at one Node, is
 * listed on the Node that owns it instead. A reference across Stacks is a read-only Reference edge, unless the code's own
 * References (`existing`) already draw one between the same Nodes.
 */
export function connectionsOf(
  assembly: Assembly,
  facts: Facts,
  nodes: readonly ConnectableNode[],
  existing: readonly Pick<ConnectionEdge, 'from' | 'to'>[],
): Connections {
  const ids = new Set(nodes.map((n) => n.id));
  const label = new Map(nodes.map((n) => [n.id, n.label]));
  const unitOf = (path: string): string | undefined => {
    for (let at = path.length; at > 0; at = path.lastIndexOf('/', at - 1)) {
      const prefix = path.slice(0, at);
      if (ids.has(prefix)) return prefix;
    }
    return undefined;
  };
  const externals = nodes.flatMap((n) =>
    (facts.nodes[n.id]?.identifiers ?? []).map((name) => ({
      id: n.id,
      pattern: new RegExp(`(^|[:/])${escapeRegExp(name)}($|[/:*])`),
    })),
  );
  const endNodes = (end: EffectEnd): string[] => {
    const found = [...new Set(end.paths.flatMap((p) => unitOf(p) ?? []))];
    return found.length > 0 ? found : [...new Set(externals.filter((x) => x.pattern.test(end.text)).map((x) => x.id))];
  };
  const pretty = (end: EffectEnd): string => {
    const text = end.text.replace(
      /\{([^}]+)\}/g,
      (_, path: string) => label.get(unitOf(path) ?? '') ?? path.split('/').slice(-2).join('/'),
    );
    return text === '' ? 'nothing' : text;
  };

  const edges = new Map<string, { kind: Kind; from: string; to: string; effects: EffectView[] }>();
  const other = new Map<string, { permissions: EffectView[]; integrations: EffectView[] }>();
  const listOn = (owner: string, effect: Effect, view: EffectView) => {
    const lists = other.get(owner) ?? other.set(owner, { permissions: [], integrations: [] }).get(owner)!;
    // A security group rule is a permission to whoever reads the Node: it lets traffic in or out.
    (effect.kind === 'integration' ? lists.integrations : lists.permissions).push(view);
  };

  for (const effect of assembly.effects ?? []) {
    const sources = endNodes(effect.source);
    const targets = endNodes(effect.target);
    const view: EffectView = {
      detail: effect.detail,
      summary: `${effect.detail} · ${pretty(effect.source)} → ${pretty(effect.target)}`,
      at: effect.at,
    };
    const pairs = sources.flatMap((from) => targets.filter((to) => to !== from).map((to) => [from, to] as const));
    if (pairs.length === 0) {
      const owner = sources[0] ?? unitOf(effect.at) ?? targets[0];
      if (owner !== undefined) listOn(owner, effect, view);
      continue;
    }
    for (const [from, to] of pairs) {
      const key = `${effect.kind}\0${from}\0${to}`;
      (edges.get(key) ?? edges.set(key, { kind: effect.kind, from, to, effects: [] }).get(key)!).effects.push(view);
    }
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const calls = new Map<string, CallFacts[]>();
  for (const c of facts.calls ?? []) {
    if (!ids.has(c.from) || !ids.has(c.to) || c.from === c.to) continue;
    const key = `${c.kind}\0${c.from}\0${c.to}`;
    (calls.get(key) ?? calls.set(key, []).get(key)!).push(c);
  }
  const out: ConnectionEdge[] = [...edges.values()].map(({ kind, from, to, effects }) => {
    const mine = calls.get(`${kind}\0${from}\0${to}`) ?? [];
    calls.delete(`${kind}\0${from}\0${to}`);
    const primary = mine.find((c) => c.role === 'primary');
    const source = primary?.span
      ? { file: primary.span.file, line: primary.span.start.line, col: primary.span.start.col }
      : (nodeById.get(from)?.source ?? nodeById.get(to)?.source);
    const [one, many] = NOUN[kind];
    const lock = readOnlyOf(mine);
    return {
      id: `${kind}:${from}->${to}`,
      kind,
      from,
      to,
      prop: effects.length === 1 ? effects[0]!.detail : `${effects.length} ${many}`,
      text: effects.length === 1 ? effects[0]!.summary : `${effects.length} ${effects.length === 1 ? one : many}`,
      ...(lock !== undefined ? { readOnly: lock } : {}),
      fromSynth: true as const,
      ...(source ? { source } : {}),
      effects,
      ...(mine.length > 0 ? { calls: mine.map(callView) } : {}),
    };
  });
  // A call that makes a Connection synth shows nothing of (a route to a Function, an origin) is an edge of its own.
  for (const mine of calls.values()) {
    const primary = mine.find((c) => c.role === 'primary');
    if (!primary) continue;
    const lock = readOnlyOf(mine);
    out.push({
      id: `${primary.kind}:${primary.from}->${primary.to}`,
      kind: primary.kind,
      from: primary.from,
      to: primary.to,
      prop: primary.method.join('.'),
      text: primary.text,
      ...(lock !== undefined ? { readOnly: lock } : {}),
      source: { file: primary.span.file, line: primary.span.start.line, col: primary.span.start.col },
      calls: mine.map(callView),
    });
  }

  const drawn = new Set(existing.map((e) => `${e.from}\0${e.to}`));
  for (const r of assembly.importRefs ?? []) {
    const from = unitOf(r.from);
    const to = unitOf(r.to);
    if (from === undefined || to === undefined || from === to || drawn.has(`${from}\0${to}`)) continue;
    const id = `${from}->${to}:${r.prop}`;
    if (out.some((e) => e.id === id)) continue;
    const source = nodeById.get(from)?.source;
    out.push({
      id,
      kind: 'reference',
      from,
      to,
      prop: r.prop,
      text: 'Fn::ImportValue',
      readOnly: CROSS_STACK,
      fromSynth: true,
      ...(source ? { source } : {}),
    });
  }
  return { edges: out, other };
}
