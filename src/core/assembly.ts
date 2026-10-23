/**
 * The cloud assembly as the core sees it: a plain-JSON digest of what `cdk synth` wrote,
 * with every file path relative to the app folder so recorded fixtures are portable.
 */

export interface TreeNode {
  id: string;
  /** Construct path, e.g. `ShopStack/Uploads`. The App root has path ''. */
  path: string;
  fqn: string;
  /** CloudFormation type, on L1 resources. */
  cfnType?: string;
  children: TreeNode[];
}

/** One user-code frame from a construct's creation stack (1-based line and column). */
export interface Frame {
  fn?: string;
  /** Relative to the app folder. */
  file: string;
  line: number;
  col: number;
}

export interface StackInfo {
  /** Construct path of the stack. */
  path: string;
  /** `aws://account/region`, or undefined for an env-agnostic stack. */
  env?: string;
}

export interface Assembly {
  /** Cloud assembly manifest version. */
  schemaVersion: string;
  tree: TreeNode;
  stacks: StackInfo[];
  /** User-code frames per construct path, innermost first. Paths with no user frame are absent. */
  creation: Record<string, Frame[]>;
}

export type SynthResult =
  | { ok: true; assembly: Assembly }
  | { ok: false; error: SynthError };

/** A place in the app's own source (1-based line and column), file relative to the app folder. */
export interface SourceLocation {
  file: string;
  line: number;
  col: number;
}

/** A request to show a place in the app's code in the user's editor; the position is optional. */
export type EditorRequest = Pick<SourceLocation, 'file'> & Partial<Omit<SourceLocation, 'file'>>;

export interface SynthError {
  message: string;
  /** Raw stdout/stderr from the app, for display. */
  output?: string;
  /** Where in the app's code the trace points, when it does. */
  location?: SourceLocation;
}
