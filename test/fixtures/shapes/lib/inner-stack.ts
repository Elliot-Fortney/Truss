import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export class InnerStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new sqs.Queue(this, 'InnerQueue');
  }
}
