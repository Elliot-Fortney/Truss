import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export class AuditedTopic extends sns.Topic {
  constructor(scope: Construct, id: string) {
    super(scope, id, { displayName: 'Audited' });
  }
}
