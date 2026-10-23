/** How an AWS service is written, where capitalising its module name wouldn't do. */
const SERVICE_NAMES: Record<string, string> = {
  apigateway: 'API Gateway',
  apigatewayv2: 'API Gateway',
  cloudfront: 'CloudFront',
  dynamodb: 'DynamoDB',
  ec2: 'EC2',
  ecs: 'ECS',
  efs: 'EFS',
  eks: 'EKS',
  events: 'EventBridge',
  iam: 'IAM',
  kms: 'KMS',
  lambda: 'Lambda',
  rds: 'RDS',
  s3: 'S3',
  secretsmanager: 'Secrets Manager',
  sns: 'SNS',
  sqs: 'SQS',
  stepfunctions: 'Step Functions',
};

/** The written name of the service behind an `aws-cdk-lib` module (`s3`, `lambda`), or undefined when a name can't be made of it. */
export function serviceName(module: string): string | undefined {
  // A module of several words (`ecs_patterns`) can't be turned into a service name by capitalising it.
  return SERVICE_NAMES[module] ?? (/^[a-z0-9]+$/.test(module) ? module[0]!.toUpperCase() + module.slice(1) : undefined);
}
