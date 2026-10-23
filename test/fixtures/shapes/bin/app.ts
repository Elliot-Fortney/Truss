import * as cdk from 'aws-cdk-lib';
import { AppStage } from '../lib/app-stage';
import { RepeatedStack } from '../lib/repeated-stack';
import { ShapesStack } from '../lib/shapes-stack';

const app = new cdk.App();
const env = { account: '123456789012', region: 'us-east-1' };
new ShapesStack(app, 'Shapes', { env });
new RepeatedStack(app, 'Dev', { env });
new RepeatedStack(app, 'Prod', { env });
new AppStage(app, 'StageDev', { env });
new AppStage(app, 'StageProd', { env });
