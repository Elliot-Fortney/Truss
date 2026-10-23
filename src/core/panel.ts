import { entryFor, type Catalog, type CatalogEntry, type CatalogProp } from './catalog.ts';
import type { Facts, NodeFacts, PropFacts } from './facts.ts';
import type { ViewBody } from './view.ts';

/** What the code gives a prop. A literal is a value Truss can show as such; anything else is source text it won't touch. */
export type WrittenValue = { kind: 'literal'; value: string | number | boolean | null; text: string } | { kind: 'expression'; text: string };

export interface PropRowView {
  name: string;
  /** The type as TypeScript writes it. Absent for a prop the Catalog doesn't describe. */
  type?: string;
  /** The docs summary. */
  summary?: string;
  /** The CDK default, as the docs word it. Display text only. */
  default?: string;
  required?: true;
  featured?: true;
  /** Absent when the code doesn't pass the prop. */
  written?: WrittenValue;
}

/** What the panel shows for one Node or Stack. */
export interface PanelView {
  /** The construct path. */
  id: string;
  kind: 'node' | 'stack';
  /** The class as written in the code, e.g. `s3.Bucket`. */
  className: string;
  /** The construct's docs summary. */
  summary?: string;
  /** The props shown first: required, featured, and any the code sets. */
  rows: PropRowView[];
  /** Every other prop, for the panel to disclose on demand. */
  more: PropRowView[];
  /** Set when the props are passed as a variable or a call: Truss can't tell prop by prop, so every prop is read-only. */
  propsSource?: string;
  source?: { file: string; line: number; col: number };
}

const sourceOf = ({ span }: NodeFacts) => ({ file: span.file, line: span.start.line, col: span.start.col });

const writtenOf = (p: PropFacts): WrittenValue =>
  p.kind === 'literal' && p.value !== undefined ? { kind: 'literal', value: p.value, text: p.text } : { kind: 'expression', text: p.text };

function rowOf(prop: CatalogProp, featured: boolean, written: PropFacts | undefined): PropRowView {
  return {
    name: prop.name,
    type: prop.type,
    ...(prop.summary ? { summary: prop.summary } : {}),
    ...(prop.default ? { default: prop.default } : {}),
    ...(prop.required ? { required: true as const } : {}),
    ...(featured ? { featured: true as const } : {}),
    ...(written ? { written: writtenOf(written) } : {}),
  };
}

/** The props `StackProps` offers that a Stack's header panel edits. The Catalog has no entry for a Stack, because a Stack is a box and never a Node. */
const STACK_PROPS: CatalogProp[] = [
  {
    name: 'env',
    type: 'Environment',
    required: false,
    summary: 'The AWS environment (account/region) where this stack will be deployed.',
    default: "- The environment of the containing Stage if available, otherwise create the stack will be environment-agnostic.",
  },
  { name: 'terminationProtection', type: 'boolean', required: false, summary: 'Whether to enable termination protection for this stack.', default: 'false' },
  { name: 'description', type: 'string', required: false, summary: 'A description of the stack.', default: '- No description.' },
];

/** Which props a construct has, split into those the panel shows first and those it discloses on demand. */
interface Described {
  first: CatalogProp[];
  rest: CatalogProp[];
  featured: ReadonlySet<string>;
}

function describeEntry(entry: CatalogEntry): Described {
  const byName = new Map(entry.props.map((p) => [p.name, p]));
  const featuredProps = entry.overlay?.featuredProps ?? [];
  const first = [...entry.props.filter((p) => p.required), ...featuredProps.flatMap((n) => byName.get(n) ?? []).filter((p) => !p.required)];
  const shown = new Set(first.map((p) => p.name));
  return { first, rest: entry.props.filter((p) => !shown.has(p.name)), featured: new Set(featuredProps) };
}

/** The rows for the described props. A prop the code sets is never left on demand, and what is written but not described follows as written. */
function rowsOf(described: Described | undefined, props: readonly PropFacts[]): { rows: PropRowView[]; more: PropRowView[] } {
  const written = new Map(props.map((p) => [p.name, p]));
  const rows: PropRowView[] = [];
  const more: PropRowView[] = [];
  const known = new Set<string>();
  for (const p of described?.first ?? []) {
    known.add(p.name);
    rows.push(rowOf(p, described!.featured.has(p.name), written.get(p.name)));
  }
  for (const p of described?.rest ?? []) {
    known.add(p.name);
    (written.has(p.name) ? rows : more).push(rowOf(p, false, written.get(p.name)));
  }
  for (const p of props) if (!known.has(p.name)) rows.push({ name: p.name, written: writtenOf(p) });
  return { rows, more };
}

const classNamed = (written: string) => written.split('.').at(-1);

/**
 * The property panel of the Node or Stack at `id`: its props from the Catalog, with what the app's code
 * says about each. A construct the Catalog can't describe, such as a class of the app's own, shows only
 * the props as written. Undefined when there is no such Node or Stack.
 */
export function buildPanel(id: string, view: ViewBody, facts: Facts, catalog: Catalog | undefined): PanelView | undefined {
  const node = view.nodes.find((n) => n.id === id);
  const isStack = !node && view.stacks.some((s) => s.id === id);
  if (!node && !isStack) return undefined;
  const nodeFacts = facts.nodes[id];
  // A subclass of a CDK construct takes props of its own, so the parent's are only used when the code names the parent's class.
  const entry = node && nodeFacts && catalog ? entryFor(catalog, node.fqn) : undefined;
  const described = isStack ? { first: STACK_PROPS, rest: [], featured: new Set<string>() } : entry && nodeFacts && classNamed(nodeFacts.className) === entry.name ? describeEntry(entry) : undefined;
  const { rows, more } = rowsOf(described, nodeFacts?.props?.form === 'object' ? nodeFacts.props.props : []);
  return {
    id,
    kind: isStack ? 'stack' : 'node',
    className: nodeFacts?.className ?? node?.subtitle ?? '',
    ...(described && entry?.summary ? { summary: entry.summary } : {}),
    rows,
    more,
    ...(nodeFacts?.props?.form === 'other' ? { propsSource: nodeFacts.props.text } : {}),
    ...(nodeFacts ? { source: sourceOf(nodeFacts) } : {}),
  };
}
