# Layer extraction by instantiating constructs

Spike for the ticket "Can Layers be extracted by instantiating constructs at build time?" It was run against `aws-cdk-lib` 2.274.0 on Node 24.14 and headless Chrome on 2026-10-22. The spike code was throwaway and is not kept.

## Answer

**Yes, it works, but not generically, and it gives an example tree rather than the real one.** Instantiating a construct in a throwaway `Stack` and walking `node.children` gives an accurate construct tree in milliseconds, in Node and also in the browser. Three things limit it:

1. **Not generic.** The high-value constructs need real dependency values to construct at all.
2. **Prop-dependent.** The tree changes with props, so a build-time tree only shows one example configuration.
3. **The subtree isn't everything the construct created.** Some constructs add resources outside their own subtree.

## Method

- Every non-abstract `Construct` subclass in the jsii assembly was enumerated: 2,408 classes, of which 1,906 are L1 (`Cfn*`) and 502 are everything else. "Everything else" also includes non-resource helpers.
- Each class was instantiated into a fresh `App` and `Stack`, with `env` set, in two modes:
  - **empty**: props `{}` / `undefined`.
  - **auto**: required props filled generically from jsii types. Primitives get dummy values and enums get their first member. Structs are filled recursively. Reference types come from a static constant, then a static factory, then any concrete implementor, up to depth 4.
- The subtree of the new construct was walked, recording the `fqn` of each child via jsii RTTI.

## Results

| | empty props | auto props |
|---|---|---|
| L1 constructs that build | 273 / 1906 | 1905 / 1906 |
| L2/L3 constructs that build | 138 / 502 | 290 / 502 |
| L2/L3 with children (a Layer exists) | 108 | 245 |
| Wall time, the whole library | ~1.8 s | ~2.0 s |

- **L1s are trivially leaves.** They don't need instantiating for Layers.
- **Speed is a non-issue.** Per construct, p50 < 0.3 ms and max ~60 ms, where the max comes from the asset-hashing constructs. Peak RSS is ~0.9 GB, mostly from parsing the 85 MB assembly. Successful L2/L3 trees have p50 2 nodes, p90 4 and max 56.

### Which constructs fail, and why

The generic filler fails on the constructs Truss cares most about:

| Construct | Why it fails generically |
|---|---|
| `lambda.Function`, `LambdaRestApi`, `eks.Cluster` | It can't make `lambda.Code` / `IFunction` / `ILayerVersion`, because the factories need real assets or inline code. |
| `ecs_patterns.ApplicationLoadBalancedFargateService` (and other patterns) | It hits a runtime "one of `taskDefinition` or `image`" rule that isn't in the type system. |
| `rds.DatabaseInstance` / `DatabaseCluster` | It can't make `IInstanceEngine` / `IClusterEngine`, whose factories need versioned args. |
| `cloudfront.Distribution` | It can't make `IOrigin`, because origins live in a different module (`aws_cloudfront_origins`). |
| `iam.Role`, `s3_deployment.BucketDeployment` | It can't make `IPrincipal` / `ISource`. |
| `dynamodb.Table`, `stepfunctions.StateMachine` | The required prop is enforced at runtime only, not marked required in jsii. |
| `lambda_nodejs.NodejsFunction` | It needs a handler file on disk and runs esbuild. |

The other common errors are runtime validations ("at least one of…", "must be configured…"), missing files and assets, and mutual-exclusion rules. None of these are visible in jsii metadata.

**Type-level fixtures fix the headline cases.** One hand-written value per *dependency type* was added, not one per construct: `Code.fromInline`, `ContainerImage.fromRegistry`, a Postgres engine, a `ServicePrincipal`, an `S3BucketOrigin`, a `Vpc`, and a `partitionKey`. With those, all the failing headline constructs above build. Examples: Function 4 nodes, ALB Fargate Service 28, DatabaseInstance 10, Distribution 5, LambdaRestApi 21, Table 3. **How far a fixture set of this size closes the remaining ~200 L2/L3 failures was not measured.**

### The tree depends on props

| Construct | Default | Varied |
|---|---|---|
| `s3.Bucket` | 2 nodes (Bucket → CfnBucket) | 6 with `autoDeleteObjects` + `enforceSSL`: adds a BucketPolicy and an auto-delete CustomResource |
| `lambda.Function` | 4 (ServiceRole, CfnFunction) | 9 with `vpc` + `logRetention`: adds a SecurityGroup, LogRetention and a LogGroup |
| `dynamodb.Table` | 3 | 8 with PROVISIONED + stream + autoscaling (autoscaling is a method call, not a prop) |
| ALB Fargate Service | 28 | 28 with `publicLoadBalancer: false` (no structural change) |

So a build-time catalog tree is a **default/example** tree. An accurate Layer for a particular Node has to be recomputed from that Node's actual props, and sometimes from method calls too.

### The subtree isn't everything the construct created

- `ApplicationLoadBalancedFargateService` with no `cluster` creates `EcsDefaultCluster…`, holding a Cluster and a 46-node VPC, as a **sibling at stack scope**, not under itself. Its subtree has 28 nodes, but the stack has 63.
- `queue.grantSendMessages(role)` adds a `DefaultPolicy` under the **Role**, not under the Queue.
- Singletons such as custom-resource providers (`Custom::S3AutoDeleteObjectsCustomResourceProvider`) and the LogRetention function are also stack-scoped.

To build a Layer, diff the whole stack before and after instantiation, not just `node.children`. Truss also has to decide how to show resources that are hoisted to the stack or attached to another Node.

## Running aws-cdk-lib in the browser

**It works with shims.** An entry point that imports `aws-cdk-lib` and builds a Bucket with `autoDeleteObjects`, a Function and an ALB Fargate Service (77 constructs) was bundled with esbuild (`platform: browser`) and ran correctly in headless Chrome.

- **Out of the box it fails.** The bundle can't resolve 205 imports of Node built-ins: `path` ×101, `fs` ×58, `crypto` ×19, `os` ×9, `child_process` ×6, and more.
- **Shims used**:
  - browserify packages for `path`, `crypto`, `os`, `stream`, `zlib`, `util`, `assert`, `url` and `events`.
  - `Buffer` / `process` globals.
  - `__dirname` defined as a constant.
  - A hand-made stub `fs` / `child_process`.
- **Without asset-backed constructs, a stub that just throws is enough.** For example, a Bucket with no `autoDeleteObjects`, an inline-code Function and an ALB Fargate Service: OK, 69 constructs.
- **Asset-backed constructs need more.** Custom-resource handlers and `Code.fromAsset` hash files and stage them in `cdk.out`. They needed a **fake filesystem** that pretends files and directories exist and turns writes into no-ops. Getting there took about six rounds of fixing one missing `fs` call at a time. It is brittle, and it may break on any CDK upgrade.
- **Size**: 40.8 MB minified / **4.86 MB gzipped** when importing from the root `aws-cdk-lib` barrel. Per-module subpath imports might tree-shake smaller, but that wasn't tested.
- **Time**: ~1.1 s from script load to finished construction in headless Chrome, including parse.

Running construction in a Web Worker is therefore *possible* for live, per-props Layers. It costs a ~5 MB download and a maintained `fs` fake, and the browser contract is unofficial, since CDK doesn't support browsers.

## Implications for the Construct catalog decision

- Layers can come from build-time instantiation, but only for constructs that have **fixtures**. The fixture set is keyed by dependency type, plus some per-construct runtime-required props. It is curated overlay data either way.
- A build-time tree is an *example*. If Layers must match the user's props, Truss needs either live instantiation (Node backend or browser worker) or to accept "representative" Layers in v1.
- Layers have to account for stack-scoped side effects, such as default clusters and VPCs, singleton providers, and grant policies on other Nodes.
- L1s need no instantiation. They are always leaves.
