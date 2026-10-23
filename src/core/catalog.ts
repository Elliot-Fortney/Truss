import { serviceName } from './services.ts';

/**
 * The Catalog: every construct the app's installed jsii libraries offer (ADR 0009, ADR 0010).
 * It is built in two steps so the slow one can be cached by package name and version: a jsii
 * assembly is boiled down to an `AssemblyDigest` (JSON, cacheable), then the digests of every
 * installed library are built into the `Catalog`. This file is pure; reading the files is an adapter's job.
 */

/** Which kind of construct an entry is. */
export type Tier = 'L1' | 'L2' | 'L3';

export interface CatalogProp {
  name: string;
  /** The type as a developer would write it, e.g. `string`, `Record<string, string>`, `LifecycleRule[]`. */
  type: string;
  required: boolean;
  summary?: string;
  /** The `@default` doc, as display text only: `- Assigned by CloudFormation.` */
  default?: string;
}

export interface CatalogEntry {
  fqn: string;
  /** The class name, e.g. `Bucket`. */
  name: string;
  /** The npm package that holds it, e.g. `aws-cdk-lib`. */
  library: string;
  /** The service as written, e.g. `S3`. Absent for a construct outside any module. */
  service?: string;
  /** The module the class sits in, e.g. `aws_s3`. */
  module?: string;
  tier: Tier;
  /** The CloudFormation type an L1 is, or an L2 builds on: `AWS::S3::Bucket`. */
  cfnType?: string;
  summary?: string;
  deprecated?: true;
  /** Every prop the construct takes, including those its props struct inherits; required ones are flagged. */
  props: CatalogProp[];
}

export interface Catalog {
  /** Ordered by FQN. */
  entries: CatalogEntry[];
}

/** An entry as the palette lists it: everything but the props. */
export type SearchHit = Omit<CatalogEntry, 'props'>;

// --- Digest ---------------------------------------------------------------------------------------------

/** Bump when the digest's shape changes, so a cache written by an older Truss is ignored. */
export const DIGEST_FORMAT = 1;

/** A jsii type reference. */
export type TypeRef =
  | { primitive: string }
  | { fqn: string }
  | { collection: { kind: string; elementtype: TypeRef } }
  | { union: { types: TypeRef[] } };

interface DigestClass {
  fqn: string;
  name: string;
  namespace?: string;
  base?: string;
  abstract?: true;
  /** The constructor is protected, so only subclasses can call it. */
  protected?: true;
  deprecated?: true;
  summary?: string;
  cfnType?: string;
  /** The struct the third constructor parameter takes. */
  propsFqn?: string;
}

interface DigestProp {
  name: string;
  type: TypeRef;
  optional?: true;
  summary?: string;
  default?: string;
}

interface DigestStruct {
  fqn: string;
  bases: string[];
  props: DigestProp[];
}

export interface AssemblyDigest {
  format: number;
  name: string;
  version: string;
  classes: DigestClass[];
  structs: DigestStruct[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Keeps from a jsii assembly what the Catalog needs: classes and the structs that hold their props. Throws when `raw` isn't an assembly. */
export function digestAssembly(raw: unknown): AssemblyDigest {
  if (!isObject(raw) || !str(raw['name']) || !str(raw['version']) || !isObject(raw['types'])) {
    throw new Error('Not a jsii assembly: it has no name, version and types');
  }
  const classes: DigestClass[] = [];
  const structs: DigestStruct[] = [];

  for (const t of Object.values(raw['types'])) {
    if (!isObject(t) || !str(t['fqn'])) continue;
    const fqn = t['fqn'] as string;
    const docs = isObject(t['docs']) ? t['docs'] : {};
    if (t['kind'] === 'class') {
      const init = isObject(t['initializer']) ? t['initializer'] : undefined;
      const third = init && Array.isArray(init['parameters']) ? init['parameters'][2] : undefined;
      const propsType = isObject(third) && isObject(third['type']) ? str(third['type']['fqn']) : undefined;
      const custom = isObject(docs['custom']) ? docs['custom'] : {};
      const namespace = str(t['namespace']);
      const base = str(t['base']);
      const summary = str(docs['summary']);
      const cfnType = str(custom['cloudformationResource']);
      classes.push({
        fqn,
        name: str(t['name']) ?? fqn.split('.').at(-1)!,
        ...(namespace ? { namespace } : {}),
        ...(base ? { base } : {}),
        ...(t['abstract'] === true ? { abstract: true as const } : {}),
        ...(init?.['protected'] === true ? { protected: true as const } : {}),
        ...(docs['stability'] === 'deprecated' ? { deprecated: true as const } : {}),
        ...(summary ? { summary } : {}),
        ...(cfnType ? { cfnType } : {}),
        ...(propsType ? { propsFqn: propsType } : {}),
      });
    } else if (t['kind'] === 'interface' && t['datatype'] === true) {
      const bases = Array.isArray(t['interfaces']) ? t['interfaces'].filter((b): b is string => typeof b === 'string') : [];
      structs.push({ fqn, bases, props: (Array.isArray(t['properties']) ? t['properties'] : []).flatMap(digestProp) });
    }
  }
  return { format: DIGEST_FORMAT, name: raw['name'] as string, version: raw['version'] as string, classes, structs };
}

function digestProp(p: unknown): DigestProp[] {
  if (!isObject(p) || !str(p['name']) || !isObject(p['type'])) return [];
  const docs = isObject(p['docs']) ? p['docs'] : {};
  const summary = str(docs['summary']);
  const def = str(docs['default']);
  return [
    {
      name: p['name'] as string,
      type: p['type'] as unknown as TypeRef,
      ...(p['optional'] === true ? { optional: true as const } : {}),
      ...(summary ? { summary } : {}),
      ...(def ? { default: def } : {}),
    },
  ];
}

// --- Build ----------------------------------------------------------------------------------------------

const CONSTRUCT = 'constructs.Construct';
const CFN_RESOURCE = 'aws-cdk-lib.CfnResource';
/** Never entries: the base every construct has, and the one every L1 has. */
const NEVER_PLACED = new Set([CONSTRUCT, CFN_RESOURCE]);
/** Stacks and Stages are drawn as boxes, never as Nodes (CONTEXT.md). */
const BOXES = new Set(['aws-cdk-lib.Stack', 'aws-cdk-lib.Stage']);
/** Where a `fqn` of `aws-cdk-lib.interfaces.*` lives: the `IxxxRef` types an L1 prop also accepts instead of a string. */
const REF_INTERFACES = 'aws-cdk-lib.interfaces.';

/** Writes a jsii type the way TypeScript would. */
function renderType(t: TypeRef): string {
  if ('primitive' in t) {
    const p = t.primitive;
    return p === 'date' ? 'Date' : p === 'json' ? 'any' : p;
  }
  if ('fqn' in t) return t.fqn.split('.').at(-1)!;
  if ('collection' in t) {
    const element = renderType(t.collection.elementtype);
    if (t.collection.kind === 'map') return `Record<string, ${element}>`;
    return /[|]/.test(element) ? `(${element})[]` : `${element}[]`;
  }
  // L1 props are widening from `string` to `string | IxxxRef`; the Ref alternative stays out of the panel.
  const members = t.union.types;
  const shown = members.filter((m) => !('fqn' in m && m.fqn.startsWith(REF_INTERFACES)));
  return (shown.length > 0 ? shown : members).map(renderType).join(' | ');
}

/** The props of a struct and of every struct it inherits from, the most distant first; a prop declared again replaces the inherited one. */
function flatten(fqn: string, structs: ReadonlyMap<string, DigestStruct>, seen = new Set<string>()): Map<string, DigestProp> {
  const out = new Map<string, DigestProp>();
  const s = structs.get(fqn);
  if (!s || seen.has(fqn)) return out;
  seen.add(fqn);
  for (const base of s.bases) for (const [name, p] of flatten(base, structs, seen)) out.set(name, p);
  for (const p of s.props) out.set(p.name, p);
  return out;
}

const moduleKey = (namespace: string) => namespace.replace(/^aws_/, '').replace(/_patterns$/, '');

/** Builds the Catalog from the digest of every library the app has installed. */
export function buildCatalog(digests: readonly AssemblyDigest[]): Catalog {
  const classes = new Map<string, { c: DigestClass; library: string }>();
  const structs = new Map<string, DigestStruct>();
  for (const d of digests) {
    for (const c of d.classes) classes.set(c.fqn, { c, library: d.name });
    for (const s of d.structs) structs.set(s.fqn, s);
  }

  /** The class's base classes, nearest first. The last one may be a class no loaded library defines, such as `constructs.Construct`. */
  const ancestors = (fqn: string): string[] => {
    const out: string[] = [];
    let next = classes.get(fqn)?.c.base;
    while (next !== undefined && !out.includes(next)) {
      out.push(next);
      next = classes.get(next)?.c.base;
    }
    return out;
  };

  const entries: CatalogEntry[] = [];
  for (const [fqn, { c, library }] of classes) {
    const above = ancestors(fqn);
    if (c.abstract || c.protected || NEVER_PLACED.has(fqn)) continue;
    if (!above.includes(CONSTRUCT)) continue;
    if ([fqn, ...above].some((f) => BOXES.has(f))) continue;

    const tier: Tier = above.includes(CFN_RESOURCE) ? 'L1' : c.namespace?.endsWith('_patterns') ? 'L3' : 'L2';
    const key = c.namespace ? moduleKey(c.namespace) : undefined;
    const service = key ? (serviceName(key) ?? key.replace(/_/g, ' ')) : undefined;
    const props = [...flatten(c.propsFqn ?? '', structs).values()].map(
      (p): CatalogProp => ({
        name: p.name,
        type: renderType(p.type),
        required: p.optional !== true,
        ...(p.summary ? { summary: p.summary } : {}),
        ...(p.default ? { default: p.default } : {}),
      }),
    );
    entries.push({
      fqn,
      name: c.name,
      library,
      ...(service ? { service } : {}),
      ...(c.namespace ? { module: c.namespace } : {}),
      tier,
      ...(c.cfnType ? { cfnType: c.cfnType } : {}),
      ...(c.summary ? { summary: c.summary } : {}),
      ...(c.deprecated ? { deprecated: true as const } : {}),
      props,
    });
  }

  // An L2 builds on the L1 next to it that is named for it: `Bucket` on `CfnBucket`.
  const l1Types = new Map(entries.filter((e) => e.tier === 'L1' && e.cfnType).map((e) => [e.fqn, e.cfnType!]));
  for (const e of entries) {
    if (e.tier !== 'L2' || e.cfnType) continue;
    const sibling = `${e.fqn.slice(0, e.fqn.length - e.name.length)}Cfn${e.name}`;
    const cfnType = l1Types.get(sibling);
    if (cfnType) e.cfnType = cfnType;
  }

  return { entries: entries.sort((a, b) => (a.fqn < b.fqn ? -1 : a.fqn > b.fqn ? 1 : 0)) };
}

const indexes = new WeakMap<Catalog, Map<string, CatalogEntry>>();

/** The entry for a construct class, or undefined when the Catalog has none. */
export function entryFor(catalog: Catalog, fqn: string): CatalogEntry | undefined {
  let index = indexes.get(catalog);
  if (!index) {
    index = new Map(catalog.entries.map((e) => [e.fqn, e]));
    indexes.set(catalog, index);
  }
  return index.get(fqn);
}

// --- Search ---------------------------------------------------------------------------------------------

const TIER_ORDER: Record<Tier, number> = { L2: 0, L3: 1, L1: 2 };

/** How well one word of the query matches an entry; 0 when it doesn't. */
function scoreWord(word: string, e: CatalogEntry): number {
  const name = e.name.toLowerCase();
  if (name === word) return 100;
  if (name.startsWith(word)) return 60;
  if (name.includes(word)) return 40;
  const service = e.service?.toLowerCase();
  const module = e.module ? moduleKey(e.module) : undefined;
  if (service === word || module === word) return 30;
  const cfn = e.cfnType?.toLowerCase();
  if (cfn && (cfn.split('::').at(-1) === word || cfn === word)) return 30;
  if ([service, module, cfn, e.library.toLowerCase()].some((field) => field?.includes(word))) return 10;
  return 0;
}

/**
 * Searches by name, service or CloudFormation type, the way the palette does. Every word of the query
 * must match; the best name matches come first, then L2 before L3 before L1, and deprecated constructs last.
 * An empty query lists everything in that order.
 */
export function searchCatalog(catalog: Catalog, query: string, limit = 50): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { e: CatalogEntry; score: number }[] = [];
  for (const e of catalog.entries) {
    let score = 0;
    let matches = true;
    for (const w of words) {
      const s = scoreWord(w, e);
      if (s === 0) {
        matches = false;
        break;
      }
      score += s;
    }
    if (matches) scored.push({ e, score });
  }
  scored.sort(
    (a, b) =>
      Number(a.e.deprecated ?? false) - Number(b.e.deprecated ?? false) ||
      b.score - a.score ||
      TIER_ORDER[a.e.tier] - TIER_ORDER[b.e.tier] ||
      (a.e.name < b.e.name ? -1 : a.e.name > b.e.name ? 1 : 0) ||
      (a.e.fqn < b.e.fqn ? -1 : 1),
  );
  return scored.slice(0, limit).map(({ e: { props: _props, ...hit } }) => hit);
}
