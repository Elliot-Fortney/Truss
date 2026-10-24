import type { TreeNode } from './assembly.ts';
import { constructIdProblem, siblingIds } from './construct-id.ts';
import { entryFor, type Catalog, type CatalogProp } from './catalog.ts';
import type { NodeFacts } from './facts.ts';
import type { AddedProp, AddNodeIntent, DuplicateIntent, PropValue, RemoveNodeIntent } from './intents.ts';
import { valueFits, type PanelView } from './panel.ts';

/** The Construct ID for a new construct named `base`: `base` itself when it is free, else `base` without any number it ends in, then 2, 3 and so on. */
export function freshId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base) && constructIdProblem(base, taken) === undefined) return base;
  const stem = base.replace(/\d+$/, '') || base;
  for (let n = 2; ; n++) {
    const id = `${stem}${n}`;
    if (constructIdProblem(id, taken) === undefined) return id;
  }
}

/** The IDs of the constructs directly under `path`. */
const childIds = (tree: TreeNode, path: string): string[] => siblingIds(tree, `${path}/-`);

export type AddOutcome =
  | { ok: true; intent: AddNodeIntent }
  /** Props the construct needs and Truss has no value for: the user is asked before anything is staged. */
  | { ok: false; form: CatalogProp[] }
  | { ok: false; reason: string };

/**
 * What dropping the construct `fqn` on the Stack at `scope` means for the Draft: required props come from the
 * Overlay's defaults, then from `given`; a construct that still lacks some gets a form first.
 */
export function intentForAdd(
  catalog: Catalog | undefined,
  fqn: string,
  scope: { id: string; facts: NodeFacts | undefined; tree: TreeNode },
  given: Readonly<Record<string, PropValue>>,
): AddOutcome {
  const entry = catalog && entryFor(catalog, fqn);
  if (!entry) return { ok: false, reason: `${fqn} is not in the Catalog` };
  if (!scope.facts) return { ok: false, reason: `Truss found no code for the Stack ${scope.id}` };
  const props: AddedProp[] = [];
  const missing: CatalogProp[] = [];
  for (const prop of entry.props.filter((p) => p.required)) {
    const snippet = entry.overlay?.defaults[prop.name];
    const value = given[prop.name];
    if (value !== undefined && prop.input && valueFits(prop.input, value)) props.push({ name: prop.name, value });
    else if (snippet) props.push({ name: prop.name, snippet });
    else missing.push(prop);
  }
  const unfillable = missing.filter((p) => !p.input || p.input.kind === 'struct');
  if (unfillable.length > 0) return { ok: false, reason: `${entry.name} needs ${unfillable.map((p) => p.name).join(', ')}, which Truss can't write a value for yet. Add it in your code.` };
  if (missing.length > 0) return { ok: false, form: missing };
  const id = freshId(entry.name, childIds(scope.tree, scope.id));
  return { ok: true, intent: { type: 'addNode', path: scope.id, expect: { className: scope.facts.className, literalId: scope.facts.literalId ?? '' }, fqn, id, props } };
}

/** What copying the Node whose panel this is means for the Draft. */
export function intentForDuplicate(panel: PanelView | undefined, id: string): { ok: true; intent: DuplicateIntent } | { ok: false; reason: string } {
  if (!panel || panel.kind !== 'node') return { ok: false, reason: `No Node at ${id}` };
  if (panel.readOnly) return { ok: false, reason: panel.readOnly };
  if (!panel.idEdit || panel.literalId === undefined) return { ok: false, reason: `${id} can't be duplicated here` };
  const newId = freshId(panel.literalId, [...panel.idEdit.siblings, panel.literalId]);
  return { ok: true, intent: { type: 'duplicate', path: id, expect: { className: panel.className, literalId: panel.literalId }, newId } };
}

/** What deleting the Node whose panel this is means for the Draft. */
export function intentForRemove(panel: PanelView | undefined, id: string): { ok: true; intent: RemoveNodeIntent } | { ok: false; reason: string } {
  if (!panel || panel.kind !== 'node') return { ok: false, reason: `No Node at ${id}` };
  if (panel.readOnly) return { ok: false, reason: panel.readOnly };
  if (!panel.idEdit || panel.literalId === undefined) return { ok: false, reason: `${id} can't be removed here` };
  return { ok: true, intent: { type: 'removeNode', path: id, expect: { className: panel.className, literalId: panel.literalId } } };
}
