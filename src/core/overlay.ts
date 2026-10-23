/**
 * The Overlay format: hand-written presentation data for one construct in the Catalog (CONTEXT.md,
 * ADR 0009). One typed data file per construct lives in `overlays/`; none of them touches core code.
 * Overlays are written against the CI baseline `aws-cdk-lib`. When the Catalog is built, every item is
 * checked against what the app has installed, and an item that doesn't resolve is dropped and logged,
 * never shown as a Problem. This file is only the shape; `buildCatalog` does the checking.
 */

/** Which kind of construct an entry is. Mirrors `Tier` in the Catalog, which imports this file. */
export type OverlayTier = 'L1' | 'L2' | 'L3';

/**
 * A piece of code that fills a prop or an argument, written the way the developer would, with the
 * class names bare (`Runtime.NODEJS_22_X`). The writer imports each class in `uses` in the file's own alias style.
 */
export interface Snippet {
  code: string;
  /** FQNs of the classes and enums the code names, e.g. `aws-cdk-lib.aws_lambda.Runtime`. */
  uses?: string[];
}

/**
 * One call a Connection makes. `forms` are the spellings of the same call, newest first: CDK is moving
 * grants to a facade, so a grant is `['grants', 'read']` where the app has it and `['grantRead']` where
 * it doesn't. The first form that resolves in the app's `aws-cdk-lib` is the one written.
 */
export interface HintCall {
  /** Which end of the Connection the call is made on. */
  on: 'self' | 'peer';
  forms: string[][];
  /** The arguments as code. `{self}` and `{peer}` stand for the two Nodes' bindings. */
  args: string[];
  /** FQNs of the classes and enums the arguments name. */
  uses?: string[];
}

export type ConnectionKind = 'grant' | 'integration' | 'network';

/**
 * How the Overlay's construct (`self`) can be connected with another (`peer`). References aren't here:
 * they come from jsii. A hint lives on the Overlay of the construct its primary call is made on.
 */
export interface ConnectionHint {
  kind: ConnectionKind;
  /** What the picker says, e.g. `reads from`. */
  label: string;
  /** FQNs of the constructs on the other end; a subclass of one counts. */
  peers: string[];
  /** Which way data or requests flow: `out` is self → peer, `in` is peer → self. The arrow follows it. */
  flow: 'out' | 'in';
  /** Preselected in the picker when several hints fit. */
  default?: true;
  /** The call that makes the Connection, made on `self`. */
  primary: Omit<HintCall, 'on'>;
  /** Calls that complete it, such as the environment variable that carries a table's name. */
  secondary?: HintCall[];
}

/** How a Connection reaches inside an L3: the edge is drawn to the L3 and the code goes through `path`. */
export interface Accessor {
  /** `grantee` is what a grant is made to; `connectable` is what a network rule is opened on. */
  as: 'grantee' | 'connectable';
  /** Properties to follow from the construct, e.g. `['taskDefinition', 'taskRole']`. */
  path: string[];
}

export interface Overlay {
  /** The construct this is for, e.g. `aws-cdk-lib.aws_s3.Bucket`. */
  fqn: string;
  /** The friendly name the palette and the Node show, e.g. `S3 Bucket`. */
  displayName: string;
  /** Replaces the tier the generator decided on. */
  tier?: OverlayTier;
  /** The props a Node's panel shows first after the required ones, in order. */
  featuredProps?: string[];
  /** What a required prop gets when the construct is dropped on a Stack. */
  defaults?: Record<string, Snippet>;
  /** What a prop gets when the construct is instantiated locally for its Computed Layer, where a default won't do. */
  fixtures?: Record<string, Snippet>;
  connections?: ConnectionHint[];
  accessors?: Accessor[];
}

/** An Overlay as the Catalog holds it: only the items that resolved in the app's libraries, with nothing left optional. */
export interface ResolvedOverlay {
  displayName: string;
  featuredProps: string[];
  defaults: Record<string, Snippet>;
  fixtures: Record<string, Snippet>;
  connections: ConnectionHint[];
  accessors: Accessor[];
}
