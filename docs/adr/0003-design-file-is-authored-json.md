# The Design file is Truss-owned JSON holding only what the user authored

Truss saves a Design as `*.truss.json`: a custom JSON schema, published as a JSON Schema, that stores only what the user authored. That means placed Nodes, their sparse props, Connections, layout and Export state. Layers are never stored; they are always computed. A TypeScript Design file seems natural for an infrastructure-as-code tool, but Truss already produces TypeScript: the Generated File is the reviewable code. The Design file is what Truss reads back to restore the canvas, and reading TS back is Import.

## Considered Options

- **A TypeScript file (CDK-like code as the source of truth)**: rejected. Opening a Design would mean parsing TS with the compiler API, which is the v2 Import problem moved into v1's core, and that API has no stable version for TS 7. Half the file isn't CDK anyway: Node IDs, layout, Export targets, baseline hashes and Connection overrides would end up as JSON inside TS. It also invites the hand edits that ADR 0002 sends to the Extension File.
- **A file shaped like CDK's construct tree (`tree.json`)**: rejected because it mixes authored Nodes with derived children, which Computed Layers already rebuild from props (ADR 0001). Stored copies would drift.

## Consequences

- Each Node has an opaque, immutable Node ID and a separate, editable construct ID. Connections, layout and in-code markers point at the Node ID. Changing a construct ID is a deliberate act that replaces the deployed resource.
- Props are sparse and keyed by jsii name. Values that aren't plain JSON use tags: `$node` (a Reference), `$enum` and `$call` (static factories and constants), all validated against the Catalog.
- Connections store the Overlay hint ID and the user's overrides, never the expanded calls, so a fix to an Overlay reaches existing Designs.
- `formatVersion` is migrated on load by a chain of pure functions, one step per version. A file from a newer Truss is refused.
- The file is committed with the user's code and holds each Export target and its baseline hash, so everyone who clones the repo agrees on what counts as a hand edit.
