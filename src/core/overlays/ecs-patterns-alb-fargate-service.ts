import type { Overlay } from '../overlay.ts';

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService',
  displayName: 'Fargate Service behind a Load Balancer',
  featuredProps: ['taskImageOptions', 'cluster', 'vpc', 'cpu', 'memoryLimitMiB', 'desiredCount', 'publicLoadBalancer', 'listenerPort', 'domainName', 'certificate'],
  // Without an image or a task definition the pattern throws, so the image is as good as required.
  defaults: {
    taskImageOptions: { code: "{ image: ContainerImage.fromRegistry('amazon/amazon-ecs-sample') }", uses: ['aws-cdk-lib.aws_ecs.ContainerImage'] },
  },
  accessors: [
    { as: 'grantee', path: ['taskDefinition', 'taskRole'] },
    { as: 'connectable', path: ['service'] },
  ],
};

export default overlay;
