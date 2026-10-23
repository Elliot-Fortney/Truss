import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export class ShopStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new s3.Bucket(this, 'Uploads', {
      versioned: true,
    });

    new sqs.Queue(this, 'Orders', {
      visibilityTimeout: cdk.Duration.seconds(30),
    });

    new dynamodb.Table(this, 'Catalog', {
      partitionKey: { name: 'sku', type: dynamodb.AttributeType.STRING },
    });
  }
}
