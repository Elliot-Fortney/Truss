# Truss never performs context lookups

`Vpc.fromLookup`, `HostedZone.fromLookup` and friends need AWS credentials to resolve the first time, after which `cdk synth` caches the answer in `cdk.context.json`. Truss re-synths on every debounced file change and every Draft edit, so doing what `cdk synth` does would mean silent AWS calls in the background, and credentials needed just to view a diagram. Instead, Truss synths with lookups disabled. Values already in `cdk.context.json` are used as normal. For a missing value, the framework's dummy value is kept, rather than failing the way `cdk synth --no-lookups` does. It shows as a warning Problem on the External Node: "Context missing: run `cdk synth` once with AWS credentials."

## Considered Options

- **Resolve lookups like `cdk synth`**: rejected. Network calls and writes to `cdk.context.json` would happen as side effects of opening or editing.
- **Opt-in flag**: rejected for v1. It's an extra mode to test, and committed context already covers teams.

## Consequences

- Truss never writes `cdk.context.json`.
- Missing context is a warning, never an error, so it doesn't block Save, even when the Draft adds the lookup. The canvas shows the dummy value.
