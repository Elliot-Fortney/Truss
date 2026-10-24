import type { TreeNode } from './assembly.ts';
import { constructIdProblem, siblingIds } from './construct-id.ts';
import { entryFor, type Catalog, type CatalogEntry, type CatalogProp, type PropInput } from './catalog.ts';
import { canConnect, type ConnectContext } from './connect.ts';
import { nodeEditability } from './editability.ts';
import type { Facts, NodeFacts, PropFacts } from './facts.ts';
import { withIntents, type Intent, type PropValue } from './intents.ts';
import type { EffectView, ViewBody } from './view.ts';

/**
 * What the code gives a prop. A literal is a value Truss can show as such, and so is an object literal, a
 * `Type.MEMBER` and a `Duration.seconds(30)`; any other expression is source text it won't touch.
 */
export type WrittenValue =
  | { kind: 'literal'; value: string | number | boolean | null; text: string }
  | { kind: 'expression'; text: string; member?: { type: string; name: string }; quantity?: { type: 'Duration' | 'Size'; unit: string; amount: number } }
  | { kind: 'object'; text: string; fields: Array<{ name: string; written: WrittenValue }> };

/** For a prop that takes Nodes (a Reference), what it points at and what it could. */
export interface PropNodesView {
  /** The prop takes several Nodes, in order; otherwise one. */
  many: boolean;
  /** What the code points it at now, in order. */
  current: Array<{ id: string; label: string; readOnly?: string }>;
  /** The Nodes of the Design it could point at, besides those it does. */
  choices: Array<{ id: string; label: string }>;
}

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
  /** What to edit the prop with. Absent when Truss won't write it: the panel is read-only, the type has no input, or the code gives the prop something Truss can't edit. */
  input?: PropInput;
  /** The Node picker, for a prop that takes Nodes and can be edited. The same value a drag on the canvas edits. */
  nodes?: PropNodesView;
}

/** What the panel shows for one Node or Stack. */
export interface PanelView {
  /** The construct path. */
  id: string;
  kind: 'node' | 'stack';
  /** The Construct ID as the code writes it; a change to the prop is only made where it still matches. */
  literalId?: string;
  /** Present when the Construct ID can be changed: the IDs of its siblings, which it can't take. */
  idEdit?: { siblings: string[] };
  /** Why no prop here can be edited, when none can. Absent: the props with an `input` can. */
  readOnly?: string;
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
  /** Permissions and network rules of this Node with no Node at the other end (ADR 0012). Read-only. */
  otherPermissions?: EffectView[];
  /** Triggers and subscriptions of this Node with no Node at the other end. Read-only. */
  otherIntegrations?: EffectView[];
  /** What Truss found on this construct, of every severity: info shows nowhere else. */
  problems?: Array<{ severity: 'error' | 'warning' | 'info'; message: string; draft: boolean }>;
}

const sourceOf = ({ span }: NodeFacts) => ({ file: span.file, line: span.start.line, col: span.start.col });

function writtenOf(p: PropFacts): WrittenValue {
  if (p.kind === 'literal' && p.value !== undefined) return { kind: 'literal', value: p.value, text: p.text };
  if (p.kind === 'object' && p.fields) return { kind: 'object', text: p.text, fields: p.fields.map((f) => ({ name: f.name, written: writtenOf(f) })) };
  return { kind: 'expression', text: p.text, ...(p.member ? { member: p.member } : {}), ...(p.quantity ? { quantity: p.quantity } : {}) };
}

/** Whether what the code gives a prop is something its input can show and replace. */
export function editableAs(input: PropInput, written: WrittenValue | undefined): boolean {
  if (!written) return true;
  switch (input.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return written.kind === 'literal' && typeof written.value === input.kind;
    case 'enum':
      return written.kind === 'expression' && written.member !== undefined && input.fqn.endsWith(`.${written.member.type}`);
    case 'duration':
    case 'size':
      return written.kind === 'expression' && written.quantity?.type === (input.kind === 'duration' ? 'Duration' : 'Size');
    case 'struct':
      return written.kind === 'object';
  }
}

function rowOf(prop: CatalogProp, featured: boolean, written: PropFacts | undefined, editing: boolean, nodes?: PropNodesView): PropRowView {
  const value = written && writtenOf(written);
  return {
    name: prop.name,
    type: prop.type,
    ...(prop.summary ? { summary: prop.summary } : {}),
    ...(prop.default ? { default: prop.default } : {}),
    ...(prop.required ? { required: true as const } : {}),
    ...(featured ? { featured: true as const } : {}),
    ...(value ? { written: value } : {}),
    ...(editing && prop.input && editableAs(prop.input, value) ? { input: prop.input } : {}),
    ...(editing && nodes ? { nodes } : {}),
  };
}

/** The props `StackProps` offers that a Stack's header panel edits. The Catalog has no entry for a Stack, because a Stack is a box and never a Node. */
const STACK_PROPS: CatalogProp[] = [
  {
    name: 'env',
    type: 'Environment',
    required: false,
    input: {
      kind: 'struct',
      fields: [
        { name: 'account', type: 'string', required: false, input: { kind: 'string' }, summary: 'The AWS account ID for this environment.' },
        { name: 'region', type: 'string', required: false, input: { kind: 'string' }, summary: 'The AWS region for this environment.' },
      ],
    },
    summary: 'The AWS environment (account/region) where this stack will be deployed.',
    default: "- The environment of the containing Stage if available, otherwise create the stack will be environment-agnostic.",
  },
  { name: 'terminationProtection', type: 'boolean', required: false, input: { kind: 'boolean' }, summary: 'Whether to enable termination protection for this stack.', default: 'false' },
  { name: 'description', type: 'string', required: false, input: { kind: 'string' }, summary: 'A description of the stack.', default: '- No description.' },
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
function rowsOf(described: Described | undefined, props: readonly PropFacts[], editing: boolean, nodesFor: (prop: CatalogProp) => PropNodesView | undefined): { rows: PropRowView[]; more: PropRowView[] } {
  const written = new Map(props.map((p) => [p.name, p]));
  const rows: PropRowView[] = [];
  const more: PropRowView[] = [];
  const known = new Set<string>();
  for (const p of described?.first ?? []) {
    known.add(p.name);
    rows.push(rowOf(p, described!.featured.has(p.name), written.get(p.name), editing, nodesFor(p)));
  }
  for (const p of described?.rest ?? []) {
    known.add(p.name);
    (written.has(p.name) ? rows : more).push(rowOf(p, false, written.get(p.name), editing, nodesFor(p)));
  }
  for (const p of props) if (!known.has(p.name)) rows.push({ name: p.name, written: writtenOf(p) });
  return { rows, more };
}

const classNamed = (written: string) => written.split('.').at(-1);

/** What the panel needs to offer edits: the Draft, so a staged value shows before synth has caught up, and whether editing is paused. */
export interface PanelEditing {
  intents: readonly Intent[];
  /** The construct tree of the Design on screen, which the Construct ID's siblings are read from. */
  tree?: TreeNode;
  /** Why the Draft can't take an edit at the moment, when it can't: the app can't be synthed with a Draft, or doesn't synth. */
  blocked?: string;
  /** The paths of the constructs the Draft adds, which have no code on disk to edit until it is saved. */
  added?: ReadonlySet<string>;
}

const sameSpan = (a: NodeFacts, b: NodeFacts) => a.span.file === b.span.file && a.span.start.line === b.span.start.line && a.span.start.col === b.span.start.col;

/**
 * The property panel of the Node or Stack at `id`: its props from the Catalog, with what the app's code
 * says about each. A construct the Catalog can't describe, such as a class of the app's own, shows only
 * the props as written. Undefined when there is no such Node or Stack. Given `editing`, a prop Truss can
 * write comes with its `input`; without it, or when the Node is locked, every prop is read-only.
 */
export function buildPanel(id: string, view: ViewBody, facts: Facts, catalog: Catalog | undefined, editing?: PanelEditing): PanelView | undefined {
  const node = view.nodes.find((n) => n.id === id);
  const isStack = !node && view.stacks.some((s) => s.id === id);
  if (!node && !isStack) return undefined;
  const nodeFacts = facts.nodes[id];
  // A subclass of a CDK construct takes props of its own, so the parent's are only used when the code names the parent's class.
  const entry = node && nodeFacts && catalog ? entryFor(catalog, node.fqn) : undefined;
  const described = isStack ? { first: STACK_PROPS, rest: [], featured: new Set<string>() } : entry && nodeFacts && classNamed(nodeFacts.className) === entry.name ? describeEntry(entry) : undefined;

  const lock = node ? node.lock : nodeFacts ? errorOf(nodeEditability(id, nodeFacts)) : 'Truss found no code for this Stack';
  const readOnly = !editing ? undefined : editing.added?.has(id) ? ADDED_NOTICE : lock !== undefined ? lock : nodeFacts?.props?.form === 'other' ? propsNotice(nodeFacts.props.text) : editing.blocked;
  // The Draft's edits to this construct, and to any other made by the same `new`: a Stack or Stage class created more than once.
  const mine = nodeFacts && editing ? editing.intents.filter((i) => facts.nodes[i.path] && sameSpan(facts.nodes[i.path]!, nodeFacts)) : [];
  const props = withIntents(nodeFacts?.props, mine);
  const nodesFor = (prop: CatalogProp) => (node && editing && readOnly === undefined && prop.accepts ? nodesOf(id, prop, { view, facts, catalog, ...(editing.blocked ? { blocked: editing.blocked } : {}), ...(editing.added ? { added: editing.added } : {}) }) : undefined);
  const { rows, more } = rowsOf(described, props?.form === 'object' ? props.props : [], editing !== undefined && readOnly === undefined, nodesFor);
  return {
    id,
    kind: isStack ? 'stack' : 'node',
    className: nodeFacts?.className ?? node?.subtitle ?? '',
    ...(nodeFacts?.literalId !== undefined ? { literalId: nodeFacts.literalId } : {}),
    ...(readOnly !== undefined ? { readOnly } : {}),
    ...(editing?.tree && readOnly === undefined && nodeFacts?.literalId !== undefined && nodeFacts.pathsOnSpan === 1 ? { idEdit: { siblings: siblingIds(editing.tree, id) } } : {}),
    ...(described && entry?.summary ? { summary: entry.summary } : {}),
    rows,
    more,
    ...(nodeFacts?.props?.form === 'other' ? { propsSource: nodeFacts.props.text } : {}),
    ...(nodeFacts ? { source: sourceOf(nodeFacts) } : {}),
    ...(node?.otherPermissions ? { otherPermissions: node.otherPermissions } : {}),
    ...(node?.otherIntegrations ? { otherIntegrations: node.otherIntegrations } : {}),
  };
}

/** The Node picker of a prop that takes Nodes. Absent when the code gives the prop something the picker can't show and replace. */
function nodesOf(id: string, prop: CatalogProp, ctx: ConnectContext): PropNodesView | undefined {
  const label = (path: string) => ctx.view.nodes.find((n) => n.id === path)?.label ?? path.split('/').at(-1)!;
  const refs = (ctx.facts.references ?? []).filter((r) => r.from === id && r.prop === prop.name).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const written = ctx.facts.nodes[id]?.props;
  const writtenAs = written?.form === 'object' ? written.props.find((p) => p.name === prop.name) : undefined;
  // Written as something that isn't a Node (a parameter, a call), or as a list with more in it than Nodes: the picker has nothing to show.
  if (writtenAs && refs.length === 0 && !/^\[\s*\]$/.test(writtenAs.text.trim())) return undefined;
  const many = prop.accepts?.many === true;
  const choices = ctx.view.nodes.flatMap((n) => {
    if (n.id === id || refs.some((r) => r.to === n.id)) return [];
    const check = canConnect(ctx, id, n.id);
    return check.ok && check.options.some((o) => o.prop === prop.name) ? [{ id: n.id, label: n.label }] : [];
  });
  return { many, current: refs.map((r) => ({ id: r.to, label: label(r.to), ...(r.editable ? {} : { readOnly: r.reason ?? 'Truss leaves this alone' }) })), choices };
}

const errorOf = (e: ReturnType<typeof nodeEditability>) => (e.editable ? undefined : e.reason);
const ADDED_NOTICE = 'Added in the Draft: save it to edit it.';
const propsNotice = (text: string) => `Props are passed as ${text}, so Truss shows every prop read-only.`;

/**
 * The input a prop of the panel is edited with, following `prop` into the fields of object-literal props.
 * Undefined when the panel doesn't offer one: a field the code doesn't write as an object Truss can edit, or no such prop.
 */
export function inputFor(panel: PanelView, prop: readonly string[]): PropInput | undefined {
  const [name, ...rest] = prop;
  const row = [...panel.rows, ...panel.more].find((r) => r.name === name);
  let input = row?.input;
  let written = row?.written;
  for (const field of rest) {
    if (input?.kind !== 'struct') return undefined;
    const declared = input.fields.find((f) => f.name === field);
    written = written?.kind === 'object' ? written.fields.find((f) => f.name === field)?.written : undefined;
    input = declared?.input && editableAs(declared.input, written) ? declared.input : undefined;
  }
  return input;
}

/** Whether `value` is one the `input` takes. */
export const valueFits = (input: PropInput, value: PropValue): boolean =>
  input.kind === value.kind && (input.kind !== 'enum' || (value.kind === 'enum' && value.type === input.fqn && input.members.includes(value.member)));

/**
 * What a panel edit means for the Draft: the intent to stage, or why the edit is refused. The panel is the one the user edited in,
 * so a prop it offers no input for, or a value its input doesn't take, is turned away here and never reaches the code.
 */
export function intentForEdit(
  panel: PanelView | undefined,
  id: string,
  prop: string[],
  value: PropValue,
): { ok: true; intent: Intent } | { ok: false; reason: string } {
  if (!panel) return { ok: false, reason: `No Node or Stack at ${id}` };
  if (panel.readOnly) return { ok: false, reason: panel.readOnly };
  const input = inputFor(panel, prop);
  const named = prop.join('.');
  if (!input) return { ok: false, reason: `${named} can't be edited here` };
  if (!valueFits(input, value)) return { ok: false, reason: `${named} takes a ${input.kind}, not a ${value.kind}` };
  if (panel.literalId === undefined) return { ok: false, reason: `${id} has no Construct ID in the code to edit by` };
  return { ok: true, intent: { type: 'setProp', path: id, expect: { className: panel.className, literalId: panel.literalId }, prop, value } };
}

/** What renaming the Node or Stack means for the Draft: the intent to stage, or why the new Construct ID is refused. */
export function intentForRename(panel: PanelView | undefined, id: string, newId: string): { ok: true; intent: Intent } | { ok: false; reason: string } {
  if (!panel) return { ok: false, reason: `No Node or Stack at ${id}` };
  if (panel.readOnly) return { ok: false, reason: panel.readOnly };
  if (!panel.idEdit || panel.literalId === undefined) return { ok: false, reason: `The Construct ID of ${id} can't be changed here` };
  const problem = constructIdProblem(newId, panel.idEdit.siblings);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, intent: { type: 'renameId', path: id, expect: { className: panel.className, literalId: panel.literalId }, newId } };
}
