# Truss

Truss is a visual editor for AWS infrastructure: users draw their architecture on a canvas and Truss generates the AWS CDK code that provisions it.

## Language

**Design**:
The document a user builds on the canvas: the full set of Nodes and Connections describing one piece of infrastructure.
_Avoid_: Diagram (when meaning the saved document), project, model

**Node**:
One box on the canvas, corresponding to exactly one CDK construct.
_Avoid_: Service, shape, component, resource (unless it is literally an L1 resource)

**Layer**:
A level of the CDK construct tree. Expanding a Node reveals the child Nodes its construct creates (L3 → L2 → L1).
_Avoid_: Level of detail, zoom level

**Export**:
Turning a Design into CDK code the user takes away.
_Avoid_: Compile, build, deploy

**Scaffold**:
An Export that produces a complete, deployable CDK app (entry point, stack, project config). The default.
_Avoid_: Full project, template

**Stack-only Export**:
An Export that produces only the stack file, for dropping into an existing CDK app.

**Import**:
Turning existing CDK code into a Design. The reverse of Export; planned for v2.
_Avoid_: Reverse-engineer, sync
