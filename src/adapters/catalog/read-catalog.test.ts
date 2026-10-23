import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entryFor, searchCatalog, type Catalog } from '../../core/catalog.ts';
import { MIN_CDK_LIB_VERSION } from '../../core/support.ts';
import { fixtureDir } from '../../../test/support/fixture.ts';
import { loadCatalog } from './read-catalog.ts';

const installedCdkLib = join(fixtureDir('straight-line'), 'node_modules', 'aws-cdk-lib');

let scratch: string;
let cacheDir: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'truss-catalog-'));
  cacheDir = join(scratch, 'cache');
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A cache of its own, so a test can't be answered by what another left; `aws-cdk-lib`'s digest is carried over, because reading it takes seconds. */
let cacheCount = 0;
function freshCache(withCdkLib = true): string {
  const dir = join(scratch, `cache${cacheCount++}`);
  mkdirSync(dir);
  if (withCdkLib) for (const f of readdirSync(cacheDir)) if (f.startsWith('aws-cdk-lib@')) copyFileSync(join(cacheDir, f), join(dir, f));
  return dir;
}

let appCount = 0;
/** An app folder under the scratch dir with the given package.json and installed packages. */
function makeApp(pkg: Record<string, unknown>, installed: Record<string, 'real-cdk-lib' | { version: string; files?: Record<string, string | Buffer>; deps?: Record<string, string> }> = {}): string {
  const dir = join(scratch, `app${appCount++}`);
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [name, what] of Object.entries(installed)) {
    const at = join(dir, 'node_modules', name);
    mkdirSync(join(at, '..'), { recursive: true });
    if (what === 'real-cdk-lib') {
      symlinkSync(installedCdkLib, at);
      continue;
    }
    mkdirSync(at);
    writeFileSync(join(at, 'package.json'), JSON.stringify({ name, version: what.version, dependencies: what.deps }));
    for (const [file, content] of Object.entries(what.files ?? {})) writeFileSync(join(at, file), content);
  }
  return dir;
}

const lib = (name: string, version: string, types: Record<string, unknown>) => JSON.stringify({ name, version, types });
const queueish = (extra: Record<string, unknown> = {}) => ({
  'my-constructs.Queueish': {
    kind: 'class',
    fqn: 'my-constructs.Queueish',
    name: 'Queueish',
    assembly: 'my-constructs',
    base: 'constructs.Construct',
    docs: { summary: 'A third-party construct.' },
    initializer: {
      parameters: [
        { name: 'scope', type: { fqn: 'constructs.Construct' } },
        { name: 'id', type: { primitive: 'string' } },
        { name: 'props', type: { fqn: 'my-constructs.QueueishProps' } },
      ],
    },
    ...extra,
  },
  'my-constructs.QueueishProps': {
    kind: 'interface',
    datatype: true,
    fqn: 'my-constructs.QueueishProps',
    name: 'QueueishProps',
    interfaces: ['aws-cdk-lib.aws_lambda.FunctionOptions'],
    properties: [{ name: 'queueName', type: { primitive: 'string' }, docs: { summary: 'The name.' } }],
  },
});

const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
};

describe('loadCatalog on the installed aws-cdk-lib', () => {
  let catalog: Catalog;
  beforeAll(async () => {
    const result = await loadCatalog(fixtureDir('straight-line'), { cacheDir, log: () => undefined });
    if (!result.ok) throw new Error(result.message);
    catalog = result.catalog;
  }, 120_000);

  it('knows the common constructs, each at its tier', () => {
    expect(entryFor(catalog, 'aws-cdk-lib.aws_s3.Bucket')).toMatchObject({ tier: 'L2', service: 'S3', cfnType: 'AWS::S3::Bucket' });
    expect(entryFor(catalog, 'aws-cdk-lib.aws_s3.CfnBucket')).toMatchObject({ tier: 'L1', cfnType: 'AWS::S3::Bucket' });
    expect(entryFor(catalog, 'aws-cdk-lib.aws_dynamodb.Table')).toMatchObject({ tier: 'L2' });
    expect(entryFor(catalog, 'aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService')).toMatchObject({ tier: 'L3', service: 'ECS' });
  });

  it('does not offer Stacks, Stages or abstract bases', () => {
    for (const fqn of ['aws-cdk-lib.Stack', 'aws-cdk-lib.Stage', 'aws-cdk-lib.App', 'aws-cdk-lib.Resource', 'constructs.Construct']) {
      expect(entryFor(catalog, fqn), fqn).toBeUndefined();
    }
  });

  it('flags the props a Function cannot be made without', () => {
    const required = entryFor(catalog, 'aws-cdk-lib.aws_lambda.Function')!.props.filter((p) => p.required).map((p) => p.name);
    expect(required).toEqual(expect.arrayContaining(['code', 'handler', 'runtime']));
    expect(entryFor(catalog, 'aws-cdk-lib.aws_lambda.Function')!.props.find((p) => p.name === 'memorySize')).toMatchObject({ required: false, type: 'number' });
  });

  it('flattens the props a props struct inherits', () => {
    // `timeout` is declared on FunctionOptions, which FunctionProps extends.
    const names = entryFor(catalog, 'aws-cdk-lib.aws_lambda.Function')!.props.map((p) => p.name);
    expect(names).toContain('timeout');
    expect(names).toContain('runtime');
    expect(names.filter((n) => n === 'handler')).toHaveLength(1);
  });

  it('shows CDK defaults as text', () => {
    expect(entryFor(catalog, 'aws-cdk-lib.aws_lambda.Function')!.props.find((p) => p.name === 'memorySize')?.default).toMatch(/128/);
  });

  it('searches by name, service and CloudFormation type, and shows the tier of each hit', () => {
    expect(searchCatalog(catalog, 'bucket')[0]).toMatchObject({ fqn: 'aws-cdk-lib.aws_s3.Bucket', tier: 'L2' });
    expect(searchCatalog(catalog, 'dynamodb').map((h) => h.name)).toContain('Table');
    expect(searchCatalog(catalog, 'AWS::SQS::Queue').map((h) => h.fqn)).toEqual(expect.arrayContaining(['aws-cdk-lib.aws_sqs.Queue', 'aws-cdk-lib.aws_sqs.CfnQueue']));
    expect(searchCatalog(catalog, 'fargate').some((h) => h.tier === 'L3')).toBe(true);
  });
});

describe('loadCatalog with other libraries installed', () => {
  const direct = { dependencies: { 'aws-cdk-lib': '^2.274.0', 'my-constructs': '^1.0.0' } };

  it('includes the constructs of a directly installed jsii library, with the props its structs inherit from aws-cdk-lib', async () => {
    const dir = makeApp(direct, {
      'aws-cdk-lib': 'real-cdk-lib',
      'my-constructs': { version: '1.0.0', files: { '.jsii': lib('my-constructs', '1.0.0', queueish()) } },
    });
    const result = await loadCatalog(dir, { cacheDir: freshCache(), log: () => undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = entryFor(result.catalog, 'my-constructs.Queueish');
    expect(entry).toMatchObject({ library: 'my-constructs', tier: 'L2', summary: 'A third-party construct.' });
    expect(entry!.props.map((p) => p.name)).toEqual(expect.arrayContaining(['timeout', 'queueName']));
    expect(searchCatalog(result.catalog, 'queueish')[0]?.fqn).toBe('my-constructs.Queueish');
  });

  it('reads an assembly a `.jsii` file redirects to a gzipped file', async () => {
    const dir = makeApp(direct, {
      'aws-cdk-lib': 'real-cdk-lib',
      'my-constructs': {
        version: '1.0.0',
        files: {
          '.jsii': JSON.stringify({ schema: 'jsii/file-redirect', compression: 'gzip', filename: '.jsii.gz' }),
          '.jsii.gz': gzipSync(lib('my-constructs', '1.0.0', queueish())),
        },
      },
    });
    const result = await loadCatalog(dir, { cacheDir: freshCache(), log: () => undefined });
    expect(result.ok && entryFor(result.catalog, 'my-constructs.Queueish')).toBeTruthy();
  });

  it('does not follow a redirect out of the package', async () => {
    const dir = makeApp(direct, {
      'aws-cdk-lib': 'real-cdk-lib',
      'my-constructs': { version: '1.0.0', files: { '.jsii': JSON.stringify({ schema: 'jsii/file-redirect', filename: '../../package.json' }) } },
    });
    const { lines, log } = quiet();
    const result = await loadCatalog(dir, { cacheDir: freshCache(), log });
    expect(result.ok).toBe(true);
    expect(lines.join('\n')).toContain('my-constructs');
  });

  it('logs a library whose assembly will not load, and carries on without it', async () => {
    const dir = makeApp(direct, {
      'aws-cdk-lib': 'real-cdk-lib',
      'my-constructs': { version: '1.0.0', files: { '.jsii': '{ not json' } },
    });
    const { lines, log } = quiet();
    const result = await loadCatalog(dir, { cacheDir: freshCache(), log });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('my-constructs');
    expect(entryFor(result.catalog, 'aws-cdk-lib.aws_s3.Bucket')).toBeDefined();
    expect(result.catalog.entries.some((e) => e.library === 'my-constructs')).toBe(false);
  });

  it('is quiet about a dependency that ships no assembly, or is not installed', async () => {
    const dir = makeApp(
      { dependencies: { 'aws-cdk-lib': '^2.274.0', lodash: '^4.0.0', missing: '^1.0.0' } },
      { 'aws-cdk-lib': 'real-cdk-lib', lodash: { version: '4.17.21' } },
    );
    const { lines, log } = quiet();
    expect((await loadCatalog(dir, { cacheDir: freshCache(), log })).ok).toBe(true);
    expect(lines).toEqual([]);
  });

  it('ignores a library the app only has installed through another package', async () => {
    const dir = makeApp(
      { dependencies: { 'aws-cdk-lib': '^2.274.0' } },
      { 'aws-cdk-lib': 'real-cdk-lib', 'my-constructs': { version: '1.0.0', files: { '.jsii': lib('my-constructs', '1.0.0', queueish()) } } },
    );
    const result = await loadCatalog(dir, { cacheDir: freshCache(), log: () => undefined });
    expect(result.ok && result.catalog.entries.some((e) => e.library === 'my-constructs')).toBe(false);
  });

  it('finds a package hoisted into a folder above the app', async () => {
    const root = makeApp({ private: true }, { 'my-constructs': { version: '1.0.0', files: { '.jsii': lib('my-constructs', '1.0.0', queueish()) } }, 'aws-cdk-lib': 'real-cdk-lib' });
    const dir = join(root, 'packages', 'web');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(direct));
    const result = await loadCatalog(dir, { cacheDir: freshCache(), log: () => undefined });
    expect(result.ok && entryFor(result.catalog, 'my-constructs.Queueish')).toBeTruthy();
  });
});

describe('loadCatalog cache', () => {
  const direct = { dependencies: { 'aws-cdk-lib': '^2.274.0', 'my-constructs': '^1.0.0' } };
  const install = (version: string, jsii: string) => ({ 'aws-cdk-lib': 'real-cdk-lib' as const, 'my-constructs': { version, files: { '.jsii': jsii } } });

  it('reads a library once per name and version', async () => {
    const cache = freshCache();
    const dir = makeApp(direct, install('1.0.0', lib('my-constructs', '1.0.0', queueish())));
    expect((await loadCatalog(dir, { cacheDir: cache, log: () => undefined })).ok).toBe(true);
    // Same name and version, but unreadable now: only the cache can answer.
    writeFileSync(join(dir, 'node_modules/my-constructs/.jsii'), '{ not json');
    const { lines, log } = quiet();
    const again = await loadCatalog(dir, { cacheDir: cache, log });
    expect(lines).toEqual([]);
    expect(again.ok && entryFor(again.catalog, 'my-constructs.Queueish')).toBeTruthy();
  });

  it('reads the library again when its version changes', async () => {
    const cache = freshCache();
    const dir = makeApp(direct, install('1.0.0', lib('my-constructs', '1.0.0', queueish())));
    await loadCatalog(dir, { cacheDir: cache, log: () => undefined });
    writeFileSync(join(dir, 'node_modules/my-constructs/package.json'), JSON.stringify({ name: 'my-constructs', version: '1.1.0' }));
    writeFileSync(join(dir, 'node_modules/my-constructs/.jsii'), lib('my-constructs', '1.1.0', queueish({ docs: { summary: 'Now better.' } })));
    const again = await loadCatalog(dir, { cacheDir: cache, log: () => undefined });
    expect(again.ok && entryFor(again.catalog, 'my-constructs.Queueish')?.summary).toBe('Now better.');
  });

  it('ignores a cache entry it cannot use', async () => {
    const cache = freshCache();
    const dir = makeApp(direct, install('1.0.0', lib('my-constructs', '1.0.0', queueish())));
    await loadCatalog(dir, { cacheDir: cache, log: () => undefined });
    for (const f of readdirSync(cache)) writeFileSync(join(cache, f), '{"format":0}');
    const again = await loadCatalog(dir, { cacheDir: cache, log: () => undefined });
    expect(again.ok && entryFor(again.catalog, 'my-constructs.Queueish')).toBeTruthy();
  });

  it('works without a cache folder, and when the cache folder cannot be written', async () => {
    const dir = makeApp(direct, install('1.0.0', lib('my-constructs', '1.0.0', queueish())));
    const blocked = join(scratch, 'blocked');
    writeFileSync(blocked, 'a file, not a folder');
    for (const opts of [{ log: () => undefined }, { cacheDir: join(blocked, 'inside'), log: () => undefined }]) {
      const result = await loadCatalog(dir, opts);
      expect(result.ok && entryFor(result.catalog, 'my-constructs.Queueish')).toBeTruthy();
    }
  });
});

describe('loadCatalog refusals', () => {
  const refusal = async (dir: string) => {
    const result = await loadCatalog(dir, { cacheDir: freshCache(false), log: () => undefined });
    if (result.ok) throw new Error('expected a refusal');
    return result.message;
  };
  const cdkLib = (version: string, deps?: Record<string, string>) => ({ 'aws-cdk-lib': { version, ...(deps ? { deps } : {}) } });

  it('refuses an aws-cdk-lib below the minimum, before reading anything from it', async () => {
    const dir = makeApp({ dependencies: { 'aws-cdk-lib': '2.100.0' } }, cdkLib('2.100.0'));
    const message = await refusal(dir);
    expect(message).toContain('2.100.0');
    expect(message).toContain(MIN_CDK_LIB_VERSION);
  });

  it('refuses CDK v1', async () => {
    const dir = makeApp({ dependencies: { '@aws-cdk/core': '1.204.0' } }, { '@aws-cdk/core': { version: '1.204.0' } });
    expect(await refusal(dir)).toMatch(/CDK v1/);
  });

  it('refuses an app with nothing installed', async () => {
    expect(await refusal(makeApp({ dependencies: { 'aws-cdk-lib': '^2.0.0' } }))).toMatch(/npm install/);
  });

  it('refuses an app whose aws-cdk-lib writes a newer cloud assembly schema than the bundled toolkit-lib reads', async () => {
    const dir = makeApp({ dependencies: { 'aws-cdk-lib': '^2.999.0' } }, cdkLib('2.999.0', { '@aws-cdk/cloud-assembly-schema': '^999.0.0' }));
    expect(await refusal(dir)).toMatch(/upgrade Truss/i);
  });

  it('refuses an app whose aws-cdk-lib assembly cannot be read, since nothing could be placed', async () => {
    const dir = makeApp({ dependencies: { 'aws-cdk-lib': '^2.274.0' } }, { 'aws-cdk-lib': { version: '2.274.0', files: { '.jsii': '{ not json' } } });
    expect(await refusal(dir)).toMatch(/aws-cdk-lib/);
  });
});
