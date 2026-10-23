import { mkdirSync } from 'node:fs';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { buildCatalog, DIGEST_FORMAT, digestAssembly, type AssemblyDigest } from '../../core/catalog.ts';
import type { CatalogLoad } from '../../core/ports.ts';
import { checkSupported } from '../../core/support.ts';

const gunzipAsync = promisify(gunzip);

const CDK_LIB = 'aws-cdk-lib';

export interface LoadCatalogOptions {
  /** Where each library's digest is kept, by name and version. Without one nothing is cached. */
  cacheDir?: string;
  /** Where a library that can't be read is reported: the terminal. */
  log: (line: string) => void;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

async function readJsonIfThere(file: string): Promise<Json | undefined> {
  try {
    const json = await readJson(file);
    return isObject(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

/** The folder of an installed package, found the way `require` would: `node_modules` here, then in each folder above. */
async function findPackageDir(from: string, name: string): Promise<string | undefined> {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (await readJsonIfThere(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The major version of the cloud assembly schema the bundled toolkit-lib reads; infinite when it can't be found, which skips the check. */
async function bundledSchemaMajor(): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const toolkit = await findPackageDir(here, '@aws-cdk/toolkit-lib');
  const schema = toolkit && (await findPackageDir(toolkit, '@aws-cdk/cloud-assembly-schema'));
  const version = schema && (await readJsonIfThere(join(schema, 'package.json')))?.['version'];
  const major = typeof version === 'string' ? Number(version.split('.')[0]) : NaN;
  return Number.isInteger(major) ? major : Infinity;
}

/** Reads a package's jsii assembly: `.jsii` holds it, or names the (usually gzipped) file that does. */
async function readAssembly(pkgDir: string): Promise<unknown> {
  const file = await readFile(join(pkgDir, '.jsii'));
  const first: unknown = JSON.parse(file.toString('utf8'));
  if (!isObject(first) || first['schema'] !== 'jsii/file-redirect') return first;
  const filename = first['filename'];
  if (typeof filename !== 'string' || isAbsolute(filename) || normalize(filename).startsWith('..')) {
    throw new Error(`.jsii redirects to ${JSON.stringify(filename)}, outside the package`);
  }
  const target = await readFile(join(pkgDir, filename));
  return JSON.parse((first['compression'] === 'gzip' ? await gunzipAsync(target) : target).toString('utf8'));
}

const isDigest = (v: unknown, name: string, version: string): v is AssemblyDigest =>
  isObject(v) && v['format'] === DIGEST_FORMAT && v['name'] === name && v['version'] === version && Array.isArray(v['classes']) && Array.isArray(v['structs']);

async function digestOf(pkgDir: string, name: string, version: string, cacheDir: string | undefined): Promise<AssemblyDigest> {
  const cacheFile = cacheDir && join(cacheDir, `${name.replace(/[\\/]/g, '__')}@${version}.json`);
  if (cacheFile) {
    const cached = await readJsonIfThere(cacheFile);
    if (isDigest(cached, name, version)) return cached;
  }
  const digest = digestAssembly(await readAssembly(pkgDir));
  if (cacheDir && cacheFile) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(digest));
      await rename(tmp, cacheFile);
    } catch {
      // A cache that can't be written costs the next start a re-read, nothing more.
    }
  }
  return digest;
}

/**
 * Builds the Catalog from what the app has installed (ADR 0009, ADR 0010): `aws-cdk-lib`'s assembly,
 * resolved from the app folder as the app's own code would, and that of every direct dependency that
 * ships one. Refuses an app Truss can't support before it reads anything large. A library whose assembly
 * won't load is logged and left out, as if it were plain TypeScript; that is never a failure.
 */
export async function loadCatalog(appDir: string, opts: LoadCatalogOptions): Promise<CatalogLoad> {
  const appPackage = (await readJsonIfThere(join(appDir, 'package.json'))) ?? {};
  const dependencyNames = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = appPackage[field];
    if (isObject(deps)) for (const name of Object.keys(deps)) dependencyNames.add(name);
  }

  const cdkDir = await findPackageDir(appDir, CDK_LIB);
  const cdkPackage = cdkDir ? await readJsonIfThere(join(cdkDir, 'package.json')) : undefined;
  const cdkDeps = cdkPackage?.['dependencies'];
  const schemaRange = isObject(cdkDeps) ? cdkDeps['@aws-cdk/cloud-assembly-schema'] : undefined;
  const version = cdkPackage?.['version'];
  const support = checkSupported(
    {
      cdkLibVersion: typeof version === 'string' ? version : undefined,
      usesCdkV1: dependencyNames.has('@aws-cdk/core'),
      schemaRange: typeof schemaRange === 'string' ? schemaRange : undefined,
    },
    { schemaMajor: await bundledSchemaMajor() },
  );
  if (!support.ok) return support;

  const digests: AssemblyDigest[] = [];
  try {
    digests.push(await digestOf(cdkDir!, CDK_LIB, version as string, opts.cacheDir));
  } catch (err) {
    return { ok: false, message: `Couldn't read the constructs of ${CDK_LIB} ${String(version)}: ${err instanceof Error ? err.message : String(err)}` };
  }

  for (const name of [...dependencyNames].filter((n) => n !== CDK_LIB).sort()) {
    const dir = await findPackageDir(appDir, name);
    const libVersion = dir && (await readJsonIfThere(join(dir, 'package.json')))?.['version'];
    if (!dir || typeof libVersion !== 'string') continue;
    // Without an assembly it is a plain TypeScript library, which needs no word.
    if (!(await exists(join(dir, '.jsii')))) continue;
    try {
      digests.push(await digestOf(dir, name, libVersion, opts.cacheDir));
    } catch (err) {
      opts.log(`Couldn't read the constructs of ${name} ${libVersion}, so Truss treats it as plain TypeScript: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: true, catalog: buildCatalog(digests) };
}
