import { describe, expect, it } from 'vitest';
import type { TreeNode } from './assembly.ts';
import { withoutNestedStackPlumbing } from './tree.ts';

const node = (id: string, fqn: string): TreeNode => ({ id, path: `S/${id}`, fqn, children: [] });

describe('withoutNestedStackPlumbing', () => {
  it('drops the construct that wraps the resource pointing at a nested stack, and nothing else', () => {
    const children = [
      node('Worker', 'aws-cdk-lib.NestedStack'),
      node('Worker.NestedStack', 'constructs.Construct'),
      node('Jobs', 'aws-cdk-lib.aws_sqs.Queue'),
      node('Other.NestedStack', 'constructs.Construct'),
    ];
    expect(withoutNestedStackPlumbing(children).map((c) => c.id)).toEqual(['Worker', 'Jobs', 'Other.NestedStack']);
  });
});
