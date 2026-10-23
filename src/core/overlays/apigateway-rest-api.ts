import type { Overlay } from '../overlay.ts';

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_apigateway.RestApi',
  displayName: 'API Gateway REST API',
  featuredProps: ['restApiName', 'description', 'deployOptions', 'defaultCorsPreflightOptions', 'endpointTypes', 'cloudWatchRole'],
  connections: [
    {
      kind: 'integration',
      label: 'routes requests to',
      peers: ['aws-cdk-lib.aws_lambda.Function'],
      flow: 'out',
      default: true,
      primary: { forms: [['root', 'addMethod']], args: ["'ANY'", 'new LambdaIntegration({peer})'], uses: ['aws-cdk-lib.aws_apigateway.LambdaIntegration'] },
    },
  ],
};

export default overlay;
