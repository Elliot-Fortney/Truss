import type { ConnectCheck, ConnectOption } from '../core/connect.ts';
import type { EdgeView } from '../core/view.ts';

/** What a drag from a Node answered, for every other Node: asked when the drag starts, and good until it ends. */
export type Targets = Readonly<Record<string, ConnectCheck>>;

/** What dropping on a Node comes to. */
export type Drop =
  /** Turned away: the reason goes in a tooltip at the drop. */
  | { kind: 'refused'; reason: string }
  /** Stage it: one prop takes the Node. */
  | { kind: 'connect'; prop: string }
  /** The prop points at another Node: ask before replacing it. */
  | { kind: 'replace'; prop: string; current: string }
  /** Several props take the Node: ask which. */
  | { kind: 'choose'; options: readonly ConnectOption[] };

/** What a drop on the Node `to` comes to, given what the drag was told. */
export function dropOn(targets: Targets | undefined, to: string | undefined): Drop {
  if (!targets) return { kind: 'refused', reason: 'Truss is still working out where this can connect. Try again in a moment.' };
  if (to === undefined) return { kind: 'refused', reason: 'Drop on a Node to connect to it.' };
  const check = targets[to];
  if (!check) return { kind: 'refused', reason: 'A Node can’t connect to itself.' };
  if (!check.ok) return { kind: 'refused', reason: check.reason };
  const [only, ...more] = check.options;
  if (!only) return { kind: 'refused', reason: 'Nothing here takes it.' };
  if (more.length > 0) return { kind: 'choose', options: check.options };
  return only.replaces ? { kind: 'replace', prop: only.prop, current: only.replaces.label } : { kind: 'connect', prop: only.prop };
}

/** Whether the drag can end on `id`, which the canvas dims the Nodes that can't for. The Node the drag started from takes no part. */
export function dimmed(targets: Targets | undefined, id: string, from: string | undefined): boolean {
  return targets !== undefined && id !== from && targets[id]?.ok !== true;
}

/** Whether an end of the Reference in `prop` can be moved to `to`. */
export function canRepoint(targets: Targets | undefined, to: string, prop: string): boolean {
  const check = targets?.[to];
  return check?.ok === true && check.options.some((o) => o.prop === prop);
}

/** An edge's name for the canvas, e.g. `vpc` or `securityGroups[1]`. */
export const edgeLabel = (e: Pick<EdgeView, 'prop' | 'index'>): string => (e.index === undefined ? e.prop : `${e.prop}[${e.index}]`);

/** What an edge says when pointed at, and what it is, for a screen reader. */
export function edgeTitle(e: EdgeView, names: ReadonlyMap<string, string>): string {
  const from = names.get(e.from) ?? e.from;
  const to = names.get(e.to) ?? e.to;
  return `${from}.${edgeLabel(e)} → ${to}${e.readOnly ? ` (read-only: ${e.readOnly})` : ''}`;
}
