import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export class ApiService extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new sqs.Queue(this, 'Jobs');
  }
}
