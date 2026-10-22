# Construct metadata from aws-cdk-lib

Research for ticket 02-jsii-metadata (resolved; see the Truss v1 map, #8). Measured 2026-10-22 against `aws-cdk-lib@2.274.0` (latest on npm, published 2026-10-20), with `aws-cdk-lib@2.200.0` (2025-06-02) used for the stability comparison. All numbers come from downloading the tarballs with `npm pack --ignore-scripts` and parsing the files with Python. No package code was run.

## TL;DR

- `aws-cdk-lib` ships a complete **jsii assembly** (`.jsii`, which is a redirect to `.jsii.gz`). It is machine-readable JSON covering every exported class, struct, interface and enum, along with docs. It can drive the catalog's **list of constructs, props (types, optional/required, documented defaults), docs and methods** with no hand-written data.
- It does **not** describe **what child constructs an L2/L3 creates**, and nothing else shipped in the package does either. Layers need a separate source. The realistic one is build-time synthesis: instantiate each construct in Node and walk `node.children` / `tree.json`.
- Size: **85.7 MB** of raw JSON (**8.5 MB** gzipped). Loading that into a browser as-is is too much. A build-time preprocessed catalog fits easily: **22.4 MB / 1.24 MB gz** without docs, or **36.6 MB / 2.95 MB gz** keeping summary, default and stability docs. It can also be split per service namespace for lazy loading (for example `aws_s3` is about 0.68 MB raw).
- Stability: within CDK v2 the hand-written (stable) API is close to append-only. L1s change constantly: there are new resources, and in recent versions L1 prop types widened from `string` to `string | IXxxRef`. Truss should pin one `aws-cdk-lib` version per catalog build and regenerate the catalog on upgrade.

## 1. What ships in the package

Files at the package root of `aws-cdk-lib@2.274.0` (tarball 37.7 MB, `dist.unpackedSize` 138.8 MB, 7,621 files):

| File | Size | Content |
|---|---|---|
| `.jsii` | 74 B | `{"schema":"jsii/file-redirect","compression":"gzip","filename":".jsii.gz"}` |
| `.jsii.gz` | 8,580,620 B (85,705,061 B decompressed) | The jsii assembly, schema `jsii/0.10.0`, built with jsii `5.9.56` |
| `.jsii.tabl.json.gz` | 12.2 MB (141 MB decompressed) | Rosetta "tablet": code examples translated into other jsii languages. Not useful to Truss. |
| `.warnings.jsii.js` | 253 KB | Runtime deprecation-warning shims |
| `*/lib/*.d.ts` | many | TypeScript declarations, an alternative but harder-to-consume source |

The redirect format (`jsii/file-redirect`) and the assembly schema are defined in `@jsii/spec` (npm `@jsii/spec@1.142.0`, source at [aws/jsii `packages/@jsii/spec`](https://github.com/aws/jsii/tree/main/packages/%40jsii/spec)). A consumer must follow the redirect and gunzip the file. `@jsii/spec` exports `loadAssemblyFromFile` / `loadAssemblyFromPath`, which do this. The type-system semantics are documented in the [jsii specification](https://aws.github.io/jsii/specification/2-type-system/). `jsii-reflect` (npm, 1.142.0) adds an object model on top of the assembly with inheritance resolution. It is what Construct Hub / `jsii-docgen` use to render the API docs at [constructs.dev](https://constructs.dev/packages/aws-cdk-lib).

**CloudFormation resource data is *not* shipped** inside `aws-cdk-lib`. The L1 classes are generated at CDK build time from `@aws-cdk/aws-service-spec` (a devDependency of aws-cdk-lib, `0.1.220` in 2.274.0, via `@aws-cdk/spec2cdk`; see the [aws-cdk repo `tools/@aws-cdk/spec2cdk`](https://github.com/aws/aws-cdk/tree/main/tools/%40aws-cdk/spec2cdk) and [cdklabs/awscdk-service-spec](https://github.com/cdklabs/awscdk-service-spec)). That data is published separately:

| Source | Size measured | Notes |
|---|---|---|
| `@aws-cdk/aws-service-spec@0.1.223` `db.json.gz` | 2.65 MB gz, 15.6 MB raw | Merged CFN registry schemas, the legacy resource spec, docs and SAM. It is CDK's own source of truth for L1s. |
| CFN registry schemas, `https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip` | 3.25 MB zip, 21 MB unzipped, 1,855 files | One JSON Schema per resource type (for example `aws-s3-bucket.json`). Has `properties`, `required`, `createOnlyProperties`, `readOnlyProperties`, `primaryIdentifier`, `definitions`. [CFN registry schema docs](https://docs.aws.amazon.com/cloudformation-cli/latest/userguide/resource-type-schema.html). |

These matter only if Truss wants CFN-level facts that the jsii data lacks, such as replacement-on-update (`createOnlyProperties`) or read-only attributes. The jsii L1 classes already carry the CFN docs and type names.

## 2. Can it drive a Construct catalog?

Counts are from `.jsii` at 2.274.0. There are 22,682 types: 18,582 interfaces (including structs), 3,455 classes and 645 enums, across 360 namespaces (submodules).

### Construct list (L1 / L2 / L3): yes, by inheritance

- Classes whose base chain reaches `constructs.Construct`: **2,478**.
- **L1**: base chain includes `aws-cdk-lib.CfnResource`. There are **1,897** of these, and 1,896 carry `docs.custom.cloudformationResource` (for example `"AWS::S3::Bucket"`) plus a static const `CFN_RESOURCE_TYPE_NAME`. Detection is reliable.
- **Non-L1 constructs**: **581**. Of these, 400 extend `aws-cdk-lib.Resource` (classic L2s) and 66 are `abstract` (bases such as `BucketBase` that should be hidden from the palette).
- **L3**: jsii has **no L2 vs L3 marker**. Patterns live in `*_patterns` namespaces (`aws_ecs_patterns`: 19 constructs, including `...ServiceBase` abstracts). Other "L3-ish" constructs (such as `aws_s3_deployment.BucketDeployment`) are indistinguishable from L2s. The L2/L3 label has to come from a curated overlay or a heuristic (namespace, or "does not extend `Resource`").
- Stability: constructs are `external` (1,892 L1s), `stable` (576) or `deprecated` (10). Deprecated items carry `docs.deprecated` text and can be filtered out.

### Props: yes

Each construct's `initializer.parameters` gives `(scope, id, props?)`, and `props.type.fqn` points to a struct (`datatype: true`), such as `aws_s3.BucketProps` or `aws_s3.CfnBucketProps`. Each struct property has:

- `name`, `type`. The type is a primitive, `fqn` reference, collection (`array`/`map`), or `union`. 2.274.0 also uses the `intersection-types` feature (`usedFeatures`).
- `optional: true` when not required. Across all L2/L3 props structs, including inherited interfaces: **6,386 props, 5,653 optional**.
- `docs.default`: **5,629 of 5,653 optional L2/L3 props** have one. **The default is free-form prose, not a value.** Examples: `"BucketAccessControl.PRIVATE"`, `"false"`, `"- The ABAC status is not set"`. It works as display text, but not as a reliable machine value for codegen. Truss should simply omit unset props in Export and let CDK apply its defaults.
- L1 props (`CfnBucketProps`) have **no `default` docs** (0 of 25 for S3). Required/optional does mirror CFN.
- Struct inheritance goes through `interfaces`, so a catalog builder must flatten it (jsii-reflect's `allProperties` does this).

### Docs: yes

Each type, property, method and parameter has `docs.summary`, `remarks`, `example`, `see` and `stability`. L1 docs are copied from the CFN user guide and link to it via `see`. Per-submodule README markdown is in `submodules[*].readme` (3.3 MB in total).

### Methods (`grantRead`, `addEventSource`, ...): yes, with caveats

- `methods[]` has `name`, `parameters` (types, optional, variadic), `returns` and docs. Methods are declared on the class that defines them, so `grantRead` sits on `aws_s3.BucketBase`, not `Bucket`, and walking `base` is needed.
- The parameter types are what make wiring possible. For example, `grantRead(identity: aws_iam.IGrantable, objectsKeyPattern?: any)` means "any Node implementing `IGrantable` can connect". Class `interfaces` lists implemented interfaces, which allows matching a Connection's source and target by type.
- Caveat: CDK is moving grants to a `grants` facade. `BucketBase.grantRead` docs now say *"The use of this method is discouraged. Please use `grants.read()` instead."* A catalog built from method names alone will drift. The connection layer (ticket 06) should treat this metadata as input to a curated mapping.

### Child constructs (for Layers): no

Nothing in `.jsii`, `.d.ts` or the service spec records which constructs a class creates in its constructor. It is imperative code, and it depends on props: for example `autoDeleteObjects: true` adds a custom-resource provider and a `BucketPolicy`. Options:

1. **Build-time synthesis (recommended to spike):** in Node, at catalog-build time, instantiate each L2/L3 in a throwaway `Stack` with minimal props, then walk `construct.node.children` recursively, or read the `tree.json` that `cdk synth` writes into `cdk.out` (the construct tree, with `fqn` per node via `constructInfo`). This gives the *default-props* tree. Per-Design trees could be recomputed for the actual props if aws-cdk-lib can run in the browser or a worker. **Not verified here**, because aws-cdk-lib's JS imports Node built-ins (`fs`, `path`, `child_process`) and the brief forbade running package code.
2. **Static source analysis** of `new X(this, ...)` calls in `lib/*.js`. This is brittle and ignores conditionals.
3. **Curated overlay** per construct. This is accurate where it matters but needs manual upkeep.

## 3. Size and browser loading

Measured by re-serialising `assembly.types` with compact JSON and gzip -9:

| Variant | Raw | gzip |
|---|---|---|
| Full `.jsii` (2.274.0) | 85.7 MB | 8.5 MB (as shipped) |
| `types` only | 82.3 MB | n/a |
| `types` minus all `docs`, `locationInModule`, `symbolId` | 22.4 MB | 1.24 MB |
| `types` keeping only `docs.summary/default/stability/deprecated` | 36.6 MB | 2.95 MB |

Biggest namespaces by raw bytes: `aws_quicksight` 7.8 MB, `interfaces` 4.2 MB (new resource-reference types), `aws_ec2` 3.6 MB, `aws_bedrockagentcore` 2.2 MB, `aws_sagemaker` 2.1 MB. `aws_s3` is 0.68 MB and `aws_lambda` 0.91 MB.

Conclusion: do not ship or parse the raw assembly in the browser. An 85 MB `JSON.parse` is slow and memory-heavy, and the assembly is mostly docs for L1s. Instead, run a **build-time catalog generator** (Node, using `@jsii/spec` or `jsii-reflect`) that emits a slim, Truss-shaped catalog. That catalog would flatten inheritance, resolve L1/L2/L3, drop the rosetta and long remarks, and split per namespace so the UI lazy-loads a service's file when it is first used. A version that is curated and focused on L2s will be well under 1 MB gzipped.

## 4. Stability across CDK versions

Diff of `aws-cdk-lib@2.200.0` (2025-06-02, `.jsii` 60.9 MB) vs `2.274.0` (2026-10-20, 85.7 MB):

- Types: 14,643 → 22,682 (+8,047, −8). L1s: 1,442 → 1,896, with **0 removed**.
- `stable` types removed: 1 (`aws-cdk-lib.ResourceEnvironment`, relocated under `aws-cdk-lib.interfaces`).
- `stable` struct props: 0 became required. 7 "disappeared" from their declaring interface, and all of those checked were moved up into a new parent interface (for example `aws_batch.ManagedEc2EcsComputeEnvironmentProps` now extends `ManagedEc2ComputeEnvironmentProps`). The props are still reachable after flattening, which is why the catalog must flatten.
- L1 props: 534 removals or type changes. The changes sampled were all **type widenings**, for example `CfnEIPProps.instanceId: string` → `string | interfaces.aws_ec2.IInstanceRef`. This is source-compatible for users, but a catalog's type model must handle unions.
- The assembly schema string has stayed `jsii/0.10.0` for years, while new type-system features are flagged in `usedFeatures` (`intersection-types` here). A generator should fail loudly on an unknown feature.

This matches CDK's policy. Stable v2 APIs follow semver and get no breaking changes outside major versions ([AWS CDK versioning](https://docs.aws.amazon.com/cdk/v2/guide/versioning.html)). L1s are regenerated from CFN weekly-ish, and every release adds resources. Implication for the "CDK version pinning" open item: tie each catalog build (and each Design) to one exact `aws-cdk-lib` version, and regenerate per upgrade. An upgrade is mostly additive, but the catalog diff should be reviewed.

## Sources

- npm: `aws-cdk-lib@2.274.0` and `@2.200.0` tarballs (`npm view aws-cdk-lib`, `npm pack`), https://www.npmjs.com/package/aws-cdk-lib
- jsii assembly spec and redirect schema: https://github.com/aws/jsii/tree/main/packages/%40jsii/spec, https://aws.github.io/jsii/specification/2-type-system/
- jsii-reflect: https://github.com/aws/jsii/tree/main/packages/jsii-reflect
- L1 generation: https://github.com/aws/aws-cdk/tree/main/tools/%40aws-cdk/spec2cdk, https://github.com/cdklabs/awscdk-service-spec, npm `@aws-cdk/aws-service-spec@0.1.223`
- CFN registry schemas: https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip (Last-Modified 2026-10-21), https://docs.aws.amazon.com/cloudformation-cli/latest/userguide/resource-type-schema.html
- CDK versioning and stability policy: https://docs.aws.amazon.com/cdk/v2/guide/versioning.html
- Construct tree / `tree.json`: https://docs.aws.amazon.com/cdk/v2/guide/constructs.html (construct tree), produced in `cdk.out` by `cdk synth`
