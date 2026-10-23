/** Below this zoom a Node's name is too small to read, so the Node is drawn as its icon alone. */
const NAME_MIN_ZOOM = 0.6;

export function namesShownAt(zoom: number): boolean {
  return zoom >= NAME_MIN_ZOOM;
}
