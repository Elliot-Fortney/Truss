import type { Overlay } from '../overlay.ts';

const overlay: Overlay = {
  fqn: 'aws-cdk-lib.aws_cloudfront.Distribution',
  displayName: 'CloudFront Distribution',
  featuredProps: [
    'defaultBehavior',
    'domainNames',
    'certificate',
    'priceClass',
    'defaultRootObject',
    'enabled',
    'comment',
  ],
  defaults: {
    defaultBehavior: {
      code: "{ origin: new HttpOrigin('example.com') }",
      uses: ['aws-cdk-lib.aws_cloudfront_origins.HttpOrigin'],
    },
  },
  connections: [
    {
      kind: 'integration',
      label: 'serves files from',
      peers: ['aws-cdk-lib.aws_s3.Bucket'],
      flow: 'in',
      default: true,
      primary: {
        forms: [['addBehavior']],
        args: ["'/static/*'", 'S3BucketOrigin.withOriginAccessControl({peer})'],
        uses: ['aws-cdk-lib.aws_cloudfront_origins.S3BucketOrigin'],
      },
    },
  ],
};

export default overlay;
