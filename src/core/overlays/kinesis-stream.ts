import type { Overlay } from '../overlay.ts';

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_kinesis.Stream',
  displayName: 'Kinesis Data Stream',
  featuredProps: ['streamName', 'shardCount', 'streamMode', 'retentionPeriod', 'encryption', 'removalPolicy'],
  connections: [
    {
      kind: 'grant',
      label: 'is read by',
      peers: ['aws-cdk-lib.aws_lambda.Function'],
      flow: 'out',
      default: true,
      primary: { forms: [['grantRead']], args: ['{peer}'] },
      secondary: [{ on: 'peer', forms: [['addEnvironment']], args: ["'STREAM_NAME'", '{self}.streamName'] }],
    },
    {
      kind: 'grant',
      label: 'is written by',
      peers: ['aws-cdk-lib.aws_lambda.Function'],
      flow: 'in',
      primary: { forms: [['grantWrite']], args: ['{peer}'] },
      secondary: [{ on: 'peer', forms: [['addEnvironment']], args: ["'STREAM_NAME'", '{self}.streamName'] }],
    },
  ],
};

export default overlay;
