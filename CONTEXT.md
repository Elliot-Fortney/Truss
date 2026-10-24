# Truss

Truss is a visual editor for AWS infrastructure: users draw their architecture on a canvas and Truss generates the AWS CDK code that provisions it.

## Language

**Design**:
One CDK app as Truss shows and edits it: everything the app synthesizes, as Nodes and Connections. It is derived from the app's code, which is the source of truth.
_Avoid_: Diagram (when meaning the saved document), project, model

**Node**:
One box on the canvas, corresponding to exactly one CDK construct.
_Avoid_: Service, shape, component, resource (unless it is literally an L1 resource)

**External Node**:
A Node for an AWS resource that the app refers to but doesn't create, made by a `fromXxx` call such as `Bucket.fromBucketName`. It can be a Connection target, but it deploys nothing.
_Avoid_: Lookup (that's only `fromLookup`), imported Node, existing resource

**Construct ID**:
The literal ID a Node's construct gets in the app's code. Together with its parents it forms the construct path, which is also the Node's identity in Truss. Changing it replaces the deployed resource.
_Avoid_: Name, label, Node ID (when meaning the code ID)

**Preview**:
The picture of a Design (placed Nodes and Connections, Layers collapsed) that Truss writes next to the Sidecar whenever either changes, for review in PRs and READMEs. It's derived and never read back.
_Avoid_: Thumbnail, screenshot, image Export

**Stack**:
A group of Nodes that deploy together as one CloudFormation stack, drawn as a group box around them. A Stack is never a Node: it can't be connected or dragged into another Stack. A nested stack is a box inside its parent Stack's box.
_Avoid_: Environment, deployment, group (when meaning a Stack)

**Stage**:
A deployable copy of one or more Stacks, usually one per environment (Dev, Prod). The canvas shows one Stage at a time.
_Avoid_: Environment (when meaning the Stage), account

**Connection**:
An edge between two Nodes that always becomes code: a Reference, Grant, Integration or Network Connection. Its arrow follows data or request flow, not code direction.
_Avoid_: Link, wire, line, relationship

**Reference**:
A Connection where one Node's prop points at another Node, e.g. a Function placed in a VPC. Containment is a Reference, never nesting. Its arrow runs from the Node whose prop it is to the Node it names, unless the Overlay says what it names flows into that Node (a Function's role).
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

**Hoisted Node**:
A read-only Node for a construct that another construct creates outside its own subtree, such as a default VPC or a singleton provider. It is drawn at Stack scope and linked to the Node, or Nodes, whose resources point at it.
_Avoid_: Side effect, implicit resource, shared resource

**Catalog**:
The set of constructs a Design can use, generated from the app's own installed `aws-cdk-lib` and its other directly installed jsii construct libraries, so it always matches the versions the app synths with. The app's own construct classes aren't in it.
_Avoid_: Palette (the UI that lists it), registry, library

**Overlay**:
Hand-written presentation data for one construct in the Catalog: tier, display name, featured props, fixtures and Connection hints.
_Avoid_: Plugin, extension, config

**Override**:
A raw CloudFormation change the app's code makes to a Node's L1 child through a CDK escape hatch (`addPropertyOverride`, `addOverride`, `addDeletionOverride`). Truss shows the ones it recognises, but never edits them.
_Avoid_: Escape hatch (the technique, not the change), patch

**Scaffold**:
The minimal CDK app Truss writes when a user starts in an empty folder. From then on it is an app like any other.
_Avoid_: Template, new project

**Draft**:
The canvas edits not yet saved to the app's code. Truss shows the Design as it would be with the Draft applied; Save writes it to the user's files, Discard drops it.
_Avoid_: Staged changes, changeset, pending edits

**Base**:
The app as its files hold it on disk, from the last synth of them. The Draft's edits are planned against it, and when the files change Truss reads a new Base and plans the Draft on it again.
_Avoid_: Snapshot, baseline, original

**Problem**:
An error or warning Truss shows on a Design, from synth, type-checking, CDK annotations or a dependency cycle (or, rarely, a check that the edit Truss planned is the edit the Draft means, which is a bug in Truss, not in the user's code). Errors introduced by the Draft block Save.
_Avoid_: Issue, diagnostic, lint, finding

**Sidecar**:
The one committed file per app where Truss keeps what code can't express: Node positions and notes, keyed by construct path.
_Avoid_: Design file, layout file, project file

## Retired terms

Retired by ADR 0005 (the app's code is the source of truth). Don't use these for new work.

- **Export**, **Construct-only Export**: there's no separate step; every canvas edit is a code edit, and opening an existing app replaces Construct-only Export.
- **Generated File**, **Extension File**: the generation gap (ADR 0002) is gone; Truss edits the user's own files.
- **Import**: opening an app *is* reading its code.
- **Design file** (`*.truss.json`): replaced by the Sidecar.
