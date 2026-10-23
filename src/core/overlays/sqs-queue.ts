import type { HintCall, Overlay } from '../overlay.ts';

const FUNCTION = 'aws-cdk-lib.aws_lambda.Function';

const queueUrlEnv: HintCall = { on: 'peer', forms: [['addEnvironment']], args: ["'QUEUE_URL'", '{self}.queueUrl'] };

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_sqs.Queue',
  displayName: 'SQS Queue',
  featuredProps: ['queueName', 'visibilityTimeout', 'retentionPeriod', 'deadLetterQueue', 'fifo', 'encryption', 'removalPolicy'],
  connections: [
    {
      kind: 'grant',
      label: 'is consumed by',
      peers: [FUNCTION],
      flow: 'out',
      default: true,
      primary: { forms: [['grants', 'consumeMessages'], ['grantConsumeMessages']], args: ['{peer}'] },
      secondary: [queueUrlEnv],
    },
    {
      kind: 'grant',
      label: 'receives messages from',
      peers: [FUNCTION],
      flow: 'in',
      primary: { forms: [['grants', 'sendMessages'], ['grantSendMessages']], args: ['{peer}'] },
      secondary: [queueUrlEnv],
    },
  ],
};

export default overlay;
