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

export interface SynthError {
  message: string;
  /** Raw stdout/stderr from the app, for display. */
  output?: string;
}
