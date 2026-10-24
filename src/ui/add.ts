import type { PropValue } from '../core/intents.ts';
import type { WrittenValue } from '../core/panel.ts';
import type { StackBoxView } from '../core/view.ts';

/** The Stack a click on a palette entry adds to: the Stack open in the panel, else the Stack of the selected Node, else the only Stack there is. */
export function addScopeOf(
  stacks: readonly Pick<StackBoxView, 'id'>[],
  open: string | undefined,
  selectedNodeStack: string | undefined,
): string | undefined {
  if (open && stacks.some((s) => s.id === open)) return open;
  if (selectedNodeStack && stacks.some((s) => s.id === selectedNodeStack)) return selectedNodeStack;
  return stacks.length === 1 ? stacks[0]!.id : undefined;
}

/** The construct path of the Stack box whose canvas id is `canvasId`, if it is one. */
export const stackPathOf = (canvasId: string | undefined): string | undefined =>
  canvasId?.startsWith('stack:') ? canvasId.slice('stack:'.length) : undefined;

/** What the code would have for a value the form holds, so the inputs of the panel can show it. */
export function writtenOf(value: PropValue): WrittenValue {
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return { kind: 'literal', value: value.value, text: String(value.value) };
    case 'enum':
      return {
        kind: 'expression',
        text: `${value.type.split('.').at(-1)}.${value.member}`,
        member: { type: value.type.split('.').at(-1)!, name: value.member },
      };
    case 'duration':
    case 'size': {
      const type = value.kind === 'duration' ? 'Duration' : 'Size';
      return {
        kind: 'expression',
        text: `${type}.${value.unit}(${value.amount})`,
        quantity: { type, unit: value.unit, amount: value.amount },
      };
    }
  }
}
