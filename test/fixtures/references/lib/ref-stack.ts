import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class RefStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const key = new kms.Key(this, 'Key');
    const spare = new kms.Key(this, 'Spare');
    const logs = new s3.Bucket(this, 'Logs');

    // Encrypted with the key, and logging to Logs.
    const data = new s3.Bucket(this, 'Data', { encryptionKey: key, serverAccessLogsBucket: logs });
    const plain = new s3.Bucket(this, 'Plain');

    const statement = new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: ['*'] });
    const read = new iam.ManagedPolicy(this, 'Read', { statements: [statement] });
    const write = new iam.ManagedPolicy(this, 'Write', { statements: [statement] });
    new iam.Role(this, 'Reader', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'), managedPolicies: [read] });

    // Made before the Node it will point at, so a Reference moves it below.
    // Two lines of comment.
    const early = new s3.Bucket(this, 'Early');
    const target = new kms.Key(this, 'Target');
  }
}
