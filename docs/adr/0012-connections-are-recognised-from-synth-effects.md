# Connections are recognised from synth effects, not source patterns

Grant, Integration and Network Connections in an existing app are found from what synth produces, not by matching Overlay hints against source. An IAM statement attached to Node A's role whose resource is Node B is a Grant A → B. An event source mapping, subscription or target is an Integration, and a security group rule is a Network Connection. Each end rolls up to the nearest placed Node, and External Nodes count as ends. The Source port then tries to explain each edge with recognised call spans. That decides only whether the edge is editable, never whether it is shown. Any app must be viewable however its code is written, and a permission built with `addToRolePolicy`, a hand-built `PolicyStatement` or a helper function is just as real as a `grants.read` call.

## Considered Options

- **Source patterns only**: rejected. It's simpler, but every permission or trigger written in a way Truss doesn't recognise would be missing from the canvas, so the canvas would understate what the app deploys.
- **Source matches as Connections, plus unexplained synth effects in a separate style**: rejected. It's two sources of edges for the same thing, and one AWS permission would appear in two different places depending on how it was written.

## Consequences

- There's one edge per (kind, source Node, target Node). Its panel lists every matched call and every unexplained effect.
- An edge can be removed only when every one of its effects is explained by editable calls. Otherwise it's read-only and says why, and the panel can still remove individual editable calls.
- An effect with an end that isn't a Node (`*`, a raw ARN, a self-edge) gets no edge. It's listed read-only in the owning Node's panel instead.
- Cross-stack Connections are recognised by pairing `Fn::ImportValue` with its `Export`, without tracing stack props through `bin/`. They are always read-only.
- The Synth port has to expose effects that can be resolved to Nodes. `Source.analyse` has to report call matches and the binding each call's receiver and arguments resolve to.
