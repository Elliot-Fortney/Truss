# Import feasibility: recovering a Design from CDK TypeScript

Research for ticket 04-import-feasibility (resolved; see the Truss v1 map, #8). Done 2026-10-22 against `aws-cdk-lib@2.274.0` (npm latest), `aws/aws-cdk` at `main` commit `e07d99d` (2026-10-21), `aws/aws-cdk-cli` at `main` commit `85464af` (2026-10-22), `typescript@6.0.3` and `typescript@7.0.2`.

Claims marked **[exp]** were checked by experiment. The experiment synthesized a small app (an S3 `Bucket`, a Lambda `Function`, and `bucket.grantRead(fn)`) in a scratch directory with `aws-cdk-lib@2.274.0`. It also ran a TS compiler API script and a `require`-hook instrumentation script against that app. Experiment output is quoted where it matters.

## TL;DR

- **Synth output is the backbone.** `tree.json` gives the full construct tree: id, path, jsii FQN and version for every construct (L3 → L2 → L1). For L1s it also gives the CFN type and the _resolved_ CFN props. The CFN templates give connections as `Ref`/`Fn::GetAtt` plus IAM policy statements. Each resource carries `aws:cdk:path`, which joins it back to the tree. **L2/L3 props are not recorded** (only their L1 effects are).
- **Source locations come for free.** By default, every `CfnElement` and `Stack` records an `aws:cdk:creationStack` trace into `<stack>.metadata.json`. The trace is filtered to "just my code", so it points at the user line that called `new s3.Bucket(...)` **[exp]**. The new official `cdk lsp` (`@aws-cdk/cdk-explorer`) already maps these traces through `.js.map` source maps to `.ts` line and column. Caveat: Node's default 10-frame limit drops the call site of lazily created children such as a grant's `DefaultPolicy`. `--stack-trace-limit=50` recovers it, including the frame name `grantRead` **[exp]**.
- **Static TS AST analysis recovers what synth loses**: the authored L2/L3 props as source expressions, `grant*` / `add*` calls, variable names, and exact positions. It cannot handle loops, conditionals, helper functions, computed IDs, or anything that needs evaluation **[exp]**. It is also exposed to churn: **TypeScript 7.0 ships no stable programmatic API**. The `typescript@7.0.2` package exports only `unstable/*` entry points **[exp]**, and a stable API is promised for 7.1. Import must pin the TS 6 API (`@typescript/typescript6`).
- **Running the app with instrumentation** (a `require` hook that wraps `aws-cdk-lib` classes) captures the _actual_ constructor arguments of every user-authored construct, keyed by construct path **[exp]**. It is exact and handles loops, but it executes user code (Node only, needs trust, and may need AWS context lookups).
- **Recommended v2 Import = synth + static join.** Read `cdk.out` (tree.json + manifest metadata + templates) for structure, types and connections. Use creation-stack locations to join each construct to its `NewExpression` in the TS AST, and read authored props from there. Instrumentation is an optional precision upgrade. A browser-only Truss can take an uploaded `cdk.out` plus the source files. Running synth needs a local Node helper.
- **What v1 Exports must contain** (details in §6):
  1. Literal, stable construct IDs, because the construct path is the join key.
  2. A sidecar mapping file from Node ID to construct path to FQN, with a content hash per generated file.
  3. A per-Node marker comment in the code.
  4. A rigid, analysable code shape: one `new` per Node, inline literal props, and explicit `grant*` calls.
  5. Source maps on, with path metadata and creation stacks not disabled.

## 1. What each technique recovers

| Recovers                                                  | Synth: `tree.json`                                       | Synth: templates + `aws:cdk:path`                                 | Synth: manifest metadata (`*.metadata.json`)                                                                    | Static TS AST                                          | Instrumented run                                         |
| --------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Construct tree (L3→L2→L1)                                 | **Yes**, every construct incl. library-internal children | L1 only (via path)                                                | Paths of constructs with metadata                                                                               | Only what the user wrote; library internals invisible  | User-authored constructs (plus tree via `node.children`) |
| Construct type                                            | **jsii FQN + version** (`constructInfo`)                 | CFN type                                                          | No                                                                                                              | Resolved class symbol → `.d.ts` file (FQN derivable)   | jsii FQN via `Symbol.for('jsii.rtti')`                   |
| L1 props                                                  | **Resolved values** (`aws:cdk:cloudformation:props`)     | Resolved values                                                   | No                                                                                                              | Only if user wrote an L1                               | Yes                                                      |
| L2/L3 props                                               | **No**                                                   | No                                                                | Only if `@aws-cdk/core:enableAdditionalMetadataCollection` is on, and then **redacted** (strings/numbers → `*`) | **Yes**, as source expressions                         | **Yes**, as runtime values                               |
| Connections                                               | No (attributes only)                                     | **Yes**: `Ref`, `Fn::GetAtt`, `DependsOn`, IAM statements         | No                                                                                                              | Yes, as `grant*` calls and props referencing variables | Yes, if methods are wrapped too                          |
| Intent of connection (`grantRead` vs hand-written policy) | No                                                       | No: the grant becomes an `AWS::IAM::Policy` with expanded actions | Frame name `grantRead` in the creation stack, if the trace limit is high enough **[exp]**                       | **Yes**                                                | Yes                                                      |
| Source locations                                          | No                                                       | No                                                                | **Yes**: `aws:cdk:creationStack`, `aws:cdk:logicalId` trace, `aws:cdk:propertyAssignment` (debug)               | **Yes**, exact                                         | Yes (stack at construction)                              |
| Handles loops/conditionals/helpers                        | Yes (it is the result)                                   | Yes                                                               | Yes                                                                                                             | **No**                                                 | Yes                                                      |
| Needs to execute user code                                | Yes (`cdk synth`)                                        | Yes                                                               | Yes                                                                                                             | **No**                                                 | Yes                                                      |

## 2. Synth output in detail

### 2.1 `tree.json`

The `TreeMetadata` construct is attached to every `App`. During synthesis it walks the whole tree breadth-first and writes one node per construct: `{ id, path, children, attributes, constructInfo }` ([`core/lib/private/tree-metadata.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/private/tree-metadata.ts)). The file is registered in the manifest as artifact `Tree` of type `cdk:tree`.

- `constructInfo` is `{ fqn, version }`, read from the class's jsii runtime-type-info symbol `Symbol.for('jsii.rtti')`. The source calls this "the public contract of what shows up in tree.json. We are very unlikely to extend this in future" ([`core/lib/private/runtime-info.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/private/runtime-info.ts)). User-defined classes that are not jsii-compiled get no `constructInfo`.
- `attributes` come from constructs that implement `IInspectable.inspect(TreeInspector)` ([`core/lib/tree.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/tree.ts)). Every generated L1 adds `aws:cdk:cloudformation:type`, `aws:cdk:cloudformation:logicalId` and `aws:cdk:cloudformation:props` (`this.cfnProperties`), and the values are resolved against the stack ([`tools/@aws-cdk/spec2cdk/lib/cdk/resource-class.ts`](https://github.com/aws/aws-cdk/blob/main/tools/%40aws-cdk/spec2cdk/lib/cdk/resource-class.ts), constants in [`cloud-assembly-schema/.../metadata-schema.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/cloud-assembly-schema/lib/cloud-assembly/metadata-schema.ts)). L2s have no attributes.
- Large trees are split. Since recent versions the writer fragments the tree into a `tree-0.1` root plus `forest-0.1` files, using `SubTreeReference { fileName, treeId }`. A reader must follow those references (`tree-metadata.ts`, `FragmentedTreeWriter`).
- Any construct can add its own attributes by implementing `IInspectable`. cdk-dia uses exactly this for its `CdkDiaDecorator` ([cdk-dia README](https://github.com/pistazie/cdk-dia)). It is a supported channel for custom data into `tree.json`.

Experiment output (abridged) **[exp]**:

```
Demo                aws-cdk-lib.Stack
  Uploads           aws-cdk-lib.aws_s3.Bucket                       (no attributes)
    Resource        aws-cdk-lib.aws_s3.CfnBucket   AWS::S3::Bucket  props: versioningConfiguration
  Thumbnailer       aws-cdk-lib.aws_lambda.Function
    ServiceRole     aws-cdk-lib.aws_iam.Role
      Resource      aws-cdk-lib.aws_iam.CfnRole    AWS::IAM::Role
      DefaultPolicy aws-cdk-lib.aws_iam.Policy
        Resource    aws-cdk-lib.aws_iam.CfnPolicy  AWS::IAM::Policy props: policyDocument, policyName, roles
    Resource        aws-cdk-lib.aws_lambda.CfnFunction AWS::Lambda::Function props: code, handler, memorySize, role, runtime
```

The Bucket's authored `versioned: true` survives only as the L1's `versioningConfiguration`. Mapping L1 props back to L2 props is not generally invertible.

### 2.2 CloudFormation templates and `aws:cdk:path`

When context `aws:cdk:enable-path-metadata` is set, `CfnResource` writes `Metadata: { "aws:cdk:path": "<construct path>" }` into each resource ([`core/lib/cfn-resource.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/cfn-resource.ts); key defined in [`cloud-assembly-api/lib/metadata.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/cloud-assembly-api/lib/metadata.ts); context key in [`cx-api/lib/app.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/cx-api/lib/app.ts)). The CLI and toolkit-lib set that context **by default** (`settings.pathMetadata ?? true`, in [`toolkit-lib/.../environment.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/toolkit-lib/lib/api/cloud-assembly/environment.ts); CLI flag `--path-metadata`, "enabled by default"). A user who passes `--no-path-metadata` loses it, so Import should run synth itself or tolerate its absence. `tree.json`'s `aws:cdk:cloudformation:logicalId` gives the same join.

Connections are the intrinsic references. In the experiment the grant became **[exp]**:

```json
{
  "Action": ["s3:GetObject*", "s3:GetBucket*", "s3:List*"],
  "Effect": "Allow",
  "Resource": [
    { "Fn::GetAtt": ["Uploads4F6EB0FD", "Arn"] },
    { "Fn::Join": ["", [{ "Fn::GetAtt": ["Uploads4F6EB0FD", "Arn"] }, "/*"]] }
  ]
}
```

That statement sits in `ThumbnailerServiceRoleDefaultPolicy9BAC8CD0`, attached to the function's role. The template alone cannot say "`grantRead`" rather than "a hand-written policy with these actions". It can only be pattern-matched against known grant action sets. cdk-dia derives its edges exactly this way, by scanning `aws:cdk:cloudformation:props` in tree.json for `Ref` / `Fn::GetAtt` ([`src/diagram/aws/aws-edge-resolver.ts`](https://github.com/pistazie/cdk-dia/blob/main/src/diagram/aws/aws-edge-resolver.ts)).

Logical IDs are a function of the construct path: the human-readable components plus an 8-char hash of the full path, with `Default` removed and `Resource` hidden. Changing a construct ID after deploy replaces the resource ([CDK guide: Identifiers](https://docs.aws.amazon.com/cdk/v2/guide/identifiers.html); [`core/lib/private/uniqueid.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/private/uniqueid.ts)). This is why the construct path is the natural stable key across Export and Import.

### 2.3 Manifest metadata (`<stack>.metadata.json`)

Every construct's `node.metadata` entries are written, keyed by `/<construct path>`, into `<artifactId>.metadata.json`, which is referenced from `manifest.json` as `additionalMetadataFile` ([`core/lib/stack-synthesizers/_shared.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/stack-synthesizers/_shared.ts), `collectStackMetadata`). Entry shape is `{ type, data?, trace? }`. Relevant types ([`metadata-schema.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/cloud-assembly-schema/lib/cloud-assembly/metadata-schema.ts)):

| Type                                      | Written by                                        | Default?                                                                                                                          | Use for Import                           |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `aws:cdk:logicalId`                       | every `CfnElement`                                | yes, unless `aws:cdk:disable-logicalId-metadata`                                                                                  | path → logical ID                        |
| `aws:cdk:creationStack`                   | every `CfnElement` and `Stack` constructor        | **yes**, unless `aws:cdk:disable-creation-stack-traces` (re-enabled by `CDK_DEBUG`)                                               | **source location**                      |
| `aws:cdk:propertyAssignment`              | `traceProperty()` on later property mutation      | only with `CDK_DEBUG`                                                                                                             | where a prop was changed after creation  |
| `aws:cdk:analytics:construct` / `:method` | `addConstructMetadata` / `@MethodMetadata` on L2s | only with feature flag `@aws-cdk/core:enableAdditionalMetadataCollection`; values **redacted** to `*` except booleans/known enums | prop _shape_ only; not usable for values |
| any custom type                           | `node.addMetadata(type, data)`                    | yes                                                                                                                               | a channel for Truss markers (§6)         |

Sources: [`core/lib/cfn-element.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/cfn-element.ts), [`core/lib/stack.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/stack.ts), [`core/lib/metadata-resource.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/metadata-resource.ts), [`core/lib/debug.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/debug.ts), [`cx-api/lib/app.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/cx-api/lib/app.ts).

Creation stacks are captured with `Error.captureStackTrace` and rendered "just my code": frames in `node_modules`, `node:` internals and the jsii runtime are collapsed into `...new Bucket2 in aws-cdk-lib...` ([`core/lib/private/stack-trace.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/private/stack-trace.ts)). Note that only L1s and Stacks record a trace, not L2s. An L2's location is the user frame in its `Resource` child's trace. Experiment, default settings **[exp]**:

```
/Demo/Uploads/Resource  aws:cdk:creationStack  ["...new Bucket2 in aws-cdk-lib...", "<anonymous> (.../app/app.js:6:16)", ...]
/Demo/Thumbnailer/ServiceRole/DefaultPolicy/Resource  aws:cdk:creationStack
    ["...aws-cdk-lib...", "(no user code in 10 frames, use --stack-trace-limit to capture more)"]
```

With `node --stack-trace-limit=50` the policy's trace becomes `["...PropertyInjectable.grantRead in aws-cdk-lib...", "<anonymous> (.../app/app.js:10:8)"]`. That gives both the grant's call site and its method name. `CDK_DEBUG=true` alone does **not** fix this. It adds `aws:cdk:propertyAssignment` entries but keeps the 10-frame limit **[exp]**.

### 2.4 First-party tooling that already does this join

- **`@aws-cdk/cloud-assembly-api`** now exports `buildConstructTree()` / `ConstructIndex`. It reads `tree.json`, "joins it with each stack's manifest metadata to produce a construct tree where every CFN resource carries its logicalId and CFN type", and handles Stages (nested assemblies) and NestedStacks ([`construct-tree.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/cloud-assembly-api/lib/construct-tree.ts)). It also exports `resolveResourceRanges()` for character ranges of resources in a template ([`template-ranges.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/cloud-assembly-api/lib/template-ranges.ts)). **This is a ready-made reader for Import.**
- **`cdk lsp` / `@aws-cdk/cdk-explorer`** is a language server shipped in the CDK CLI. It "runs your CDK app, reads the synthesized cloud assembly", and offers code lenses on source lines that create resources plus go-to-definition from template to construct source ([README](https://github.com/aws/aws-cdk-cli/tree/main/packages/%40aws-cdk/cdk-explorer)). Its `SourceMapResolver` takes the creation-stack frames (`findCreationStackTrace` in toolkit-lib, which tries the `logicalId` trace and then `aws:cdk:creationStack`) and maps `.js` frames to `.ts` via sibling `.js.map` files ([`lib/core/source-resolver.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/cdk-explorer/lib/core/source-resolver.ts), [`toolkit-lib/.../stack-source-tracing.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/toolkit-lib/lib/api/source-tracing/private/stack-source-tracing.ts)). This is AWS's own proof that construct → source-line mapping from synth output works.
- **AWS Toolkit for VS Code "CDK Explorer"** (preview) shows a tree view built from `tree.json` ([docs](https://docs.aws.amazon.com/toolkit-for-vscode/latest/userguide/cdk-explorer.html)). It is read-only.

## 3. Static TypeScript AST analysis

The TS compiler API: `ts.createProgram` → `program.getTypeChecker()`, walking with `ts.forEachChild`, `checker.getSymbolAtLocation` / `getTypeAtLocation`, and `getLineAndCharacterOfPosition` for positions ([TypeScript wiki: Using the Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)). With `aws-cdk-lib`'s `.d.ts` on disk, the checker resolves `new s3.Bucket(...)` to its declaration in `aws-cdk-lib/aws-s3/lib/bucket.d.ts`. That maps to the jsii FQN `aws-cdk-lib.aws_s3.Bucket` and therefore to the catalog from ticket 02.

Experiment on a TS stack (TS 6.0.3) **[exp]**:

```
L8  new Bucket   [aws-cdk-lib/aws-s3/lib/bucket.d.ts]       id='Uploads'      props={ versioned: true }
L9  new Function [aws-cdk-lib/aws-lambda/lib/function.d.ts] id='Thumbnailer'  props={ runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code: lambda.Code.fromAsset('lambda'), memorySize: 512 }
L12 call bucket.grantRead(fn)
L13 new Bucket   [aws-cdk-lib/aws-s3/lib/bucket.d.ts]       id=`Logs-${name}` props=-
```

Line 13 sits in a `for` loop over `['a','b']`. The AST shows one site with a template-literal ID, while runtime produces two constructs. Static analysis therefore:

- **Recovers:** authored L2/L3 props as expressions (literals are exact; references such as `role: myRole` resolve to a variable and hence a Node), `grant*`/`add*` calls with receiver and argument, variable names (good default labels), exact source ranges, and comments (for markers).
- **Cannot recover:** constructs created inside loops, conditionals, helper functions or user-defined construct classes instantiated many times, or with computed IDs. It also misses anything library-internal (Layers below the authored level), context lookups, and values computed at runtime. These cases need synth.
- **Runs without executing user code**, and can run in the browser. The TS compiler runs in browsers, as the TS Playground shows. It needs `aws-cdk-lib` type declarations, or Truss can resolve import specifiers against its own jsii-derived catalog instead of full type checking.

**API churn risk.** TypeScript 7.0 (the Go-native compiler) shipped without a stable programmatic API. The 7.0 RC post says "we won't have a stable programmatic API available until at least several months from now with TypeScript 7.1", and points API consumers to the `@typescript/typescript6` package, which "re-exports the TypeScript 6.0 API" ([Announcing TypeScript 7.0 RC](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/)). The compiler-API wiki carries the same warning: "TypeScript 7.1 will have a completely different API". Installing `typescript@7.0.2` gives a package whose root exports only `version`, with everything else under `typescript/unstable/*` **[exp]**. Import's AST adapter should pin TS 6 (`typescript@6` / `@typescript/typescript6`) behind a port, so it can move to the 7.1 API later.

## 4. Running the app with instrumentation

The idea is to load the user's app in Node with a preload (`node -r ./instrument.js`). The preload wraps `aws-cdk-lib` module exports in a `Proxy` whose `construct` trap records `(node.path, jsii fqn, args[2])` for each construct the user instantiates directly. Library-internal children never pass through the user's `require`, so they are not recorded, and the recorded set is exactly the user-authored Nodes. Experiment output **[exp]**:

```
Demo/Uploads      aws-cdk-lib.aws_s3.Bucket        {"versioned":true}
Demo/Thumbnailer  aws-cdk-lib.aws_lambda.Function  {"runtime":"Runtime","handler":"index.handler","code":"InlineCode","memorySize":512}
```

- **Recovers:** exact runtime props of every authored construct, including those created in loops and helpers, keyed by the same construct path as `tree.json`. Construct-valued props can be mapped to paths by object identity. Wrapping instance methods the same way would capture `grant*` calls with their arguments.
- **Costs:** it executes user code (trust, AWS credentials, and context lookups that may need an account; `cdk lsp` reports "needs context lookups that are not in cdk.context.json" as a distinct failure: [`synth-runner.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/cdk-explorer/lib/core/synth-runner.ts)). It needs Node, so it cannot run in a browser-only Truss. It is fragile across module systems: ESM `import` bypasses `Module.prototype.require` and needs `module.register` loader hooks. Non-serialisable values (`Runtime`, `Code`, `Duration`) need per-type decoders, which ticket 02's catalog types can drive.
- Prior art: AWS PDK's `cdk-graph` instruments differently. You add `new CdkGraph(app)`, which traverses the tree at synth time and serialises a graph of nodes and edges. Its roadmap lists "Find alternative synthesis solution that doesn't utilize CDK internals" ([cdk-graph guide](https://github.com/aws/aws-pdk/blob/mainline/packages/cdk-graph/docs/developer_guides/cdk-graph/index.md)). The PDK "is no longer supported" ([aws-pdk README](https://github.com/aws/aws-pdk)).

## 5. Existing visualisers (CDK → picture)

| Tool                                                                                                                                                       | Input                                 | Edges from                                       | Notes                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **cdk-dia** ([repo](https://github.com/pistazie/cdk-dia), npm `cdk-dia@0.12.4`, updated 2026-09)                                                           | `cdk.out/tree.json` after `cdk synth` | `Ref`/`Fn::GetAtt` in L1 props and stack exports | Collapses L2s by default. A `CdkDiaDecorator` via `IInspectable` can expand or ignore a construct (TS/JS only). Graphviz output, plus experimental Cytoscape HTML. |
| **AWS PDK cdk-graph + diagram plugin** ([guide](https://github.com/aws/aws-pdk/blob/mainline/packages/cdk-graph/docs/developer_guides/cdk-graph/index.md)) | In-app construct at synth             | Graph built from tree + references               | PDK unsupported; points to the Nx Plugin for AWS.                                                                                                                  |
| **AWS Toolkit CDK Explorer** ([docs](https://docs.aws.amazon.com/toolkit-for-vscode/latest/userguide/cdk-explorer.html))                                   | `tree.json`                           | none (tree view only)                            | Preview, read-only.                                                                                                                                                |
| **`cdk lsp` / cdk-explorer** ([README](https://github.com/aws/aws-cdk-cli/tree/main/packages/%40aws-cdk/cdk-explorer))                                     | runs the app, reads `cdk.out`         | n/a                                              | Source ↔ construct ↔ template navigation via creation stacks and source maps.                                                                                      |

All of them read synth output. None recovers L2 props or intent, and none writes code back. Truss's Import would be the first to combine synth with source.

## 6. Recommendation for v2 Import, and what v1 Exports must contain

### Import pipeline (v2)

1. **Get a cloud assembly.** Either Truss runs `cdk synth` through a local Node helper (toolkit-lib), or the user uploads `cdk.out` (browser-only path). For best fidelity, synth with `node --stack-trace-limit=50` (via `NODE_OPTIONS`) and keep path metadata on.
2. **Build the construct tree** with `@aws-cdk/cloud-assembly-api`'s `buildConstructTree` (tree.json + metadata + logical IDs, with Stages and NestedStacks handled). Nodes come from FQNs, and Layers from the tree.
3. **Derive Connections** from the templates: `Ref`/`GetAtt` and IAM policy statements, attributed to the grantee via the policy's `aws:cdk:path`, with `grant*` intent read from the creation-stack frame name where present.
4. **Join to source.** Resolve creation stacks to `.ts` line and column (same method as cdk-explorer), find the `NewExpression` / `CallExpression` at that position with the TS 6 API, and read authored props and grant calls from it.
5. **Fall back** to L1-level Nodes (raw props from `tree.json`) for anything with no matching authored site. Instrumentation is a later, optional precision mode.

### What v1 Exports must contain so Import can map code back to Nodes

1. **Construct path = stable key.** Every Node gets a literal, user-visible construct ID, unique within its scope, that persists in the Design. Export never regenerates or derives it from random UUIDs. Path is what joins `tree.json`, templates (`aws:cdk:path`) and manifest metadata. It also fixes logical IDs, so renaming a Node in Truss replaces the deployed resource, and the UI should warn about that ([Identifiers](https://docs.aws.amazon.com/cdk/v2/guide/identifiers.html)).
2. **A sidecar mapping file** in the Scaffold (for example `truss.json`, or the Design file itself). It maps `nodeId → { constructPath, fqn, file, exportHash }`, where `exportHash` is a hash of each generated file's content as exported. Import uses it to re-attach Truss Node IDs and layout, and to detect which files were hand-edited, which feeds ticket 07. A Stack-only Export cannot rely on the sidecar surviving, which is why items 1 and 3 must stand alone.
3. **A per-Node marker in code**, such as a leading comment `// truss:node <nodeId>` on each construct statement. It has zero runtime effect, survives formatting, and the TS AST reads it directly. The alternative is a runtime marker, `node.addMetadata('truss:node', id)` (core API, no Truss dependency), which flows into `<stack>.metadata.json` even when the code shape is later changed. It costs one line of visible noise per Node, so it is a decision for ticket 07/08. A Truss runtime library must not be required, in line with the PDK's lesson in prior-art.
4. **An analysable code shape.** One `const <var> = new <ns>.<Class>(<scope>, '<LiteralId>', { <inline literal props> })` per Node. Connections are explicit `a.grantX(b)` calls or props referencing a Node's variable. No loops or helper functions in generated code, `aws-cdk-lib` imported by stable namespace (`import * as s3 from 'aws-cdk-lib/aws-s3'`), and L3-composed Nodes as instances of library classes rather than generated subclasses. This makes static analysis exact on unedited Exports.
5. **Synth-friendly Scaffold defaults.** Keep source maps on (`"sourceMap": true` / `inlineSourceMap`, or run via `ts-node`/`tsx`) so creation stacks map to `.ts`. Don't set `aws:cdk:disable-creation-stack-traces`, `aws:cdk:disable-logicalId-metadata` or `pathMetadata: false` in the generated `cdk.json`.

## Sources

- aws-cdk (main @ `e07d99d`): [`core/lib/private/tree-metadata.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/private/tree-metadata.ts), [`core/lib/private/runtime-info.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/private/runtime-info.ts), [`core/lib/tree.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/tree.ts), [`core/lib/cfn-resource.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/cfn-resource.ts), [`core/lib/cfn-element.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/cfn-element.ts), [`core/lib/stack.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/stack.ts), [`core/lib/stack-synthesizers/_shared.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/stack-synthesizers/_shared.ts), [`core/lib/private/stack-trace.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/private/stack-trace.ts), [`core/lib/debug.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/debug.ts), [`core/lib/metadata-resource.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/metadata-resource.ts), [`core/lib/private/uniqueid.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/core/lib/private/uniqueid.ts), [`cx-api/lib/app.ts`](https://github.com/aws/aws-cdk/blob/main/packages/aws-cdk-lib/cx-api/lib/app.ts), [`tools/@aws-cdk/spec2cdk/lib/cdk/resource-class.ts`](https://github.com/aws/aws-cdk/blob/main/tools/%40aws-cdk/spec2cdk/lib/cdk/resource-class.ts)
- aws-cdk-cli (main @ `85464af`): [`cloud-assembly-schema/lib/cloud-assembly/metadata-schema.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/cloud-assembly-schema/lib/cloud-assembly/metadata-schema.ts), [`cloud-assembly-api/lib/metadata.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/cloud-assembly-api/lib/metadata.ts), [`cloud-assembly-api/lib/construct-tree.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/cloud-assembly-api/lib/construct-tree.ts), [`cloud-assembly-api/lib/template-ranges.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/cloud-assembly-api/lib/template-ranges.ts), [`toolkit-lib/lib/api/cloud-assembly/environment.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/toolkit-lib/lib/api/cloud-assembly/environment.ts), [`toolkit-lib/lib/api/source-tracing/private/stack-source-tracing.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/%40aws-cdk/toolkit-lib/lib/api/source-tracing/private/stack-source-tracing.ts), [`aws-cdk/lib/cli/cli-config.ts`](https://github.com/aws/aws-cdk-cli/blob/main/packages/aws-cdk/lib/cli/cli-config.ts), [`cdk-explorer` README and `lib/core/source-resolver.ts`](https://github.com/aws/aws-cdk-cli/tree/main/packages/%40aws-cdk/cdk-explorer)
- AWS CDK Developer Guide: [Identifiers and the AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/identifiers.html); API reference: [`ArtifactMetadataEntryType`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.cloud_assembly_schema.ArtifactMetadataEntryType.html)
- AWS Toolkit for VS Code: [AWS CDK Explorer](https://docs.aws.amazon.com/toolkit-for-vscode/latest/userguide/cdk-explorer.html)
- TypeScript: [Using the Compiler API (wiki)](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), [Announcing TypeScript 7.0 RC](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/)
- cdk-dia: [pistazie/cdk-dia](https://github.com/pistazie/cdk-dia) (README, `src/diagram/aws/aws-edge-resolver.ts`), [npm](https://www.npmjs.com/package/cdk-dia)
- AWS PDK: [aws/aws-pdk README](https://github.com/aws/aws-pdk), [cdk-graph developer guide](https://github.com/aws/aws-pdk/blob/mainline/packages/cdk-graph/docs/developer_guides/cdk-graph/index.md)
