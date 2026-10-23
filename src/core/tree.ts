import type { TreeNode } from './assembly.ts';

/** What the construct tree calls a nested stack, which synth writes no stack artifact for, and a Stage. */
export const NESTED_STACK_FQN = 'aws-cdk-lib.NestedStack';
export const STAGE_FQN = 'aws-cdk-lib.Stage';

/**
 * The children of a construct without the plumbing CDK adds for its nested stacks: beside each nested
 * stack `X` the parent holds a construct `X.NestedStack` wrapping the resource that points at it. It is
 * made by the same `new` as the nested stack, and is no construct of the app's own.
 */
export function withoutNestedStackPlumbing(children: readonly TreeNode[]): TreeNode[] {
  const plumbing = new Set(children.filter((c) => c.fqn === NESTED_STACK_FQN).map((c) => `${c.id}.NestedStack`));
  return children.filter((c) => !plumbing.has(c.id));
}

/** What CDK adds to every Stack, by construct ID and the type it has. They deploy nothing the app asked for. */
const STACK_PLUMBING: Readonly<Record<string, string>> = {
  CDKMetadata: 'constructs.Construct',
  BootstrapVersion: 'aws-cdk-lib.CfnParameter',
  CheckBootstrapVersion: 'aws-cdk-lib.CfnRule',
};

/** Whether a direct child of a Stack is one of the constructs CDK adds to every Stack. */
export const isStackPlumbing = (child: TreeNode): boolean => STACK_PLUMBING[child.id] === child.fqn;
