import type { HintCall, Overlay } from '../overlay.ts';

const secretArnEnv: HintCall = { on: 'peer', forms: [['addEnvironment']], args: ["'SECRET_ARN'", '{self}.secretArn'] };

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_secretsmanager.Secret',
  displayName: 'Secrets Manager Secret',
  featuredProps: ['secretName', 'description', 'generateSecretString', 'encryptionKey', 'removalPolicy'],
  connections: [
    {
      kind: 'grant',
      label: 'is read by',
      peers: ['aws-cdk-lib.aws_lambda.Function'],
      flow: 'out',
      default: true,
      primary: { forms: [['grantRead']], args: ['{peer}'] },
      secondary: [secretArnEnv],
    },
    {
      kind: 'grant',
      label: 'is written by',
      peers: ['aws-cdk-lib.aws_lambda.Function'],
      flow: 'in',
      primary: { forms: [['grantWrite']], args: ['{peer}'] },
      secondary: [secretArnEnv],
    },
  ],
};

export default overlay;
