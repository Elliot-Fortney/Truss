import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Assembly, TreeNode } from './assembly.ts';
import { CONSTRUCT_ICONS, GENERIC_ICON, ICON_FILES, iconFor, SERVICE_ICONS } from './icons.ts';

describe('iconFor', () => {
  it('gives a construct in the curated map its own icon', () => {
    expect(iconFor('aws-cdk-lib.aws_lambda.Function')).toBe('lambda-function');
    expect(iconFor('aws-cdk-lib.aws_s3.Bucket')).toBe('s3-bucket');
  });

  it('falls back to the service icon for the namespace of a construct the map does not list', () => {
    // A queue policy is not in the curated map, but SQS has a service icon.
    expect(iconFor('aws-cdk-lib.aws_sqs.QueuePolicy')).toBe('sqs');
    // So does an L1.
    expect(iconFor('aws-cdk-lib.aws_dynamodb.CfnTable')).toBe('dynamodb');
  });

  it('shares one service icon between a service and the modules built on it', () => {
    expect(iconFor('aws-cdk-lib.aws_ecs_patterns.QueueProcessingEc2Service')).toBe(
      iconFor('aws-cdk-lib.aws_ecs.Cluster'),
    );
    expect(iconFor('aws-cdk-lib.aws_lambda_event_sources.SqsEventSource')).toBe(
      iconFor('aws-cdk-lib.aws_lambda.Layer'),
    );
  });

  it('prefers a construct’s own icon over its service icon', () => {
    expect(iconFor('aws-cdk-lib.aws_dynamodb.Table')).not.toBe(iconFor('aws-cdk-lib.aws_dynamodb.CfnTable'));
  });

  it('falls back to the generic icon when the FQN has no service to name', () => {
    expect(iconFor('constructs.Construct')).toBe(GENERIC_ICON);
    expect(iconFor('aws-cdk-lib.Stack')).toBe(GENERIC_ICON);
    expect(iconFor('aws-cdk-lib.aws_notaservice.Thing')).toBe(GENERIC_ICON);
    expect(iconFor('some-library.Widget')).toBe(GENERIC_ICON);
    expect(iconFor('')).toBe(GENERIC_ICON);
  });

  it('gives the featured constructs a specific icon, not just their service’s', () => {
    expect(iconFor('aws-cdk-lib.aws_ec2.Vpc')).toBe('vpc');
    expect(iconFor('aws-cdk-lib.aws_lambda.DockerImageFunction')).toBe('lambda-function');
    expect(iconFor('aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService')).toBe('fargate');
  });

  it('never returns an icon the vendored set does not have, for every FQN in the recorded assemblies', () => {
    const fqns = new Set<string>();
    const walk = (n: TreeNode) => {
      fqns.add(n.fqn);
      n.children.forEach(walk);
    };
    for (const name of ['straight-line', 'shapes'])
      walk((JSON.parse(readFileSync(`test/fixtures/${name}/assembly.json`, 'utf8')) as Assembly).tree);
    expect(fqns.size).toBeGreaterThan(5);
    for (const fqn of fqns) {
      const icon = iconFor(fqn);
      expect(icon === GENERIC_ICON || icon in ICON_FILES, fqn).toBe(true);
    }
    // The shape apps are built from S3, SQS and DynamoDB, so none of those is left generic.
    for (const fqn of fqns) if (/\.aws_(s3|sqs|dynamodb)\./.test(fqn)) expect(iconFor(fqn), fqn).not.toBe(GENERIC_ICON);
  });
});

describe('the icon map', () => {
  const vendored = 'assets/aws-architecture-icons';

  it('only names icons it has a file for', () => {
    for (const id of [...Object.values(CONSTRUCT_ICONS), ...Object.values(SERVICE_ICONS)])
      expect(ICON_FILES, id).toHaveProperty(id);
  });

  it('has every one of those files vendored, and nothing else, so the set stays curated', () => {
    for (const file of Object.values(ICON_FILES)) expect(existsSync(`${vendored}/${file}`), file).toBe(true);
    const svgs = readdirSync(vendored).filter((f) => f.endsWith('.svg'));
    expect(svgs.sort()).toEqual(Object.values(ICON_FILES).sort());
  });

  it('ships the vendored icons with their NOTICE', () => {
    expect(existsSync(`${vendored}/NOTICE`)).toBe(true);
    expect(existsSync('assets/tabler-icons/LICENSE')).toBe(true);
  });
});
