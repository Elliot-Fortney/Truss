# Computed Layers run in a local Node process

A Layer must show the child constructs that *this* Node's props actually create. A plain `Bucket` has 2 nodes; with `autoDeleteObjects` + `enforceSSL` it has 6. So Truss computes Layers by instantiating the whole Design with the real, pinned `aws-cdk-lib`, rather than showing static example trees. To run CDK where it's officially supported, Truss is a local web app served by a Node process (`npx truss`), not a static browser-only page. Nothing touches AWS: this is a local dry run used only to draw Layers.

## Considered Options

- **Example Layers (static, built once with default props)**: rejected because the trees are wrong for any non-default props, which defeats design review.
- **aws-cdk-lib in a browser Web Worker**: this would keep Truss a static site. Rejected because CDK doesn't support browsers. It needs Node built-in shims and a fake `fs` that may break on any CDK upgrade, plus about 4.9 MB gzipped of extra download. The users are CDK developers, so they already have Node.

## Consequences

- Truss needs Node to run. Instantiation sits behind a port, so a browser adapter is still possible for a future hosted version. Hosting it would need sandboxed server compute per user.
- The local process can write Exports straight into the user's repo and read and write Design files directly.
- The process's `aws-cdk-lib` is pinned to the Catalog's version.
- Instantiating the whole Design, not one Node at a time, means Connections must map to calls Truss can replay. Then grants and stack-scoped singletons appear in the right place.
- Runtime-required values the user hasn't set are filled from Overlay fixtures. If instantiation still fails, the Node can't be expanded and shows CDK's error.

See `docs/research/layer-extraction.md`.
