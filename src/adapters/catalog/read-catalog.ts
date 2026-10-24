import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { buildCatalog, DIGEST_FORMAT, digestAssembly, type AssemblyDigest } from '../../core/catalog.ts';
import { OVERLAYS } from '../../core/overlays/index.ts';
import type { CatalogLoad, LoadCatalog } from '../../core/ports.ts';
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

/** The major version of the cloud assembly schema the bundled toolkit-lib reads; infinite when it can't be found, which skips the check (the caller says so). */
async function bundledSchemaMajor(): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const toolkit = await findPackageDir(here, '@aws-cdk/toolkit-lib');
  const schema = toolkit && (await findPackageDir(toolkit, '@aws-cdk/cloud-assembly-schema'));
  const version = schema && (await readJsonIfThere(join(schema, 'package.json')))?.version;
  const major = typeof version === 'string' ? Number(version.split('.')[0]) : NaN;
  return Number.isInteger(major) ? major : Infinity;
}

/** Reads a package's jsii assembly: `.jsii` holds it, or names the (usually gzipped) file that does. */
async function readAssembly(pkgDir: string): Promise<unknown> {
  const file = await readFile(join(pkgDir, '.jsii'));
  const first: unknown = JSON.parse(file.toString('utf8'));
  if (!isObject(first) || first.schema !== 'jsii/file-redirect') return first;
  const filename = first.filename;
  if (typeof filename !== 'string' || isAbsolute(filename) || normalize(filename).startsWith('..')) {
    throw new Error(`.jsii redirects to ${JSON.stringify(filename)}, outside the package`);
  }
  const target = await readFile(join(pkgDir, filename));
  return JSON.parse((first.compression === 'gzip' ? await gunzipAsync(target) : target).toString('utf8'));
}

const isDigest = (v: unknown, name: string, version: string): v is AssemblyDigest =>
  isObject(v) &&
  v.format === DIGEST_FORMAT &&
  v.name === name &&
  v.version === version &&
  Array.isArray(v.classes) &&
  Array.isArray(v.structs) &&
  Array.isArray(v.interfaces) &&
  Array.isArray(v.enums) &&
  isObject(v.enumMembers);

async function digestOf(
  pkgDir: string,
  name: string,
  version: string,
  cacheDir: string | undefined,
): Promise<AssemblyDigest> {
  const cacheFile = cacheDir && join(cacheDir, `${name.replace(/[\\/]/g, '__')}@${version}.json`);
  if (cacheFile) {
    const cached = await readJsonIfThere(cacheFile);
    if (isDigest(cached, name, version)) return cached;
  }
  const digest = digestAssembly(await readAssembly(pkgDir));
  if (cacheDir && cacheFile) {
    try {
      await mkdir(cacheDir, { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(digest));
      await rename(tmp, cacheFile);
    } catch {
      // A cache that can't be written costs the next start a re-read, nothing more.
    }
  }
  return digest;
}

/** One installed library whose assembly goes into the Catalog. */
interface Library {
  name: string;
  version: string;
  dir: string;
}

type Scan = { ok: true; cdkLib: Library; others: Library[]; schemaUnknown: boolean } | { ok: false; message: string };

/**
 * Looks at what the app has installed, reading nothing large: refuses an app Truss can't support, and
 * lists the libraries whose assemblies the Catalog is built from, `aws-cdk-lib` and every direct
 * dependency that ships one (ADR 0009, ADR 0010). Cheap enough to run on every change to the app.
 */
async function scanApp(appDir: string): Promise<Scan> {
  const appPackage = (await readJsonIfThere(join(appDir, 'package.json'))) ?? {};
  const dependencyNames = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = appPackage[field];
    if (isObject(deps)) for (const name of Object.keys(deps)) dependencyNames.add(name);
  }

  const cdkDir = await findPackageDir(appDir, CDK_LIB);
  const cdkPackage = cdkDir ? await readJsonIfThere(join(cdkDir, 'package.json')) : undefined;
  const cdkDeps = cdkPackage?.dependencies;
  const schemaRange = isObject(cdkDeps) ? cdkDeps['@aws-cdk/cloud-assembly-schema'] : undefined;
  const version = cdkPackage?.version;
  const schemaMajor = await bundledSchemaMajor();
  const cdkLibVersion = typeof version === 'string' ? version : undefined;
  const support = checkSupported(
    {
      cdkLibVersion,
      usesCdkV1: dependencyNames.has('@aws-cdk/core'),
      schemaRange: typeof schemaRange === 'string' ? schemaRange : undefined,
    },
    { schemaMajor },
  );
  if (!support.ok) return support;
  if (!cdkDir || cdkLibVersion === undefined) return { ok: false, message: `${CDK_LIB} isn't installed for this app.` };

  const others: Library[] = [];
  for (const name of [...dependencyNames].filter((n) => n !== CDK_LIB).sort()) {
    const dir = await findPackageDir(appDir, name);
    const libVersion = dir && (await readJsonIfThere(join(dir, 'package.json')))?.version;
    if (!dir || typeof libVersion !== 'string') continue;
    // Without an assembly it is a plain TypeScript library, which needs no word.
    if (await exists(join(dir, '.jsii'))) others.push({ name, version: libVersion, dir });
  }
  return {
    ok: true,
    cdkLib: { name: CDK_LIB, version: cdkLibVersion, dir: cdkDir },
    others,
    schemaUnknown: schemaMajor === Infinity,
  };
}

/** Builds the Catalog of a scanned app, with the Overlays laid over it. A library that won't load is logged and left out, except `aws-cdk-lib`, without which nothing could be placed. */
async function buildFrom(scan: Extract<Scan, { ok: true }>, opts: LoadCatalogOptions): Promise<CatalogLoad> {
  if (scan.schemaUnknown)
    opts.log(
      "Couldn't find the cloud assembly schema Truss bundles, so Truss can't tell whether this app's CDK is too new for it.",
    );
  const { cdkLib } = scan;
  const digests: AssemblyDigest[] = [];
  try {
    digests.push(await digestOf(cdkLib.dir, cdkLib.name, cdkLib.version, opts.cacheDir));
  } catch (err) {
    return {
      ok: false,
      message: `Couldn't read the constructs of ${CDK_LIB} ${cdkLib.version}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  for (const { dir, name, version } of scan.others) {
    try {
      digests.push(await digestOf(dir, name, version, opts.cacheDir));
    } catch (err) {
      opts.log(
        `Couldn't read the constructs of ${name} ${version}, so Truss treats it as plain TypeScript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const catalog = buildCatalog(digests, OVERLAYS);
  // An Overlay is written against the CI baseline, so on another version some of its items may not resolve: that is for the terminal, never a Problem.
  for (const line of catalog.dropped) opts.log(line);
  return { ok: true, catalog };
}

/**
 * Builds the Catalog from what the app has installed (ADR 0009, ADR 0010). Refuses an app Truss can't
 * support before it reads anything large.
 */
export async function loadCatalog(appDir: string, opts: LoadCatalogOptions): Promise<CatalogLoad> {
  const scan = await scanApp(appDir);
  return scan.ok ? buildFrom(scan, opts) : scan;
}

/**
 * A `loadCatalog` that can be asked again whenever the app changes. While the installed versions of
 * `aws-cdk-lib` and the other libraries are the same it answers with the Catalog it already built; when
 * one changes it builds a new one, from the cache when that version was read before (ADR 0009).
 */
export function createCatalogLoader(opts: LoadCatalogOptions): LoadCatalog {
  const last = new Map<string, { versions: string; load: CatalogLoad }>();
  return async (appDir) => {
    const scan = await scanApp(appDir);
    if (!scan.ok) return scan;
    const versions = [scan.cdkLib, ...scan.others].map((l) => `${l.name}@${l.version}`).join(' ');
    const before = last.get(appDir);
    if (before?.versions === versions) return before.load;
    const load = await buildFrom(scan, opts);
    if (load.ok) last.set(appDir, { versions, load });
    return load;
  };
}
