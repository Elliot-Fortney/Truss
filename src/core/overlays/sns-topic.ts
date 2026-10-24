import type { HintCall, Overlay } from '../overlay.ts';

const topicArnEnv: HintCall = { on: 'peer', forms: [['addEnvironment']], args: ["'TOPIC_ARN'", '{self}.topicArn'] };

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_sns.Topic',
  displayName: 'SNS Topic',
  featuredProps: ['topicName', 'displayName', 'fifo', 'masterKey', 'enforceSSL'],
  connections: [
    {
      kind: 'grant',
      label: 'is published to by',
      peers: ['aws-cdk-lib.aws_lambda.Function'],
      flow: 'in',
      primary: { forms: [['grants', 'publish'], ['grantPublish']], args: ['{peer}'] },
      secondary: [topicArnEnv],
    },
    {
      kind: 'integration',
      label: 'notifies',
      peers: ['aws-cdk-lib.aws_lambda.Function'],
      flow: 'out',
      default: true,
      primary: {
        forms: [['addSubscription']],
        args: ['new LambdaSubscription({peer})'],
        uses: ['aws-cdk-lib.aws_sns_subscriptions.LambdaSubscription'],
      },
    },
    {
      kind: 'integration',
      label: 'sends messages to',
      peers: ['aws-cdk-lib.aws_sqs.Queue'],
      flow: 'out',
      default: true,
      primary: {
        forms: [['addSubscription']],
        args: ['new SqsSubscription({peer})'],
        uses: ['aws-cdk-lib.aws_sns_subscriptions.SqsSubscription'],
      },
    },
  ],
};

export default overlay;
