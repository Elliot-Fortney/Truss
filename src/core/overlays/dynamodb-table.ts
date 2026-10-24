import type { HintCall, Overlay } from '../overlay.ts';

const FUNCTION = 'aws-cdk-lib.aws_lambda.Function';
const SERVICE = 'aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService';

const tableNameEnv: HintCall = { on: 'peer', forms: [['addEnvironment']], args: ["'TABLE_NAME'", '{self}.tableName'] };

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_dynamodb.Table',
  displayName: 'DynamoDB Table',
  featuredProps: [
    'partitionKey',
    'sortKey',
    'billingMode',
    'pointInTimeRecovery',
    'timeToLiveAttribute',
    'stream',
    'deletionProtection',
    'removalPolicy',
  ],
  defaults: {
    partitionKey: {
      code: "{ name: 'id', type: AttributeType.STRING }",
      uses: ['aws-cdk-lib.aws_dynamodb.AttributeType'],
    },
  },
  connections: [
    {
      kind: 'grant',
      label: 'is read by',
      peers: [FUNCTION],
      flow: 'out',
      default: true,
      primary: { forms: [['grants', 'readData'], ['grantReadData']], args: ['{peer}'] },
      secondary: [tableNameEnv],
    },
    {
      kind: 'grant',
      label: 'is written by',
      peers: [FUNCTION],
      flow: 'in',
      primary: { forms: [['grants', 'writeData'], ['grantWriteData']], args: ['{peer}'] },
      secondary: [tableNameEnv],
    },
    {
      kind: 'grant',
      label: 'is read and written by',
      combines: ['is read by', 'is written by'],
      peers: [FUNCTION],
      flow: 'in',
      primary: { forms: [['grants', 'readWriteData'], ['grantReadWriteData']], args: ['{peer}'] },
      secondary: [tableNameEnv],
    },
    {
      kind: 'grant',
      label: 'is read by',
      peers: [SERVICE],
      flow: 'out',
      default: true,
      primary: { forms: [['grants', 'readData'], ['grantReadData']], args: ['{peer}'] },
    },
    {
      kind: 'grant',
      label: 'is written by',
      peers: [SERVICE],
      flow: 'in',
      primary: { forms: [['grants', 'writeData'], ['grantWriteData']], args: ['{peer}'] },
    },
  ],
};

export default overlay;
