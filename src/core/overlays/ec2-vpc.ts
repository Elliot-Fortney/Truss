import type { Overlay } from '../overlay.ts';

// A Vpc is only ever the target of a Reference (a Function's `vpc`, a Cluster's `vpc`), which jsii already tells us.
const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_ec2.Vpc',
  displayName: 'VPC',
  featuredProps: ['maxAzs', 'natGateways', 'subnetConfiguration', 'ipAddresses', 'enableDnsHostnames', 'vpcName'],
};

export default overlay;
