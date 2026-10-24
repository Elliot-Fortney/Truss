import type { ConnectionHint, HintCall, Overlay, ResolvedOverlay, Snippet } from './overlay.ts';
import { serviceName } from './services.ts';

/**
 * The Catalog: every construct the app's installed jsii libraries offer (ADR 0009, ADR 0010).
 * It is built in two steps so the slow one can be cached by package name and version: a jsii
 * assembly is boiled down to an `AssemblyDigest` (JSON, cacheable), then the digests of every
 * installed library are built into the `Catalog`. This file is pure; reading the files is an adapter's job.
 */

/** Which kind of construct an entry is. */
export type Tier = 'L1' | 'L2' | 'L3';

/** What the panel offers to edit a prop of this type with. Absent for a type Truss writes no literal for (arrays, unions, references). */
export type PropInput =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'duration' }
  | { kind: 'size' }
  /** `fqn` is the enum's jsii FQN. */
  | { kind: 'enum'; fqn: string; members: string[] }
  /** An object literal; only the fields Truss can write a literal for are listed. */
  | { kind: 'struct'; fields: CatalogProp[] };

export interface CatalogProp {
  name: string;
  /** The type as a developer would write it, e.g. `string`, `Record<string, string>`, `LifecycleRule[]`. */
  type: string;
  required: boolean;
  summary?: string;
  /** The `@default` doc, as display text only: `- Assigned by CloudFormation.` */
  default?: string;
  input?: PropInput;
  /** Set when the prop takes a construct, or an array of them: the jsii FQN of the class or interface it is typed as. A Node that is assignable to it can be this prop's Reference. */
  accepts?: { fqn: string; many?: true };
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
  /** The construct's own FQN and those of every class and interface it inherits from, so a prop typed as one of them takes it. */
  assignableTo: string[];
  /** The instance methods, its own and inherited, that take an `IGrantable` and return a `Grant`: `grantRead`, `grantInvoke`. */
  grantMethods: string[];
  /** The hand-written presentation data for this construct, with the items that don't resolve in the app's libraries left out. */
  overlay?: ResolvedOverlay;
}

export interface Catalog {
  /** Ordered by FQN. */
  entries: CatalogEntry[];
  /** Each Overlay item that didn't resolve in the app's libraries and was dropped, as a line for the terminal. */
  dropped: string[];
}

/** An entry as the palette lists it: everything but the props, with the Overlay's friendly name and whether it is featured. */
export type SearchHit = Omit<CatalogEntry, 'props' | 'overlay' | 'assignableTo' | 'grantMethods'> & {
  displayName?: string;
  featured?: true;
};

// --- Digest ---------------------------------------------------------------------------------------------

/** Bump when the digest's shape changes, so a cache written by an older Truss is ignored. */
export const DIGEST_FORMAT = 4;

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
  /** The interfaces it implements directly. */
  interfaces?: string[];
  /** Names of the instance methods a caller can use, declared on this class and not on its bases. */
  methods?: string[];
  /** Those of `methods` that take an `IGrantable` and return a `Grant`. */
  grantMethods?: string[];
  /** Instance properties a caller can use, by name, each with the FQN of its type, or `''` when the type isn't a class or interface. */
  properties?: Record<string, string>;
}

/** A behavioural interface (not a props struct): what an Overlay call can be made on when a property is typed as one, e.g. `IResource`. */
interface DigestInterface {
  fqn: string;
  bases: string[];
  methods?: string[];
  grantMethods?: string[];
  properties?: Record<string, string>;
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
  interfaces: DigestInterface[];
  /** FQNs of the enums, which Overlay snippets may name. */
  enums: string[];
  /** The members of each enum, by the enum's FQN. */
  enumMembers: Record<string, string[]>;
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
  const interfaces: DigestInterface[] = [];
  const enums: string[] = [];
  const enumMembers: Record<string, string[]> = {};

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
      const { methods, grantMethods, properties } = digestMembers(t);
      const implemented = stringList(t['interfaces']);
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
        ...(implemented.length > 0 ? { interfaces: implemented } : {}),
        ...(methods ? { methods } : {}),
        ...(grantMethods ? { grantMethods } : {}),
        ...(properties ? { properties } : {}),
      });
    } else if (t['kind'] === 'enum') {
      enums.push(fqn);
      enumMembers[fqn] = (Array.isArray(t['members']) ? t['members'] : []).flatMap((m) =>
        isObject(m) && str(m['name']) ? [m['name'] as string] : [],
      );
    } else if (t['kind'] === 'interface') {
      const bases = stringList(t['interfaces']);
      if (t['datatype'] === true)
        structs.push({
          fqn,
          bases,
          props: (Array.isArray(t['properties']) ? t['properties'] : []).flatMap(digestProp),
        });
      else interfaces.push({ fqn, bases, ...digestMembers(t) });
    }
  }
  return {
    format: DIGEST_FORMAT,
    name: raw['name'] as string,
    version: raw['version'] as string,
    classes,
    structs,
    interfaces,
    enums,
    enumMembers,
  };
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((b): b is string => typeof b === 'string') : [];

/** The instance methods and properties of a class or interface, left out when it has none. */
function digestMembers(t: Json): { methods?: string[]; grantMethods?: string[]; properties?: Record<string, string> } {
  const callable = (Array.isArray(t['methods']) ? t['methods'] : []).filter(isCallable);
  const methods = callable.map((m) => m['name'] as string);
  const grantMethods = callable.filter(grantsToIdentity).map((m) => m['name'] as string);
  const properties = Object.fromEntries(
    (Array.isArray(t['properties']) ? t['properties'] : []).flatMap((p) =>
      isCallable(p) ? [[p['name'] as string, isObject(p['type']) ? (str(p['type']['fqn']) ?? '') : '']] : [],
    ),
  );
  return {
    ...(methods.length > 0 ? { methods } : {}),
    ...(grantMethods.length > 0 ? { grantMethods } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  };
}

const GRANTABLE = 'aws-cdk-lib.aws_iam.IGrantable';
const GRANT = 'aws-cdk-lib.aws_iam.Grant';

/** Whether a method takes an `IGrantable` as its first parameter and returns a `Grant`. */
function grantsToIdentity(m: Json): boolean {
  const first = Array.isArray(m['parameters']) ? m['parameters'][0] : undefined;
  const returns = isObject(m['returns']) && isObject(m['returns']['type']) ? m['returns']['type']['fqn'] : undefined;
  return isObject(first) && isObject(first['type']) && first['type']['fqn'] === GRANTABLE && returns === GRANT;
}

/** A method or property a caller can use on an instance: named, and neither static nor protected. */
function isCallable(m: unknown): m is Json {
  return isObject(m) && !!str(m['name']) && m['static'] !== true && m['protected'] !== true;
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
/** The base of everything in a template: resources, but also outputs, parameters and conditions. */
const CFN_ELEMENT = 'aws-cdk-lib.CfnElement';
/** Never entries: the base every construct has, the one every L1 has, and the root a construct tree hangs from. */
const NEVER_PLACED = new Set([CONSTRUCT, CFN_RESOURCE, 'constructs.RootConstruct']);
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
function flatten(
  fqn: string,
  structs: ReadonlyMap<string, DigestStruct>,
  seen = new Set<string>(),
): Map<string, DigestProp> {
  const out = new Map<string, DigestProp>();
  const s = structs.get(fqn);
  if (!s || seen.has(fqn)) return out;
  seen.add(fqn);
  for (const base of s.bases) for (const [name, p] of flatten(base, structs, seen)) out.set(name, p);
  for (const p of s.props) out.set(p.name, p);
  return out;
}

/** How deep a struct's fields are offered as inputs inside inputs. */
const MAX_INPUT_DEPTH = 3;
/** Only enums from CDK itself are offered: writing one into code needs an import Truss knows how to make. */
const CDK_LIB = 'aws-cdk-lib.';

/** Works out, for a prop's type, the input the panel edits it with. Shared by every prop of the same struct, so the work is done once per struct. */
function inputs(
  structs: ReadonlyMap<string, DigestStruct>,
  enumMembers: ReadonlyMap<string, string[]>,
): (t: TypeRef, depth: number) => { input?: PropInput } {
  const structInputs = new Map<string, PropInput | undefined>();

  const inputFor = (t: TypeRef, depth: number): PropInput | undefined => {
    if ('primitive' in t)
      return t.primitive === 'string' || t.primitive === 'number' || t.primitive === 'boolean'
        ? { kind: t.primitive }
        : undefined;
    if ('union' in t) {
      // L1 props widen from `string` to `string | IxxxRef`; the Ref alternative stays out of the panel (see renderType).
      const shown = t.union.types.filter((m) => !('fqn' in m && m.fqn.startsWith(REF_INTERFACES)));
      return shown.length === 1 ? inputFor(shown[0]!, depth) : undefined;
    }
    if (!('fqn' in t)) return undefined;
    if (t.fqn === 'aws-cdk-lib.Duration') return { kind: 'duration' };
    if (t.fqn === 'aws-cdk-lib.Size') return { kind: 'size' };
    const members = enumMembers.get(t.fqn);
    if (members)
      return t.fqn.startsWith(CDK_LIB) && members.length > 0 ? { kind: 'enum', fqn: t.fqn, members } : undefined;
    if (!structs.has(t.fqn) || depth >= MAX_INPUT_DEPTH) return undefined;
    const key = `${t.fqn}@${depth}`;
    if (!structInputs.has(key)) {
      structInputs.set(key, undefined); // a struct that contains itself stops here
      const fields = [...flatten(t.fqn, structs).values()].flatMap((p): CatalogProp[] => {
        const input = inputFor(p.type, depth + 1);
        return input
          ? [
              {
                name: p.name,
                type: renderType(p.type),
                required: p.optional !== true,
                input,
                ...(p.summary ? { summary: p.summary } : {}),
              },
            ]
          : [];
      });
      structInputs.set(key, fields.length > 0 ? { kind: 'struct', fields } : undefined);
    }
    return structInputs.get(key);
  };

  return (t, depth) => {
    const input = inputFor(t, depth);
    return input ? { input } : {};
  };
}

/** What a prop that holds constructs is typed as: a class or interface that a construct could be, alone or as an array. Undefined for any other type. */
function acceptsOf(t: TypeRef, accepted: (fqn: string) => boolean): CatalogProp['accepts'] {
  if ('union' in t) {
    const shown = t.union.types.filter((m) => !('fqn' in m && m.fqn.startsWith(REF_INTERFACES)));
    return shown.length === 1 ? acceptsOf(shown[0]!, accepted) : undefined;
  }
  if ('fqn' in t) return accepted(t.fqn) ? { fqn: t.fqn } : undefined;
  if ('collection' in t && t.collection.kind === 'array') {
    const element = acceptsOf(t.collection.elementtype, accepted);
    return element ? { fqn: element.fqn, many: true } : undefined;
  }
  return undefined;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const moduleKey = (namespace: string) => namespace.replace(/^aws_/, '').replace(/_patterns$/, '');

/**
 * Builds the Catalog from the digest of every library the app has installed, then lays the Overlays
 * over it. An Overlay item the libraries can't resolve is dropped and reported in `dropped`.
 */
export function buildCatalog(digests: readonly AssemblyDigest[], overlays: readonly Overlay[] = []): Catalog {
  const classes = new Map<string, { c: DigestClass; library: string }>();
  const structs = new Map<string, DigestStruct>();
  const enums = new Set<string>();
  const enumMembers = new Map<string, string[]>();
  /** What a call can be made on: every class and interface, with the types it inherits members from. */
  const members = new Map<
    string,
    { bases: string[]; methods?: string[]; grantMethods?: string[]; properties?: Record<string, string> }
  >();
  for (const d of digests) {
    for (const c of d.classes)
      members.set(c.fqn, {
        bases: [...(c.base ? [c.base] : []), ...(c.interfaces ?? [])],
        ...(c.methods ? { methods: c.methods } : {}),
        ...(c.grantMethods ? { grantMethods: c.grantMethods } : {}),
        ...(c.properties ? { properties: c.properties } : {}),
      });
    for (const i of d.interfaces) members.set(i.fqn, i);
    for (const c of d.classes) classes.set(c.fqn, { c, library: d.name });
    for (const s of d.structs) structs.set(s.fqn, s);
    for (const e of d.enums) enums.add(e);
    for (const [fqn, names] of Object.entries(d.enumMembers)) enumMembers.set(fqn, names);
  }
  const inputOf = inputs(structs, enumMembers);
  const interfaceFqns = new Set(digests.flatMap((d) => d.interfaces.map((i) => i.fqn)));

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

  /** An interface, or a class that is a construct: what a Reference could point at. Not `Duration`, `Size` or the like. */
  const takesConstruct = (fqn: string) =>
    interfaceFqns.has(fqn) || (classes.has(fqn) && ancestors(fqn).includes(CONSTRUCT));

  const entries: CatalogEntry[] = [];
  for (const [fqn, { c, library }] of classes) {
    const above = ancestors(fqn);
    if (c.abstract || c.protected || NEVER_PLACED.has(fqn)) continue;
    if (!above.includes(CONSTRUCT)) continue;
    if ([fqn, ...above].some((f) => BOXES.has(f))) continue;
    // Outputs, parameters and the like are template elements, not resources a Node could be.
    if (above.includes(CFN_ELEMENT) && !above.includes(CFN_RESOURCE)) continue;

    const tier: Tier = above.includes(CFN_RESOURCE) ? 'L1' : c.namespace?.endsWith('_patterns') ? 'L3' : 'L2';
    const key = c.namespace ? moduleKey(c.namespace) : undefined;
    const service = key ? (serviceName(key) ?? key.replace(/_/g, ' ')) : undefined;
    const props = [...flatten(c.propsFqn ?? '', structs).values()].map((p): CatalogProp => {
      const accepts = acceptsOf(p.type, takesConstruct);
      return {
        name: p.name,
        type: renderType(p.type),
        required: p.optional !== true,
        ...(p.summary ? { summary: p.summary } : {}),
        ...(p.default ? { default: p.default } : {}),
        ...inputOf(p.type, 0),
        ...(accepts ? { accepts } : {}),
      };
    });
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
      assignableTo: supertypes(members, fqn),
      grantMethods: [...new Set(supertypes(members, fqn).flatMap((f) => members.get(f)?.grantMethods ?? []))],
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

  const dropped: string[] = [];
  const world: World = {
    hasType: (fqn) => members.has(fqn) || enums.has(fqn),
    hasClass: (fqn) => classes.has(fqn),
    hasMethod: (fqn, name) => supertypes(members, fqn).some((f) => members.get(f)?.methods?.includes(name)),
    propertyType: (fqn, name) => {
      for (const f of supertypes(members, fqn)) {
        const type = members.get(f)?.properties?.[name];
        if (type !== undefined) return type;
      }
      return undefined;
    },
  };
  const byFqn = new Map(entries.map((e) => [e.fqn, e]));
  for (const o of overlays) {
    const entry = byFqn.get(o.fqn);
    if (!entry) {
      dropped.push(`Overlay for ${o.fqn} dropped: no such construct in the installed libraries.`);
      continue;
    }
    if (o.tier) entry.tier = o.tier;
    entry.overlay = resolveOverlay(o, entry, world, (what, why) =>
      dropped.push(`Overlay for ${o.fqn}: dropped ${what}, ${why}.`),
    );
  }

  return { entries: entries.sort((a, b) => compare(a.fqn, b.fqn)), dropped };
}

// --- Overlays -------------------------------------------------------------------------------------------

/** What the installed libraries say exists, for checking the items of an Overlay. */
interface World {
  /** A class or an enum. */
  hasType(fqn: string): boolean;
  hasClass(fqn: string): boolean;
  /** An instance method on the class or one of its bases. */
  hasMethod(fqn: string, name: string): boolean;
  /** The FQN of a property's type (`''` when it isn't a class or interface), or undefined when the class and its bases have no such property. */
  propertyType(fqn: string, name: string): string | undefined;
}

/** The type and everything it inherits members from, nearest first; a cycle in the data ends the walk instead of looping. */
function supertypes(members: ReadonlyMap<string, { bases: string[] }>, fqn: string): string[] {
  const out: string[] = [];
  for (let i = 0, queue = [fqn]; i < queue.length; i++) {
    const at = queue[i]!;
    if (out.includes(at)) continue;
    out.push(at);
    queue.push(...(members.get(at)?.bases ?? []));
  }
  return out;
}

/** Follows `path` through properties from the class `from`; the last step is checked by `last`. */
function follows(
  world: World,
  from: string,
  path: readonly string[],
  last: (fqn: string, name: string) => boolean,
): boolean {
  let at = from;
  for (const name of path.slice(0, -1)) {
    const type = world.propertyType(at, name);
    if (!type) return false;
    at = type;
  }
  const end = path.at(-1);
  return end !== undefined && last(at, end);
}

const named = (path: readonly string[]) => path.join('.');

function resolveOverlay(
  o: Overlay,
  entry: CatalogEntry,
  world: World,
  drop: (what: string, why: string) => void,
): ResolvedOverlay {
  const propNames = new Set(entry.props.map((p) => p.name));
  const noProp = (name: string) => `${entry.name} has no prop "${name}"`;
  const missing = (uses: readonly string[] | undefined) => (uses ?? []).filter((f) => !world.hasType(f));

  const snippets = (kind: string, given: Record<string, Snippet> | undefined) => {
    const kept: Record<string, Snippet> = {};
    for (const [prop, snippet] of Object.entries(given ?? {})) {
      const gone = missing(snippet.uses);
      if (!propNames.has(prop)) drop(`${kind} "${prop}"`, noProp(prop));
      else if (gone.length > 0) drop(`${kind} "${prop}"`, `${gone.join(', ')} isn't in the installed libraries`);
      else kept[prop] = snippet;
    }
    return kept;
  };

  const featuredProps: string[] = [];
  for (const p of o.featuredProps ?? []) {
    if (propNames.has(p)) featuredProps.push(p);
    else drop(`featured prop "${p}"`, noProp(p));
  }

  /** The spellings of a call that resolve on every class in `receivers`. A spelling is only worth a line of its own when another one survives. */
  const callForms = (forms: readonly string[][], receivers: readonly string[], label: string) => {
    const resolves = (form: string[]) =>
      receivers.every((r) => follows(world, r, form, (fqn, name) => world.hasMethod(fqn, name)));
    const kept = forms.filter(resolves);
    if (kept.length > 0)
      for (const form of forms.filter((f) => !kept.includes(f)))
        drop(`form ${named(form)} of ${label}`, `it doesn't resolve on ${receivers.join(', ')}`);
    return kept;
  };

  const connections: ConnectionHint[] = [];
  for (const hint of o.connections ?? []) {
    const label = `hint "${hint.label}"`;
    const peers = hint.peers.filter((p) => world.hasClass(p));
    if (peers.length === 0) {
      drop(label, 'none of its peers are in the installed libraries');
      continue;
    }
    for (const gone of hint.peers.filter((p) => !peers.includes(p)))
      drop(`peer ${gone} of ${label}`, `it isn't in the installed libraries`);
    const primaryGone = missing(hint.primary.uses);
    const forms = callForms(hint.primary.forms, [entry.fqn], `${label}'s call`);
    if (primaryGone.length > 0 || forms.length === 0) {
      drop(
        label,
        primaryGone.length > 0
          ? `${primaryGone.join(', ')} isn't in the installed libraries`
          : `its call ${hint.primary.forms.map(named).join(' or ')} doesn't resolve`,
      );
      continue;
    }
    const secondary: HintCall[] = [];
    for (const call of hint.secondary ?? []) {
      const gone = missing(call.uses);
      const callForm = callForms(call.forms, call.on === 'self' ? [entry.fqn] : peers, `${label}'s call on ${call.on}`);
      if (gone.length > 0) drop(`a call of ${label}`, `${gone.join(', ')} isn't in the installed libraries`);
      else if (callForm.length === 0)
        drop(`a call of ${label}`, `${call.forms.map(named).join(' or ')} doesn't resolve`);
      else secondary.push({ ...call, forms: callForm });
    }
    connections.push({ ...hint, peers, primary: { ...hint.primary, forms }, ...(hint.secondary ? { secondary } : {}) });
  }

  const accessors = (o.accessors ?? []).filter(
    (a) =>
      follows(world, entry.fqn, a.path, (fqn, name) => world.propertyType(fqn, name) !== undefined) ||
      (drop(`accessor ${named(a.path)}`, `${entry.name} has no such property`), false),
  );

  const referenceFlows: Record<string, 'in'> = {};
  for (const [prop, flow] of Object.entries(o.referenceFlows ?? {})) {
    if (propNames.has(prop)) referenceFlows[prop] = flow;
    else drop(`reference flow "${prop}"`, noProp(prop));
  }

  return {
    displayName: o.displayName,
    featuredProps,
    defaults: snippets('default', o.defaults),
    fixtures: snippets('fixture', o.fixtures),
    connections,
    accessors,
    referenceFlows,
  };
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
  const display = e.overlay?.displayName.toLowerCase();
  if (name === word || display === word) return 100;
  const service = e.service?.toLowerCase();
  const module = e.module ? moduleKey(e.module) : undefined;
  if (service === word || module === word) return 70;
  if (name.startsWith(word) || display?.startsWith(word)) return 60;
  if (name.includes(word) || display?.includes(word)) return 40;
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
      Number(b.e.overlay !== undefined) - Number(a.e.overlay !== undefined) ||
      TIER_ORDER[a.e.tier] - TIER_ORDER[b.e.tier] ||
      compare(a.e.name, b.e.name) ||
      compare(a.e.fqn, b.e.fqn),
  );
  return scored
    .slice(0, limit)
    .map(({ e: { props: _props, assignableTo: _assignableTo, overlay, ...hit } }) =>
      overlay ? { ...hit, displayName: overlay.displayName, featured: true as const } : hit,
    );
}
