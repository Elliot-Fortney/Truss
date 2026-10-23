# The Catalog is generated from the app's own installed aws-cdk-lib

The Catalog was meant to be built once, at Truss's build time, from one pinned `aws-cdk-lib`, because the browser couldn't afford to parse the 85 MB jsii assembly. Since ADR 0001 and ADR 0005, Truss runs as a local Node process inside the app, and the app synths with its own installed `aws-cdk-lib`, so a pinned Catalog would describe a different version from the code it edits. Instead, Truss runs the same Catalog generator at startup on the app's installed `.jsii.gz` (resolved from the folder holding `cdk.json`, as the app's entry point would) and caches the result by version. The Catalog then always matches the code that synths, and version mismatch disappears instead of being managed.

## Considered Options

- **Bundle one pinned Catalog and tolerate mismatch**: rejected. Constructs and props would be missing or phantom, depending on which side is newer.
- **Bundle a Catalog and regenerate only on mismatch**: rejected. It's the same generator with an extra path to test, and saves only the first run's few seconds.

## Consequences

- Overlays are still hand-written against a baseline version. Each Overlay item (featured prop, Connection hint, accessor) is checked against the app's Catalog when loaded; items that don't resolve are dropped and logged to the terminal, never shown as a warning. A construct left with no items falls back to its auto-generated panel. CI validates Overlays against the baseline and the minimum supported version. Per-item version ranges can be added later if hints really diverge.
- Truss refuses to open apps below a declared minimum `aws-cdk-lib` (and CDK v1), and apps whose cloud assembly schema is too new for its bundled toolkit-lib ("upgrade Truss"). Everything in between opens. The minimum is the oldest version the CI corpus covers, set in the spec.
- The Scaffold pins the CI baseline exactly, as `cdk init` does; after that the user upgrades with npm like any app.
- When the resolved `aws-cdk-lib` version changes while Truss runs, the Catalog is regenerated (or loaded from cache) before the re-synth. Draft items the upgrade invalidates become Draft errors through the normal Problems path; there is no migration step.
- Reading a third-party library's jsii assembly to describe its constructs is the same code path.
