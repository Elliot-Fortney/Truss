import { afterMoves, type Move } from './intents.ts';

/** The file name of the Sidecar, next to `cdk.json`. */
export const SIDECAR_FILE = 'truss.json';

/** A place on the canvas. */
export interface Point {
  x: number;
  y: number;
}

export interface SidecarEntry {
  position?: Point;
  note?: string;
}

/** What code can't express, by construct path. Entries for paths the code no longer has are kept. */
export interface Sidecar {
  nodes: Record<string, SidecarEntry>;
}

export const emptySidecar = (): Sidecar => ({ nodes: {} });

/** One step of the format's history: takes the file's content at version N and returns it as version N + 1. */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/** `MIGRATIONS[i]` takes a file from `formatVersion` i + 1 to i + 2, so the current version is one more than the count. */
export const MIGRATIONS: readonly Migration[] = [];

export const currentFormatVersion = (migrations: readonly Migration[] = MIGRATIONS) => migrations.length + 1;

export type ParsedSidecar = { ok: true; sidecar: Sidecar } | { ok: false; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCoordinate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readEntry(path: string, raw: unknown): SidecarEntry | string {
  if (!isObject(raw)) return `"${path}" is not an object`;
  const entry: SidecarEntry = {};
  if (raw['position'] !== undefined) {
    const p = raw['position'];
    if (!isObject(p) || !isCoordinate(p['x']) || !isCoordinate(p['y'])) return `"${path}" has a position without numeric x and y`;
    entry.position = { x: p['x'], y: p['y'] };
  }
  if (raw['note'] !== undefined) {
    if (typeof raw['note'] !== 'string') return `"${path}" has a note that is not text`;
    entry.note = raw['note'];
  }
  return entry;
}

/** Reads the Sidecar's text. Paths the code no longer has are kept as they are. */
export function parseSidecar(text: string, migrations: readonly Migration[] = MIGRATIONS): ParsedSidecar {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: `${SIDECAR_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isObject(raw)) return { ok: false, message: `${SIDECAR_FILE} is not a JSON object` };
  const version = raw['formatVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, message: `${SIDECAR_FILE} has no valid "formatVersion"` };
  }
  const current = currentFormatVersion(migrations);
  if (version > current) {
    return {
      ok: false,
      message: `${SIDECAR_FILE} is format ${version}, which is newer than this Truss understands (format ${current}). Upgrade Truss to open it.`,
    };
  }
  let migrated: Record<string, unknown> = raw;
  try {
    for (let v = version; v < current; v++) migrated = { ...migrations[v - 1]!(migrated), formatVersion: v + 1 };
  } catch (err) {
    return { ok: false, message: `${SIDECAR_FILE} could not be upgraded from format ${version}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isObject(migrated['nodes'])) return { ok: false, message: `${SIDECAR_FILE} has no "nodes" object` };
  const nodes: Record<string, SidecarEntry> = {};
  for (const [path, value] of Object.entries(migrated['nodes'])) {
    const entry = readEntry(path, value);
    if (typeof entry === 'string') return { ok: false, message: `${SIDECAR_FILE}: ${entry}` };
    nodes[path] = entry;
  }
  return { ok: true, sidecar: { nodes } };
}

/** Returns a copy of `value` whose object keys are sorted at every depth, so output never depends on insertion order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sorted(v)]),
    );
  }
  return value;
}

/** Deterministic text for the Sidecar: sorted keys, two-space indent, trailing newline. */
export function serializeSidecar(sidecar: Sidecar, formatVersion = currentFormatVersion()): string {
  return JSON.stringify(sorted({ formatVersion, nodes: sidecar.nodes }), null, 2) + '\n';
}

/** Sets where a Node sits. Positions are whole numbers so diffs stay small. */
export function withPosition(sidecar: Sidecar, path: string, position: Point): Sidecar {
  const entry = sidecar.nodes[path] ?? {};
  return {
    ...sidecar,
    nodes: { ...sidecar.nodes, [path]: { ...entry, position: { x: Math.round(position.x), y: Math.round(position.y) } } },
  };
}

/** Sets a Node's note; an empty note removes it. An entry with nothing left in it is removed too. */
export function withNote(sidecar: Sidecar, path: string, note: string): Sidecar {
  const { note: _old, ...rest } = sidecar.nodes[path] ?? {};
  const entry: SidecarEntry = note === '' ? rest : { ...rest, note };
  const { [path]: _gone, ...others } = sidecar.nodes;
  return { ...sidecar, nodes: Object.keys(entry).length === 0 ? others : { ...others, [path]: entry } };
}

/** The Sidecar once the constructs at `paths` are deleted: each entry at one of them, or beneath it, is dropped. */
export function withoutPaths(sidecar: Sidecar, paths: ReadonlySet<string>): Sidecar {
  if (paths.size === 0) return sidecar;
  const gone = (path: string) => [...paths].some((p) => path === p || path.startsWith(`${p}/`));
  return { ...sidecar, nodes: Object.fromEntries(Object.entries(sidecar.nodes).filter(([path]) => !gone(path))) };
}

/** The Sidecar once constructs have moved: each entry at a moved path, or beneath it, goes with it. Moves are made in order. */
export function withMoves(sidecar: Sidecar, moves: readonly Move[]): Sidecar {
  if (moves.length === 0) return sidecar;
  const entries = Object.entries(sidecar.nodes).map(([path, entry]) => ({ path, to: afterMoves(moves, path), entry }));
  // An entry that was already at the place another moves to is left behind by it.
  return { ...sidecar, nodes: Object.fromEntries([...entries.filter((e) => e.to === e.path), ...entries.filter((e) => e.to !== e.path)].map((e) => [e.to, e.entry])) };
}
