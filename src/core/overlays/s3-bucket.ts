import type { HintCall, Overlay } from '../overlay.ts';

const FUNCTION = 'aws-cdk-lib.aws_lambda.Function';
const QUEUE = 'aws-cdk-lib.aws_sqs.Queue';

const bucketNameEnv: HintCall = {
  on: 'peer',
  forms: [['addEnvironment']],
  args: ["'BUCKET_NAME'", '{self}.bucketName'],
};

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_s3.Bucket',
  displayName: 'S3 Bucket',
  featuredProps: [
    'bucketName',
    'versioned',
    'encryption',
    'blockPublicAccess',
    'enforceSSL',
    'lifecycleRules',
    'removalPolicy',
    'autoDeleteObjects',
  ],
  connections: [
    {
      kind: 'grant',
      label: 'is read by',
      peers: [FUNCTION],
      flow: 'out',
      default: true,
      primary: { forms: [['grants', 'read'], ['grantRead']], args: ['{peer}'] },
      secondary: [bucketNameEnv],
    },
    {
      kind: 'grant',
      label: 'is written by',
      peers: [FUNCTION],
      flow: 'in',
      primary: { forms: [['grants', 'write'], ['grantWrite']], args: ['{peer}'] },
      secondary: [bucketNameEnv],
    },
    {
      kind: 'grant',
      label: 'is read and written by',
      combines: ['is read by', 'is written by'],
      peers: [FUNCTION],
      flow: 'in',
      primary: { forms: [['grants', 'readWrite'], ['grantReadWrite']], args: ['{peer}'] },
      secondary: [bucketNameEnv],
    },
    {
      kind: 'integration',
      label: 'invokes',
      peers: [FUNCTION],
      flow: 'out',
      default: true,
      primary: {
        forms: [['addEventNotification']],
        args: ['EventType.OBJECT_CREATED', 'new LambdaDestination({peer})'],
        uses: ['aws-cdk-lib.aws_s3.EventType', 'aws-cdk-lib.aws_s3_notifications.LambdaDestination'],
      },
    },
    {
      kind: 'integration',
      label: 'sends messages to',
      peers: [QUEUE],
      flow: 'out',
      default: true,
      primary: {
        forms: [['addEventNotification']],
        args: ['EventType.OBJECT_CREATED', 'new SqsDestination({peer})'],
        uses: ['aws-cdk-lib.aws_s3.EventType', 'aws-cdk-lib.aws_s3_notifications.SqsDestination'],
      },
    },
  ],
};

export default overlay;
