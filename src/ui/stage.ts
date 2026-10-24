import type { StageView, View } from '../core/view.ts';

const KEY = 'truss.stage';

type Memory = Pick<Storage, 'getItem' | 'setItem'>;

/** The browser's storage, or nothing where the browser won't hand it out. */
function browserStorage(): Memory | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The Stage picked last time, from this browser only: it is a preference, not part of the Design. */
export function rememberedStage(storage: Memory | undefined = browserStorage()): string | undefined {
  try {
    return storage?.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberStage(id: string, storage: Memory | undefined = browserStorage()): void {
  try {
    storage?.setItem(KEY, id);
  } catch {
    // Not remembering is fine.
  }
}

/** The Stage to show: the remembered one if the app still has it, else the first the app creates. */
export function chooseStage(stages: readonly StageView[], remembered: string | undefined): string | undefined {
  return stages.find((s) => s.id === remembered)?.id ?? stages[0]?.id;
}

/** The View with only the chosen Stage's Stacks and the Stacks outside every Stage, and the Nodes in them, with the edges between those. */
export function showStage(view: View, stageId: string | undefined): View {
  const stacks = view.stacks.filter((s) => s.stageId === undefined || s.stageId === stageId);
  const shown = new Set(stacks.map((s) => s.id));
  const nodes = view.nodes.filter((n) => shown.has(n.stackId));
  const ids = new Set(nodes.map((n) => n.id));
  return { ...view, stacks, nodes, edges: view.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}
