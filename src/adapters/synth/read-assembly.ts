import { readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Assembly, Frame, StackInfo, TreeNode } from '../../core/assembly.ts';

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
  properties?: { directoryName?: string };
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
  collectStacks(assemblyDir, appDir, stacks, creation);
  return { schemaVersion: String(manifest.version), tree, stacks, creation };
}

/** Adds the stacks of one assembly directory, then those of the nested assembly each Stage writes. */
function collectStacks(dir: string, appDir: string, stacks: StackInfo[], creation: Record<string, Frame[]>): void {
  const manifest = readJson(join(dir, 'manifest.json'));
  for (const [id, artifact] of Object.entries<RawArtifact>(manifest.artifacts ?? {})) {
    if (artifact.type === 'cdk:cloud-assembly' && artifact.properties?.directoryName) {
      collectStacks(join(dir, artifact.properties.directoryName), appDir, stacks, creation);
      continue;
    }
    if (artifact.type !== 'aws:cloudformation:stack') continue;
    const env = artifact.environment && artifact.environment !== AGNOSTIC_ENV ? artifact.environment : undefined;
    stacks.push({ path: artifact.displayName ?? id, ...(env ? { env } : {}) });
    if (!artifact.additionalMetadataFile) continue;
    const metadata = readJson(join(dir, artifact.additionalMetadataFile)) as Record<string, { type: string; data: unknown }[]>;
    for (const [path, entries] of Object.entries(metadata)) {
      const entry = entries.find((e) => e.type === 'aws:cdk:creationStack');
      if (!entry || !Array.isArray(entry.data)) continue;
      const frames = parseCreationStack(entry.data as string[], appDir);
      if (frames.length) creation[path.replace(/^\//, '')] = frames;
    }
  }
}
