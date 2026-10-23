import type { ConnectionHint, Overlay } from '../overlay.ts';

const triggers = (peer: string, target: string, isDefault = false): ConnectionHint => ({
  kind: 'integration',
  label: 'triggers',
  peers: [peer],
  flow: 'out',
  ...(isDefault ? { default: true as const } : {}),
  primary: { forms: [['addTarget']], args: [`new ${target}({peer})`], uses: [`aws-cdk-lib.aws_events_targets.${target}`] },
});

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_events.Rule',
  displayName: 'EventBridge Rule',
  featuredProps: ['schedule', 'eventPattern', 'description', 'enabled', 'ruleName', 'eventBus'],
  // A rule with neither a schedule nor an event pattern throws.
  defaults: {
    schedule: { code: 'Schedule.rate(Duration.hours(1))', uses: ['aws-cdk-lib.aws_events.Schedule', 'aws-cdk-lib.Duration'] },
  },
  connections: [
    triggers('aws-cdk-lib.aws_lambda.Function', 'LambdaFunction', true),
    triggers('aws-cdk-lib.aws_sqs.Queue', 'SqsQueue', true),
    triggers('aws-cdk-lib.aws_sns.Topic', 'SnsTopic', true),
    triggers('aws-cdk-lib.aws_stepfunctions.StateMachine', 'SfnStateMachine', true),
  ],
};

export default overlay;
