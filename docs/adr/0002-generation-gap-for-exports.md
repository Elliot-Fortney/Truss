# Exports use a generation gap: a Generated File plus an Extension File

Users edit exported code and then re-export, so Truss splits ownership. The **Generated File** holds one `Construct` subclass (e.g. `OrdersTruss`) that exposes every Node as a `public readonly` member. Truss rewrites it whole on every Export. The **Extension File** is a stack that creates that construct and holds the user's own code. Truss writes it once and never touches it again. This keeps the Generated File in the rigid, analysable shape that v2 Import needs, and still gives users a real place for code Truss can't model.

## Considered Options

- **Overwrite everything**: rejected because hand edits are lost and users have nowhere to put escape hatches.
- **Marked regions** (`// truss:begin` / `// truss:end` with user code between them): rejected because regions get mangled, merges are ambiguous, and user code inside the file breaks exact static analysis.
- **Three-way merge** against the last Export: rejected because it needs a conflict UI, and hand edits leak into the code Import must analyse.
- **Abstract `Stack` base class** that the user's stack extends: rejected because it can't drop into an existing stack, and it couples user code to generated code by inheritance.

## Consequences

- The wrapper construct adds one segment to every construct path, and so changes every logical ID. Its construct ID comes from the Design and must stay stable, just like Node IDs.
- Construct-only Export (formerly Stack-only) emits only the Generated File, for the user to create in an existing stack.
- If the Generated File's hash differs from the last Export's, re-export is blocked until the user confirms. If no baseline hash exists, the file is treated as edited.
- Scaffold's other files are written once. When they fall out of step, e.g. the `aws-cdk-lib` version, Truss warns instead of editing them.
- Removing or renaming a Node can break references in the Extension File. Export warns, and the user's compiler catches the breakage.
- Extension File code isn't part of the Design and isn't reflected in Computed Layers. v1 promises Import only that the Generated File stays exact.
