import type { Overlay } from '../overlay.ts';

// Its engine and VPC are required and have no default that would be right for anyone, so a form asks for them.
const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_rds.DatabaseInstance',
  displayName: 'RDS Database Instance',
  featuredProps: ['engine', 'vpc', 'instanceType', 'allocatedStorage', 'databaseName', 'multiAz', 'backupRetention', 'deletionProtection', 'removalPolicy'],
  connections: [
    {
      kind: 'network',
      label: 'accepts connections from',
      peers: ['aws-cdk-lib.aws_lambda.Function', 'aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService'],
      flow: 'in',
      primary: { forms: [['connections', 'allowDefaultPortFrom']], args: ['{peer}'] },
    },
  ],
};

export default overlay;
