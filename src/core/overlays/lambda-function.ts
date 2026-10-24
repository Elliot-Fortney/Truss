import type { Overlay } from '../overlay.ts';

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_lambda.Function',
  displayName: 'Lambda Function',
  featuredProps: ['runtime', 'handler', 'code', 'memorySize', 'timeout', 'environment', 'architecture', 'description'],
  defaults: {
    runtime: { code: 'Runtime.NODEJS_22_X', uses: ['aws-cdk-lib.aws_lambda.Runtime'] },
    handler: { code: "'index.handler'" },
    code: { code: "Code.fromInline('exports.handler = async () => {};')", uses: ['aws-cdk-lib.aws_lambda.Code'] },
  },
  // The execution role and the layers give the Function what it runs with.
  referenceFlows: { role: 'in', layers: 'in' },
  connections: [
    {
      kind: 'integration',
      label: 'is triggered by',
      peers: ['aws-cdk-lib.aws_sqs.Queue'],
      flow: 'in',
      default: true,
      primary: {
        forms: [['addEventSource']],
        args: ['new SqsEventSource({peer})'],
        uses: ['aws-cdk-lib.aws_lambda_event_sources.SqsEventSource'],
      },
    },
    {
      kind: 'integration',
      label: 'is triggered by',
      peers: ['aws-cdk-lib.aws_kinesis.Stream'],
      flow: 'in',
      default: true,
      primary: {
        forms: [['addEventSource']],
        args: ['new KinesisEventSource({peer}, { startingPosition: StartingPosition.TRIM_HORIZON })'],
        uses: ['aws-cdk-lib.aws_lambda_event_sources.KinesisEventSource', 'aws-cdk-lib.aws_lambda.StartingPosition'],
      },
    },
    {
      kind: 'grant',
      label: 'is invoked by',
      peers: ['aws-cdk-lib.aws_stepfunctions.StateMachine'],
      flow: 'in',
      primary: { forms: [['grantInvoke']], args: ['{peer}'] },
    },
  ],
};

export default overlay;
