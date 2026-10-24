import { readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { templateEffects, type EffectTemplate } from './effects.ts';
import type { Annotation, Assembly, Frame, ResourceRef, StackInfo, TreeNode } from '../../core/assembly.ts';

interface RawTreeNode {
  id: string;
  path: string;
  constructInfo?: { fqn: string };
  attributes?: Record<string, unknown>;
  children?: Record<string, RawTreeNode>;
}

interface RawArtifact {
  type: string;
  environment?: string;
  /** The construct path of a stack. A stack's artifact ID can differ from it, as it does inside a Stage. */
  displayName?: string;
  additionalMetadataFile?: string;
  properties?: { directoryName?: string; templateFile?: string };
}

// `fn (file:line:col)` or, for anonymous frames, a bare `file:line:col`. `file` may be a file:// URL.
const FRAME = /^(?:(.*?) )?\(?((?:file:\/\/)?[^()]+?):(\d+):(\d+)\)?$/;
const AGNOSTIC_ENV = 'aws://unknown-account/unknown-region';

const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'));

function convertTree(raw: RawTreeNode): TreeNode {
  const cfnType = raw.attributes?.['aws:cdk:cloudformation:type'];
  return {
    id: raw.id,
    path: raw.path,
    fqn: raw.constructInfo?.fqn ?? 'unknown',
    ...(typeof cfnType === 'string' ? { cfnType } : {}),
    children: Object.values(raw.children ?? {}).map(convertTree),
  };
}

/** Parses the lines of an `aws:cdk:creationStack` entry that point into the app, innermost first. */
export function parseCreationStack(lines: string[], appDir: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of lines) {
    const m = FRAME.exec(line.trim());
    if (!m) continue;
    const [, fn, raw, l, c] = m as unknown as [string, string | undefined, string, string, string];
    const file = raw.startsWith('file://') ? fileURLToPath(raw) : raw;
    if (!isAbsolute(file)) continue;
    const rel = relative(appDir, file);
    if (rel.startsWith('..') || rel.split('/').includes('node_modules')) continue;
    frames.push({ ...(fn ? { fn } : {}), file: rel, line: Number(l), col: Number(c) });
  }
  return frames;
}

/** Reads a cloud assembly directory written by `cdk synth` into the core's plain-JSON shape. */
export function readAssembly(assemblyDir: string, appDir: string): Assembly {
  const manifest = readJson(join(assemblyDir, 'manifest.json'));
  const tree = convertTree(readJson(join(assemblyDir, 'tree.json')).tree);

  const stacks: StackInfo[] = [];
  const creation: Record<string, Frame[]> = {};
  const resourceRefs: ResourceRef[] = [];
  const annotations: Annotation[] = [];
  const templates: EffectTemplate[] = [];
  collectStacks(assemblyDir, appDir, stacks, creation, resourceRefs, annotations, templates);
  const { effects, importRefs } = templateEffects(templates);
  return {
    schemaVersion: String(manifest.version),
    tree,
    stacks,
    creation,
    resourceRefs,
    annotations,
    effects,
    importRefs,
  };
}

/** Adds the stacks of one assembly directory, then those of the nested assembly each Stage writes. */
function collectStacks(
  dir: string,
  appDir: string,
  stacks: StackInfo[],
  creation: Record<string, Frame[]>,
  resourceRefs: ResourceRef[],
  annotations: Annotation[],
  templates: EffectTemplate[],
): void {
  const manifest = readJson(join(dir, 'manifest.json'));
  for (const [id, artifact] of Object.entries<RawArtifact>(manifest.artifacts ?? {})) {
    if (artifact.type === 'cdk:cloud-assembly' && artifact.properties?.directoryName) {
      collectStacks(
        join(dir, artifact.properties.directoryName),
        appDir,
        stacks,
        creation,
        resourceRefs,
        annotations,
        templates,
      );
      continue;
    }
    if (artifact.type !== 'aws:cloudformation:stack') continue;
    const env = artifact.environment && artifact.environment !== AGNOSTIC_ENV ? artifact.environment : undefined;
    stacks.push({ path: artifact.displayName ?? id, ...(env ? { env } : {}) });
    if (artifact.properties?.templateFile) {
      const template = readJson(join(dir, artifact.properties.templateFile));
      resourceRefs.push(...templateRefs(template));
      templates.push(template);
    }
    if (!artifact.additionalMetadataFile) continue;
    const metadata = readJson(join(dir, artifact.additionalMetadataFile)) as Record<
      string,
      { type: string; data: unknown }[]
    >;
    for (const [path, entries] of Object.entries(metadata)) {
      for (const e of entries) {
        const level = /^aws:cdk:(error|warning|info)$/.exec(e.type)?.[1] as Annotation['level'] | undefined;
        if (level && typeof e.data === 'string')
          annotations.push({ path: path.replace(/^\//, ''), level, message: e.data });
      }
      const entry = entries.find((e) => e.type === 'aws:cdk:creationStack');
      if (!entry || !Array.isArray(entry.data)) continue;
      const frames = parseCreationStack(entry.data as string[], appDir);
      if (frames.length) creation[path.replace(/^\//, '')] = frames;
    }
  }
}

interface RawTemplate {
  Parameters?: unknown;
  Resources?: Record<
    string,
    { Type?: string; Metadata?: Record<string, unknown>; Properties?: unknown; DependsOn?: unknown }
  >;
}

/** The logical IDs a template value points at: `Ref`, `Fn::GetAtt` (both forms) and the `${Id}` and `${Id.Attr}` of `Fn::Sub`. */
function referencedIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) referencedIds(v, out);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'Ref' && typeof inner === 'string') out.add(inner);
    else if (key === 'Fn::GetAtt') {
      const id = Array.isArray(inner) ? inner[0] : typeof inner === 'string' ? inner.split('.')[0] : undefined;
      if (typeof id === 'string') out.add(id);
    } else if (key === 'Fn::Sub') {
      const text = Array.isArray(inner) ? inner[0] : inner;
      if (typeof text === 'string') for (const m of text.matchAll(/\$\{([^!}][^}]*)\}/g)) out.add(m[1]!.split('.')[0]!);
      if (Array.isArray(inner)) referencedIds(inner[1], out);
    } else referencedIds(inner, out);
  }
}

/**
 * Which L1 resource of a template points at which, by construct path: the cloud assembly's own record of
 * what each construct needed. Parameters, pseudo parameters and resources with no construct path are left out.
 */
export function templateRefs(template: RawTemplate): ResourceRef[] {
  const resources = template.Resources ?? {};
  const pathOf = new Map<string, string>();
  for (const [id, r] of Object.entries(resources)) {
    const path = r.Metadata?.['aws:cdk:path'];
    if (typeof path === 'string') pathOf.set(id, path);
  }
  const refs = new Map<string, ResourceRef>();
  for (const [id, r] of Object.entries(resources)) {
    const from = pathOf.get(id);
    if (from === undefined) continue;
    const ids = new Set<string>();
    referencedIds(r.Properties, ids);
    for (const dep of [r.DependsOn].flat()) if (typeof dep === 'string') ids.add(dep);
    for (const target of ids) {
      const to = pathOf.get(target);
      if (to !== undefined && to !== from) refs.set(`${from}\0${to}`, { from, to });
    }
  }
  return [...refs.values()];
}
