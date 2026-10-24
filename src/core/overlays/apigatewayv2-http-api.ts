import type { Overlay } from '../overlay.ts';

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_apigatewayv2.HttpApi',
  displayName: 'API Gateway HTTP API',
  featuredProps: [
    'apiName',
    'description',
    'corsPreflight',
    'createDefaultStage',
    'defaultAuthorizer',
    'defaultIntegration',
    'disableExecuteApiEndpoint',
  ],
  connections: [
    {
      kind: 'integration',
      label: 'routes requests to',
      peers: ['aws-cdk-lib.aws_lambda.Function'],
      flow: 'out',
      default: true,
      primary: {
        forms: [['addRoutes']],
        args: [
          "{ path: '/', methods: [HttpMethod.ANY], integration: new HttpLambdaIntegration('LambdaIntegration', {peer}) }",
        ],
        uses: [
          'aws-cdk-lib.aws_apigatewayv2.HttpMethod',
          'aws-cdk-lib.aws_apigatewayv2_integrations.HttpLambdaIntegration',
        ],
      },
    },
  ],
};

export default overlay;
