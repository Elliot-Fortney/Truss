import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { ApiService } from './api-service';

const tableProps: dynamodb.TableProps = {
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
};

function makeQueue(scope: Construct, id: string): sqs.Queue {
  return new sqs.Queue(scope, id);
}

export class ShapesStack extends cdk.Stack {
  private readonly audit: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Plain: a bare statement, a const and a field.
    new sns.Topic(this, 'Plain', { displayName: 'Plain', fifo: false });
    const bound = new sqs.Queue(this, 'Bound', { retentionPeriod: cdk.Duration.days(1) });
    this.audit = new s3.Bucket(this, 'Audit');

    // Two constructs on one line.
    new sns.Topic(this, 'SameLineA'); new sns.Topic(this, 'SameLineB');

    // One construct inside another's props.
    new s3.Bucket(this, 'Outer', { eventBridgeEnabled: true, serverAccessLogsBucket: new s3.Bucket(this, 'Inner') });

    // Loops.
    for (const name of ['One', 'Two']) {
      new sqs.Queue(this, `Loop${name}`);
    }
    ['Left', 'Right'].forEach((name) => new sns.Topic(this, `Each${name}`));

    // Helpers.
    makeQueue(this, 'HelperA');
    makeQueue(this, 'HelperB');

    // A construct class of the app's own.
    new ApiService(this, 'Api');

    // Non-literal ID.
    const tableId = 'Orders';
    new dynamodb.Table(this, tableId, { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING } });

    // Props given as a variable.
    new dynamodb.Table(this, 'FromVariable', tableProps);

    bound.node.addMetadata('keep', this.audit.bucketName);
  }
}
