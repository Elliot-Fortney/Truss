import type { PanelView } from '../core/panel.ts';

/** A literal prop's value as the panel shows it: what it evaluates to, not how it was quoted. */
export const literalText = (value: string | number | boolean | null): string => (value === '' ? '""' : String(value));

/** What a prop the panel can't see a value for says: unset when the props are written out, otherwise left to the variable they come from. */
export const unsetText = (panel: Pick<PanelView, 'propsSource'>): string => (panel.propsSource === undefined ? 'not set' : `see ${panel.propsSource}`);

/** Why the panel's props can't be edited as a whole, when the code passes them as a variable or a call. */
export function propsNotice(panel: Pick<PanelView, 'propsSource'>): string | undefined {
  return panel.propsSource === undefined ? undefined : `Props are passed as ${panel.propsSource}, so Truss shows every prop read-only.`;
}

/** The toggle for the props kept on demand. */
export const moreLabel = (count: number, open: boolean): string => `${open ? 'Hide' : 'Show'} ${count} more ${count === 1 ? 'prop' : 'props'}`;
