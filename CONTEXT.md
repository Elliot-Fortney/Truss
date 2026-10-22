# Truss

Truss is a visual editor for AWS infrastructure: users draw their architecture on a canvas and Truss generates the AWS CDK code that provisions it.

## Language

**Design**:
The document a user builds on the canvas: the full set of Nodes and Connections describing one piece of infrastructure.
_Avoid_: Diagram (when meaning the saved document), project, model

**Node**:
One box on the canvas, corresponding to exactly one CDK construct.
_Avoid_: Service, shape, component, resource (unless it is literally an L1 resource)

**Connection**:
An edge between two Nodes that always becomes code: a Reference, Grant, Integration or Network Connection. Its arrow follows data or request flow, not code direction.
_Avoid_: Link, wire, line, relationship

**Reference**:
A Connection where one Node's prop points at another Node, e.g. a Function placed in a VPC. Containment is a Reference, never nesting.
_Avoid_: Containment, parent

**Grant**:
A Connection that gives one Node IAM permissions on another.
_Avoid_: Permission edge, policy

**Integration**:
A Connection that routes events or invocations from one Node to another, e.g. a Queue triggering a Function.
_Avoid_: Trigger, event edge

**Network Connection**:
A Connection that opens network access between two Nodes.
_Avoid_: Security group rule, firewall edge

**Layer**:
A level of the CDK construct tree. Expanding a Node reveals the child Nodes its construct creates (L3 → L2 → L1).
_Avoid_: Level of detail, zoom level

**Computed Layer**:
A Layer derived from the Node's actual props by instantiating the Design locally, never from a static example. Its child Nodes are read-only.
_Avoid_: Live Layer, example Layer

**Catalog**:
The set of constructs a Design can use, generated from one pinned `aws-cdk-lib` version.
_Avoid_: Palette (the UI that lists it), registry, library

**Overlay**:
Hand-written presentation data for one construct in the Catalog: tier, display name, featured props, fixtures and Connection hints.
_Avoid_: Plugin, extension, config

**Export**:
Turning a Design into CDK code the user takes away.
_Avoid_: Compile, build, deploy

**Scaffold**:
An Export that produces a complete, deployable CDK app (entry point, stack, project config). The default.
_Avoid_: Full project, template

**Construct-only Export**:
An Export that produces only the Generated File, for dropping into a stack in an existing CDK app.
_Avoid_: Stack-only Export

**Generated File**:
The file Truss owns and rewrites whole on every Export. It defines one construct holding every Node of the Design.
_Avoid_: Protected file, managed file, output

**Extension File**:
The stack file that uses the Generated File's construct, where users add their own code. Truss writes it once and never touches it again.
_Avoid_: User file, custom file

**Import**:
Turning existing CDK code into a Design. The reverse of Export; planned for v2.
_Avoid_: Reverse-engineer, sync
