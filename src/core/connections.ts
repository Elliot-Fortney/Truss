import type { Assembly, Effect, EffectEnd } from './assembly.ts';
import type { Facts } from './facts.ts';

/** One thing the synthesized app grants, triggers or opens (ADR 0012), as the panel lists it. */
export interface EffectView {
  /** What it says in a few words: `s3:GetObject`, `event source mapping`, `tcp 5432`. */
  detail: string;
  /** The whole of it with both ends, e.g. `s3:GetObject · Fn → *`. */
  summary: string;
  /** The construct path of the resource that carries it, e.g. a policy. */
  at: string;
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
  readOnly: string;
  /** Read from what synth produced, not written in the code. */
  fromSynth: true;
  source?: { file: string; line: number; col: number };
  effects?: EffectView[];
}

type Kind = 'grant' | 'integration' | 'network';

const READ_ONLY = 'Truss reads this from what the app synthesizes and does not edit it yet';
const CROSS_STACK = "It reads another Stack's export through Fn::ImportValue, which Truss does not edit";

const NOUN: Record<Kind, [string, string]> = { grant: ['permission', 'permissions'], integration: ['trigger', 'triggers'], network: ['rule', 'rules'] };

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
export function connectionsOf(assembly: Assembly, facts: Facts, nodes: readonly ConnectableNode[], existing: readonly Pick<ConnectionEdge, 'from' | 'to'>[]): Connections {
  const ids = new Set(nodes.map((n) => n.id));
  const label = new Map(nodes.map((n) => [n.id, n.label]));
  const unitOf = (path: string): string | undefined => {
    for (let at = path.length; at > 0; at = path.lastIndexOf('/', at - 1)) {
      const prefix = path.slice(0, at);
      if (ids.has(prefix)) return prefix;
    }
    return undefined;
  };
  const externals = nodes.flatMap((n) => (facts.nodes[n.id]?.identifiers ?? []).map((name) => ({ id: n.id, pattern: new RegExp(`(^|[:/])${escapeRegExp(name)}($|[/:*])`) })));
  const endNodes = (end: EffectEnd): string[] => {
    const found = [...new Set(end.paths.flatMap((p) => unitOf(p) ?? []))];
    return found.length > 0 ? found : [...new Set(externals.filter((x) => x.pattern.test(end.text)).map((x) => x.id))];
  };
  const pretty = (end: EffectEnd): string => {
    const text = end.text.replace(/\{([^}]+)\}/g, (_, path: string) => label.get(unitOf(path) ?? '') ?? path.split('/').slice(-2).join('/'));
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
    const view: EffectView = { detail: effect.detail, summary: `${effect.detail} · ${pretty(effect.source)} → ${pretty(effect.target)}`, at: effect.at };
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
  const out: ConnectionEdge[] = [...edges.values()].map(({ kind, from, to, effects }) => {
    const source = nodeById.get(from)?.source ?? nodeById.get(to)?.source;
    const [one, many] = NOUN[kind];
    return {
      id: `${kind}:${from}->${to}`,
      kind,
      from,
      to,
      prop: effects.length === 1 ? effects[0]!.detail : `${effects.length} ${many}`,
      text: effects.length === 1 ? effects[0]!.summary : `${effects.length} ${effects.length === 1 ? one : many}`,
      readOnly: READ_ONLY,
      fromSynth: true as const,
      ...(source ? { source } : {}),
      effects,
    };
  });

  const drawn = new Set(existing.map((e) => `${e.from}\0${e.to}`));
  for (const r of assembly.importRefs ?? []) {
    const from = unitOf(r.from);
    const to = unitOf(r.to);
    if (from === undefined || to === undefined || from === to || drawn.has(`${from}\0${to}`)) continue;
    const id = `${from}->${to}:${r.prop}`;
    if (out.some((e) => e.id === id)) continue;
    const source = nodeById.get(from)?.source;
    out.push({ id, kind: 'reference', from, to, prop: r.prop, text: 'Fn::ImportValue', readOnly: CROSS_STACK, fromSynth: true, ...(source ? { source } : {}) });
  }
  return { edges: out, other };
}
