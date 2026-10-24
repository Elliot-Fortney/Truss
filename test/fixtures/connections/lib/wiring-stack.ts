import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export class WiringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const uploads = new s3.Bucket(this, 'Uploads');
    const orders = new sqs.Queue(this, 'Orders');
    const catalog = new dynamodb.Table(this, 'Catalog', { partitionKey: { name: 'sku', type: dynamodb.AttributeType.STRING } });
    const events = new sns.Topic(this, 'Events');
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 0 });
    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.POSTGRES,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    const handler = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
      vpc,
    });
    const worker = new lambda.Function(this, 'Worker', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
    });
    // Reaches the database's network, but nothing says so yet.
    const reporter = new lambda.Function(this, 'Reporter', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
      vpc,
    });
    const idle = new lambda.Function(this, 'Idle', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
    });

    // The handler reads the uploads and says which bucket they are in.
    uploads.grantRead(handler);
    handler.addEnvironment('BUCKET_NAME', uploads.bucketName);

    // Written the way aws-cdk-lib is moving to.
    catalog.grants.readWriteData(worker);

    // Two grants on one pair, and a grant no hint writes.
    catalog.grants.readData(handler);
    catalog.grants.writeData(handler);
    orders.grantPurge(idle);

    // A trigger, and a subscription.
    worker.addEventSource(new SqsEventSource(orders));
    events.addSubscription(new subs.LambdaSubscription(idle));

    // The handler reaches the database.
    db.connections.allowDefaultPortFrom(handler);
  }
}
