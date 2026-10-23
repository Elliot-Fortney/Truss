import type { View } from '../core/view.ts';

/** The server pushes the whole View with a version that only goes up; anything not newer is stale. */
export function applyPush(current: View | undefined, incoming: View): View {
  return current && incoming.version <= current.version ? current : incoming;
}
