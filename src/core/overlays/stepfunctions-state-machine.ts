import type { Overlay } from '../overlay.ts';

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_stepfunctions.StateMachine',
  displayName: 'Step Functions State Machine',
  featuredProps: ['stateMachineName', 'definitionBody', 'stateMachineType', 'timeout', 'tracingEnabled', 'logs', 'role', 'removalPolicy'],
  // One Pass state, so the machine is valid until its definition is written.
  defaults: {
    definitionBody: {
      code: `DefinitionBody.fromString('{"StartAt":"Done","States":{"Done":{"Type":"Pass","End":true}}}')`,
      uses: ['aws-cdk-lib.aws_stepfunctions.DefinitionBody'],
    },
  },
  connections: [
    {
      kind: 'grant',
      label: 'is started by',
      peers: ['aws-cdk-lib.aws_lambda.Function'],
      flow: 'in',
      primary: { forms: [['grants', 'startExecution'], ['grantStartExecution']], args: ['{peer}'] },
      secondary: [{ on: 'peer', forms: [['addEnvironment']], args: ["'STATE_MACHINE_ARN'", '{self}.stateMachineArn'] }],
    },
  ],
};

export default overlay;
