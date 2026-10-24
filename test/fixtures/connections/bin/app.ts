import * as cdk from 'aws-cdk-lib';
import { WiringStack } from '../lib/wiring-stack';

const app = new cdk.App();
new WiringStack(app, 'Wiring');
