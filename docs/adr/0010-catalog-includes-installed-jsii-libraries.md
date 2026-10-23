# The Catalog includes the app's directly installed jsii construct libraries

Real apps use third-party construct libraries (`@aws-solutions-constructs/*`, cdk-monitoring-constructs) next to `aws-cdk-lib`. Most of them ship a `.jsii` assembly, which is exactly what ADR 0009's Catalog generator reads. So at startup Truss also scans the app's **direct** dependencies for `.jsii` assemblies and adds their constructs to the Catalog, cached by package name and version. Their constructs get jsii-driven property panels and References, and can be searched and placed from the palette like any `aws-cdk-lib` construct.

## Considered Options

- **Show third-party constructs but don't make them placeable**: rejected. It's the same generator and data either way, and placing a Solutions Construct is one of the strongest reasons to use a visual editor.
- **Treat them like the user's own classes (no schema)**: rejected. It would throw away a full, typed description the library already ships.

## Consequences

- Third-party constructs have no Overlay, so they get no Grant or Integration hints. Only References (from jsii) and any generic patterns that Connection recognition settles on apply.
- Only direct dependencies are scanned. A library that is installed only transitively can't be instantiated from the app's own code without importing it, so it isn't needed.
- A library whose assembly fails to load is logged to the terminal and treated like a plain-TypeScript library. That is never a Problem.
- Their Layers are Computed Layers like any other, with read-only children.
